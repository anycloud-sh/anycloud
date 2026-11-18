-- One VM attempt per node pool is its ingress entry: the Node that runs the
-- pool's Traefik and whose public IP Service records point at. The
-- controller elects and re-elects it; the row records the current choice so a
-- restart keeps the same entry and consumers can see when it last changed.

ALTER TABLE node_pools ADD COLUMN ingress_entry_vm_id INTEGER
  REFERENCES vms(id) ON DELETE SET NULL;
ALTER TABLE node_pools ADD COLUMN ingress_entry_changed_at INTEGER;
