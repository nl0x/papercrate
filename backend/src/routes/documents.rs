use std::{
    collections::{HashMap, HashSet},
    path::Path as FsPath,
    time::Duration,
};

use axum::extract::{Json, Multipart, Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use chrono::{DateTime, NaiveDateTime, Utc};
use diesel::dsl::exists;
use diesel::{prelude::*, result::DatabaseErrorKind, select, PgConnection};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use super::folders::gather_descendant_folder_ids;
use crate::auth::AuthenticatedUser;
use crate::error::{AppError, AppResult};
use crate::jobs::{enqueue_job, JOB_ANALYZE_DOCUMENT};
use crate::models::{
    Correspondent, Document, DocumentAsset, DocumentCorrespondent, DocumentVersion, NewDocument,
    NewDocumentCorrespondent, NewDocumentTag, NewDocumentVersion, Tag,
};
use crate::schema::{
    correspondents, document_assets, document_correspondents, document_tags, document_versions,
    documents, folders, refresh_tokens::dsl as refresh_dsl, tags,
};
use crate::state::AppState;

const PRESIGNED_URL_EXPIRY_SECONDS: u64 = 300;
const QUICKWIT_MAX_HITS: usize = 200;
pub const CORRESPONDENT_ROLES: &[&str] = &["sender", "receiver", "other"];

fn normalize_role(value: &str) -> String {
    value.trim().to_lowercase()
}

fn is_valid_correspondent_role(role: &str) -> bool {
    CORRESPONDENT_ROLES.iter().any(|allowed| *allowed == role)
}

fn inline_content_disposition(filename: &str) -> Option<String> {
    if filename.is_empty() {
        return None;
    }

    let sanitized: String = filename
        .chars()
        .map(|ch| match ch {
            '"' | '\\' => '_',
            _ => ch,
        })
        .collect();

    let encoded =
        percent_encoding::utf8_percent_encode(&sanitized, percent_encoding::NON_ALPHANUMERIC);
    Some(format!(
        "inline; filename=\"{}\"; filename*=UTF-8''{}",
        sanitized, encoded
    ))
}

#[derive(Deserialize)]
pub struct DocumentListQuery {
    pub folder_id: Option<Uuid>,
    #[serde(default)]
    pub include_deleted: bool,
    #[serde(default)]
    pub include_descendants: Option<bool>,
    pub query: Option<String>,
    pub tags: Option<String>,
    pub correspondents: Option<String>,
}

#[derive(Deserialize)]
pub struct AssetRequestQuery {
    #[serde(default)]
    pub force: bool,
}

#[derive(Serialize)]
pub struct TagResponse {
    pub id: Uuid,
    pub label: String,
    pub color: Option<String>,
}

impl From<Tag> for TagResponse {
    fn from(tag: Tag) -> Self {
        Self {
            id: tag.id,
            label: tag.label,
            color: tag.color,
        }
    }
}

#[derive(Serialize, Clone)]
pub struct DocumentVersionResponse {
    pub id: Uuid,
    pub version_number: i32,
    pub s3_key: String,
    pub size_bytes: i64,
    pub checksum: String,
    pub created_at: String,
    pub metadata: Value,
    pub operations_summary: Value,
}

#[derive(Serialize, Clone)]
pub struct DocumentAssetResponse {
    pub id: Uuid,
    pub asset_type: String,
    pub mime_type: String,
    pub metadata: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub created_at: String,
}

#[derive(Serialize, Clone)]
pub struct DocumentCurrentVersionResponse {
    #[serde(flatten)]
    pub version: DocumentVersionResponse,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub assets: Vec<DocumentAssetResponse>,
    pub download_path: String,
}

#[derive(Serialize, Clone)]
pub struct DocumentCorrespondentResponse {
    pub id: Uuid,
    pub name: String,
    pub role: String,
    pub metadata: Value,
    pub assigned_at: String,
}

#[derive(Serialize)]
pub struct DocumentResponse {
    pub id: Uuid,
    pub filename: String,
    pub title: String,
    pub original_name: String,
    pub content_type: Option<String>,
    pub folder_id: Option<Uuid>,
    pub uploaded_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub issued_at: Option<String>,
    pub metadata: Value,
    pub tags: Vec<TagResponse>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub correspondents: Vec<DocumentCorrespondentResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_version: Option<DocumentCurrentVersionResponse>,
}
#[derive(Serialize)]
pub struct DocumentDetailResponse {
    pub document: DocumentResponse,
}

#[derive(Serialize)]
pub struct DocumentDownloadResponse {
    pub url: String,
    pub expires_in: u64,
    pub filename: String,
    pub content_type: Option<String>,
    pub size_bytes: i64,
}

#[derive(Serialize)]
pub struct BulkReanalyzeResponse {
    pub queued: usize,
}

#[derive(Deserialize)]
pub struct BulkMoveRequest {
    pub document_ids: Vec<Uuid>,
    pub folder_id: Option<Uuid>,
}

#[derive(Deserialize)]
pub struct UpdateDocumentRequest {
    pub title: Option<String>,
}

#[derive(Serialize)]
pub struct BulkMoveResponse {
    pub updated: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BulkTagAction {
    Add,
    Remove,
}

#[derive(Deserialize)]
pub struct BulkTagRequest {
    pub document_ids: Vec<Uuid>,
    pub tag_ids: Vec<Uuid>,
    pub action: BulkTagAction,
}

#[derive(Serialize)]
pub struct BulkTagResponse {
    pub added: usize,
    pub removed: usize,
}

#[derive(Serialize)]
pub struct BulkCorrespondentResponse {
    pub assigned: usize,
    pub removed: usize,
}

#[derive(Deserialize)]
pub struct CorrespondentAssignmentInput {
    pub correspondent_id: Uuid,
    pub role: String,
}

#[derive(Deserialize)]
pub struct AssignCorrespondentsRequest {
    pub assignments: Vec<CorrespondentAssignmentInput>,
    #[serde(default)]
    pub replace: bool,
}

#[derive(Deserialize, Copy, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BulkCorrespondentAction {
    Add,
    Remove,
}

fn default_bulk_correspondent_action() -> BulkCorrespondentAction {
    BulkCorrespondentAction::Add
}

#[derive(Deserialize)]
pub struct BulkCorrespondentsRequest {
    pub document_ids: Vec<Uuid>,
    pub assignments: Vec<CorrespondentAssignmentInput>,
    #[serde(default = "default_bulk_correspondent_action")]
    pub action: BulkCorrespondentAction,
}

fn normalize_correspondent_assignments(
    assignments: &[CorrespondentAssignmentInput],
) -> AppResult<(Vec<(Uuid, String)>, Vec<Uuid>, Vec<String>)> {
    let mut unique_pairs: HashSet<(Uuid, String)> = HashSet::new();
    let mut normalized_pairs: Vec<(Uuid, String)> = Vec::new();
    let mut role_set: HashSet<String> = HashSet::new();
    let mut correspondent_ids: HashSet<Uuid> = HashSet::new();

    for assignment in assignments {
        let role = normalize_role(&assignment.role);
        if role.is_empty() {
            return Err(AppError::bad_request("role must not be empty"));
        }
        if !is_valid_correspondent_role(&role) {
            return Err(AppError::bad_request(format!(
                "invalid correspondent role '{role}'. Allowed roles: {}",
                CORRESPONDENT_ROLES.join(", ")
            )));
        }

        if !unique_pairs.insert((assignment.correspondent_id, role.clone())) {
            continue;
        }

        normalized_pairs.push((assignment.correspondent_id, role.clone()));
        role_set.insert(role);
        correspondent_ids.insert(assignment.correspondent_id);
    }

    if normalized_pairs.is_empty() {
        return Err(AppError::bad_request(
            "assignments must contain at least one unique correspondent/role pair",
        ));
    }

    let mut correspondents_vec: Vec<Uuid> = correspondent_ids.into_iter().collect();
    correspondents_vec.sort();

    let mut roles_vec: Vec<String> = role_set.into_iter().collect();
    roles_vec.sort();

    Ok((normalized_pairs, correspondents_vec, roles_vec))
}

#[derive(Deserialize)]
pub struct CorrespondentRoleQuery {
    pub role: String,
}

#[derive(Deserialize)]
pub struct BulkReanalyzeSelectionRequest {
    pub document_ids: Vec<Uuid>,
    #[serde(default = "default_true")]
    pub force: bool,
}

fn default_true() -> bool {
    true
}

struct UploadRequest {
    bytes: Vec<u8>,
    original_name: String,
    content_type: Option<String>,
    folder_id: Option<Uuid>,
    metadata: Value,
}

struct UploadOutcome {
    detail: DocumentDetailResponse,
    created: bool,
}

#[derive(Deserialize)]
pub struct MoveDocumentRequest {
    pub folder_id: Option<Uuid>,
}

#[derive(Deserialize)]
pub struct AssignTagsRequest {
    pub tag_ids: Vec<Uuid>,
}

pub async fn list_documents(
    State(state): State<AppState>,
    Query(params): Query<DocumentListQuery>,
    user: AuthenticatedUser,
) -> AppResult<Json<Vec<DocumentResponse>>> {
    let mut conn = state.db()?;

    let DocumentListQuery {
        folder_id,
        include_deleted,
        include_descendants,
        query,
        tags,
        correspondents,
    } = params;

    let mut docs_query = documents::table.into_boxed();

    if !include_deleted {
        docs_query = docs_query.filter(documents::deleted_at.is_null());
    }

    let search_text = query
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_owned());
    let tags_param = tags
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_owned());
    let correspondents_param = correspondents
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_owned());

    let mut include_descendants = include_descendants.unwrap_or_else(|| folder_id.is_some());
    if search_text.is_some() || tags_param.is_some() || correspondents_param.is_some() {
        include_descendants = true;
    }

    match (folder_id, include_descendants) {
        (Some(folder_id), true) => {
            let descendant_ids = gather_descendant_folder_ids(&mut conn, folder_id)?;
            docs_query = docs_query.filter(documents::folder_id.eq_any(descendant_ids));
        }
        (Some(folder_id), false) => {
            docs_query = docs_query.filter(documents::folder_id.eq(Some(folder_id)));
        }
        (None, false) => {
            docs_query = docs_query.filter(documents::folder_id.is_null());
        }
        (None, true) => {}
    }

    let mut filter_ids: Option<HashSet<Uuid>> = None;
    let mut quickwit_order: Option<Vec<Uuid>> = None;

    if let Some(query_str) = search_text.as_ref() {
        debug!(query = %query_str, "performing quickwit document search");
        let endpoint = state
            .config
            .quickwit_endpoint
            .as_ref()
            .ok_or_else(|| AppError::internal("quickwit endpoint not configured"))?;
        let index = state
            .config
            .quickwit_index
            .as_ref()
            .ok_or_else(|| AppError::internal("quickwit index not configured"))?;

        let ids = quickwit_search(endpoint, index, query_str)
            .await
            .map_err(|err| AppError::internal(format!("quickwit search failed: {err}")))?;

        if ids.is_empty() {
            return Ok(Json(vec![]));
        }

        quickwit_order = Some(ids.clone());
        let set: HashSet<Uuid> = ids.into_iter().collect();
        filter_ids = Some(match &filter_ids {
            Some(existing) => existing.intersection(&set).copied().collect(),
            None => set,
        });
    }

    if let Some(tags_param) = tags_param.as_ref() {
        let tag_ids: Result<Vec<Uuid>, _> = tags_param
            .split(',')
            .map(|s| Uuid::parse_str(s.trim()))
            .collect();

        if let Ok(ids) = tag_ids {
            if !ids.is_empty() {
                let mut doc_id_set: Option<HashSet<Uuid>> = None;
                for tag_id in &ids {
                    let docs_for_tag: Vec<Uuid> = document_tags::table
                        .filter(document_tags::tag_id.eq(*tag_id))
                        .select(document_tags::document_id)
                        .load(&mut conn)?;
                    let docs_set: HashSet<Uuid> = docs_for_tag.into_iter().collect();
                    doc_id_set = Some(match doc_id_set {
                        Some(existing) => existing.intersection(&docs_set).cloned().collect(),
                        None => docs_set,
                    });

                    if let Some(ref set) = doc_id_set {
                        if set.is_empty() {
                            break;
                        }
                    }
                }

                let matching_doc_ids: HashSet<Uuid> = doc_id_set.unwrap_or_default();

                if matching_doc_ids.is_empty() {
                    return Ok(Json(vec![]));
                }

                let new_filter = match &filter_ids {
                    Some(existing) => existing.intersection(&matching_doc_ids).copied().collect(),
                    None => matching_doc_ids.clone(),
                };

                filter_ids = Some(new_filter);
            }
        }
    }

    if let Some(correspondents_param) = correspondents_param.as_ref() {
        let correspondent_ids: Result<Vec<Uuid>, _> = correspondents_param
            .split(',')
            .map(|s| Uuid::parse_str(s.trim()))
            .collect();

        if let Ok(ids) = correspondent_ids {
            if !ids.is_empty() {
                let mut doc_id_set: Option<HashSet<Uuid>> = None;
                for correspondent_id in &ids {
                    let docs_for_correspondent: Vec<Uuid> = document_correspondents::table
                        .filter(document_correspondents::correspondent_id.eq(*correspondent_id))
                        .select(document_correspondents::document_id)
                        .load(&mut conn)?;

                    let docs_set: HashSet<Uuid> = docs_for_correspondent.into_iter().collect();
                    doc_id_set = Some(match doc_id_set {
                        Some(existing) => existing.intersection(&docs_set).cloned().collect(),
                        None => docs_set,
                    });

                    if let Some(ref set) = doc_id_set {
                        if set.is_empty() {
                            break;
                        }
                    }
                }

                let matching_doc_ids: HashSet<Uuid> = doc_id_set.unwrap_or_default();

                if matching_doc_ids.is_empty() {
                    return Ok(Json(vec![]));
                }

                let new_filter = match &filter_ids {
                    Some(existing) => existing.intersection(&matching_doc_ids).copied().collect(),
                    None => matching_doc_ids.clone(),
                };

                filter_ids = Some(new_filter);
            }
        }
    }

    if let Some(ref set) = filter_ids {
        if set.is_empty() {
            return Ok(Json(vec![]));
        }

        let ids_vec: Vec<Uuid> = set.iter().copied().collect();
        docs_query = docs_query.filter(documents::id.eq_any(ids_vec));
    }

    let docs: Vec<Document> = if let Some(order_ids) = quickwit_order.as_ref() {
        let relevant_ids: Vec<Uuid> = if let Some(filter_set) = filter_ids.as_ref() {
            order_ids
                .iter()
                .copied()
                .filter(|id| filter_set.contains(id))
                .collect()
        } else {
            order_ids.clone()
        };

        if relevant_ids.is_empty() {
            return Ok(Json(vec![]));
        }

        let fetched: Vec<Document> = docs_query.load(&mut conn)?;
        let mut by_id: HashMap<Uuid, Document> =
            fetched.into_iter().map(|doc| (doc.id, doc)).collect();

        let mut ordered = Vec::with_capacity(by_id.len());
        for id in relevant_ids {
            if let Some(doc) = by_id.remove(&id) {
                ordered.push(doc);
            }
        }

        if !by_id.is_empty() {
            let mut remaining: Vec<Document> = by_id.into_values().collect();
            remaining.sort_by(|a, b| b.uploaded_at.cmp(&a.uploaded_at));
            ordered.extend(remaining);
        }

        ordered
    } else {
        docs_query
            .order(documents::uploaded_at.desc())
            .load(&mut conn)?
    };

    let doc_ids: Vec<Uuid> = docs.iter().map(|doc| doc.id).collect();
    let tags_map = load_tags_for_documents(&mut conn, &doc_ids)?;
    let mut correspondents_map = load_correspondents_for_documents(&mut conn, &doc_ids)?;
    drop(conn);

    let primary_versions = load_primary_assets(&state, &docs).await?;
    let mut response = Vec::with_capacity(doc_ids.len());
    for doc in docs {
        let tags = tags_map.get(&doc.id).cloned();
        let correspondents = correspondents_map.remove(&doc.id).unwrap_or_default();
        let current_version = primary_versions.get(&doc.id).cloned();
        response.push(to_document_response(
            &state,
            user.user_id,
            doc,
            tags,
            correspondents,
            current_version,
        )?);
    }

    Ok(Json(response))
}

