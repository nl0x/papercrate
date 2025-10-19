ALTER TABLE document_assets
    ADD COLUMN cardinality INTEGER,
    ADD CONSTRAINT document_assets_cardinality_positive CHECK (cardinality IS NULL OR cardinality >= 1);

CREATE TABLE document_asset_objects (
    id UUID PRIMARY KEY,
    asset_id UUID NOT NULL REFERENCES document_assets(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    s3_key TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT document_asset_objects_ordinal_positive CHECK (ordinal >= 1),
    CONSTRAINT document_asset_objects_asset_ordinal_unique UNIQUE (asset_id, ordinal)
);

CREATE INDEX idx_document_asset_objects_asset_ordinal
    ON document_asset_objects (asset_id, ordinal);

INSERT INTO document_asset_objects (id, asset_id, ordinal, s3_key, metadata)
SELECT
    gen_random_uuid(),
    id,
    1,
    s3_key,
    '{}'::jsonb
FROM document_assets;

UPDATE document_asset_objects AS dao
SET metadata = jsonb_set(dao.metadata, '{width}', da.metadata->'width', true)
FROM document_assets AS da
WHERE dao.asset_id = da.id
  AND dao.ordinal = 1
  AND da.metadata ? 'width';

UPDATE document_asset_objects AS dao
SET metadata = jsonb_set(dao.metadata, '{height}', da.metadata->'height', true)
FROM document_assets AS da
WHERE dao.asset_id = da.id
  AND dao.ordinal = 1
  AND da.metadata ? 'height';

UPDATE document_assets
SET metadata = metadata - 'width'
WHERE metadata ? 'width';

UPDATE document_assets
SET metadata = metadata - 'height'
WHERE metadata ? 'height';

UPDATE document_assets
SET cardinality = 1
WHERE cardinality IS NULL;

ALTER TABLE document_assets
    DROP COLUMN s3_key;
