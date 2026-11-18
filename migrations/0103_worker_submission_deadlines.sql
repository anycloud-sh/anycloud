-- A public Job keeps its ID while each explicit submission gets a new revision.
ALTER TABLE deployments ADD COLUMN submission_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deployments ADD COLUMN claim_deadline_at INTEGER;
ALTER TABLE deployments ADD COLUMN first_claimed_at INTEGER;

CREATE INDEX idx_deployments_claim_deadline
  ON deployments(claim_deadline_at, id)
  WHERE worker_id IS NOT NULL AND first_claimed_at IS NULL
    AND claim_deadline_at IS NOT NULL AND state = 'queued';

-- Keep ordered queue reads covered while checking first-claim eligibility.
DROP INDEX idx_deployments_worker;
CREATE INDEX idx_deployments_worker
  ON deployments(worker_id, state, submitted_at, id,
                 first_claimed_at, claim_deadline_at, submission_revision,
                 current_execution_id)
  WHERE worker_id IS NOT NULL;
