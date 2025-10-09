use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use diesel::prelude::*;
use reqwest::Client;
use serde::Deserialize;
use serde_json::json;
use tokio::task;
use tracing::{error, warn};
use uuid::Uuid;

use crate::{
    jobs::JOB_INDEX_DOCUMENT_TEXT,
    models::{Document, DocumentAsset, DocumentVersion},
    schema::{document_assets, document_versions, documents},
    state::AppState,
};

use super::{ocr::OCR_TEXT_ASSET_TYPE, JobExecution, JobHandler};

#[derive(Debug, Deserialize)]
struct IndexPayload {
    document_id: Uuid,
    document_version_id: Uuid,
}

pub struct IndexDocumentTextJob;

impl IndexDocumentTextJob {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl JobHandler for IndexDocumentTextJob {
    fn job_type(&self) -> &'static str {
        JOB_INDEX_DOCUMENT_TEXT
    }

    async fn handle(&self, state: Arc<AppState>, job: crate::models::Job) -> JobExecution {
        let payload: IndexPayload = match serde_json::from_value(job.payload.clone()) {
            Ok(payload) => payload,
            Err(err) => {
                return JobExecution::Failed {
                    error: format!("invalid index payload: {err}"),
                }
            }
        };

        let quickwit_endpoint = match &state.config.quickwit_endpoint {
            Some(endpoint) => endpoint.clone(),
            None => {
                warn!("quickwit endpoint missing; skipping indexing");
                return JobExecution::Success;
            }
        };

        let quickwit_index = match &state.config.quickwit_index {
            Some(index) => index.clone(),
            None => {
                warn!("quickwit index missing; skipping indexing");
                return JobExecution::Success;
            }
        };

        let client = Client::new();

        let state_clone = state.clone();
        let context = match task::spawn_blocking(move || load_context(state_clone, &payload)).await
        {
            Ok(Ok(ctx)) => ctx,
            Ok(Err(err)) => {
                warn!(job_id = %job.id, error = %err, "index job will retry");
                return JobExecution::Retry {
                    delay: Duration::from_secs(30),
                    error: err,
                };
            }
            Err(join_err) => {
                error!(job_id = %job.id, error = %join_err, "index task panicked");
                return JobExecution::Retry {
                    delay: Duration::from_secs(60),
                    error: format!("worker panicked: {join_err}"),
                };
            }
        };

        if context.text_asset.is_none() {
            warn!(job_id = %job.id, "missing OCR text asset; failing indexing job");
            return JobExecution::Failed {
                error: "missing OCR text asset".into(),
            };
        }

        let asset = context.text_asset.unwrap();
        let text = match state.storage.get_object(&asset.s3_key).await {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(text) => text,
                Err(err) => {
                    warn!(job_id = %job.id, error = %err, "ocr text not valid UTF-8");
                    return JobExecution::Failed {
                        error: "ocr text not valid UTF-8".into(),
                    };
                }
            },
            Err(err) => {
                warn!(job_id = %job.id, error = %err, "failed to download ocr text");
                return JobExecution::Retry {
                    delay: Duration::from_secs(30),
                    error: err.to_string(),
                };
            }
        };

        if text.trim().is_empty() {
            warn!(job_id = %job.id, "ocr text empty; skipping");
            return JobExecution::Failed {
                error: "ocr text empty".into(),
            };
        }

        let client = client;
        let url = format!(
            "{}/api/v1/{}/ingest?commit=auto",
            quickwit_endpoint, quickwit_index
        );
        let payload = json!({
            "document_id": context.document.id,
            "version_id": context.version.id,
            "title": context.document.title.to_lowercase(),
            "text": text.to_lowercase()
        });

        let body = serde_json::to_string(&payload).unwrap();

        match client
            .post(&url)
            .header("content-type", "application/x-ndjson")
            .body(format!("{}\n", body))
            .send()
            .await
        {
            Ok(response) => {
                if response.status().is_success() {
                    JobExecution::Success
                } else {
                    let status = response.status();
                    let body = response.text().await.unwrap_or_default();
                    warn!(job_id = %job.id, %status, %body, "quickwit ingest failed");
                    JobExecution::Retry {
                        delay: Duration::from_secs(30),
                        error: format!("quickwit ingest failed with status {status}"),
                    }
                }
            }
            Err(err) => {
                warn!(job_id = %job.id, error = %err, "quickwit request failed");
                JobExecution::Retry {
                    delay: Duration::from_secs(30),
                    error: err.to_string(),
                }
            }
        }
    }
}

struct IndexContext {
    document: Document,
    version: DocumentVersion,
    text_asset: Option<DocumentAsset>,
}

fn load_context(state: Arc<AppState>, payload: &IndexPayload) -> Result<IndexContext, String> {
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

    let text_asset: Option<DocumentAsset> = document_assets::table
        .filter(document_assets::document_version_id.eq(payload.document_version_id))
        .filter(document_assets::asset_type.eq(OCR_TEXT_ASSET_TYPE))
        .first(&mut conn)
        .optional()
        .map_err(|err| format!("{err:?}"))?;

    Ok(IndexContext {
        document,
        version,
        text_asset,
    })
}
