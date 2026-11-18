-- Explicit checkpoint buckets are independent of spot. NULL preserves the
-- existing implicit deployment-ID checkpoint for spot deployments.
ALTER TABLE deployments ADD COLUMN checkpoint_bucket TEXT;
