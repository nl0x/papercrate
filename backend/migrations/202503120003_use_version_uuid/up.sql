ALTER TABLE documents ADD COLUMN current_version_id UUID;

UPDATE documents AS d
SET current_version_id = dv.id
FROM document_versions AS dv
WHERE dv.document_id = d.id
  AND dv.version_number = d.current_version;

ALTER TABLE documents
    ALTER COLUMN current_version_id SET NOT NULL;

ALTER TABLE documents
    ADD CONSTRAINT documents_current_version_fk
        FOREIGN KEY (current_version_id)
        REFERENCES document_versions(id)
        DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX idx_documents_current_version_id
    ON documents(current_version_id);

ALTER TABLE documents DROP COLUMN current_version;
