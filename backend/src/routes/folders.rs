use axum::{
    extract::{Json, Path, Query, State},
    http::StatusCode,
};
use diesel::{dsl::exists, prelude::*, PgConnection};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::models::{Document, Folder, NewFolder};
use crate::schema::{documents, folders};
use crate::state::AppState;
use crate::{
    auth::AuthenticatedUser,
    error::{AppError, AppResult},
};

use super::documents::{
    load_correspondents_for_documents, load_primary_assets, load_tags_for_documents,
    to_document_response, to_iso, DocumentResponse,
};

#[derive(Deserialize)]
pub struct CreateFolderRequest {
    pub name: String,
    pub parent_id: Option<Uuid>,
}

#[derive(Deserialize)]
pub struct EnsureFolderPathRequest {
    pub parent_id: Option<Uuid>,
    pub segments: Vec<String>,
}

#[derive(Deserialize)]
pub struct UpdateFolderRequest {
    #[serde(default)]
    pub parent_id: Option<Option<Uuid>>,
    pub name: Option<String>,
}

#[derive(Serialize)]
pub struct FolderResponse {
    pub folder: FolderInfo,
}

#[derive(Serialize)]
pub struct FolderContentsResponse {
    pub folder: Option<FolderInfo>,
    pub subfolders: Vec<FolderInfo>,
    pub documents: Vec<DocumentResponse>,
}

#[derive(Deserialize)]
pub struct FolderContentsQuery {
    #[serde(default = "default_include_documents")]
    pub include_documents: bool,
}

const fn default_include_documents() -> bool {
    true
}

#[derive(Serialize)]
pub struct FolderInfo {
    pub id: Uuid,
    pub name: String,
    pub parent_id: Option<Uuid>,
    pub created_at: String,
    pub updated_at: String,
}

pub async fn ensure_folder_path(
    State(state): State<AppState>,
    Json(payload): Json<EnsureFolderPathRequest>,
) -> AppResult<Json<FolderResponse>> {
    if payload.segments.is_empty() {
        return Err(AppError::bad_request("segments must not be empty"));
    }

    let mut conn = state.db()?;

    let target_folder = conn.transaction::<Folder, AppError, _>(|conn| {
        let mut current_parent = payload.parent_id;
        let mut last_folder: Option<Folder> = None;

        for raw_name in &payload.segments {
            let name = raw_name.trim();
            if name.is_empty() {
                return Err(AppError::bad_request("folder names must not be empty"));
            }

            let existing: Option<Folder> = if let Some(parent_id) = current_parent {
                folders::table
                    .filter(folders::parent_id.eq(Some(parent_id)))
                    .filter(folders::name.eq(name))
                    .first(conn)
                    .optional()?
            } else {
                folders::table
                    .filter(folders::parent_id.is_null())
                    .filter(folders::name.eq(name))
                    .first(conn)
                    .optional()?
            };

            let folder = if let Some(folder) = existing {
                folder
            } else {
                let new_folder = NewFolder {
                    id: Uuid::new_v4(),
                    name: name.to_string(),
                    parent_id: current_parent,
                };

                diesel::insert_into(folders::table)
                    .values(&new_folder)
                    .execute(conn)?;

                folders::table.find(new_folder.id).first(conn)?
            };

            current_parent = Some(folder.id);
            last_folder = Some(folder);
        }

        last_folder.ok_or_else(|| AppError::internal("failed to resolve folder path".to_string()))
    })?;

    Ok(Json(FolderResponse {
        folder: folder_to_info(target_folder),
    }))
}

pub async fn create_folder(
    State(state): State<AppState>,
    Json(payload): Json<CreateFolderRequest>,
) -> AppResult<Json<FolderResponse>> {
    if payload.name.trim().is_empty() {
        return Err(AppError::bad_request("name must not be empty"));
    }

    let mut conn = state.db()?;

    let new_folder = NewFolder {
        id: Uuid::new_v4(),
        name: payload.name.trim().to_string(),
        parent_id: payload.parent_id,
    };

    diesel::insert_into(folders::table)
        .values(&new_folder)
        .execute(&mut conn)?;

    let folder: Folder = folders::table.find(new_folder.id).first(&mut conn)?;
    Ok(Json(FolderResponse {
        folder: folder_to_info(folder),
    }))
}

