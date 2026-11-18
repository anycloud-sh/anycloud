BEGIN TRANSACTION;

DROP INDEX idx_cluster_deployments_active_name;
DROP INDEX idx_cluster_deployments_cluster;
DROP INDEX idx_deployments_cluster_deployment;

ALTER TABLE cluster_deployments RENAME TO workers;
ALTER TABLE deployments RENAME COLUMN cluster_deployment_id TO worker_id;

CREATE UNIQUE INDEX idx_workers_active_name
  ON workers(lower(name))
  WHERE deleted_at IS NULL;

CREATE INDEX idx_workers_cluster
  ON workers(cluster_id, deleted_at, created_at);

CREATE INDEX idx_deployments_worker
  ON deployments(worker_id, state, submitted_at)
  WHERE worker_id IS NOT NULL;

COMMIT;
