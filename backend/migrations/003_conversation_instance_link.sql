ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS character_instance_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_character_instance_fk'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_character_instance_fk
      FOREIGN KEY (character_instance_id)
      REFERENCES character_instances(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS conversations_instance_index
  ON conversations (character_instance_id, last_message_at DESC NULLS LAST);

UPDATE conversations c
SET character_instance_id = ci.id
FROM character_instances ci
WHERE c.character_instance_id IS NULL
  AND c.user_id = ci.user_id
  AND c.character_id = ci.character_id;