pub async fn list_folder_contents(
    State(state): State<AppState>,
    Path(folder_identifier): Path<String>,
    Query(query): Query<FolderContentsQuery>,
    user: AuthenticatedUser,
) -> AppResult<Json<FolderContentsResponse>> {
    let mut conn = state.db()?;

    let folder_id = if folder_identifier.eq_ignore_ascii_case("root") {
        None
    } else {
        Some(
            Uuid::parse_str(&folder_identifier)
                .map_err(|_| AppError::bad_request("folder identifier must be 'root' or a UUID"))?,
        )
    };

    let folder = match folder_id {
        Some(id) => Some(folder_to_info(
            folders::table.find(id).first::<Folder>(&mut conn)?,
        )),
        None => None,
    };

    let child_folders: Vec<Folder> = if let Some(parent_id) = folder_id {
        folders::table
            .filter(folders::parent_id.eq(parent_id))
            .order(folders::name.asc())
            .load(&mut conn)?
    } else {
        folders::table
            .filter(folders::parent_id.is_null())
            .order(folders::name.asc())
            .load(&mut conn)?
    };
    let subfolders = child_folders.into_iter().map(folder_to_info).collect();

    let documents = if query.include_documents {
        let docs_query = documents::table
            .filter(documents::deleted_at.is_null())
            .order(documents::uploaded_at.desc());

        let docs: Vec<Document> = if let Some(current_folder) = folder_id {
            docs_query
                .filter(documents::folder_id.eq(current_folder))
                .load(&mut conn)?
        } else {
            docs_query
                .filter(documents::folder_id.is_null())
                .load(&mut conn)?
        };

        let doc_ids: Vec<Uuid> = docs.iter().map(|doc| doc.id).collect();
        let tags_map = load_tags_for_documents(&mut conn, &doc_ids)?;
        let mut correspondents_map = load_correspondents_for_documents(&mut conn, &doc_ids)?;
        drop(conn);

        let primary_versions = load_primary_assets(&state, &docs).await?;

        let mut documents = Vec::with_capacity(doc_ids.len());
        for doc in docs {
            let tags = tags_map.get(&doc.id).cloned();
            let correspondents = correspondents_map.remove(&doc.id).unwrap_or_default();
            let current_version = primary_versions.get(&doc.id).cloned();
            documents.push(to_document_response(
                &state,
                user.user_id,
                doc,
                tags,
                correspondents,
                current_version,
            )?);
        }

        documents
    } else {
        Vec::new()
    };

    Ok(Json(FolderContentsResponse {
        folder,
        subfolders,
        documents,
    }))
}

pub async fn delete_folder(
    State(state): State<AppState>,
    Path(folder_id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let mut conn = state.db()?;

    conn.transaction::<_, AppError, _>(|conn| {
        folders::table.find(folder_id).first::<Folder>(conn)?;

        let has_child_folders: bool = diesel::select(exists(
            folders::table.filter(folders::parent_id.eq(Some(folder_id))),
        ))
        .get_result(conn)?;

        if has_child_folders {
            return Err(AppError::bad_request(
                "folder must be empty before deletion",
            ));
        }

        let has_documents: bool = diesel::select(exists(
            documents::table
                .filter(documents::folder_id.eq(Some(folder_id)))
                .filter(documents::deleted_at.is_null()),
        ))
        .get_result(conn)?;

        if has_documents {
            return Err(AppError::bad_request(
                "folder must be empty before deletion",
            ));
        }

        diesel::delete(folders::table.find(folder_id)).execute(conn)?;

        Ok(())
    })?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn update_folder(
    State(state): State<AppState>,
    Path(folder_id): Path<Uuid>,
    Json(payload): Json<UpdateFolderRequest>,
) -> AppResult<StatusCode> {
    let mut conn = state.db()?;

    conn.transaction::<(), AppError, _>(|conn| {
        let folder: Folder = folders::table.find(folder_id).first(conn)?;

        let mut next_parent = folder.parent_id;
        let mut parent_changed = false;

        if let Some(parent_request) = payload.parent_id {
            if parent_request == Some(folder_id) {
                return Err(AppError::bad_request("folder cannot be its own parent"));
            }

            if let Some(parent_id) = parent_request {
                let _parent: Folder = folders::table.find(parent_id).first(conn)?;

                let descendant_ids = gather_descendant_folder_ids(conn, folder_id)?;
                if descendant_ids.contains(&parent_id) {
                    return Err(AppError::bad_request(
                        "cannot move folder into itself or a descendant",
                    ));
                }
            }

            parent_changed = parent_request != folder.parent_id;
            next_parent = parent_request;
        }

        let mut new_name = folder.name.clone();
        let mut name_changed = false;

        if let Some(name) = payload.name {
            let trimmed = name.trim();
            if trimmed.is_empty() {
                return Err(AppError::bad_request("name must not be empty"));
            }

            if trimmed != folder.name {
                new_name = trimmed.to_string();
                name_changed = true;
            }
        }

        if !parent_changed && !name_changed {
            return Ok(());
        }

        let conflict = if let Some(parent_id) = next_parent {
            folders::table
                .filter(folders::parent_id.eq(Some(parent_id)))
                .filter(folders::name.eq(&new_name))
                .filter(folders::id.ne(folder_id))
                .first::<Folder>(conn)
                .optional()?
        } else {
            folders::table
                .filter(folders::parent_id.is_null())
                .filter(folders::name.eq(&new_name))
                .filter(folders::id.ne(folder_id))
                .first::<Folder>(conn)
                .optional()?
        };

        if conflict.is_some() {
            return Err(AppError::bad_request(
                "a folder with the same name already exists in the target",
            ));
        }

        diesel::update(folders::table.find(folder_id))
            .set((
                folders::parent_id.eq(next_parent),
                folders::name.eq(&new_name),
            ))
            .execute(conn)?;

        Ok(())
    })?;

    Ok(StatusCode::NO_CONTENT)
}

fn folder_to_info(folder: Folder) -> FolderInfo {
    FolderInfo {
        id: folder.id,
        name: folder.name,
        parent_id: folder.parent_id,
        created_at: to_iso(folder.created_at),
        updated_at: to_iso(folder.updated_at),
    }
}

pub(super) fn gather_descendant_folder_ids(
    conn: &mut PgConnection,
    folder_id: Uuid,
) -> AppResult<Vec<Uuid>> {
    let mut ids = vec![folder_id];
    let mut queue = vec![folder_id];

    while let Some(current) = queue.pop() {
        let child_ids: Vec<Uuid> = folders::table
            .filter(folders::parent_id.eq(Some(current)))
            .select(folders::id)
            .load(conn)?;
        queue.extend(child_ids.iter().copied());
        ids.extend(child_ids);
    }

    Ok(ids)
}
