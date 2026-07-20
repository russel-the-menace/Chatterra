ALTER TABLE users
  ALTER COLUMN consent_flags
  SET DEFAULT '{"memoryPersonalization": true}'::jsonb;

UPDATE users
SET consent_flags = jsonb_set(consent_flags, '{memoryPersonalization}', 'true'::jsonb, TRUE),
    updated_at = NOW()
WHERE NOT (consent_flags ? 'memoryPersonalization');

UPDATE characters
SET default_settings = default_settings
  - 'temperature'
  - 'topP'
  - 'top_p'
  - 'maxResponseTokens'
  - 'max_response_tokens'
  - 'contextWindow'
  - 'contextMessages'
  - 'context_messages';

CREATE TABLE IF NOT EXISTS inference_records (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES character_instances(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  decision_id TEXT REFERENCES decision_records(id) ON DELETE SET NULL,
  trigger_event_id TEXT REFERENCES domain_events(id) ON DELETE SET NULL,
  output_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK (mode IN ('companion', 'practice')),
  route TEXT NOT NULL CHECK (route IN ('direct', 'model', 'tool', 'none')),
  reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  policy_version TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  profile TEXT,
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_style JSONB NOT NULL DEFAULT '{}'::jsonb,
  context_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'completed'
    CHECK (status IN ('planned', 'completed', 'failed', 'cancelled')),
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS inference_records_instance_index
  ON inference_records (instance_id, created_at DESC);

CREATE INDEX IF NOT EXISTS inference_records_conversation_index
  ON inference_records (conversation_id, created_at DESC);

ALTER TABLE generation_records
  ADD COLUMN IF NOT EXISTS inference_id TEXT REFERENCES inference_records(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS generation_records_inference_index
  ON generation_records (inference_id);
