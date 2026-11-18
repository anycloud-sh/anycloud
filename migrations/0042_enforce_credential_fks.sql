-- Make credential_id columns into real foreign keys to credentials(id).
-- SQLite has no ALTER TABLE ADD CONSTRAINT, so rebuild the table per
-- https://www.sqlite.org/lang_altertable.html#otheralter (step 1: disable
-- foreign_keys for the rebuild).
--
-- Also drops the legacy NOT NULL DEFAULT empty-string on credential_id (a
-- SQLite-migration workaround from 0014, empty-string rows have never been
-- observed in any audited prod/local DB) and converts any stray empty value
-- to NULL.
--
-- better-sqlite3 ships SQLite compiled with SQLITE_DEFAULT_FOREIGN_KEYS=1, so
-- FKs are ON at connection open. Without this toggle, DROP TABLE deployments
-- fires implicit FK probes against deployment_events.deployment_id (no
-- ON DELETE) and aborts. db.ts re-enables FKs and runs foreign_key_check
-- after migrations.
PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

-- Clear orphan credential references before adding the FK. Older builds of
-- dropOrUnnameCredential only blocked credential deletes when an ACTIVE_STATES
-- deployment referenced the row, so terminal-state deployments can be holding
-- IDs whose credential row has since been deleted. Without this wash, the
-- foreign_key_check in db.ts would refuse to start on those DBs.
UPDATE deployments SET credential_id = ''
 WHERE credential_id != ''
   AND credential_id NOT IN (SELECT id FROM credentials);
UPDATE deployments SET input_storage_credential_id = NULL
 WHERE input_storage_credential_id IS NOT NULL
   AND input_storage_credential_id NOT IN (SELECT id FROM credentials);
UPDATE deployments SET output_storage_credential_id = NULL
 WHERE output_storage_credential_id IS NOT NULL
   AND output_storage_credential_id NOT IN (SELECT id FROM credentials);

CREATE TABLE deployments_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  deployment_type TEXT NOT NULL,
  image TEXT NOT NULL,
  cloud_provider TEXT,
  region TEXT,
  vm_type TEXT,
  spot INTEGER DEFAULT 0,
  persist INTEGER DEFAULT 0,
  state TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  version TEXT NOT NULL,
  docker_command TEXT NOT NULL,
  availability_zone TEXT DEFAULT NULL,
  input_bucket TEXT DEFAULT NULL,
  output_bucket TEXT DEFAULT NULL,
  ssh_private_key TEXT NOT NULL DEFAULT '',
  credential_id TEXT REFERENCES credentials(id) ON DELETE RESTRICT,
  last_checked INTEGER,
  disk_size_gb INTEGER,
  docker_options TEXT,
  env TEXT,
  github_token TEXT,
  input_storage_credential_id TEXT REFERENCES credentials(id) ON DELETE RESTRICT,
  command TEXT,
  input_storage_region TEXT,
  image_digest TEXT,
  price_per_hour REAL,
  gpu_type TEXT,
  dns_record_id TEXT,
  output_storage_credential_id TEXT REFERENCES credentials(id) ON DELETE RESTRICT,
  output_storage_region TEXT,
  secret_names TEXT
);

INSERT INTO deployments_new (
  id, user_id, deployment_type, image, cloud_provider, region, vm_type,
  spot, persist, state, started_at, completed_at, version, docker_command,
  availability_zone, input_bucket, output_bucket, ssh_private_key,
  credential_id, last_checked, disk_size_gb, docker_options, env,
  github_token, input_storage_credential_id, command, input_storage_region,
  image_digest, price_per_hour, gpu_type, dns_record_id,
  output_storage_credential_id, output_storage_region, secret_names
)
SELECT
  id, user_id, deployment_type, image, cloud_provider, region, vm_type,
  spot, persist, state, started_at, completed_at, version, docker_command,
  availability_zone, input_bucket, output_bucket, ssh_private_key,
  NULLIF(credential_id, ''), last_checked, disk_size_gb, docker_options, env,
  github_token, input_storage_credential_id, command, input_storage_region,
  image_digest, price_per_hour, gpu_type, dns_record_id,
  output_storage_credential_id, output_storage_region, secret_names
FROM deployments;

DROP TABLE deployments;
ALTER TABLE deployments_new RENAME TO deployments;

CREATE INDEX idx_deployments_user ON deployments(user_id, started_at DESC);
CREATE INDEX idx_deployments_state ON deployments(user_id, state);
CREATE INDEX idx_deployments_credential ON deployments(credential_id);

COMMIT;

PRAGMA foreign_keys = ON;
