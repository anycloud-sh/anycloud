-- Add name column to credentials table for CLI/API-managed named credentials.
-- Nullable: existing deployment credentials (unnamed) keep name = NULL.

ALTER TABLE credentials ADD COLUMN name TEXT;
CREATE UNIQUE INDEX idx_credentials_name ON credentials(name) WHERE name IS NOT NULL;
