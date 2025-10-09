use std::{convert::TryInto, io::Cursor, panic, sync::Arc, time::Duration};

use async_trait::async_trait;
use chrono::Utc;
use diesel::{pg::upsert::excluded, prelude::*};
use image::{GenericImageView, ImageFormat, ImageReader};
use pdfium_render::prelude::*;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tokio::task;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::{
    jobs::JOB_GENERATE_THUMBNAILS,
    models::{Document, DocumentAsset, DocumentVersion, NewDocumentAsset},
    schema::{document_assets, document_versions, documents},
    state::AppState,
};

use super::{analyze::determine_thumbnail_support, JobExecution, JobHandler};

const THUMBNAIL_WIDTH: u32 = 512;
const THUMBNAIL_HEIGHT: u32 = 512;
const PREVIEW_WIDTH: u32 = THUMBNAIL_WIDTH * 4;
const PREVIEW_HEIGHT: u32 = THUMBNAIL_HEIGHT * 4;
const THUMBNAIL_ASSET_TYPE: &str = "thumbnail";
const PREVIEW_ASSET_TYPE: &str = "preview";

#[derive(Debug, Deserialize)]
struct ThumbnailPayload {
    document_id: Uuid,
    document_version_id: Uuid,
    #[serde(default)]
    force: bool,
}

pub struct GenerateThumbnailsJob;

impl GenerateThumbnailsJob {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl JobHandler for GenerateThumbnailsJob {
    fn job_type(&self) -> &'static str {
        JOB_GENERATE_THUMBNAILS
    }

    async fn handle(&self, state: Arc<AppState>, job: crate::models::Job) -> JobExecution {
        let payload: ThumbnailPayload = match serde_json::from_value(job.payload.clone()) {
            Ok(p) => p,
            Err(err) => {
                return JobExecution::Failed {
                    error: format!("invalid thumbnail payload: {err}"),
                }
            }
        };

        let state_clone = state.clone();
        let initial =
            match task::spawn_blocking(move || load_thumbnail_context(state_clone, &payload)).await
            {
                Ok(Ok(ctx)) => ctx,
                Ok(Err(err)) => {
                    warn!(job_id = %job.id, error = %err, "thumbnail job will retry");
                    return JobExecution::Retry {
                        delay: Duration::from_secs(30),
                        error: err,
                    };
                }
                Err(join_err) => {
                    error!(job_id = %job.id, error = %join_err, "thumbnail task panicked");
                    return JobExecution::Retry {
                        delay: Duration::from_secs(60),
                        error: format!("worker panicked: {join_err}"),
                    };
                }
            };

        if initial.skip {
            info!(job_id = %job.id, "thumbnails already exist; skipping");
            return JobExecution::Success;
        }

        let bytes = match state.storage.get_object(&initial.version.s3_key).await {
            Ok(bytes) => bytes,
            Err(err) => {
                warn!(job_id = %job.id, error = %err, "thumbnail fetch failed; will retry");
                return JobExecution::Retry {
                    delay: Duration::from_secs(30),
                    error: err.to_string(),
                };
            }
        };

        let generation = match generate_preview_and_thumbnail(&initial.document, &bytes) {
            Ok(result) => result,
            Err(err) => {
                return JobExecution::Failed { error: err };
            }
        };

        if let Some(page_count) = generation.page_count {
            let state_clone = state.clone();
            let document_id = initial.document.id;
            let version_id = initial.version.id;
            match task::spawn_blocking(move || {
                persist_document_page_count(state_clone, document_id, version_id, page_count)
            })
            .await
            {
                Ok(Ok(())) => {}
                Ok(Err(err)) => {
                    warn!(
                        job_id = %job.id,
                        document_id = %document_id,
                        version_id = %version_id,
                        error = %err,
                        "failed to update document page count metadata; retrying"
                    );
                    return JobExecution::Retry {
                        delay: Duration::from_secs(30),
                        error: err,
                    };
                }
                Err(join_err) => {
                    error!(
                        job_id = %job.id,
                        document_id = %document_id,
                        version_id = %version_id,
                        error = %join_err,
                        "page count metadata task panicked"
                    );
                    return JobExecution::Retry {
                        delay: Duration::from_secs(60),
                        error: format!("metadata panic: {join_err}"),
                    };
                }
            }
        }

        let thumbnail_asset_id = initial
            .existing_thumbnail
            .as_ref()
            .map(|asset| asset.id)
            .unwrap_or_else(Uuid::new_v4);
        let thumbnail_s3_key = format!(
            "documents/{}/v{}/assets/{}/{}",
            initial.document.id,
            initial.version.version_number,
            THUMBNAIL_ASSET_TYPE,
            thumbnail_asset_id
        );

        let preview_asset_id = initial
            .existing_preview
            .as_ref()
            .map(|asset| asset.id)
            .unwrap_or_else(Uuid::new_v4);
        let preview_s3_key = format!(
            "documents/{}/v{}/assets/{}/{}",
            initial.document.id,
            initial.version.version_number,
            PREVIEW_ASSET_TYPE,
            preview_asset_id
        );

        if let Err(err) = state
            .storage
            .put_object(
                &preview_s3_key,
                generation.preview.image_bytes.clone(),
                Some("image/png".into()),
                None,
            )
            .await
        {
            warn!(job_id = %job.id, error = %err, "failed to upload preview; retrying");
            return JobExecution::Retry {
                delay: Duration::from_secs(30),
                error: err.to_string(),
            };
        }

        if let Err(err) = state
            .storage
            .put_object(
                &thumbnail_s3_key,
                generation.thumbnail.image_bytes.clone(),
                Some("image/png".into()),
                None,
            )
            .await
        {
            warn!(job_id = %job.id, error = %err, "failed to upload thumbnail; retrying");
            return JobExecution::Retry {
                delay: Duration::from_secs(30),
                error: err.to_string(),
            };
        }

        let state_clone = state.clone();
        match task::spawn_blocking(move || {
            persist_assets_metadata(
                state_clone,
                &initial,
                &[
                    AssetPersistence {
                        asset_type: PREVIEW_ASSET_TYPE,
                        asset_id: preview_asset_id,
                        s3_key: &preview_s3_key,
                        generated: &generation.preview,
                    },
                    AssetPersistence {
                        asset_type: THUMBNAIL_ASSET_TYPE,
                        asset_id: thumbnail_asset_id,
                        s3_key: &thumbnail_s3_key,
                        generated: &generation.thumbnail,
                    },
                ],
            )
        })
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                warn!(job_id = %job.id, error = %err, "failed to persist thumbnail metadata; retrying");
                return JobExecution::Retry {
                    delay: Duration::from_secs(30),
                    error: err,
                };
            }
            Err(join_err) => {
                error!(job_id = %job.id, error = %join_err, "thumbnail metadata update panicked");
                return JobExecution::Retry {
                    delay: Duration::from_secs(30),
                    error: format!("metadata update panic: {join_err}"),
                };
            }
        }

        JobExecution::Success
    }
}

