-- One row per try of a Job (RFC 0044 decision 24, Class Table Inheritance).
-- The base holds only substrate-neutral facts; each substrate keeps its own
-- facts in a 1:1 extension keyed by the attempt. recordAttemptOutcome is the
-- only writer that closes an attempt, and it never writes an extension.
CREATE TABLE workload_attempts (
  id INTEGER PRIMARY KEY,
  workload_id TEXT NOT NULL REFERENCES workloads(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  execution_id TEXT NOT NULL UNIQUE,
  generation INTEGER,
  substrate TEXT NOT NULL CHECK (substrate IN ('pod', 'slurm')),
  outcome TEXT CHECK (outcome IN
    ('completed', 'errored', 'failed', 'invalid', 'retrying', 'terminated')),
  cause TEXT,
  exit_code INTEGER,
  reason TEXT,
  log_tail TEXT,
  log_tail_state TEXT,
  opened_at INTEGER NOT NULL,
  ended_at INTEGER,
  UNIQUE (workload_id, attempt),
  CHECK ((outcome IS NULL) = (ended_at IS NULL))
);

CREATE TRIGGER workload_attempts_identity_immutable
BEFORE UPDATE OF workload_id, attempt, execution_id, substrate ON workload_attempts
BEGIN
  SELECT RAISE(ABORT, 'workload attempt identity is immutable');
END;

-- A closed attempt is a read-only record: once ended_at is set, its end facts
-- never change, not even from NULL (the CHECK ties outcome to ended_at). The
-- log tail may go from NULL to a value once, after the close.
CREATE TRIGGER workload_attempts_write_once BEFORE UPDATE ON workload_attempts
WHEN (OLD.ended_at IS NOT NULL AND (
    NEW.ended_at IS NOT OLD.ended_at OR NEW.outcome IS NOT OLD.outcome
    OR NEW.cause IS NOT OLD.cause OR NEW.exit_code IS NOT OLD.exit_code
    OR NEW.reason IS NOT OLD.reason))
  OR (OLD.log_tail IS NOT NULL AND NEW.log_tail IS NOT OLD.log_tail)
  OR (OLD.log_tail_state IS NOT NULL
    AND NEW.log_tail_state IS NOT OLD.log_tail_state)
BEGIN
  SELECT RAISE(ABORT, 'workload attempt facts are written once');
END;

-- The Pod facts of a 'pod' attempt, written by the Pod owner in its own
-- transaction. The primary key allows one row per attempt; the triggers allow
-- it only on a 'pod' attempt, never move it, and write each fact once.
CREATE TABLE pod_attempts (
  attempt_id INTEGER PRIMARY KEY
    REFERENCES workload_attempts(id) ON DELETE CASCADE,
  pod_uid TEXT,
  container_id TEXT,
  node TEXT
);

CREATE TRIGGER pod_attempts_substrate BEFORE INSERT ON pod_attempts
WHEN (SELECT substrate FROM workload_attempts WHERE id = NEW.attempt_id)
  IS NOT 'pod'
BEGIN
  SELECT RAISE(ABORT, 'pod_attempts requires a pod attempt');
END;

CREATE TRIGGER pod_attempts_owner_immutable
BEFORE UPDATE OF attempt_id ON pod_attempts
BEGIN
  SELECT RAISE(ABORT, 'pod attempt owner is immutable');
END;

CREATE TRIGGER pod_attempts_write_once BEFORE UPDATE ON pod_attempts
WHEN (OLD.pod_uid IS NOT NULL AND NEW.pod_uid IS NOT OLD.pod_uid)
  OR (OLD.container_id IS NOT NULL AND NEW.container_id IS NOT OLD.container_id)
  OR (OLD.node IS NOT NULL AND NEW.node IS NOT OLD.node)
BEGIN
  SELECT RAISE(ABORT, 'pod attempt facts are written once');
END;

-- Targeted Jobs' live executions become open first attempts, so recovery
-- reads identity from attempt rows.
INSERT INTO workload_attempts
  (workload_id, attempt, execution_id, generation, substrate, opened_at)
SELECT w.id, 1, w.current_execution_id,
       CAST(json_extract(e.metadata, '$.generation') AS INTEGER),
       'pod',
       e.created_at
FROM workloads w
JOIN workload_events e ON e.id = (
  SELECT id FROM workload_events
  WHERE workload_id = w.id AND state = 'running' AND json_valid(metadata)
    AND json_extract(metadata, '$.executionId') = w.current_execution_id
  ORDER BY id DESC LIMIT 1
)
WHERE w.deployment_id IS NOT NULL
  AND (w.state = 'running' OR (w.state IN
    ('completed', 'errored', 'failed', 'invalid', 'terminated')
    AND w.cleaned_at IS NULL));

INSERT INTO pod_attempts (attempt_id, pod_uid, container_id)
SELECT a.id, json_extract(e.metadata, '$.podUid'),
       json_extract(e.metadata, '$.containerId')
FROM workload_attempts a
JOIN workload_events e ON e.id = (
  SELECT id FROM workload_events
  WHERE workload_id = a.workload_id AND state = 'running'
    AND json_valid(metadata)
    AND json_extract(metadata, '$.executionId') = a.execution_id
  ORDER BY id DESC LIMIT 1
);
