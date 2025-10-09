use std::env;

use anyhow::{Context, Result};
use diesel::prelude::*;

use backend::{
    config::AppConfig,
    db,
    models::DocumentAsset,
    s3,
    schema::document_assets,
    storage::{ObjectStorage, S3Storage},
};

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("delete-assets") => delete_all_assets().await?,
        Some(cmd) => {
            eprintln!("Unknown command: {cmd}\nUsage: maintenance delete-assets");
            std::process::exit(1);
        }
        None => {
            eprintln!("Usage: maintenance delete-assets");
            std::process::exit(1);
        }
    }

    Ok(())
}

async fn delete_all_assets() -> Result<()> {
    let config = AppConfig::from_env()?;
    tracing::info!(
        component = "maintenance",
        database_url = %config.redacted_database_url(),
        pool_size = config.database_max_pool_size,
        s3_bucket = %config.s3_bucket,
        "loaded backend configuration"
    );
    let pool = db::init_pool_with_size(&config.database_url, config.database_max_pool_size)?;

    let s3_client = s3::build_client(&config).await?;
    let storage = S3Storage::new(s3_client, config.s3_bucket.clone());

    let mut conn = pool.get().context("failed to get database connection")?;

    let assets: Vec<DocumentAsset> = document_assets::table
        .load(&mut conn)
        .context("failed to load document assets")?;

    if assets.is_empty() {
        println!("No assets found.");
        return Ok(());
    }

    println!("Deleting {} assets…", assets.len());

    for asset in &assets {
        if let Err(err) = storage.delete_object(&asset.s3_key).await {
            eprintln!(
                "Failed to delete object {} from storage: {err}",
                asset.s3_key
            );
        }
    }

    diesel::delete(document_assets::table)
        .execute(&mut conn)
        .context("failed to remove asset records")?;

    println!("Asset records deleted.");
    Ok(())
}
