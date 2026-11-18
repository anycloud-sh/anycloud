-- Durable teardown record (RFC 0031).

-- The API's own version timeline. One row is appended at boot whenever the
-- running version differs from the newest row, so "which API version
-- performed X" is a time-join against this table for any timestamped fact -
-- teardown included - instead of migration archaeology or a per-row stamp.
-- Not the submitting CLI's version, which lives on the deployment row and
-- answers a different question.
CREATE TABLE api_versions (
  version TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL
);

-- Count of cleanup passes entered for this deployment's teardown episode.
-- Bumped as each pass starts and backstopped by the UPDATE that sets
-- cleaned_at, so a cleaned deployment can never record zero passes. NULL
-- means the deployment was cleaned before this feature existed - no backfill.
ALTER TABLE deployments ADD COLUMN cleanup_attempts INTEGER;
