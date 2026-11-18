-- RA: a Deployment's replica count moves between min_replicas and
-- max_replicas on its queued plus held Jobs; `--replicas N` sets both to N.
-- Managed Deployments start from 0, so only user admission keeps min >= 1.
ALTER TABLE deployments ADD COLUMN min_replicas INTEGER NOT NULL DEFAULT 1
  CHECK (min_replicas >= 0);
ALTER TABLE deployments ADD COLUMN max_replicas INTEGER NOT NULL DEFAULT 1
  CHECK (max_replicas >= 1);
UPDATE deployments SET min_replicas = replicas, max_replicas = replicas;
ALTER TABLE deployments DROP COLUMN replicas;
