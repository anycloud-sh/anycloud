-- One breaker bounds a node pool's Node remediation. It counts the
-- pool's VMs replaced as unhealthy within a window and pauses, which replaces
-- the never-joined cap that failed the pool for good.
ALTER TABLE vms ADD COLUMN remediated_at INTEGER;
ALTER TABLE node_pools DROP COLUMN join_replacements;
ALTER TABLE node_pools DROP COLUMN join_replaced_at;
