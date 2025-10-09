mod common;

use anyhow::Result;
use axum::http::StatusCode;
use common::{acquire_db_lock, body_to_vec, TestApp};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize)]
struct DocumentDetail {
    document: DocumentInfo,
}

#[derive(Deserialize)]
struct DocumentInfo {
    id: Uuid,
    title: String,
    original_name: String,
    deleted_at: Option<String>,
    issued_at: Option<String>,
    tags: Vec<TagSummary>,
    #[serde(default)]
    correspondents: Vec<DocumentCorrespondentInfo>,
    #[serde(default)]
    current_version: Option<DocumentVersion>,
}

#[derive(Deserialize)]
struct DocumentVersion {
    id: Uuid,
    s3_key: String,
    size_bytes: i64,
    version_number: i32,
    download_path: String,
    #[serde(default)]
    assets: Vec<DocumentAssetInfo>,
}

#[allow(dead_code)]
#[derive(Deserialize)]
struct DocumentAssetInfo {
    id: Uuid,
    asset_type: String,
}

#[derive(Deserialize)]
struct DocumentListItem {
    id: Uuid,
    #[serde(default)]
    current_version: Option<DocumentVersion>,
}

#[derive(Deserialize)]
struct DocumentDownload {
    url: String,
    filename: String,
}

#[derive(Deserialize)]
struct BulkReanalyze {
    queued: usize,
}

#[derive(Deserialize)]
struct BulkMoveResult {
    updated: usize,
}

#[derive(Deserialize)]
struct BulkTagResult {
    added: usize,
    removed: usize,
}

#[derive(Deserialize)]
struct TagSummary {
    label: String,
}

#[derive(Deserialize)]
struct DocumentCorrespondentInfo {
    name: String,
    role: String,
}

#[derive(Deserialize)]
struct CorrespondentSummary {
    id: Uuid,
}

#[derive(Deserialize)]
struct BulkCorrespondentResult {
    assigned: usize,
    removed: usize,
}

#[derive(Deserialize)]
struct AnalyzeJobPayload {
    document_id: Uuid,
    document_version_id: Uuid,
    #[serde(default)]
    force: bool,
}

#[derive(Deserialize)]
struct FolderResponse {
    folder: FolderInfo,
}

#[derive(Deserialize)]
struct FolderInfo {
    id: Uuid,
}

#[derive(Deserialize)]
struct FolderContents {
    documents: Vec<DocumentListItem>,
}

#[derive(Deserialize)]
struct TagResponse {
    id: Uuid,
}

#[derive(Serialize)]
struct BulkMoveRequest<'a> {
    document_ids: &'a [Uuid],
    folder_id: Option<Uuid>,
}

#[derive(Serialize)]
struct BulkTagRequest<'a> {
    document_ids: &'a [Uuid],
    tag_ids: &'a [Uuid],
    action: &'a str,
}

#[derive(Serialize)]
struct CreateFolderRequest<'a> {
    name: &'a str,
    parent_id: Option<Uuid>,
}

#[derive(Serialize)]
struct CreateTagPayload<'a> {
    label: &'a str,
    color: Option<&'a str>,
}

