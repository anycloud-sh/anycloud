import BetterSqlite3 from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MigrationDatabase } from './migration-database.js';

/** The migrations that remove node pools, Deployments and node pool Services. */
export const REMOVAL_MIGRATIONS: ReadonlySet<string> = new Set([
  '0171_remove_deployments.sql',
  '0172_remove_node_pools.sql',
]);

const columnsOf = (db: Pick<MigrationDatabase, 'query'>, table: string) =>
  new Set(
    db
      .query<{ name: string }>('SELECT name FROM pragma_table_info(?)', [table])
      .map((column) => column.name),
  );

/**
 * Refuses, before either removal migration runs and so before anything
 * changes, while the database still holds a live node pool, Deployment, node
 * pool Service or Job on either: `api upgrade` names them first, and this
 * catches every other path (an older CLI, a local API, a restored backup).
 */
export function refuseRemovedWorkloads(
  db: Pick<MigrationDatabase, 'query'>,
): void {
  const live: string[] = [];
  const name = (rows: Array<{ kind: string; id: string; name: string }>) =>
    live.push(
      ...rows.map(({ kind, id, name: label }) =>
        label === id ? `${kind} ${id}` : `${kind} ${label} (${id})`,
      ),
    );
  // Only a Deployment on a node pool (0121 on) is live work: before 0106
  // `deployments` held the Workloads, and a Cluster's Deployments before 0122
  // are history 0122 removes behind its own guard.
  const poolDeployments = columnsOf(db, 'deployments').has('node_pool_id');
  const workloadColumns = columnsOf(db, 'workloads');
  const targets = [
    ...(workloadColumns.has('node_pool_id')
      ? ['node_pool_id IS NOT NULL']
      : []),
    ...(poolDeployments && workloadColumns.has('deployment_id')
      ? [
          'deployment_id IN (SELECT id FROM deployments WHERE node_pool_id IS NOT NULL)',
        ]
      : []),
  ];
  if (targets.length > 0) {
    name(
      db.query(
        `SELECT CASE WHEN workload_type = 'service'
                  THEN 'node pool Service' ELSE 'Job on a Deployment' END AS kind,
                id, id AS name
         FROM workloads
         WHERE (${targets.join(' OR ')})
           AND cleaned_at IS NULL
         ORDER BY id`,
      ),
    );
  }
  if (poolDeployments) {
    name(
      db.query(
        `SELECT 'Deployment' AS kind, id, name FROM deployments
         WHERE deleted_at IS NULL AND node_pool_id IS NOT NULL ORDER BY id`,
      ),
    );
  }
  if (columnsOf(db, 'node_pools').size > 0) {
    name(
      db.query(
        `SELECT 'node pool' AS kind, p.id, p.name FROM node_pools p
         WHERE p.state <> 'deleted' OR EXISTS (
           SELECT 1 FROM vms v WHERE v.node_pool_id = p.id AND v.ended_at IS NULL)
         ORDER BY p.id`,
      ),
    );
  }
  if (live.length > 0) {
    throw new Error(
      [
        'This release removes node pools, Kubernetes Deployments and node pool Services, and this database still has:',
        ...live.map((entry) => `  ${entry}`),
        'Nothing was changed. Remove them with the previous release ("anycloud terminate <id>" for each Service, "anycloud deployment delete <name>", then "anycloud node-pool delete <name>"), then upgrade again.',
      ].join('\n'),
    );
  }
}

/**
 * The same refusal against the API database in `directory`, opened read-only:
 * the system release's pre-upgrade hook runs it while the API it would
 * replace still serves.
 */
export function refuseRemovedWorkloadsIn(directory: string): void {
  const path = ['api.db', 'conductor.db']
    .map((name) => join(directory, name))
    .find((candidate) => existsSync(candidate));
  if (!path) return;
  const database = new BetterSqlite3(path, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    refuseRemovedWorkloads({
      query: <T>(sql: string, params: unknown[] = []) =>
        database.prepare(sql).all(...params) as T[],
    });
  } finally {
    database.close();
  }
}
