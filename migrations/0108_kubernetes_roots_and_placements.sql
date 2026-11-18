-- One shared Kubernetes root with cloud-specific placements.
--
-- An installation registers exactly one active root. The record binds the
-- kube-system namespace UID observed from its control plane at registration
-- and keeps encrypted, revisioned connection material. A placement references
-- exactly one root for its whole life and owns its own compute credential,
-- region/zone and VM type. Independent `clusters` records are not
-- reinterpreted here; their cutover is a separate migration.

CREATE TABLE kubernetes_roots (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL CHECK (length(trim(owner_user_id)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  -- 'failed' is declared now because a CHECK cannot grow without rebuilding
  -- the table; nothing writes it until connection health checks exist.
  state TEXT NOT NULL CHECK (state IN ('ready', 'failed', 'deleting', 'deleted')),
  kubernetes_identity TEXT NOT NULL CHECK (length(trim(kubernetes_identity)) > 0),
  encrypted_connection TEXT CHECK (
    encrypted_connection IS NULL OR length(encrypted_connection) > 0
  ),
  connection_revision INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(connection_revision) = 'integer' AND connection_revision >= 1
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((state = 'deleted') = (encrypted_connection IS NULL))
);

-- At most one root that is not deleted, regardless of owner or name.
CREATE UNIQUE INDEX idx_kubernetes_roots_single_active
  ON kubernetes_roots((state <> 'deleted'))
  WHERE state <> 'deleted';
CREATE UNIQUE INDEX idx_kubernetes_roots_active_name
  ON kubernetes_roots(name COLLATE NOCASE)
  WHERE state <> 'deleted';
CREATE INDEX idx_kubernetes_roots_owner_state
  ON kubernetes_roots(owner_user_id, state, created_at DESC);

CREATE TABLE placements (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL REFERENCES kubernetes_roots(id) ON DELETE RESTRICT,
  owner_user_id TEXT NOT NULL CHECK (length(trim(owner_user_id)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  -- 'ready' and 'failed' are declared for the same reason; provisioning writes them.
  state TEXT NOT NULL CHECK (
    state IN ('creating', 'ready', 'failed', 'deleting', 'deleted')
  ),
  compute_credential_id TEXT NOT NULL
    REFERENCES credentials(id) ON DELETE RESTRICT,
  region TEXT NOT NULL CHECK (length(trim(region)) > 0),
  zone TEXT CHECK (zone IS NULL OR length(trim(zone)) > 0),
  vm_type TEXT NOT NULL CHECK (length(trim(vm_type)) > 0),
  min_vm_count INTEGER NOT NULL,
  max_vm_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    typeof(min_vm_count) = 'integer'
    AND typeof(max_vm_count) = 'integer'
    AND min_vm_count >= 0
    AND min_vm_count <= max_vm_count
  )
);

CREATE UNIQUE INDEX idx_placements_active_name
  ON placements(name COLLATE NOCASE)
  WHERE state <> 'deleted';
CREATE INDEX idx_placements_root_state
  ON placements(root_id, state, created_at);
CREATE INDEX idx_placements_credential
  ON placements(compute_credential_id);

-- Root identity is bound once. A deleted root stays deleted, and the connection
-- revision only advances.
CREATE TRIGGER kubernetes_roots_identity_immutable BEFORE UPDATE ON kubernetes_roots
WHEN NEW.rowid IS NOT OLD.rowid
  OR NEW.id IS NOT OLD.id
  OR NEW.owner_user_id IS NOT OLD.owner_user_id
  OR NEW.name IS NOT OLD.name
  OR NEW.kubernetes_identity IS NOT OLD.kubernetes_identity
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.connection_revision < OLD.connection_revision
  OR (OLD.state = 'deleted' AND NEW.state IS NOT 'deleted')
BEGIN
  SELECT RAISE(ABORT, 'Kubernetes root identity is immutable');
END;

-- Deletion cannot begin while a placement still references the root.
CREATE TRIGGER kubernetes_roots_deletion_requires_no_placements
BEFORE UPDATE OF state ON kubernetes_roots
WHEN NEW.state IN ('deleting', 'deleted')
  AND OLD.state NOT IN ('deleting', 'deleted')
  AND EXISTS (
    SELECT 1 FROM placements p
    WHERE p.root_id = OLD.id AND p.state <> 'deleted'
  )
BEGIN
  SELECT RAISE(ABORT, 'Kubernetes root still has placements');
END;

-- A placement joins a root that is neither deleting nor deleted.
CREATE TRIGGER placements_root_accepts BEFORE INSERT ON placements
WHEN NOT EXISTS (
  SELECT 1 FROM kubernetes_roots r
  WHERE r.id = NEW.root_id AND r.state = 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'Kubernetes root does not accept placements');
END;

-- The root association and the provider, credential, region, zone and VM type
-- a placement owns are fixed for its whole life.
CREATE TRIGGER placements_association_immutable BEFORE UPDATE ON placements
WHEN NEW.rowid IS NOT OLD.rowid
  OR NEW.id IS NOT OLD.id
  OR NEW.root_id IS NOT OLD.root_id
  OR NEW.owner_user_id IS NOT OLD.owner_user_id
  OR NEW.name IS NOT OLD.name
  OR NEW.compute_credential_id IS NOT OLD.compute_credential_id
  OR NEW.region IS NOT OLD.region
  OR NEW.zone IS NOT OLD.zone
  OR NEW.vm_type IS NOT OLD.vm_type
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.state = 'deleted' AND NEW.state IS NOT 'deleted')
BEGIN
  SELECT RAISE(ABORT, 'Placement association is immutable');
END;
