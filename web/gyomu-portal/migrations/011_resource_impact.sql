-- 効果（任意）：誰の・どの作業が・どれだけ楽になるか。JSONで保存し、見出しはサーバー側で組み立てる。
ALTER TABLE resources ADD COLUMN impact TEXT;
