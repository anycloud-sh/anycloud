-- A spot node pool: every VM it launches is a spot VM, deleted on
-- eviction. Existing pools stay on-demand.
ALTER TABLE node_pools ADD COLUMN spot INTEGER NOT NULL DEFAULT 0
  CHECK (spot IN (0, 1));
