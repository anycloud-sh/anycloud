-- Add docker_command column to store the docker run command for debugging
-- Add bucket_name column to store the bucket name for the deployment
ALTER TABLE deployments ADD COLUMN docker_command TEXT NOT NULL;
ALTER TABLE deployments ADD COLUMN bucket_name TEXT;
