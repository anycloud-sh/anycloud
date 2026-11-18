-- Rename the persistent Kubernetes application without rewriting its records.
-- Workloads remain the shared Job/Service/VM records. SQLite updates all foreign
-- keys, checks and unnamed guards when their referenced tables/columns change.
-- The runner audits ownership inside the same transaction before its receipt.

DROP TRIGGER workers_insert_collision;
DROP TRIGGER workers_identity_immutable;

ALTER TABLE workers RENAME TO deployments;
ALTER TABLE workloads RENAME COLUMN worker_id TO deployment_id;
ALTER TABLE container_specs RENAME COLUMN worker_id TO deployment_id;

-- ALTER preserves index names, so recreate the named indexes with the same keys.
DROP INDEX idx_workers_active_name;
CREATE UNIQUE INDEX idx_deployments_active_name ON deployments(lower(name))
  WHERE deleted_at IS NULL;
DROP INDEX idx_workers_cluster;
CREATE INDEX idx_deployments_cluster ON deployments(cluster_id, deleted_at, created_at);
DROP INDEX idx_workloads_worker;
CREATE INDEX idx_workloads_deployment
  ON workloads(deployment_id, state, submitted_at, id,
               first_claimed_at, claim_deadline_at, submission_revision,
               current_execution_id)
  WHERE deployment_id IS NOT NULL;

CREATE TRIGGER deployments_insert_collision BEFORE INSERT ON deployments
WHEN EXISTS (SELECT 1 FROM deployments d WHERE d.rowid = NEW.rowid OR d.id = NEW.id
  OR (NEW.deleted_at IS NULL AND d.deleted_at IS NULL
    AND lower(d.name) = lower(NEW.name)))
BEGIN
  SELECT RAISE(ABORT, 'Deployment identity already exists');
END;

CREATE TRIGGER deployments_identity_immutable BEFORE UPDATE ON deployments
WHEN NEW.rowid IS NOT OLD.rowid
  OR NEW.id IS NOT OLD.id OR NEW.owner_user_id IS NOT OLD.owner_user_id
  OR NEW.name IS NOT OLD.name OR NEW.cluster_id IS NOT OLD.cluster_id
  OR (OLD.deletion_requested_at IS NOT NULL
    AND NEW.deletion_requested_at IS NOT OLD.deletion_requested_at)
  OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT OLD.deleted_at)
BEGIN
  SELECT RAISE(ABORT, 'Deployment identity or deletion lifecycle is immutable');
END;
