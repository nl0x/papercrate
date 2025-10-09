use std::collections::HashMap;
use std::env;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, ensure, Context, Result};
use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::Router;
use backend::auth::jwt::JwtService;
use backend::config::AppConfig;
use backend::db::{self, PgPool};
use backend::models::{Job, NewUser};
use backend::routes;
use backend::state::AppState;
use backend::storage::ObjectStorage;
use diesel::connection::SimpleConnection;
use diesel::prelude::*;
use diesel::PgConnection;
use diesel_migrations::{embed_migrations, EmbeddedMigrations, MigrationHarness};
use http_body_util::BodyExt;
use once_cell::sync::Lazy;
use rand::rngs::OsRng;
use serde::Serialize;
use tokio::sync::Mutex;
use tower::util::ServiceExt;
use uuid::Uuid;

const MIGRATIONS: EmbeddedMigrations = embed_migrations!("migrations");

static DB_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[allow(dead_code)]
#[derive(Clone)]
pub struct StoredObject {
    pub key: String,
    pub bytes: Vec<u8>,
    pub content_type: Option<String>,
    pub content_disposition: Option<String>,
}

#[derive(Default)]
pub struct FakeStorage {
    objects: Mutex<HashMap<String, StoredObject>>,
}

#[async_trait]
impl ObjectStorage for FakeStorage {
    async fn put_object(
        &self,
        key: &str,
        bytes: Vec<u8>,
        content_type: Option<String>,
        content_disposition: Option<String>,
    ) -> Result<()> {
        let stored = StoredObject {
            key: key.to_string(),
            bytes,
            content_type,
            content_disposition,
        };
        let mut guard = self.objects.lock().await;
        guard.insert(stored.key.clone(), stored);
        Ok(())
    }

    async fn presign_get_object(&self, key: &str, expires_in: Duration) -> Result<String> {
        let guard = self.objects.lock().await;
        ensure!(guard.contains_key(key), "object {key} missing");
        Ok(format!(
            "https://fake-storage/{key}?expires_in={}",
            expires_in.as_secs()
        ))
    }

    async fn get_object(&self, key: &str) -> Result<Vec<u8>> {
        let guard = self.objects.lock().await;
        guard
            .get(key)
            .map(|obj| obj.bytes.clone())
            .ok_or_else(|| anyhow!("object {key} missing"))
    }

    async fn delete_object(&self, key: &str) -> Result<()> {
        let mut guard = self.objects.lock().await;
        guard.remove(key);
        Ok(())
    }
}

impl FakeStorage {
    #[allow(dead_code)]
    pub async fn get(&self, key: &str) -> Option<StoredObject> {
        let guard = self.objects.lock().await;
        guard.get(key).cloned()
    }

    #[allow(dead_code)]
    pub async fn object_count(&self) -> usize {
        let guard = self.objects.lock().await;
        guard.len()
    }
}

pub struct TestApp {
    pub state: AppState,
    router: Router,
    storage: Arc<FakeStorage>,
}

impl TestApp {
    pub async fn new() -> Result<Self> {
        let database_url = env::var("TEST_DATABASE_URL")
            .context("TEST_DATABASE_URL must be set for integration tests")?;

        let config = AppConfig {
            database_url: database_url.clone(),
            database_max_pool_size: db::DEFAULT_MAX_POOL_SIZE,
            server_host: "127.0.0.1".to_string(),
            server_port: 0,
            webdav_host: "127.0.0.1".to_string(),
            webdav_port: 0,
            jwt_secret: "test-secret".to_string(),
            jwt_issuer: "test-issuer".to_string(),
            jwt_audience: "test-audience".to_string(),
            jwt_expiry_minutes: 60,
            download_token_audience: "test-download".to_string(),
            download_token_expiry_minutes: 60,
            refresh_token_expiry_days: 30,
            refresh_cookie_secure: false,
            refresh_cookie_domain: None,
            cors_allowed_origin: None,
            aws_endpoint_url: None,
            aws_access_key_id: None,
            aws_secret_access_key: None,
            aws_region: "us-east-1".to_string(),
            s3_bucket: "test-bucket".to_string(),
            quickwit_endpoint: None,
            quickwit_index: None,
        };

        let pool = db::init_pool_with_size(&config.database_url, config.database_max_pool_size)?;
        prepare_database(&pool).await?;

        let storage = Arc::new(FakeStorage::default());
        let storage_for_state: Arc<dyn ObjectStorage> = storage.clone();
        let jwt = JwtService::from_config(&config)?;
        let state = AppState::new(pool.clone(), config, storage_for_state, jwt);
        let router = routes::create_router(state.clone());

        Ok(Self {
            state,
            router,
            storage,
        })
    }

