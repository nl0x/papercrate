use std::time::Duration;

use diesel::pg::PgConnection;
use diesel::r2d2::{ConnectionManager, Pool};

pub type PgPool = Pool<ConnectionManager<PgConnection>>;

pub const DEFAULT_MAX_POOL_SIZE: u32 = 2;

pub fn init_pool(database_url: &str) -> anyhow::Result<PgPool> {
    init_pool_with_size(database_url, DEFAULT_MAX_POOL_SIZE)
}

pub fn init_pool_with_size(database_url: &str, max_size: u32) -> anyhow::Result<PgPool> {
    let manager = ConnectionManager::<PgConnection>::new(database_url);
    let pool_size = max_size.max(1);
    let pool = Pool::builder()
        .max_size(pool_size)
        .connection_timeout(Duration::from_secs(10))
        .build(manager)?;
    Ok(pool)
}
