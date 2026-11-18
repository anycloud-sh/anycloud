-- Split single bucket_name into three separate buckets
-- Migration: 0011_split_buckets.sql

-- Add three new bucket columns
ALTER TABLE deployments ADD COLUMN input_bucket TEXT DEFAULT NULL;
ALTER TABLE deployments ADD COLUMN output_bucket TEXT DEFAULT NULL;
ALTER TABLE deployments ADD COLUMN checkpoint_bucket TEXT DEFAULT NULL;

-- Drop old column (breaking change - existing deployments lose bucket config)
-- Users must redeploy with new 3-bucket configuration
ALTER TABLE deployments DROP COLUMN bucket_name;
