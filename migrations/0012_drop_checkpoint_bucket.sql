-- Drop checkpoint_bucket column - checkpoint is deployment ID for spot instances
-- Migration: 0012_drop_checkpoint_bucket.sql

-- Checkpoint bucket = deployment ID (only for spot instances), so storing it separately is redundant
ALTER TABLE deployments DROP COLUMN checkpoint_bucket;
