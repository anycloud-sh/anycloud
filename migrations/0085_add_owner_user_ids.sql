-- Preserve the historical username columns and add durable authorization ids.
-- Existing rows remain NULL and use the explicitly bounded legacy fallback.
ALTER TABLE api_access_policy ADD COLUMN owner_user_id TEXT;
ALTER TABLE deployments ADD COLUMN owner_user_id TEXT;
ALTER TABLE quota_operations ADD COLUMN owner_user_id TEXT;

-- New rows authorize by immutable id. Existing rows remain NULL and authorize
-- by the username already stored in user_id.
CREATE INDEX idx_deployments_owner_user
  ON deployments(owner_user_id, started_at DESC)
  WHERE owner_user_id IS NOT NULL;
CREATE INDEX idx_deployments_owner_state
  ON deployments(owner_user_id, state)
  WHERE owner_user_id IS NOT NULL;
CREATE INDEX idx_deployments_legacy_user
  ON deployments(user_id COLLATE NOCASE, started_at DESC)
  WHERE owner_user_id IS NULL;
CREATE INDEX idx_deployments_legacy_state
  ON deployments(user_id COLLATE NOCASE, state)
  WHERE owner_user_id IS NULL;

CREATE INDEX idx_quota_operations_owner_user
  ON quota_operations(owner_user_id, created_at)
  WHERE owner_user_id IS NOT NULL;
CREATE INDEX idx_quota_operations_legacy_user
  ON quota_operations(user_id COLLATE NOCASE, created_at)
  WHERE owner_user_id IS NULL;
