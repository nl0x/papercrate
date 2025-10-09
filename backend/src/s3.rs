use anyhow::Result;
use aws_config::meta::region::RegionProviderChain;
use aws_credential_types::Credentials;
use aws_sdk_s3::{
    config::{Builder as S3ConfigBuilder, Region},
    Client as S3Client,
};

use crate::config::AppConfig;

pub async fn build_client(config: &AppConfig) -> Result<S3Client> {
    let region = Region::new(config.aws_region.clone());
    let region_provider = RegionProviderChain::first_try(Some(region))
        .or_default_provider()
        .or_else("us-east-1");

    #[allow(deprecated)]
    let mut loader = aws_config::from_env().region(region_provider);

    if let Some(endpoint) = &config.aws_endpoint_url {
        loader = loader.endpoint_url(endpoint);
    }

    if let (Some(access_key), Some(secret_key)) = (
        config.aws_access_key_id.clone(),
        config.aws_secret_access_key.clone(),
    ) {
        let credentials = Credentials::new(access_key, secret_key, None, None, "static");
        loader = loader.credentials_provider(credentials);
    }

    let base_config = loader.load().await;
    let s3_config = S3ConfigBuilder::from(&base_config)
        .force_path_style(true)
        .build();

    Ok(S3Client::from_conf(s3_config))
}
