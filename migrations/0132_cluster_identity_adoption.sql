-- A hosted API restored from a backup into a new cluster adopts it: the
-- recorded Kubernetes identity may change only together with an increment of
-- identity_generation, which only that adoption performs. Every other change
-- to a cluster's identity stays refused.
ALTER TABLE clusters ADD COLUMN identity_generation INTEGER NOT NULL DEFAULT 0;

DROP TRIGGER clusters_identity_immutable;
CREATE TRIGGER clusters_identity_immutable BEFORE UPDATE ON clusters
WHEN NEW.rowid IS NOT OLD.rowid
  OR NEW.id IS NOT OLD.id
  OR NEW.owner_user_id IS NOT OLD.owner_user_id
  OR NEW.name IS NOT OLD.name
  OR NEW.compute_credential_id IS NOT OLD.compute_credential_id
  OR NEW.region IS NOT OLD.region
  OR NEW.zone IS NOT OLD.zone
  OR NEW.vm_type IS NOT OLD.vm_type
  OR NEW.k3s_version IS NOT OLD.k3s_version
  OR NEW.k3s_sha256 IS NOT OLD.k3s_sha256
  OR NEW.helm_job_image IS NOT OLD.helm_job_image
  OR NEW.api_version IS NOT OLD.api_version
  OR NEW.api_image IS NOT OLD.api_image
  OR NEW.chart_version IS NOT OLD.chart_version
  OR NEW.chart_sha256 IS NOT OLD.chart_sha256
  OR NEW.encrypted_server_token IS NOT OLD.encrypted_server_token
  OR NEW.ssh_public_key IS NOT OLD.ssh_public_key
  OR NEW.encrypted_ssh_private_key IS NOT OLD.encrypted_ssh_private_key
  OR NEW.connection_kind IS NOT OLD.connection_kind
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.connection_revision < OLD.connection_revision
  OR (NEW.identity_generation IS NOT OLD.identity_generation
      AND (NEW.identity_generation IS NOT OLD.identity_generation + 1
           OR NEW.kubernetes_identity IS NULL
           OR NEW.kubernetes_identity IS OLD.kubernetes_identity))
  OR (OLD.kubernetes_identity IS NOT NULL
      AND NEW.kubernetes_identity IS NOT OLD.kubernetes_identity
      AND NEW.identity_generation IS NOT OLD.identity_generation + 1)
  OR (OLD.state = 'destroyed' AND NEW.state IS NOT 'destroyed')
BEGIN
  SELECT RAISE(ABORT, 'Cluster identity is immutable');
END;