pub async fn get_document(
    State(state): State<AppState>,
    Path(document_id): Path<Uuid>,
    user: AuthenticatedUser,
) -> AppResult<Json<DocumentDetailResponse>> {
    let mut conn = state.db()?;

    let doc: Document = documents::table.find(document_id).first(&mut conn)?;
    if doc.deleted_at.is_some() {
        return Err(AppError::not_found());
    }

    let current_version: DocumentVersion = document_versions::table
        .find(doc.current_version_id)
        .first(&mut conn)?;

    let tags_map = load_tags_for_documents(&mut conn, &[document_id])?;
    let mut correspondents_map = load_correspondents_for_documents(&mut conn, &[document_id])?;
    let version_id = current_version.id;
    drop(conn);

    let assets = load_asset_responses(&state, version_id).await?;
    let version_response = to_version_response(current_version);

    Ok(Json(DocumentDetailResponse {
        document: to_document_response(
            &state,
            user.user_id,
            doc,
            tags_map.get(&document_id).cloned(),
            correspondents_map.remove(&document_id).unwrap_or_default(),
            Some((version_response, assets)),
        )?,
    }))
}

pub async fn upload_document(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    mut multipart: Multipart,
) -> AppResult<(StatusCode, Json<DocumentDetailResponse>)> {
    let mut file_bytes: Option<Vec<u8>> = None;
    let mut original_name: Option<String> = None;
    let mut content_type: Option<String> = None;
    let mut folder_id: Option<Uuid> = None;
    let mut metadata: Value = Value::Object(Default::default());

    while let Some(field) = multipart.next_field().await.map_err(|err| {
        let msg = format!("invalid multipart data: {err}");
        error!(error = %err, "invalid multipart data");
        AppError::bad_request(msg)
    })? {
        let name = field.name().map(|n| n.to_string());
        match name.as_deref() {
            Some("file") => {
                let file_name = field.file_name().map(|n| n.to_string());
                original_name = file_name.clone();
                content_type = field.content_type().map(|mime| mime.to_string());
                let data = field.bytes().await.map_err(|err| {
                    let msg = format!("failed to read file bytes: {err}");
                    error!(error = %err, "failed to read file bytes");
                    AppError::bad_request(msg)
                })?;
                file_bytes = Some(data.to_vec());
            }
            Some("folder_id") => {
                let value = field.text().await.map_err(|err| {
                    let msg = format!("invalid folder id: {err}");
                    error!(error = %err, "invalid folder id");
                    AppError::bad_request(msg)
                })?;
                if !value.trim().is_empty() {
                    let parsed = Uuid::parse_str(value.trim())
                        .map_err(|_| AppError::bad_request("folder_id must be a valid UUID"))?;
                    folder_id = Some(parsed);
                }
            }
            Some("metadata") => {
                let value = field.text().await.map_err(|err| {
                    let msg = format!("invalid metadata: {err}");
                    error!(error = %err, "invalid metadata payload");
                    AppError::bad_request(msg)
                })?;
                metadata = serde_json::from_str(&value).map_err(|err| {
                    let msg = format!("metadata must be valid JSON: {err}");
                    error!(error = %err, "metadata parse failure");
                    AppError::bad_request(msg)
                })?;
            }
            _ => {}
        }
    }

    let file_bytes = file_bytes.ok_or_else(|| {
        error!("upload rejected: missing file field");
        AppError::bad_request("file field is required")
    })?;

    if file_bytes.is_empty() {
        error!("upload rejected: empty file payload");
        return Err(AppError::bad_request("file field must not be empty"));
    }
    let original_name = original_name.ok_or_else(|| {
        error!("upload rejected: missing original filename");
        AppError::bad_request("filename is required")
    })?;
    let original_name_for_log = original_name.clone();

    let request = UploadRequest {
        bytes: file_bytes,
        original_name,
        content_type,
        folder_id,
        metadata,
    };

    let outcome = match process_upload(&state, request, user.user_id).await {
        Ok(outcome) => {
            info!(
                document_id = %outcome.detail.document.id,
                original_name = %outcome.detail.document.original_name,
                created = outcome.created,
                reused_existing = !outcome.created,
                "document upload succeeded"
            );
            outcome
        }
        Err(err) => {
            error!(error = ?err, original_name = %original_name_for_log, "document upload failed");
            return Err(err);
        }
    };
    let status = if outcome.created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };

    Ok((status, Json(outcome.detail)))
}

