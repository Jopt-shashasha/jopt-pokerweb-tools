-- Snapshot the authenticated sender; retain attribution after staff rename/deletion.
ALTER TABLE messages_log ADD COLUMN sender_staff_id TEXT;
ALTER TABLE messages_log ADD COLUMN sender_staff_name TEXT;
