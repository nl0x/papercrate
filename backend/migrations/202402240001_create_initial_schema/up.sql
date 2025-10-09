CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE users (
    id UUID PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(16) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE folders (
    id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    parent_id UUID REFERENCES folders(id) ON DELETE SET NULL,
    path_cache VARCHAR(1000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT folders_parent_name_unique UNIQUE (parent_id, name)
);

CREATE INDEX idx_folders_parent ON folders(parent_id);

CREATE TABLE documents (
    id UUID PRIMARY KEY,
    filename VARCHAR(255) NOT NULL,
    original_name VARCHAR(255) NOT NULL,
    content_type VARCHAR(100),
    folder_id UUID REFERENCES folders(id) ON DELETE SET NULL,
    current_version INTEGER NOT NULL,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_documents_folder ON documents(folder_id);
CREATE INDEX idx_documents_deleted_at ON documents(deleted_at);

CREATE TABLE document_versions (
    id UUID PRIMARY KEY,
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    s3_key VARCHAR(500) NOT NULL,
    size_bytes BIGINT NOT NULL,
    checksum VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    operations_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT document_versions_unique_version UNIQUE (document_id, version_number)
);

CREATE INDEX idx_document_versions_document ON document_versions(document_id);

CREATE TABLE tags (
    id UUID PRIMARY KEY,
    label VARCHAR(100) NOT NULL UNIQUE,
    color VARCHAR(7),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE document_tags (
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    assigned_by UUID REFERENCES users(id),
    PRIMARY KEY (document_id, tag_id)
);

CREATE INDEX idx_document_tags_tag ON document_tags(tag_id);

INSERT INTO users (id, username, password_hash, role)
VALUES (
    gen_random_uuid(),
    'admin',
    '$argon2id$v=19$m=19456,t=2,p=1$UMkfsNut028fmZupy9JoQg$/YFvGQoEZ2hhMiDCyv68ZROF97GcwAxxRwRgwSbpX5U',
    'admin'
);
