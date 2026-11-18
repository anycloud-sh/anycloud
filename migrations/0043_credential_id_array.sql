-- Move the credential_id FK off deployments and onto vms.
--
-- deployments.credential_id temporarily allowed either a single credential id
-- or a JSON array of ids. A REFERENCES constraint can't validate JSON-array
-- values, so this migration dropped the FK from the column. Later migrations
-- normalize credential arrays back to NULL/unpinned compute.
--
-- vms gains its own credential_id with the FK. Each VM booted with exactly
-- one credential, so per-VM is the right ownership level for referential
-- integrity. Backfill from deployments.credential_id at migration time —
-- every existing row stores a single credential id (the JSON-array shape
-- only appears after this migration ships).
--
-- SQLite has no ALTER TABLE DROP CONSTRAINT, so dropping the deployments FK
-- requires the table-rebuild dance (same as 0042). PRAGMA foreign_keys = OFF
-- and re-enable in db.ts after migrations, mirroring 0042.

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

-- 1. Add credential_id to vms with FK. ALTER TABLE ADD COLUMN with
--    REFERENCES is allowed when the column is nullable / has a default.
ALTER TABLE vms ADD COLUMN credential_id TEXT
  REFERENCES credentials(id) ON DELETE RESTRICT;

-- 2. Backfill from the parent deployment. At this point every deployment
--    row holds a scalar credential id (no array values exist yet).
UPDATE vms SET credential_id = (
  SELECT credential_id FROM deployments WHERE deployments.id = vms.deployment_id
)
WHERE credential_id IS NULL;

CREATE INDEX idx_vms_credential ON vms(credential_id);

-- 3. Rebuild deployments to drop the FK from credential_id. Other columns
--    keep their constraints.
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
  credential_id TEXT,
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
  credential_id, last_checked, disk_size_gb, docker_options, env,
  github_token, input_storage_credential_id, command, input_storage_region,
  image_digest, price_per_hour, gpu_type, dns_record_id,
  output_storage_credential_id, output_storage_region, secret_names
FROM deployments;

DROP TABLE deployments;
ALTER TABLE deployments_new RENAME TO deployments;

CREATE INDEX idx_deployments_user ON deployments(user_id, started_at DESC);
CREATE INDEX idx_deployments_state ON deployments(user_id, state);
-- Keep the credential index for legacy single-cred lookups. LIKE scans
-- against JSON-array values still benefit from it as a covering filter.
CREATE INDEX idx_deployments_credential ON deployments(credential_id);

COMMIT;

PRAGMA foreign_keys = ON;
