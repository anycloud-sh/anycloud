/** Ownership audit for the historical migration-0105 schema. */
import type { MigrationDatabase } from './migration-database.js';

export function auditWorkloadRenameContainerSpecOwnership(
  db: Pick<MigrationDatabase, 'query'>,
): void {
  const invalidOwners = db.query(`
    SELECT w.id FROM workloads w LEFT JOIN container_specs s ON s.workload_id = w.id
    GROUP BY w.id
    HAVING COUNT(s.workload_id) <> CASE WHEN w.worker_id IS NULL THEN 1 ELSE 0 END
    UNION ALL
    SELECT w.id FROM workers w LEFT JOIN container_specs s ON s.worker_id = w.id
    GROUP BY w.id HAVING COUNT(s.worker_id) <> 1
    UNION ALL
    SELECT COALESCE(s.workload_id, s.worker_id) FROM container_specs s
      LEFT JOIN workloads w ON w.id = s.workload_id
      LEFT JOIN workers worker ON worker.id = s.worker_id
    WHERE (s.workload_id IS NULL) = (s.worker_id IS NULL)
       OR (s.workload_id IS NOT NULL AND (w.id IS NULL OR w.worker_id IS NOT NULL
         OR w.workload_type NOT IN ('job', 'service', 'vm')))
       OR (s.worker_id IS NOT NULL AND worker.id IS NULL)
    LIMIT 1`);
  if (invalidOwners.length > 0) {
    throw new Error('Container spec ownership check failed; refusing to start');
  }
  if (db.query('PRAGMA foreign_key_check').length > 0) {
    throw new Error(
      'Container spec foreign-key check failed; refusing to start',
    );
  }
}
