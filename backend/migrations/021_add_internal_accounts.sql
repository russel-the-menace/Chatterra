ALTER TABLE users
  ADD COLUMN IF NOT EXISTS username TEXT,
  ADD COLUMN IF NOT EXISTS password_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique_index
  ON users (LOWER(username))
  WHERE username IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS auth_sessions_token_expiry_index
  ON auth_sessions (token_hash, expires_at DESC);

CREATE INDEX IF NOT EXISTS auth_sessions_user_expiry_index
  ON auth_sessions (user_id, expires_at DESC);

DO $migration$
DECLARE
  yeatom_id CONSTANT TEXT := 'account-yeatom';
  test_id CONSTANT TEXT := 'account-test';
BEGIN
  INSERT INTO users (
    id, display_name, username, password_hash, learning_goals, preferences,
    consent_flags, created_at, updated_at
  ) VALUES
    (
      yeatom_id,
      'yeatom',
      'yeatom',
      'scrypt$5ed8daf2756281b52e9c422914d0e664$4d2f31ffecb5724cac3975b97d0885b2674a53f439d4a010a6ddb3e3f239fb8eb1975db0c7af7e491c6cbb812f476bf3e2641368c5144d0bfea4feca7d220862',
      '{}'::jsonb,
      '{}'::jsonb,
      '{"memoryPersonalization": true}'::jsonb,
      NOW(),
      NOW()
    ),
    (
      test_id,
      'test',
      'test',
      'scrypt$2b702ea9b46458ee104d17d7244213a4$e8392b77370078f7116e64c1bf4fca7d544b29acf5130c7a234f7efd7b1ecf963178643b334d323610c83d3504fd286800a1699049f42dd09c461de6c7a2df32',
      '{}'::jsonb,
      '{}'::jsonb,
      '{"memoryPersonalization": true}'::jsonb,
      NOW(),
      NOW()
    )
  ON CONFLICT (id) DO UPDATE SET
    username = EXCLUDED.username,
    password_hash = EXCLUDED.password_hash,
    updated_at = NOW();

  WITH source_profile AS (
    SELECT display_name, learning_goals, preferences, consent_flags
    FROM users
    WHERE id NOT IN (yeatom_id, test_id)
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
  )
  UPDATE users AS target
  SET
    display_name = CASE
      WHEN source_profile.display_name IS NULL OR source_profile.display_name = 'Local User'
        THEN target.display_name
      ELSE source_profile.display_name
    END,
    learning_goals = COALESCE(source_profile.learning_goals, target.learning_goals),
    preferences = COALESCE(source_profile.preferences, target.preferences),
    consent_flags = COALESCE(source_profile.consent_flags, target.consent_flags),
    updated_at = NOW()
  FROM source_profile
  WHERE target.id = yeatom_id;

  UPDATE characters
  SET owner_user_id = yeatom_id,
      updated_at = NOW()
  WHERE owner_user_id IS NOT NULL
    AND owner_user_id NOT IN (yeatom_id, test_id);

  UPDATE conversations
  SET user_id = yeatom_id,
      updated_at = NOW()
  WHERE user_id NOT IN (yeatom_id, test_id);

  UPDATE messages
  SET sender_id = yeatom_id
  WHERE sender_role = 'user'
    AND sender_id IS NOT NULL
    AND sender_id NOT IN (yeatom_id, test_id);

  UPDATE messages
  SET content_json = jsonb_set(
    content_json,
    '{voice,audioUrl}',
    to_jsonb('/media/voice/' || (content_json #>> '{voice,filename}')),
    TRUE
  )
  WHERE content_json #>> '{voice,provider}' = 'user-recording'
    AND COALESCE(content_json #>> '{voice,filename}', '') <> '';

  UPDATE memories
  SET user_id = yeatom_id
  WHERE user_id NOT IN (yeatom_id, test_id);

  UPDATE domain_events
  SET user_id = yeatom_id
  WHERE user_id NOT IN (yeatom_id, test_id);

  UPDATE expo_push_devices
  SET user_id = yeatom_id,
      updated_at = NOW()
  WHERE user_id NOT IN (yeatom_id, test_id);

  INSERT INTO user_learning_profiles (
    user_id, target_language, proficiency, correction_mode, goals, updated_at
  )
  SELECT yeatom_id, target_language, proficiency, correction_mode, goals, updated_at
  FROM user_learning_profiles
  WHERE user_id NOT IN (yeatom_id, test_id)
  ORDER BY updated_at DESC
  LIMIT 1
  ON CONFLICT (user_id) DO UPDATE SET
    target_language = EXCLUDED.target_language,
    proficiency = EXCLUDED.proficiency,
    correction_mode = EXCLUDED.correction_mode,
    goals = EXCLUDED.goals,
    updated_at = EXCLUDED.updated_at;

  INSERT INTO user_character_preferences (user_id, character_id, pinned_at, avatar_override)
  SELECT yeatom_id, character_id, pinned_at, avatar_override
  FROM user_character_preferences
  WHERE user_id NOT IN (yeatom_id, test_id)
  ON CONFLICT (user_id, character_id) DO UPDATE SET
    pinned_at = CASE
      WHEN user_character_preferences.pinned_at IS NULL THEN EXCLUDED.pinned_at
      WHEN EXCLUDED.pinned_at IS NULL THEN user_character_preferences.pinned_at
      ELSE GREATEST(user_character_preferences.pinned_at, EXCLUDED.pinned_at)
    END,
    avatar_override = COALESCE(
      user_character_preferences.avatar_override,
      EXCLUDED.avatar_override
    );

  CREATE TEMP TABLE account_instance_map ON COMMIT DROP AS
  WITH candidates AS (
    SELECT
      instance.id AS source_id,
      FIRST_VALUE(instance.id) OVER (
        PARTITION BY instance.character_id
        ORDER BY instance.updated_at DESC, instance.id DESC
      ) AS target_id
    FROM character_instances AS instance
    WHERE instance.user_id <> test_id
  )
  SELECT source_id, target_id
  FROM candidates;

  INSERT INTO relationship_states (
    instance_id, familiarity, trust, affinity, respect, reciprocity, boundary_comfort,
    unresolved_tension, bond_strength, version, as_of, updated_at
  )
  SELECT
    map.target_id, state.familiarity, state.trust, state.affinity, state.respect,
    state.reciprocity, state.boundary_comfort, state.unresolved_tension, state.bond_strength,
    state.version, state.as_of, state.updated_at
  FROM relationship_states AS state
  JOIN account_instance_map AS map ON map.source_id = state.instance_id
  WHERE map.source_id <> map.target_id
  ON CONFLICT (instance_id) DO UPDATE SET
    familiarity = EXCLUDED.familiarity,
    trust = EXCLUDED.trust,
    affinity = EXCLUDED.affinity,
    respect = EXCLUDED.respect,
    reciprocity = EXCLUDED.reciprocity,
    boundary_comfort = EXCLUDED.boundary_comfort,
    unresolved_tension = EXCLUDED.unresolved_tension,
    bond_strength = EXCLUDED.bond_strength,
    version = EXCLUDED.version,
    as_of = EXCLUDED.as_of,
    updated_at = EXCLUDED.updated_at
  WHERE EXCLUDED.updated_at >= relationship_states.updated_at;

  INSERT INTO affect_states (
    instance_id, valence, arousal, dominance, warmth, stress, energy, baseline,
    last_event_id, version, as_of, updated_at
  )
  SELECT
    map.target_id, state.valence, state.arousal, state.dominance, state.warmth,
    state.stress, state.energy, state.baseline, state.last_event_id, state.version,
    state.as_of, state.updated_at
  FROM affect_states AS state
  JOIN account_instance_map AS map ON map.source_id = state.instance_id
  WHERE map.source_id <> map.target_id
  ON CONFLICT (instance_id) DO UPDATE SET
    valence = EXCLUDED.valence,
    arousal = EXCLUDED.arousal,
    dominance = EXCLUDED.dominance,
    warmth = EXCLUDED.warmth,
    stress = EXCLUDED.stress,
    energy = EXCLUDED.energy,
    baseline = EXCLUDED.baseline,
    last_event_id = EXCLUDED.last_event_id,
    version = EXCLUDED.version,
    as_of = EXCLUDED.as_of,
    updated_at = EXCLUDED.updated_at
  WHERE EXCLUDED.updated_at >= affect_states.updated_at;

  INSERT INTO simulation_cursors (
    instance_id, local_timezone, current_activity, activity_started_at, activity_ends_at,
    last_simulated_at, next_wakeup_at, routine_seed, version, updated_at
  )
  SELECT
    map.target_id, cursor.local_timezone, cursor.current_activity, cursor.activity_started_at,
    cursor.activity_ends_at, cursor.last_simulated_at, cursor.next_wakeup_at,
    cursor.routine_seed, cursor.version, cursor.updated_at
  FROM simulation_cursors AS cursor
  JOIN account_instance_map AS map ON map.source_id = cursor.instance_id
  WHERE map.source_id <> map.target_id
  ON CONFLICT (instance_id) DO UPDATE SET
    local_timezone = EXCLUDED.local_timezone,
    current_activity = EXCLUDED.current_activity,
    activity_started_at = EXCLUDED.activity_started_at,
    activity_ends_at = EXCLUDED.activity_ends_at,
    last_simulated_at = EXCLUDED.last_simulated_at,
    next_wakeup_at = EXCLUDED.next_wakeup_at,
    routine_seed = EXCLUDED.routine_seed,
    version = EXCLUDED.version,
    updated_at = EXCLUDED.updated_at
  WHERE EXCLUDED.updated_at >= simulation_cursors.updated_at;

  UPDATE conversations AS conversation
  SET character_instance_id = map.target_id,
      updated_at = NOW()
  FROM account_instance_map AS map
  WHERE conversation.character_instance_id = map.source_id
    AND map.source_id <> map.target_id;

  UPDATE decision_records AS record
  SET instance_id = map.target_id
  FROM account_instance_map AS map
  WHERE record.instance_id = map.source_id
    AND map.source_id <> map.target_id;

  UPDATE generation_records AS record
  SET instance_id = map.target_id
  FROM account_instance_map AS map
  WHERE record.instance_id = map.source_id
    AND map.source_id <> map.target_id;

  UPDATE inference_records AS record
  SET instance_id = map.target_id
  FROM account_instance_map AS map
  WHERE record.instance_id = map.source_id
    AND map.source_id <> map.target_id;

  CREATE TEMP TABLE account_event_moves ON COMMIT DROP AS
  WITH moving_targets AS (
    SELECT DISTINCT target_id
    FROM account_instance_map
    WHERE source_id <> target_id
  ), offsets AS (
    SELECT
      target.target_id,
      COALESCE(MAX(event.sequence_no), 0) AS max_sequence
    FROM moving_targets AS target
    LEFT JOIN domain_events AS event ON event.instance_id = target.target_id
    GROUP BY target.target_id
  )
  SELECT
    event.id,
    map.target_id,
    offsets.max_sequence + ROW_NUMBER() OVER (
      PARTITION BY map.target_id
      ORDER BY event.sequence_no, event.id
    ) AS sequence_no
  FROM domain_events AS event
  JOIN account_instance_map AS map ON map.source_id = event.instance_id
  JOIN offsets ON offsets.target_id = map.target_id
  WHERE map.source_id <> map.target_id;

  UPDATE domain_events AS event
  SET instance_id = move.target_id,
      sequence_no = move.sequence_no
  FROM account_event_moves AS move
  WHERE event.id = move.id;

  DELETE FROM character_instances AS instance
  USING account_instance_map AS map
  WHERE instance.id = map.source_id
    AND map.source_id <> map.target_id;

  UPDATE character_instances AS instance
  SET user_id = yeatom_id,
      event_sequence = GREATEST(
        instance.event_sequence,
        COALESCE((
          SELECT MAX(event.sequence_no)
          FROM domain_events AS event
          WHERE event.instance_id = instance.id
        ), 0)
      ),
      updated_at = NOW()
  WHERE instance.user_id NOT IN (yeatom_id, test_id);

  DELETE FROM user_character_preferences
  WHERE user_id NOT IN (yeatom_id, test_id);

  DELETE FROM user_learning_profiles
  WHERE user_id NOT IN (yeatom_id, test_id);

  DELETE FROM users
  WHERE id NOT IN (yeatom_id, test_id);
END
$migration$;
