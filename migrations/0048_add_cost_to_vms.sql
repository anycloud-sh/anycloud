-- Real billed cost for this VM, pulled from the cloud provider's billing API
-- after the bill settles (~24h). NULL until the cost-calculation monitor
-- populates it. Readers fall back to (price_per_hour * duration) from the
-- catalog snapshot. Lives on vms (not deployments) because each VM records
-- the credential/cloud account that actually booted it, so per-VM is the
-- natural attribution unit.
ALTER TABLE vms ADD COLUMN cost REAL;
