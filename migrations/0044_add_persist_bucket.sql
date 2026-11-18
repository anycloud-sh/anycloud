-- migrations/0044_add_persist_bucket.sql
-- Per-deployment flag: when set, the spot checkpoint bucket is retained on
-- job completion instead of being auto-deleted. Lets users keep checkpoint
-- state across runs without paying for an idle VM (i.e. without --persist).

ALTER TABLE deployments ADD COLUMN persist_bucket INTEGER NOT NULL DEFAULT 0;
