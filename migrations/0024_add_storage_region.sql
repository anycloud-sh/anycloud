-- Add storage_region column for cross-cloud storage support.
-- Required when storage_credential_id is set (storage in a different cloud/region than compute).
ALTER TABLE deployments ADD COLUMN storage_region TEXT;
