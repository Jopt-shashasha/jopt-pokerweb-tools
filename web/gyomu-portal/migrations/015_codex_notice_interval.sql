-- Codexへのお知らせ（新着資料・ニュース）は既定で週1回。PCごとに最後に伝えた時刻を保存する。
ALTER TABLE agent_tokens ADD COLUMN last_notice_at TEXT;
