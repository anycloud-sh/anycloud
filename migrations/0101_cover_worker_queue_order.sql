DROP INDEX idx_deployments_worker;

CREATE INDEX idx_deployments_worker
  ON deployments(worker_id, state, submitted_at, id)
  WHERE worker_id IS NOT NULL;