pub async fn request_document_assets(
    State(state): State<AppState>,
    Path(document_id): Path<Uuid>,
    Query(query): Query<AssetRequestQuery>,
) -> AppResult<StatusCode> {
    let mut conn = state.db()?;
    let document: Document = documents::table.find(document_id).first(&mut conn)?;
    if document.deleted_at.is_some() {
        return Err(AppError::not_found());
    }

    enqueue_job(
        &mut conn,
        JOB_ANALYZE_DOCUMENT,
        json!({
            "document_id": document_id,
            "document_version_id": document.current_version_id,
            "force": query.force,
        }),
        None,
    )
    .map_err(|err| AppError::internal(format!("failed to enqueue analyze job: {err}")))?;

    Ok(StatusCode::ACCEPTED)
}

pub async fn reanalyze_all_documents(
    State(state): State<AppState>,
    _user: AuthenticatedUser,
) -> AppResult<(StatusCode, Json<BulkReanalyzeResponse>)> {
    let mut conn = state.db()?;

    let targets: Vec<(Uuid, Uuid)> = documents::table
        .filter(documents::deleted_at.is_null())
        .select((documents::id, documents::current_version_id))
        .load(&mut conn)?;

    let mut queued = 0usize;
    for (document_id, version_id) in targets {
        enqueue_job(
            &mut conn,
            JOB_ANALYZE_DOCUMENT,
            json!({
                "document_id": document_id,
                "document_version_id": version_id,
                "force": true,
            }),
            None,
        )
        .map_err(|err| AppError::internal(format!("failed to enqueue analyze job: {err}")))?;
        queued += 1;
    }

    Ok((StatusCode::ACCEPTED, Json(BulkReanalyzeResponse { queued })))
}

