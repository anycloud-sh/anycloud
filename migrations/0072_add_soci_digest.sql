-- SOCI top-level digest resolved at submit or serve-upgrade time.
-- NULL means the deployment uses the ordinary OCI image path.
ALTER TABLE deployments ADD COLUMN soci_digest TEXT;
