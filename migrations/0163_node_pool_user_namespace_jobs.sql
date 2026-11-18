-- A node pool whose Jobs run as root of their own user namespace (RFC 0049
-- C32). Existing pools don't.
ALTER TABLE node_pools ADD COLUMN user_namespace_jobs INTEGER NOT NULL DEFAULT 0
  CHECK (user_namespace_jobs IN (0, 1));
