use anyhow::Result;
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::config::AppConfig;

#[derive(Clone)]
pub struct JwtService {
    encoding: EncodingKey,
    decoding: DecodingKey,
    issuer: String,
    audience: String,
    expiry: Duration,
    download_audience: String,
    download_expiry: Duration,
}

impl JwtService {
    pub fn from_config(config: &AppConfig) -> Result<Self> {
        Ok(Self {
            encoding: EncodingKey::from_secret(config.jwt_secret.as_bytes()),
            decoding: DecodingKey::from_secret(config.jwt_secret.as_bytes()),
            issuer: config.jwt_issuer.clone(),
            audience: config.jwt_audience.clone(),
            expiry: Duration::minutes(config.jwt_expiry_minutes),
            download_audience: config.download_token_audience.clone(),
            download_expiry: Duration::minutes(config.download_token_expiry_minutes),
        })
    }

    pub fn generate_token(&self, user_id: Uuid, username: &str, role: &str) -> Result<String> {
        let now = Utc::now();
        let exp = now + self.expiry;
        let claims = Claims {
            sub: user_id,
            username: username.to_owned(),
            role: role.to_owned(),
            iss: self.issuer.clone(),
            aud: self.audience.clone(),
            iat: now.timestamp() as usize,
            exp: exp.timestamp() as usize,
        };

        Ok(encode(&Header::default(), &claims, &self.encoding)?)
    }

    pub fn verify_token(&self, token: &str) -> Result<Claims> {
        let mut validation = Validation::default();
        validation.set_audience(&[self.audience.clone()]);
        validation.set_issuer(&[self.issuer.clone()]);
        let data = decode::<Claims>(token, &self.decoding, &validation)?;
        Ok(data.claims)
    }

    pub fn generate_download_token(&self, document_id: Uuid, user_id: Uuid) -> Result<String> {
        let now = Utc::now();
        let exp = now + self.download_expiry;
        let claims = DownloadClaims {
            doc_id: document_id,
            user_id,
            iss: self.issuer.clone(),
            aud: self.download_audience.clone(),
            iat: now.timestamp() as usize,
            exp: exp.timestamp() as usize,
        };

        Ok(encode(&Header::default(), &claims, &self.encoding)?)
    }

    pub fn verify_download_token(&self, token: &str) -> Result<DownloadClaims> {
        let mut validation = Validation::default();
        validation.set_audience(&[self.download_audience.clone()]);
        validation.set_issuer(&[self.issuer.clone()]);
        let data = decode::<DownloadClaims>(token, &self.decoding, &validation)?;
        Ok(data.claims)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: Uuid,
    pub username: String,
    pub role: String,
    pub iss: String,
    pub aud: String,
    pub iat: usize,
    pub exp: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadClaims {
    pub doc_id: Uuid,
    pub user_id: Uuid,
    pub iss: String,
    pub aud: String,
    pub iat: usize,
    pub exp: usize,
}
