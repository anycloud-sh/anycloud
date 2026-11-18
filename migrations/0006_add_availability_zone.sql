-- migrations/0006_add_availability_zone.sql
-- Add availability_zone column for Azure zone selection

ALTER TABLE deployments ADD COLUMN availability_zone TEXT DEFAULT NULL;
