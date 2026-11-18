-- SPEND (RFC 0044 Records): one row per capacity-holding Deployment
-- replica, from the bind the Deployment owner first sees to the Pod's end.
-- `hourly_usd` snapshots the replica's share of its Node's VM price. Account
-- spend never reads it: whole-VM time stays on `vms`.
CREATE TABLE pool_occupancy (
  id INTEGER PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES deployments(id),
  pod_uid TEXT NOT NULL,
  vm_id INTEGER NOT NULL REFERENCES vms(id),
  node_pool_id TEXT NOT NULL REFERENCES node_pools(id),
  share REAL NOT NULL CHECK (share >= 0),
  gpus INTEGER NOT NULL CHECK (gpus >= 0),
  hourly_usd REAL,
  opened_at INTEGER NOT NULL,
  ended_at INTEGER,
  UNIQUE (deployment_id, pod_uid)
);

CREATE INDEX pool_occupancy_open ON pool_occupancy(deployment_id)
  WHERE ended_at IS NULL;
