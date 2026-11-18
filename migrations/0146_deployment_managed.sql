-- SLOT (RFC 0044 decision 26): a managed Deployment runs pool Jobs.
-- Its Jobs' slot time enters their session's burn and window spend, and the
-- claim checks it; Jobs on user Deployments stay ungated.
ALTER TABLE deployments ADD COLUMN managed INTEGER NOT NULL DEFAULT 0
  CHECK (managed IN (0, 1));
