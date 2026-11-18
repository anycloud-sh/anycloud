-- SSH endpoint as data: most providers are reached at the VM public IP on
-- port 22, but NAT'd marketplaces (Vast) expose SSH on a gateway host and a
-- mapped port. Store both per-VM. NULL means use ip:22 (every existing
-- provider). The migration runner splits statements on the semicolon
-- character, so this comment must not contain that character.
ALTER TABLE vms ADD COLUMN ssh_host TEXT;
ALTER TABLE vms ADD COLUMN ssh_port INTEGER;
