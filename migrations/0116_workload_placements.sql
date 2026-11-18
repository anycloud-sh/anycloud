-- Service Workloads can target one explicit placement in the shared Kubernetes
-- root. The target is immutable for the Workload's life, only a Service that
-- targets no Deployment may carry one, and it can be admitted only while the
-- placement is ready. A placement cannot begin deletion while a Service that
-- has not finished cleanup still references it: native objects remain in the
-- root until cleanup confirms their removal.

ALTER TABLE workloads ADD COLUMN placement_id TEXT
  REFERENCES placements(id) ON DELETE RESTRICT;

CREATE INDEX idx_workloads_placement
  ON workloads(placement_id, state, cleaned_at)
  WHERE placement_id IS NOT NULL;

CREATE TRIGGER workloads_placement_target BEFORE INSERT ON workloads
WHEN NEW.placement_id IS NOT NULL
  AND (NEW.workload_type <> 'service' OR NEW.deployment_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'only a Service Workload without a Deployment target can target a placement');
END;

CREATE TRIGGER workloads_placement_accepts BEFORE INSERT ON workloads
WHEN NEW.placement_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM placements p WHERE p.id = NEW.placement_id AND p.state = 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'placement does not accept Services');
END;

DROP TRIGGER workloads_identity_immutable;
CREATE TRIGGER workloads_identity_immutable BEFORE UPDATE ON workloads
WHEN NEW.rowid IS NOT OLD.rowid
  OR NEW.id IS NOT OLD.id OR NEW.workload_type IS NOT OLD.workload_type
  OR NEW.deployment_id IS NOT OLD.deployment_id
  OR NEW.placement_id IS NOT OLD.placement_id
  OR NEW.user_id IS NOT OLD.user_id
  OR NEW.owner_user_id IS NOT OLD.owner_user_id
BEGIN
  SELECT RAISE(ABORT, 'workload identity and target are immutable');
END;

CREATE TRIGGER placements_deletion_requires_no_services
BEFORE UPDATE OF state ON placements
WHEN NEW.state IN ('deleting', 'deleted')
  AND OLD.state NOT IN ('deleting', 'deleted')
  AND EXISTS (
    SELECT 1 FROM workloads w
    WHERE w.placement_id = OLD.id AND w.cleaned_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'placement still has Services');
END;
