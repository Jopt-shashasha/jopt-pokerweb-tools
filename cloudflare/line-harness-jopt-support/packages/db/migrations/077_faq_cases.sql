-- Additive, opt-in storage for structured FAQ inquiries. Existing FAQ sessions,
-- message logs and public image endpoints are intentionally left unchanged.
CREATE TABLE IF NOT EXISTS faq_cases (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES line_accounts(id),
  friend_id TEXT NOT NULL REFERENCES friends(id),
  faq_session_id TEXT NOT NULL REFERENCES faq_sessions(id),
  release_id TEXT NOT NULL REFERENCES faq_releases(id),
  node_id TEXT NOT NULL,
  event_id TEXT,
  selection_json TEXT NOT NULL,
  requires_attachment INTEGER NOT NULL CHECK(requires_attachment IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('draft','awaiting_image','submitted','checking','needs_staff','answered','closed')),
  idempotency_key TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, friend_id, idempotency_key),
  UNIQUE(id, account_id, friend_id)
);
CREATE INDEX IF NOT EXISTS idx_faq_cases_owner ON faq_cases(account_id, friend_id, created_at);
CREATE INDEX IF NOT EXISTS idx_faq_cases_status ON faq_cases(account_id, status, updated_at);

CREATE TABLE IF NOT EXISTS faq_case_attachments (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL CHECK(content_type IN ('image/jpeg','image/png','image/gif','image/webp')),
  size_bytes INTEGER NOT NULL CHECK(size_bytes > 0 AND size_bytes <= 10485760),
  created_at TEXT NOT NULL,
  UNIQUE(account_id, source_event_id),
  FOREIGN KEY(case_id, account_id, friend_id) REFERENCES faq_cases(id, account_id, friend_id)
);
CREATE INDEX IF NOT EXISTS idx_faq_case_attachments_case ON faq_case_attachments(case_id, account_id, friend_id, created_at);
