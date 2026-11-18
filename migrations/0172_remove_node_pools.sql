-- Phase 2b removes node pools. The runner refuses to apply this while one is
-- still live (repositories/removed-workloads-guard.ts), so every pool VM has
-- ended: their ledger rows go with the pools. `vms` is rebuilt without the
-- node pool owner and the Node remediation breaker; its children reference
-- it by name and are not touched. Foreign keys are off for this file and
-- `foreign_key_check` gates the commit.

DROP TRIGGER clusters_destroy_requires_no_node_pools;
DROP TABLE node_pools;

DELETE FROM api_ownership_backfill_targets WHERE vm_id IN (
  SELECT id FROM vms WHERE node_pool_id IS NOT NULL
);
DELETE FROM vms WHERE node_pool_id IS NOT NULL;

CREATE TABLE vms_new (
  id INTEGER PRIMARY KEY,
  workload_id TEXT,
  cluster_id TEXT,
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
  launch_diagnosis TEXT,
  launch_region_denied TEXT
    CHECK (launch_region_denied IS NULL OR launch_diagnosis IS NOT NULL),
  CHECK ((workload_id IS NOT NULL) + (cluster_id IS NOT NULL) = 1),
  FOREIGN KEY (workload_id) REFERENCES workloads(id) ON DELETE CASCADE,
  FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE RESTRICT
);
INSERT INTO vms_new (
  id, workload_id, cluster_id, ip, cloud_id, private_ip, created_at, ended_at,
  preempt, base_image_id, region, availability_zone, credential_id,
  price_per_hour, cost, ssh_host, ssh_port, ssh_username, vm_type,
  input_host_path, output_host_path, checkpoint_host_path,
  removal_requested_at, launch_diagnosis, launch_region_denied
)
SELECT
  id, workload_id, cluster_id, ip, cloud_id, private_ip, created_at, ended_at,
  preempt, base_image_id, region, availability_zone, credential_id,
  price_per_hour, cost, ssh_host, ssh_port, ssh_username, vm_type,
  input_host_path, output_host_path, checkpoint_host_path,
  removal_requested_at, launch_diagnosis, launch_region_denied
FROM vms;
DROP TABLE vms;
ALTER TABLE vms_new RENAME TO vms;

CREATE INDEX idx_vms_active
  ON vms(workload_id, ip, price_per_hour)
  WHERE ended_at IS NULL;
CREATE INDEX idx_vms_cloud_id ON vms(cloud_id);
CREATE INDEX idx_vms_credential ON vms(credential_id);
CREATE INDEX idx_vms_needing_cost
  ON vms(ended_at, workload_id, credential_id, cloud_id)
  WHERE cost IS NULL
    AND ended_at IS NOT NULL;
-- billing.ts names these expressions; keep them identical.
CREATE INDEX idx_vms_pending_cost_group ON vms (
  CASE WHEN workload_id IS NOT NULL THEN 'anycloud_deployment' ELSE 'anycloud_resource' END,
  COALESCE(cluster_id, workload_id),
  (credential_id IS NOT NULL),
  COALESCE(credential_id, ''),
  ended_at
)
WHERE cost IS NULL
  AND ended_at IS NOT NULL
  AND (workload_id IS NOT NULL OR cluster_id IS NOT NULL);
CREATE INDEX idx_vms_release_overdue
  ON vms(removal_requested_at, workload_id, id)
  WHERE workload_id IS NOT NULL
    AND ended_at IS NULL
    AND removal_requested_at IS NOT NULL;
CREATE INDEX idx_vms_cluster_active
  ON vms(cluster_id, removal_requested_at, created_at)
  WHERE cluster_id IS NOT NULL AND ended_at IS NULL;
CREATE UNIQUE INDEX idx_vms_cluster_attempt
  ON vms(cluster_id, cloud_id, created_at)
  WHERE cluster_id IS NOT NULL;
CREATE INDEX idx_vms_spend_window
  ON vms(ended_at, created_at, workload_id)
  WHERE ip IS NOT NULL;
CREATE UNIQUE INDEX idx_vms_workload_attempt
  ON vms(workload_id, cloud_id, created_at)
  WHERE workload_id IS NOT NULL;
CREATE INDEX idx_vms_workload_id ON vms(workload_id);
