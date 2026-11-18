-- Hourly price captured at VM provisioning time, when the resolved region is
-- finally known. Cost = SUM(price_per_hour * duration) across a deployment's
-- vms rows. Stored here (not on deployments) because retries can land in
-- different-priced regions, and writing here lets the price ride along the
-- same INSERT that sets region — no UPDATE on the deployments row required.
ALTER TABLE vms ADD COLUMN price_per_hour REAL;
