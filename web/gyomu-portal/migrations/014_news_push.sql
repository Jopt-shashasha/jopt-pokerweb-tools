-- ニュースの配信：Slackへの送信記録（同じ記事を同じチャンネルへ二重に送らない）と、Codex向けの既読位置。
ALTER TABLE agent_tokens ADD COLUMN last_seen_news_at TEXT;
CREATE TABLE news_posts (
 id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, channel_name TEXT, text TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('sending','sent','failed','unknown')),
 slack_ts TEXT, error TEXT, forced INTEGER NOT NULL DEFAULT 0,
 actor_id TEXT REFERENCES users(id), resolved_by TEXT REFERENCES users(id),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE news_sent (
 post_id TEXT NOT NULL REFERENCES news_posts(id) ON DELETE CASCADE, url_hash TEXT NOT NULL,
 channel_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL,
 PRIMARY KEY(post_id,url_hash)
);
CREATE INDEX news_sent_lookup ON news_sent(url_hash,channel_id);
