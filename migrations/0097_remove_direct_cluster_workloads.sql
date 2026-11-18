-- Remove the obsolete direct Kubernetes Job/Service target. Kubernetes jobs now
-- target a persistent Cluster Deployment through the relationship introduced
-- by the following migration.

DROP INDEX IF EXISTS idx_deployments_cluster_id;

ALTER TABLE deployments DROP COLUMN cluster_id;
