use std::net::SocketAddr;
use std::sync::Arc;

use tokio::net::TcpListener;
use tower::make::Shared;
use tracing_subscriber::EnvFilter;

use backend::auth::jwt::JwtService;
use backend::config::AppConfig;
use backend::db;
use backend::routes::webdav;
use backend::s3::build_client;
use backend::state::AppState;
use backend::storage::S3Storage;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenv::dotenv().ok();
    init_tracing();

    let config = AppConfig::from_env()?;
    tracing::info!(
        component = "webdav",
        database_url = %config.redacted_database_url(),
        pool_size = config.database_max_pool_size,
        server_host = %config.server_host,
        server_port = config.server_port,
        webdav_host = %config.webdav_host,
        webdav_port = config.webdav_port,
        quickwit_enabled = config.quickwit_endpoint.is_some(),
        s3_bucket = %config.s3_bucket,
        "loaded backend configuration"
    );
    let pool = db::init_pool_with_size(&config.database_url, config.database_max_pool_size)?;
    let s3_client = build_client(&config).await?;
    let storage = Arc::new(S3Storage::new(s3_client, config.s3_bucket.clone()));
    let jwt = JwtService::from_config(&config)?;

    let state = AppState::new(pool, config, storage, jwt);
    let listen_addr: SocketAddr = {
        let config = state.config.clone();
        format!("{}:{}", config.webdav_host, config.webdav_port).parse()?
    };
    let router = webdav::create_router().with_state(state);

    let listener = TcpListener::bind(listen_addr).await?;
    tracing::info!("listening for WebDAV on {}", listen_addr);

    axum::serve(listener, Shared::new(router)).await?;
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
