CREATE TABLE portal_batch_guard (
 ok INTEGER NOT NULL CONSTRAINT portal_precondition CHECK (ok = 1)
);

CREATE TABLE portal_rate_limits (
 key TEXT PRIMARY KEY,
 count INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX portal_rate_limits_expiry ON portal_rate_limits (expires_at);
