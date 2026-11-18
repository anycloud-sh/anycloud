-- Seek complete pending resource/credential groups without scanning or sorting
-- the remaining backlog. NULL and empty-string credentials remain distinct.
-- cloud_id is already NOT NULL; repeating it in this partial predicate can
-- prevent SQLite from proving that the forced index applies after simplification.
CREATE INDEX idx_vms_pending_cost_group ON vms (
  CASE WHEN cluster_id IS NULL THEN 'anycloud_deployment' ELSE 'anycloud_resource' END,
  COALESCE(cluster_id, deployment_id),
  (credential_id IS NOT NULL),
  COALESCE(credential_id, ''),
  ended_at
)
WHERE cost IS NULL
  AND ended_at IS NOT NULL
  AND (deployment_id IS NOT NULL OR cluster_id IS NOT NULL);
