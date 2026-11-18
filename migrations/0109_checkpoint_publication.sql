-- Reusable checkpoint publication and writer handoff.
--
-- A root is one checkpoint namespace in one bucket. Generation numbers are
-- allocated here, before any upload, so a delayed or stale preparation always
-- carries a lower number than every later one. Only this database advances
-- the committed reference; bucket objects are evidence that it verifies.
CREATE TABLE checkpoint_roots (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('workload', 'installation')),
  owner_id TEXT NOT NULL,
  identity TEXT NOT NULL CHECK (json_valid(identity) AND json_type(identity) = 'object'),
  bucket TEXT NOT NULL,
  prefix TEXT NOT NULL,
  next_generation INTEGER NOT NULL DEFAULT 1 CHECK (next_generation >= 1),
  committed_generation INTEGER,
  committed_manifest_sha256 TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((committed_generation IS NULL) = (committed_manifest_sha256 IS NULL)),
  CHECK (committed_generation IS NULL OR committed_generation < next_generation)
);

CREATE UNIQUE INDEX checkpoint_roots_owner ON checkpoint_roots(owner_kind, owner_id);

-- Two roots must never share or nest a location; retention decisions are per root.
CREATE UNIQUE INDEX checkpoint_roots_location ON checkpoint_roots(bucket, prefix);

-- One operation prepares one generation. `attempt` retries the upload under a
-- fresh prefix while keeping the allocated generation and the failed bytes.
CREATE TABLE checkpoint_operations (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL REFERENCES checkpoint_roots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('upgrade', 'terminate', 'recover', 'periodic')),
  generation INTEGER NOT NULL,
  desired_revision TEXT,
  source_writer_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  state TEXT NOT NULL CHECK (state IN ('preparing', 'fenced', 'committed', 'failed', 'superseded', 'abandoned')),
  delegate_key_hash TEXT,
  failure TEXT,
  credential_expires_at INTEGER,
  fenced_at INTEGER,
  committed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (root_id, generation)
);

CREATE UNIQUE INDEX checkpoint_operations_pending ON checkpoint_operations(root_id)
WHERE state IN ('preparing', 'fenced', 'failed') AND kind <> 'periodic';

CREATE INDEX checkpoint_operations_root ON checkpoint_operations(root_id, created_at DESC);

-- Published generations are immutable. A retired row records that its
-- objects may be removed by a later cleanup slice; the committed generation
-- and the last recoverable copy are never retired here.
CREATE TABLE checkpoint_generations (
  root_id TEXT NOT NULL REFERENCES checkpoint_roots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  operation_id TEXT NOT NULL REFERENCES checkpoint_operations(id),
  attempt INTEGER NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  byte_count INTEGER NOT NULL,
  file_count INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('published', 'retired')),
  published_at INTEGER NOT NULL,
  PRIMARY KEY (root_id, generation)
);

-- The writer lease. Exactly one active writer per root; admission records the
-- committed generation and manifest it restored so the consumer can hand that
-- exact reference to its restore step and a later operation can prove what it
-- fenced.
CREATE TABLE checkpoint_writers (
  id TEXT NOT NULL,
  root_id TEXT NOT NULL REFERENCES checkpoint_roots(id) ON DELETE CASCADE,
  admitted_by_operation_id TEXT REFERENCES checkpoint_operations(id),
  revision TEXT,
  restored_generation INTEGER,
  restored_manifest_sha256 TEXT,
  admitted_at INTEGER NOT NULL,
  released_at INTEGER,
  release_reason TEXT CHECK (release_reason IS NULL OR release_reason IN ('fenced', 'lost')),
  PRIMARY KEY (root_id, id),
  CHECK ((released_at IS NULL) = (release_reason IS NULL)),
  CHECK ((restored_generation IS NULL) = (restored_manifest_sha256 IS NULL))
);

CREATE UNIQUE INDEX checkpoint_writers_active ON checkpoint_writers(root_id)
WHERE released_at IS NULL;
