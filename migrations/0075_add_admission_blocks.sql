-- Persisted admission blocks: durable, SQL-visible record of observed
-- quota/capacity exhaustion, scoped per credential. Account-scope rows use ''
-- for vm_type and region so the composite key stays unique. opens_at is the
-- epoch-ms time the block self-expires. Written alongside the in-process
-- admission gates so the block state survives restarts and can be inspected
-- directly on a customer API host
CREATE TABLE admission_blocks (
  cloud TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  spot INTEGER NOT NULL,
  vm_type TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  opens_at INTEGER NOT NULL,
  PRIMARY KEY (cloud, credential_id, spot, vm_type, region)
);

CREATE INDEX idx_admission_blocks_credential
  ON admission_blocks (credential_id, spot, opens_at);
