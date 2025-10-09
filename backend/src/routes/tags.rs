use crate::utils::json::{classify_nullable, NullableValue};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use diesel::{dsl::count_star, prelude::*};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::{NewTag, Tag};
use crate::schema::{document_tags, tags};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct CreateTagRequest {
    pub label: String,
    pub color: Option<String>,
}

#[derive(AsChangeset, Default)]
#[diesel(table_name = tags)]
struct UpdateTagChangeset<'a> {
    label: Option<&'a str>,
    color: Option<Option<&'a str>>,
}

#[derive(Serialize)]
pub struct TagCatalogEntry {
    pub id: Uuid,
    pub label: String,
    pub color: Option<String>,
    pub usage_count: i64,
}

pub async fn list_tags(State(state): State<AppState>) -> AppResult<Json<Vec<TagCatalogEntry>>> {
    let mut conn = state.db()?;

    let tag_list: Vec<Tag> = tags::table.order(tags::label.asc()).load(&mut conn)?;

    let usage_rows: Vec<(Uuid, i64)> = document_tags::table
        .group_by(document_tags::tag_id)
        .select((document_tags::tag_id, count_star()))
        .load(&mut conn)?;

    let usage_map: HashMap<Uuid, i64> = usage_rows.into_iter().collect();

    let response = tag_list
        .into_iter()
        .map(|tag| TagCatalogEntry {
            id: tag.id,
            label: tag.label,
            color: tag.color,
            usage_count: *usage_map.get(&tag.id).unwrap_or(&0),
        })
        .collect();

    Ok(Json(response))
}

pub async fn create_tag(
    State(state): State<AppState>,
    Json(payload): Json<CreateTagRequest>,
) -> AppResult<Json<TagCatalogEntry>> {
    if payload.label.trim().is_empty() {
        return Err(AppError::bad_request("label must not be empty"));
    }

    let mut conn = state.db()?;
    let new_tag = NewTag {
        id: Uuid::new_v4(),
        label: payload.label.trim().to_string(),
        color: payload.color,
    };

    match diesel::insert_into(tags::table)
        .values(&new_tag)
        .execute(&mut conn)
    {
        Ok(_) => {}
        Err(diesel::result::Error::DatabaseError(
            diesel::result::DatabaseErrorKind::UniqueViolation,
            _,
        )) => {
            return Err(AppError::bad_request("tag label already exists"));
        }
        Err(err) => return Err(AppError::from(err)),
    }

    let tag: Tag = tags::table.find(new_tag.id).first(&mut conn)?;
    Ok(Json(TagCatalogEntry {
        id: tag.id,
        label: tag.label,
        color: tag.color,
        usage_count: 0,
    }))
}

pub async fn update_tag(
    State(state): State<AppState>,
    Path(tag_id): Path<Uuid>,
    Json(body): Json<Value>,
) -> AppResult<Json<TagCatalogEntry>> {
    let mut conn = state.db()?;
    let existing: Tag = tags::table.find(tag_id).first(&mut conn)?;
    let label_class = classify_nullable(body.get("label")).map_err(AppError::bad_request)?;
    let color_class = classify_nullable(body.get("color")).map_err(AppError::bad_request)?;

    if matches!(label_class, NullableValue::Omitted)
        && matches!(color_class, NullableValue::Omitted)
    {
        let usage_count: i64 = document_tags::table
            .filter(document_tags::tag_id.eq(tag_id))
            .select(count_star())
            .first(&mut conn)?;
        return Ok(Json(TagCatalogEntry {
            id: existing.id,
            label: existing.label.clone(),
            color: existing.color.clone(),
            usage_count,
        }));
    }

    let mut new_label: Option<String> = None;
    let mut label_changed = false;
    match label_class {
        NullableValue::Omitted => {}
        NullableValue::Null => {
            return Err(AppError::bad_request("label cannot be null"));
        }
        NullableValue::String(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Err(AppError::bad_request("label must not be empty"));
            }
            if trimmed != existing.label {
                let duplicate = tags::table
                    .filter(tags::label.eq(trimmed))
                    .filter(tags::id.ne(tag_id))
                    .first::<Tag>(&mut conn)
                    .optional()?;
                if duplicate.is_some() {
                    return Err(AppError::bad_request("tag label already exists"));
                }
                new_label = Some(trimmed.to_string());
                label_changed = true;
            }
        }
    }

    let mut color_change: Option<Option<String>> = None;
    let mut color_changed = false;
    match color_class {
        NullableValue::Omitted => {}
        NullableValue::Null => {
            color_change = Some(None);
            color_changed = true;
        }
        NullableValue::String(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Err(AppError::bad_request("color must not be empty"));
            }
            if existing.color.as_deref() != Some(trimmed) {
                color_change = Some(Some(trimmed.to_string()));
                color_changed = true;
            }
        }
    }

    if !label_changed && !color_changed {
        let usage_count: i64 = document_tags::table
            .filter(document_tags::tag_id.eq(tag_id))
            .select(count_star())
            .first(&mut conn)?;
        return Ok(Json(TagCatalogEntry {
            id: existing.id,
            label: existing.label.clone(),
            color: existing.color.clone(),
            usage_count,
        }));
    }

    let changeset = UpdateTagChangeset {
        label: new_label.as_deref(),
        color: color_change
            .as_ref()
            .map(|opt| opt.as_ref().map(|value| value.as_str())),
    };

    diesel::update(tags::table.find(tag_id))
        .set(&changeset)
        .execute(&mut conn)?;

    let updated: Tag = tags::table.find(tag_id).first(&mut conn)?;
    let usage_count: i64 = document_tags::table
        .filter(document_tags::tag_id.eq(tag_id))
        .select(count_star())
        .first(&mut conn)?;

    Ok(Json(TagCatalogEntry {
        id: updated.id,
        label: updated.label,
        color: updated.color,
        usage_count,
    }))
}

pub async fn delete_tag(
    State(state): State<AppState>,
    Path(tag_id): Path<Uuid>,
) -> AppResult<impl axum::response::IntoResponse> {
    let mut conn = state.db()?;

    let usage: i64 = document_tags::table
        .filter(document_tags::tag_id.eq(tag_id))
        .select(count_star())
        .first(&mut conn)?;

    if usage > 0 {
        return Err(AppError::bad_request(
            "cannot delete tag that is still assigned to documents",
        ));
    }

    let deleted = diesel::delete(tags::table.find(tag_id)).execute(&mut conn)?;
    if deleted == 0 {
        return Err(AppError::not_found());
    }

    Ok(StatusCode::NO_CONTENT)
}