    pub async fn cleanup(&self) -> Result<()> {
        let pool = self.state.pool.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut conn = pool
                .get()
                .map_err(|err| anyhow!("failed to get cleanup connection: {err}"))?;
            truncate_all(&mut conn)?;
            Ok(())
        })
        .await
        .context("cleanup task panicked")?
    }

    #[allow(dead_code)]
    pub fn storage(&self) -> Arc<FakeStorage> {
        self.storage.clone()
    }

    pub async fn insert_user(&self, username: &str, password: &str, role: &str) -> Result<Uuid> {
        let username = username.to_string();
        let password = password.to_string();
        let role = role.to_string();
        self.with_conn(move |conn| {
            let password_hash = hash_password(&password)?;
            let user = NewUser {
                id: Uuid::new_v4(),
                username,
                password_hash,
                role,
            };
            diesel::insert_into(backend::schema::users::table)
                .values(&user)
                .execute(conn)
                .context("failed to insert user")?;
            Ok(user.id)
        })
        .await
    }

    pub async fn login_token(&self, username: &str, password: &str) -> Result<String> {
        #[derive(Serialize)]
        struct LoginPayload<'a> {
            username: &'a str,
            password: &'a str,
        }

        let response = self
            .post_json(
                "/api/auth/login",
                &LoginPayload { username, password },
                None,
            )
            .await?;

        ensure!(
            response.status() == StatusCode::OK,
            "login failed with status {}",
            response.status()
        );

        let body = body_to_vec(response.into_body()).await?;
        #[derive(serde::Deserialize)]
        struct LoginResponse {
            access_token: String,
        }
        let parsed: LoginResponse = serde_json::from_slice(&body)?;
        Ok(parsed.access_token)
    }

    #[allow(dead_code)]
    pub async fn clear_jobs(&self) -> Result<()> {
        self.with_conn(|conn| {
            use backend::schema::jobs::dsl::jobs as jobs_table;
            diesel::delete(jobs_table)
                .execute(conn)
                .context("failed to clear jobs")?;
            Ok(())
        })
        .await
    }

    #[allow(dead_code)]
    pub async fn jobs_by_type(&self, ty: &str) -> Result<Vec<Job>> {
        let ty = ty.to_string();
        self.with_conn(move |conn| {
            use backend::schema::jobs::dsl::{job_type as job_type_col, jobs as jobs_table};
            let rows = jobs_table
                .filter(job_type_col.eq(&ty))
                .load::<Job>(conn)
                .context("failed to load jobs")?;
            Ok(rows)
        })
        .await
    }

    pub async fn post_json<T: Serialize + ?Sized>(
        &self,
        path: &str,
        payload: &T,
        token: Option<&str>,
    ) -> Result<hyper::Response<Body>> {
        let body = serde_json::to_vec(payload)?;
        let mut builder = Request::builder()
            .method(Method::POST)
            .uri(path)
            .header("content-type", "application/json");
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        let request = builder.body(Body::from(body))?;
        Ok(self
            .router
            .clone()
            .oneshot(request)
            .await
            .expect("infallible response"))
    }

    #[allow(dead_code)]
    pub async fn patch_json<T: Serialize + ?Sized>(
        &self,
        path: &str,
        payload: &T,
        token: Option<&str>,
    ) -> Result<hyper::Response<Body>> {
        let body = serde_json::to_vec(payload)?;
        let mut builder = Request::builder()
            .method(Method::PATCH)
            .uri(path)
            .header("content-type", "application/json");
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        let request = builder.body(Body::from(body))?;
        Ok(self
            .router
            .clone()
            .oneshot(request)
            .await
            .expect("infallible response"))
    }

    pub async fn get(&self, path: &str, token: Option<&str>) -> Result<hyper::Response<Body>> {
        let mut builder = Request::builder().method(Method::GET).uri(path);
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        let request = builder.body(Body::empty())?;
        Ok(self
            .router
            .clone()
            .oneshot(request)
            .await
            .expect("infallible response"))
    }

    #[allow(dead_code)]
    pub async fn delete(&self, path: &str, token: Option<&str>) -> Result<hyper::Response<Body>> {
        let builder = Request::builder().method(Method::DELETE).uri(path);
        let builder = if let Some(token) = token {
            builder.header("authorization", format!("Bearer {token}"))
        } else {
            builder
        };
        let request = builder.body(Body::empty())?;
        Ok(self
            .router
            .clone()
            .oneshot(request)
            .await
            .expect("infallible response"))
    }

    #[allow(dead_code)]
    pub async fn upload_document(
        &self,
        path: &str,
        filename: &str,
        content_type: &str,
        data: &[u8],
        folder_id: Option<Uuid>,
        token: &str,
    ) -> Result<hyper::Response<Body>> {
        let boundary = format!("boundary-{}", Uuid::new_v4());
        let mut body = Vec::new();
        body.extend(format!("--{boundary}\r\n").as_bytes());
        body.extend(
            format!(
                "Content-Disposition: form-data; name=\"file\"; filename=\"{}\"\r\n",
                filename
            )
            .as_bytes(),
        );
        body.extend(format!("Content-Type: {}\r\n\r\n", content_type).as_bytes());
        body.extend(data);
        body.extend(b"\r\n");

        if let Some(folder) = folder_id {
            body.extend(format!("--{boundary}\r\n").as_bytes());
            body.extend(b"Content-Disposition: form-data; name=\"folder_id\"\r\n\r\n");
            body.extend(folder.to_string().as_bytes());
            body.extend(b"\r\n");
        }

        body.extend(format!("--{boundary}--\r\n").as_bytes());

        let builder = Request::builder()
            .method(Method::POST)
            .uri(path)
            .header(
                "content-type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .header("authorization", format!("Bearer {token}"));

        let request = builder.body(Body::from(body))?;
        Ok(self
            .router
            .clone()
            .oneshot(request)
            .await
            .expect("infallible response"))
    }

    async fn with_conn<F, T>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&mut PgConnection) -> Result<T> + Send + 'static,
        T: Send + 'static,
    {
        let pool = self.state.pool.clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = pool
                .get()
                .map_err(|err| anyhow!("failed to get database connection: {err}"))?;
            f(&mut conn)
        })
        .await
        .context("connection task panicked")?
    }
}

