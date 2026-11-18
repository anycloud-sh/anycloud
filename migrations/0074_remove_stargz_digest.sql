-- Remove the abandoned lazy-image signal. All images now use the standard OCI
-- full-pull path, accelerated by containerd transfer when the runtime supports it.
ALTER TABLE deployments DROP COLUMN stargz_digest;
