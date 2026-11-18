-- migrations/0003_add_version.sql
-- Add version column to track CLI version used for deployment

ALTER TABLE deployments ADD COLUMN version TEXT NOT NULL;
