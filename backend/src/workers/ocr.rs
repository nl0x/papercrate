use std::{
    fmt, fs,
    io::{ErrorKind, Write},
    process::Command,
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use chrono::Utc;
use diesel::{pg::upsert::excluded, prelude::*};
use pdfium_render::prelude::*;
use serde::Deserialize;
use serde_json::json;
use tempfile::NamedTempFile;
use tokio::task;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::{
    jobs::{enqueue_job, JOB_GENERATE_OCR_TEXT, JOB_INDEX_DOCUMENT_TEXT},
    models::{Document, DocumentAsset, DocumentVersion, NewDocumentAsset},
    schema::{document_assets, document_versions, documents},
    state::AppState,
};

use super::{JobExecution, JobHandler};

pub const OCR_TEXT_ASSET_TYPE: &str = "ocr-text";
const MIN_TEXT_LENGTH: usize = 50;

#[derive(Clone, Debug, Deserialize)]
struct OcrPayload {
    document_id: Uuid,
    document_version_id: Uuid,
    #[serde(default)]
    force: bool,
}

pub struct GenerateOcrTextJob;

impl GenerateOcrTextJob {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl JobHandler for GenerateOcrTextJob {
    fn job_type(&self) -> &'static str {
        JOB_GENERATE_OCR_TEXT
    }

    async fn handle(&self, state: Arc<AppState>, job: crate::models::Job) -> JobExecution {
        let payload: OcrPayload = match serde_json::from_value(job.payload.clone()) {
            Ok(payload) => payload,
            Err(err) => {
                return JobExecution::Failed {
                    error: format!("invalid OCR payload: {err}"),
                }
            }
        };

        let state_clone = state.clone();
        let payload_clone = payload.clone();
        let context =
            match task::spawn_blocking(move || load_ocr_context(state_clone, &payload_clone)).await
            {
                Ok(Ok(ctx)) => ctx,
                Ok(Err(err)) => {
                    warn!(job_id = %job.id, error = %err, "ocr job will retry");
                    return JobExecution::Retry {
                        delay: Duration::from_secs(30),
                        error: err,
                    };
                }
                Err(join_err) => {
                    error!(job_id = %job.id, error = %join_err, "ocr task panicked");
                    return JobExecution::Retry {
                        delay: Duration::from_secs(60),
                        error: format!("worker panicked: {join_err}"),
                    };
                }
            };

        if context.skip {
            info!(job_id = %job.id, "ocr already present; skipping");
            return JobExecution::Success;
        }

        let bytes = match state.storage.get_object(&context.version.s3_key).await {
            Ok(bytes) => bytes,
            Err(err) => {
                warn!(job_id = %job.id, error = %err, "failed to fetch document for ocr");
                return JobExecution::Retry {
                    delay: Duration::from_secs(30),
                    error: err.to_string(),
                };
            }
        };

        let doc_meta = PdfDocumentMeta {
            content_type: context.document.content_type.clone(),
            original_name: context.document.original_name.clone(),
        };

        let generation =
            match task::spawn_blocking(move || generate_ocr_text(&doc_meta, &bytes)).await {
                Ok(result) => result,
                Err(join_err) => {
                    error!(job_id = %job.id, error = %join_err, "ocr text task panicked");
                    return JobExecution::Retry {
                        delay: Duration::from_secs(60),
                        error: format!("worker panicked: {join_err}"),
                    };
                }
            };

        let Some(generation) = generation else {
            warn!(job_id = %job.id, "no text extracted from document; failing job");
            return JobExecution::Failed {
                error: "no text extracted and OCR unavailable".into(),
            };
        };

        let asset_id = context
            .existing_asset
            .as_ref()
            .map(|asset| asset.id)
            .unwrap_or_else(Uuid::new_v4);

        let s3_key = format!(
            "documents/{}/v{}/assets/{}/{}",
            context.document.id, context.version.version_number, OCR_TEXT_ASSET_TYPE, asset_id
        );

        if let Err(err) = state
            .storage
            .put_object(
                &s3_key,
                generation.text.into_bytes(),
                Some("text/plain".into()),
                None,
            )
            .await
        {
            warn!(job_id = %job.id, error = %err, "failed to upload ocr text");
            return JobExecution::Retry {
                delay: Duration::from_secs(30),
                error: err.to_string(),
            };
        }

        let state_clone = state.clone();
        match task::spawn_blocking(move || {
            persist_ocr_metadata(state_clone, &context, asset_id, &s3_key, generation.source)
        })
        .await
        {
            Ok(Ok(())) => {
                if state.config.quickwit_endpoint.is_some() && state.config.quickwit_index.is_some()
                {
                    if let Err(err) = enqueue_index_job(&state, &payload) {
                        warn!(job_id = %job.id, error = %err, "failed to enqueue index job");
                    }
                }
                JobExecution::Success
            }
            Ok(Err(err)) => {
                warn!(job_id = %job.id, error = %err, "failed to persist ocr metadata");
                JobExecution::Retry {
                    delay: Duration::from_secs(30),
                    error: err,
                }
            }
            Err(join_err) => {
                error!(job_id = %job.id, error = %join_err, "ocr metadata task panicked");
                JobExecution::Retry {
                    delay: Duration::from_secs(30),
                    error: format!("metadata update panic: {join_err}"),
                }
            }
        }
    }
}

struct PdfDocumentMeta {
    content_type: Option<String>,
    original_name: String,
}

struct OcrContext {
    document: Document,
    version: DocumentVersion,
    existing_asset: Option<DocumentAsset>,
    skip: bool,
}

struct OcrGeneration {
    text: String,
    source: &'static str,
}

fn load_ocr_context(state: Arc<AppState>, payload: &OcrPayload) -> Result<OcrContext, String> {
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

    let existing: Option<DocumentAsset> = document_assets::table
        .filter(document_assets::document_version_id.eq(payload.document_version_id))
        .filter(document_assets::asset_type.eq(OCR_TEXT_ASSET_TYPE))
        .first(&mut conn)
        .optional()
        .map_err(|err| format!("{err:?}"))?;

    let is_pdf = document_is_pdf(&document);
    if !is_pdf {
        return Ok(OcrContext {
            document,
            version,
            existing_asset: existing,
            skip: true,
        });
    }

    let skip = existing.is_some() && !payload.force;

    Ok(OcrContext {
        document,
        version,
        existing_asset: existing,
        skip,
    })
}

fn generate_ocr_text(meta: &PdfDocumentMeta, bytes: &[u8]) -> Option<OcrGeneration> {
    if !document_meta_is_pdf(meta) {
        return None;
    }

    if let Ok(text) = extract_pdf_text(bytes) {
        if text.trim().chars().count() >= MIN_TEXT_LENGTH {
            return Some(OcrGeneration {
                text,
                source: "pdf-text",
            });
        }
    }

    match run_ocr(bytes) {
        Ok(Some(text)) => Some(OcrGeneration {
            text,
            source: "ocr",
        }),
        Ok(None) => None,
        Err(OcrError::BinaryMissing) => {
            warn!("ocrmypdf not installed; cannot perform OCR");
            None
        }
        Err(err) => {
            warn!(error = ?err, "ocr command failed");
            None
        }
    }
}

fn extract_pdf_text(bytes: &[u8]) -> Result<String, String> {
    let pdfium = Pdfium::default();
    let document = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|err| format!("load pdf: {err}"))?;

    let mut combined = String::new();
    let pages = document.pages();
    for page_index in 0..pages.len() {
        let page = pages
            .get(page_index)
            .map_err(|err| format!("load page {page_index}: {err}"))?;
        if let Ok(page_text) = page.text() {
            for segment in page_text.segments().iter() {
                combined.push_str(&segment.text());
                combined.push('\n');
            }
        };
    }

    Ok(combined)
}

