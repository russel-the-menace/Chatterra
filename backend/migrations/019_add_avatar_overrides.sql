ALTER TABLE user_character_preferences
  ADD COLUMN IF NOT EXISTS avatar_override TEXT;

ALTER TABLE user_character_preferences
  ALTER COLUMN pinned_at DROP NOT NULL,
  ALTER COLUMN pinned_at DROP DEFAULT;