pub async fn reanalyze_selected_documents(
    State(state): State<AppState>,
    Json(payload): Json<BulkReanalyzeSelectionRequest>,
) -> AppResult<(StatusCode, Json<BulkReanalyzeResponse>)> {
    let BulkReanalyzeSelectionRequest {
        mut document_ids,
        force,
    } = payload;

    if document_ids.is_empty() {
        return Err(AppError::bad_request("document_ids must not be empty"));
    }

    document_ids.sort();
    document_ids.dedup();

    let mut conn = state.db()?;

    let targets: Vec<(Uuid, Uuid)> = documents::table
        .filter(documents::id.eq_any(&document_ids))
        .filter(documents::deleted_at.is_null())
        .select((documents::id, documents::current_version_id))
        .load(&mut conn)?;

    if targets.len() != document_ids.len() {
        return Err(AppError::bad_request(
            "one or more documents do not exist or are inaccessible",
        ));
    }

    let mut queued = 0usize;
    for (document_id, version_id) in targets {
        enqueue_job(
            &mut conn,
            JOB_ANALYZE_DOCUMENT,
            json!({
                "document_id": document_id,
                "document_version_id": version_id,
                "force": force,
            }),
            None,
        )
        .map_err(|err| AppError::internal(format!("failed to enqueue analyze job: {err}")))?;
        queued += 1;
    }

    Ok((StatusCode::ACCEPTED, Json(BulkReanalyzeResponse { queued })))
}

pub async fn list_document_assets(
    State(state): State<AppState>,
    Path(document_id): Path<Uuid>,
) -> AppResult<Json<Vec<DocumentAssetResponse>>> {
    let mut conn = state.db()?;
    let document: Document = documents::table.find(document_id).first(&mut conn)?;
    if document.deleted_at.is_some() {
        return Err(AppError::not_found());
    }

    let version_id = document.current_version_id;
    drop(conn);

    let assets = load_asset_responses(&state, version_id).await?;
    Ok(Json(assets))
}