#[tokio::test]
async fn upload_and_list_document() -> Result<()> {
    let _lock = acquire_db_lock().await;
    let app = TestApp::new().await?;

    let password = "passw0rd";
    app.insert_user("dana", password, "admin").await?;
    let token = app.login_token("dana", password).await?;

    let file_bytes = b"example document body".to_vec();
    let upload = app
        .upload_document(
            "/api/documents",
            "doc.txt",
            "text/plain",
            &file_bytes,
            None,
            &token,
        )
        .await?;
    assert_eq!(upload.status(), StatusCode::CREATED);
    let body = body_to_vec(upload.into_body()).await?;
    let detail: DocumentDetail = serde_json::from_slice(&body)?;

    assert_eq!(detail.document.original_name, "doc.txt");
    assert_eq!(detail.document.title, "doc");
    assert_eq!(detail.document.deleted_at, None);
    assert!(detail.document.issued_at.is_none());
    assert!(detail.document.tags.is_empty());
    let current_version = detail
        .document
        .current_version
        .as_ref()
        .expect("current version detail");
    assert!(current_version.download_path.starts_with("/download/"));
    assert_eq!(current_version.version_number, 1);
    assert_eq!(current_version.size_bytes, file_bytes.len() as i64);
    assert!(current_version.assets.is_empty());

    let stored = app
        .storage()
        .get(&current_version.s3_key)
        .await
        .expect("object stored");
    assert_eq!(stored.bytes, file_bytes);
    assert_eq!(app.storage().object_count().await, 1);

    let response = app.get("/api/documents", Some(&token)).await?;
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_to_vec(response.into_body()).await?;
    let mut list: Vec<DocumentListItem> = serde_json::from_slice(&body)?;
    assert_eq!(list.len(), 1);
    let item = list.pop().unwrap();
    assert_eq!(item.id, detail.document.id);
    assert_eq!(
        item.current_version
            .as_ref()
            .map(|version| version.version_number),
        Some(1)
    );
    assert!(item
        .current_version
        .as_ref()
        .expect("list current version")
        .download_path
        .starts_with("/download/"));

    let download = app
        .get(
            &format!("/api/documents/{}/download", detail.document.id),
            Some(&token),
        )
        .await?;
    assert_eq!(download.status(), StatusCode::OK);
    let body = body_to_vec(download.into_body()).await?;
    let download_info: DocumentDownload = serde_json::from_slice(&body)?;
    assert!(download_info.url.contains(&current_version.s3_key));
    assert_eq!(download_info.filename, "doc.txt");

    let redirect = app.get(&current_version.download_path, None).await?;
    assert_eq!(redirect.status(), StatusCode::TEMPORARY_REDIRECT);
    let location = redirect
        .headers()
        .get("location")
        .expect("redirect location header");
    let location = location.to_str().expect("location header utf8");
    assert!(location.contains(&current_version.s3_key));

    app.cleanup().await?;
    Ok(())
}

#[tokio::test]
async fn duplicate_and_restore_document() -> Result<()> {
    let _lock = acquire_db_lock().await;
    let app = TestApp::new().await?;

    let password = "pass1234";
    app.insert_user("sam", password, "admin").await?;
    let token = app.login_token("sam", password).await?;

    let payload = b"same bytes".to_vec();
    let first = app
        .upload_document(
            "/api/documents",
            "dup.bin",
            "application/octet-stream",
            &payload,
            None,
            &token,
        )
        .await?;
    assert_eq!(first.status(), StatusCode::CREATED);
    let first_body = body_to_vec(first.into_body()).await?;
    let first_detail: DocumentDetail = serde_json::from_slice(&first_body)?;

    let second = app
        .upload_document(
            "/api/documents",
            "dup.bin",
            "application/octet-stream",
            &payload,
            None,
            &token,
        )
        .await?;
    assert_eq!(second.status(), StatusCode::OK);
    let second_body = body_to_vec(second.into_body()).await?;
    let second_detail: DocumentDetail = serde_json::from_slice(&second_body)?;

    assert_eq!(first_detail.document.id, second_detail.document.id);
    assert_eq!(second_detail.document.deleted_at, None);
    assert!(second_detail
        .document
        .current_version
        .as_ref()
        .expect("second current version")
        .assets
        .is_empty());
    assert_eq!(app.storage().object_count().await, 1);

    let delete = app
        .delete(
            &format!("/api/documents/{}", first_detail.document.id),
            Some(&token),
        )
        .await?;
    assert_eq!(delete.status(), StatusCode::NO_CONTENT);

    let third = app
        .upload_document(
            "/api/documents",
            "dup.bin",
            "application/octet-stream",
            &payload,
            None,
            &token,
        )
        .await?;
    assert_eq!(third.status(), StatusCode::OK);
    let third_body = body_to_vec(third.into_body()).await?;
    let third_detail: DocumentDetail = serde_json::from_slice(&third_body)?;

    assert_eq!(third_detail.document.id, first_detail.document.id);
    assert_eq!(third_detail.document.deleted_at, None);
    assert_eq!(app.storage().object_count().await, 1);

    app.cleanup().await?;
    Ok(())
}

