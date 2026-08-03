-- Character-version definitions were never read at runtime. Keep one lightweight
-- registry row for each live template version because character_instances has a
-- composite foreign key to it, but do not retain obsolete persona snapshots.

INSERT INTO character_versions (id, character_id, version, created_at)
SELECT c.id || ':v' || c.current_version, c.id, c.current_version, c.updated_at
FROM characters c
ON CONFLICT (character_id, version) DO NOTHING;

UPDATE character_instances instance
SET template_version = character.current_version,
    updated_at = NOW()
FROM characters character
WHERE instance.character_id = character.id
  AND instance.template_version IS DISTINCT FROM character.current_version;

DELETE FROM character_versions version
USING characters character
WHERE version.character_id = character.id
  AND version.version <> character.current_version;

ALTER TABLE character_versions
  DROP COLUMN IF EXISTS definition;
