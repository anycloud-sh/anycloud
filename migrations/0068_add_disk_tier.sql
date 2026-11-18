-- migrations/0068_add_disk_tier.sql
-- Store normalized root-disk performance tier. NULL means default/medium.

ALTER TABLE deployments ADD COLUMN disk_tier TEXT;
