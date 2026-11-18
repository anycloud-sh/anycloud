-- Named Secrets a Deployment record references, as a JSON array of
-- names; values stay in `secrets` and are resolved at reconcile.
ALTER TABLE deployments ADD COLUMN secret_names TEXT
  CHECK (secret_names IS NULL OR (json_valid(secret_names) AND json_type(secret_names) = 'array'));
