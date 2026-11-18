-- Add the scheduler-neutral cluster registry and optional AnyCloud-managed
-- capacity intent. A cluster can exist without a capacity row, while runtime
-- connection readers must therefore never infer infrastructure ownership from
-- the cluster record alone.

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE clusters (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
  owner_user_id TEXT NOT NULL CHECK (length(trim(owner_user_id)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  state TEXT NOT NULL CHECK (
    state IN ('creating', 'ready', 'failed', 'deleting', 'deleted')
  ),
  controller_identity TEXT,
  encrypted_runtime_state TEXT,
  connection_revision INTEGER NOT NULL DEFAULT 0 CHECK (connection_revision >= 0),
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_clusters_active_name
  ON clusters(name COLLATE NOCASE)
  WHERE state <> 'deleted';
CREATE INDEX idx_clusters_owner_state
  ON clusters(owner_user_id, state, created_at DESC);

CREATE TABLE cluster_capacity (
  cluster_id TEXT PRIMARY KEY,
  compute_credential_id TEXT NOT NULL
    REFERENCES credentials(id) ON DELETE RESTRICT,
  region TEXT NOT NULL CHECK (length(trim(region)) > 0),
  vm_type TEXT NOT NULL CHECK (length(trim(vm_type)) > 0),
  min_vm_count INTEGER NOT NULL,
  max_vm_count INTEGER NOT NULL,
  CHECK (
    typeof(min_vm_count) = 'integer'
    AND typeof(max_vm_count) = 'integer'
    AND min_vm_count >= 0
    AND min_vm_count <= max_vm_count
  ),
  FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE RESTRICT
);

CREATE INDEX idx_cluster_capacity_credential
  ON cluster_capacity(compute_credential_id);

ALTER TABLE deployments ADD COLUMN cluster_id TEXT
  REFERENCES clusters(id) ON DELETE RESTRICT;

CREATE INDEX idx_deployments_cluster_id
  ON deployments(cluster_id)
  WHERE cluster_id IS NOT NULL;

-- Give every VM attempt one immutable database identity and generalize its
-- owner. Existing rows remain deployment-owned.
CREATE TABLE vms_new (
  id INTEGER PRIMARY KEY,
  deployment_id TEXT,
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
  CHECK (
    (deployment_id IS NOT NULL AND cluster_id IS NULL)
    OR (deployment_id IS NULL AND cluster_id IS NOT NULL)
  ),
  FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE,
  FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE RESTRICT
);

INSERT INTO vms_new (
  deployment_id, ip, cloud_id, private_ip, created_at, ended_at, preempt,
  base_image_id, region, availability_zone, credential_id, price_per_hour,
  cost, ssh_host, ssh_port, ssh_username, vm_type, input_host_path,
  output_host_path, checkpoint_host_path
)
SELECT
  deployment_id, ip, cloud_id, private_ip, created_at, ended_at, preempt,
  base_image_id, region, availability_zone, credential_id, price_per_hour,
  cost, ssh_host, ssh_port, ssh_username, vm_type, input_host_path,
  output_host_path, checkpoint_host_path
FROM vms
ORDER BY rowid;

DROP TABLE vms;
ALTER TABLE vms_new RENAME TO vms;

-- Preserve the old composite-primary-key collision contract for deployment
-- attempts while giving cluster-owned attempts the equivalent constraint.
CREATE UNIQUE INDEX idx_vms_deployment_attempt
  ON vms(deployment_id, cloud_id, created_at)
  WHERE deployment_id IS NOT NULL;
CREATE UNIQUE INDEX idx_vms_cluster_attempt
  ON vms(cluster_id, cloud_id, created_at)
  WHERE cluster_id IS NOT NULL;

-- Restore every index dropped with the old vms table.
CREATE INDEX idx_vms_deployment_id ON vms(deployment_id);
CREATE INDEX idx_vms_credential ON vms(credential_id);
CREATE INDEX idx_vms_active
  ON vms(deployment_id, ip, price_per_hour)
  WHERE ended_at IS NULL;
CREATE INDEX idx_vms_spend_window
  ON vms(ended_at, created_at, deployment_id)
  WHERE ip IS NOT NULL;
CREATE INDEX idx_vms_needing_cost
  ON vms(ended_at, deployment_id, credential_id, cloud_id)
  WHERE cost IS NULL
    AND ended_at IS NOT NULL;
CREATE INDEX idx_vms_cloud_id ON vms(cloud_id);
CREATE INDEX idx_vms_cluster_active
  ON vms(cluster_id, removal_requested_at, created_at)
  WHERE cluster_id IS NOT NULL AND ended_at IS NULL;

COMMIT;

PRAGMA foreign_keys = ON;
