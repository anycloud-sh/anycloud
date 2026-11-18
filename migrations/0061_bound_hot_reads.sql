-- Bound recurring monitor/API reads to live sets or explicit time windows.
-- These indexes are additive only: they do not prune history or change query
-- results, but keep hot paths from scanning lifetime tables as history grows.

-- Restores the live-VM partial index that was created in 0008/0010 and lost
-- during the 0015 vms table rebuild. Used by live VM joins, cleanup retry
-- scans, and burn-rate checks.
CREATE INDEX IF NOT EXISTS idx_vms_active
  ON vms(deployment_id, ip, price_per_hour)
  WHERE ended_at IS NULL;

-- Spend-window queries filter by VM lifetime overlap. The redundant
-- indexable predicate added in code lets SQLite use ended_at for both live
-- rows (NULL) and rows that ended after the window start.
CREATE INDEX IF NOT EXISTS idx_vms_spend_window
  ON vms(ended_at, created_at, deployment_id)
  WHERE ip IS NOT NULL;

-- Cost reconciliation only needs ended VMs whose billing-derived cost has not
-- been written yet. This keeps the hourly monitor proportional to actual
-- pending work, not all historical VMs.
CREATE INDEX IF NOT EXISTS idx_vms_needing_cost
  ON vms(ended_at, deployment_id, credential_id, cloud_id)
  WHERE cost IS NULL
    AND ended_at IS NOT NULL;

-- setVmCost updates by provider cloud id after billing lookup.
CREATE INDEX IF NOT EXISTS idx_vms_cloud_id
  ON vms(cloud_id);

-- State-only monitor queries cannot use the existing (user_id, state) index.
CREATE INDEX IF NOT EXISTS idx_deployments_state_started
  ON deployments(state, started_at);

-- Daily digest/date-range reads filter terminal deployments by completed_at.
CREATE INDEX IF NOT EXISTS idx_deployments_state_completed
  ON deployments(state, completed_at)
  WHERE completed_at IS NOT NULL;

-- Retry candidate probes need the event immediately before the latest
-- retry/recovery event for a deployment.
CREATE INDEX IF NOT EXISTS idx_events_deployment_id
  ON deployment_events(deployment_id, id);