#[derive(Debug)]
enum OcrError {
    BinaryMissing,
    Failed(String),
}

impl fmt::Display for OcrError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OcrError::BinaryMissing => write!(f, "ocrmypdf binary not found"),
            OcrError::Failed(msg) => write!(f, "ocr failed: {msg}"),
        }
    }
}

fn run_ocr(bytes: &[u8]) -> Result<Option<String>, OcrError> {
    let mut input = NamedTempFile::new().map_err(|err| OcrError::Failed(err.to_string()))?;
    input
        .write_all(bytes)
        .map_err(|err| OcrError::Failed(err.to_string()))?;
    input
        .flush()
        .map_err(|err| OcrError::Failed(err.to_string()))?;

    let output_pdf = NamedTempFile::new().map_err(|err| OcrError::Failed(err.to_string()))?;
    let sidecar = NamedTempFile::new().map_err(|err| OcrError::Failed(err.to_string()))?;

    let status = Command::new("ocrmypdf")
        .arg("--sidecar")
        .arg(sidecar.path())
        .arg("--skip-text")
        .arg(input.path())
        .arg(output_pdf.path())
        .output();

    match status {
        Ok(output) => {
            if !output.status.success() {
                return Err(OcrError::Failed(format!(
                    "ocrmypdf failed: exit={} stderr={}",
                    output.status,
                    String::from_utf8_lossy(&output.stderr)
                )));
            }

            let text = fs::read_to_string(sidecar.path())
                .map_err(|err| OcrError::Failed(err.to_string()))?;
            if text.trim().chars().count() >= MIN_TEXT_LENGTH {
                Ok(Some(text))
            } else {
                Ok(None)
            }
        }
        Err(err) => {
            if err.kind() == ErrorKind::NotFound {
                Err(OcrError::BinaryMissing)
            } else {
                Err(OcrError::Failed(err.to_string()))
            }
        }
    }
}

