-- RFC 0049 C27: the release whose runner a managed Deployment's replicas
-- run. While it is this release or the one before it, an API upgrade keeps
-- the replicas and their Jobs; an older one rolls. User Deployments run no
-- runner and keep NULL.
ALTER TABLE deployments ADD COLUMN runner_release TEXT;

