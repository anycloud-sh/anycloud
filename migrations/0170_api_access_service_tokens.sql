-- An owner-issued service token: a `service:<name>` member admitted by the
-- SHA-256 of its token alone. The token itself is printed once, never stored.
ALTER TABLE api_access_users ADD COLUMN token_hash TEXT;
CREATE UNIQUE INDEX api_access_users_token_hash
  ON api_access_users (token_hash) WHERE token_hash IS NOT NULL;