pub async fn get_document_asset(
    State(state): State<AppState>,
    Path((document_id, asset_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<DocumentAssetResponse>> {
    let mut conn = state.db()?;
    let document: Document = documents::table.find(document_id).first(&mut conn)?;
    if document.deleted_at.is_some() {
        return Err(AppError::not_found());
    }

    let asset: DocumentAsset = document_assets::table.find(asset_id).first(&mut conn)?;
    let version: DocumentVersion = document_versions::table
        .find(asset.document_version_id)
        .first(&mut conn)?;

    if version.document_id != document_id {
        return Err(AppError::not_found());
    }

    let s3_key = asset.s3_key.clone();
    drop(conn);

    let presigned_url = state
        .storage
        .presign_get_object(&s3_key, Duration::from_secs(PRESIGNED_URL_EXPIRY_SECONDS))
        .await
        .map_err(|err| AppError::internal(format!("failed to generate asset URL: {err}")))?;

    Ok(Json(to_asset_response(asset, Some(presigned_url))))
}

pub async fn download_document(
    State(state): State<AppState>,
    Path(document_id): Path<Uuid>,
) -> AppResult<Json<DocumentDownloadResponse>> {
    let mut conn = state.db()?;
    let doc: Document = documents::table.find(document_id).first(&mut conn)?;
    if doc.deleted_at.is_some() {
        return Err(AppError::not_found());
    }

    let version: DocumentVersion = document_versions::table
        .find(doc.current_version_id)
        .first(&mut conn)?;

    let presigned_url = state
        .storage
        .presign_get_object(
            &version.s3_key,
            Duration::from_secs(PRESIGNED_URL_EXPIRY_SECONDS),
        )
        .await
        .map_err(|err| AppError::internal(format!("failed to generate download URL: {err}")))?;

    Ok(Json(DocumentDownloadResponse {
        url: presigned_url,
        expires_in: PRESIGNED_URL_EXPIRY_SECONDS,
        filename: doc.original_name.clone(),
        content_type: doc.content_type.clone(),
        size_bytes: version.size_bytes,
    }))
}

pub async fn download_with_token(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> AppResult<impl IntoResponse> {
    let claims = state
        .jwt
        .verify_download_token(&token)
        .map_err(|_| AppError::unauthorized())?;

    let mut conn = state.db()?;

    let doc: Document = documents::table.find(claims.doc_id).first(&mut conn)?;
    if doc.deleted_at.is_some() {
        return Err(AppError::not_found());
    }

    let version: DocumentVersion = document_versions::table
        .find(doc.current_version_id)
        .first(&mut conn)?;

    let now = Utc::now().naive_utc();
    let has_active_refresh: bool = select(exists(
        refresh_dsl::refresh_tokens
            .filter(refresh_dsl::user_id.eq(claims.user_id))
            .filter(refresh_dsl::revoked_at.is_null())
            .filter(refresh_dsl::expires_at.gt(now)),
    ))
    .get_result(&mut conn)?;

    if !has_active_refresh {
        return Err(AppError::unauthorized());
    }

    drop(conn);

    let presigned_url = state
        .storage
        .presign_get_object(
            &version.s3_key,
            Duration::from_secs(PRESIGNED_URL_EXPIRY_SECONDS),
        )
        .await
        .map_err(|err| AppError::internal(format!("failed to generate download URL: {err}")))?;

    Ok(axum::response::Redirect::temporary(&presigned_url))
}

pub async fn delete_document(
    State(state): State<AppState>,
    Path(document_id): Path<Uuid>,
) -> AppResult<impl IntoResponse> {
    let mut conn = state.db()?;
    let now = Utc::now().naive_utc();
    diesel::update(documents::table.find(document_id))
        .set((
            documents::deleted_at.eq(Some(now)),
            documents::updated_at.eq(now),
        ))
        .execute(&mut conn)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn update_document(
    State(state): State<AppState>,
    Path(document_id): Path<Uuid>,
    user: AuthenticatedUser,
    Json(payload): Json<UpdateDocumentRequest>,
) -> AppResult<Json<DocumentDetailResponse>> {
    let mut conn = state.db()?;

    let mut document: Document = documents::table.find(document_id).first(&mut conn)?;
    if document.deleted_at.is_some() {
        return Err(AppError::not_found());
    }

    let new_title = match payload.title {
        Some(ref title) => {
            let trimmed = title.trim();
            if trimmed.is_empty() {
                return Err(AppError::bad_request("title must not be empty"));
            }
            Some(trimmed.to_string())
        }
        None => None,
    };

    if new_title.is_none() {
        return Err(AppError::bad_request("no changes provided"));
    }

    if let Some(title) = new_title {
        let now = Utc::now().naive_utc();
        let new_filename = filename_with_retained_extension(&title, &document.filename);

        let update_result = diesel::update(documents::table.find(document_id)).set((
            documents::title.eq(&title),
            documents::filename.eq(&new_filename),
            documents::updated_at.eq(now),
        ));

        match update_result.execute(&mut conn) {
            Ok(_) => {}
            Err(diesel::result::Error::DatabaseError(DatabaseErrorKind::UniqueViolation, _)) => {
                return Err(AppError::bad_request(
                    "another document in this folder already uses that filename",
                ));
            }
            Err(err) => return Err(AppError::from(err)),
        }

        document = documents::table.find(document_id).first(&mut conn)?;
    }

    let current_version: DocumentVersion = document_versions::table
        .find(document.current_version_id)
        .first(&mut conn)?;

    let tags_map = load_tags_for_documents(&mut conn, &[document_id])?;
    let mut correspondents_map = load_correspondents_for_documents(&mut conn, &[document_id])?;
    let version_id = current_version.id;
    drop(conn);

    let assets = load_asset_responses(&state, version_id).await?;
    let version_response = to_version_response(current_version);

    Ok(Json(DocumentDetailResponse {
        document: to_document_response(
            &state,
            user.user_id,
            document,
            tags_map.get(&document_id).cloned(),
            correspondents_map.remove(&document_id).unwrap_or_default(),
            Some((version_response, assets)),
        )?,
    }))
}

pub async fn move_document(
    State(state): State<AppState>,
    Path(document_id): Path<Uuid>,
    Json(payload): Json<MoveDocumentRequest>,
) -> AppResult<impl IntoResponse> {
    if let Some(folder_id) = payload.folder_id {
        ensure_folder_exists(&state, folder_id)?;
    }

    let mut conn = state.db()?;
    let now = Utc::now().naive_utc();
    diesel::update(documents::table.find(document_id))
        .set((
            documents::folder_id.eq(payload.folder_id),
            documents::updated_at.eq(now),
        ))
        .execute(&mut conn)?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn bulk_move_documents(
    State(state): State<AppState>,
    Json(payload): Json<BulkMoveRequest>,
) -> AppResult<(StatusCode, Json<BulkMoveResponse>)> {
    let BulkMoveRequest {
        mut document_ids,
        folder_id,
    } = payload;

    if document_ids.is_empty() {
        return Err(AppError::bad_request("document_ids must not be empty"));
    }

    document_ids.sort();
    document_ids.dedup();

    if let Some(target_folder) = folder_id {
        ensure_folder_exists(&state, target_folder)?;
    }

    let mut conn = state.db()?;

    let existing: Vec<(Uuid, Option<NaiveDateTime>)> = documents::table
        .filter(documents::id.eq_any(&document_ids))
        .select((documents::id, documents::deleted_at))
        .load(&mut conn)?;

    if existing.len() != document_ids.len() {
        return Err(AppError::bad_request(
            "one or more documents do not exist or are inaccessible",
        ));
    }

    if existing.iter().any(|(_, deleted)| deleted.is_some()) {
        return Err(AppError::bad_request("cannot move deleted documents"));
    }

    let now = Utc::now().naive_utc();
    let updated = diesel::update(documents::table.filter(documents::id.eq_any(&document_ids)))
        .set((
            documents::folder_id.eq(folder_id),
            documents::updated_at.eq(now),
        ))
        .execute(&mut conn)?;

    Ok((StatusCode::OK, Json(BulkMoveResponse { updated })))
}

pub async fn assign_correspondents(
    State(state): State<AppState>,
    Path(document_id): Path<Uuid>,
    user: AuthenticatedUser,
    Json(payload): Json<AssignCorrespondentsRequest>,
) -> AppResult<impl IntoResponse> {
    if payload.assignments.is_empty() {
        return Err(AppError::bad_request("assignments must not be empty"));
    }

    let (normalized_pairs, correspondents_vec, roles_vec) =
        normalize_correspondent_assignments(&payload.assignments)?;
    let replace = payload.replace;
    let user_id = user.user_id;

    let mut conn = state.db()?;
    conn.transaction::<(), AppError, _>(|conn| {
        let document: Document = documents::table.find(document_id).first(conn)?;
        if document.deleted_at.is_some() {
            return Err(AppError::not_found());
        }

        if !correspondents_vec.is_empty() {
            let existing: Vec<Correspondent> = correspondents::table
                .filter(correspondents::id.eq_any(&correspondents_vec))
                .load(conn)?;
            if existing.len() != correspondents_vec.len() {
                return Err(AppError::bad_request(
                    "one or more correspondents do not exist",
                ));
            }
        }

        let mut changed = false;
        if replace {
            let deleted = diesel::delete(
                document_correspondents::table
                    .filter(document_correspondents::document_id.eq(document_id))
                    .filter(document_correspondents::role.eq_any(&roles_vec)),
            )
            .execute(conn)?;
            if deleted > 0 {
                changed = true;
            }
        }

        let new_rows: Vec<NewDocumentCorrespondent> = normalized_pairs
            .iter()
            .map(|(correspondent_id, role)| NewDocumentCorrespondent {
                document_id,
                correspondent_id: *correspondent_id,
                role: role.clone(),
                assigned_by: Some(user_id),
            })
            .collect();

        if !new_rows.is_empty() {
            let inserted = diesel::insert_into(document_correspondents::table)
                .values(&new_rows)
                .on_conflict_do_nothing()
                .execute(conn)?;
            if inserted > 0 {
                changed = true;
            }
        }

        if changed {
            diesel::update(documents::table.find(document_id))
                .set(documents::updated_at.eq(Utc::now().naive_utc()))
                .execute(conn)?;
        }

        Ok(())
    })?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn bulk_assign_correspondents(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Json(payload): Json<BulkCorrespondentsRequest>,
) -> AppResult<(StatusCode, Json<BulkCorrespondentResponse>)> {
    if payload.document_ids.is_empty() {
        return Err(AppError::bad_request("document_ids must not be empty"));
    }
    if payload.assignments.is_empty() {
        return Err(AppError::bad_request("assignments must not be empty"));
    }

    let mut document_ids = payload.document_ids;
    document_ids.sort();
    document_ids.dedup();

    let (normalized_pairs, correspondents_vec, roles_vec) =
        normalize_correspondent_assignments(&payload.assignments)?;
    let action = payload.action;
    let user_id = user.user_id;

    let mut conn = state.db()?;
    let (assigned, removed) = conn.transaction::<(usize, usize), AppError, _>(|conn| {
        let docs: Vec<(Uuid, Option<NaiveDateTime>)> = documents::table
            .filter(documents::id.eq_any(&document_ids))
            .select((documents::id, documents::deleted_at))
            .load(conn)?;

        if docs.len() != document_ids.len() {
            return Err(AppError::bad_request(
                "one or more documents do not exist or are inaccessible",
            ));
        }

        if docs.iter().any(|(_, deleted)| deleted.is_some()) {
            return Err(AppError::bad_request(
                "cannot assign correspondents to deleted documents",
            ));
        }

        if !correspondents_vec.is_empty() {
            let existing: Vec<Correspondent> = correspondents::table
                .filter(correspondents::id.eq_any(&correspondents_vec))
                .load(conn)?;
            if existing.len() != correspondents_vec.len() {
                return Err(AppError::bad_request(
                    "one or more correspondents do not exist",
                ));
            }
        }

        match action {
            BulkCorrespondentAction::Add => {
                let mut removed = 0;
                if !roles_vec.is_empty() {
                    removed = diesel::delete(
                        document_correspondents::table
                            .filter(document_correspondents::document_id.eq_any(&document_ids))
                            .filter(document_correspondents::role.eq_any(&roles_vec)),
                    )
                    .execute(conn)?;
                }

                let mut new_rows = Vec::with_capacity(document_ids.len() * normalized_pairs.len());
                for doc_id in &document_ids {
                    for (correspondent_id, role) in &normalized_pairs {
                        new_rows.push(NewDocumentCorrespondent {
                            document_id: *doc_id,
                            correspondent_id: *correspondent_id,
                            role: role.clone(),
                            assigned_by: Some(user_id),
                        });
                    }
                }

                let assigned = if new_rows.is_empty() {
                    0
                } else {
                    diesel::insert_into(document_correspondents::table)
                        .values(&new_rows)
                        .on_conflict_do_nothing()
                        .execute(conn)?
                };

                if assigned > 0 || removed > 0 {
                    diesel::update(documents::table.filter(documents::id.eq_any(&document_ids)))
                        .set(documents::updated_at.eq(Utc::now().naive_utc()))
                        .execute(conn)?;
                }

                Ok((assigned, removed))
            }
            BulkCorrespondentAction::Remove => {
                let mut removed = 0;
                if !normalized_pairs.is_empty() {
                    let mut grouped: HashMap<String, Vec<Uuid>> = HashMap::new();
                    for (correspondent_id, role) in &normalized_pairs {
                        grouped
                            .entry(role.clone())
                            .or_default()
                            .push(*correspondent_id);
                    }

                    for (role, ids) in grouped {
                        removed += diesel::delete(
                            document_correspondents::table
                                .filter(document_correspondents::document_id.eq_any(&document_ids))
                                .filter(document_correspondents::role.eq(role.as_str()))
                                .filter(document_correspondents::correspondent_id.eq_any(&ids)),
                        )
                        .execute(conn)?;
                    }
                }

                if removed > 0 {
                    diesel::update(documents::table.filter(documents::id.eq_any(&document_ids)))
                        .set(documents::updated_at.eq(Utc::now().naive_utc()))
                        .execute(conn)?;
                }

                Ok((0, removed))
            }
        }
    })?;

    Ok((
        StatusCode::OK,
        Json(BulkCorrespondentResponse { assigned, removed }),
    ))
}

pub async fn remove_correspondent(
    State(state): State<AppState>,
    Path((document_id, correspondent_id)): Path<(Uuid, Uuid)>,
    Query(query): Query<CorrespondentRoleQuery>,
) -> AppResult<impl IntoResponse> {
    let role = normalize_role(&query.role);
    if role.is_empty() {
        return Err(AppError::bad_request("role must not be empty"));
    }
    if !is_valid_correspondent_role(&role) {
        return Err(AppError::bad_request(format!(
            "invalid correspondent role '{role}'. Allowed roles: {}",
            CORRESPONDENT_ROLES.join(", ")
        )));
    }

    let mut conn = state.db()?;
    let document: Document = documents::table.find(document_id).first(&mut conn)?;
    if document.deleted_at.is_some() {
        return Err(AppError::not_found());
    }

    let deleted = diesel::delete(
        document_correspondents::table
            .filter(document_correspondents::document_id.eq(document_id))
            .filter(document_correspondents::correspondent_id.eq(correspondent_id))
            .filter(document_correspondents::role.eq(&role)),
    )
    .execute(&mut conn)?;

    if deleted == 0 {
        return Err(AppError::not_found());
    }

    diesel::update(documents::table.find(document_id))
        .set(documents::updated_at.eq(Utc::now().naive_utc()))
        .execute(&mut conn)?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn assign_tags(
    State(state): State<AppState>,
    Path(document_id): Path<Uuid>,
    user: AuthenticatedUser,
    Json(payload): Json<AssignTagsRequest>,
) -> AppResult<impl IntoResponse> {
    if payload.tag_ids.is_empty() {
        return Err(AppError::bad_request("tag_ids must not be empty"));
    }

    let mut conn = state.db()?;

    // Ensure document exists
    documents::table
        .find(document_id)
        .first::<Document>(&mut conn)?;

    // Ensure tags exist
    let existing_tags: Vec<Tag> = tags::table
        .filter(tags::id.eq_any(&payload.tag_ids))
        .load(&mut conn)?;
    if existing_tags.len() != payload.tag_ids.len() {
        return Err(AppError::bad_request("one or more tags do not exist"));
    }

    let new_tags: Vec<NewDocumentTag> = payload
        .tag_ids
        .iter()
        .map(|tag_id| NewDocumentTag {
            document_id,
            tag_id: *tag_id,
            assigned_by: Some(user.user_id),
        })
        .collect();

    diesel::insert_into(document_tags::table)
        .values(&new_tags)
        .on_conflict_do_nothing()
        .execute(&mut conn)?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn bulk_update_tags(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Json(payload): Json<BulkTagRequest>,
) -> AppResult<(StatusCode, Json<BulkTagResponse>)> {
    let BulkTagRequest {
        mut document_ids,
        mut tag_ids,
        action,
    } = payload;

    if document_ids.is_empty() {
        return Err(AppError::bad_request("document_ids must not be empty"));
    }
    if tag_ids.is_empty() {
        return Err(AppError::bad_request("tag_ids must not be empty"));
    }

    document_ids.sort();
    document_ids.dedup();
    tag_ids.sort();
    tag_ids.dedup();

    let mut conn = state.db()?;

    let docs: Vec<(Uuid, Option<NaiveDateTime>)> = documents::table
        .filter(documents::id.eq_any(&document_ids))
        .select((documents::id, documents::deleted_at))
        .load(&mut conn)?;

    if docs.len() != document_ids.len() {
        return Err(AppError::bad_request(
            "one or more documents do not exist or are inaccessible",
        ));
    }

    if docs.iter().any(|(_, deleted)| deleted.is_some()) {
        return Err(AppError::bad_request(
            "cannot assign or remove tags from deleted documents",
        ));
    }

    let existing_tags: Vec<Tag> = tags::table
        .filter(tags::id.eq_any(&tag_ids))
        .load(&mut conn)?;
    if existing_tags.len() != tag_ids.len() {
        return Err(AppError::bad_request("one or more tags do not exist"));
    }

    let response = match action {
        BulkTagAction::Add => {
            let mut inserts = Vec::with_capacity(document_ids.len() * tag_ids.len());
            for doc_id in &document_ids {
                for tag_id in &tag_ids {
                    inserts.push(NewDocumentTag {
                        document_id: *doc_id,
                        tag_id: *tag_id,
                        assigned_by: Some(user.user_id),
                    });
                }
            }

            let added = if inserts.is_empty() {
                0
            } else {
                diesel::insert_into(document_tags::table)
                    .values(&inserts)
                    .on_conflict_do_nothing()
                    .execute(&mut conn)?
            };

            BulkTagResponse { added, removed: 0 }
        }
        BulkTagAction::Remove => {
            let removed = diesel::delete(
                document_tags::table
                    .filter(document_tags::document_id.eq_any(&document_ids))
                    .filter(document_tags::tag_id.eq_any(&tag_ids)),
            )
            .execute(&mut conn)?;

            BulkTagResponse { added: 0, removed }
        }
    };

    Ok((StatusCode::OK, Json(response)))
}

pub async fn remove_tag(
    State(state): State<AppState>,
    Path((document_id, tag_id)): Path<(Uuid, Uuid)>,
) -> AppResult<impl IntoResponse> {
    let mut conn = state.db()?;
    diesel::delete(
        document_tags::table
            .filter(document_tags::document_id.eq(document_id))
            .filter(document_tags::tag_id.eq(tag_id)),
    )
    .execute(&mut conn)?;

    Ok(StatusCode::NO_CONTENT)
}

async fn process_upload(
    state: &AppState,
    request: UploadRequest,
    user_id: Uuid,
) -> AppResult<UploadOutcome> {
    let UploadRequest {
        bytes,
        original_name,
        content_type,
        folder_id,
        metadata,
    } = request;

    if let Some(folder) = folder_id {
        ensure_folder_exists(state, folder)?;
    }

    let doc_id = Uuid::new_v4();
    let version_id = Uuid::new_v4();
    let version_number = 1;
    let stored_filename = original_name.clone();

    let checksum = Sha256::digest(&bytes);
    let checksum_hex = hex::encode(checksum);
    let size_bytes = bytes.len() as i64;
    let s3_key = format!("documents/{doc_id}/v{version_number}/{version_id}");

    {
        let mut conn = state.db()?;

        let existing = documents::table
            .inner_join(
                document_versions::table
                    .on(document_versions::id.eq(documents::current_version_id)),
            )
            .filter(document_versions::checksum.eq(&checksum_hex))
            .select((documents::all_columns, document_versions::all_columns))
            .first::<(Document, DocumentVersion)>(&mut conn)
            .optional()?;

        if let Some((mut document, version)) = existing {
            if document.deleted_at.is_some() {
                let now = Utc::now().naive_utc();
                diesel::update(documents::table.find(document.id))
                    .set((
                        documents::deleted_at.eq(None::<NaiveDateTime>),
                        documents::updated_at.eq(now),
                    ))
                    .execute(&mut conn)?;
                document.deleted_at = None;
                document.updated_at = now;
            }

            let tags_map = load_tags_for_documents(&mut conn, &[document.id])?;
            let mut correspondents_map =
                load_correspondents_for_documents(&mut conn, &[document.id])?;
            let tags = tags_map.get(&document.id).cloned();
            let correspondents = correspondents_map.remove(&document.id).unwrap_or_default();
            drop(conn);
            let assets = load_asset_responses(state, version.id).await?;
            let version_response = to_version_response(version.clone());

            info!(
                document_id = %document.id,
                checksum = %checksum_hex,
                "upload deduplicated existing document"
            );

            return Ok(UploadOutcome {
                detail: DocumentDetailResponse {
                    document: to_document_response(
                        state,
                        user_id,
                        document,
                        tags,
                        correspondents,
                        Some((version_response, assets)),
                    )?,
                },
                created: false,
            });
        }
    }

    let content_disposition = inline_content_disposition(&original_name);

    state
        .storage
        .put_object(
            &s3_key,
            bytes.clone(),
            content_type.clone(),
            content_disposition.clone(),
        )
        .await
        .map_err(|err| {
            error!(error = %err, key = %s3_key, "failed to store document");
            AppError::internal(format!("failed to store document: {err}"))
        })?;

    let metadata_value = if metadata.is_null() {
        Value::Object(Default::default())
    } else {
        metadata
    };

    let (document, version) = {
        let mut conn = state.db()?;
        conn.transaction(|conn| {
            let new_document = NewDocument {
                id: doc_id,
                filename: stored_filename.clone(),
                original_name: original_name.clone(),
                content_type: content_type.clone(),
                folder_id,
                current_version_id: version_id,
                issued_at: None,
                title: derive_document_title(&original_name),
                metadata: metadata_value.clone(),
            };
            diesel::insert_into(documents::table)
                .values(&new_document)
                .execute(conn)?;

            let new_version = NewDocumentVersion {
                id: version_id,
                document_id: doc_id,
                version_number,
                s3_key: s3_key.clone(),
                size_bytes,
                checksum: checksum_hex.clone(),
                metadata: Value::Object(Default::default()),
                operations_summary: Value::Object(Default::default()),
            };

            diesel::insert_into(document_versions::table)
                .values(&new_version)
                .execute(conn)?;

            let document: Document = documents::table.find(doc_id).first(conn)?;
            let version: DocumentVersion = document_versions::table.find(version_id).first(conn)?;

            Ok::<_, diesel::result::Error>((document, version))
        })?
    };

    let detail = DocumentDetailResponse {
        document: to_document_response(
            state,
            user_id,
            document,
            None,
            Vec::new(),
            Some((to_version_response(version.clone()), Vec::new())),
        )?,
    };

    if let Ok(mut conn) = state.db() {
        if let Err(err) = enqueue_job(
            &mut conn,
            JOB_ANALYZE_DOCUMENT,
            json!({
                "document_id": doc_id,
                "document_version_id": version.id,
                "force": false,
            }),
            None,
        ) {
            warn!(document_id = %doc_id, error = %err, "failed to enqueue analyze job");
        }
    } else {
        warn!(document_id = %doc_id, "failed to enqueue analyze job due to pool error");
    }

    Ok(UploadOutcome {
        detail,
        created: true,
    })
}

fn ensure_folder_exists(state: &AppState, folder_id: Uuid) -> AppResult<()> {
    let mut conn = state.db()?;
    let exists: bool = diesel::select(exists(folders::table.filter(folders::id.eq(folder_id))))
        .get_result(&mut conn)?;
    if !exists {
        return Err(AppError::bad_request("folder does not exist"));
    }
    Ok(())
}

pub(crate) fn load_tags_for_documents(
    conn: &mut PgConnection,
    document_ids: &[Uuid],
) -> AppResult<HashMap<Uuid, Vec<Tag>>> {
    if document_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows: Vec<(Uuid, Tag)> = document_tags::table
        .inner_join(tags::table)
        .filter(document_tags::document_id.eq_any(document_ids))
        .select((document_tags::document_id, tags::all_columns))
        .load(conn)?;

    let mut map: HashMap<Uuid, Vec<Tag>> = HashMap::new();
    for (doc_id, tag) in rows {
        map.entry(doc_id).or_default().push(tag);
    }
    Ok(map)
}

pub(crate) fn load_correspondents_for_documents(
    conn: &mut PgConnection,
    document_ids: &[Uuid],
) -> AppResult<HashMap<Uuid, Vec<DocumentCorrespondentResponse>>> {
    if document_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows: Vec<(DocumentCorrespondent, Correspondent)> = document_correspondents::table
        .inner_join(correspondents::table)
        .filter(document_correspondents::document_id.eq_any(document_ids))
        .order((
            document_correspondents::document_id.asc(),
            document_correspondents::role.asc(),
            document_correspondents::assigned_at.asc(),
        ))
        .load(conn)?;

    let mut map: HashMap<Uuid, Vec<DocumentCorrespondentResponse>> = HashMap::new();
    for (assignment, correspondent) in rows {
        map.entry(assignment.document_id)
            .or_default()
            .push(DocumentCorrespondentResponse {
                id: correspondent.id,
                name: correspondent.name,
                role: assignment.role,
                metadata: correspondent.metadata,
                assigned_at: to_iso(assignment.assigned_at),
            });
    }

    Ok(map)
}

pub(crate) async fn load_primary_assets(
    state: &AppState,
    documents: &[Document],
) -> AppResult<HashMap<Uuid, (DocumentVersionResponse, Vec<DocumentAssetResponse>)>> {
    if documents.is_empty() {
        return Ok(HashMap::new());
    }

    let mut doc_to_version: HashMap<Uuid, Uuid> = HashMap::with_capacity(documents.len());
    let mut version_ids: Vec<Uuid> = Vec::with_capacity(documents.len());
    for doc in documents {
        doc_to_version.insert(doc.id, doc.current_version_id);
        version_ids.push(doc.current_version_id);
    }

    version_ids.sort();
    version_ids.dedup();

    let mut conn = state.db()?;
    let versions: Vec<DocumentVersion> = document_versions::table
        .filter(document_versions::id.eq_any(&version_ids))
        .load(&mut conn)?;

    let mut version_map: HashMap<Uuid, DocumentVersion> = HashMap::new();
    for version in versions {
        version_map.insert(version.id, version);
    }

    let assets: Vec<DocumentAsset> = document_assets::table
        .filter(document_assets::document_version_id.eq_any(&version_ids))
        .order((
            document_assets::document_version_id.asc(),
            document_assets::created_at.asc(),
        ))
        .load(&mut conn)?;

    let mut assets_by_version: HashMap<Uuid, Vec<DocumentAssetResponse>> = HashMap::new();
    for asset in assets {
        let version_id = asset.document_version_id;
        let response = to_asset_response(asset, None);
        assets_by_version
            .entry(version_id)
            .or_default()
            .push(response);
    }

    drop(conn);

    let mut result: HashMap<Uuid, (DocumentVersionResponse, Vec<DocumentAssetResponse>)> =
        HashMap::with_capacity(doc_to_version.len());
    for (doc_id, version_id) in doc_to_version {
        if let Some(version) = version_map.remove(&version_id) {
            let assets = assets_by_version.remove(&version_id).unwrap_or_default();
            result.insert(doc_id, (to_version_response(version), assets));
        }
    }

    Ok(result)
}

pub(crate) fn to_document_response(
    state: &AppState,
    user_id: Uuid,
    doc: Document,
    tags: Option<Vec<Tag>>,
    correspondents: Vec<DocumentCorrespondentResponse>,
    current_version: Option<(DocumentVersionResponse, Vec<DocumentAssetResponse>)>,
) -> AppResult<DocumentResponse> {
    let current_version = if let Some((version, assets)) = current_version {
        let download_path = build_download_path(state, doc.id, user_id)?;
        Some(DocumentCurrentVersionResponse {
            version,
            assets,
            download_path,
        })
    } else {
        None
    };

    Ok(DocumentResponse {
        id: doc.id,
        filename: doc.filename,
        title: doc.title,
        original_name: doc.original_name,
        content_type: doc.content_type,
        folder_id: doc.folder_id,
        uploaded_at: to_iso(doc.uploaded_at),
        updated_at: to_iso(doc.updated_at),
        deleted_at: doc.deleted_at.map(to_iso),
        issued_at: doc.issued_at.map(to_iso),
        metadata: doc.metadata,
        tags: tags
            .unwrap_or_default()
            .into_iter()
            .map(TagResponse::from)
            .collect(),
        correspondents,
        current_version,
    })
}

fn build_download_path(state: &AppState, document_id: Uuid, user_id: Uuid) -> AppResult<String> {
    state
        .jwt
        .generate_download_token(document_id, user_id)
        .map(|token| format!("/download/{token}"))
        .map_err(|err| AppError::internal(format!("failed to generate download token: {err}")))
}

fn to_version_response(version: DocumentVersion) -> DocumentVersionResponse {
    DocumentVersionResponse {
        id: version.id,
        version_number: version.version_number,
        s3_key: version.s3_key,
        size_bytes: version.size_bytes,
        checksum: version.checksum,
        created_at: to_iso(version.created_at),
        metadata: version.metadata,
        operations_summary: version.operations_summary,
    }
}

fn to_asset_response(asset: DocumentAsset, url: Option<String>) -> DocumentAssetResponse {
    let metadata = asset.metadata.clone();
    DocumentAssetResponse {
        id: asset.id,
        asset_type: asset.asset_type,
        mime_type: asset.mime_type,
        metadata,
        url,
        created_at: to_iso(asset.created_at),
    }
}

fn derive_document_title(original: &str) -> String {
    let trimmed = original.trim();
    if trimmed.is_empty() {
        return "Document".to_string();
    }

    let stem = FsPath::new(trimmed)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    stem.unwrap_or_else(|| trimmed.to_string())
}

fn filename_with_retained_extension(title: &str, current_filename: &str) -> String {
    let extension = FsPath::new(current_filename)
        .extension()
        .and_then(|ext| ext.to_str());

    if let Some(ext) = extension {
        if title
            .rsplit_once('.')
            .map(|(_, existing_ext)| existing_ext.eq_ignore_ascii_case(ext))
            .unwrap_or(false)
        {
            title.to_string()
        } else {
            format!("{title}.{ext}")
        }
    } else {
        title.to_string()
    }
}

async fn load_asset_responses(
    state: &AppState,
    version_id: Uuid,
) -> AppResult<Vec<DocumentAssetResponse>> {
    let mut conn = state.db()?;
    let assets: Vec<DocumentAsset> = document_assets::table
        .filter(document_assets::document_version_id.eq(version_id))
        .order(document_assets::created_at.asc())
        .load(&mut conn)?;
    drop(conn);

    Ok(assets
        .into_iter()
        .map(|asset| to_asset_response(asset, None))
        .collect())
}

pub(crate) fn to_iso(dt: NaiveDateTime) -> String {
    DateTime::<Utc>::from_naive_utc_and_offset(dt, Utc).to_rfc3339()
}

async fn quickwit_search(endpoint: &str, index: &str, query: &str) -> anyhow::Result<Vec<Uuid>> {
    let quickwit_query = match build_quickwit_query(query) {
        Some(q) => {
            debug!(%query, quickwit_query = %q, "built quickwit search query");
            q
        }
        None => {
            debug!(%query, "quickwit search skipped because query produced no tokens");
            return Ok(vec![]);
        }
    };

    let client = Client::new();
    let url = format!("{}/api/v1/{}/search", endpoint.trim_end_matches('/'), index);

    let payload = json!({
        "query": quickwit_query,
        "max_hits": QUICKWIT_MAX_HITS,
    });

    debug!(%url, payload = %payload, "sending quickwit search request");
    let response = client.post(url).json(&payload).send().await?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        error!(%status, body = %body, "quickwit search request failed");
        return Err(anyhow::anyhow!(
            "quickwit search failed with status {status}: {body}"
        ));
    }

    let data: QuickwitSearchResponse = response.json().await?;
    debug!("quickwit search response parsed successfully");
    let QuickwitSearchResponse { hits } = data;
    let mut seen = HashSet::new();
    let mut doc_ids = Vec::new();
    let total_hits = hits.len();

    for hit in hits {
        if let Some(doc_id) = extract_document_id(&hit) {
            if seen.insert(doc_id) {
                doc_ids.push(doc_id);
            }
        }
    }

    debug!(
        total_hits = total_hits,
        unique_ids = doc_ids.len(),
        "quickwit search completed"
    );
    Ok(doc_ids)
}

fn build_quickwit_query(input: &str) -> Option<String> {
    let tokens: Vec<String> = input
        .split_whitespace()
        .filter(|token| !token.is_empty())
        .map(|token| {
            let normalized = token.to_lowercase();
            escape_quickwit_token(&normalized)
        })
        .collect();

    if tokens.is_empty() {
        return None;
    }

    let parts: Vec<String> = tokens
        .into_iter()
        .map(|token| format!("(title:{token} OR text:{token})"))
        .collect();

    Some(parts.join(" AND "))
}

fn escape_quickwit_token(token: &str) -> String {
    let mut escaped = String::with_capacity(token.len());
    for ch in token.chars() {
        match ch {
            '+' | '-' | '&' | '|' | '!' | '(' | ')' | '{' | '}' | '[' | ']' | '^' | '"' | '~'
            | '*' | '?' | ':' | '\\' | '/' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            _ => escaped.push(ch),
        }
    }
    escaped
}

#[derive(Deserialize)]
struct QuickwitSearchResponse {
    #[serde(default)]
    hits: Vec<Value>,
}

fn extract_document_id(hit: &Value) -> Option<Uuid> {
    for key in ["_source", "source", "fields", "stored_fields"] {
        if let Some(value) = hit.get(key) {
            if let Some(uuid) = extract_uuid_from_value(value) {
                return Some(uuid);
            }
        }
    }

    if let Some(value) = hit.get("document_id") {
        if let Some(uuid) = extract_uuid_from_value(value) {
            return Some(uuid);
        }
    }

    None
}

fn extract_uuid_from_value(value: &Value) -> Option<Uuid> {
    if let Some(obj) = value.as_object() {
        if let Some(inner) = obj.get("document_id") {
            return parse_uuid_value(inner);
        }
    }

    if let Some(arr) = value.as_array() {
        for item in arr {
            if let Some(uuid) = extract_uuid_from_value(item) {
                return Some(uuid);
            }
        }
    }

    parse_uuid_value(value)
}

fn parse_uuid_value(value: &Value) -> Option<Uuid> {
    if let Some(s) = value.as_str() {
        return Uuid::parse_str(s).ok();
    }

    if let Some(arr) = value.as_array() {
        for item in arr {
            if let Some(uuid) = parse_uuid_value(item) {
                return Some(uuid);
            }
        }
    }

    None
}
