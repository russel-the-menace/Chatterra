UPDATE auth_sessions
SET expires_at = 'infinity'
WHERE expires_at IS DISTINCT FROM 'infinity'::timestamptz;
