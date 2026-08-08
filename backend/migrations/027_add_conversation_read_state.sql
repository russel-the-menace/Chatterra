ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_read_message_at TIMESTAMPTZ;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_read_message_id TEXT;

-- Existing transcripts predate unread tracking, so they begin as read rather
-- than presenting every historical assistant reply as a new notification.
UPDATE conversations
SET last_read_message_at = COALESCE(last_read_message_at, last_message_at, created_at)
WHERE last_read_message_at IS NULL;

CREATE INDEX IF NOT EXISTS messages_assistant_conversation_time_index
  ON messages (conversation_id, created_at, id)
  WHERE sender_role = 'assistant';
