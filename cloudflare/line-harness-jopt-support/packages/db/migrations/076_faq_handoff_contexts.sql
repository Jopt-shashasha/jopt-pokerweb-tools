CREATE TABLE IF NOT EXISTS faq_handoff_contexts (
  session_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  classification TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(session_id,node_id,event_key)
);
CREATE INDEX IF NOT EXISTS faq_handoff_contexts_friend ON faq_handoff_contexts(account_id,friend_id,created_at);
