ALTER TABLE document_assets
    ADD COLUMN s3_key TEXT;

UPDATE document_assets AS da
SET s3_key = dao.s3_key
FROM document_asset_objects AS dao
WHERE dao.asset_id = da.id
  AND dao.ordinal = 1
  AND da.s3_key IS NULL;

ALTER TABLE document_assets
    ALTER COLUMN s3_key SET NOT NULL;

UPDATE document_assets AS da
SET metadata = jsonb_set(da.metadata, '{width}', dao.metadata->'width', true)
FROM document_asset_objects AS dao
WHERE dao.asset_id = da.id
  AND dao.ordinal = 1
  AND dao.metadata ? 'width';

UPDATE document_assets AS da
SET metadata = jsonb_set(da.metadata, '{height}', dao.metadata->'height', true)
FROM document_asset_objects AS dao
WHERE dao.asset_id = da.id
  AND dao.ordinal = 1
  AND dao.metadata ? 'height';

DROP INDEX IF EXISTS idx_document_asset_objects_asset_ordinal;
DROP TABLE IF EXISTS document_asset_objects;

ALTER TABLE document_assets
    DROP CONSTRAINT IF EXISTS document_assets_cardinality_positive;
ALTER TABLE document_assets
    DROP COLUMN IF EXISTS cardinality;
