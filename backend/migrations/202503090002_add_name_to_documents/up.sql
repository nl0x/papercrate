ALTER TABLE documents
    ADD COLUMN name VARCHAR(255);

UPDATE documents
SET name = CASE
    WHEN filename ~ '\\.[^./]+$' THEN regexp_replace(filename, '\\.[^./]+$', '')
    ELSE filename
END;

ALTER TABLE documents
    ALTER COLUMN name SET NOT NULL;
