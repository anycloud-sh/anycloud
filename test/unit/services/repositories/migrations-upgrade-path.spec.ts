import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../../../../src/api/services/repositories/migrations.js';
import type { MigrationDatabase } from '../../../../src/api/services/repositories/migration-database.js';

/**
 * Migration runner coverage on a file-backed SQLite database: the catalog,
 * the API version stamp and downgrade refusal, and the fresh-install schema.
 */
describe('migrations upgrade path', () => {
  let tmpDir: string;
  let dbPath: string;
  let sqlite: BetterSqlite3.Database;
  let migrationDb: MigrationDatabase;
  const db = {
    query: <T>(sql: string, params?: unknown[]): Promise<T[]> =>
      Promise.resolve(sqlite.prepare(sql).all(...(params ?? [])) as T[]),
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'anycloud-migration-upgrade-'));
    dbPath = join(tmpDir, 'upgrade.db');
    sqlite = new BetterSqlite3(dbPath);
    migrationDb = {
      get inTransaction() {
        return sqlite.inTransaction;
      },
      exec(sql) {
        sqlite.exec(sql);
      },
      query<T>(sql: string, params?: unknown[]): T[] {
        const statement = sqlite.prepare(sql);
        if (statement.reader) {
          return statement.all(...(params ?? [])) as T[];
        }
        return [
          { rowsAffected: statement.run(...(params ?? [])).changes },
        ] as T[];
      },
    };
  });

  afterEach(() => {
    sqlite.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps migration numeric versions unique', () => {
    const byVersion = new Map<string, string[]>();
    for (const file of readdirSync(join(process.cwd(), 'migrations')).filter(
      (name) => name.endsWith('.sql'),
    )) {
      const match = file.match(/^(\d+)_.*\.sql$/);
      if (!match) {
        throw new Error(`Invalid migration filename: ${file}`);
      }
      const files = byVersion.get(match[1]) ?? [];
      files.push(file);
      byVersion.set(match[1], files);
    }

    const duplicates = [...byVersion.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([version, files]) => `${version}: ${files.join(', ')}`);
    expect(duplicates).toEqual([]);
  });

  it('records the current app version after full migrations', async () => {
    await runMigrations(migrationDb, undefined, '1.2.3');

    const rows = await db.query<{ value: string }>(
      `SELECT value FROM _metadata WHERE key = ?`,
      ['schema_app_version'],
    );
    expect(rows).toEqual([{ value: '1.2.3' }]);
  });

  it('allows the same app version to start against the DB again', async () => {
    await runMigrations(migrationDb, undefined, '1.2.3');

    await expect(
      runMigrations(migrationDb, undefined, '1.2.3'),
    ).resolves.toBeUndefined();
  });

  it('allows a newer app version to update DB metadata', async () => {
    await runMigrations(migrationDb, undefined, '1.2.3');
    await runMigrations(migrationDb, undefined, '1.2.4');

    const rows = await db.query<{ value: string }>(
      `SELECT value FROM _metadata WHERE key = ?`,
      ['schema_app_version'],
    );
    expect(rows).toEqual([{ value: '1.2.4' }]);
  });

  it('0036/S20 refuses to start an older app version against a newer DB', async () => {
    await runMigrations(migrationDb, undefined, '1.2.4');

    await expect(
      runMigrations(migrationDb, undefined, '1.2.3'),
    ).rejects.toThrow(/refusing to start older API 1\.2\.3/);
  });

  it('0139 installs fresh with an optional node pool region', async () => {
    await runMigrations(migrationDb);
    await expect(
      db.query(
        `SELECT "notnull" FROM pragma_table_info('node_pools') WHERE name = 'region'`,
      ),
    ).resolves.toEqual([{ notnull: 0 }]);
  });

  it('0165 rebuilds clusters keeping its rows and children, and takes the new creation steps', async () => {
    await runMigrations(migrationDb, 164);
    sqlite.exec(`
      INSERT INTO credentials (id, encrypted_data, cloud_provider, name, created_at, last_used_at)
        VALUES ('cred-1', 'x', 'AWS', 'aws', 1, 1);
      INSERT INTO clusters (id, owner_user_id, name, state, step, compute_credential_id,
          region, vm_type, kubernetes_identity, identity_generation, restore_from_backup,
          checkpoint_bucket, checkpoint_bucket_managed, created_at, updated_at)
        VALUES ('c1', 'u1', 'prod', 'ready', 'release', 'cred-1', 'us-east-1',
          't3.medium', 'uid-1', 1, 1, 'c1', 1, 1, 2);
      INSERT INTO vms (cluster_id, cloud_id, created_at, credential_id)
        VALUES ('c1', 'i-1', 1, 'cred-1');
    `);
    await runMigrations(migrationDb);
    await expect(
      db.query(
        `SELECT id, step, region, identity_generation, restore_from_backup,
                cloud_provider FROM clusters`,
      ),
    ).resolves.toEqual([
      {
        id: 'c1',
        step: 'release',
        region: 'us-east-1',
        identity_generation: 1,
        restore_from_backup: 1,
        cloud_provider: null,
      },
    ]);
    await expect(
      db.query(`SELECT cluster_id FROM vms WHERE cloud_id = 'i-1'`),
    ).resolves.toEqual([{ cluster_id: 'c1' }]);
    for (const step of [
      'installer-access',
      'backup-trust',
      'backup-check',
      'ssh-close',
    ]) {
      sqlite.prepare(`UPDATE clusters SET step = ? WHERE id = 'c1'`).run(step);
    }
    expect(() =>
      sqlite
        .prepare(`UPDATE clusters SET step = 'other' WHERE id = 'c1'`)
        .run(),
    ).toThrow(/CHECK constraint failed/);
    // The triggers came back with the table.
    expect(() =>
      sqlite.prepare(`UPDATE clusters SET region = 'x' WHERE id = 'c1'`).run(),
    ).toThrow(/Cluster identity is immutable/);
    // A user's bucket never becomes a managed one, which delete would remove.
    sqlite.exec(`
      INSERT INTO clusters (id, owner_user_id, name, state, step, compute_credential_id,
          checkpoint_bucket, checkpoint_bucket_managed, created_at, updated_at)
        VALUES ('c0', 'u1', 'old', 'destroyed', 'release', 'cred-1', 'mine', 0, 1, 1);
    `);
    expect(() =>
      sqlite
        .prepare(
          `UPDATE clusters SET checkpoint_bucket_managed = 1 WHERE id = 'c0'`,
        )
        .run(),
    ).toThrow(/Cluster identity is immutable/);
    // ... and is never cleared: delete keeps a supplied bucket.
    expect(() =>
      sqlite
        .prepare(`UPDATE clusters SET checkpoint_bucket = NULL WHERE id = 'c0'`)
        .run(),
    ).toThrow(/Cluster identity is immutable/);
    // A managed bucket changes only to NULL, when a delete removed it (C28).
    for (const sql of [
      `checkpoint_bucket = 'other'`,
      'checkpoint_bucket_managed = 0',
    ]) {
      expect(
        () =>
          sqlite.prepare(`UPDATE clusters SET ${sql} WHERE id = 'c1'`).run(),
        sql,
      ).toThrow(/Cluster identity is immutable/);
    }
    sqlite
      .prepare(
        `UPDATE clusters SET checkpoint_bucket = NULL, checkpoint_bucket_managed = 0 WHERE id = 'c1'`,
      )
      .run();
    expect(() =>
      sqlite
        .prepare(`UPDATE clusters SET checkpoint_bucket = 'c1' WHERE id = 'c1'`)
        .run(),
    ).toThrow(/Cluster identity is immutable/);
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO node_pools (id, cluster_id, owner_user_id, name, state,
             compute_credential_id, vm_type, min_vm_count, max_vm_count,
             created_at, updated_at)
           VALUES ('p1', 'missing', 'u1', 'p', 'creating', 'cred-1', '["t3"]', 0, 1, 1, 1)`,
        )
        .run(),
    ).toThrow(/Cluster does not accept node pools/);
  });

  it('0029/S13 keeps performance-critical indexes in the final migrated schema', async () => {
    await runMigrations(migrationDb);

    const indexes = sqlite
      .prepare(
        `SELECT name, tbl_name, sql
         FROM sqlite_master
         WHERE type = 'index'
           AND name IN (
             'idx_vms_active',
             'idx_vms_node_pool_active',
             'idx_vms_node_pool_attempt',
             'idx_vms_cluster_active',
             'idx_vms_cluster_attempt',
             'idx_vms_pending_cost_group',
             'idx_vms_workload_attempt',
             'idx_vms_spend_window',
             'idx_vms_needing_cost',
             'idx_vms_cloud_id',
             'idx_node_pools_active_name',
             'idx_deployments_active_name',
             'idx_deployments_node_pool',
             'idx_workloads_deployment',
             'idx_workloads_state_started',
             'idx_workloads_state_completed',
             'idx_workloads_pending_cleanup',
             'idx_workloads_submitted_at',
             'idx_events_workload_id',
             'idx_events_state_workload',
             'idx_events_resubmit',
             'idx_events_resubmit_created_at'
           )
         ORDER BY name`,
      )
      .all() as Array<{ name: string; tbl_name: string; sql: string | null }>;
    const byName = new Map(indexes.map((row) => [row.name, row]));
    const deploymentIndexColumns = sqlite
      .prepare(`PRAGMA index_info('idx_workloads_deployment')`)
      .all() as Array<{ name: string }>;

    expect([...byName.keys()].sort()).toEqual(
      [
        'idx_node_pools_active_name',
        'idx_workloads_pending_cleanup',
        'idx_workloads_state_completed',
        'idx_workloads_state_started',
        'idx_workloads_submitted_at',
        'idx_workloads_deployment',
        'idx_events_workload_id',
        'idx_events_resubmit',
        'idx_events_resubmit_created_at',
        'idx_events_state_workload',
        'idx_vms_active',
        'idx_vms_cloud_id',
        'idx_vms_node_pool_active',
        'idx_vms_node_pool_attempt',
        'idx_vms_cluster_active',
        'idx_vms_cluster_attempt',
        'idx_vms_pending_cost_group',
        'idx_vms_workload_attempt',
        'idx_vms_needing_cost',
        'idx_vms_spend_window',
        'idx_deployments_active_name',
        'idx_deployments_node_pool',
      ].sort(),
    );
    expect(byName.get('idx_vms_node_pool_attempt')?.sql).toContain(
      'WHERE node_pool_id IS NOT NULL',
    );
    expect(byName.get('idx_vms_pending_cost_group')?.sql).toContain(
      'COALESCE(node_pool_id, cluster_id, workload_id)',
    );

    // Regression for the live-VM index lost during the 0015 vms rebuild: the
    // table still migrated cleanly, but recurring monitors fell back to
    // lifetime scans. Pin the partial predicate, not just the index name.
    expect(byName.get('idx_vms_active')?.tbl_name).toBe('vms');
    expect(byName.get('idx_vms_active')?.sql).toContain(
      'WHERE ended_at IS NULL',
    );
    expect(byName.get('idx_vms_needing_cost')?.sql).toContain('cost IS NULL');
    expect(byName.get('idx_vms_node_pool_active')?.sql).toContain(
      'node_pool_id IS NOT NULL AND ended_at IS NULL',
    );
    expect(byName.get('idx_node_pools_active_name')?.sql).toContain(
      "WHERE state <> 'deleted'",
    );
    expect(byName.get('idx_workloads_deployment')?.sql).toContain(
      'WHERE deployment_id IS NOT NULL',
    );
    expect(deploymentIndexColumns.map(({ name }) => name)).toEqual([
      'deployment_id',
      'state',
      'submitted_at',
      'id',
      'first_claimed_at',
      'claim_deadline_at',
      'submission_revision',
      'current_execution_id',
    ]);
    expect(byName.get('idx_workloads_state_completed')?.sql).toContain(
      'WHERE completed_at IS NOT NULL',
    );
    expect(byName.get('idx_workloads_pending_cleanup')?.sql).toContain(
      'WHERE completed_at IS NOT NULL AND cleaned_at IS NULL',
    );
    for (const name of [
      'idx_events_resubmit',
      'idx_events_resubmit_created_at',
    ]) {
      expect(byName.get(name)?.sql).toContain('json_valid(metadata)');
    }
  });
});
