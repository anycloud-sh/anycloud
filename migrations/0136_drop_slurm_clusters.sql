-- Remove 0135's Slurm attach schema (RFC 0046 P1.1). `cluster attach` was
-- removed after v0.1.66, no Job ever ran on an attached cluster, and Phase 2
-- re-creates the schema with a runtime profile. `workload_attempts.substrate`
-- keeps its 'slurm' value for Phase 2.
DROP TRIGGER workloads_slurm_cluster_exists;
DROP TRIGGER workloads_identity_immutable;
DROP INDEX idx_workloads_slurm_cluster;
DROP TABLE slurm_clusters;
ALTER TABLE workloads DROP COLUMN slurm_cluster_id;

CREATE TRIGGER workloads_identity_immutable BEFORE UPDATE ON workloads
WHEN NEW.rowid IS NOT OLD.rowid
  OR NEW.id IS NOT OLD.id OR NEW.workload_type IS NOT OLD.workload_type
  OR NEW.deployment_id IS NOT OLD.deployment_id
  OR NEW.node_pool_id IS NOT OLD.node_pool_id
  OR NEW.user_id IS NOT OLD.user_id
  OR NEW.owner_user_id IS NOT OLD.owner_user_id
BEGIN
  SELECT RAISE(ABORT, 'workload identity and target are immutable');
END;
