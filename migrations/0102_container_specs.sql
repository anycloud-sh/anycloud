-- Startup validates VM container values and prepares registry identities.
-- Workers must be empty; the runner owns the transaction and FK switch.
-- Rebuild under temporary destination names: renaming a source parent would
-- rewrite the unchanged event/VM/Job foreign keys to the temporary name.
CREATE TABLE workers_new (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL CHECK (length(trim(owner_user_id)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  cluster_id TEXT NOT NULL REFERENCES clusters(id) ON DELETE RESTRICT,
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
  CHECK (deletion_requested_at IS NULL OR deletion_requested_at >= created_at),
  CHECK (deleted_at IS NULL OR (
    deletion_requested_at IS NOT NULL AND deleted_at >= deletion_requested_at
  ))
);

CREATE TABLE deployments_new (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  owner_user_id TEXT,
  deployment_type TEXT NOT NULL CHECK (deployment_type IN ('job', 'service', 'vm')),
  worker_id TEXT REFERENCES workers(id) ON DELETE RESTRICT,
  current_execution_id TEXT,
  state TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  submitted_at INTEGER,
  completed_at INTEGER,
  cleaned_at INTEGER,
  cleanup_attempts INTEGER,
  docker_command TEXT NOT NULL,
  region TEXT,
  vm_type TEXT,
  gpu_type TEXT,
  spot INTEGER DEFAULT 0,
  availability_zone TEXT,
  credential_id TEXT,
  requested_compute_provider TEXT,
  disk_size_gb INTEGER,
  disk_tier TEXT,
  image_runtime TEXT,
  ssh_private_key TEXT NOT NULL DEFAULT '',
  secret_names TEXT,
  input_bucket TEXT,
  input_storage_credential_id TEXT REFERENCES credentials(id) ON DELETE RESTRICT,
  input_storage_region TEXT,
  output_bucket TEXT,
  output_storage_credential_id TEXT REFERENCES credentials(id) ON DELETE RESTRICT,
  output_storage_region TEXT,
  checkpoint_bucket TEXT,
  checkpoint_storage_credential_id TEXT REFERENCES credentials(id) ON DELETE RESTRICT,
  checkpoint_storage_region TEXT,
  dns_record_id TEXT,
  session TEXT,
  agent TEXT,
  session_label TEXT,
  CHECK (
    (worker_id IS NULL AND current_execution_id IS NULL)
    OR (worker_id IS NOT NULL AND deployment_type = 'job')
  )
);

INSERT INTO deployments_new (
  id, user_id, owner_user_id, deployment_type, worker_id, current_execution_id,
  state, started_at, submitted_at, completed_at,
  cleaned_at, cleanup_attempts, docker_command, region, vm_type, gpu_type, spot,
  availability_zone, credential_id, requested_compute_provider, disk_size_gb,
  disk_tier, image_runtime, ssh_private_key, secret_names, input_bucket,
  input_storage_credential_id, input_storage_region, output_bucket,
  output_storage_credential_id, output_storage_region, checkpoint_bucket,
  checkpoint_storage_credential_id, checkpoint_storage_region, dns_record_id,
  session, agent, session_label
)
SELECT id, user_id, owner_user_id, deployment_type, worker_id, current_execution_id,
  state, started_at, submitted_at, completed_at, cleaned_at, cleanup_attempts,
  docker_command, region, vm_type, gpu_type, spot, availability_zone,
  credential_id, requested_compute_provider, disk_size_gb, disk_tier,
  image_runtime, ssh_private_key, secret_names, input_bucket,
  input_storage_credential_id, input_storage_region, output_bucket,
  output_storage_credential_id, output_storage_region, checkpoint_bucket,
  checkpoint_storage_credential_id, checkpoint_storage_region, dns_record_id,
  session, agent, session_label
FROM deployments;

DROP TABLE deployments;
DROP TABLE workers;
ALTER TABLE workers_new RENAME TO workers;
ALTER TABLE deployments_new RENAME TO deployments;

CREATE UNIQUE INDEX idx_workers_active_name ON workers(lower(name))
  WHERE deleted_at IS NULL;
CREATE INDEX idx_workers_cluster ON workers(cluster_id, deleted_at, created_at);
CREATE INDEX idx_deployments_user ON deployments(user_id, started_at DESC);
CREATE INDEX idx_deployments_state ON deployments(user_id, state);
CREATE INDEX idx_deployments_credential ON deployments(credential_id);
CREATE INDEX idx_deployments_session ON deployments(session) WHERE session IS NOT NULL;
CREATE INDEX idx_deployments_agent ON deployments(agent) WHERE agent IS NOT NULL;
CREATE INDEX idx_deployments_state_started ON deployments(state, started_at);
CREATE INDEX idx_deployments_state_completed ON deployments(state, completed_at)
  WHERE completed_at IS NOT NULL;
CREATE INDEX idx_deployments_submitted_at ON deployments(submitted_at);
CREATE INDEX idx_deployments_pending_cleanup ON deployments(state, completed_at)
  WHERE completed_at IS NOT NULL AND cleaned_at IS NULL;
CREATE INDEX idx_deployments_owner_user ON deployments(owner_user_id, started_at DESC)
  WHERE owner_user_id IS NOT NULL;
CREATE INDEX idx_deployments_owner_state ON deployments(owner_user_id, state)
  WHERE owner_user_id IS NOT NULL;
CREATE INDEX idx_deployments_legacy_user ON deployments(user_id COLLATE NOCASE, started_at DESC)
  WHERE owner_user_id IS NULL;
CREATE INDEX idx_deployments_legacy_state ON deployments(user_id COLLATE NOCASE, state)
  WHERE owner_user_id IS NULL;
CREATE UNIQUE INDEX idx_deployments_current_execution ON deployments(current_execution_id)
  WHERE current_execution_id IS NOT NULL;
CREATE INDEX idx_deployments_worker ON deployments(worker_id, state, submitted_at, id)
  WHERE worker_id IS NOT NULL;

CREATE TABLE container_specs (
  deployment_id TEXT UNIQUE REFERENCES deployments(id) ON DELETE CASCADE,
  worker_id TEXT UNIQUE REFERENCES workers(id) ON DELETE CASCADE,
  image TEXT NOT NULL CHECK (length(trim(image)) > 0),
  image_digest TEXT,
  command TEXT CHECK (
    CASE WHEN command IS NULL THEN 1
      WHEN json_valid(command) THEN json_type(command) = 'array' ELSE 0 END
  ),
  docker_options TEXT CHECK (
    CASE WHEN docker_options IS NULL THEN 1
      WHEN json_valid(docker_options) THEN json_type(docker_options) = 'object' ELSE 0 END
  ),
  env TEXT CHECK (env IS NULL OR length(env) > 0),
  registry_username TEXT NOT NULL CHECK (length(registry_username) > 0),
  registry_token TEXT CHECK (registry_token IS NULL OR length(registry_token) > 0),
  CHECK ((deployment_id IS NOT NULL AND worker_id IS NULL)
    OR (deployment_id IS NULL AND worker_id IS NOT NULL))
);

CREATE TRIGGER container_specs_insert_collision BEFORE INSERT ON container_specs
WHEN EXISTS (
  SELECT 1 FROM container_specs s WHERE (NEW.deployment_id IS NOT NULL AND s.deployment_id = NEW.deployment_id)
    OR (NEW.worker_id IS NOT NULL AND s.worker_id = NEW.worker_id)
    OR s.rowid = NEW.rowid
)
BEGIN
  SELECT RAISE(ABORT, 'container spec already exists');
END;

CREATE TRIGGER container_specs_deployment_owner BEFORE INSERT ON container_specs
WHEN NEW.deployment_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM deployments d WHERE d.id = NEW.deployment_id
    AND d.worker_id IS NULL AND d.deployment_type IN ('job', 'service', 'vm')
)
BEGIN
  SELECT RAISE(ABORT, 'container spec requires a VM-host owner');
END;

CREATE TRIGGER container_specs_owner_immutable BEFORE UPDATE ON container_specs
WHEN NEW.rowid IS NOT OLD.rowid
  OR NEW.deployment_id IS NOT OLD.deployment_id
  OR NEW.worker_id IS NOT OLD.worker_id
BEGIN
  SELECT RAISE(ABORT, 'container spec owner is immutable');
END;

CREATE TRIGGER container_specs_fixed_deployment BEFORE UPDATE ON container_specs
WHEN EXISTS (SELECT 1 FROM deployments d WHERE d.id = OLD.deployment_id
  AND d.deployment_type IN ('job', 'vm'))
BEGIN
  SELECT RAISE(ABORT, 'admitted Job or VM container spec is immutable');
END;

CREATE TRIGGER container_specs_no_detach BEFORE DELETE ON container_specs
WHEN EXISTS (SELECT 1 FROM deployments WHERE id = OLD.deployment_id)
  OR EXISTS (SELECT 1 FROM workers WHERE id = OLD.worker_id)
BEGIN
  SELECT RAISE(ABORT, 'container spec owner remains');
END;

CREATE TRIGGER deployments_identity_immutable BEFORE UPDATE ON deployments
WHEN NEW.rowid IS NOT OLD.rowid
  OR NEW.id IS NOT OLD.id OR NEW.deployment_type IS NOT OLD.deployment_type
  OR NEW.worker_id IS NOT OLD.worker_id OR NEW.user_id IS NOT OLD.user_id
  OR NEW.owner_user_id IS NOT OLD.owner_user_id
BEGIN
  SELECT RAISE(ABORT, 'deployment identity and target are immutable');
END;

CREATE TRIGGER deployments_insert_collision BEFORE INSERT ON deployments
WHEN EXISTS (SELECT 1 FROM deployments d WHERE d.rowid = NEW.rowid OR d.id = NEW.id
  OR (NEW.current_execution_id IS NOT NULL
    AND d.current_execution_id = NEW.current_execution_id))
BEGIN
  SELECT RAISE(ABORT, 'deployment identity already exists');
END;

CREATE TRIGGER deployments_execution_collision BEFORE UPDATE ON deployments
WHEN NEW.current_execution_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM deployments d WHERE d.id <> OLD.id
    AND d.current_execution_id = NEW.current_execution_id)
BEGIN
  SELECT RAISE(ABORT, 'execution identity already exists');
END;

CREATE TRIGGER workers_insert_collision BEFORE INSERT ON workers
WHEN EXISTS (SELECT 1 FROM workers w WHERE w.rowid = NEW.rowid OR w.id = NEW.id
  OR (NEW.deleted_at IS NULL AND w.deleted_at IS NULL
    AND lower(w.name) = lower(NEW.name)))
BEGIN
  SELECT RAISE(ABORT, 'Worker identity already exists');
END;

CREATE TRIGGER workers_identity_immutable BEFORE UPDATE ON workers
WHEN NEW.rowid IS NOT OLD.rowid
  OR NEW.id IS NOT OLD.id OR NEW.owner_user_id IS NOT OLD.owner_user_id
  OR NEW.name IS NOT OLD.name OR NEW.cluster_id IS NOT OLD.cluster_id
  OR (OLD.deletion_requested_at IS NOT NULL
    AND NEW.deletion_requested_at IS NOT OLD.deletion_requested_at)
  OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT OLD.deleted_at)
BEGIN
  SELECT RAISE(ABORT, 'Worker identity or deletion lifecycle is immutable');
END;
