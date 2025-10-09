CREATE TABLE correspondents (
    id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT correspondents_name_unique UNIQUE (name)
);

CREATE TABLE document_correspondents (
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    correspondent_id UUID NOT NULL REFERENCES correspondents(id) ON DELETE CASCADE,
    role VARCHAR(32) NOT NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    assigned_by UUID REFERENCES users(id),
    PRIMARY KEY (document_id, correspondent_id, role),
    CONSTRAINT document_correspondents_role_check CHECK (role IN ('sender', 'receiver', 'other'))
);

CREATE INDEX idx_document_correspondents_document
    ON document_correspondents(document_id);

CREATE INDEX idx_document_correspondents_correspondent
    ON document_correspondents(correspondent_id);

CREATE INDEX idx_document_correspondents_role
    ON document_correspondents(role);
