-- The quota submission worker has been retired. Preserve completed provider
-- results and explicitly cancel every target that it had not completed.
UPDATE quota_operation_targets
SET status = 'completed',
    error = 'Canceled: Anycloud quota submissions were retired. Request any remaining increase through the cloud provider.',
    completed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE status IN ('pending', 'running');

UPDATE quota_operations
SET status = 'completed',
    completed_targets = total_targets,
    failed_targets = (SELECT COUNT(*) FROM quota_operation_targets t
                      WHERE t.operation_id = quota_operations.id AND t.error IS NOT NULL),
    completed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE status IN ('queued', 'running');
