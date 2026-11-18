-- migrations/0019_add_docker_options.sql
-- Store docker runtime options (gpus, runtime, shmSize, etc.) so they survive retries

ALTER TABLE deployments ADD COLUMN docker_options TEXT;
