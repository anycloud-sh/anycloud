-- migrations/0014_create_credentials_table.sql
-- Create credentials table with deduplication via hash-based ID

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,                    -- SHA-256 hash of encrypted_data
  encrypted_data TEXT NOT NULL,           -- authTag:iv:encryptedData (AES-256-GCM)
  cloud_provider TEXT NOT NULL,           -- 'AWS' | 'GCP' | 'Azure'
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Unique constraint on ID (implicit with PRIMARY KEY)
CREATE UNIQUE INDEX idx_credentials_id ON credentials(id);

-- Index for cleanup queries (find unused credentials)
CREATE INDEX idx_credentials_last_used ON credentials(last_used_at);

-- Add foreign key to deployments table
ALTER TABLE deployments ADD COLUMN credential_id TEXT NOT NULL DEFAULT '';

-- Index for joining deployments to credentials
CREATE INDEX idx_deployments_credential ON deployments(credential_id);
