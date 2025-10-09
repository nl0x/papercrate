ALTER TABLE document_versions
    ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
