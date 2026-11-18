-- Rename the shared Job/Service/VM record without rebuilding or rewriting data.
-- Provider metadata and native Kubernetes Deployment identities are not SQL names.
-- The migration runner owns the transaction and audits ownership before commit.

-- Remove guards while their referenced tables and columns change together.
DROP TRIGGER container_specs_deployment_owner;
DROP TRIGGER container_specs_fixed_deployment;
DROP TRIGGER container_specs_insert_collision;
DROP TRIGGER container_specs_no_detach;
DROP TRIGGER container_specs_owner_immutable;
DROP TRIGGER deployments_execution_collision;
DROP TRIGGER deployments_identity_immutable;
DROP TRIGGER deployments_insert_collision;

ALTER TABLE deployments RENAME TO workloads;
ALTER TABLE workloads RENAME COLUMN deployment_type TO workload_type;
ALTER TABLE deployment_events RENAME TO workload_events;
ALTER TABLE workload_events RENAME COLUMN deployment_id TO workload_id;
ALTER TABLE vms RENAME COLUMN deployment_id TO workload_id;
ALTER TABLE container_specs RENAME COLUMN deployment_id TO workload_id;

-- ALTER updates index definitions but keeps their names.
DROP INDEX idx_deployments_agent;
CREATE INDEX idx_workloads_agent ON workloads(agent) WHERE agent IS NOT NULL;
DROP INDEX idx_deployments_claim_deadline;
CREATE INDEX idx_workloads_claim_deadline
  ON workloads(claim_deadline_at, id)
  WHERE worker_id IS NOT NULL AND first_claimed_at IS NULL
    AND claim_deadline_at IS NOT NULL AND state = 'queued';
DROP INDEX idx_deployments_credential;
CREATE INDEX idx_workloads_credential ON workloads(credential_id);
DROP INDEX idx_deployments_current_execution;
CREATE UNIQUE INDEX idx_workloads_current_execution ON workloads(current_execution_id)
  WHERE current_execution_id IS NOT NULL;
DROP INDEX idx_deployments_legacy_state;
CREATE INDEX idx_workloads_legacy_state ON workloads(user_id COLLATE NOCASE, state)
  WHERE owner_user_id IS NULL;
DROP INDEX idx_deployments_legacy_user;
CREATE INDEX idx_workloads_legacy_user ON workloads(user_id COLLATE NOCASE, started_at DESC)
  WHERE owner_user_id IS NULL;
DROP INDEX idx_deployments_owner_state;
CREATE INDEX idx_workloads_owner_state ON workloads(owner_user_id, state)
  WHERE owner_user_id IS NOT NULL;
DROP INDEX idx_deployments_owner_user;
CREATE INDEX idx_workloads_owner_user ON workloads(owner_user_id, started_at DESC)
  WHERE owner_user_id IS NOT NULL;
DROP INDEX idx_deployments_pending_cleanup;
CREATE INDEX idx_workloads_pending_cleanup ON workloads(state, completed_at)
  WHERE completed_at IS NOT NULL AND cleaned_at IS NULL;
DROP INDEX idx_deployments_session;
CREATE INDEX idx_workloads_session ON workloads(session) WHERE session IS NOT NULL;
DROP INDEX idx_deployments_state;
CREATE INDEX idx_workloads_state ON workloads(user_id, state);
DROP INDEX idx_deployments_state_completed;
CREATE INDEX idx_workloads_state_completed ON workloads(state, completed_at)
  WHERE completed_at IS NOT NULL;
DROP INDEX idx_deployments_state_started;
CREATE INDEX idx_workloads_state_started ON workloads(state, started_at);
DROP INDEX idx_deployments_submitted_at;
CREATE INDEX idx_workloads_submitted_at ON workloads(submitted_at);
DROP INDEX idx_deployments_user;
CREATE INDEX idx_workloads_user ON workloads(user_id, started_at DESC);
DROP INDEX idx_deployments_worker;
CREATE INDEX idx_workloads_worker
  ON workloads(worker_id, state, submitted_at, id,
                 first_claimed_at, claim_deadline_at, submission_revision,
                 current_execution_id)
  WHERE worker_id IS NOT NULL;
