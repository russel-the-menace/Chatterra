CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT,
  native_language TEXT,
  learning_goals JSONB NOT NULL DEFAULT '{}'::jsonb,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  consent_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX users_email_unique
  ON users (LOWER(email))
  WHERE email IS NOT NULL;

CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (BTRIM(name) <> ''),
  avatar TEXT,
  role TEXT,
  personality TEXT,
  company TEXT,
  scenario TEXT,
  goal TEXT,
  language TEXT,
  background TEXT,
  system_prompt_template TEXT,
  default_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX characters_name_index ON characters (LOWER(name));

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  last_message_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX conversations_user_recent_index
  ON conversations (user_id, last_message_at DESC NULLS LAST, created_at DESC);
CREATE INDEX conversations_character_index ON conversations (character_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('user', 'assistant', 'system')),
  sender_id TEXT,
  content TEXT NOT NULL,
  content_json JSONB,
  token_count INTEGER CHECK (token_count IS NULL OR token_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX messages_conversation_time_index
  ON messages (conversation_id, created_at, id);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
  origin_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN (
    'user_profile',
    'background',
    'preference',
    'past_event',
    'learning_weakness',
    'important_fact',
    'other'
  )),
  content TEXT NOT NULL,
  importance_score DOUBLE PRECISION NOT NULL CHECK (importance_score BETWEEN 0 AND 1),
  confidence DOUBLE PRECISION CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ,
  last_updated_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX memories_user_character_index
  ON memories (user_id, character_id, importance_score DESC, created_at DESC);
CREATE INDEX memories_origin_message_index ON memories (origin_message_id);

CREATE TABLE conversation_summaries (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  summary_text TEXT NOT NULL,
  last_generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  coverage JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX conversation_summaries_conversation_index
  ON conversation_summaries (conversation_id, last_generated_at DESC);