#[tokio::test]
async fn bulk_reanalyze_documents() -> Result<()> {
    let _lock = acquire_db_lock().await;
    let app = TestApp::new().await?;

    let password = "bulkpass";
    app.insert_user("alex", password, "admin").await?;
    let token = app.login_token("alex", password).await?;

    app.clear_jobs().await?;

    let first_bytes = b"first doc";
    let first = app
        .upload_document(
            "/api/documents",
            "first.txt",
            "text/plain",
            first_bytes,
            None,
            &token,
        )
        .await?;
    assert_eq!(first.status(), StatusCode::CREATED);
    let first_body = body_to_vec(first.into_body()).await?;
    let first_detail: DocumentDetail = serde_json::from_slice(&first_body)?;

    let second_bytes = b"second doc";
    let second = app
        .upload_document(
            "/api/documents",
            "second.txt",
            "text/plain",
            second_bytes,
            None,
            &token,
        )
        .await?;
    assert_eq!(second.status(), StatusCode::CREATED);
    let second_body = body_to_vec(second.into_body()).await?;
    let second_detail: DocumentDetail = serde_json::from_slice(&second_body)?;

    app.clear_jobs().await?;

    let response = app
        .post_json(
            "/api/documents/reanalyze",
            &serde_json::json!({}),
            Some(&token),
        )
        .await?;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let body = body_to_vec(response.into_body()).await?;
    let bulk: BulkReanalyze = serde_json::from_slice(&body)?;
    assert_eq!(bulk.queued, 2);

    let jobs = app.jobs_by_type("analyze-document").await?;
    assert_eq!(jobs.len(), 2);
    let mut payload_docs = Vec::new();
    for job in jobs {
        let payload: AnalyzeJobPayload = serde_json::from_value(job.payload)?;
        assert!(payload.force);
        payload_docs.push((payload.document_id, payload.document_version_id));
    }

    let mut expected = vec![
        (
            first_detail.document.id,
            first_detail
                .document
                .current_version
                .as_ref()
                .expect("first current version")
                .id,
        ),
        (
            second_detail.document.id,
            second_detail
                .document
                .current_version
                .as_ref()
                .expect("second current version")
                .id,
        ),
    ];
    payload_docs.sort();
    expected.sort();
    assert_eq!(payload_docs, expected);

    app.cleanup().await?;
    Ok(())
}

