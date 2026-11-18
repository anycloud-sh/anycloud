-- Hosted API release intents: the Helm-managed API records what it is about
-- to ask helm-controller for before it patches its HelmChart. Slice 1's
-- kubernetes_root_release_intents cannot hold these rows: it references the
-- installation record, which exists only in the installer's database.
-- Revisions increase per database; the HelmChart annotation carries the same
-- number so the chart's pre-upgrade guard refuses a stale replay in-cluster.
CREATE TABLE system_release_intents (
  revision INTEGER PRIMARY KEY CHECK (revision >= 1),
  operation_id TEXT NOT NULL UNIQUE CHECK (length(trim(operation_id)) > 0),
  api_version TEXT NOT NULL CHECK (length(trim(api_version)) > 0),
  api_image TEXT NOT NULL CHECK (instr(api_image, '@sha256:') > 0),
  requested_by_user_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('recorded', 'applied', 'failed')),
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TRIGGER system_release_intents_monotonic
BEFORE INSERT ON system_release_intents
WHEN NEW.revision <= COALESCE((SELECT MAX(revision) FROM system_release_intents), 0)
BEGIN
  SELECT RAISE(ABORT, 'System release revision must increase');
END;

-- Where the hosted API backs its database up: an existing, versioned bucket
-- and the storage credential the installer recorded at bootstrap.
ALTER TABLE kubernetes_root_installations ADD COLUMN backup_bucket TEXT;
ALTER TABLE kubernetes_root_installations ADD COLUMN backup_region TEXT;
ALTER TABLE kubernetes_root_installations ADD COLUMN backup_credential_id TEXT;
