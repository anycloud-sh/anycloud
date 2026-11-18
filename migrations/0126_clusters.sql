-- One cluster record. The installation's Kubernetes cluster is described by
-- one `clusters` row: the bootstrap facts (`kubernetes_root_installations`)
-- and the control-plane identity and connection (`kubernetes_roots`) join
-- into it, keyed by the root id where both existed. The installer keeps its
-- bootstrap-time connection (`connection_kind = 'installer'`); the hosted API
-- records itself with its in-cluster ServiceAccount (`'in-cluster'`) and
-- stores no credential. The two release-intent tables fold into
-- `cluster_releases`.
--
-- `node_pools` keeps its rows: the table rename carries its foreign key to
-- the new name and its owner column is renamed in place. `vms` is rebuilt so
-- the management VM's owner column points at `clusters`. Foreign keys are off
-- for this file and `foreign_key_check` gates the commit.

ALTER TABLE kubernetes_roots RENAME TO clusters;
ALTER TABLE node_pools RENAME COLUMN root_id TO cluster_id;

DROP TRIGGER kubernetes_roots_identity_immutable;
DROP TRIGGER kubernetes_roots_deletion_requires_no_node_pools;
DROP TRIGGER node_pools_root_accepts;
DROP INDEX idx_kubernetes_roots_active_name;
DROP INDEX idx_kubernetes_roots_owner_state;
DROP INDEX idx_kubernetes_roots_single_active;

