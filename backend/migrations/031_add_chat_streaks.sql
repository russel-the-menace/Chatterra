CREATE TABLE IF NOT EXISTS character_streaks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  current_days INTEGER NOT NULL DEFAULT 0 CHECK (current_days >= 0),
  longest_days INTEGER NOT NULL DEFAULT 0 CHECK (longest_days >= 0),
  last_qualified_day DATE,
  restore_count INTEGER NOT NULL DEFAULT 0 CHECK (restore_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, character_id)
);

CREATE TABLE IF NOT EXISTS character_streak_days (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  day_key DATE NOT NULL,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, character_id, day_key)
);

CREATE INDEX IF NOT EXISTS character_streaks_user_index
  ON character_streaks (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS character_streak_days_user_recent_index
  ON character_streak_days (user_id, character_id, day_key DESC);

