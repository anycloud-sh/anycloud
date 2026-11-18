-- Provider identity now belongs to credentials, not deployments.
-- deployments.credential_id stores an optional pinned compute credential;
-- the runtime cloud is derived from the selected credential row. Historical
-- attempts derive cloud from vms.credential_id -> credentials.cloud_provider.
ALTER TABLE deployments DROP COLUMN cloud_provider;
