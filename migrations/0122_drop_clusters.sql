-- Independent Clusters leave the product. This file removes every Cluster,
-- its capacity rows and VM attempts, every Deployment on a Cluster and the
-- Jobs those Deployments ran.
--
-- `deployments` and `vms` lose their Cluster column and are rebuilt; rows keep
-- their ids. `workloads`, `container_specs` and `api_ownership_backfill_targets`
-- reference the rebuilt tables, so the runner applies this file with foreign
-- keys off and audits `foreign_key_check` before committing.

-- Job history of Deployments that ran on Clusters, children first. Foreign
-- keys are off, so nothing cascades on its own.
DELETE FROM workload_events WHERE workload_id IN (
  SELECT w.id FROM workloads w
  JOIN deployments d ON d.id = w.deployment_id
  WHERE d.cluster_id IS NOT NULL
);
DELETE FROM api_ownership_backfill_targets WHERE vm_id IN (
  SELECT v.id FROM vms v
  WHERE v.cluster_id IS NOT NULL
     OR v.workload_id IN (
       SELECT w.id FROM workloads w
       JOIN deployments d ON d.id = w.deployment_id
       WHERE d.cluster_id IS NOT NULL
     )
);
DELETE FROM vms WHERE workload_id IN (
  SELECT w.id FROM workloads w
  JOIN deployments d ON d.id = w.deployment_id
  WHERE d.cluster_id IS NOT NULL
);
DELETE FROM workloads WHERE deployment_id IN (
  SELECT id FROM deployments WHERE cluster_id IS NOT NULL
);
-- `container_specs_no_detach` allows the delete once the owner row is gone.
DELETE FROM container_specs
WHERE workload_id IS NOT NULL
  AND workload_id NOT IN (SELECT id FROM workloads);

-- Deployment records target node pools only.
CREATE TABLE deployments_new (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL CHECK (length(trim(owner_user_id)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  node_pool_id TEXT NOT NULL REFERENCES node_pools(id) ON DELETE RESTRICT,
  gpu_count INTEGER NOT NULL CHECK (
    typeof(gpu_count) = 'integer' AND gpu_count BETWEEN 0 AND 9007199254740991
  ),
  max_concurrent_jobs_per_replica INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(max_concurrent_jobs_per_replica) = 'integer'
    AND max_concurrent_jobs_per_replica BETWEEN 1 AND 9007199254740991
  ),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(generation) = 'integer' AND generation BETWEEN 1 AND 9007199254740991
  ),
  deletion_requested_at INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  readiness_probe TEXT
    CHECK (readiness_probe IS NULL OR (json_valid(readiness_probe) AND json_type(readiness_probe) = 'object')),
  CHECK (deletion_requested_at IS NULL OR deletion_requested_at >= created_at),
  CHECK (deleted_at IS NULL OR (
    deletion_requested_at IS NOT NULL AND deleted_at >= deletion_requested_at
  ))
);

INSERT INTO deployments_new (
  id, owner_user_id, name, node_pool_id, gpu_count,
  max_concurrent_jobs_per_replica, generation, deletion_requested_at,
  deleted_at, created_at, updated_at, readiness_probe
)
SELECT
  id, owner_user_id, name, node_pool_id, gpu_count,
  max_concurrent_jobs_per_replica, generation, deletion_requested_at,
  deleted_at, created_at, updated_at, readiness_probe
FROM deployments
WHERE node_pool_id IS NOT NULL
ORDER BY rowid;

DROP TRIGGER deployments_insert_collision;
DROP TRIGGER deployments_identity_immutable;
-- The only trigger on another table that names deployments; recreated below
-- so the schema stays parseable while the table is renamed.
DROP TRIGGER container_specs_no_detach;
DROP INDEX idx_deployments_active_name;
DROP INDEX idx_deployments_cluster;
DROP INDEX idx_deployments_node_pool;
DROP TABLE deployments;
ALTER TABLE deployments_new RENAME TO deployments;

-- Container specs of the Cluster Deployments that were not copied.
DELETE FROM container_specs
WHERE deployment_id IS NOT NULL
  AND deployment_id NOT IN (SELECT id FROM deployments);

CREATE TRIGGER container_specs_no_detach BEFORE DELETE ON container_specs
WHEN EXISTS (SELECT 1 FROM workloads WHERE id = OLD.workload_id)
  OR EXISTS (SELECT 1 FROM deployments WHERE id = OLD.deployment_id)
BEGIN
  SELECT RAISE(ABORT, 'container spec owner remains');
END;

CREATE UNIQUE INDEX idx_deployments_active_name ON deployments(lower(name))
  WHERE deleted_at IS NULL;
-- Node pool admission sums live GPU reservations per node pool.
CREATE INDEX idx_deployments_node_pool
  ON deployments(node_pool_id, deleted_at, gpu_count, created_at);

CREATE TRIGGER deployments_insert_collision BEFORE INSERT ON deployments
WHEN EXISTS (SELECT 1 FROM deployments d WHERE d.rowid = NEW.rowid OR d.id = NEW.id
  OR (NEW.deleted_at IS NULL AND d.deleted_at IS NULL
    AND lower(d.name) = lower(NEW.name)))
BEGIN
  SELECT RAISE(ABORT, 'Deployment identity already exists');
END;

