-- Phase 2b removes Kubernetes Deployments, the Jobs that target them (pool
-- Jobs included), node pool Services and registered Deployments' API access.
-- The runner refuses to apply this while any of them is still live
-- (repositories/removed-workloads-guard.ts), so what remains is history: it
-- goes with the feature. `workloads` and `container_specs` are rebuilt
-- without the columns only those used (targets, claim fences, the public
-- endpoint view, the runner's entrypoint); other tables reference
-- `workloads` by name and are not touched. Foreign keys are off for this
-- file and `foreign_key_check` gates the commit.

DELETE FROM api_access_users WHERE user_id LIKE 'serviceaccount:%';

DROP TRIGGER container_specs_fixed_workload;
DROP TRIGGER container_specs_insert_collision;
DROP TRIGGER container_specs_owner_immutable;
DROP TRIGGER container_specs_no_detach;
DROP TRIGGER container_specs_workload_owner;
DROP TRIGGER workloads_execution_collision;
DROP TRIGGER workloads_insert_collision;
DROP TRIGGER workloads_node_pool_target;
DROP TRIGGER workloads_identity_immutable;
DROP TRIGGER workloads_node_pool_accepts;
DROP TRIGGER node_pools_deletion_requires_no_services;

CREATE TEMP TABLE removed_workloads AS
  SELECT id FROM workloads
  WHERE deployment_id IS NOT NULL OR node_pool_id IS NOT NULL;
DELETE FROM api_ownership_backfill_targets WHERE vm_id IN (
  SELECT id FROM vms WHERE workload_id IN (SELECT id FROM removed_workloads)
);
DELETE FROM vms WHERE workload_id IN (SELECT id FROM removed_workloads);
DELETE FROM workload_events
  WHERE workload_id IN (SELECT id FROM removed_workloads);
DELETE FROM container_specs
  WHERE deployment_id IS NOT NULL
     OR workload_id IN (SELECT id FROM removed_workloads);
DELETE FROM workloads WHERE id IN (SELECT id FROM removed_workloads);
DROP TABLE removed_workloads;

DROP TABLE pool_occupancy;
DROP TABLE pod_attempts;
DROP TABLE workload_attempts;

CREATE TABLE container_specs_new (
  workload_id TEXT NOT NULL UNIQUE REFERENCES "workloads"(id) ON DELETE CASCADE,
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
  registry_token TEXT CHECK (registry_token IS NULL OR length(registry_token) > 0)
);
INSERT INTO container_specs_new (
  rowid, workload_id, image, image_digest, command, docker_options, env,
  registry_username, registry_token
)
SELECT rowid, workload_id, image, image_digest, command, docker_options, env,
  registry_username, registry_token
FROM container_specs;
DROP TABLE container_specs;
ALTER TABLE container_specs_new RENAME TO container_specs;

CREATE TABLE workloads_new (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  owner_user_id TEXT,
  workload_type TEXT NOT NULL CHECK (workload_type IN ('job', 'service', 'vm')),
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
  cleanup_error TEXT,
  end_reason TEXT,
  last_attempt_end_reason TEXT,
  max_retries INTEGER,
  no_checkpoint INTEGER NOT NULL DEFAULT 0,
  require_nested_virtualization INTEGER NOT NULL DEFAULT 0,
  host_docker INTEGER NOT NULL DEFAULT 0,
  disk_iops INTEGER,
  disk_throughput_mibps INTEGER,
  regions TEXT
);
INSERT INTO workloads_new (
  rowid, id, user_id, owner_user_id, workload_type, state, started_at,
  submitted_at, completed_at, cleaned_at, cleanup_attempts, docker_command,
  region, vm_type, gpu_type, spot, availability_zone, credential_id,
  requested_compute_provider, disk_size_gb, disk_tier, image_runtime,
  ssh_private_key, secret_names, input_bucket, input_storage_credential_id,
  input_storage_region, output_bucket, output_storage_credential_id,
  output_storage_region, checkpoint_bucket, checkpoint_storage_credential_id,
  checkpoint_storage_region, dns_record_id, session, agent, session_label,
  cleanup_error, end_reason, last_attempt_end_reason, max_retries,
  no_checkpoint, require_nested_virtualization, host_docker, disk_iops,
  disk_throughput_mibps, regions
)
SELECT
  rowid, id, user_id, owner_user_id, workload_type, state, started_at,
  submitted_at, completed_at, cleaned_at, cleanup_attempts, docker_command,
  region, vm_type, gpu_type, spot, availability_zone, credential_id,
  requested_compute_provider, disk_size_gb, disk_tier, image_runtime,
  ssh_private_key, secret_names, input_bucket, input_storage_credential_id,
  input_storage_region, output_bucket, output_storage_credential_id,
  output_storage_region, checkpoint_bucket, checkpoint_storage_credential_id,
  checkpoint_storage_region, dns_record_id, session, agent, session_label,
  cleanup_error, end_reason, last_attempt_end_reason, max_retries,
  no_checkpoint, require_nested_virtualization, host_docker, disk_iops,
  disk_throughput_mibps, regions
FROM workloads;
DROP TABLE workloads;
ALTER TABLE workloads_new RENAME TO workloads;
DROP TABLE deployments;

CREATE INDEX idx_workloads_agent ON workloads(agent) WHERE agent IS NOT NULL;
CREATE INDEX idx_workloads_credential ON workloads(credential_id);
CREATE INDEX idx_workloads_legacy_state ON workloads(user_id COLLATE NOCASE, state)
  WHERE owner_user_id IS NULL;
CREATE INDEX idx_workloads_legacy_user ON workloads(user_id COLLATE NOCASE, started_at DESC)
  WHERE owner_user_id IS NULL;
CREATE INDEX idx_workloads_owner_state ON workloads(owner_user_id, state)
  WHERE owner_user_id IS NOT NULL;
CREATE INDEX idx_workloads_owner_user ON workloads(owner_user_id, started_at DESC)
  WHERE owner_user_id IS NOT NULL;
CREATE INDEX idx_workloads_pending_cleanup ON workloads(state, completed_at)
  WHERE completed_at IS NOT NULL AND cleaned_at IS NULL;
CREATE INDEX idx_workloads_session ON workloads(session) WHERE session IS NOT NULL;
CREATE INDEX idx_workloads_state ON workloads(user_id, state);
CREATE INDEX idx_workloads_state_completed ON workloads(state, completed_at)
  WHERE completed_at IS NOT NULL;
CREATE INDEX idx_workloads_state_started ON workloads(state, started_at);
CREATE INDEX idx_workloads_submitted_at ON workloads(submitted_at);
CREATE INDEX idx_workloads_user ON workloads(user_id, started_at DESC);

CREATE TRIGGER workloads_insert_collision BEFORE INSERT ON workloads
WHEN EXISTS (SELECT 1 FROM workloads d WHERE d.rowid = NEW.rowid OR d.id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'workload identity already exists');
END;

CREATE TRIGGER workloads_identity_immutable BEFORE UPDATE ON workloads
WHEN NEW.rowid IS NOT OLD.rowid
  OR NEW.id IS NOT OLD.id OR NEW.workload_type IS NOT OLD.workload_type
  OR NEW.user_id IS NOT OLD.user_id
  OR NEW.owner_user_id IS NOT OLD.owner_user_id
BEGIN
  SELECT RAISE(ABORT, 'workload identity is immutable');
END;

CREATE TRIGGER container_specs_fixed_workload BEFORE UPDATE ON container_specs
WHEN EXISTS (SELECT 1 FROM workloads d WHERE d.id = OLD.workload_id
  AND d.workload_type IN ('job', 'vm'))
BEGIN
  SELECT RAISE(ABORT, 'admitted Job or VM container spec is immutable');
END;

CREATE TRIGGER container_specs_insert_collision BEFORE INSERT ON container_specs
WHEN EXISTS (
  SELECT 1 FROM container_specs s
  WHERE s.workload_id = NEW.workload_id OR s.rowid = NEW.rowid
)
BEGIN
  SELECT RAISE(ABORT, 'container spec already exists');
END;

CREATE TRIGGER container_specs_owner_immutable BEFORE UPDATE ON container_specs
WHEN NEW.rowid IS NOT OLD.rowid OR NEW.workload_id IS NOT OLD.workload_id
BEGIN
  SELECT RAISE(ABORT, 'container spec owner is immutable');
END;

CREATE TRIGGER container_specs_no_detach BEFORE DELETE ON container_specs
WHEN EXISTS (SELECT 1 FROM workloads WHERE id = OLD.workload_id)
BEGIN
  SELECT RAISE(ABORT, 'container spec owner remains');
END;

CREATE TRIGGER container_specs_workload_owner BEFORE INSERT ON container_specs
WHEN NOT EXISTS (
  SELECT 1 FROM workloads d
  WHERE d.id = NEW.workload_id AND d.workload_type IN ('job', 'service', 'vm')
)
BEGIN
  SELECT RAISE(ABORT, 'container spec requires a Workload owner');
END;
