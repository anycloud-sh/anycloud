-- Make ip nullable and change PK to (deployment_id, cloud_id, created_at).
-- Failed provisioning attempts are recorded with ip=NULL so countAllVMs
-- increments startIndex on retry (avoids Azure 409 collisions).
-- cloud_id + created_at disambiguates VM restarts (same cloud_id, new row).

-- PRAGMA toggle added retroactively (see 0042) for consistency with the
-- table-rebuild pattern. Already-applied on existing DBs so it is a no-op
-- there, and matters only for fresh installs that re-run all migrations.
PRAGMA foreign_keys = OFF;

CREATE TABLE vms_new (
  deployment_id TEXT NOT NULL,
  ip TEXT,
  cloud_id TEXT NOT NULL,
  private_ip TEXT,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  preempt INTEGER,
  PRIMARY KEY (deployment_id, cloud_id, created_at),
  FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
);

INSERT INTO vms_new (deployment_id, ip, cloud_id, private_ip, created_at, ended_at, preempt)
SELECT deployment_id, ip, cloud_id, private_ip, created_at, ended_at, preempt FROM vms;

DROP TABLE vms;
ALTER TABLE vms_new RENAME TO vms;

CREATE INDEX idx_vms_deployment_id ON vms(deployment_id);

PRAGMA foreign_keys = ON;
