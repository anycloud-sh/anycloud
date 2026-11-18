-- A hosted API's own bearer: one opaque token per admitted GitHub account.
-- The token is looked up by its SHA-256 and kept encrypted so the
-- exchange can return it again; the account's GitHub sign-in is kept
-- encrypted for GHCR pulls, Service hostnames and clusters.
CREATE TABLE api_tokens (
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_ciphertext TEXT NOT NULL,
  github_ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
