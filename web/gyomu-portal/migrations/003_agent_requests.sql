CREATE TABLE agent_requests (
 id TEXT PRIMARY KEY, result_hash TEXT NOT NULL,
 operation TEXT NOT NULL CHECK(operation IN ('search','read','register')),
 input TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done','error','cancelled')),
 actor_id TEXT REFERENCES users(id), session_hash TEXT REFERENCES sessions(token_hash) ON DELETE CASCADE,
 result TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX agent_requests_expiry ON agent_requests(expires_at);
