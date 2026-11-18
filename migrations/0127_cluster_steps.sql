-- The noun leaves the schema: the two creation steps still named for the
-- "root" become 'management-vm' (the management VM is provisioned) and
-- 'connection' (the installer's connection is bound). Step values are part of
-- the table's CHECK constraint, so `clusters` is rebuilt; its children
-- (`node_pools`, `cluster_releases`, `vms`) reference it by name and are not
-- touched. Foreign keys are off for this file and `foreign_key_check` gates
-- the commit. Nothing is released; 0126's pre-flight already required every
-- earlier installation to be destroyed.

CREATE TABLE clusters_new (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL CHECK (length(trim(owner_user_id)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  -- 'destroy-failed' keeps a half-destroyed cluster out of the creation
  -- lane: only another destroy may resume it.
  state TEXT NOT NULL CHECK (
    state IN (
      'bootstrapping', 'ready', 'failed', 'destroying', 'destroy-failed',
      'destroyed'
    )
  ),
  -- Last durably completed creation step; creation resumes after it. The
  -- hosted API's own record is complete from the start.
  step TEXT NOT NULL CHECK (
    step IN (
      'intent', 'management-vm', 'kubernetes', 'kubeconfig', 'connection',
      'release-intent', 'release'
    )
  ),
  -- Creation facts; null on the hosted API's own record.
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

INSERT INTO clusters_new (
  id, owner_user_id, name, state, step, compute_credential_id, region, zone,
  vm_type, k3s_version, k3s_sha256, helm_job_image, api_version, api_image,
  chart_version, chart_sha256, encrypted_server_token, ssh_public_key,
  encrypted_ssh_private_key, checkpoint_bucket, checkpoint_bucket_managed,
  kubernetes_identity, connection_kind, encrypted_connection,
  connection_revision, last_error, created_at, updated_at
)
SELECT
  id, owner_user_id, name, state,
  CASE step
    WHEN 'root-vm' THEN 'management-vm'
    WHEN 'root' THEN 'connection'
    ELSE step
  END,
  compute_credential_id, region, zone,
  vm_type, k3s_version, k3s_sha256, helm_job_image, api_version, api_image,
  chart_version, chart_sha256, encrypted_server_token, ssh_public_key,
  encrypted_ssh_private_key, checkpoint_bucket, checkpoint_bucket_managed,
  kubernetes_identity, connection_kind, encrypted_connection,
  connection_revision, last_error, created_at, updated_at
FROM clusters
ORDER BY rowid;

-- The node pool trigger names the table and survives the drop; recreate it.
DROP TRIGGER node_pools_cluster_accepts;
DROP TABLE clusters;
ALTER TABLE clusters_new RENAME TO clusters;

CREATE UNIQUE INDEX idx_clusters_active_name
  ON clusters(name COLLATE NOCASE)
  WHERE state <> 'destroyed';
CREATE INDEX idx_clusters_owner_state
  ON clusters(owner_user_id, state, created_at DESC);
-- An installation has exactly one cluster.
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

-- The node pool index kept the old owner's name through the column rename.
DROP INDEX idx_node_pools_root_state;
CREATE INDEX idx_node_pools_cluster_state
  ON node_pools(cluster_id, state, created_at);
