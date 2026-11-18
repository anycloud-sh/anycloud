-- Remove daemon-related columns and rename api_preempt to preempt
-- Removed columns (daemon-only):
-- - sigterm: VM received SIGTERM signal (reported by daemon)
-- - daemon_preempt: Daemon detected preemption via cloud metadata service
-- - last_ack: Timestamp of last daemon heartbeat
-- Renamed column:
-- - api_preempt → preempt: API-detected preemption via cloud provider API

-- SQLite doesn't support DROP COLUMN directly, so we recreate the table

-- PRAGMA toggle added retroactively (see 0042) for consistency with the
-- table-rebuild pattern. Already-applied on existing DBs so it is a no-op
-- there, and matters only for fresh installs that re-run all migrations.
PRAGMA foreign_keys = OFF;

CREATE TABLE vms_new (
  deployment_id TEXT NOT NULL,
  ip TEXT NOT NULL,
  cloud_id TEXT NOT NULL,
  private_ip TEXT,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  preempt INTEGER,
  PRIMARY KEY (deployment_id, ip, created_at),
  FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
);

-- Copy data from old table (rename api_preempt to preempt, drop daemon columns)
INSERT INTO vms_new (deployment_id, ip, cloud_id, private_ip, created_at, ended_at, preempt)
SELECT deployment_id, ip, cloud_id, private_ip, created_at, ended_at, api_preempt FROM vms;

-- Replace old table with new
DROP TABLE vms;
ALTER TABLE vms_new RENAME TO vms;

-- Recreate index
CREATE INDEX idx_vms_deployment_id ON vms(deployment_id);

PRAGMA foreign_keys = ON;
