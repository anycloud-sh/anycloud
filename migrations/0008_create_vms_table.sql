-- migrations/0008_create_vms_table.sql
-- Replace vm_ips with vms table that includes cloud_id for termination
-- This allows reading VM data from D1 instead of querying cloud providers
-- Note: Drops existing vm_ips data (historical records not needed)

DROP TABLE IF EXISTS vm_ips;

CREATE TABLE vms (
  deployment_id TEXT NOT NULL,
  ip TEXT NOT NULL,
  cloud_id TEXT NOT NULL,
  private_ip TEXT,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  preempted INTEGER DEFAULT 0,
  PRIMARY KEY (deployment_id, ip, created_at),
  FOREIGN KEY (deployment_id) REFERENCES deployments(id)
);

-- Fast lookup for active VMs
CREATE INDEX idx_vms_active ON vms(deployment_id, ended_at) WHERE ended_at IS NULL;
