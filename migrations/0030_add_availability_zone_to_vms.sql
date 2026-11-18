-- Store discovered availability zone on VMs (derived data, not user input)
ALTER TABLE vms ADD COLUMN availability_zone TEXT;
