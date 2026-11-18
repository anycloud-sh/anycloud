-- The Kubernetes-hosted API keeps its state in the installation's checkpoint
-- bucket with the semantics the VM-hosted API had: a user-supplied bucket is
-- retained and never deleted by Anycloud; without one, bootstrap creates a
-- managed bucket named after the installation id and destroy removes it. The
-- credential is the installation's compute credential and the region is read
-- from the bucket, so the separate backup credential and region go.
ALTER TABLE kubernetes_root_installations RENAME COLUMN backup_bucket TO checkpoint_bucket;
ALTER TABLE kubernetes_root_installations ADD COLUMN checkpoint_bucket_managed INTEGER NOT NULL DEFAULT 0
  CHECK (checkpoint_bucket_managed IN (0, 1));
ALTER TABLE kubernetes_root_installations DROP COLUMN backup_region;
ALTER TABLE kubernetes_root_installations DROP COLUMN backup_credential_id;
