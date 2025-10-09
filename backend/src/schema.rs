// @generated automatically by Diesel CLI.

diesel::table! {
    correspondents (id) {
        id -> Uuid,
        #[max_length = 255]
        name -> Varchar,
        metadata -> Jsonb,
        created_at -> Timestamptz,
        updated_at -> Timestamptz,
    }
}

diesel::table! {
    document_assets (id) {
        id -> Uuid,
        document_version_id -> Uuid,
        asset_type -> Text,
        s3_key -> Text,
        mime_type -> Text,
        metadata -> Jsonb,
        created_at -> Timestamptz,
    }
}

diesel::table! {
    document_correspondents (document_id, correspondent_id, role) {
        document_id -> Uuid,
        correspondent_id -> Uuid,
        #[max_length = 32]
        role -> Varchar,
        assigned_at -> Timestamptz,
        assigned_by -> Nullable<Uuid>,
    }
}

diesel::table! {
    document_tags (document_id, tag_id) {
        document_id -> Uuid,
        tag_id -> Uuid,
        assigned_at -> Timestamptz,
        assigned_by -> Nullable<Uuid>,
    }
}

diesel::table! {
    document_versions (id) {
        id -> Uuid,
        document_id -> Uuid,
        version_number -> Int4,
        #[max_length = 500]
        s3_key -> Varchar,
        size_bytes -> Int8,
        #[max_length = 64]
        checksum -> Varchar,
        created_at -> Timestamptz,
        operations_summary -> Jsonb,
        metadata -> Jsonb,
    }
}

diesel::table! {
    documents (id) {
        id -> Uuid,
        #[max_length = 255]
        filename -> Varchar,
        #[max_length = 255]
        original_name -> Varchar,
        #[max_length = 100]
        content_type -> Nullable<Varchar>,
        folder_id -> Nullable<Uuid>,
        uploaded_at -> Timestamptz,
        updated_at -> Timestamptz,
        deleted_at -> Nullable<Timestamptz>,
        metadata -> Jsonb,
        issued_at -> Nullable<Timestamptz>,
        #[max_length = 255]
        title -> Varchar,
        current_version_id -> Uuid,
    }
}

diesel::table! {
    folders (id) {
        id -> Uuid,
        #[max_length = 255]
        name -> Varchar,
        parent_id -> Nullable<Uuid>,
        created_at -> Timestamptz,
        updated_at -> Timestamptz,
    }
}

diesel::table! {
    jobs (id) {
        id -> Uuid,
        job_type -> Text,
        payload -> Jsonb,
        status -> Text,
        attempts -> Int4,
        run_after -> Timestamptz,
        last_error -> Nullable<Text>,
        created_at -> Timestamptz,
        updated_at -> Timestamptz,
    }
}

diesel::table! {
    refresh_tokens (id) {
        id -> Uuid,
        user_id -> Uuid,
        token_hash -> Text,
        issued_at -> Timestamptz,
        expires_at -> Timestamptz,
        revoked_at -> Nullable<Timestamptz>,
        created_at -> Timestamptz,
        updated_at -> Timestamptz,
    }
}

diesel::table! {
    tags (id) {
        id -> Uuid,
        #[max_length = 100]
        label -> Varchar,
        #[max_length = 7]
        color -> Nullable<Varchar>,
        created_at -> Timestamptz,
    }
}

diesel::table! {
    users (id) {
        id -> Uuid,
        #[max_length = 100]
        username -> Varchar,
        #[max_length = 255]
        password_hash -> Varchar,
        #[max_length = 16]
        role -> Varchar,
        created_at -> Timestamptz,
        updated_at -> Timestamptz,
    }
}

diesel::joinable!(document_assets -> document_versions (document_version_id));
diesel::joinable!(document_correspondents -> correspondents (correspondent_id));
diesel::joinable!(document_correspondents -> documents (document_id));
diesel::joinable!(document_correspondents -> users (assigned_by));
diesel::joinable!(document_tags -> documents (document_id));
diesel::joinable!(document_tags -> tags (tag_id));
diesel::joinable!(document_tags -> users (assigned_by));
diesel::joinable!(documents -> folders (folder_id));
diesel::joinable!(refresh_tokens -> users (user_id));

diesel::allow_tables_to_appear_in_same_query!(
    correspondents,
    document_assets,
    document_correspondents,
    document_tags,
    document_versions,
    documents,
    folders,
    jobs,
    refresh_tokens,
    tags,
    users,
);
