-- Opt-in control for warming baked-image data before container start.
-- Independent of use_bake_cache, which controls whether a baked image may be
-- selected at all.
ALTER TABLE deployments ADD COLUMN warm_image INTEGER NOT NULL DEFAULT 0;
