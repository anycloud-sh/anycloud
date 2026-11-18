-- Node pools take an ordered VM type list, like VM Jobs: `vm_type` holds a
-- JSON array, and each VM row keeps the one type it launched as. The
-- association trigger forbids changing `vm_type`, so it is dropped around the
-- conversion and recreated verbatim.

DROP TRIGGER node_pools_association_immutable;

UPDATE node_pools SET vm_type = json_array(vm_type);

CREATE TRIGGER node_pools_association_immutable BEFORE UPDATE ON node_pools
WHEN NEW.rowid IS NOT OLD.rowid
  OR NEW.id IS NOT OLD.id
  OR NEW.cluster_id IS NOT OLD.cluster_id
  OR NEW.owner_user_id IS NOT OLD.owner_user_id
  OR NEW.name IS NOT OLD.name
  OR NEW.compute_credential_id IS NOT OLD.compute_credential_id
  OR NEW.region IS NOT OLD.region
  OR NEW.zone IS NOT OLD.zone
  OR NEW.vm_type IS NOT OLD.vm_type
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.state = 'deleted' AND NEW.state IS NOT 'deleted')
BEGIN
  SELECT RAISE(ABORT, 'Node pool association is immutable');
END;
