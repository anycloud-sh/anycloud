-- Covering index for the retry monitor's per-minute scan over retrying and
-- recovering events. Without it the scan walks every deployment_events row
-- (529k rows at one customer = ~2s on the event loop per tick)
CREATE INDEX IF NOT EXISTS idx_events_state_deployment
  ON deployment_events(state, deployment_id, created_at);

-- Partial index for resubmit counting. Holds only the rows written by
-- resubmitDeployment so the per-minute count touches nothing else
CREATE INDEX IF NOT EXISTS idx_events_resubmit
  ON deployment_events(deployment_id)
  WHERE json_valid(metadata)
    AND json_extract(metadata, '$.reason') = 'resubmitted';
