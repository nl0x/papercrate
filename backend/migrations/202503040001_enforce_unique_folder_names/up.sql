ALTER TABLE folders
    DROP CONSTRAINT IF EXISTS folders_parent_name_unique;

CREATE UNIQUE INDEX folders_parent_name_unique_idx
    ON folders (COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
