-- Root installations: the infrastructure owner behind one Kubernetes root.
--
-- Bootstrap records this row, with the exact pinned toolchain and the target
-- cloud identity, before it creates anything in the customer's cloud. The
-- management VM is an ordinary row in the existing `vms` ledger owned by the
-- installation; the registered `kubernetes_roots` row is linked once the
-- control plane's identity has been observed. Release intent is a monotonic,
-- per-installation revision so a restart or stale manifest cannot move the
-- root backwards.

CREATE TABLE kubernetes_root_installations (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL CHECK (length(trim(owner_user_id)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  -- 'destroy-failed' keeps a half-destroyed installation out of the bootstrap
  -- lane: only another destroy may resume it.
  state TEXT NOT NULL CHECK (
    state IN (
      'bootstrapping', 'ready', 'failed', 'destroying', 'destroy-failed',
      'destroyed'
    )
  ),
  -- Last durably completed bootstrap step; bootstrap resumes after it.
  step TEXT NOT NULL CHECK (
    step IN (
      'intent', 'root-vm', 'kubernetes', 'kubeconfig', 'root',
      'release-intent', 'release'
    )
  ),
  compute_credential_id TEXT NOT NULL
    REFERENCES credentials(id) ON DELETE RESTRICT,
  region TEXT NOT NULL CHECK (length(trim(region)) > 0),
  zone TEXT CHECK (zone IS NULL OR length(trim(zone)) > 0),
  vm_type TEXT NOT NULL CHECK (length(trim(vm_type)) > 0),
  -- Exact toolchain copied from the bootstrapping API at intent time.
  k3s_version TEXT NOT NULL CHECK (length(trim(k3s_version)) > 0),
  k3s_sha256 TEXT NOT NULL CHECK (length(k3s_sha256) = 64),
  helm_job_image TEXT NOT NULL CHECK (instr(helm_job_image, '@sha256:') > 0),
  api_version TEXT NOT NULL CHECK (length(trim(api_version)) > 0),
  api_image TEXT NOT NULL CHECK (instr(api_image, '@sha256:') > 0),
  chart_version TEXT NOT NULL CHECK (length(trim(chart_version)) > 0),
  chart_sha256 TEXT NOT NULL CHECK (length(chart_sha256) = 64),
  -- K3s server token and bootstrap SSH key, generated before mutation and
  -- encrypted at rest so a resumed or independent maintenance run can reach
  -- the same host.
  encrypted_server_token TEXT NOT NULL CHECK (length(encrypted_server_token) > 0),
  ssh_public_key TEXT NOT NULL CHECK (length(trim(ssh_public_key)) > 0),
  encrypted_ssh_private_key TEXT NOT NULL CHECK (
    length(encrypted_ssh_private_key) > 0
  ),
  -- Observed kube-system UID; set once the control plane answers, before
  -- registration, so a resumed bootstrap registers the same identity.
  kubernetes_identity TEXT CHECK (
    kubernetes_identity IS NULL OR length(trim(kubernetes_identity)) > 0
  ),
  root_id TEXT REFERENCES kubernetes_roots(id) ON DELETE RESTRICT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One installation that is not destroyed, whatever its owner or name.
CREATE UNIQUE INDEX idx_kubernetes_root_installations_single_active
  ON kubernetes_root_installations((state <> 'destroyed'))
  WHERE state <> 'destroyed';
CREATE UNIQUE INDEX idx_kubernetes_root_installations_active_name
  ON kubernetes_root_installations(name COLLATE NOCASE)
  WHERE state <> 'destroyed';
CREATE INDEX idx_kubernetes_root_installations_credential
  ON kubernetes_root_installations(compute_credential_id);

-- Target identity and toolchain are fixed at intent time. A destroyed
-- installation stays destroyed.
CREATE TRIGGER kubernetes_root_installations_intent_immutable
BEFORE UPDATE ON kubernetes_root_installations
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
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.kubernetes_identity IS NOT NULL
      AND NEW.kubernetes_identity IS NOT OLD.kubernetes_identity)
  OR (OLD.root_id IS NOT NULL AND NEW.root_id IS NOT OLD.root_id)
  OR (OLD.state = 'destroyed' AND NEW.state IS NOT 'destroyed')
BEGIN
  SELECT RAISE(ABORT, 'Kubernetes root installation intent is immutable');
END;

-- Release intent: one monotonic revision sequence per installation. Bootstrap
-- seeds revision 1 exactly once; later updates append higher revisions.
CREATE TABLE kubernetes_root_release_intents (
  installation_id TEXT NOT NULL
    REFERENCES kubernetes_root_installations(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision >= 1),
  operation_id TEXT NOT NULL UNIQUE CHECK (length(trim(operation_id)) > 0),
  api_version TEXT NOT NULL CHECK (length(trim(api_version)) > 0),
  api_image TEXT NOT NULL CHECK (instr(api_image, '@sha256:') > 0),
  chart_version TEXT NOT NULL CHECK (length(trim(chart_version)) > 0),
  chart_sha256 TEXT NOT NULL CHECK (length(chart_sha256) = 64),
  values_sha256 TEXT NOT NULL CHECK (length(values_sha256) = 64),
  state TEXT NOT NULL CHECK (
    state IN ('seeded', 'applied', 'completed', 'failed')
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, revision)
);

CREATE TRIGGER kubernetes_root_release_intents_monotonic
BEFORE INSERT ON kubernetes_root_release_intents
WHEN NEW.revision <= COALESCE((
  SELECT MAX(revision) FROM kubernetes_root_release_intents
  WHERE installation_id = NEW.installation_id
), 0)
BEGIN
  SELECT RAISE(ABORT, 'Kubernetes root release revision must increase');
END;

CREATE TRIGGER kubernetes_root_release_intents_immutable
BEFORE UPDATE ON kubernetes_root_release_intents
WHEN NEW.installation_id IS NOT OLD.installation_id
  OR NEW.revision IS NOT OLD.revision
  OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.api_version IS NOT OLD.api_version
  OR NEW.api_image IS NOT OLD.api_image
  OR NEW.chart_version IS NOT OLD.chart_version
  OR NEW.chart_sha256 IS NOT OLD.chart_sha256
  OR NEW.values_sha256 IS NOT OLD.values_sha256
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'Kubernetes root release intent is immutable');
END;

-- The management VM lives in the existing ledger with the installation as its
-- one owner. 0110 gave attempts a placement owner (workload | cluster |
-- placement); the root's VM is owned by the installation record (it exists
-- before the root's identity can be verified and survives host-loss
-- recovery), so the owner set becomes workload | cluster | placement | root
-- installation. The CHECK cannot be widened in place, so the table is rebuilt
-- with 0110's pattern: every 0110 column and row is copied with its id,
-- foreign keys stay enforced, and the backfill queue that references vms(id)
-- ON DELETE CASCADE is rebuilt against the new table first so dropping the old
-- table cascades into nothing.
CREATE TABLE vms_new (
  id INTEGER PRIMARY KEY,
  workload_id TEXT,
  cluster_id TEXT,
  placement_id TEXT,
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
    (workload_id IS NOT NULL) + (cluster_id IS NOT NULL)
      + (placement_id IS NOT NULL) + (root_installation_id IS NOT NULL) = 1
  ),
  FOREIGN KEY (workload_id) REFERENCES workloads(id) ON DELETE CASCADE,
  FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE RESTRICT,
  FOREIGN KEY (placement_id) REFERENCES placements(id) ON DELETE RESTRICT,
  FOREIGN KEY (root_installation_id)
    REFERENCES kubernetes_root_installations(id) ON DELETE RESTRICT
);