-- The target is immutable: a Deployment never moves between node pools.
CREATE TRIGGER deployments_identity_immutable BEFORE UPDATE ON deployments
WHEN NEW.rowid IS NOT OLD.rowid
  OR NEW.id IS NOT OLD.id OR NEW.owner_user_id IS NOT OLD.owner_user_id
  OR NEW.name IS NOT OLD.name OR NEW.node_pool_id IS NOT OLD.node_pool_id
  OR (OLD.deletion_requested_at IS NOT NULL
    AND NEW.deletion_requested_at IS NOT OLD.deletion_requested_at)
  OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT OLD.deleted_at)
BEGIN
  SELECT RAISE(ABORT, 'Deployment identity or deletion lifecycle is immutable');
END;

-- VM attempts have three owners: a Workload, a node pool or a root
-- installation. Ended Cluster attempts are not copied.
CREATE TABLE vms_new (
  id INTEGER PRIMARY KEY,
  workload_id TEXT,
  node_pool_id TEXT,
  root_installation_id TEXT,
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
    (workload_id IS NOT NULL) + (node_pool_id IS NOT NULL)
      + (root_installation_id IS NOT NULL) = 1
  ),
  FOREIGN KEY (workload_id) REFERENCES workloads(id) ON DELETE CASCADE,
  FOREIGN KEY (node_pool_id) REFERENCES node_pools(id) ON DELETE RESTRICT,
  FOREIGN KEY (root_installation_id)
    REFERENCES kubernetes_root_installations(id) ON DELETE RESTRICT
);

INSERT INTO vms_new (
  id, workload_id, node_pool_id, root_installation_id, ip, cloud_id,
  private_ip, created_at, ended_at, preempt, base_image_id, region,
  availability_zone, credential_id, price_per_hour, cost, ssh_host, ssh_port,
  ssh_username, vm_type, input_host_path, output_host_path,
  checkpoint_host_path, removal_requested_at
)
SELECT
  id, workload_id, node_pool_id, root_installation_id, ip, cloud_id,
  private_ip, created_at, ended_at, preempt, base_image_id, region,
  availability_zone, credential_id, price_per_hour, cost, ssh_host, ssh_port,
  ssh_username, vm_type, input_host_path, output_host_path,
  checkpoint_host_path, removal_requested_at
FROM vms
WHERE cluster_id IS NULL
ORDER BY id;

DROP INDEX idx_vms_active;
DROP INDEX idx_vms_cloud_id;
DROP INDEX idx_vms_cluster_active;
DROP INDEX idx_vms_cluster_attempt;
DROP INDEX idx_vms_credential;
DROP INDEX idx_vms_needing_cost;
DROP INDEX idx_vms_node_pool_active;
DROP INDEX idx_vms_node_pool_attempt;
DROP INDEX idx_vms_pending_cost_group;
DROP INDEX idx_vms_release_overdue;
DROP INDEX idx_vms_root_installation_active;
DROP INDEX idx_vms_root_installation_attempt;
DROP INDEX idx_vms_spend_window;
DROP INDEX idx_vms_workload_attempt;
DROP INDEX idx_vms_workload_id;
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
CREATE INDEX idx_vms_node_pool_active
  ON vms(node_pool_id, removal_requested_at, created_at)
  WHERE node_pool_id IS NOT NULL AND ended_at IS NULL;
CREATE UNIQUE INDEX idx_vms_node_pool_attempt
  ON vms(node_pool_id, cloud_id, created_at)
  WHERE node_pool_id IS NOT NULL;
-- Billing groups pending attempts by owner; the expressions must match
-- `KEY_EXPRESSIONS` in repositories/billing.ts exactly.
CREATE INDEX idx_vms_pending_cost_group ON vms (
  CASE WHEN workload_id IS NOT NULL THEN 'anycloud_deployment' ELSE 'anycloud_resource' END,
  COALESCE(node_pool_id, root_installation_id, workload_id),
  (credential_id IS NOT NULL),
  COALESCE(credential_id, ''),
  ended_at
)
WHERE cost IS NULL
  AND ended_at IS NOT NULL
  AND (workload_id IS NOT NULL OR node_pool_id IS NOT NULL
       OR root_installation_id IS NOT NULL);
CREATE INDEX idx_vms_release_overdue
  ON vms(removal_requested_at, workload_id, id)
  WHERE workload_id IS NOT NULL
    AND ended_at IS NULL
    AND removal_requested_at IS NOT NULL;
CREATE INDEX idx_vms_root_installation_active
  ON vms(root_installation_id, removal_requested_at, created_at)
  WHERE root_installation_id IS NOT NULL AND ended_at IS NULL;
CREATE UNIQUE INDEX idx_vms_root_installation_attempt
  ON vms(root_installation_id, cloud_id, created_at)
  WHERE root_installation_id IS NOT NULL;
CREATE INDEX idx_vms_spend_window
  ON vms(ended_at, created_at, workload_id)
  WHERE ip IS NOT NULL;
CREATE UNIQUE INDEX idx_vms_workload_attempt
  ON vms(workload_id, cloud_id, created_at)
  WHERE workload_id IS NOT NULL;
CREATE INDEX idx_vms_workload_id ON vms(workload_id);

DROP TABLE cluster_capacity;
DROP TABLE clusters;
