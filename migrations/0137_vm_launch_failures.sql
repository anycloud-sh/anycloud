-- A failed VM launch records its classification on its own ledger row, so the
-- launch-target picker reads failure history from `vms` alone. Disposition is
-- derived on read from the diagnosis and the owner's immutable pins.
ALTER TABLE vms ADD COLUMN launch_diagnosis TEXT;
ALTER TABLE vms ADD COLUMN launch_region_denied TEXT
  CHECK (launch_region_denied IS NULL OR launch_diagnosis IS NOT NULL);
