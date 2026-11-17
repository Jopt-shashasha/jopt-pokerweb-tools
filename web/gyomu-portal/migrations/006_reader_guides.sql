CREATE TABLE resource_reader_guides (
 resource_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
 content TEXT NOT NULL,
 updated_by TEXT NOT NULL REFERENCES users(id),
 updated_at TEXT NOT NULL
);
