-- Fence the current execution of a Job running inside a persistent Deployment.

ALTER TABLE deployments ADD COLUMN current_execution_id TEXT;

CREATE UNIQUE INDEX idx_deployments_current_execution
  ON deployments(current_execution_id)
  WHERE current_execution_id IS NOT NULL;

-- Reject reuse after a retry or resubmission has replaced the row's current
-- fence without scanning the complete event ledger on every next-Job call.
CREATE INDEX idx_events_execution
  ON deployment_events(json_extract(metadata, '$.executionId'))
  WHERE json_valid(metadata)
    AND json_extract(metadata, '$.executionId') IS NOT NULL;

-- Active Deployment names are API-wide. Deleted rows retain historical names
-- and remain addressable by immutable ID.
DROP INDEX idx_cluster_deployments_active_name;

CREATE UNIQUE INDEX idx_cluster_deployments_active_name
  ON cluster_deployments(lower(name))
  WHERE deleted_at IS NULL;
