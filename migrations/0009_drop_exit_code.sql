-- Drop exit_code column from deployments table
-- Exit code is now stored in deployment_events metadata only
ALTER TABLE deployments DROP COLUMN exit_code;
