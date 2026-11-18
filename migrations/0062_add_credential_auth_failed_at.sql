-- Persist when a stored cloud credential is observed to fail authentication in
-- a terminal way (e.g. a rotated or invalid client secret). NULL means healthy.
--
-- Set when provisioning classifies a failure as a bad credential, and cleared
-- on the next successful use or when the credential is re-saved. Read directly
-- so the signal survives an API restart (an in-memory block does not), which
-- lets cleanup pause and unpinned selection skip the credential until it is
-- fixed instead of retrying the same failing auth every tick.
ALTER TABLE credentials ADD COLUMN auth_failed_at INTEGER;
