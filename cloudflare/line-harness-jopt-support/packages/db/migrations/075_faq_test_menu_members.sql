CREATE TABLE IF NOT EXISTS faq_test_menu_members (
  account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  rich_menu_id TEXT NOT NULL,
  previous_menu_id TEXT,
  added_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(account_id, friend_id)
);
