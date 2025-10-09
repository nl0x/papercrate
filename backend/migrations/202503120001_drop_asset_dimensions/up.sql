-- Backfill existing width/height values into metadata then drop the columns.

UPDATE document_assets
SET metadata = metadata || jsonb_build_object('width', width)
WHERE width IS NOT NULL
  AND NOT (metadata ? 'width');

UPDATE document_assets
SET metadata = metadata || jsonb_build_object('height', height)
WHERE height IS NOT NULL
  AND NOT (metadata ? 'height');

ALTER TABLE document_assets
    DROP COLUMN width,
    DROP COLUMN height;
