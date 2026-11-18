-- SSH username as endpoint data. Most providers authorize root and leave this
-- NULL. Legacy container-mode runtimes could use a non-root account while
-- preserving the same host/port endpoint contract.
ALTER TABLE vms ADD COLUMN ssh_username TEXT;
