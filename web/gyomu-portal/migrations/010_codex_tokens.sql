-- Codex連携: one-time setup codes, read-scoped personal tokens and usage log.
-- Only hashes of codes and tokens are stored.
CREATE TABLE agent_setup_codes (
 code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX agent_setup_codes_expiry ON agent_setup_codes(expires_at);
CREATE TABLE agent_tokens (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 last_used_at INTEGER, revoked_at INTEGER, last_seen_new_at INTEGER
);
CREATE INDEX agent_tokens_user ON agent_tokens(user_id);
CREATE TABLE resource_usage (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
 via TEXT NOT NULL CHECK(via IN ('codex')), action TEXT NOT NULL CHECK(action IN ('read','suggested')),
 created_at INTEGER NOT NULL
);
CREATE INDEX resource_usage_resource ON resource_usage(resource_id,created_at);
