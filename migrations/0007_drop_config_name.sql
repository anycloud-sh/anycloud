-- migrations/0007_drop_config_name.sql
-- Drop unused config_name column (single cloudConfig refactor)

ALTER TABLE deployments DROP COLUMN config_name;
