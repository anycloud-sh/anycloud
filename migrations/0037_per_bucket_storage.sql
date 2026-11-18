-- Per-bucket storage credentials: allow input and output buckets on different clouds.
-- Rename shared storage columns to input-specific (preserves existing data).
ALTER TABLE deployments RENAME COLUMN storage_credential_id TO input_storage_credential_id;
ALTER TABLE deployments RENAME COLUMN storage_region TO input_storage_region;

-- Add output-specific columns.
ALTER TABLE deployments ADD COLUMN output_storage_credential_id TEXT;
ALTER TABLE deployments ADD COLUMN output_storage_region TEXT;

-- Backfill: existing deployments used the same credential for both buckets.
UPDATE deployments SET output_storage_credential_id = input_storage_credential_id;
UPDATE deployments SET output_storage_region = input_storage_region;
