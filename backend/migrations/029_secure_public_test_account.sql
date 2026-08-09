INSERT INTO users (
  id, display_name, username, password_hash, learning_goals, preferences,
  consent_flags, created_at, updated_at
) VALUES (
  'account-test',
  'test',
  'test',
  'scrypt$2b702ea9b46458ee104d17d7244213a4$e8392b77370078f7116e64c1bf4fca7d544b29acf5130c7a234f7efd7b1ecf963178643b334d323610c83d3504fd286800a1699049f42dd09c461de6c7a2df32',
  '{}'::jsonb,
  '{}'::jsonb,
  '{"memoryPersonalization": false}'::jsonb,
  NOW(),
  NOW()
)
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  username = EXCLUDED.username,
  password_hash = EXCLUDED.password_hash,
  consent_flags = EXCLUDED.consent_flags,
  updated_at = NOW();

CREATE TABLE IF NOT EXISTS test_account_reply_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS test_account_reply_usage_window_index
  ON test_account_reply_usage (user_id, created_at DESC);

WITH ranked_messages AS (
  SELECT
    m.id,
    ROW_NUMBER() OVER (
      PARTITION BY c.character_id
      ORDER BY m.created_at DESC, m.id DESC
    ) AS position
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  WHERE c.user_id = 'account-test'
)
DELETE FROM messages
WHERE id IN (
  SELECT id FROM ranked_messages WHERE position > 50
);

CREATE OR REPLACE FUNCTION prune_public_test_messages()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.conversations c
    JOIN public.users u ON u.id = c.user_id
    WHERE c.id = NEW.conversation_id
      AND LOWER(u.username) = 'test'
  ) THEN
    DELETE FROM public.messages m
    USING public.conversations c
    WHERE m.conversation_id = c.id
      AND c.user_id = 'account-test'
      AND c.character_id = (
        SELECT character_id
        FROM public.conversations
        WHERE id = NEW.conversation_id
      )
      AND m.id IN (
        SELECT old_message.id
        FROM public.messages old_message
        JOIN public.conversations old_conversation
          ON old_conversation.id = old_message.conversation_id
        WHERE old_conversation.user_id = 'account-test'
          AND old_conversation.character_id = (
            SELECT character_id
            FROM public.conversations
            WHERE id = NEW.conversation_id
          )
        ORDER BY old_message.created_at DESC, old_message.id DESC
        OFFSET 50
      );
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS messages_prune_public_test_account ON messages;
CREATE TRIGGER messages_prune_public_test_account
AFTER INSERT ON messages
FOR EACH ROW
EXECUTE FUNCTION prune_public_test_messages();

DELETE FROM memories WHERE user_id = 'account-test';
UPDATE character_instances
SET next_action_at = NULL, updated_at = NOW()
WHERE user_id = 'account-test';
