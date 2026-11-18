-- Service is the canonical persisted and wire discriminator. This update is
-- idempotent so a process exit after the statement but before migration
-- bookkeeping can safely retry it.
UPDATE deployments
SET deployment_type = 'service'
-- service-terminology-ok: migrate the only legacy persisted value
WHERE deployment_type = 'server';
