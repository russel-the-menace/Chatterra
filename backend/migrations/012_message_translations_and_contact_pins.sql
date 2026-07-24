CREATE TABLE message_translations (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  segment_index INTEGER NOT NULL DEFAULT 0 CHECK (segment_index >= 0),
  target_language TEXT NOT NULL CHECK (BTRIM(target_language) <> ''),
  translated_text TEXT NOT NULL CHECK (BTRIM(translated_text) <> ''),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, segment_index, target_language)
);

CREATE INDEX message_translations_message_index
  ON message_translations (message_id, target_language, segment_index);

CREATE TABLE user_character_preferences (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  pinned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, character_id)
);

CREATE INDEX user_character_preferences_pinned_index
  ON user_character_preferences (user_id, pinned_at DESC);
