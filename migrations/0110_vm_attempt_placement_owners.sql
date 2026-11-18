-- Give VM attempts a third exclusive owner: a placement (its VMs). Every row
-- keeps exactly one of workload, cluster or placement; existing rows are copied
-- unchanged with their immutable ids. The root's management VM is owned by the
-- installation record, not by the root itself. The owner CHECK cannot be
-- widened in place, so the table is rebuilt. Foreign keys stay enforced throughout: the backfill
-- queue that references vms(id) ON DELETE CASCADE is rebuilt against the new
-- table first, so dropping the old table cascades into nothing.

CREATE TABLE vms_new (
  id INTEGER PRIMARY KEY,
  workload_id TEXT,
  cluster_id TEXT,
  placement_id TEXT,
  ip TEXT,
  cloud_id TEXT NOT NULL,
  private_ip TEXT,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  preempt INTEGER,
  base_image_id TEXT,
  region TEXT,
  availability_zone TEXT,
  credential_id TEXT REFERENCES credentials(id) ON DELETE RESTRICT,
  price_per_hour REAL,
  cost REAL,
  ssh_host TEXT,
  ssh_port INTEGER,
  ssh_username TEXT,
  vm_type TEXT,
  input_host_path TEXT,
  output_host_path TEXT,
  checkpoint_host_path TEXT,
  removal_requested_at INTEGER,
  CHECK (
    (workload_id IS NOT NULL) + (cluster_id IS NOT NULL)
      + (placement_id IS NOT NULL) = 1
  ),
  FOREIGN KEY (workload_id) REFERENCES workloads(id) ON DELETE CASCADE,
  FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE RESTRICT,
  FOREIGN KEY (placement_id) REFERENCES placements(id) ON DELETE RESTRICT
);

INSERT INTO vms_new (
  id, workload_id, cluster_id, ip, cloud_id, private_ip, created_at, ended_at,
  preempt, base_image_id, region, availability_zone, credential_id,
  price_per_hour, cost, ssh_host, ssh_port, ssh_username, vm_type,
  input_host_path, output_host_path, checkpoint_host_path, removal_requested_at
)
SELECT
  id, workload_id, cluster_id, ip, cloud_id, private_ip, created_at, ended_at,
  preempt, base_image_id, region, availability_zone, credential_id,
  price_per_hour, cost, ssh_host, ssh_port, ssh_username, vm_type,
  input_host_path, output_host_path, checkpoint_host_path, removal_requested_at
FROM vms
ORDER BY id;

CREATE TABLE api_ownership_backfill_targets_new (
  vm_id INTEGER PRIMARY KEY REFERENCES vms_new(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'retry', 'completed', 'missing', 'unsupported', 'conflict')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

INSERT INTO api_ownership_backfill_targets_new (
  vm_id, status, attempts, last_error, updated_at
)
SELECT vm_id, status, attempts, last_error, updated_at
FROM api_ownership_backfill_targets
ORDER BY vm_id;

DROP INDEX idx_api_ownership_backfill_pending;
DROP TABLE api_ownership_backfill_targets;
DROP TABLE vms;

-- RENAME rewrites the backfill queue's foreign key to follow the table.
ALTER TABLE vms_new RENAME TO vms;
ALTER TABLE api_ownership_backfill_targets_new RENAME TO api_ownership_backfill_targets;

CREATE INDEX idx_api_ownership_backfill_pending
  ON api_ownership_backfill_targets(status, attempts, updated_at, vm_id);

-- Every index dropped with the old table, plus the new owner.
CREATE UNIQUE INDEX idx_vms_workload_attempt
  ON vms(workload_id, cloud_id, created_at)
  WHERE workload_id IS NOT NULL;
CREATE UNIQUE INDEX idx_vms_cluster_attempt
  ON vms(cluster_id, cloud_id, created_at)
  WHERE cluster_id IS NOT NULL;
CREATE UNIQUE INDEX idx_vms_placement_attempt
  ON vms(placement_id, cloud_id, created_at)
  WHERE placement_id IS NOT NULL;
CREATE INDEX idx_vms_workload_id ON vms(workload_id);
CREATE INDEX idx_vms_credential ON vms(credential_id);
CREATE INDEX idx_vms_active
  ON vms(workload_id, ip, price_per_hour)
  WHERE ended_at IS NULL;
CREATE INDEX idx_vms_spend_window
  ON vms(ended_at, created_at, workload_id)
  WHERE ip IS NOT NULL;
CREATE INDEX idx_vms_needing_cost
  ON vms(ended_at, workload_id, credential_id, cloud_id)
  WHERE cost IS NULL
    AND ended_at IS NOT NULL;
CREATE INDEX idx_vms_cloud_id ON vms(cloud_id);
CREATE INDEX idx_vms_cluster_active
  ON vms(cluster_id, removal_requested_at, created_at)
  WHERE cluster_id IS NOT NULL AND ended_at IS NULL;
CREATE INDEX idx_vms_placement_active
  ON vms(placement_id, removal_requested_at, created_at)
  WHERE placement_id IS NOT NULL AND ended_at IS NULL;
CREATE INDEX idx_vms_release_overdue
  ON vms(removal_requested_at, workload_id, id)
  WHERE workload_id IS NOT NULL
    AND ended_at IS NULL
    AND removal_requested_at IS NOT NULL;

-- Cost settlement groups ended attempts by provider tag and owning resource.
-- Placement attempts carry the resource-scope tag like Cluster capacity; only
-- Workload VMs carry the deployment tag.
CREATE INDEX idx_vms_pending_cost_group ON vms (
  CASE WHEN workload_id IS NOT NULL THEN 'anycloud_deployment' ELSE 'anycloud_resource' END,
  COALESCE(cluster_id, placement_id, workload_id),
  (credential_id IS NOT NULL),
  COALESCE(credential_id, ''),
  ended_at
)
WHERE cost IS NULL
  AND ended_at IS NOT NULL
  AND (workload_id IS NOT NULL OR cluster_id IS NOT NULL OR placement_id IS NOT NULL);

-- The placement controller records its latest reconciliation failure and the
-- durable counters that bound provider retries and never-joined replacements.
ALTER TABLE placements ADD COLUMN last_error TEXT;
ALTER TABLE placements ADD COLUMN provisioning_failures INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(provisioning_failures) = 'integer' AND provisioning_failures >= 0);
ALTER TABLE placements ADD COLUMN provisioning_failed_at INTEGER;
ALTER TABLE placements ADD COLUMN join_replacements INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(join_replacements) = 'integer' AND join_replacements >= 0);
ALTER TABLE placements ADD COLUMN join_replaced_at INTEGER;
