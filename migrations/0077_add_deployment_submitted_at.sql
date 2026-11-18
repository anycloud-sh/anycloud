-- Preserve the original submission time when started_at is reset for a later
-- attempt (resubmit or server upgrade). Server upgrades already reset
-- started_at before this column existed, so recover the earliest persisted
-- lifecycle timestamp available for legacy rows.
ALTER TABLE deployments ADD COLUMN submitted_at INTEGER;

UPDATE deployments
SET submitted_at = MIN(
  started_at,
  COALESCE(
    (SELECT MIN(e.created_at)
     FROM deployment_events e
     WHERE e.deployment_id = deployments.id),
    started_at
  ),
  COALESCE(
    (SELECT MIN(v.created_at)
     FROM vms v
     WHERE v.deployment_id = deployments.id),
    started_at
  )
)
WHERE submitted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_deployments_submitted_at
  ON deployments(submitted_at);

-- Daily digest resubmission counts filter the append-only event log by time.
CREATE INDEX IF NOT EXISTS idx_events_resubmit_created_at
  ON deployment_events(created_at, deployment_id)
  WHERE json_valid(metadata)
    AND json_extract(metadata, '$.reason') = 'resubmitted';
