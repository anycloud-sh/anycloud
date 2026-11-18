-- Controls whether submit/serve provisioning may boot from an existing baked
-- image cache entry. Explicit baking still uses image_digest even when cache
-- consumption is disabled.
ALTER TABLE deployments ADD COLUMN use_bake_cache INTEGER NOT NULL DEFAULT 1;
