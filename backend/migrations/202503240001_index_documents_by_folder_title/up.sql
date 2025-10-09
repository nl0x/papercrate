CREATE INDEX idx_documents_folder_title
    ON documents (
        COALESCE(folder_id, '00000000-0000-0000-0000-000000000000'::uuid),
        title
    )
    WHERE deleted_at IS NULL;

CREATE INDEX idx_documents_folder_filename
    ON documents (
        COALESCE(folder_id, '00000000-0000-0000-0000-000000000000'::uuid),
        filename
    )
    WHERE deleted_at IS NULL;
