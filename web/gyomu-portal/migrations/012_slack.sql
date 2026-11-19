-- Slack紹介：部署ごとの配信先、送信記録（タイムアウト時は unknown として人が確認）、リンクのクリック記録。
ALTER TABLE departments ADD COLUMN slack_channel_id TEXT;
ALTER TABLE departments ADD COLUMN slack_channel_name TEXT;
ALTER TABLE departments ADD COLUMN slack_enabled INTEGER NOT NULL DEFAULT 0;
CREATE TABLE portal_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE slack_posts (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('intro','digest')),
 resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL, resource_ids TEXT NOT NULL DEFAULT '[]',
 channel_id TEXT NOT NULL, channel_name TEXT, text TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('sending','sent','failed','unknown')),
 period TEXT, slack_ts TEXT, error TEXT, forced INTEGER NOT NULL DEFAULT 0,
 actor_id TEXT REFERENCES users(id), resolved_by TEXT REFERENCES users(id),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX slack_posts_channel ON slack_posts(channel_id,kind,created_at);
CREATE INDEX slack_posts_resource ON slack_posts(resource_id);
CREATE TABLE link_clicks (
 id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
 post_id TEXT REFERENCES slack_posts(id) ON DELETE SET NULL, user_id TEXT REFERENCES users(id),
 created_at TEXT NOT NULL
);
CREATE INDEX link_clicks_resource ON link_clicks(resource_id,created_at);