#[tokio::test]
async fn bulk_move_documents_to_folder() -> Result<()> {
    let _lock = acquire_db_lock().await;
    let app = TestApp::new().await?;

    let password = "bulkmove";
    app.insert_user("mover", password, "admin").await?;
    let token = app.login_token("mover", password).await?;

    let alpha = app
        .upload_document(
            "/api/documents",
            "alpha.txt",
            "text/plain",
            b"alpha",
            None,
            &token,
        )
        .await?;
    assert_eq!(alpha.status(), StatusCode::CREATED);
    let alpha_body = body_to_vec(alpha.into_body()).await?;
    let alpha_detail: DocumentDetail = serde_json::from_slice(&alpha_body)?;

    let beta = app
        .upload_document(
            "/api/documents",
            "beta.txt",
            "text/plain",
            b"beta",
            None,
            &token,
        )
        .await?;
    assert_eq!(beta.status(), StatusCode::CREATED);
    let beta_body = body_to_vec(beta.into_body()).await?;
    let beta_detail: DocumentDetail = serde_json::from_slice(&beta_body)?;

    let folder_resp = app
        .post_json(
            "/api/folders",
            &CreateFolderRequest {
                name: "Archives",
                parent_id: None,
            },
            Some(&token),
        )
        .await?;
    assert_eq!(folder_resp.status(), StatusCode::OK);
    let folder_body = body_to_vec(folder_resp.into_body()).await?;
    let folder: FolderResponse = serde_json::from_slice(&folder_body)?;

    let move_resp = app
        .post_json(
            "/api/documents/bulk/move",
            &BulkMoveRequest {
                document_ids: &[alpha_detail.document.id, beta_detail.document.id],
                folder_id: Some(folder.folder.id),
            },
            Some(&token),
        )
        .await?;
    assert_eq!(move_resp.status(), StatusCode::OK);
    let move_body = body_to_vec(move_resp.into_body()).await?;
    let result: BulkMoveResult = serde_json::from_slice(&move_body)?;
    assert_eq!(result.updated, 2);

    let folder_contents = app
        .get(
            &format!("/api/folders/{}/contents", folder.folder.id),
            Some(&token),
        )
        .await?;
    assert_eq!(folder_contents.status(), StatusCode::OK);
    let folder_body = body_to_vec(folder_contents.into_body()).await?;
    let folder_docs: FolderContents = serde_json::from_slice(&folder_body)?;
    let moved_ids: Vec<_> = folder_docs.documents.iter().map(|doc| doc.id).collect();
    assert!(moved_ids.contains(&alpha_detail.document.id));
    assert!(moved_ids.contains(&beta_detail.document.id));

    let root_contents = app.get("/api/folders/root/contents", Some(&token)).await?;
    let root_body = body_to_vec(root_contents.into_body()).await?;
    let root_docs: FolderContents = serde_json::from_slice(&root_body)?;
    assert!(root_docs
        .documents
        .iter()
        .all(|doc| doc.id != alpha_detail.document.id && doc.id != beta_detail.document.id));

    app.cleanup().await?;
    Ok(())
}

#[tokio::test]
async fn bulk_update_tags_for_selection() -> Result<()> {
    let _lock = acquire_db_lock().await;
    let app = TestApp::new().await?;

    let password = "bulktags";
    app.insert_user("tagger", password, "admin").await?;
    let token = app.login_token("tagger", password).await?;

    let first = app
        .upload_document(
            "/api/documents",
            "notes.txt",
            "text/plain",
            b"notes",
            None,
            &token,
        )
        .await?;
    assert_eq!(first.status(), StatusCode::CREATED);
    let first_body = body_to_vec(first.into_body()).await?;
    let first_detail: DocumentDetail = serde_json::from_slice(&first_body)?;

    let second = app
        .upload_document(
            "/api/documents",
            "report.txt",
            "text/plain",
            b"report",
            None,
            &token,
        )
        .await?;
    assert_eq!(second.status(), StatusCode::CREATED);
    let second_body = body_to_vec(second.into_body()).await?;
    let second_detail: DocumentDetail = serde_json::from_slice(&second_body)?;

    let urgent_tag = app
        .post_json(
            "/api/tags",
            &CreateTagPayload {
                label: "Urgent",
                color: None,
            },
            Some(&token),
        )
        .await?;
    assert_eq!(urgent_tag.status(), StatusCode::OK);
    let urgent_body = body_to_vec(urgent_tag.into_body()).await?;
    let urgent: TagResponse = serde_json::from_slice(&urgent_body)?;

    let review_tag = app
        .post_json(
            "/api/tags",
            &CreateTagPayload {
                label: "Review",
                color: None,
            },
            Some(&token),
        )
        .await?;
    assert_eq!(review_tag.status(), StatusCode::OK);
    let review_body = body_to_vec(review_tag.into_body()).await?;
    let review: TagResponse = serde_json::from_slice(&review_body)?;

    let add_resp = app
        .post_json(
            "/api/documents/bulk/tags",
            &BulkTagRequest {
                document_ids: &[first_detail.document.id, second_detail.document.id],
                tag_ids: &[urgent.id, review.id],
                action: "add",
            },
            Some(&token),
        )
        .await?;
    assert_eq!(add_resp.status(), StatusCode::OK);
    let add_body = body_to_vec(add_resp.into_body()).await?;
    let add_result: BulkTagResult = serde_json::from_slice(&add_body)?;
    assert_eq!(add_result.added, 4);

    for doc_id in [&first_detail.document.id, &second_detail.document.id] {
        let refreshed = app
            .get(&format!("/api/documents/{}", doc_id), Some(&token))
            .await?;
        assert_eq!(refreshed.status(), StatusCode::OK);
        let refreshed_body = body_to_vec(refreshed.into_body()).await?;
        let detail: DocumentDetail = serde_json::from_slice(&refreshed_body)?;
        let labels: Vec<_> = detail
            .document
            .tags
            .iter()
            .map(|tag| tag.label.as_str())
            .collect();
        assert!(labels.contains(&"Urgent"));
        assert!(labels.contains(&"Review"));
    }

    let remove_resp = app
        .post_json(
            "/api/documents/bulk/tags",
            &BulkTagRequest {
                document_ids: &[first_detail.document.id, second_detail.document.id],
                tag_ids: &[urgent.id],
                action: "remove",
            },
            Some(&token),
        )
        .await?;
    assert_eq!(remove_resp.status(), StatusCode::OK);
    let remove_body = body_to_vec(remove_resp.into_body()).await?;
    let remove_result: BulkTagResult = serde_json::from_slice(&remove_body)?;
    assert_eq!(remove_result.removed, 2);

    for doc_id in [&first_detail.document.id, &second_detail.document.id] {
        let refreshed = app
            .get(&format!("/api/documents/{}", doc_id), Some(&token))
            .await?;
        let refreshed_body = body_to_vec(refreshed.into_body()).await?;
        let detail: DocumentDetail = serde_json::from_slice(&refreshed_body)?;
        let labels: Vec<_> = detail
            .document
            .tags
            .iter()
            .map(|tag| tag.label.as_str())
            .collect();
        assert!(!labels.contains(&"Urgent"));
        assert!(labels.contains(&"Review"));
    }

    app.cleanup().await?;
    Ok(())
}

