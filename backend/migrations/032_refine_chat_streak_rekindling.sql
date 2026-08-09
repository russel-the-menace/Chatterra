ALTER TABLE character_streaks
  ADD COLUMN IF NOT EXISTS rekindle_progress INTEGER NOT NULL DEFAULT 0
    CHECK (rekindle_progress BETWEEN 0 AND 2);

