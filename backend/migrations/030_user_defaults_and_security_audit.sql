CREATE TABLE IF NOT EXISTS security_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  ip_address TEXT,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  username_fingerprint TEXT,
  request_id TEXT,
  method TEXT,
  path TEXT,
  user_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS security_events_recent_index
  ON security_events (created_at DESC, event_type);

CREATE INDEX IF NOT EXISTS security_events_ip_recent_index
  ON security_events (ip_address, created_at DESC)
  WHERE ip_address IS NOT NULL;

CREATE OR REPLACE FUNCTION provision_user_avatar_defaults()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  source_avatar TEXT;
BEGIN
  IF NEW.id = 'account-yeatom' THEN
    RETURN NEW;
  END IF;

  SELECT preferences ->> 'avatar'
  INTO source_avatar
  FROM public.users
  WHERE id = 'account-yeatom';

  IF COALESCE(source_avatar, '') <> '' THEN
    UPDATE public.users
    SET preferences = jsonb_set(
      COALESCE(preferences, '{}'::jsonb),
      '{avatar}',
      to_jsonb(source_avatar),
      TRUE
    )
    WHERE id = NEW.id;
  END IF;

  INSERT INTO public.user_character_preferences (
    user_id, character_id, pinned_at, avatar_override
  )
  SELECT NEW.id, source.character_id, NULL, source.avatar_override
  FROM public.user_character_preferences source
  JOIN public.characters character ON character.id = source.character_id
  WHERE source.user_id = 'account-yeatom'
    AND source.avatar_override IS NOT NULL
    AND character.owner_user_id IS NULL
  ON CONFLICT (user_id, character_id) DO UPDATE SET
    avatar_override = EXCLUDED.avatar_override;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS users_provision_avatar_defaults ON users;
CREATE TRIGGER users_provision_avatar_defaults
AFTER INSERT ON users
FOR EACH ROW
EXECUTE FUNCTION provision_user_avatar_defaults();

UPDATE users AS target
SET preferences = jsonb_set(
  COALESCE(target.preferences, '{}'::jsonb),
  '{avatar}',
  to_jsonb(source.preferences ->> 'avatar'),
  TRUE
)
FROM users AS source
WHERE target.id = 'account-test'
  AND source.id = 'account-yeatom'
  AND COALESCE(source.preferences ->> 'avatar', '') <> '';

INSERT INTO user_character_preferences (
  user_id, character_id, pinned_at, avatar_override
)
SELECT 'account-test', source.character_id, NULL, source.avatar_override
FROM user_character_preferences source
JOIN characters character ON character.id = source.character_id
WHERE source.user_id = 'account-yeatom'
  AND source.avatar_override IS NOT NULL
  AND character.owner_user_id IS NULL
ON CONFLICT (user_id, character_id) DO UPDATE SET
  avatar_override = EXCLUDED.avatar_override;

CREATE OR REPLACE FUNCTION enforce_public_test_character_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  owner_username TEXT;
  custom_character_count INTEGER;
BEGIN
  IF NEW.owner_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT username
  INTO owner_username
  FROM public.users
  WHERE id = NEW.owner_user_id
  FOR UPDATE;

  IF LOWER(COALESCE(owner_username, '')) <> 'test' THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*)::int
  INTO custom_character_count
  FROM public.characters
  WHERE owner_user_id = NEW.owner_user_id;

  IF custom_character_count >= 3 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'test_account_custom_character_limit';
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS characters_enforce_public_test_limit ON characters;
CREATE TRIGGER characters_enforce_public_test_limit
BEFORE INSERT ON characters
FOR EACH ROW
EXECUTE FUNCTION enforce_public_test_character_limit();

DELETE FROM users WHERE LOWER(username) = 'junling';

