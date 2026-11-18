-- Deployment reconciliation is process-local and reconstructs its schedule
-- from authoritative deployment/event/VM state at startup. These cursor and
-- heartbeat columns belonged to the removed persistent due-pull reconciler.
ALTER TABLE deployments DROP COLUMN next_check_at;
ALTER TABLE deployments DROP COLUMN last_checked;