struct ThumbnailContext {
    document: Document,
    version: DocumentVersion,
    existing_thumbnail: Option<DocumentAsset>,
    existing_preview: Option<DocumentAsset>,
    skip: bool,
}

struct GeneratedImage {
    image_bytes: Vec<u8>,
    width: Option<i32>,
    height: Option<i32>,
}

struct GeneratedAssets {
    thumbnail: GeneratedImage,
    preview: GeneratedImage,
    page_count: Option<u32>,
}

struct AssetPersistence<'a> {
    asset_type: &'static str,
    asset_id: Uuid,
    s3_key: &'a str,
    generated: &'a GeneratedImage,
}

fn load_thumbnail_context(
    state: Arc<AppState>,
    payload: &ThumbnailPayload,
) -> Result<ThumbnailContext, String> {
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

    let existing_assets: Vec<DocumentAsset> = document_assets::table
        .filter(document_assets::document_version_id.eq(payload.document_version_id))
        .filter(document_assets::asset_type.eq_any(vec![
            THUMBNAIL_ASSET_TYPE.to_string(),
            PREVIEW_ASSET_TYPE.to_string(),
        ]))
        .load(&mut conn)
        .map_err(|err| format!("{err:?}"))?;

    let mut existing_thumbnail = None;
    let mut existing_preview = None;
    for asset in existing_assets {
        match asset.asset_type.as_str() {
            THUMBNAIL_ASSET_TYPE => existing_thumbnail = Some(asset),
            PREVIEW_ASSET_TYPE => existing_preview = Some(asset),
            _ => {}
        }
    }

    let (supported, _) = determine_thumbnail_support(&document);
    if !supported {
        return Err("thumbnail generation not supported for this document".into());
    }

    let skip = existing_thumbnail.is_some() && existing_preview.is_some() && !payload.force;

    Ok(ThumbnailContext {
        document,
        version,
        existing_thumbnail,
        existing_preview,
        skip,
    })
}

fn generate_preview_and_thumbnail(
    document: &Document,
    bytes: &[u8],
) -> Result<GeneratedAssets, String> {
    let is_pdf = document
        .content_type
        .as_deref()
        .map(|mime| mime == "application/pdf")
        .unwrap_or_else(|| {
            document
                .original_name
                .rsplit('.')
                .next()
                .map(|ext| ext.eq_ignore_ascii_case("pdf"))
                .unwrap_or(false)
        });

    if is_pdf {
        let pdf_assets = generate_pdf_assets(bytes)?;
        Ok(GeneratedAssets {
            preview: pdf_assets.preview,
            thumbnail: pdf_assets.thumbnail,
            page_count: Some(pdf_assets.page_count),
        })
    } else {
        let (preview, thumbnail) = generate_image_assets(bytes)?;
        Ok(GeneratedAssets {
            preview,
            thumbnail,
            page_count: None,
        })
    }
}

