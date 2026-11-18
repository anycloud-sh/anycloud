-- Persist explicit submit/run --bake intent so queued/retried deployments keep
-- the requested bake phase after API restarts.
ALTER TABLE deployments ADD COLUMN bake INTEGER DEFAULT 0;
