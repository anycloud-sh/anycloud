-- RFC 0049 C26 for 0.1.74, rebuilding `clusters` once for every row I lane.
--
-- (a) The cluster record moves to the cluster. Create writes the facts delete
-- and upgrade need into the release values, and the hosted API keeps them on
-- its own row, which its hourly backup carries. Region, zone, VM type, the K3s
-- pin and the bucket had columns; the cloud came from the compute credential,
-- which the hosted row has none of, so the cloud and its account are columns
-- now, with the management VM's provider id and its network scope. Rows from
-- before stay null.
--
-- (e) Creation gains the steps `installer-access`, `backup-trust`,
-- `backup-check` and `ssh-close`. Step values are part of the table's CHECK,
-- so `clusters` is rebuilt as 0127 did; its children (`node_pools`,
-- `cluster_releases`, `vms`) reference it by name and are not touched.
-- Foreign keys are off for this file and `foreign_key_check` gates the commit.

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
      'release-intent', 'release', 'installer-access', 'backup-trust',
      'backup-check', 'ssh-close'
    )
  ),
  -- Creation facts. The hosted API's own row holds the cluster record its
  -- release values carry (RFC 0049 C26 (a)); null before 0.1.74.
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
  restore_from_backup INTEGER NOT NULL DEFAULT 0
    CHECK (restore_from_backup IN (0, 1)),
  identity_generation INTEGER NOT NULL DEFAULT 0,
  -- The cloud and its account (AWS account, GCP project, Azure subscription;
  -- none on Lambda), the management VM's provider id and the network scope
  -- (`anycloud-cluster-<id>`): what delete needs without the credential.
  cloud_provider TEXT CHECK (
    cloud_provider IS NULL OR cloud_provider IN ('AWS', 'GCP', 'Azure', 'Lambda')
  ),
  cloud_account TEXT CHECK (
    cloud_account IS NULL OR length(trim(cloud_account)) > 0
  ),
  management_vm_id TEXT CHECK (
    management_vm_id IS NULL OR length(trim(management_vm_id)) > 0
  ),
  network_scope TEXT CHECK (
    network_scope IS NULL OR length(trim(network_scope)) > 0
  ),
  CHECK (state <> 'destroyed' OR encrypted_connection IS NULL)
);

INSERT INTO clusters_new (
  id, owner_user_id, name, state, step, compute_credential_id, region, zone,
  vm_type, k3s_version, k3s_sha256, helm_job_image, api_version, api_image,
  chart_version, chart_sha256, encrypted_server_token, ssh_public_key,
  encrypted_ssh_private_key, checkpoint_bucket, checkpoint_bucket_managed,
  kubernetes_identity, connection_kind, encrypted_connection,
  connection_revision, last_error, created_at, updated_at,
  restore_from_backup, identity_generation
)
SELECT
  id, owner_user_id, name, state, step, compute_credential_id, region, zone,
  vm_type, k3s_version, k3s_sha256, helm_job_image, api_version, api_image,
  chart_version, chart_sha256, encrypted_server_token, ssh_public_key,
  encrypted_ssh_private_key, checkpoint_bucket, checkpoint_bucket_managed,
  kubernetes_identity, connection_kind, encrypted_connection,
  connection_revision, last_error, created_at, updated_at,
  restore_from_backup, identity_generation
FROM clusters
ORDER BY rowid;

-- The node pool trigger names the table; recreate it around the swap.
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

-- The record is as immutable as the rest of the identity, except that a
-- hosted API restored into a new cluster (the adoption 0132 allows) takes the
-- new cluster's record with its new identity.
CREATE TRIGGER clusters_identity_immutable BEFORE UPDATE ON clusters
WHEN NEW.rowid IS NOT OLD.rowid
  OR NEW.id IS NOT OLD.id
  OR NEW.owner_user_id IS NOT OLD.owner_user_id
  OR NEW.name IS NOT OLD.name
  OR NEW.compute_credential_id IS NOT OLD.compute_credential_id
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
  OR ((NEW.region IS NOT OLD.region
       OR NEW.zone IS NOT OLD.zone
       OR NEW.vm_type IS NOT OLD.vm_type
       OR NEW.k3s_version IS NOT OLD.k3s_version
       OR NEW.k3s_sha256 IS NOT OLD.k3s_sha256
       OR NEW.cloud_provider IS NOT OLD.cloud_provider
       OR NEW.cloud_account IS NOT OLD.cloud_account
       OR NEW.management_vm_id IS NOT OLD.management_vm_id
       OR NEW.network_scope IS NOT OLD.network_scope
       -- A delete that removed the managed bucket clears it (RFC 0049 C28);
       -- a supplied bucket is never deleted, so never cleared.
       OR (NEW.checkpoint_bucket IS NOT OLD.checkpoint_bucket
           AND (NEW.checkpoint_bucket IS NOT NULL
                OR OLD.checkpoint_bucket_managed IS NOT 1))
       OR (NEW.checkpoint_bucket_managed IS NOT OLD.checkpoint_bucket_managed
           AND (NEW.checkpoint_bucket IS NOT NULL
                OR OLD.checkpoint_bucket_managed IS NOT 1)))
      AND NEW.identity_generation IS NOT OLD.identity_generation + 1)
  OR (NEW.identity_generation IS NOT OLD.identity_generation
      AND (NEW.identity_generation IS NOT OLD.identity_generation + 1
           OR NEW.kubernetes_identity IS NULL
           OR NEW.kubernetes_identity IS OLD.kubernetes_identity))
  OR (OLD.kubernetes_identity IS NOT NULL
      AND NEW.kubernetes_identity IS NOT OLD.kubernetes_identity
      AND NEW.identity_generation IS NOT OLD.identity_generation + 1)
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
