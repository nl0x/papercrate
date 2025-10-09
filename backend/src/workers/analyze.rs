use std::{collections::HashSet, sync::Arc, time::Duration};

use async_trait::async_trait;
use diesel::prelude::*;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tokio::task;
use tracing::{error, warn};
use uuid::Uuid;

use super::ocr::{document_is_pdf, OCR_TEXT_ASSET_TYPE};
use crate::{
    jobs::{enqueue_job, JOB_ANALYZE_DOCUMENT, JOB_GENERATE_OCR_TEXT, JOB_GENERATE_THUMBNAILS},
    models::{Document, DocumentAsset, DocumentVersion},
    schema::{document_assets, document_versions, documents},
    state::AppState,
};

use super::{JobExecution, JobHandler};

#[derive(Debug, Deserialize)]
struct AnalyzePayload {
    document_id: Uuid,
    document_version_id: Uuid,
    #[serde(default)]
    force: bool,
}

pub struct AnalyzeDocumentJob;

impl AnalyzeDocumentJob {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl JobHandler for AnalyzeDocumentJob {
    fn job_type(&self) -> &'static str {
        JOB_ANALYZE_DOCUMENT
    }

    async fn handle(&self, state: Arc<AppState>, job: crate::models::Job) -> JobExecution {
        let payload: AnalyzePayload = match serde_json::from_value(job.payload.clone()) {
            Ok(payload) => payload,
            Err(err) => {
                return JobExecution::Failed {
                    error: format!("invalid analyze payload: {err}"),
                }
            }
        };

        let state_clone = state.clone();
        match task::spawn_blocking(move || analyze_document(state_clone, payload)).await {
            Ok(Ok(execution)) => execution,
            Ok(Err(err)) => {
                warn!(job_id = %job.id, error = %err, "analyze job will retry");
                JobExecution::Retry {
                    delay: Duration::from_secs(30),
                    error: err,
                }
            }
            Err(join_err) => {
                error!(job_id = %job.id, error = %join_err, "analyze task panicked");
                JobExecution::Retry {
                    delay: Duration::from_secs(60),
                    error: format!("worker panicked: {join_err}"),
                }
            }
        }
    }
}

fn analyze_document(state: Arc<AppState>, payload: AnalyzePayload) -> Result<JobExecution, String> {
    let mut conn = state.db().map_err(|err| format!("{err:?}"))?;

    let version: DocumentVersion = document_versions::table
        .find(payload.document_version_id)
        .first(&mut conn)
        .map_err(|err| format!("{err:?}"))?;

    if version.document_id != payload.document_id {
        return Err("document/version mismatch".into());
    }

    let document: Document = documents::table
        .find(payload.document_id)
        .first(&mut conn)
        .map_err(|err| format!("{err:?}"))?;

    let (supported, reason) = determine_thumbnail_support(&document);
    let ocr_supported = document_is_pdf(&document);

    let existing_ocr: Option<DocumentAsset> = document_assets::table
        .filter(document_assets::document_version_id.eq(payload.document_version_id))
        .filter(document_assets::asset_type.eq(OCR_TEXT_ASSET_TYPE))
        .first(&mut conn)
        .optional()
        .map_err(|err| format!("{err:?}"))?;

    let skip_ocr = existing_ocr.is_some() && !payload.force;

    let mut summary_map = match version.operations_summary {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    summary_map.insert("thumbnail_supported".to_string(), Value::Bool(supported));
    if let Some(reason) = reason {
        summary_map.insert("thumbnail_reason".to_string(), Value::String(reason));
    } else {
        summary_map.remove("thumbnail_reason");
    }

    summary_map.insert("ocr_supported".to_string(), Value::Bool(ocr_supported));
    if ocr_supported {
        summary_map.remove("ocr_reason");
    } else {
        summary_map.insert(
            "ocr_reason".to_string(),
            Value::String("document is not a PDF".into()),
        );
    }

    diesel::update(document_versions::table.find(version.id))
        .set(document_versions::operations_summary.eq(Value::Object(summary_map)))
        .execute(&mut conn)
        .map_err(|err| format!("{err:?}"))?;

    if supported {
        let enqueue_result = enqueue_job(
            &mut conn,
            JOB_GENERATE_THUMBNAILS,
            json!({
                "document_id": payload.document_id,
                "document_version_id": payload.document_version_id,
                "force": payload.force,
            }),
            None,
        );

        if let Err(err) = enqueue_result {
            return Err(err.to_string());
        }
    }

    if ocr_supported && !skip_ocr {
        let enqueue_result = enqueue_job(
            &mut conn,
            JOB_GENERATE_OCR_TEXT,
            json!({
                "document_id": payload.document_id,
                "document_version_id": payload.document_version_id,
                "force": payload.force,
            }),
            None,
        );

        if let Err(err) = enqueue_result {
            return Err(err.to_string());
        }
    }

    Ok(JobExecution::Success)
}

pub(crate) fn determine_thumbnail_support(document: &Document) -> (bool, Option<String>) {
    let supported_mimes: HashSet<&'static str> = [
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/tiff",
        "image/bmp",
        "image/webp",
        "application/pdf",
    ]
    .into_iter()
    .collect();

    if let Some(ref content_type) = document.content_type {
        if supported_mimes.contains(content_type.as_str()) {
            return (true, None);
        }
    }

    if let Some(ext) = document
        .original_name
        .rsplit('.')
        .next()
        .map(|ext| ext.to_ascii_lowercase())
    {
        let supported_exts = [
            "jpg", "jpeg", "png", "gif", "tif", "tiff", "bmp", "webp", "pdf",
        ];
        if supported_exts.contains(&ext.as_str()) {
            return (true, None);
        }
    }

    (
        false,
        Some("content type not supported for thumbnails".into()),
    )
}
