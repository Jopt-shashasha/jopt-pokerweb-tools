-- Independent from FAQ activation. Apply only after the target D1 and rollback
-- procedure have been verified. A stored ID is NOT proof of account ownership.
CREATE TABLE IF NOT EXISTS faq_contact_ids (
  account_id TEXT NOT NULL REFERENCES line_accounts(id),
  friend_id TEXT NOT NULL REFERENCES friends(id),
  kind TEXT NOT NULL CHECK(kind IN ('game_id','games_id')),
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,friend_id,kind)
);
CREATE INDEX IF NOT EXISTS faq_contact_ids_expiry ON faq_contact_ids(expires_at);

-- Immutable copy selected for a particular case. Updating the remembered ID
-- for a later inquiry must never silently change an older case's identity.
CREATE TABLE IF NOT EXISTS faq_case_contact_ids (
  case_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('game_id','games_id')),
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL,
  profile_revision INTEGER NOT NULL CHECK(profile_revision > 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(case_id,kind),
  FOREIGN KEY(case_id,account_id,friend_id) REFERENCES faq_cases(id,account_id,friend_id)
);
CREATE TABLE IF NOT EXISTS faq_case_contact_access_audit (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('game_id','games_id')),
  created_at INTEGER NOT NULL
);
