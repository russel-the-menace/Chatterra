ALTER TABLE characters
  ADD COLUMN IF NOT EXISTS current_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS character_versions (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  definition JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (character_id, version)
);

INSERT INTO character_versions (id, character_id, version, definition, created_at)
SELECT
  c.id || ':v1',
  c.id,
  1,
  jsonb_build_object(
    'name', c.name,
    'avatar', COALESCE(c.avatar, ''),
    'role', COALESCE(c.role, ''),
    'company', COALESCE(c.company, ''),
    'personality', COALESCE(c.personality, ''),
    'scenario', COALESCE(c.scenario, ''),
    'goal', COALESCE(c.goal, ''),
    'language', COALESCE(c.language, ''),
    'background', COALESCE(c.background, ''),
    'systemPromptTemplate', COALESCE(c.system_prompt_template, ''),
    'defaultSettings', c.default_settings
  ),
  c.created_at
FROM characters c
ON CONFLICT (character_id, version) DO NOTHING;

CREATE TABLE IF NOT EXISTS character_instances (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  template_version INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL DEFAULT 'practice'
    CHECK (mode IN ('companion', 'practice')),
  event_sequence BIGINT NOT NULL DEFAULT 0 CHECK (event_sequence >= 0),
  last_interaction_at TIMESTAMPTZ,
  next_action_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, character_id),
  FOREIGN KEY (character_id, template_version)
    REFERENCES character_versions(character_id, version)
);

