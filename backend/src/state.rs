use std::sync::Arc;

use diesel::{
    pg::PgConnection,
    r2d2::{ConnectionManager, PooledConnection},
};

use crate::{
    auth::jwt::JwtService,
    config::AppConfig,
    db::PgPool,
    error::{AppError, AppResult},
    storage::ObjectStorage,
};

type PgPooledConnection = PooledConnection<ConnectionManager<PgConnection>>;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Arc<AppConfig>,
    pub storage: Arc<dyn ObjectStorage>,
    pub jwt: JwtService,
}

impl AppState {
    pub fn new(
        pool: PgPool,
        config: AppConfig,
        storage: Arc<dyn ObjectStorage>,
        jwt: JwtService,
    ) -> Self {
        Self {
            pool,
            config: Arc::new(config),
            storage,
            jwt,
        }
    }

    pub fn db(&self) -> AppResult<PgPooledConnection> {
        self.pool
            .get()
            .map_err(|err| AppError::internal(format!("database pool error: {err}")))
    }
}
