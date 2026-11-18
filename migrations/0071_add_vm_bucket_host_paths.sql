-- Persist the host-side bucket directories per VM.
--
-- Existing rows were initialized before host paths were stored explicitly, so
-- they must keep the legacy /mnt layout even when their provider now defaults
-- to a different root.
ALTER TABLE vms ADD COLUMN input_host_path TEXT;
ALTER TABLE vms ADD COLUMN output_host_path TEXT;
ALTER TABLE vms ADD COLUMN checkpoint_host_path TEXT;

UPDATE vms
SET input_host_path = COALESCE(input_host_path, '/mnt/input'),
    output_host_path = COALESCE(output_host_path, '/mnt/output'),
    checkpoint_host_path = COALESCE(checkpoint_host_path, '/mnt/checkpoint');
