CREATE TABLE IF NOT EXISTS quota_operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  cloud_provider TEXT NOT NULL,
  credential_name TEXT,
  dry_run INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  total_targets INTEGER NOT NULL,
  completed_targets INTEGER NOT NULL DEFAULT 0,
  failed_targets INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS quota_operation_targets (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES quota_operations(id) ON DELETE CASCADE,
  target_index INTEGER NOT NULL,
  vm_type TEXT NOT NULL,
  region TEXT NOT NULL,
  spot INTEGER NOT NULL DEFAULT 0,
  include_public_ip_quota INTEGER,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  entries_json TEXT,
  error TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(operation_id, target_index)
);

CREATE INDEX IF NOT EXISTS idx_quota_operations_user
  ON quota_operations(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_quota_operations_status
  ON quota_operations(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_quota_operation_targets_operation
  ON quota_operation_targets(operation_id, target_index);

CREATE INDEX IF NOT EXISTS idx_quota_operation_targets_status
  ON quota_operation_targets(status, updated_at);
