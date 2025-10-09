use std::collections::{BTreeMap, HashMap};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use diesel::{dsl::count_star, prelude::*, result::DatabaseErrorKind, PgConnection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::{Correspondent, NewCorrespondent},
    schema::{correspondents, document_correspondents},
    state::AppState,
};

use super::documents::to_iso;

#[derive(Serialize)]
pub struct CorrespondentUsage {
    pub total: i64,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub by_role: BTreeMap<String, i64>,
}

#[derive(Serialize)]
pub struct CorrespondentSummary {
    pub id: Uuid,
    pub name: String,
    pub metadata: Value,
    pub created_at: String,
    pub updated_at: String,
    pub usage: CorrespondentUsage,
}

#[derive(Deserialize)]
pub struct CreateCorrespondentRequest {
    pub name: String,
    #[serde(default)]
    pub metadata: Option<Value>,
}

#[derive(Deserialize)]
pub struct UpdateCorrespondentRequest {
    pub name: Option<String>,
    pub metadata: Option<Value>,
}

#[derive(AsChangeset, Default)]
#[diesel(table_name = correspondents)]
struct CorrespondentChangeset<'a> {
    name: Option<&'a str>,
    metadata: Option<&'a Value>,
}

pub async fn list_correspondents(
    State(state): State<AppState>,
) -> AppResult<Json<Vec<CorrespondentSummary>>> {
    let mut conn = state.db()?;

    let correspondents_list: Vec<Correspondent> = correspondents::table
        .order(correspondents::name.asc())
        .load(&mut conn)?;

    let usage_rows: Vec<(Uuid, String, i64)> = document_correspondents::table
        .group_by((
            document_correspondents::correspondent_id,
            document_correspondents::role,
        ))
        .select((
            document_correspondents::correspondent_id,
            document_correspondents::role,
            count_star(),
        ))
        .load(&mut conn)?;

    let mut usage_map: HashMap<Uuid, BTreeMap<String, i64>> = HashMap::new();
    for (correspondent_id, role, count) in usage_rows {
        usage_map
            .entry(correspondent_id)
            .or_default()
            .insert(role, count);
    }

    let mut response = Vec::with_capacity(correspondents_list.len());
    for correspondent in correspondents_list {
        let role_counts = usage_map.remove(&correspondent.id).unwrap_or_default();
        response.push(build_summary(correspondent, role_counts));
    }

    Ok(Json(response))
}

pub async fn create_correspondent(
    State(state): State<AppState>,
    Json(payload): Json<CreateCorrespondentRequest>,
) -> AppResult<Json<CorrespondentSummary>> {
    let name = payload.name.trim();
    if name.is_empty() {
        return Err(AppError::bad_request("name must not be empty"));
    }

    let metadata_value = normalize_metadata(payload.metadata);
    let new_id = Uuid::new_v4();
    let new_correspondent = NewCorrespondent {
        id: new_id,
        name: name.to_string(),
        metadata: metadata_value,
    };

    let mut conn = state.db()?;
    match diesel::insert_into(correspondents::table)
        .values(&new_correspondent)
        .execute(&mut conn)
    {
        Ok(_) => {}
        Err(diesel::result::Error::DatabaseError(DatabaseErrorKind::UniqueViolation, _)) => {
            return Err(AppError::bad_request("correspondent name already exists"));
        }
        Err(err) => return Err(AppError::from(err)),
    }

    let correspondent: Correspondent = correspondents::table.find(new_id).first(&mut conn)?;
    Ok(Json(build_summary(correspondent, BTreeMap::new())))
}

