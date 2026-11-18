-- An existing Slurm cluster the user can already log in to, attached on their
-- own local API. The record holds the alias from the user's own SSH config and
-- the site profile preflight read; never a key, host key, user or host.
CREATE TABLE slurm_clusters (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL CHECK (length(trim(owner_user_id)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  login_alias TEXT NOT NULL CHECK (length(trim(login_alias)) > 0),
  workdir TEXT NOT NULL CHECK (substr(workdir, 1, 1) = '/'),
  arch TEXT NOT NULL CHECK (arch IN ('amd64', 'arm64')),
  max_walltime_seconds INTEGER CHECK (max_walltime_seconds > 0),
  gpus_per_node INTEGER NOT NULL CHECK (gpus_per_node > 0),
  last_checked_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_slurm_clusters_owner_name
  ON slurm_clusters(owner_user_id, name COLLATE NOCASE);

-- A Slurm Job carries its cluster, and no other target. The column is a
-- reference, not a foreign key: detach removes a cluster that only cleaned-up
-- Jobs still name, and they keep the id as history.
ALTER TABLE workloads ADD COLUMN slurm_cluster_id TEXT CHECK (
  slurm_cluster_id IS NULL
  OR (workload_type = 'job' AND deployment_id IS NULL AND node_pool_id IS NULL)
);

CREATE INDEX idx_workloads_slurm_cluster
  ON workloads(slurm_cluster_id, cleaned_at)
  WHERE slurm_cluster_id IS NOT NULL;

CREATE TRIGGER workloads_slurm_cluster_exists BEFORE INSERT ON workloads
WHEN NEW.slurm_cluster_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM slurm_clusters c WHERE c.id = NEW.slurm_cluster_id
)
BEGIN
  SELECT RAISE(ABORT, 'Slurm cluster not found');
END;

CREATE TRIGGER slurm_clusters_detach_requires_no_live_jobs
BEFORE DELETE ON slurm_clusters
WHEN EXISTS (
  SELECT 1 FROM workloads w
  WHERE w.slurm_cluster_id = OLD.id AND w.cleaned_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'Slurm cluster still has live Jobs');
END;

DROP TRIGGER workloads_identity_immutable;
CREATE TRIGGER workloads_identity_immutable BEFORE UPDATE ON workloads
WHEN NEW.rowid IS NOT OLD.rowid
  OR NEW.id IS NOT OLD.id OR NEW.workload_type IS NOT OLD.workload_type
  OR NEW.deployment_id IS NOT OLD.deployment_id
  OR NEW.node_pool_id IS NOT OLD.node_pool_id
  OR NEW.slurm_cluster_id IS NOT OLD.slurm_cluster_id
  OR NEW.user_id IS NOT OLD.user_id
  OR NEW.owner_user_id IS NOT OLD.owner_user_id
BEGIN
  SELECT RAISE(ABORT, 'workload identity and target are immutable');
END;
