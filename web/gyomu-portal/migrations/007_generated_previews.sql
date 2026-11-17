CREATE TABLE resource_preview_inputs (
 resource_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
 blob TEXT NOT NULL, filename TEXT NOT NULL, sha256 TEXT NOT NULL
);
CREATE TABLE resource_generated_previews (
 resource_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
 blob TEXT NOT NULL, content_key TEXT NOT NULL, kind TEXT NOT NULL,
 created_at TEXT NOT NULL
);
