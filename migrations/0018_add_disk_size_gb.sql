-- migrations/0018_add_disk_size_gb.sql
-- Store requested disk size so API can apply it on VM creation

ALTER TABLE deployments ADD COLUMN disk_size_gb INTEGER;
