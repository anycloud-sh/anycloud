-- A Deployment record targets exactly one of a Cluster or a node pool. The
-- Cluster column loses NOT NULL and a node pool column joins it under an
-- exclusive-owner CHECK, so the table is rebuilt; rows are copied unchanged
-- with their ids. `workloads` and `container_specs` reference deployments(id)
-- (RESTRICT and CASCADE), so the runner applies this file with foreign keys
-- off and audits `foreign_key_check` before committing; the children's
-- REFERENCES clauses resolve to the renamed table by name.

CREATE TABLE deployments_new (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL CHECK (length(trim(owner_user_id)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  cluster_id TEXT REFERENCES clusters(id) ON DELETE RESTRICT,
  node_pool_id TEXT REFERENCES node_pools(id) ON DELETE RESTRICT,
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
  CHECK ((cluster_id IS NOT NULL) + (node_pool_id IS NOT NULL) = 1),
  CHECK (deletion_requested_at IS NULL OR deletion_requested_at >= created_at),
  CHECK (deleted_at IS NULL OR (
    deletion_requested_at IS NOT NULL AND deleted_at >= deletion_requested_at
  ))
);

INSERT INTO deployments_new (
  id, owner_user_id, name, cluster_id, gpu_count, max_concurrent_jobs_per_replica,
  generation, deletion_requested_at, deleted_at, created_at, updated_at,
  readiness_probe
)
SELECT
  id, owner_user_id, name, cluster_id, gpu_count, max_concurrent_jobs_per_replica,
  generation, deletion_requested_at, deleted_at, created_at, updated_at,
  readiness_probe
FROM deployments
ORDER BY rowid;

DROP TRIGGER deployments_insert_collision;
DROP TRIGGER deployments_identity_immutable;
-- The only trigger on another table that names deployments; recreated below
-- so the schema stays parseable while the table is renamed.
DROP TRIGGER container_specs_no_detach;
DROP INDEX idx_deployments_active_name;
DROP INDEX idx_deployments_cluster;
DROP TABLE deployments;
ALTER TABLE deployments_new RENAME TO deployments;

CREATE TRIGGER container_specs_no_detach BEFORE DELETE ON container_specs
WHEN EXISTS (SELECT 1 FROM workloads WHERE id = OLD.workload_id)
  OR EXISTS (SELECT 1 FROM deployments WHERE id = OLD.deployment_id)
BEGIN
  SELECT RAISE(ABORT, 'container spec owner remains');
END;

CREATE UNIQUE INDEX idx_deployments_active_name ON deployments(lower(name))
  WHERE deleted_at IS NULL;
CREATE INDEX idx_deployments_cluster ON deployments(cluster_id, deleted_at, created_at)
  WHERE cluster_id IS NOT NULL;
-- Node pool admission sums live GPU reservations per node pool.
CREATE INDEX idx_deployments_node_pool
  ON deployments(node_pool_id, deleted_at, gpu_count, created_at)
  WHERE node_pool_id IS NOT NULL;

CREATE TRIGGER deployments_insert_collision BEFORE INSERT ON deployments
WHEN EXISTS (SELECT 1 FROM deployments d WHERE d.rowid = NEW.rowid OR d.id = NEW.id
  OR (NEW.deleted_at IS NULL AND d.deleted_at IS NULL
    AND lower(d.name) = lower(NEW.name)))
BEGIN
  SELECT RAISE(ABORT, 'Deployment identity already exists');
END;

-- The target is immutable: a Deployment never moves between Clusters,
-- between node pools, or from one kind of target to the other.
CREATE TRIGGER deployments_identity_immutable BEFORE UPDATE ON deployments
WHEN NEW.rowid IS NOT OLD.rowid
  OR NEW.id IS NOT OLD.id OR NEW.owner_user_id IS NOT OLD.owner_user_id
  OR NEW.name IS NOT OLD.name OR NEW.cluster_id IS NOT OLD.cluster_id
  OR NEW.node_pool_id IS NOT OLD.node_pool_id
  OR (OLD.deletion_requested_at IS NOT NULL
    AND NEW.deletion_requested_at IS NOT OLD.deletion_requested_at)
  OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT OLD.deleted_at)
BEGIN
  SELECT RAISE(ABORT, 'Deployment identity or deletion lifecycle is immutable');
END;
