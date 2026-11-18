import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../../../../src/api/services/repositories/migrations.js';
import type { MigrationDatabase } from '../../../../src/api/services/repositories/migration-database.js';
import { auditContainerSpecOwnership } from '../../../../src/api/services/repositories/container-spec-ownership.js';
import * as crypto from '../../../../src/api/services/secret-crypto.js';
import { hostedApiIdentity } from '../../../../src/shared/hosted-api-identity.js';

type Row = Record<string, unknown>;

describe('0105 Workload rename through the current schema', () => {
  let sqlite: BetterSqlite3.Database;
  let database: MigrationDatabase;

  beforeEach(() => {
    sqlite = new BetterSqlite3(':memory:');
    database = {
      get inTransaction() {
        return sqlite.inTransaction;
      },
      exec(sql) {
        sqlite.exec(sql);
      },
      query<T>(sql: string, params: unknown[] = []): T[] {
        const statement = sqlite.prepare(sql);
        return (
          statement.reader
            ? statement.all(...params)
            : [{ rowsAffected: statement.run(...params).changes }]
        ) as T[];
      },
    };
  });

  afterEach(() => {
    sqlite.close();
    vi.restoreAllMocks();
  });

  function snapshot() {
    const schema = database.query<{
      type: string;
      name: string;
      tbl_name: string;
      sql: string | null;
    }>(
      'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name',
    );
    return {
      schema,
      tables: Object.fromEntries(
        schema
          .filter(({ type }) => type === 'table')
          .map(({ name }) => [
            name,
            database.query<Row>(`SELECT * FROM "${name}" ORDER BY rowid`),
          ]),
      ),
    };
  }

  async function populateLegacyDatabase(version = 104) {
    await runMigrations(database, version);
    database.query(
      "INSERT INTO _metadata VALUES ('schema_app_version', '1.0.0')",
    );
    database.query("INSERT INTO _metadata VALUES ('api_identity', ?)", [
      `v1:${hostedApiIdentity('service-a')}`,
    ]);
    database.query(
      "INSERT INTO credentials (id, encrypted_data, cloud_provider) VALUES ('credential-a', ?, 'AWS')",
      [await crypto.encryptSecret('{"credential":"retained"}')],
    );
    // The Cluster and its Worker are retained history: 0122 refuses a live
    // Cluster before any pending migration runs, then removes the history.
    sqlite.exec(`
      INSERT INTO clusters (id, kind, owner_user_id, name, state, created_at, updated_at)
        VALUES ('cluster-a', 'kubernetes', 'owner-a', 'cluster-a', 'deleted', 1, 1);
      INSERT INTO workers (id, owner_user_id, name, cluster_id, gpu_count, generation,
        deletion_requested_at, deleted_at, created_at, updated_at)
        VALUES ('worker-a', 'owner-a', 'worker-a', 'cluster-a', 0, 3, 20, 21, 1, 2);
    `);
    const sshKey = await crypto.encryptSecret('SSH_CANARY');
    for (const [id, type, state] of [
      ['job-a', 'job', 'completed'],
      ['service-a', 'service', 'recovering'],
      ['vm-a', 'vm', 'running'],
    ]) {
      database.query(
        `INSERT INTO deployments (id, user_id, owner_user_id, deployment_type, state,
          started_at, submitted_at, completed_at, docker_command, ssh_private_key,
          credential_id, dns_record_id, checkpoint_bucket, session, agent)
        VALUES (?, 'CapturedUser', 'owner-a', ?, ?, 10, 5, ?, 'diagnostic bytes', ?,
          'credential-a', 'dns-record-retained', 'checkpoint-retained', 'session-a', 'agent-a')`,
        [id, type, state, state === 'completed' ? 20 : null, sshKey],
      );
    }
    const registryUsername = await crypto.encryptSecret('CapturedUser');
    const registryToken = await crypto.encryptSecret('TOKEN_CANARY');
    const env = await crypto.encryptSecret('{ "VALUE": "ENV_CANARY" }');
    for (const id of ['job-a', 'service-a', 'vm-a', 'worker-a']) {
      database.query(
        `INSERT INTO container_specs (deployment_id, worker_id, image, image_digest,
          command, docker_options, env, registry_username, registry_token)
        VALUES (?, ?, 'accepted:image', 'sha256:accepted', '[ "run" ]', '{ "cpus": "2" }', ?, ?, ?)`,
        [
          id === 'worker-a' ? null : id,
          id === 'worker-a' ? id : null,
          env,
          registryUsername,
          registryToken,
        ],
      );
    }
    sqlite.exec(`
      INSERT INTO deployments (id, user_id, owner_user_id, deployment_type, worker_id,
        current_execution_id, state, started_at, submitted_at, completed_at, docker_command,
        submission_revision, first_claimed_at, claim_deadline_at)
        VALUES ('worker-job', 'CapturedUser', 'owner-a', 'job', 'worker-a',
          'execution-a', 'completed', 15, 12, 19, '', 2, 15, 30);
      INSERT INTO deployment_events (id, deployment_id, state, metadata, created_at)
        VALUES (41, 'job-a', 'completed', '{ "message": "retained history" }', 20),
          (42, 'worker-job', 'running', '{"executionId":"execution-a","podUid":"pod-a"}', 15);
      INSERT INTO vms (id, deployment_id, cluster_id, cloud_id, ip, created_at,
        credential_id, checkpoint_host_path, removal_requested_at)
        VALUES (11, 'service-a', NULL, 'existing-cloud-vm', '192.0.2.10', 10,
          'credential-a', '/var/lib/anycloud/deployments/service-a/checkpoint', NULL),
          (12, NULL, 'cluster-a', 'existing-cluster-host', '192.0.2.11', 9,
          'credential-a', NULL, NULL);
      INSERT INTO api_ownership_backfill_targets (vm_id, status, attempts, last_error, updated_at)
        VALUES (11, 'retry', 2, 'retryable', 19), (12, 'completed', 1, NULL, 19);
      UPDATE vms SET ended_at = 20 WHERE id = 11;
      UPDATE vms SET ended_at = 18, cost = 1.5 WHERE id = 12;
    `);
  }

  it('installs only current tables, columns, indexes and guards on an empty database', async () => {
    await runMigrations(database, undefined, '2.0.0');
    expect(
      database.query('SELECT version FROM _migrations WHERE version = 105'),
    ).toHaveLength(1);
    expect(
      snapshot().schema.some(({ name, sql }) =>
        /worker|deployment_events|deployment_type/i.test(
          name + (sql ?? '').replaceAll("'anycloud_deployment'", ''),
        ),
      ),
    ).toBe(false);
    for (const table of [
      'workloads',
      'workload_events',
      'vms',
      'container_specs',
    ]) {
      expect(database.query(`SELECT * FROM ${table}`)).toEqual([]);
    }
    expect(() => database.query('SELECT * FROM workers')).toThrow(
      'no such table',
    );
    const before = snapshot();
    await runMigrations(database, undefined, '2.0.0');
    expect(snapshot()).toEqual(before);
  });

  it.each([103, 104])(
    'preserves every populated row, execution, ownership reference and encrypted byte through upgrade from schema %i and restart',
    async (version) => {
      await populateLegacyDatabase(version);
      const before = snapshot();
      const encrypt = vi.spyOn(crypto, 'encryptSecret');
      const decrypt = vi.spyOn(crypto, 'decryptSecret');
      // 0121 is the last schema that still holds the Cluster-era rows.
      await runMigrations(database, 121);

      const renamed = snapshot();
      const tableNames: Record<string, string> = {
        deployments: 'workloads',
        deployment_events: 'workload_events',
        workers: 'deployments',
      };
      const columns: Record<string, string> = {
        deployment_id: 'workload_id',
        deployment_type: 'workload_type',
        worker_id: 'deployment_id',
      };
      for (const [table, rows] of Object.entries(before.tables)) {
        if (table === '_migrations' || table === '_metadata') continue;
        const expected = rows.map((row) => ({
          ...Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              columns[key] ?? key,
              table === 'sqlite_sequence' &&
              key === 'name' &&
              value === 'deployment_events'
                ? 'workload_events'
                : value,
            ]),
          ),
          // 0117 adds the Deployment node pool target next to the Cluster.
          ...(table === 'workers'
            ? { readiness_probe: null, node_pool_id: null }
            : {}),
          // 0110 and 0111 add the node pool and root installation owners;
          // 0116 adds the Service node pool target.
          ...(table === 'vms'
            ? { node_pool_id: null, root_installation_id: null }
            : {}),
          ...(table === 'deployments' ? { node_pool_id: null } : {}),
        }));
        expect(renamed.tables[tableNames[table] ?? table], table).toEqual(
          expected,
        );
      }
      expect(
        renamed.tables._migrations.filter(
          (row) => Number(row.version) <= version,
        ),
      ).toEqual(before.tables._migrations);
      expect(encrypt).not.toHaveBeenCalled();
      expect(decrypt).not.toHaveBeenCalled();
      expect(sqlite.pragma('foreign_key_check')).toEqual([]);

      // 0122 removes the Cluster history and keeps every VM-host row.
      await runMigrations(database, undefined, '2.0.0');
      const after = snapshot();
      const clusterHistory = new Set([
        'worker-a',
        'worker-job',
        'existing-cluster-host',
        'cluster-a',
      ]);
      const survives = (row: Row) =>
        ![
          row.id,
          row.workload_id,
          row.deployment_id,
          row.cloud_id,
          row.cluster_id,
        ].some(
          (value) => typeof value === 'string' && clusterHistory.has(value),
        );
      // 0126 folds the root installation and root tables into one cluster
      // record (an unrelated `clusters` table) and renames the VM owner.
      const collapsed: Record<string, string> = {
        kubernetes_root_installations: 'clusters',
        root_installation_id: 'cluster_id',
      };
      // 0171 and 0172 drop the Deployment and node pool columns.
      const removed: Record<string, string[]> = {
        workloads: [
          'deployment_id',
          'current_execution_id',
          'submission_revision',
          'first_claimed_at',
          'claim_deadline_at',
          'node_pool_id',
        ],
        container_specs: ['deployment_id'],
        vms: ['node_pool_id'],
      };
      for (const [table, rows] of Object.entries(renamed.tables)) {
        // 0122 drops the Cluster tables; 0123 drops checkpoint publication.
        if (
          [
            '_migrations',
            '_metadata',
            'clusters',
            'cluster_capacity',
            'kubernetes_roots',
            'kubernetes_root_release_intents',
            'system_release_intents',
          ].includes(table) ||
          table.startsWith('checkpoint_')
        ) {
          continue;
        }
        // 0171 and 0172 drop the Deployment and node pool tables, empty here.
        if (table === 'deployments' || table === 'node_pools') {
          expect(rows.filter(survives)).toEqual([]);
          expect(after.tables[table]).toBeUndefined();
          continue;
        }
        if (table === 'api_ownership_backfill_targets') {
          expect(after.tables[table], table).toEqual(
            rows.filter((row) => row.vm_id === 11),
          );
          continue;
        }
        expect(after.tables[collapsed[table] ?? table], table).toEqual(
          rows.filter(survives).map(({ cluster_id: _dropped, ...row }) => ({
            ...Object.fromEntries(
              Object.entries(row)
                .filter(([key]) => !removed[table]?.includes(key))
                .map(([key, value]) => [collapsed[key] ?? key, value]),
            ),
            // 0129 adds the cleanup reason.
            ...(table === 'workloads'
              ? {
                  cleanup_error: null,
                  end_reason: null,
                  last_attempt_end_reason: null,
                  max_retries: null,
                  no_checkpoint: 0,
                  require_nested_virtualization: 0,
                  host_docker: 0,
                  disk_iops: null,
                  disk_throughput_mibps: null,
                  regions: null,
                }
              : {}),
            // 0137 adds the launch failure columns.
            ...(table === 'vms'
              ? {
                  launch_diagnosis: null,
                  launch_region_denied: null,
                }
              : {}),
          })),
        );
      }
      expect(after.tables.clusters).toEqual([]);
      expect(after.tables._metadata).toEqual(
        before.tables._metadata.map((row) =>
          row.key === 'schema_app_version' ? { ...row, value: '2.0.0' } : row,
        ),
      );
      expect(sqlite.pragma('foreign_key_check')).toEqual([]);
      expect(sqlite.pragma('foreign_key_list(vms)')).toContainEqual(
        expect.objectContaining({
          table: 'workloads',
          from: 'workload_id',
          to: 'id',
          on_delete: 'CASCADE',
        }),
      );
      expect(sqlite.pragma('foreign_key_list(container_specs)')).toContainEqual(
        expect.objectContaining({
          table: 'workloads',
          from: 'workload_id',
          to: 'id',
          on_delete: 'CASCADE',
        }),
      );
      // Migration 0104's expression index must survive the renames, retaining
      // its provider tag while querying the renamed owner column and existing
      // rows; 0122 rebuilt it without the Cluster owner and 0126 with the
      // cluster record as the management VM's owner.
      expect(
        database.query(`SELECT cloud_id FROM vms INDEXED BY idx_vms_pending_cost_group
        WHERE cost IS NULL AND ended_at IS NOT NULL
          AND (workload_id IS NOT NULL OR cluster_id IS NOT NULL)
          AND CASE WHEN workload_id IS NOT NULL THEN 'anycloud_deployment' ELSE 'anycloud_resource' END = 'anycloud_deployment'
          AND COALESCE(cluster_id, workload_id) = 'service-a'`),
      ).toEqual([{ cloud_id: 'existing-cloud-vm' }]);

      await runMigrations(database, undefined, '2.0.0');
      expect(snapshot()).toEqual(after);
      database.query(
        "INSERT INTO workload_events (workload_id, state) VALUES ('job-a', 'completed')",
      );
      expect(
        database.query('SELECT MAX(id) AS id FROM workload_events'),
      ).toEqual([{ id: 43 }]);
    },
  );

  it.each(['script', 'receipt', 'version', 'ownership', 'foreign key'])(
    'rolls back the complete rename on a %s failure and can retry',
    async (failure) => {
      await populateLegacyDatabase();
      if (failure === 'receipt')
        sqlite.exec(`CREATE TRIGGER reject_rename BEFORE INSERT ON _migrations
        WHEN NEW.version = 105 BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END`);
      if (failure === 'version')
        sqlite.exec(`CREATE TRIGGER reject_rename BEFORE UPDATE ON _metadata
        WHEN NEW.value = '2.0.0' BEGIN SELECT RAISE(ABORT, 'injected version failure'); END`);
      if (failure === 'ownership')
        sqlite.exec(`INSERT INTO deployments
        (id, user_id, deployment_type, state, started_at, docker_command)
        VALUES ('missing-spec', 'u', 'service', 'queued', 1, '')`);
      if (failure === 'foreign key') {
        sqlite.pragma('foreign_keys = OFF');
        sqlite.exec(`INSERT INTO deployment_events (deployment_id, state)
          VALUES ('missing-owner', 'completed')`);
        sqlite.pragma('foreign_keys = ON');
      }
      const before = snapshot();
      const exec = database.exec;
      database.exec = (sql) => {
        exec(sql);
        if (
          failure === 'script' &&
          sql.includes('ALTER TABLE deployments RENAME')
        ) {
          throw new Error('injected SQL failure');
        }
      };
      await expect(runMigrations(database, undefined, '2.0.0')).rejects.toThrow(
        /injected|ownership check failed|foreign-key check failed/,
      );
      expect(snapshot()).toEqual(before);
      expect(sqlite.inTransaction).toBe(false);
      expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
      database.exec = exec;
      if (failure === 'receipt' || failure === 'version')
        sqlite.exec('DROP TRIGGER reject_rename');
      if (failure === 'ownership')
        sqlite.exec("DELETE FROM deployments WHERE id = 'missing-spec'");
      if (failure === 'foreign key')
        sqlite.exec(
          "DELETE FROM deployment_events WHERE deployment_id = 'missing-owner'",
        );
      await runMigrations(database, undefined, '2.0.0');
      expect(
        database.query('SELECT version FROM _migrations WHERE version = 105'),
      ).toEqual([{ version: 105 }]);
      auditContainerSpecOwnership(database);
    },
  );

  it('retains ownership and replacement guards and permits Service updates and VM cascades', async () => {
    await populateLegacyDatabase();
    await runMigrations(database, undefined, '2.0.0');
    sqlite.pragma('recursive_triggers = OFF');
    const before = snapshot();
    for (const sql of [
      "UPDATE workloads SET workload_type = 'service' WHERE id = 'job-a'",
      "UPDATE workloads SET owner_user_id = 'another-owner' WHERE id = 'job-a'",
      "INSERT OR REPLACE INTO workloads (id, user_id, workload_type, state, started_at, docker_command) VALUES ('job-a', 'u', 'job', 'queued', 1, '')",
      "UPDATE container_specs SET image = 'changed' WHERE workload_id = 'job-a'",
      "UPDATE container_specs SET image = 'changed' WHERE workload_id = 'vm-a'",
      "UPDATE OR REPLACE container_specs SET workload_id = 'vm-a' WHERE workload_id = 'service-a'",
      "INSERT INTO container_specs (workload_id, image, registry_username) VALUES ('job-a', 'img', 'ciphertext')",
      "INSERT INTO workload_events (workload_id, state) VALUES ('missing', 'running')",
    ]) {
      expect(() => sqlite.exec(sql), sql).toThrow();
      expect(snapshot(), sql).toEqual(before);
    }
    sqlite.exec(
      "UPDATE container_specs SET image = 'upgraded:image' WHERE workload_id = 'service-a'",
    );
    sqlite.exec("DELETE FROM workloads WHERE id = 'service-a'");
    expect(database.query('SELECT id FROM vms ORDER BY id')).toEqual([]);
    expect(
      database.query('SELECT * FROM api_ownership_backfill_targets'),
    ).toEqual([]);
    expect(
      database.query(
        "SELECT * FROM container_specs WHERE workload_id = 'service-a'",
      ),
    ).toEqual([]);
    auditContainerSpecOwnership(database);
  });

  it('rejects damaged current ownership on subsequent startup without advancing the version', async () => {
    await populateLegacyDatabase();
    await runMigrations(database, undefined, '2.0.0');
    sqlite.exec(`DROP TRIGGER container_specs_no_detach;
      DELETE FROM container_specs WHERE workload_id = 'service-a'`);
    const before = snapshot();
    await expect(runMigrations(database, undefined, '3.0.0')).rejects.toThrow(
      'ownership check failed',
    );
    expect(snapshot()).toEqual(before);
  });
});
