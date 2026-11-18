-- Preserve the retention intent of existing spot deployments using the
-- explicit, user-owned checkpoint bucket contract, then remove the obsolete
-- per-deployment flag.
UPDATE deployments
SET checkpoint_bucket = id
WHERE persist_bucket = 1
  AND spot = 1
  AND checkpoint_bucket IS NULL;

ALTER TABLE deployments DROP COLUMN persist_bucket;
