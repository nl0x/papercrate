mod common;

use anyhow::Result;
use axum::http::StatusCode;
use common::{acquire_db_lock, body_to_vec, TestApp};
use serde::Deserialize;
use serde::Serialize;
use uuid::Uuid;

#[derive(Deserialize)]
struct DocumentDetail {
    document: DocumentInfo,
}

#[derive(Deserialize)]
struct DocumentInfo {
    id: Uuid,
    tags: Vec<TagInfo>,
}

#[derive(Deserialize)]
struct TagInfo {
    label: String,
    #[allow(dead_code)]
    color: Option<String>,
}

#[derive(Deserialize)]
struct TagResponse {
    id: Uuid,
    label: String,
    color: Option<String>,
    usage_count: i64,
}

#[derive(Serialize)]
struct AssignTagsRequest {
    tag_ids: Vec<Uuid>,
}

#[tokio::test]
async fn tag_assignment_flow() -> Result<()> {
    let _lock = acquire_db_lock().await;
    let app = TestApp::new().await?;

    let password = "tagpass";
    app.insert_user("tagger", password, "admin").await?;
    let token = app.login_token("tagger", password).await?;

    let upload = app
        .upload_document(
            "/api/documents",
            "tagged.txt",
            "text/plain",
            b"tag me",
            None,
            &token,
        )
        .await?;
    assert_eq!(upload.status(), StatusCode::CREATED);
    let upload_body = body_to_vec(upload.into_body()).await?;
    let detail: DocumentDetail = serde_json::from_slice(&upload_body)?;

    #[derive(Serialize)]
    struct CreateTagPayload<'a> {
        label: &'a str,
        color: Option<&'a str>,
    }

    let create_tag = app
        .post_json(
            "/api/tags",
            &CreateTagPayload {
                label: "Important",
                color: Some("#FF0000"),
            },
            Some(&token),
        )
        .await?;
    assert_eq!(create_tag.status(), StatusCode::OK);
    let body = body_to_vec(create_tag.into_body()).await?;
    let tag: TagResponse = serde_json::from_slice(&body)?;
    assert_eq!(tag.label, "Important");
    assert_eq!(tag.color.as_deref(), Some("#FF0000"));
    assert_eq!(tag.usage_count, 0);

    let update = app
        .patch_json(
            &format!("/api/tags/{}", tag.id),
            &serde_json::json!({
                "label": "Critical",
                "color": "#00FF00"
            }),
            Some(&token),
        )
        .await?;
    let updated_status = update.status();
    let updated_body = body_to_vec(update.into_body()).await?;
    if updated_status != StatusCode::OK {
        panic!(
            "update tag failed: {}",
            String::from_utf8_lossy(&updated_body)
        );
    }
    let updated: TagResponse = serde_json::from_slice(&updated_body)?;
    assert_eq!(updated.label, "Critical");
    assert_eq!(updated.color.as_deref(), Some("#00FF00"));
    assert_eq!(updated.usage_count, 0);

    let clear_color = app
        .patch_json(
            &format!("/api/tags/{}", tag.id),
            &serde_json::json!({
                "color": null
            }),
            Some(&token),
        )
        .await?;
    let cleared_status = clear_color.status();
    let cleared_body = body_to_vec(clear_color.into_body()).await?;
    if cleared_status != StatusCode::OK {
        panic!(
            "clear color failed: {}",
            String::from_utf8_lossy(&cleared_body)
        );
    }
    let cleared: TagResponse = serde_json::from_slice(&cleared_body)?;
    assert_eq!(cleared.color, None);
    assert_eq!(cleared.usage_count, 0);

    let assign = app
        .post_json(
            &format!("/api/documents/{}/tags", detail.document.id),
            &AssignTagsRequest {
                tag_ids: vec![tag.id],
            },
            Some(&token),
        )
        .await?;
    assert_eq!(assign.status(), StatusCode::NO_CONTENT);

    let refreshed = app
        .get(
            &format!("/api/documents/{}", detail.document.id),
            Some(&token),
        )
        .await?;
    assert_eq!(refreshed.status(), StatusCode::OK);
    let refreshed_body = body_to_vec(refreshed.into_body()).await?;
    let refreshed_detail: DocumentDetail = serde_json::from_slice(&refreshed_body)?;
    assert_eq!(refreshed_detail.document.tags.len(), 1);
    assert_eq!(refreshed_detail.document.tags[0].label, "Critical");

    let remove = app
        .delete(
            &format!("/api/documents/{}/tags/{}", detail.document.id, tag.id),
            Some(&token),
        )
        .await?;
    assert_eq!(remove.status(), StatusCode::NO_CONTENT);

    let final_check = app
        .get(
            &format!("/api/documents/{}", detail.document.id),
            Some(&token),
        )
        .await?;
    let final_body = body_to_vec(final_check.into_body()).await?;
    let final_detail: DocumentDetail = serde_json::from_slice(&final_body)?;
    assert!(final_detail.document.tags.is_empty());

    app.cleanup().await?;
    Ok(())
}