fn persist_ocr_metadata(
    state: Arc<AppState>,
    context: &OcrContext,
    asset_id: Uuid,
    s3_key: &str,
    source: &'static str,
) -> Result<(), String> {
    let mut conn = state.db().map_err(|err| format!("{err:?}"))?;

    let new_asset = NewDocumentAsset {
        id: asset_id,
        document_version_id: context.version.id,
        asset_type: OCR_TEXT_ASSET_TYPE.to_string(),
        s3_key: s3_key.to_string(),
        mime_type: "text/plain".to_string(),
        metadata: json!({
            "generated_at": Utc::now().to_rfc3339(),
            "source": source,
        }),
    };

    diesel::insert_into(document_assets::table)
        .values(&new_asset)
        .on_conflict((
            document_assets::document_version_id,
            document_assets::asset_type,
        ))
        .do_update()
        .set((
            document_assets::s3_key.eq(excluded(document_assets::s3_key)),
            document_assets::mime_type.eq(excluded(document_assets::mime_type)),
            document_assets::metadata.eq(excluded(document_assets::metadata)),
        ))
        .execute(&mut conn)
        .map_err(|err| format!("{err:?}"))?;

    Ok(())
}

fn enqueue_index_job(state: &AppState, payload: &OcrPayload) -> Result<(), String> {
    let mut conn = state.db().map_err(|err| format!("{err:?}"))?;
    enqueue_job(
        &mut conn,
        JOB_INDEX_DOCUMENT_TEXT,
        json!({
            "document_id": payload.document_id,
            "document_version_id": payload.document_version_id,
        }),
        None,
    )
    .map(|_| ())
    .map_err(|err| err.to_string())
}

pub fn document_is_pdf(document: &Document) -> bool {
    document_meta_is_pdf(&PdfDocumentMeta {
        content_type: document.content_type.clone(),
        original_name: document.original_name.clone(),
    })
}

fn document_meta_is_pdf(meta: &PdfDocumentMeta) -> bool {
    if let Some(content_type) = &meta.content_type {
        if content_type.eq_ignore_ascii_case("application/pdf") {
            return true;
        }
    }

    meta.original_name
        .rsplit('.')
        .next()
        .map(|ext| ext.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
}
