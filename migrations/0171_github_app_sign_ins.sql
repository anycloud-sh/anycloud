-- A GitHub App's user token is exchanged but never kept: its account's row
-- holds no GitHub sign-in, so `github_ciphertext` becomes nullable. `api_tokens`
-- has no foreign keys, so it is rebuilt in place.
CREATE TABLE api_tokens_new (
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_ciphertext TEXT NOT NULL,
  github_ciphertext TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
INSERT INTO api_tokens_new SELECT
  user_id, username, token_hash, token_ciphertext, github_ciphertext,
  created_at, last_used_at
FROM api_tokens;
DROP TABLE api_tokens;
ALTER TABLE api_tokens_new RENAME TO api_tokens;

-- The GitHub Apps whose user tokens the exchange accepts, as a JSON array of
-- App ids that the API's startup writes from its release values.
ALTER TABLE api_access_policy ADD COLUMN github_app_ids TEXT NOT NULL DEFAULT '[]';
