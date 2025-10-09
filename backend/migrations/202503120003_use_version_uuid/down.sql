ALTER TABLE documents ADD COLUMN current_version INT4;

UPDATE documents AS d
SET current_version = dv.version_number
FROM document_versions AS dv
WHERE dv.id = d.current_version_id;

ALTER TABLE documents
    ALTER COLUMN current_version SET NOT NULL;

DROP INDEX IF EXISTS idx_documents_current_version_id;

ALTER TABLE documents
    DROP CONSTRAINT IF EXISTS documents_current_version_fk;

ALTER TABLE documents
    DROP COLUMN current_version_id;