CREATE INDEX IF NOT EXISTS character_instances_user_index
  ON character_instances (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS character_instances_next_action_index
  ON character_instances (next_action_at)
  WHERE next_action_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS relationship_states (
  instance_id TEXT PRIMARY KEY REFERENCES character_instances(id) ON DELETE CASCADE,
  familiarity DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (familiarity BETWEEN 0 AND 1),
  trust DOUBLE PRECISION NOT NULL DEFAULT 0.5 CHECK (trust BETWEEN 0 AND 1),
  affinity DOUBLE PRECISION NOT NULL DEFAULT 0.5 CHECK (affinity BETWEEN 0 AND 1),
  respect DOUBLE PRECISION NOT NULL DEFAULT 0.5 CHECK (respect BETWEEN 0 AND 1),
  reciprocity DOUBLE PRECISION NOT NULL DEFAULT 0.5 CHECK (reciprocity BETWEEN 0 AND 1),
  boundary_comfort DOUBLE PRECISION NOT NULL DEFAULT 0.5 CHECK (boundary_comfort BETWEEN 0 AND 1),
  unresolved_tension DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (unresolved_tension BETWEEN 0 AND 1),
  bond_strength DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (bond_strength BETWEEN 0 AND 1),
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  as_of TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS affect_states (
  instance_id TEXT PRIMARY KEY REFERENCES character_instances(id) ON DELETE CASCADE,
  valence DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (valence BETWEEN -1 AND 1),
  arousal DOUBLE PRECISION NOT NULL DEFAULT 0.35 CHECK (arousal BETWEEN 0 AND 1),
  dominance DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (dominance BETWEEN -1 AND 1),
  warmth DOUBLE PRECISION NOT NULL DEFAULT 0.1 CHECK (warmth BETWEEN -1 AND 1),
  stress DOUBLE PRECISION NOT NULL DEFAULT 0.2 CHECK (stress BETWEEN 0 AND 1),
  energy DOUBLE PRECISION NOT NULL DEFAULT 0.7 CHECK (energy BETWEEN 0 AND 1),
  baseline JSONB NOT NULL DEFAULT '{"valence":0,"arousal":0.35,"dominance":0,"warmth":0.1,"stress":0.2,"energy":0.7}'::jsonb,
  last_event_id TEXT,
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  as_of TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS simulation_cursors (
  instance_id TEXT PRIMARY KEY REFERENCES character_instances(id) ON DELETE CASCADE,
  local_timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  current_activity TEXT NOT NULL DEFAULT 'available',
  activity_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activity_ends_at TIMESTAMPTZ,
  last_simulated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_wakeup_at TIMESTAMPTZ,
  routine_seed TEXT NOT NULL DEFAULT 'default',
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS domain_events (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES character_instances(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  sequence_no BIGINT NOT NULL CHECK (sequence_no > 0),
  event_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  actor_role TEXT NOT NULL DEFAULT 'system'
    CHECK (actor_role IN ('user', 'character', 'system', 'scheduler')),
  actor_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL DEFAULT 'application',
  confidence DOUBLE PRECISION CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  causation_id TEXT,
  correlation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (instance_id, sequence_no)
);

CREATE INDEX IF NOT EXISTS domain_events_instance_time_index
  ON domain_events (instance_id, occurred_at DESC, sequence_no DESC);
CREATE INDEX IF NOT EXISTS domain_events_type_index
  ON domain_events (event_type, occurred_at DESC);

CREATE TABLE IF NOT EXISTS outbox_records (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES domain_events(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS outbox_pending_index
  ON outbox_records (available_at, created_at)
  WHERE processed_at IS NULL;

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS representation TEXT NOT NULL DEFAULT 'semantic',
  ADD COLUMN IF NOT EXISTS retention_tier TEXT NOT NULL DEFAULT 'durable',
  ADD COLUMN IF NOT EXISTS retrieval_strength DOUBLE PRECISION NOT NULL DEFAULT 0.6,
  ADD COLUMN IF NOT EXISTS half_life_hours DOUBLE PRECISION NOT NULL DEFAULT 720,
  ADD COLUMN IF NOT EXISTS sensitivity TEXT NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS supersedes_id TEXT,
  ADD COLUMN IF NOT EXISTS confirmed BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memories_representation_check'
  ) THEN
    ALTER TABLE memories ADD CONSTRAINT memories_representation_check
      CHECK (representation IN ('episodic', 'semantic', 'procedural', 'summary'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memories_retention_tier_check'
  ) THEN
    ALTER TABLE memories ADD CONSTRAINT memories_retention_tier_check
      CHECK (retention_tier IN ('working', 'short_lived', 'durable', 'archived'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memories_retrieval_strength_check'
  ) THEN
    ALTER TABLE memories ADD CONSTRAINT memories_retrieval_strength_check
      CHECK (retrieval_strength BETWEEN 0 AND 1);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memories_half_life_check'
  ) THEN
    ALTER TABLE memories ADD CONSTRAINT memories_half_life_check
      CHECK (half_life_hours > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS memories_retrieval_index
  ON memories (user_id, character_id, retention_tier, retrieval_strength DESC, importance_score DESC);

CREATE TABLE IF NOT EXISTS memory_evidence (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  event_id TEXT REFERENCES domain_events(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  evidence_type TEXT NOT NULL DEFAULT 'assertion',
  excerpt TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS memory_evidence_memory_index
  ON memory_evidence (memory_id, created_at DESC);

CREATE TABLE IF NOT EXISTS decision_records (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES character_instances(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  trigger_event_id TEXT REFERENCES domain_events(id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK (mode IN ('companion', 'practice')),
  action TEXT NOT NULL,
  reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  score_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  due_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS decision_records_instance_index
  ON decision_records (instance_id, created_at DESC);

CREATE TABLE IF NOT EXISTS generation_records (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES character_instances(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  decision_id TEXT REFERENCES decision_records(id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK (mode IN ('companion', 'practice')),
  provider TEXT,
  model TEXT,
  profile TEXT NOT NULL DEFAULT 'companion_balanced',
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  context_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS generation_records_instance_index
  ON generation_records (instance_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_learning_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  target_language TEXT,
  proficiency JSONB NOT NULL DEFAULT '{}'::jsonb,
  correction_mode TEXT NOT NULL DEFAULT 'selective'
    CHECK (correction_mode IN ('immediate', 'delayed', 'selective', 'explicit')),
  goals JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO user_learning_profiles (user_id)
SELECT id FROM users
ON CONFLICT (user_id) DO NOTHING;
