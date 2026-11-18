/** Current-schema ownership checks; historical cutovers keep their own readers. */
import type { MigrationDatabase } from './migration-database.js';

/**
 * Every Workload owns one container spec. Before Deployments were removed
 * (0171), a targeted Job on a user Deployment owned none, and before
 * `deployments.managed` (0146), no targeted Job owned one.
 */
export function auditContainerSpecOwnership(
  db: Pick<MigrationDatabase, 'query'>,
): void {
  const deployments = db.query(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deployments'",
  ).length;
  const invalidOwners = deployments
    ? historicalInvalidOwners(db)
    : db.query(`
    SELECT w.id FROM workloads w LEFT JOIN container_specs s ON s.workload_id = w.id
    GROUP BY w.id HAVING COUNT(s.workload_id) <> 1
    UNION ALL
    SELECT s.workload_id FROM container_specs s
      LEFT JOIN workloads w ON w.id = s.workload_id
    WHERE w.id IS NULL OR w.workload_type NOT IN ('job', 'service', 'vm')
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

function historicalInvalidOwners(
  db: Pick<MigrationDatabase, 'query'>,
): unknown[] {
  const managed = db.query(
    "SELECT 1 FROM pragma_table_info('deployments') WHERE name = 'managed'",
  ).length;
  const specless = managed ? 't.managed = 0' : 'w.deployment_id IS NOT NULL';
  return db.query(`
    SELECT w.id FROM workloads w LEFT JOIN container_specs s ON s.workload_id = w.id
      LEFT JOIN deployments t ON t.id = w.deployment_id
    GROUP BY w.id
    HAVING COUNT(s.workload_id) <> CASE WHEN ${specless} THEN 0 ELSE 1 END
    UNION ALL
    SELECT w.id FROM deployments w LEFT JOIN container_specs s ON s.deployment_id = w.id
    GROUP BY w.id HAVING COUNT(s.deployment_id) <> 1
    UNION ALL
    SELECT COALESCE(s.workload_id, s.deployment_id) FROM container_specs s
      LEFT JOIN workloads w ON w.id = s.workload_id
      LEFT JOIN deployments deployment ON deployment.id = s.deployment_id
      LEFT JOIN deployments t ON t.id = w.deployment_id
    WHERE (s.workload_id IS NULL) = (s.deployment_id IS NULL)
       OR (s.workload_id IS NOT NULL AND (w.id IS NULL OR ${specless}
         OR w.workload_type NOT IN ('job', 'service', 'vm')))
       OR (s.deployment_id IS NOT NULL AND deployment.id IS NULL)
    LIMIT 1`);
}
