DROP TRIGGER IF EXISTS trg_jobs_updated_at ON jobs;
DROP FUNCTION IF EXISTS touch_jobs_updated_at;
DROP INDEX IF EXISTS idx_jobs_job_type;
DROP INDEX IF EXISTS idx_jobs_status_run_after;
DROP TABLE IF EXISTS jobs;
