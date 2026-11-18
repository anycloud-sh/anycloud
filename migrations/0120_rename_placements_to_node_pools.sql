-- The cloud-local pool of worker Nodes under one root is a node pool, the
-- Kubernetes-ecosystem term; "placement" stays the word for a scheduling
-- property. Rename the table and the two owner columns in place. SQLite
-- rewrites REFERENCES clauses, CHECK constraints and index expressions on
-- RENAME; the triggers and indexes that carry the old noun in their names or
-- messages are dropped first and recreated below with the new ones. Every row
-- keeps its id; every foreign-key action is preserved.

DROP TRIGGER kubernetes_roots_deletion_requires_no_placements;
DROP TRIGGER placements_association_immutable;
DROP TRIGGER placements_deletion_requires_no_services;
DROP TRIGGER placements_root_accepts;
DROP TRIGGER workloads_identity_immutable;
DROP TRIGGER workloads_placement_accepts;
DROP TRIGGER workloads_placement_target;

DROP INDEX idx_placements_active_name;
DROP INDEX idx_placements_credential;
DROP INDEX idx_placements_root_state;
DROP INDEX idx_vms_pending_cost_group;
DROP INDEX idx_vms_placement_active;
DROP INDEX idx_vms_placement_attempt;
DROP INDEX idx_workloads_placement;

ALTER TABLE placements RENAME TO node_pools;
ALTER TABLE vms RENAME COLUMN placement_id TO node_pool_id;
ALTER TABLE workloads RENAME COLUMN placement_id TO node_pool_id;

CREATE UNIQUE INDEX idx_node_pools_active_name
  ON node_pools(name COLLATE NOCASE)
  WHERE state <> 'deleted';
CREATE INDEX idx_node_pools_credential
  ON node_pools(compute_credential_id);
CREATE INDEX idx_node_pools_root_state
  ON node_pools(root_id, state, created_at);

-- Billing discovery keys must match this expression token for token.
CREATE INDEX idx_vms_pending_cost_group ON vms (
  CASE WHEN workload_id IS NOT NULL THEN 'anycloud_deployment' ELSE 'anycloud_resource' END,
  COALESCE(cluster_id, node_pool_id, root_installation_id, workload_id),
  (credential_id IS NOT NULL),
  COALESCE(credential_id, ''),
  ended_at
)
WHERE cost IS NULL
  AND ended_at IS NOT NULL
  AND (workload_id IS NOT NULL OR cluster_id IS NOT NULL
       OR node_pool_id IS NOT NULL OR root_installation_id IS NOT NULL);
CREATE INDEX idx_vms_node_pool_active
  ON vms(node_pool_id, removal_requested_at, created_at)
  WHERE node_pool_id IS NOT NULL AND ended_at IS NULL;
CREATE UNIQUE INDEX idx_vms_node_pool_attempt
  ON vms(node_pool_id, cloud_id, created_at)
  WHERE node_pool_id IS NOT NULL;
CREATE INDEX idx_workloads_node_pool
  ON workloads(node_pool_id, state, cleaned_at)
  WHERE node_pool_id IS NOT NULL;

CREATE TRIGGER kubernetes_roots_deletion_requires_no_node_pools
BEFORE UPDATE OF state ON kubernetes_roots
WHEN NEW.state IN ('deleting', 'deleted')
  AND OLD.state NOT IN ('deleting', 'deleted')
  AND EXISTS (
    SELECT 1 FROM node_pools p
    WHERE p.root_id = OLD.id AND p.state <> 'deleted'
  )
BEGIN
  SELECT RAISE(ABORT, 'Kubernetes root still has node pools');
END;

CREATE TRIGGER node_pools_association_immutable BEFORE UPDATE ON node_pools
WHEN NEW.rowid IS NOT OLD.rowid
  OR NEW.id IS NOT OLD.id
  OR NEW.root_id IS NOT OLD.root_id
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

CREATE TRIGGER node_pools_root_accepts BEFORE INSERT ON node_pools
WHEN NOT EXISTS (
  SELECT 1 FROM kubernetes_roots r
  WHERE r.id = NEW.root_id AND r.state = 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'Kubernetes root does not accept node pools');
END;

CREATE TRIGGER workloads_identity_immutable BEFORE UPDATE ON workloads
WHEN NEW.rowid IS NOT OLD.rowid
  OR NEW.id IS NOT OLD.id OR NEW.workload_type IS NOT OLD.workload_type
  OR NEW.deployment_id IS NOT OLD.deployment_id
  OR NEW.node_pool_id IS NOT OLD.node_pool_id
  OR NEW.user_id IS NOT OLD.user_id
  OR NEW.owner_user_id IS NOT OLD.owner_user_id
BEGIN
  SELECT RAISE(ABORT, 'workload identity and target are immutable');
END;

CREATE TRIGGER workloads_node_pool_accepts BEFORE INSERT ON workloads
WHEN NEW.node_pool_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM node_pools p WHERE p.id = NEW.node_pool_id AND p.state = 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'node pool does not accept Services');
END;

CREATE TRIGGER workloads_node_pool_target BEFORE INSERT ON workloads
WHEN NEW.node_pool_id IS NOT NULL
  AND (NEW.workload_type <> 'service' OR NEW.deployment_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'only a Service Workload without a Deployment target can target a node pool');
END;
