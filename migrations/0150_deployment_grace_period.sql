-- GRACE: a replica's shutdown grace on eviction, Node loss, scale-in
-- or delete, rendered as its Pod's terminationGracePeriodSeconds. Managed
-- Deployments get AWS's spot notice, so their runner can run the final upload.
ALTER TABLE deployments ADD COLUMN grace_period_seconds INTEGER NOT NULL DEFAULT 30
  CHECK (grace_period_seconds BETWEEN 0 AND 3600);
UPDATE deployments SET grace_period_seconds = 120 WHERE managed = 1;
