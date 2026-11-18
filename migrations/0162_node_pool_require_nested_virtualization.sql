-- A node pool whose VMs launch with nested virtualization, on VM types the
-- catalog reports as supporting it (RFC 0049 C10). Existing pools don't.
ALTER TABLE node_pools ADD COLUMN require_nested_virtualization INTEGER NOT NULL DEFAULT 0
  CHECK (require_nested_virtualization IN (0, 1));
