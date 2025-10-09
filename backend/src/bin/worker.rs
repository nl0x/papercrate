use std::{sync::Arc, time::Duration};

use tokio::signal;
use tracing_subscriber::EnvFilter;

use backend::{
    auth::jwt::JwtService, config::AppConfig, db, default_handlers, s3::build_client,
    state::AppState, storage::S3Storage, Worker,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenv::dotenv().ok();
    init_tracing();

    let config = AppConfig::from_env()?;
    tracing::info!(
        component = "worker",
        database_url = %config.redacted_database_url(),
        pool_size = 1,
        quickwit_enabled = config.quickwit_endpoint.is_some(),
        s3_bucket = %config.s3_bucket,
        "loaded backend configuration"
    );
    let pool = db::init_pool_with_size(&config.database_url, 1)?;
    let s3_client = build_client(&config).await?;
    let storage = Arc::new(S3Storage::new(s3_client, config.s3_bucket.clone()));
    let jwt = JwtService::from_config(&config)?;

    let state = Arc::new(AppState::new(pool, config, storage, jwt));
    let worker = Worker::new(state, default_handlers(), Duration::from_secs(2));

    tokio::select! {
        _ = worker.run() => {}
        _ = signal::ctrl_c() => {
            tracing::info!("worker received shutdown signal");
        }
    }

    Ok(())
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .compact()
        .init();
}
