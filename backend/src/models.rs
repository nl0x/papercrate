use chrono::NaiveDateTime;
use diesel::prelude::*;
use uuid::Uuid;

use crate::schema::*;

#[derive(Debug, Clone, Queryable, Identifiable)]
#[diesel(table_name = users)]
pub struct User {
    pub id: Uuid,
    pub username: String,
    pub password_hash: String,
    pub role: String,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

#[derive(Debug, Insertable)]
#[diesel(table_name = users)]
pub struct NewUser {
    pub id: Uuid,
    pub username: String,
    pub password_hash: String,
    pub role: String,
}

#[derive(Debug, Clone, Queryable, Identifiable)]
#[diesel(table_name = folders)]
pub struct Folder {
    pub id: Uuid,
    pub name: String,
    pub parent_id: Option<Uuid>,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

#[derive(Debug, Insertable)]
#[diesel(table_name = folders)]
pub struct NewFolder {
    pub id: Uuid,
    pub name: String,
    pub parent_id: Option<Uuid>,
}

#[derive(Debug, Clone, Queryable, Identifiable, Associations)]
#[diesel(table_name = documents)]
#[diesel(belongs_to(Folder, foreign_key = folder_id))]
pub struct Document {
    pub id: Uuid,
    pub filename: String,
    pub original_name: String,
    pub content_type: Option<String>,
    pub folder_id: Option<Uuid>,
    pub uploaded_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
    pub deleted_at: Option<NaiveDateTime>,
    pub metadata: serde_json::Value,
    pub issued_at: Option<NaiveDateTime>,
    pub title: String,
    pub current_version_id: Uuid,
}

#[derive(Debug, Insertable)]
#[diesel(table_name = documents)]
pub struct NewDocument {
    pub id: Uuid,
    pub filename: String,
    pub original_name: String,
    pub content_type: Option<String>,
    pub folder_id: Option<Uuid>,
    pub current_version_id: Uuid,
    pub metadata: serde_json::Value,
    pub issued_at: Option<NaiveDateTime>,
    pub title: String,
}

#[derive(Debug, Clone, Queryable, Identifiable, Associations)]
#[diesel(table_name = document_versions)]
#[diesel(belongs_to(Document))]
pub struct DocumentVersion {
    pub id: Uuid,
    pub document_id: Uuid,
    pub version_number: i32,
    pub s3_key: String,
    pub size_bytes: i64,
    pub checksum: String,
    pub created_at: NaiveDateTime,
    pub operations_summary: serde_json::Value,
    pub metadata: serde_json::Value,
}

#[derive(Debug, Insertable)]
#[diesel(table_name = document_versions)]
pub struct NewDocumentVersion {
    pub id: Uuid,
    pub document_id: Uuid,
    pub version_number: i32,
    pub s3_key: String,
    pub size_bytes: i64,
    pub checksum: String,
    pub operations_summary: serde_json::Value,
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, Queryable, Identifiable, Associations)]
#[diesel(table_name = document_assets)]
#[diesel(belongs_to(DocumentVersion, foreign_key = document_version_id))]
pub struct DocumentAsset {
    pub id: Uuid,
    pub document_version_id: Uuid,
    pub asset_type: String,
    pub s3_key: String,
    pub mime_type: String,
    pub metadata: serde_json::Value,
    pub created_at: NaiveDateTime,
}

#[derive(Debug, Insertable)]
#[diesel(table_name = document_assets)]
pub struct NewDocumentAsset {
    pub id: Uuid,
    pub document_version_id: Uuid,
    pub asset_type: String,
    pub s3_key: String,
    pub mime_type: String,
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, Queryable, Identifiable)]
#[diesel(table_name = jobs)]
pub struct Job {
    pub id: Uuid,
    pub job_type: String,
    pub payload: serde_json::Value,
    pub status: String,
    pub attempts: i32,
    pub run_after: NaiveDateTime,
    pub last_error: Option<String>,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

#[derive(Debug, Insertable)]
#[diesel(table_name = jobs)]
pub struct NewJob {
    pub id: Uuid,
    pub job_type: String,
    pub payload: serde_json::Value,
    pub status: String,
    pub run_after: NaiveDateTime,
}

#[derive(Debug, Clone, Queryable, Identifiable)]
#[diesel(table_name = tags)]
pub struct Tag {
    pub id: Uuid,
    pub label: String,
    pub color: Option<String>,
    pub created_at: NaiveDateTime,
}

#[derive(Debug, Insertable)]
#[diesel(table_name = tags)]
pub struct NewTag {
    pub id: Uuid,
    pub label: String,
    pub color: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Queryable, Associations)]
#[diesel(table_name = document_tags)]
#[diesel(belongs_to(Document))]
#[diesel(belongs_to(Tag))]
#[diesel(primary_key(document_id, tag_id))]
pub struct DocumentTag {
    pub document_id: Uuid,
    pub tag_id: Uuid,
    pub assigned_at: NaiveDateTime,
    pub assigned_by: Option<Uuid>,
}

#[derive(Debug, Insertable)]
#[diesel(table_name = document_tags)]
pub struct NewDocumentTag {
    pub document_id: Uuid,
    pub tag_id: Uuid,
    pub assigned_by: Option<Uuid>,
}

#[derive(Debug, Clone, Queryable, Identifiable)]
#[diesel(table_name = correspondents)]
pub struct Correspondent {
    pub id: Uuid,
    pub name: String,
    pub metadata: serde_json::Value,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

#[derive(Debug, Insertable)]
#[diesel(table_name = correspondents)]
pub struct NewCorrespondent {
    pub id: Uuid,
    pub name: String,
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, Queryable, Associations)]
#[diesel(table_name = document_correspondents)]
#[diesel(belongs_to(Document))]
#[diesel(belongs_to(Correspondent))]
#[diesel(primary_key(document_id, correspondent_id, role))]
pub struct DocumentCorrespondent {
    pub document_id: Uuid,
    pub correspondent_id: Uuid,
    pub role: String,
    pub assigned_at: NaiveDateTime,
    pub assigned_by: Option<Uuid>,
}

#[derive(Debug, Insertable)]
#[diesel(table_name = document_correspondents)]
pub struct NewDocumentCorrespondent {
    pub document_id: Uuid,
    pub correspondent_id: Uuid,
    pub role: String,
    pub assigned_by: Option<Uuid>,
}

#[derive(Debug, Clone, Queryable, Identifiable, Associations)]
#[diesel(table_name = refresh_tokens)]
#[diesel(belongs_to(User))]
pub struct RefreshToken {
    pub id: Uuid,
    pub user_id: Uuid,
    pub token_hash: String,
    pub issued_at: NaiveDateTime,
    pub expires_at: NaiveDateTime,
    pub revoked_at: Option<NaiveDateTime>,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

#[derive(Debug, Insertable)]
#[diesel(table_name = refresh_tokens)]
pub struct NewRefreshToken {
    pub id: Uuid,
    pub user_id: Uuid,
    pub token_hash: String,
    pub issued_at: NaiveDateTime,
    pub expires_at: NaiveDateTime,
}