DROP INDEX idx_events_deployment;
CREATE INDEX idx_events_workload ON workload_events(workload_id, created_at);
DROP INDEX idx_events_deployment_id;
CREATE INDEX idx_events_workload_id
  ON workload_events(workload_id, id);
DROP INDEX idx_events_state_deployment;
CREATE INDEX idx_events_state_workload
  ON workload_events(state, workload_id, created_at);
DROP INDEX idx_vms_deployment_attempt;
CREATE UNIQUE INDEX idx_vms_workload_attempt
  ON vms(workload_id, cloud_id, created_at)
  WHERE workload_id IS NOT NULL;
DROP INDEX idx_vms_deployment_id;
CREATE INDEX idx_vms_workload_id ON vms(workload_id);

-- Restore the existing ownership, identity and execution guards.
CREATE TRIGGER container_specs_workload_owner BEFORE INSERT ON container_specs
WHEN NEW.workload_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workloads d WHERE d.id = NEW.workload_id
    AND d.worker_id IS NULL AND d.workload_type IN ('job', 'service', 'vm')
)
BEGIN
  SELECT RAISE(ABORT, 'container spec requires a VM-host owner');
END;

CREATE TRIGGER container_specs_fixed_workload BEFORE UPDATE ON container_specs
WHEN EXISTS (SELECT 1 FROM workloads d WHERE d.id = OLD.workload_id
  AND d.workload_type IN ('job', 'vm'))
BEGIN
  SELECT RAISE(ABORT, 'admitted Job or VM container spec is immutable');
END;

CREATE TRIGGER container_specs_insert_collision BEFORE INSERT ON container_specs
WHEN EXISTS (
  SELECT 1 FROM container_specs s WHERE (NEW.workload_id IS NOT NULL AND s.workload_id = NEW.workload_id)
    OR (NEW.worker_id IS NOT NULL AND s.worker_id = NEW.worker_id)
    OR s.rowid = NEW.rowid
)
BEGIN
  SELECT RAISE(ABORT, 'container spec already exists');
END;

CREATE TRIGGER container_specs_no_detach BEFORE DELETE ON container_specs
WHEN EXISTS (SELECT 1 FROM workloads WHERE id = OLD.workload_id)
  OR EXISTS (SELECT 1 FROM workers WHERE id = OLD.worker_id)
BEGIN
  SELECT RAISE(ABORT, 'container spec owner remains');
END;

CREATE TRIGGER container_specs_owner_immutable BEFORE UPDATE ON container_specs
WHEN NEW.rowid IS NOT OLD.rowid
  OR NEW.workload_id IS NOT OLD.workload_id
  OR NEW.worker_id IS NOT OLD.worker_id
BEGIN
  SELECT RAISE(ABORT, 'container spec owner is immutable');
END;

CREATE TRIGGER workloads_execution_collision BEFORE UPDATE ON workloads
WHEN NEW.current_execution_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM workloads d WHERE d.id <> OLD.id
    AND d.current_execution_id = NEW.current_execution_id)
BEGIN
  SELECT RAISE(ABORT, 'execution identity already exists');
END;

CREATE TRIGGER workloads_identity_immutable BEFORE UPDATE ON workloads
WHEN NEW.rowid IS NOT OLD.rowid
  OR NEW.id IS NOT OLD.id OR NEW.workload_type IS NOT OLD.workload_type
  OR NEW.worker_id IS NOT OLD.worker_id OR NEW.user_id IS NOT OLD.user_id
  OR NEW.owner_user_id IS NOT OLD.owner_user_id
BEGIN
  SELECT RAISE(ABORT, 'workload identity and target are immutable');
END;

CREATE TRIGGER workloads_insert_collision BEFORE INSERT ON workloads
WHEN EXISTS (SELECT 1 FROM workloads d WHERE d.rowid = NEW.rowid OR d.id = NEW.id
  OR (NEW.current_execution_id IS NOT NULL
    AND d.current_execution_id = NEW.current_execution_id))
BEGIN
  SELECT RAISE(ABORT, 'workload identity already exists');
END;
