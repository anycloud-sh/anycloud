-- migrations/0013_add_ssh_keys.sql
-- Add SSH private key column to deployments table
-- SSH private keys are encrypted using AES-256-GCM (same as cloud credentials)

ALTER TABLE deployments ADD COLUMN ssh_private_key TEXT NOT NULL DEFAULT '';

-- Existing deployments will get empty string
-- New deployments will always provide an encrypted value
