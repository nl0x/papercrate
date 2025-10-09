use std::env;

use anyhow::{Context, Result};
use url::Url;

use crate::db::DEFAULT_MAX_POOL_SIZE;

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub database_url: String,
    pub database_max_pool_size: u32,
    pub server_host: String,
    pub server_port: u16,
    pub webdav_host: String,
    pub webdav_port: u16,
    pub jwt_secret: String,
    pub jwt_issuer: String,
    pub jwt_audience: String,
    pub jwt_expiry_minutes: i64,
    pub download_token_audience: String,
    pub download_token_expiry_minutes: i64,
    pub refresh_token_expiry_days: i64,
    pub refresh_cookie_secure: bool,
    pub refresh_cookie_domain: Option<String>,
    pub cors_allowed_origin: Option<String>,
    pub aws_endpoint_url: Option<String>,
    pub aws_access_key_id: Option<String>,
    pub aws_secret_access_key: Option<String>,
    pub aws_region: String,
    pub s3_bucket: String,
    pub quickwit_endpoint: Option<String>,
    pub quickwit_index: Option<String>,
}

impl AppConfig {
    pub fn from_env() -> Result<Self> {
        let database_url = env::var("DATABASE_URL").context("DATABASE_URL must be set")?;
        let database_max_pool_size = env::var("DATABASE_MAX_POOL_SIZE")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(DEFAULT_MAX_POOL_SIZE);
        let server_host = env::var("SERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let server_port = env::var("SERVER_PORT")
            .unwrap_or_else(|_| "3000".to_string())
            .parse()
            .context("SERVER_PORT must be a valid u16")?;
        let webdav_host = env::var("WEBDAV_HOST").unwrap_or_else(|_| server_host.clone());
        let webdav_port = env::var("WEBDAV_PORT")
            .unwrap_or_else(|_| "3001".to_string())
            .parse()
            .context("WEBDAV_PORT must be a valid u16")?;
        let jwt_secret = env::var("JWT_SECRET").context("JWT_SECRET must be set")?;
        let jwt_issuer = env::var("JWT_ISSUER").unwrap_or_else(|_| "papercrate".to_string());
        let jwt_audience =
            env::var("JWT_AUDIENCE").unwrap_or_else(|_| "papercrate-clients".to_string());
        let jwt_expiry_minutes = env::var("JWT_EXPIRY_MINUTES")
            .unwrap_or_else(|_| "60".to_string())
            .parse()
            .context("JWT_EXPIRY_MINUTES must be an integer")?;
        let download_token_audience = env::var("DOWNLOAD_TOKEN_AUDIENCE")
            .unwrap_or_else(|_| "papercrate-download".to_string());
        let download_token_expiry_minutes = env::var("DOWNLOAD_TOKEN_EXPIRY_MINUTES")
            .unwrap_or_else(|_| "60".to_string())
            .parse()
            .context("DOWNLOAD_TOKEN_EXPIRY_MINUTES must be an integer")?;
        let refresh_token_expiry_days = env::var("REFRESH_TOKEN_EXPIRY_DAYS")
            .unwrap_or_else(|_| "30".to_string())
            .parse()
            .context("REFRESH_TOKEN_EXPIRY_DAYS must be an integer")?;
        let refresh_cookie_secure = env::var("REFRESH_COOKIE_SECURE")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        let refresh_cookie_domain = env::var("REFRESH_COOKIE_DOMAIN").ok();
        let cors_allowed_origin = env::var("CORS_ALLOWED_ORIGIN").ok();
        let aws_endpoint_url = env::var("AWS_ENDPOINT_URL").ok();
        let aws_access_key_id = env::var("AWS_ACCESS_KEY_ID").ok();
        let aws_secret_access_key = env::var("AWS_SECRET_ACCESS_KEY").ok();
        let aws_region = env::var("AWS_REGION").unwrap_or_else(|_| "us-east-1".to_string());
        let s3_bucket = env::var("S3_BUCKET").context("S3_BUCKET must be set")?;
        let quickwit_endpoint = env::var("QUICKWIT_ENDPOINT").ok();
        let quickwit_index = env::var("QUICKWIT_INDEX").ok();

        Ok(Self {
            database_url,
            database_max_pool_size,
            server_host,
            server_port,
            webdav_host,
            webdav_port,
            jwt_secret,
            jwt_issuer,
            jwt_audience,
            jwt_expiry_minutes,
            download_token_audience,
            download_token_expiry_minutes,
            refresh_token_expiry_days,
            refresh_cookie_secure,
            refresh_cookie_domain,
            cors_allowed_origin,
            aws_endpoint_url,
            aws_access_key_id,
            aws_secret_access_key,
            aws_region,
            s3_bucket,
            quickwit_endpoint,
            quickwit_index,
        })
    }

    pub fn redacted_database_url(&self) -> String {
        redact_database_url(&self.database_url)
    }
}

fn redact_database_url(raw: &str) -> String {
    match Url::parse(raw) {
        Ok(mut parsed) => {
            let _ = parsed.set_password(Some("*****"));
            parsed.to_string()
        }
        Err(_) => "***".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::redact_database_url;

    #[test]
    fn redacts_password_in_database_url() {
        let redacted = redact_database_url("postgres://user:secret@localhost/db");
        assert!(redacted.contains("postgres://user:*****@"));
        assert!(!redacted.contains("secret"));
    }

    #[test]
    fn handles_url_without_password() {
        let redacted = redact_database_url("postgres://localhost/db");
        assert_eq!(redacted, "postgres://localhost/db");
    }

    #[test]
    fn falls_back_when_parse_fails() {
        let redacted = redact_database_url("not a url");
        assert_eq!(redacted, "***");
    }
}
