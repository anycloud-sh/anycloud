-- A Deployment's fixed replica count, reversing RFC 0029's single
-- replica; admission reserves gpu_count × replicas on the node pool.
ALTER TABLE deployments ADD COLUMN replicas INTEGER NOT NULL DEFAULT 1
  CHECK (replicas >= 1);
