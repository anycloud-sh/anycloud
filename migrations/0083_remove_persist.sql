-- Every deployment now releases its VM when it reaches a terminal state, so
-- the per-deployment retention flag no longer selects any behavior. Unlike the
-- checkpoint-bucket flag, retention has no successor contract to rewrite the
-- old values into, so this is a plain drop.
ALTER TABLE deployments DROP COLUMN persist;
