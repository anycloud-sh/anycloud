-- Move region tracking from deployment_events to vms table.
-- Each VM row records the region it was provisioned in (or attempted in, for failed VMs).
ALTER TABLE vms ADD COLUMN region TEXT;
ALTER TABLE deployment_events DROP COLUMN region;