CREATE TABLE clusters_new (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL CHECK (length(trim(owner_user_id)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  -- 'destroy-failed' keeps a half-destroyed cluster out of the bootstrap
  -- lane: only another destroy may resume it.
  state TEXT NOT NULL CHECK (
    state IN (
      'bootstrapping', 'ready', 'failed', 'destroying', 'destroy-failed',
      'destroyed'
    )
  ),
  -- Last durably completed bootstrap step; bootstrap resumes after it. The
  -- hosted API's own record is complete from the start.
  step TEXT NOT NULL CHECK (
    step IN (
      'intent', 'root-vm', 'kubernetes', 'kubeconfig', 'root',
      'release-intent', 'release'
    )
  ),
  -- Bootstrap facts; null on the hosted API's own record.
  compute_credential_id TEXT REFERENCES credentials(id) ON DELETE RESTRICT,
  region TEXT CHECK (region IS NULL OR length(trim(region)) > 0),
  zone TEXT CHECK (zone IS NULL OR length(trim(zone)) > 0),
  vm_type TEXT CHECK (vm_type IS NULL OR length(trim(vm_type)) > 0),
  k3s_version TEXT,
  k3s_sha256 TEXT CHECK (k3s_sha256 IS NULL OR length(k3s_sha256) = 64),
  helm_job_image TEXT,
  api_version TEXT,
  api_image TEXT CHECK (api_image IS NULL OR instr(api_image, '@sha256:') > 0),
  chart_version TEXT,
  chart_sha256 TEXT CHECK (chart_sha256 IS NULL OR length(chart_sha256) = 64),
  encrypted_server_token TEXT,
  ssh_public_key TEXT,
  encrypted_ssh_private_key TEXT,
  checkpoint_bucket TEXT,
  checkpoint_bucket_managed INTEGER NOT NULL DEFAULT 0
    CHECK (checkpoint_bucket_managed IN (0, 1)),
  -- Observed kube-system UID; set once the control plane answers.
  kubernetes_identity TEXT CHECK (
    kubernetes_identity IS NULL OR length(trim(kubernetes_identity)) > 0
  ),
  connection_kind TEXT NOT NULL DEFAULT 'installer'
    CHECK (connection_kind IN ('installer', 'in-cluster')),
  encrypted_connection TEXT CHECK (
    encrypted_connection IS NULL OR length(encrypted_connection) > 0
  ),
  connection_revision INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(connection_revision) = 'integer' AND connection_revision >= 1
  ),
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (state <> 'destroyed' OR encrypted_connection IS NULL)
);

-- Roots keep their ids (node pools reference them); a linked installation
-- contributes its bootstrap facts and lifecycle.
INSERT INTO clusters_new (
  id, owner_user_id, name, state, step, compute_credential_id, region, zone,
  vm_type, k3s_version, k3s_sha256, helm_job_image, api_version, api_image,
  chart_version, chart_sha256, encrypted_server_token, ssh_public_key,
  encrypted_ssh_private_key, checkpoint_bucket, checkpoint_bucket_managed,
  kubernetes_identity, connection_kind, encrypted_connection,
  connection_revision, last_error, created_at, updated_at
)
SELECT
  r.id, r.owner_user_id, r.name,
  COALESCE(i.state, CASE r.state
    WHEN 'ready' THEN 'ready' WHEN 'failed' THEN 'failed'
    WHEN 'deleting' THEN 'destroying' ELSE 'destroyed' END),
  COALESCE(i.step, 'release'),
  i.compute_credential_id, i.region, i.zone, i.vm_type, i.k3s_version,
  i.k3s_sha256, i.helm_job_image, i.api_version, i.api_image, i.chart_version,
  i.chart_sha256, i.encrypted_server_token, i.ssh_public_key,
  i.encrypted_ssh_private_key, i.checkpoint_bucket,
  COALESCE(i.checkpoint_bucket_managed, 0),
  r.kubernetes_identity, 'installer',
  CASE WHEN COALESCE(i.state, r.state) IN ('destroyed', 'deleted')
    THEN NULL ELSE r.encrypted_connection END,
  r.connection_revision, i.last_error,
  MIN(r.created_at, COALESCE(i.created_at, r.created_at)),
  MAX(r.updated_at, COALESCE(i.updated_at, r.updated_at))
FROM clusters r
LEFT JOIN kubernetes_root_installations i ON i.root_id = r.id
ORDER BY r.rowid;

-- Installations that never reached registration keep their own id.
INSERT INTO clusters_new (
  id, owner_user_id, name, state, step, compute_credential_id, region, zone,
  vm_type, k3s_version, k3s_sha256, helm_job_image, api_version, api_image,
  chart_version, chart_sha256, encrypted_server_token, ssh_public_key,
  encrypted_ssh_private_key, checkpoint_bucket, checkpoint_bucket_managed,
  kubernetes_identity, connection_kind, encrypted_connection,
  connection_revision, last_error, created_at, updated_at
)
SELECT
  i.id, i.owner_user_id, i.name, i.state, i.step, i.compute_credential_id,
  i.region, i.zone, i.vm_type, i.k3s_version, i.k3s_sha256, i.helm_job_image,
  i.api_version, i.api_image, i.chart_version, i.chart_sha256,
  i.encrypted_server_token, i.ssh_public_key, i.encrypted_ssh_private_key,
  i.checkpoint_bucket, i.checkpoint_bucket_managed, i.kubernetes_identity,
  'installer', NULL, 1, i.last_error, i.created_at, i.updated_at
FROM kubernetes_root_installations i
WHERE i.root_id IS NULL
ORDER BY i.rowid;

DROP TABLE clusters;
ALTER TABLE clusters_new RENAME TO clusters;

CREATE UNIQUE INDEX idx_clusters_active_name
  ON clusters(name COLLATE NOCASE)
  WHERE state <> 'destroyed';
CREATE INDEX idx_clusters_owner_state
  ON clusters(owner_user_id, state, created_at DESC);
-- An installation manages exactly one cluster.
CREATE UNIQUE INDEX idx_clusters_single_active
  ON clusters((state <> 'destroyed'))
  WHERE state <> 'destroyed';
CREATE INDEX idx_clusters_credential ON clusters(compute_credential_id);

CREATE TRIGGER clusters_identity_immutable BEFORE UPDATE ON clusters
WHEN NEW.rowid IS NOT OLD.rowid
  OR NEW.id IS NOT OLD.id
  OR NEW.owner_user_id IS NOT OLD.owner_user_id
  OR NEW.name IS NOT OLD.name
  OR NEW.compute_credential_id IS NOT OLD.compute_credential_id
  OR NEW.region IS NOT OLD.region
  OR NEW.zone IS NOT OLD.zone
  OR NEW.vm_type IS NOT OLD.vm_type
  OR NEW.k3s_version IS NOT OLD.k3s_version
  OR NEW.k3s_sha256 IS NOT OLD.k3s_sha256
  OR NEW.helm_job_image IS NOT OLD.helm_job_image
  OR NEW.api_version IS NOT OLD.api_version
  OR NEW.api_image IS NOT OLD.api_image
  OR NEW.chart_version IS NOT OLD.chart_version
  OR NEW.chart_sha256 IS NOT OLD.chart_sha256
  OR NEW.encrypted_server_token IS NOT OLD.encrypted_server_token
  OR NEW.ssh_public_key IS NOT OLD.ssh_public_key
  OR NEW.encrypted_ssh_private_key IS NOT OLD.encrypted_ssh_private_key
  OR NEW.connection_kind IS NOT OLD.connection_kind
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.connection_revision < OLD.connection_revision
  OR (OLD.kubernetes_identity IS NOT NULL
      AND NEW.kubernetes_identity IS NOT OLD.kubernetes_identity)
  OR (OLD.state = 'destroyed' AND NEW.state IS NOT 'destroyed')
BEGIN
  SELECT RAISE(ABORT, 'Cluster identity is immutable');
END;

CREATE TRIGGER clusters_destroy_requires_no_node_pools
BEFORE UPDATE OF state ON clusters
WHEN NEW.state IN ('destroying', 'destroyed')
  AND OLD.state NOT IN ('destroying', 'destroyed')
  AND EXISTS (
    SELECT 1 FROM node_pools p
    WHERE p.cluster_id = OLD.id AND p.state <> 'deleted'
  )
BEGIN
  SELECT RAISE(ABORT, 'Cluster still has node pools');
END;

CREATE TRIGGER node_pools_cluster_accepts BEFORE INSERT ON node_pools
WHEN NOT EXISTS (
  SELECT 1 FROM clusters c
  WHERE c.id = NEW.cluster_id AND c.state = 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'Cluster does not accept node pools');
END;

-- One release ledger. The installer's revision-1 seed and the hosted API's
-- later requests share one shape; the hosted API's rows name its own
-- cluster record.
CREATE TABLE cluster_releases (
  cluster_id TEXT NOT NULL REFERENCES clusters(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision >= 1),
  operation_id TEXT NOT NULL UNIQUE CHECK (length(trim(operation_id)) > 0),
  api_version TEXT NOT NULL CHECK (length(trim(api_version)) > 0),
  api_image TEXT NOT NULL CHECK (instr(api_image, '@sha256:') > 0),
  chart_version TEXT,
  chart_sha256 TEXT CHECK (chart_sha256 IS NULL OR length(chart_sha256) = 64),
  values_sha256 TEXT CHECK (values_sha256 IS NULL OR length(values_sha256) = 64),
  requested_by_user_id TEXT,
  state TEXT NOT NULL CHECK (
    state IN ('seeded', 'applied', 'completed', 'failed')
  ),
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (cluster_id, revision)
);

INSERT INTO cluster_releases (
  cluster_id, revision, operation_id, api_version, api_image, chart_version,
  chart_sha256, values_sha256, requested_by_user_id, state, last_error,
  created_at, updated_at
)
SELECT
  COALESCE(i.root_id, i.id), k.revision, k.operation_id, k.api_version,
  k.api_image, k.chart_version, k.chart_sha256, k.values_sha256, NULL,
  k.state, NULL, k.created_at, k.updated_at
FROM kubernetes_root_release_intents k
JOIN kubernetes_root_installations i ON i.id = k.installation_id
ORDER BY k.rowid;

-- The hosted API's own requests belong to the cluster it runs in: the one
-- record this database holds (the latest, preferring an active one). A hosted
-- API database has no installer record before its first start on this
-- release, so its earlier rows are not carried; nothing is released.
INSERT INTO cluster_releases (
  cluster_id, revision, operation_id, api_version, api_image, chart_version,
  chart_sha256, values_sha256, requested_by_user_id, state, last_error,
  created_at, updated_at
)
SELECT
  (SELECT c.id FROM clusters c
   ORDER BY (c.state <> 'destroyed') DESC, c.rowid DESC LIMIT 1),
  s.revision, s.operation_id, s.api_version, s.api_image, NULL, NULL, NULL,
  s.requested_by_user_id,
  CASE s.state WHEN 'recorded' THEN 'seeded' ELSE s.state END,
  s.last_error, s.created_at, s.updated_at
FROM system_release_intents s
WHERE EXISTS (SELECT 1 FROM clusters)
ORDER BY s.rowid;

CREATE TRIGGER cluster_releases_monotonic BEFORE INSERT ON cluster_releases
WHEN NEW.revision <= COALESCE((
  SELECT MAX(revision) FROM cluster_releases WHERE cluster_id = NEW.cluster_id
), 0)
BEGIN
  SELECT RAISE(ABORT, 'Cluster release revision must increase');
END;

CREATE TRIGGER cluster_releases_immutable BEFORE UPDATE ON cluster_releases
WHEN NEW.cluster_id IS NOT OLD.cluster_id
  OR NEW.revision IS NOT OLD.revision
  OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.api_version IS NOT OLD.api_version
  OR NEW.api_image IS NOT OLD.api_image
  OR NEW.chart_version IS NOT OLD.chart_version
  OR NEW.chart_sha256 IS NOT OLD.chart_sha256
  OR NEW.values_sha256 IS NOT OLD.values_sha256
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'Cluster release intent is immutable');
END;

