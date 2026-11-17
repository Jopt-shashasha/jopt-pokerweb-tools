CREATE TABLE IF NOT EXISTS faq_case_intakes (
  case_id TEXT PRIMARY KEY REFERENCES faq_cases(id),
  policy_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  submission_hash TEXT,
  submitted_at TEXT
);
CREATE TABLE IF NOT EXISTS faq_case_uploads (
  case_id TEXT PRIMARY KEY REFERENCES faq_cases(id),
  attachment_id TEXT NOT NULL UNIQUE,
  storage_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','stored','deleted')),
  retry_after INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS faq_case_upload_cleanup ON faq_case_uploads(state,retry_after);