pub async fn update_correspondent(
    State(state): State<AppState>,
    Path(correspondent_id): Path<Uuid>,
    Json(payload): Json<UpdateCorrespondentRequest>,
) -> AppResult<Json<CorrespondentSummary>> {
    let mut conn = state.db()?;
    let existing: Correspondent = correspondents::table
        .find(correspondent_id)
        .first(&mut conn)?;

    let mut new_name: Option<String> = None;
    if let Some(ref candidate) = payload.name {
        let trimmed = candidate.trim();
        if trimmed.is_empty() {
            return Err(AppError::bad_request("name must not be empty"));
        }
        if trimmed != existing.name {
            let duplicate = correspondents::table
                .filter(correspondents::name.eq(trimmed))
                .filter(correspondents::id.ne(correspondent_id))
                .first::<Correspondent>(&mut conn)
                .optional()?;
            if duplicate.is_some() {
                return Err(AppError::bad_request("correspondent name already exists"));
            }
            new_name = Some(trimmed.to_string());
        }
    }

    let mut new_metadata: Option<Value> = None;
    if let Some(metadata) = payload.metadata.clone() {
        let candidate = normalize_metadata(Some(metadata));
        if candidate != existing.metadata {
            new_metadata = Some(candidate);
        }
    }

    if new_name.is_none() && new_metadata.is_none() {
        let usage = load_usage_for_correspondent(&mut conn, correspondent_id)?;
        return Ok(Json(build_summary(existing.clone(), usage)));
    }

    let mut changeset = CorrespondentChangeset::default();
    if let Some(ref name) = new_name {
        changeset.name = Some(name.as_str());
    }
    if let Some(ref metadata) = new_metadata {
        changeset.metadata = Some(metadata);
    }

    let now = Utc::now().naive_utc();
    diesel::update(correspondents::table.find(correspondent_id))
        .set((&changeset, correspondents::updated_at.eq(now)))
        .execute(&mut conn)?;

    let updated: Correspondent = correspondents::table
        .find(correspondent_id)
        .first(&mut conn)?;
    let usage = load_usage_for_correspondent(&mut conn, correspondent_id)?;
    Ok(Json(build_summary(updated, usage)))
}

pub async fn delete_correspondent(
    State(state): State<AppState>,
    Path(correspondent_id): Path<Uuid>,
) -> AppResult<impl IntoResponse> {
    let mut conn = state.db()?;

    let usage: i64 = document_correspondents::table
        .filter(document_correspondents::correspondent_id.eq(correspondent_id))
        .select(count_star())
        .first(&mut conn)?;

    if usage > 0 {
        return Err(AppError::bad_request(
            "cannot delete correspondent that is still assigned to documents",
        ));
    }

    let deleted =
        diesel::delete(correspondents::table.find(correspondent_id)).execute(&mut conn)?;
    if deleted == 0 {
        return Err(AppError::not_found());
    }
    Ok(StatusCode::NO_CONTENT)
}

fn build_summary(
    correspondent: Correspondent,
    role_counts: BTreeMap<String, i64>,
) -> CorrespondentSummary {
    let total = role_counts.values().copied().sum();
    CorrespondentSummary {
        id: correspondent.id,
        name: correspondent.name,
        metadata: correspondent.metadata,
        created_at: to_iso(correspondent.created_at),
        updated_at: to_iso(correspondent.updated_at),
        usage: CorrespondentUsage {
            total,
            by_role: role_counts,
        },
    }
}

fn normalize_metadata(input: Option<Value>) -> Value {
    match input {
        None | Some(Value::Null) => Value::Object(Default::default()),
        Some(value) => value,
    }
}

fn load_usage_for_correspondent(
    conn: &mut PgConnection,
    correspondent_id: Uuid,
) -> AppResult<BTreeMap<String, i64>> {
    let rows: Vec<(String, i64)> = document_correspondents::table
        .filter(document_correspondents::correspondent_id.eq(correspondent_id))
        .group_by(document_correspondents::role)
        .select((document_correspondents::role, count_star()))
        .load(conn)?;

    let mut map = BTreeMap::new();
    for (role, count) in rows {
        map.insert(role, count);
    }
    Ok(map)
}
