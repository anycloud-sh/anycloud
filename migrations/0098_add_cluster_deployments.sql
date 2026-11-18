-- Persistent Kubernetes workloads that accept finite Anycloud Jobs.

CREATE TABLE cluster_deployments (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL CHECK (length(trim(owner_user_id)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  cluster_id TEXT NOT NULL REFERENCES clusters(id) ON DELETE RESTRICT,
  template TEXT NOT NULL CHECK (length(template) > 0),
  max_concurrent_jobs_per_replica INTEGER NOT NULL DEFAULT 1,
  generation INTEGER NOT NULL DEFAULT 1,
  deletion_requested_at INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    typeof(max_concurrent_jobs_per_replica) = 'integer'
    AND max_concurrent_jobs_per_replica > 0
  ),
  CHECK (typeof(generation) = 'integer' AND generation > 0),
  CHECK (
    deletion_requested_at IS NULL
    OR deletion_requested_at >= created_at
  ),
  CHECK (
    deleted_at IS NULL
    OR (
      deletion_requested_at IS NOT NULL
      AND deleted_at >= deletion_requested_at
    )
  )
);

CREATE UNIQUE INDEX idx_cluster_deployments_active_name
  ON cluster_deployments(owner_user_id, name COLLATE NOCASE)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_cluster_deployments_cluster
  ON cluster_deployments(cluster_id, deleted_at, created_at);

ALTER TABLE deployments ADD COLUMN cluster_deployment_id TEXT
  REFERENCES cluster_deployments(id) ON DELETE RESTRICT;

CREATE INDEX idx_deployments_cluster_deployment
  ON deployments(cluster_deployment_id, state, submitted_at)
  WHERE cluster_deployment_id IS NOT NULL;
