-- Persist explicit checkpoint storage credentials and region so spot retries
-- and preemption recovery can recreate checkpoint storage on providers with
-- no native storage identity.
ALTER TABLE deployments ADD COLUMN checkpoint_storage_credential_id TEXT REFERENCES credentials(id) ON DELETE RESTRICT;
ALTER TABLE deployments ADD COLUMN checkpoint_storage_region TEXT;
