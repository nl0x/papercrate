use anyhow::{anyhow, Result};
use argon2::{
    password_hash::{PasswordHash, PasswordVerifier},
    Argon2,
};

pub fn verify_password(password: &str, password_hash: &str) -> Result<bool> {
    let parsed_hash = PasswordHash::new(password_hash).map_err(|err| anyhow!(err))?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok())
}
