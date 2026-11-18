-- Add panic signal tracking columns to vms table
-- Provides observability into the three panic detection mechanisms:
-- - sigterm: VM received SIGTERM signal (set by daemon)
-- - daemon_preempt: Daemon detected preemption via cloud metadata service (set by daemon) - renamed from preempted
-- - api_preempt: API verified preemption via cloud provider API (set by API)
--
-- NULL = signal not set/unknown (verification not attempted, or pre-feature VM)
-- 0 = explicitly false (checked and not detected)
-- 1 = explicitly true (detected/confirmed)
--
-- Also adds last_ack column to track when VM last sent ACK (for health monitoring)

-- SQLite doesn't allow changing column defaults, so we need to recreate the table
-- Save existing data

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
  sigterm INTEGER,
  daemon_preempt INTEGER,
  api_preempt INTEGER,
  last_ack INTEGER,
  PRIMARY KEY (deployment_id, ip, created_at),
  FOREIGN KEY (deployment_id) REFERENCES deployments(id)
);

-- Copy data from old table, converting old preempted column to daemon_preempt
INSERT INTO vms_new (deployment_id, ip, cloud_id, private_ip, created_at, ended_at, daemon_preempt)
SELECT deployment_id, ip, cloud_id, private_ip, created_at, ended_at,
       CASE WHEN preempted = 1 THEN 1 ELSE NULL END
FROM vms;

-- Drop old table
DROP TABLE vms;

-- Rename new table
ALTER TABLE vms_new RENAME TO vms;

-- Recreate indices
CREATE INDEX idx_vms_active ON vms(deployment_id, ended_at) WHERE ended_at IS NULL;

PRAGMA foreign_keys = ON;
