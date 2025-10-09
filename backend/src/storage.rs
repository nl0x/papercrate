use std::time::Duration;

use anyhow::{Context, Result};
use async_trait::async_trait;
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client as S3Client;

#[async_trait]
pub trait ObjectStorage: Send + Sync + 'static {
    async fn put_object(
        &self,
        key: &str,
        bytes: Vec<u8>,
        content_type: Option<String>,
        content_disposition: Option<String>,
    ) -> Result<()>;

    async fn presign_get_object(&self, key: &str, expires_in: Duration) -> Result<String>;

    async fn get_object(&self, key: &str) -> Result<Vec<u8>>;

    async fn delete_object(&self, key: &str) -> Result<()>;
}

pub struct S3Storage {
    client: S3Client,
    bucket: String,
}

impl S3Storage {
    pub fn new(client: S3Client, bucket: impl Into<String>) -> Self {
        Self {
            client,
            bucket: bucket.into(),
        }
    }
}

#[async_trait]
impl ObjectStorage for S3Storage {
    async fn put_object(
        &self,
        key: &str,
        bytes: Vec<u8>,
        content_type: Option<String>,
        content_disposition: Option<String>,
    ) -> Result<()> {
        let mut request = self
            .client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .body(ByteStream::from(bytes));

        if let Some(content_type) = content_type {
            request = request.content_type(content_type);
        }

        if let Some(content_disposition) = content_disposition {
            request = request.content_disposition(content_disposition);
        }

        request
            .send()
            .await
            .context("failed to upload object to S3")?;

        Ok(())
    }

    async fn presign_get_object(&self, key: &str, expires_in: Duration) -> Result<String> {
        let presign_config = PresigningConfig::builder()
            .expires_in(expires_in)
            .build()
            .context("failed to build S3 presigning config")?;

        let presigned = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .presigned(presign_config)
            .await
            .context("failed to generate presigned download URL")?;

        Ok(presigned.uri().to_string())
    }

    async fn get_object(&self, key: &str) -> Result<Vec<u8>> {
        let response = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .context("failed to download object from S3")?;

        let bytes = response
            .body
            .collect()
            .await
            .context("failed to read object stream")?
            .into_bytes()
            .to_vec();

        Ok(bytes)
    }

    async fn delete_object(&self, key: &str) -> Result<()> {
        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .context("failed to delete object from S3")?;
        Ok(())
    }
}
