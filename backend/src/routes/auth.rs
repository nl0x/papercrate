use axum::{
    extract::State,
    http::{header::SET_COOKIE, HeaderMap, HeaderValue, StatusCode},
    Json,
};
use axum_extra::{headers::Cookie, typed_header::TypedHeader};
use chrono::{Duration as ChronoDuration, Utc};
use diesel::prelude::*;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    auth::{password, AuthenticatedUser},
    error::{AppError, AppResult},
    models::{NewRefreshToken, RefreshToken, User},
    schema::{refresh_tokens, users::dsl},
    state::AppState,
};

use crate::schema::refresh_tokens::dsl as refresh_dsl;

const REFRESH_COOKIE_NAME: &str = "refresh_token";

#[derive(Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct LoginResponse {
    pub access_token: String,
    pub token_type: String,
    pub expires_in: i64,
}

pub async fn login(
    State(state): State<AppState>,
    Json(payload): Json<LoginRequest>,
) -> AppResult<(HeaderMap, Json<LoginResponse>)> {
    let mut conn = state.db()?;

    let user: User = dsl::users
        .filter(dsl::username.eq(&payload.username))
        .first(&mut conn)?;

    let valid = password::verify_password(&payload.password, &user.password_hash)
        .map_err(|_| AppError::unauthorized())?;

    if !valid {
        return Err(AppError::unauthorized());
    }

    let access_token = state
        .jwt
        .generate_token(user.id, &user.username, &user.role)
        .map_err(AppError::from)?;

    let now = Utc::now();
    let refresh_value = generate_refresh_token();
    let refresh_hash = hash_refresh_token(&refresh_value);
    let refresh_expires_at = now + ChronoDuration::days(state.config.refresh_token_expiry_days);

    let new_refresh = NewRefreshToken {
        id: Uuid::new_v4(),
        user_id: user.id,
        token_hash: refresh_hash,
        issued_at: now.naive_utc(),
        expires_at: refresh_expires_at.naive_utc(),
    };

    diesel::insert_into(refresh_tokens::table)
        .values(&new_refresh)
        .execute(&mut conn)?;

    let mut headers = HeaderMap::new();
    headers.insert(
        SET_COOKIE,
        build_refresh_cookie(&state, &refresh_value, refresh_expires_at),
    );

    Ok((
        headers,
        Json(LoginResponse {
            access_token,
            token_type: "Bearer".to_string(),
            expires_in: state.config.jwt_expiry_minutes * 60,
        }),
    ))
}

pub async fn refresh(
    State(state): State<AppState>,
    jar: Option<TypedHeader<Cookie>>,
) -> AppResult<(HeaderMap, Json<LoginResponse>)> {
    let cookies = jar.ok_or_else(AppError::unauthorized)?;
    let refresh_value = cookies
        .get(REFRESH_COOKIE_NAME)
        .ok_or_else(AppError::unauthorized)?;

    let hashed = hash_refresh_token(refresh_value);
    let mut conn = state.db()?;
    let now = Utc::now();
    let now_naive = now.naive_utc();

    let token = match refresh_dsl::refresh_tokens
        .filter(refresh_dsl::token_hash.eq(&hashed))
        .filter(refresh_dsl::revoked_at.is_null())
        .filter(refresh_dsl::expires_at.gt(now_naive))
        .first::<RefreshToken>(&mut conn)
    {
        Ok(token) => token,
        Err(diesel::result::Error::NotFound) => return Err(AppError::unauthorized()),
        Err(err) => return Err(AppError::from(err)),
    };

    diesel::update(refresh_dsl::refresh_tokens.filter(refresh_dsl::id.eq(token.id)))
        .set((
            refresh_dsl::revoked_at.eq(now_naive),
            refresh_dsl::updated_at.eq(now_naive),
        ))
        .execute(&mut conn)?;

    let user: User = dsl::users
        .find(token.user_id)
        .first(&mut conn)
        .map_err(AppError::from)?;

    let access_token = state
        .jwt
        .generate_token(user.id, &user.username, &user.role)
        .map_err(AppError::from)?;

    let new_refresh_value = generate_refresh_token();
    let new_refresh_hash = hash_refresh_token(&new_refresh_value);
    let new_refresh_expires = now + ChronoDuration::days(state.config.refresh_token_expiry_days);

    let new_refresh = NewRefreshToken {
        id: Uuid::new_v4(),
        user_id: user.id,
        token_hash: new_refresh_hash,
        issued_at: now_naive,
        expires_at: new_refresh_expires.naive_utc(),
    };

    diesel::insert_into(refresh_tokens::table)
        .values(&new_refresh)
        .execute(&mut conn)?;

    let mut headers = HeaderMap::new();
    headers.insert(
        SET_COOKIE,
        build_refresh_cookie(&state, &new_refresh_value, new_refresh_expires),
    );

    Ok((
        headers,
        Json(LoginResponse {
            access_token,
            token_type: "Bearer".to_string(),
            expires_in: state.config.jwt_expiry_minutes * 60,
        }),
    ))
}

