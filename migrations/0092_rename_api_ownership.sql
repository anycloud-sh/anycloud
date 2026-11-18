-- Controller identity now means the API installation that owns a resource, so
-- the durable names follow it. Resources tagged before this rename keep
-- anycloud_controller and are not recognized under the new key, a population
-- that exists only in development and CI.
ALTER TABLE controller_ownership_backfill_targets RENAME TO api_ownership_backfill_targets;
DROP INDEX IF EXISTS idx_controller_ownership_backfill_pending;
CREATE INDEX IF NOT EXISTS idx_api_ownership_backfill_pending
  ON api_ownership_backfill_targets(status, attempts, updated_at, vm_id);
UPDATE _metadata SET key = 'api_identity' WHERE key = 'controller_identity';
UPDATE _metadata SET key = 'api_ownership_backfill_v1_seed' WHERE key = 'controller_ownership_backfill_v1_seed';
