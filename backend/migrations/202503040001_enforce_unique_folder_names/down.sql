DROP INDEX IF EXISTS folders_parent_name_unique_idx;

ALTER TABLE folders
    ADD CONSTRAINT folders_parent_name_unique UNIQUE (parent_id, name);
