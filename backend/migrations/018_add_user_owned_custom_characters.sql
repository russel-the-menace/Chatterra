ALTER TABLE characters
  ADD COLUMN IF NOT EXISTS owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS characters_owner_created_index
  ON characters (owner_user_id, created_at DESC)
  WHERE owner_user_id IS NOT NULL;
