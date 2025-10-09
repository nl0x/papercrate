mod common;

use anyhow::Result;
use axum::http::StatusCode;
use common::{acquire_db_lock, body_to_vec, TestApp};
use serde::Deserialize;

#[derive(Deserialize)]
struct AuthenticatedUser {
    username: String,
    role: String,
}

#[tokio::test]
async fn login_and_me_roundtrip() -> Result<()> {
    let _lock = acquire_db_lock().await;
    let app = TestApp::new().await?;

    let password = "s3cret";
    app.insert_user("alice", password, "admin").await?;

    let token = app.login_token("alice", password).await?;

    let response = app.get("/api/auth/me", Some(&token)).await?;
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_to_vec(response.into_body()).await?;
    let user: AuthenticatedUser = serde_json::from_slice(&body)?;

    assert_eq!(user.username, "alice");
    assert_eq!(user.role, "admin");

    app.cleanup().await?;
    Ok(())
}
