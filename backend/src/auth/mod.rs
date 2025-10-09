pub mod jwt;
pub mod password;

use axum::{async_trait, extract::FromRequestParts, http::request::Parts};
use axum_extra::headers::{authorization::Bearer, Authorization};
use axum_extra::TypedHeader;
use serde::{Deserialize, Serialize};

use crate::{error::AppError, state::AppState};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthenticatedUser {
    pub user_id: uuid::Uuid,
    pub username: String,
    pub role: String,
}

#[async_trait]
impl FromRequestParts<AppState> for AuthenticatedUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let TypedHeader(Authorization(bearer)) =
            TypedHeader::<Authorization<Bearer>>::from_request_parts(parts, state)
                .await
                .map_err(|_| AppError::unauthorized())?;

        let claims = state
            .jwt
            .verify_token(bearer.token())
            .map_err(|_| AppError::unauthorized())?;

        Ok(AuthenticatedUser {
            user_id: claims.sub,
            username: claims.username,
            role: claims.role,
        })
    }
}
