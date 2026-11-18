-- Separate the terminal outcome timestamp from provider teardown completion.
ALTER TABLE deployments ADD COLUMN cleaned_at INTEGER;

-- Preserve the previous boundary: terminal rows without a live VM were already
-- considered settled. Requiring an attempt ended after the outcome would replay
-- old teardown because retries often retired the VM before the outcome existed,
-- potentially deleting managed checkpoints. Leak healing belongs in an explicit
-- reconciliation, not this cutover. Clamp the timestamp to completed_at so the
-- causal ordering remains valid.
UPDATE deployments AS d
SET cleaned_at = MAX(
  d.completed_at,
  COALESCE(
    (
      SELECT MAX(v.ended_at)
      FROM vms v
      WHERE v.deployment_id = d.id
    ),
    d.completed_at
  )
)
WHERE d.cleaned_at IS NULL
  AND d.completed_at IS NOT NULL
  AND d.state IN (
    'completed',
    'errored',
    'failed',
    'invalid',
    'terminated'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM vms live
    WHERE live.deployment_id = d.id
      AND live.ended_at IS NULL
  );

-- Active deployments have no completed_at and therefore stay out of this
-- restart-recovery index. Keep its physical name for databases that already
-- applied migration 84. Cleanup-needed is the current code terminology.
CREATE INDEX IF NOT EXISTS idx_deployments_pending_cleanup
  ON deployments(state, completed_at)
  WHERE completed_at IS NOT NULL AND cleaned_at IS NULL;