pub async fn logout(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    jar: Option<TypedHeader<Cookie>>,
) -> AppResult<(HeaderMap, StatusCode)> {
    let mut conn = state.db()?;
    let now = Utc::now().naive_utc();
    let mut rows_affected = 0;

    if let Some(cookies) = jar {
        if let Some(value) = cookies.get(REFRESH_COOKIE_NAME) {
            let hashed = hash_refresh_token(value);
            rows_affected = diesel::update(
                refresh_dsl::refresh_tokens
                    .filter(refresh_dsl::token_hash.eq(hashed))
                    .filter(refresh_dsl::user_id.eq(user.user_id))
                    .filter(refresh_dsl::revoked_at.is_null()),
            )
            .set((
                refresh_dsl::revoked_at.eq(now),
                refresh_dsl::updated_at.eq(now),
            ))
            .execute(&mut conn)
            .unwrap_or(0);
        }
    }

    if rows_affected == 0 {
        let _ = diesel::update(
            refresh_dsl::refresh_tokens
                .filter(refresh_dsl::user_id.eq(user.user_id))
                .filter(refresh_dsl::revoked_at.is_null()),
        )
        .set((
            refresh_dsl::revoked_at.eq(now),
            refresh_dsl::updated_at.eq(now),
        ))
        .execute(&mut conn);
    }

    let mut headers = HeaderMap::new();
    headers.insert(SET_COOKIE, build_clear_refresh_cookie(&state));
    Ok((headers, StatusCode::NO_CONTENT))
}

pub async fn me(user: AuthenticatedUser) -> Json<AuthenticatedUser> {
    Json(user)
}

fn hash_refresh_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

fn generate_refresh_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn build_refresh_cookie(
    state: &AppState,
    token: &str,
    expires_at: chrono::DateTime<Utc>,
) -> HeaderValue {
    let max_age = ChronoDuration::days(state.config.refresh_token_expiry_days).num_seconds();

    let mut parts = vec![format!("{}={}", REFRESH_COOKIE_NAME, token)];
    parts.push("Path=/".into());
    parts.push("HttpOnly".into());
    parts.push("SameSite=Strict".into());
    parts.push(format!("Max-Age={}", max_age));
    parts.push(format!("Expires={}", expires_at.to_rfc2822()));
    if state.config.refresh_cookie_secure {
        parts.push("Secure".into());
    }
    if let Some(domain) = &state.config.refresh_cookie_domain {
        parts.push(format!("Domain={}", domain));
    }

    HeaderValue::from_str(&parts.join("; ")).expect("valid refresh cookie")
}

fn build_clear_refresh_cookie(state: &AppState) -> HeaderValue {
    let mut parts = vec![format!("{}=", REFRESH_COOKIE_NAME)];
    parts.push("Path=/".into());
    parts.push("HttpOnly".into());
    parts.push("SameSite=Strict".into());
    parts.push("Max-Age=0".into());
    parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT".into());
    if state.config.refresh_cookie_secure {
        parts.push("Secure".into());
    }
    if let Some(domain) = &state.config.refresh_cookie_domain {
        parts.push(format!("Domain={}", domain));
    }

    HeaderValue::from_str(&parts.join("; ")).expect("valid refresh cookie")
}