#[tokio::test]
async fn bulk_assign_correspondents_to_selection() -> Result<()> {
    let _lock = acquire_db_lock().await;
    let app = TestApp::new().await?;

    let password = "bulkcorresp";
    app.insert_user("corra", password, "admin").await?;
    let token = app.login_token("corra", password).await?;

    let first = app
        .upload_document(
            "/api/documents",
            "letter-one.txt",
            "text/plain",
            b"letter one",
            None,
            &token,
        )
        .await?;
    assert_eq!(first.status(), StatusCode::CREATED);
    let first_body = body_to_vec(first.into_body()).await?;
    let first_detail: DocumentDetail = serde_json::from_slice(&first_body)?;

    let second = app
        .upload_document(
            "/api/documents",
            "letter-two.txt",
            "text/plain",
            b"letter two",
            None,
            &token,
        )
        .await?;
    assert_eq!(second.status(), StatusCode::CREATED);
    let second_body = body_to_vec(second.into_body()).await?;
    let second_detail: DocumentDetail = serde_json::from_slice(&second_body)?;

    let sender = app
        .post_json(
            "/api/correspondents",
            &serde_json::json!({ "name": "Acme Corp" }),
            Some(&token),
        )
        .await?;
    assert_eq!(sender.status(), StatusCode::OK);
    let sender_body = body_to_vec(sender.into_body()).await?;
    let sender_summary: CorrespondentSummary = serde_json::from_slice(&sender_body)?;

    let receiver = app
        .post_json(
            "/api/correspondents",
            &serde_json::json!({ "name": "Bank Ltd" }),
            Some(&token),
        )
        .await?;
    assert_eq!(receiver.status(), StatusCode::OK);
    let receiver_body = body_to_vec(receiver.into_body()).await?;
    let receiver_summary: CorrespondentSummary = serde_json::from_slice(&receiver_body)?;

    let assign_payload = serde_json::json!({
        "document_ids": [
            first_detail.document.id,
            second_detail.document.id
        ],
        "assignments": [
            {
                "correspondent_id": sender_summary.id,
                "role": "sender"
            },
            {
                "correspondent_id": receiver_summary.id,
                "role": "receiver"
            }
        ]
    });

    let assign_resp = app
        .post_json(
            "/api/documents/bulk/correspondents",
            &assign_payload,
            Some(&token),
        )
        .await?;
    assert_eq!(assign_resp.status(), StatusCode::OK);
    let assign_body = body_to_vec(assign_resp.into_body()).await?;
    let assign_result: BulkCorrespondentResult = serde_json::from_slice(&assign_body)?;
    assert_eq!(assign_result.assigned, 4);
    assert_eq!(assign_result.removed, 0);

    for doc_id in [first_detail.document.id, second_detail.document.id] {
        let refreshed = app
            .get(&format!("/api/documents/{doc_id}"), Some(&token))
            .await?;
        assert_eq!(refreshed.status(), StatusCode::OK);
        let refreshed_body = body_to_vec(refreshed.into_body()).await?;
        let detail: DocumentDetail = serde_json::from_slice(&refreshed_body)?;
        assert_eq!(detail.document.correspondents.len(), 2);
        assert!(detail
            .document
            .correspondents
            .iter()
            .any(|entry| entry.role == "sender" && entry.name == "Acme Corp"));
        assert!(detail
            .document
            .correspondents
            .iter()
            .any(|entry| entry.role == "receiver" && entry.name == "Bank Ltd"));
    }

    let duplicate_resp = app
        .post_json(
            "/api/documents/bulk/correspondents",
            &assign_payload,
            Some(&token),
        )
        .await?;
    assert_eq!(duplicate_resp.status(), StatusCode::OK);
    let duplicate_body = body_to_vec(duplicate_resp.into_body()).await?;
    let duplicate_result: BulkCorrespondentResult = serde_json::from_slice(&duplicate_body)?;
    assert_eq!(duplicate_result.assigned, 0);
    assert_eq!(duplicate_result.removed, 0);

    let replacement = app
        .post_json(
            "/api/correspondents",
            &serde_json::json!({ "name": "Charlie" }),
            Some(&token),
        )
        .await?;
    assert_eq!(replacement.status(), StatusCode::OK);
    let replacement_body = body_to_vec(replacement.into_body()).await?;
    let replacement_summary: CorrespondentSummary = serde_json::from_slice(&replacement_body)?;

    let replace_payload = serde_json::json!({
        "document_ids": [
            first_detail.document.id,
            second_detail.document.id
        ],
        "assignments": [
            {
                "correspondent_id": replacement_summary.id,
                "role": "sender"
            }
        ]
    });

    let replace_resp = app
        .post_json(
            "/api/documents/bulk/correspondents",
            &replace_payload,
            Some(&token),
        )
        .await?;
    assert_eq!(replace_resp.status(), StatusCode::OK);
    let replace_body = body_to_vec(replace_resp.into_body()).await?;
    let replace_result: BulkCorrespondentResult = serde_json::from_slice(&replace_body)?;
    assert_eq!(replace_result.assigned, 2);
    assert_eq!(replace_result.removed, 2);

    for doc_id in [first_detail.document.id, second_detail.document.id] {
        let refreshed = app
            .get(&format!("/api/documents/{doc_id}"), Some(&token))
            .await?;
        let refreshed_body = body_to_vec(refreshed.into_body()).await?;
        let detail: DocumentDetail = serde_json::from_slice(&refreshed_body)?;
        assert_eq!(detail.document.correspondents.len(), 2);
        assert!(detail
            .document
            .correspondents
            .iter()
            .any(|entry| entry.role == "sender" && entry.name == "Charlie"));
        assert!(detail
            .document
            .correspondents
            .iter()
            .any(|entry| entry.role == "receiver" && entry.name == "Bank Ltd"));
    }

    let remove_payload = serde_json::json!({
        "document_ids": [
            first_detail.document.id,
            second_detail.document.id
        ],
        "assignments": [
            {
                "correspondent_id": receiver_summary.id,
                "role": "receiver"
            }
        ],
        "action": "remove"
    });

    let remove_resp = app
        .post_json(
            "/api/documents/bulk/correspondents",
            &remove_payload,
            Some(&token),
        )
        .await?;
    assert_eq!(remove_resp.status(), StatusCode::OK);
    let remove_body = body_to_vec(remove_resp.into_body()).await?;
    let remove_result: BulkCorrespondentResult = serde_json::from_slice(&remove_body)?;
    assert_eq!(remove_result.assigned, 0);
    assert_eq!(remove_result.removed, 2);

    for doc_id in [first_detail.document.id, second_detail.document.id] {
        let refreshed = app
            .get(&format!("/api/documents/{doc_id}"), Some(&token))
            .await?;
        let refreshed_body = body_to_vec(refreshed.into_body()).await?;
        let detail: DocumentDetail = serde_json::from_slice(&refreshed_body)?;
        assert_eq!(detail.document.correspondents.len(), 1);
        assert!(detail
            .document
            .correspondents
            .iter()
            .any(|entry| entry.role == "sender" && entry.name == "Charlie"));
        assert!(!detail
            .document
            .correspondents
            .iter()
            .any(|entry| entry.role == "receiver"));
    }

    app.cleanup().await?;
    Ok(())
}

