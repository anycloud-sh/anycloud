-- Persist the optimizer-resolved vmType on each vms row (successful and failed
-- attempts alike) so retries and preemption recover the concrete provisioned
-- type instead of the request-array head (which may be a fake or unavailable
-- ordered-fallback entry). Read back via getLatestProvisioningConfig. NULL on
-- pre-existing rows is fine -- every read path is null-safe.
ALTER TABLE vms ADD COLUMN vm_type TEXT;