fn generate_image_assets(bytes: &[u8]) -> Result<(GeneratedImage, GeneratedImage), String> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|err| err.to_string())?;
    let image = reader.decode().map_err(|err| err.to_string())?;

    let preview_image = if image.width() > PREVIEW_WIDTH || image.height() > PREVIEW_HEIGHT {
        image.thumbnail(PREVIEW_WIDTH, PREVIEW_HEIGHT)
    } else {
        image.clone()
    };

    let thumbnail_image =
        if preview_image.width() > THUMBNAIL_WIDTH || preview_image.height() > THUMBNAIL_HEIGHT {
            preview_image.thumbnail(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT)
        } else {
            preview_image.clone()
        };

    let preview = encode_dynamic_image(preview_image)?;
    let thumbnail = encode_dynamic_image(thumbnail_image)?;

    Ok((preview, thumbnail))
}

struct PdfGeneratedAssets {
    preview: GeneratedImage,
    thumbnail: GeneratedImage,
    page_count: u32,
}

fn generate_pdf_assets(bytes: &[u8]) -> Result<PdfGeneratedAssets, String> {
    let pdfium = panic::catch_unwind(|| Pdfium::default())
        .map_err(|_| "failed to initialize PDFium".to_string())?;

    let document = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|err| format!("load pdf: {err}"))?;

    let pages = document.pages();
    let total_pages = pages.len();

    let page = pages
        .get(0)
        .map_err(|err| format!("load first page: {err}"))?;

    let render_config = PdfRenderConfig::new()
        .set_target_width(PREVIEW_WIDTH as i32)
        .set_maximum_height(PREVIEW_HEIGHT as i32)
        .render_form_data(true)
        .rotate_if_landscape(PdfPageRenderRotation::None, true);

    let bitmap = page
        .render_with_config(&render_config)
        .map_err(|err| format!("render pdf page: {err}"))?;

    let preview_buffer = bitmap.as_image().to_rgb8();
    let preview_image = image::DynamicImage::ImageRgb8(preview_buffer);

    let thumbnail_image =
        if preview_image.width() > THUMBNAIL_WIDTH || preview_image.height() > THUMBNAIL_HEIGHT {
            preview_image.thumbnail(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT)
        } else {
            preview_image.clone()
        };

    let preview = encode_dynamic_image(preview_image)?;
    let thumbnail = encode_dynamic_image(thumbnail_image)?;

    let page_count: u32 = total_pages
        .try_into()
        .map_err(|_| "page count exceeds supported range".to_string())?;

    Ok(PdfGeneratedAssets {
        preview,
        thumbnail,
        page_count,
    })
}

fn encode_dynamic_image(image: image::DynamicImage) -> Result<GeneratedImage, String> {
    let (width, height) = image.dimensions();
    let mut cursor = Cursor::new(Vec::new());
    image
        .write_to(&mut cursor, ImageFormat::Png)
        .map_err(|err| err.to_string())?;
    Ok(GeneratedImage {
        image_bytes: cursor.into_inner(),
        width: Some(width as i32),
        height: Some(height as i32),
    })
}

fn persist_assets_metadata(
    state: Arc<AppState>,
    context: &ThumbnailContext,
    assets: &[AssetPersistence<'_>],
) -> Result<(), String> {
    let mut conn = state.db().map_err(|err| format!("{err:?}"))?;

    for asset in assets {
        let new_asset = NewDocumentAsset {
            id: asset.asset_id,
            document_version_id: context.version.id,
            asset_type: asset.asset_type.to_string(),
            s3_key: asset.s3_key.to_string(),
            mime_type: "image/png".to_string(),
            metadata: json!({
                "generated_at": Utc::now().to_rfc3339(),
                "width": asset.generated.width,
                "height": asset.generated.height,
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
    }

    Ok(())
}

fn persist_document_page_count(
    state: Arc<AppState>,
    document_id: Uuid,
    document_version_id: Uuid,
    page_count: u32,
) -> Result<(), String> {
    let mut conn = state.db().map_err(|err| format!("{err:?}"))?;

    let existing_metadata: Value = document_versions::table
        .filter(document_versions::id.eq(document_version_id))
        .filter(document_versions::document_id.eq(document_id))
        .select(document_versions::metadata)
        .first(&mut conn)
        .map_err(|err| format!("{err:?}"))?;

    let updated = match existing_metadata {
        Value::Object(mut map) => {
            map.insert("page_count".to_string(), Value::from(page_count));
            Value::Object(map)
        }
        _ => {
            let mut map = Map::new();
            map.insert("page_count".to_string(), Value::from(page_count));
            Value::Object(map)
        }
    };

    diesel::update(
        document_versions::table
            .filter(document_versions::id.eq(document_version_id))
            .filter(document_versions::document_id.eq(document_id)),
    )
    .set(document_versions::metadata.eq(updated))
    .execute(&mut conn)
    .map_err(|err| format!("{err:?}"))?;

    Ok(())
}
