-- A node pool that admits privileged pool Jobs and their --bind volumes:
-- such a Job is root on its Node. Existing pools keep refusing them.
ALTER TABLE node_pools ADD COLUMN allow_privileged_jobs INTEGER NOT NULL DEFAULT 0
  CHECK (allow_privileged_jobs IN (0, 1));
