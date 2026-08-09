INSERT INTO users (
  id, display_name, username, password_hash, learning_goals, preferences,
  consent_flags, created_at, updated_at
) VALUES (
  'account-junling',
  'junling',
  'junling',
  'scrypt$bc90d86ea470461c141b4c92ef0b1a37$bbd98f393ff5b8723c87ffedba4020b406c52617eeff6038d68163cd9d3534922964622522dd9a08b5832f0107d603d880b541c67416f2396df37f2ede6e5cfd',
  '{}'::jsonb,
  '{}'::jsonb,
  '{"memoryPersonalization": true}'::jsonb,
  NOW(),
  NOW()
)
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  username = EXCLUDED.username,
  password_hash = EXCLUDED.password_hash,
  updated_at = NOW();