pub async fn acquire_db_lock() -> tokio::sync::MutexGuard<'static, ()> {
    DB_LOCK.lock().await
}

pub async fn body_to_vec(body: Body) -> Result<Vec<u8>> {
    let collected = body
        .collect()
        .await
        .map_err(|err| anyhow!("failed to read response body: {err}"))?;
    Ok(collected.to_bytes().to_vec())
}

async fn prepare_database(pool: &PgPool) -> Result<()> {
    let pool = pool.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut conn = pool
            .get()
            .map_err(|err| anyhow!("failed to acquire connection: {err}"))?;
        conn.run_pending_migrations(MIGRATIONS)
            .map_err(|err| anyhow!("failed to run migrations: {err}"))?;
        truncate_all(&mut conn)?;
        Ok(())
    })
    .await
    .context("migration task panicked")?
}

fn truncate_all(conn: &mut PgConnection) -> Result<()> {
    conn.batch_execute(
        "TRUNCATE TABLE document_tags, document_versions, documents, folders, tags, users RESTART IDENTITY CASCADE;",
    )
    .context("failed to truncate tables")?;
    Ok(())
}

fn hash_password(password: &str) -> Result<String> {
    use argon2::password_hash::{PasswordHasher, SaltString};
    use argon2::Argon2;

    let salt = SaltString::generate(&mut OsRng);
    Ok(Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|err| anyhow!("failed to hash password: {err}"))?
        .to_string())
}
