ALTER TABLE sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN renewed_at INTEGER NOT NULL DEFAULT 0;
-- Legacy sessions were issued for one hour. Preserve their age and allow
-- the next valid browser request to adopt the persistent-session policy.
UPDATE sessions SET created_at = MAX(0, expires_at - 3600);
