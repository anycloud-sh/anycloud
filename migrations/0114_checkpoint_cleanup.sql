-- Cleanup of partial and orphan checkpoint generations (slice 6).
-- Numbered after ROOT slice 3's reserved 0113.

-- Per-root retention override; NULL means the default of three published
-- generations (the committed reference plus two earlier recovery points).
ALTER TABLE checkpoint_roots ADD COLUMN retain_generations INTEGER
  CHECK (retain_generations IS NULL OR retain_generations >= 1);

-- How long an abandoned or superseded operation's bytes stay before cleanup
-- may remove them; NULL means the defaults (seven days, twenty-four hours).
-- Earlier attempts of a committed operation have no grace period.
ALTER TABLE checkpoint_roots ADD COLUMN abandoned_grace_ms INTEGER
  CHECK (abandoned_grace_ms IS NULL OR abandoned_grace_ms >= 0);
ALTER TABLE checkpoint_roots ADD COLUMN superseded_grace_ms INTEGER
  CHECK (superseded_grace_ms IS NULL OR superseded_grace_ms >= 0);

-- One row per attempted deletion of one attempt prefix. The row is durable
-- evidence: which gate authorized it, what was removed, and how it ended. A
-- completed row is what marks the prefix as gone; a failed row keeps the
-- prefix eligible for retry, including a retired generation whose bytes are
-- still there. A running row whose credential lapsed is reclaimed as failed.
CREATE TABLE checkpoint_cleanups (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL REFERENCES checkpoint_roots(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL REFERENCES checkpoint_operations(id),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  attempt_prefix TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('attempt', 'generation')),
  authorizing_gate TEXT NOT NULL CHECK (authorizing_gate IN ('destructive-cleanup', 'generation-retirement')),
  state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed')),
  objects_deleted INTEGER NOT NULL DEFAULT 0,
  bytes_deleted INTEGER NOT NULL DEFAULT 0,
  failure TEXT,
  credential_expires_at INTEGER,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  CHECK ((state = 'running') = (finished_at IS NULL))
);

-- Two cleanups must never work on one prefix at the same time.
CREATE UNIQUE INDEX checkpoint_cleanups_running ON checkpoint_cleanups(attempt_prefix)
WHERE state = 'running';

CREATE INDEX checkpoint_cleanups_operation ON checkpoint_cleanups(operation_id, attempt, state);
CREATE INDEX checkpoint_cleanups_root ON checkpoint_cleanups(root_id, finished_at DESC);
