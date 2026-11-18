-- Unpinned node pools. `region` becomes nullable: null means the pool picks a
-- catalog region per VM, and each VM row keeps the region it launched in. A
-- zone still needs a region. SQLite cannot drop NOT NULL, so the table is
-- rebuilt; foreign keys are off for this file and `foreign_key_check` gates
-- the commit.

CREATE TABLE node_pools_new (
  id TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL REFERENCES clusters(id) ON DELETE RESTRICT,
  owner_user_id TEXT NOT NULL CHECK (length(trim(owner_user_id)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  state TEXT NOT NULL CHECK (
    state IN ('creating', 'ready', 'failed', 'deleting', 'deleted')
  ),
  compute_credential_id TEXT NOT NULL
    REFERENCES credentials(id) ON DELETE RESTRICT,
  region TEXT CHECK (region IS NULL OR length(trim(region)) > 0),
  zone TEXT CHECK (zone IS NULL OR length(trim(zone)) > 0),
  vm_type TEXT NOT NULL CHECK (length(trim(vm_type)) > 0),
  min_vm_count INTEGER NOT NULL,
  max_vm_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error TEXT,
  provisioning_failures INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(provisioning_failures) = 'integer' AND provisioning_failures >= 0),
  provisioning_failed_at INTEGER,
  join_replacements INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(join_replacements) = 'integer' AND join_replacements >= 0),
  join_replaced_at INTEGER,
  ingress_entry_vm_id INTEGER REFERENCES vms(id) ON DELETE SET NULL,
  ingress_entry_changed_at INTEGER,
  CHECK (zone IS NULL OR region IS NOT NULL),
  CHECK (
    typeof(min_vm_count) = 'integer'
    AND typeof(max_vm_count) = 'integer'
    AND min_vm_count >= 0
    AND min_vm_count <= max_vm_count
  )
);

INSERT INTO node_pools_new (
  id, cluster_id, owner_user_id, name, state, compute_credential_id, region,
  zone, vm_type, min_vm_count, max_vm_count, created_at, updated_at,
  last_error, provisioning_failures, provisioning_failed_at,
  join_replacements, join_replaced_at, ingress_entry_vm_id,
  ingress_entry_changed_at
)
SELECT
  id, cluster_id, owner_user_id, name, state, compute_credential_id, region,
  zone, vm_type, min_vm_count, max_vm_count, created_at, updated_at,
  last_error, provisioning_failures, provisioning_failed_at,
  join_replacements, join_replaced_at, ingress_entry_vm_id,
  ingress_entry_changed_at
FROM node_pools;

-- Triggers on other tables that name node_pools would fail the rename check
-- while the old table is gone, so they are dropped and recreated around it.
DROP TRIGGER clusters_destroy_requires_no_node_pools;
DROP TRIGGER workloads_node_pool_accepts;
DROP TABLE node_pools;
ALTER TABLE node_pools_new RENAME TO node_pools;

CREATE UNIQUE INDEX idx_node_pools_active_name
  ON node_pools(name COLLATE NOCASE)
  WHERE state <> 'deleted';
CREATE INDEX idx_node_pools_cluster_state
  ON node_pools(cluster_id, state, created_at);
CREATE INDEX idx_node_pools_credential
  ON node_pools(compute_credential_id);

CREATE TRIGGER node_pools_association_immutable BEFORE UPDATE ON node_pools
WHEN NEW.rowid IS NOT OLD.rowid
  OR NEW.id IS NOT OLD.id
  OR NEW.cluster_id IS NOT OLD.cluster_id
  OR NEW.owner_user_id IS NOT OLD.owner_user_id
  OR NEW.name IS NOT OLD.name
  OR NEW.compute_credential_id IS NOT OLD.compute_credential_id
  OR NEW.region IS NOT OLD.region
  OR NEW.zone IS NOT OLD.zone
  OR NEW.vm_type IS NOT OLD.vm_type
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.state = 'deleted' AND NEW.state IS NOT 'deleted')
BEGIN
  SELECT RAISE(ABORT, 'Node pool association is immutable');
END;

CREATE TRIGGER node_pools_cluster_accepts BEFORE INSERT ON node_pools
WHEN NOT EXISTS (
  SELECT 1 FROM clusters c
  WHERE c.id = NEW.cluster_id AND c.state = 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'Cluster does not accept node pools');
END;

CREATE TRIGGER node_pools_deletion_requires_no_services
BEFORE UPDATE OF state ON node_pools
WHEN NEW.state IN ('deleting', 'deleted')
  AND OLD.state NOT IN ('deleting', 'deleted')
  AND EXISTS (
    SELECT 1 FROM workloads w
    WHERE w.node_pool_id = OLD.id AND w.cleaned_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'node pool still has Services');
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

CREATE TRIGGER workloads_node_pool_accepts BEFORE INSERT ON workloads
WHEN NEW.node_pool_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM node_pools p WHERE p.id = NEW.node_pool_id AND p.state = 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'node pool does not accept Services');
END;
