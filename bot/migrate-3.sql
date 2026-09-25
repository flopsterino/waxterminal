-- Buttons: a question the bot asked waits for its answer here. Run once.
ALTER TABLE chats ADD COLUMN pending TEXT NOT NULL DEFAULT '';
ALTER TABLE chats ADD COLUMN pending_at INTEGER NOT NULL DEFAULT 0;
