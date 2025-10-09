CREATE TABLE document_assets (
    id UUID PRIMARY KEY,
    document_version_id UUID NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
    asset_type TEXT NOT NULL,
    s3_key TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT document_assets_unique UNIQUE (document_version_id, asset_type)
);

CREATE INDEX idx_document_assets_version ON document_assets(document_version_id);
CREATE INDEX idx_document_assets_type ON document_assets(asset_type);
