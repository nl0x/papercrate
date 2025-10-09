-- Restore width/height columns and repopulate from metadata where available.

ALTER TABLE document_assets
    ADD COLUMN width INTEGER,
    ADD COLUMN height INTEGER;

UPDATE document_assets
SET width = (metadata->>'width')::INTEGER
WHERE metadata ? 'width';

UPDATE document_assets
SET height = (metadata->>'height')::INTEGER
WHERE metadata ? 'height';
