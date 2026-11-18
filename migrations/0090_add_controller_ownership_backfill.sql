-- Exact, database-known legacy VMs are snapshotted into this table on the
-- first controller-aware boot. New resources carry controller metadata when
-- they are created and therefore never need to enter this queue.
CREATE TABLE controller_ownership_backfill_targets (
  vm_id INTEGER PRIMARY KEY REFERENCES vms(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'retry', 'completed', 'missing', 'unsupported', 'conflict')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_controller_ownership_backfill_pending
  ON controller_ownership_backfill_targets(status, attempts, updated_at, vm_id);
