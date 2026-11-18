-- A node pool's OS disk: its size and tier, null for the provider's
-- default. Every VM the pool launches boots with them.
ALTER TABLE node_pools ADD COLUMN os_disk_size_gb INTEGER
  CHECK (os_disk_size_gb > 0);
ALTER TABLE node_pools ADD COLUMN os_disk_tier TEXT
  CHECK (os_disk_tier IN ('medium', 'high', 'ultra'));
