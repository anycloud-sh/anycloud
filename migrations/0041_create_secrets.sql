CREATE TABLE secrets (
  name TEXT PRIMARY KEY,
  encrypted_values TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

ALTER TABLE deployments ADD COLUMN secret_names TEXT;
