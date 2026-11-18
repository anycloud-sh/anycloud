import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../../../src/api/services/repositories/migrations.js';
import { refuseRemovedWorkloadsIn } from '../../../../src/api/services/repositories/removed-workloads-guard.js';
import { auditContainerSpecOwnership } from '../../../../src/api/services/repositories/container-spec-ownership.js';
import type { MigrationDatabase } from '../../../../src/api/services/repositories/migration-database.js';

/**
 * 0171 and 0172 remove Deployments and node pools: the guard refuses them
 * while any is live, and once only history remains they drop it and keep
 * every VM-host Workload as it was.
 */
describe('removing Deployments and node pools (0171, 0172)', () => {
  let sqlite: BetterSqlite3.Database;
  let database: MigrationDatabase;
  const rows = (sql: string) =>
    sqlite.prepare(sql).all() as Record<string, unknown>[];
  const columns = (table: string) =>
    rows(`SELECT name FROM pragma_table_info('${table}')`).map(
      (column) => column.name as string,
    );
  const applied = () =>
    sqlite.prepare('SELECT MAX(version) FROM _migrations').pluck().get();

  beforeEach(async () => {
    sqlite = new BetterSqlite3(':memory:');
    database = {
      get inTransaction() {
        return sqlite.inTransaction;
      },
      exec(sql) {
        sqlite.exec(sql);
      },
      query<T>(sql: string, params?: unknown[]): T[] {
        const statement = sqlite.prepare(sql);
        if (statement.reader) return statement.all(...(params ?? [])) as T[];
        return [
          { rowsAffected: statement.run(...(params ?? [])).changes },
        ] as T[];
      },
    };
    await runMigrations(database, 170);
    sqlite.exec(`
      INSERT INTO credentials (id, encrypted_data, cloud_provider) VALUES ('cred', 'x', 'AWS');
      INSERT INTO clusters (id, owner_user_id, name, state, step, created_at, updated_at)
        VALUES ('cluster', 'owner', 'main', 'ready', 'intent', 1, 1);
      INSERT INTO node_pools (id, cluster_id, owner_user_id, name, state,
          compute_credential_id, vm_type, min_vm_count, max_vm_count, created_at, updated_at)
        VALUES ('pool-1', 'cluster', 'owner', 'gpu', 'ready', 'cred', 't3.small', 1, 1, 1, 1);
      INSERT INTO deployments (id, owner_user_id, name, node_pool_id, gpu_count,
          managed, created_at, updated_at)
        VALUES ('dep-1', 'owner', 'model', 'pool-1', 0, 1, 1, 1);
      INSERT INTO container_specs (deployment_id, image, registry_username)
        VALUES ('dep-1', 'model:1', 'enc');
      INSERT INTO api_access_users (user_id, username) VALUES
        ('serviceaccount:anycloud:dep-1', 'dep-1'), ('42', 'octocat');
    `);
    const workload = sqlite.prepare(
      `INSERT INTO workloads (id, user_id, workload_type, state, started_at,
         docker_command, deployment_id, node_pool_id, cleaned_at)
       VALUES (?, 'u', ?, ?, 1, 'docker run', ?, ?, ?)`,
    );
    const spec = sqlite.prepare(
      `INSERT INTO container_specs (workload_id, image, registry_username)
       VALUES (?, 'img:1', 'enc')`,
    );
    const event = sqlite.prepare(
      `INSERT INTO workload_events (workload_id, state, metadata, created_at)
       VALUES (?, ?, '{"m":1}', 5)`,
    );
    const vm = sqlite.prepare(
      `INSERT INTO vms (workload_id, node_pool_id, cloud_id, ip, created_at,
         ended_at, credential_id, price_per_hour)
       VALUES (?, ?, ?, '10.0.0.1', 2, ?, 'cred', 0.5)`,
    );
    for (const [id, type, state, deployment, pool, cleaned] of [
      ['job-vm', 'job', 'completed', null, null, 9],
      ['svc-vm', 'service', 'running', null, null, null],
      ['job-dep', 'job', 'completed', 'dep-1', null, 9],
      ['svc-pool', 'service', 'terminated', null, 'pool-1', 9],
    ] as const) {
      workload.run(id, type, state, deployment, pool, cleaned);
      spec.run(id);
      event.run(id, state);
    }
    vm.run('job-vm', null, 'i-job', 3);
    vm.run('svc-vm', null, 'i-svc', null);
    vm.run(null, 'pool-1', 'i-pool', 4);
  });

  afterEach(() => sqlite.close());

  it('refuses while a node pool, Deployment, pool Service or Job on them is live, changing nothing', async () => {
    sqlite.exec(`
      INSERT INTO workloads (id, user_id, workload_type, state, started_at,
        docker_command, deployment_id) VALUES ('job-live', 'u', 'job', 'running', 1, 'd', 'dep-1');
      INSERT INTO workloads (id, user_id, workload_type, state, started_at,
        docker_command, node_pool_id) VALUES ('svc-live', 'u', 'service', 'running', 1, 'd', 'pool-1');
    `);
    const before = ['workloads', 'deployments', 'node_pools', 'vms'].map(
      (table) => rows(`SELECT * FROM ${table} ORDER BY rowid`),
    );

    await expect(runMigrations(database, undefined, '1.2.3')).rejects.toThrow(
      [
        'This release removes node pools, Kubernetes Deployments and node pool Services, and this database still has:',
        '  Job on a Deployment job-live',
        '  node pool Service svc-live',
        '  Deployment model (dep-1)',
        '  node pool gpu (pool-1)',
        'Nothing was changed.',
      ].join('\n'),
    );

    expect(applied()).toBe(170);
    expect(
      ['workloads', 'deployments', 'node_pools', 'vms'].map((table) =>
        rows(`SELECT * FROM ${table} ORDER BY rowid`),
      ),
    ).toEqual(before);
  });

  it("refuses from the running API's database file, read-only, as the pre-upgrade hook does", () => {
    const directory = mkdtempSync(join(tmpdir(), 'removed-workloads-'));
    try {
      // An upgrade always has a database: none is a wrong mount.
      expect(() => refuseRemovedWorkloadsIn(directory)).toThrow(
        `No API database in ${directory}`,
      );
      const file = join(directory, 'api.db');
      writeFileSync(file, sqlite.serialize());
      expect(() => refuseRemovedWorkloadsIn(directory)).toThrow(
        '  node pool gpu (pool-1)',
      );
      sqlite.exec(`
        UPDATE deployments SET deletion_requested_at = 2, deleted_at = 3;
        UPDATE node_pools SET state = 'deleted';
        UPDATE vms SET ended_at = 5 WHERE node_pool_id IS NOT NULL;
      `);
      writeFileSync(file, sqlite.serialize());
      expect(() => refuseRemovedWorkloadsIn(directory)).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reads a WAL database while the running API holds it open for writing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'removed-workloads-wal-'));
    const file = join(directory, 'api.db');
    writeFileSync(file, sqlite.serialize());
    // As the API opens it: WAL, with its writes still in the log.
    const writer = new BetterSqlite3(file);
    try {
      writer.pragma('journal_mode = WAL');
      writer.pragma('wal_autocheckpoint = 0');
      writer.exec(`
        INSERT INTO node_pools (id, cluster_id, owner_user_id, name, state,
            compute_credential_id, vm_type, min_vm_count, max_vm_count, created_at, updated_at)
          VALUES ('pool-2', 'cluster', 'owner', 'fresh', 'ready', 'cred', 't3.small', 0, 1, 1, 1);
      `);
      writer.exec('BEGIN IMMEDIATE');
      expect(() => refuseRemovedWorkloadsIn(directory)).toThrow(
        '  node pool fresh (pool-2)',
      );
      writer.exec('ROLLBACK');
    } finally {
      writer.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('drops the removed history and keeps every VM-host Workload byte for byte', async () => {
    sqlite.exec(`
      UPDATE deployments SET deletion_requested_at = 2, deleted_at = 3;
      UPDATE node_pools SET state = 'deleted';
      INSERT INTO pool_occupancy (deployment_id, pod_uid, vm_id, node_pool_id,
        share, gpus, opened_at, ended_at)
        SELECT 'dep-1', 'pod', id, 'pool-1', 1, 0, 2, 4 FROM vms WHERE cloud_id = 'i-pool';
    `);
    const kept = (table: string, key: string) =>
      rows(
        `SELECT * FROM ${table} WHERE ${key} IN ('job-vm', 'svc-vm') ORDER BY ${key}, rowid`,
      );
    const before = {
      workloads: kept('workloads', 'id'),
      container_specs: kept('container_specs', 'workload_id'),
      workload_events: kept('workload_events', 'workload_id'),
      vms: kept('vms', 'workload_id'),
    };

    await runMigrations(database, undefined, '1.2.3');

    for (const table of [
      'node_pools',
      'deployments',
      'pool_occupancy',
      'pod_attempts',
      'workload_attempts',
    ]) {
      expect(columns(table), table).toEqual([]);
    }
    for (const [table, previous] of Object.entries(before)) {
      const key = table === 'workloads' ? 'id' : 'workload_id';
      const now = columns(table);
      expect(rows(`SELECT * FROM ${table} ORDER BY ${key}, rowid`)).toEqual(
        previous.map((row) =>
          Object.fromEntries(now.map((column) => [column, row[column]])),
        ),
      );
    }
    expect(columns('workloads')).not.toContain('deployment_id');
    expect(columns('vms')).not.toContain('node_pool_id');
    expect(rows('SELECT user_id FROM api_access_users')).toEqual([
      { user_id: '42' },
    ]);
    expect(rows('PRAGMA foreign_key_check')).toEqual([]);
    expect(() => auditContainerSpecOwnership(database)).not.toThrow();
  });
});
