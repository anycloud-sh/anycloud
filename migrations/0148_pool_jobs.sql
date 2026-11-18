-- RT8 (RFC 0044 decision 26): `job IMAGE --node-pool P` runs as a
-- targeted Job with its own container spec on the pool's managed Deployment
-- for its image digest and replica shape, which the key finds.
ALTER TABLE deployments ADD COLUMN managed_key TEXT
  CHECK (managed_key IS NULL OR managed = 1);
-- One live managed Deployment per pool and key; a draining one is replaced.
CREATE UNIQUE INDEX idx_deployments_managed_key
  ON deployments(node_pool_id, managed_key)
  WHERE managed_key IS NOT NULL AND deletion_requested_at IS NULL;

-- The runner starts the image's Entrypoint, then the Job's command or the
-- image's Cmd, which the managed Deployment's spec keeps as its command.
ALTER TABLE container_specs ADD COLUMN entrypoint TEXT;

DROP TRIGGER container_specs_workload_owner;
CREATE TRIGGER container_specs_workload_owner BEFORE INSERT ON container_specs
WHEN NEW.workload_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workloads d LEFT JOIN deployments t ON t.id = d.deployment_id
  WHERE d.id = NEW.workload_id
    AND (d.deployment_id IS NULL OR t.managed = 1)
    AND d.workload_type IN ('job', 'service', 'vm')
)
BEGIN
  SELECT RAISE(ABORT, 'container spec requires a VM-host owner or a managed Deployment');
END;
