-- migrations/0002_create_vm_ips.sql
-- VM IP tracking for fast status lookups (replaces DNS API calls)
-- Soft delete with ended_at for preemption/replacement history

CREATE TABLE vm_ips (
  deployment_id TEXT NOT NULL,
  ip TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,  -- NULL = active, timestamp = terminated
  PRIMARY KEY (deployment_id, ip, created_at),
  FOREIGN KEY (deployment_id) REFERENCES deployments(id)
);

-- Fast lookup for active VMs
CREATE INDEX idx_vm_ips_active ON vm_ips(deployment_id, ended_at) WHERE ended_at IS NULL;
