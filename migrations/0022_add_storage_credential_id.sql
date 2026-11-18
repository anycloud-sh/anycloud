-- Add storage_credential_id column for cross-cloud storage support.
-- NULL means use the compute credential (backward compatible).
ALTER TABLE deployments ADD COLUMN storage_credential_id TEXT;
