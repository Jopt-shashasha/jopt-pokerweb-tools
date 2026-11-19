-- 個人へのDM紹介。SlackユーザーIDは会社メールから照合してキャッシュする。
ALTER TABLE users ADD COLUMN slack_user_id TEXT;
ALTER TABLE slack_posts ADD COLUMN recipient_user_id TEXT REFERENCES users(id);
CREATE INDEX slack_posts_recipient ON slack_posts(recipient_user_id,created_at);
