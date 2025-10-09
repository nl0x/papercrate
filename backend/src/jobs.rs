use std::time::Duration;

use chrono::{Duration as ChronoDuration, NaiveDateTime, Utc};
use diesel::pg::PgConnection;
use diesel::prelude::*;
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

use crate::models::{Job, NewJob};
use crate::schema::jobs;

pub const STATUS_QUEUED: &str = "queued";
pub const STATUS_PROCESSING: &str = "processing";
pub const STATUS_SUCCEEDED: &str = "succeeded";
pub const STATUS_FAILED: &str = "failed";

pub const JOB_ANALYZE_DOCUMENT: &str = "analyze-document";
pub const JOB_GENERATE_THUMBNAILS: &str = "generate-thumbnails";
pub const JOB_GENERATE_OCR_TEXT: &str = "generate-ocr-text";
pub const JOB_INDEX_DOCUMENT_TEXT: &str = "index-document-text";

#[derive(Debug, Error)]
pub enum JobQueueError {
    #[error("database error: {0}")]
    Database(#[from] diesel::result::Error),
}

pub type JobQueueResult<T> = Result<T, JobQueueError>;

pub fn enqueue_job(
    conn: &mut PgConnection,
    job_type: &str,
    payload: Value,
    run_after: Option<NaiveDateTime>,
) -> JobQueueResult<Job> {
    let new_job = NewJob {
        id: Uuid::new_v4(),
        job_type: job_type.to_string(),
        payload,
        status: STATUS_QUEUED.to_string(),
        run_after: run_after.unwrap_or_else(|| Utc::now().naive_utc()),
    };

    diesel::insert_into(jobs::table)
        .values(&new_job)
        .execute(conn)?;

    let job = jobs::table.find(new_job.id).first(conn)?;
    Ok(job)
}

pub fn reserve_job(conn: &mut PgConnection, job_types: &[&str]) -> JobQueueResult<Option<Job>> {
    let now = Utc::now().naive_utc();

    conn.transaction(|conn| {
        let job_opt = jobs::table
            .filter(jobs::status.eq(STATUS_QUEUED))
            .filter(jobs::run_after.le(now))
            .filter(jobs::job_type.eq_any(job_types))
            .order(jobs::run_after.asc())
            .for_update()
            .skip_locked()
            .first::<Job>(conn)
            .optional()?;

        if let Some(job) = job_opt {
            diesel::update(jobs::table.find(job.id))
                .set((
                    jobs::status.eq(STATUS_PROCESSING),
                    jobs::attempts.eq(job.attempts + 1),
                    jobs::updated_at.eq(now),
                ))
                .execute(conn)?;

            let refreshed = jobs::table.find(job.id).first(conn)?;
            Ok::<Option<Job>, diesel::result::Error>(Some(refreshed))
        } else {
            Ok::<Option<Job>, diesel::result::Error>(None)
        }
    })
    .map_err(JobQueueError::from)
}

pub fn mark_job_succeeded(conn: &mut PgConnection, job_id: Uuid) -> JobQueueResult<()> {
    diesel::update(jobs::table.find(job_id))
        .set((
            jobs::status.eq(STATUS_SUCCEEDED),
            jobs::last_error.eq::<Option<String>>(None),
            jobs::updated_at.eq(Utc::now().naive_utc()),
        ))
        .execute(conn)?;
    Ok(())
}

pub fn retry_job_after(
    conn: &mut PgConnection,
    job_id: Uuid,
    delay: Duration,
    error_message: &str,
) -> JobQueueResult<()> {
    let next_run = Utc::now()
        + ChronoDuration::from_std(delay).unwrap_or_else(|_| ChronoDuration::seconds(30));

    diesel::update(jobs::table.find(job_id))
        .set((
            jobs::status.eq(STATUS_QUEUED),
            jobs::run_after.eq(next_run.naive_utc()),
            jobs::last_error.eq(Some(error_message.to_string())),
            jobs::updated_at.eq(Utc::now().naive_utc()),
        ))
        .execute(conn)?;
    Ok(())
}

pub fn mark_job_failed(
    conn: &mut PgConnection,
    job_id: Uuid,
    error_message: &str,
) -> JobQueueResult<()> {
    diesel::update(jobs::table.find(job_id))
        .set((
            jobs::status.eq(STATUS_FAILED),
            jobs::last_error.eq(Some(error_message.to_string())),
            jobs::updated_at.eq(Utc::now().naive_utc()),
        ))
        .execute(conn)?;
    Ok(())
}