DROP TABLE kubernetes_root_release_intents;
DROP TABLE system_release_intents;

-- VM attempts: a Workload, a node pool or the cluster (its management VM).
CREATE TABLE vms_new (
  id INTEGER PRIMARY KEY,
  workload_id TEXT,
  node_pool_id TEXT,
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
    (workload_id IS NOT NULL) + (node_pool_id IS NOT NULL)
      + (cluster_id IS NOT NULL) = 1
  ),
  FOREIGN KEY (workload_id) REFERENCES workloads(id) ON DELETE CASCADE,
  FOREIGN KEY (node_pool_id) REFERENCES node_pools(id) ON DELETE RESTRICT,
  FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE RESTRICT
);

INSERT INTO vms_new (
  id, workload_id, node_pool_id, cluster_id, ip, cloud_id, private_ip,
  created_at, ended_at, preempt, base_image_id, region, availability_zone,
  credential_id, price_per_hour, cost, ssh_host, ssh_port, ssh_username,
  vm_type, input_host_path, output_host_path, checkpoint_host_path,
  removal_requested_at
)
SELECT
  v.id, v.workload_id, v.node_pool_id,
  CASE WHEN v.root_installation_id IS NULL THEN NULL ELSE COALESCE(
    (SELECT i.root_id FROM kubernetes_root_installations i
     WHERE i.id = v.root_installation_id), v.root_installation_id) END,
  v.ip, v.cloud_id, v.private_ip, v.created_at, v.ended_at, v.preempt,
  v.base_image_id, v.region, v.availability_zone, v.credential_id,
  v.price_per_hour, v.cost, v.ssh_host, v.ssh_port, v.ssh_username, v.vm_type,
  v.input_host_path, v.output_host_path, v.checkpoint_host_path,
  v.removal_requested_at
FROM vms v
ORDER BY v.id;

DROP INDEX idx_vms_active;
DROP INDEX idx_vms_cloud_id;
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
  COALESCE(node_pool_id, cluster_id, workload_id),
  (credential_id IS NOT NULL),
  COALESCE(credential_id, ''),
  ended_at
)
WHERE cost IS NULL
  AND ended_at IS NOT NULL
  AND (workload_id IS NOT NULL OR node_pool_id IS NOT NULL
       OR cluster_id IS NOT NULL);
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

DROP TRIGGER kubernetes_root_installations_intent_immutable;
DROP TABLE kubernetes_root_installations;
