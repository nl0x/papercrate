use axum::{http::StatusCode, response::Json};
use serde_json::json;

pub async fn health_check() -> (StatusCode, Json<serde_json::Value>) {
    (StatusCode::OK, Json(json!({ "status": "ok" })))
}
