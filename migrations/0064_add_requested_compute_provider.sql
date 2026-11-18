-- Credentialless compute providers need durable provider identity.
--
-- deployments.credential_id = NULL already means "unpinned remote compute" for
-- AWS/GCP/Azure/Lambda/Vast. For Local, there is intentionally no compute
-- credential, so store the explicitly requested provider separately instead of
-- inventing fake credentials or overloading NULL.
ALTER TABLE deployments ADD COLUMN requested_compute_provider TEXT;