-- A 0110 database that already holds a root_id-owned attempt cannot be
-- carried forward (it would have no owner here); 0110 and 0111 ship in the
-- same release and ROOT's placement runtime never writes root_id, so the
-- CHECK failure that would surface is a development-database condition.
INSERT INTO vms_new (
  id, workload_id, cluster_id, placement_id, ip, cloud_id, private_ip,
  created_at, ended_at, preempt, base_image_id, region, availability_zone,
  credential_id, price_per_hour, cost, ssh_host, ssh_port, ssh_username,
  vm_type, input_host_path, output_host_path, checkpoint_host_path,
  removal_requested_at
)
SELECT
  id, workload_id, cluster_id, placement_id, ip, cloud_id, private_ip,
  created_at, ended_at, preempt, base_image_id, region, availability_zone,
  credential_id, price_per_hour, cost, ssh_host, ssh_port, ssh_username,
  vm_type, input_host_path, output_host_path, checkpoint_host_path,
  removal_requested_at
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

-- Every index dropped with the old table; the root owner indexes now key on
-- the installation.
CREATE UNIQUE INDEX idx_vms_workload_attempt
  ON vms(workload_id, cloud_id, created_at)
  WHERE workload_id IS NOT NULL;
CREATE UNIQUE INDEX idx_vms_cluster_attempt
  ON vms(cluster_id, cloud_id, created_at)
  WHERE cluster_id IS NOT NULL;
CREATE UNIQUE INDEX idx_vms_placement_attempt
  ON vms(placement_id, cloud_id, created_at)
  WHERE placement_id IS NOT NULL;
CREATE UNIQUE INDEX idx_vms_root_installation_attempt
  ON vms(root_installation_id, cloud_id, created_at)
  WHERE root_installation_id IS NOT NULL;
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
CREATE INDEX idx_vms_root_installation_active
  ON vms(root_installation_id, removal_requested_at, created_at)
  WHERE root_installation_id IS NOT NULL AND ended_at IS NULL;
CREATE INDEX idx_vms_release_overdue
  ON vms(removal_requested_at, workload_id, id)
  WHERE workload_id IS NOT NULL
    AND ended_at IS NULL
    AND removal_requested_at IS NOT NULL;

-- Cost settlement groups ended attempts by provider tag and owning resource.
-- Cluster, placement and root installation attempts carry the resource-scope
-- tag; only Workload VMs carry the deployment tag. Billing selects this index
-- by name and must use these exact expressions.
CREATE INDEX idx_vms_pending_cost_group ON vms (
  CASE WHEN workload_id IS NOT NULL THEN 'anycloud_deployment' ELSE 'anycloud_resource' END,
  COALESCE(cluster_id, placement_id, root_installation_id, workload_id),
  (credential_id IS NOT NULL),
  COALESCE(credential_id, ''),
  ended_at
)
WHERE cost IS NULL
  AND ended_at IS NOT NULL
  AND (workload_id IS NOT NULL OR cluster_id IS NOT NULL
       OR placement_id IS NOT NULL OR root_installation_id IS NOT NULL);