#[tokio::test]
async fn bulk_reanalyze_selected_documents() -> Result<()> {
    let _lock = acquire_db_lock().await;
    let app = TestApp::new().await?;

    let password = "subsetrean";
    app.insert_user("subset", password, "admin").await?;
    let token = app.login_token("subset", password).await?;

    app.clear_jobs().await?;

    let first = app
        .upload_document(
            "/api/documents",
            "doc-one.txt",
            "text/plain",
            b"one",
            None,
            &token,
        )
        .await?;
    let first_body = body_to_vec(first.into_body()).await?;
    let first_detail: DocumentDetail = serde_json::from_slice(&first_body)?;

    let second = app
        .upload_document(
            "/api/documents",
            "doc-two.txt",
            "text/plain",
            b"two",
            None,
            &token,
        )
        .await?;
    let second_body = body_to_vec(second.into_body()).await?;
    let second_detail: DocumentDetail = serde_json::from_slice(&second_body)?;

    let third = app
        .upload_document(
            "/api/documents",
            "doc-three.txt",
            "text/plain",
            b"three",
            None,
            &token,
        )
        .await?;
    let third_body = body_to_vec(third.into_body()).await?;
    let third_detail: DocumentDetail = serde_json::from_slice(&third_body)?;

    app.clear_jobs().await?;

    let response = app
        .post_json(
            "/api/documents/bulk/reanalyze",
            &serde_json::json!({
                "document_ids": [
                    first_detail.document.id,
                    third_detail.document.id
                ],
                "force": true
            }),
            Some(&token),
        )
        .await?;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let body = body_to_vec(response.into_body()).await?;
    let bulk: BulkReanalyze = serde_json::from_slice(&body)?;
    assert_eq!(bulk.queued, 2);

    let jobs = app.jobs_by_type("analyze-document").await?;
    assert_eq!(jobs.len(), 2);
    let mut payload_docs = Vec::new();
    for job in jobs {
        let payload: AnalyzeJobPayload = serde_json::from_value(job.payload)?;
        assert!(payload.force);
        payload_docs.push((payload.document_id, payload.document_version_id));
    }

    assert!(payload_docs
        .iter()
        .all(|(doc_id, _)| *doc_id != second_detail.document.id));

    let mut expected = vec![
        (
            first_detail.document.id,
            first_detail
                .document
                .current_version
                .as_ref()
                .expect("first current version")
                .id,
        ),
        (
            third_detail.document.id,
            third_detail
                .document
                .current_version
                .as_ref()
                .expect("third current version")
                .id,
        ),
    ];
    payload_docs.sort();
    expected.sort();
    assert_eq!(payload_docs, expected);

    app.cleanup().await?;
    Ok(())
}
