import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../../../../src/api/services/repositories/migrations.js';
import type { MigrationDatabase } from '../../../../src/api/services/repositories/migration-database.js';
import { auditContainerSpecOwnership } from '../../../../src/api/services/repositories/container-spec-ownership.js';
import * as crypto from '../../../../src/api/services/secret-crypto.js';

type Row = Record<string, unknown>;
const executionId = '11111111-1111-4111-8111-111111111111';

describe('0106 persistent Deployment rename', () => {
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
      sql: string | null;
    }>('SELECT type, name, sql FROM sqlite_schema ORDER BY type, name');
    return {
      schema,
      tables: Object.fromEntries(
        schema
          .filter(({ type }) => type === 'table')
          .map(({ name }) => [
            name,
            database.query<Row>(
              `SELECT rowid AS retained_rowid, * FROM "${name}" ORDER BY rowid`,
            ),
          ]),
      ),
    };
  }

  // The Cluster, its Workers and their Jobs are retained history: 0122 refuses
  // a live Cluster before any pending migration runs, then removes the history.
  async function populateWorkers() {
    await runMigrations(database, 105);
    database.exec(`
      INSERT INTO _metadata VALUES ('schema_app_version', '1.0.0');
      INSERT INTO _metadata VALUES ('api_identity', 'v1:retained-api-identity');
      INSERT INTO clusters (id, kind, owner_user_id, name, state, created_at, updated_at)
        VALUES ('cluster-a', 'kubernetes', 'owner-a', 'Cluster', 'deleted', 1, 1);
      INSERT INTO workers (id, owner_user_id, name, cluster_id, gpu_count,
        max_concurrent_jobs_per_replica, generation, deletion_requested_at,
        deleted_at, created_at, updated_at) VALUES
        ('worker-a', 'owner-a', 'Model Workers', 'cluster-a', 0, 3, 4, 30, 40, 1, 20),
        ('worker-draining', 'owner-a', 'Draining', 'cluster-a', 0, 1, 2, 20, 41, 1, 20),
        ('worker-deleted', 'owner-a', 'Retired', 'cluster-a', 0, 1, 1, 10, 20, 1, 20),
        ('shared-id', 'owner-a', 'Separate namespace', 'cluster-a', 0, 1, 1, 30, 42, 1, 1);
      INSERT INTO workloads (id, user_id, owner_user_id, workload_type, state,
        started_at, submitted_at, docker_command) VALUES
        ('shared-id', 'CapturedUser', 'owner-a', 'vm', 'running', 10, 5, 'retained command'),
        ('service-a', 'CapturedUser', 'owner-a', 'service', 'recovering', 10, 5, 'retained command');
      INSERT INTO workloads (id, user_id, owner_user_id, workload_type, worker_id,
        current_execution_id, state, started_at, submitted_at, docker_command,
        submission_revision, first_claimed_at, claim_deadline_at) VALUES
        ('job-running', 'CapturedUser', 'owner-a', 'job', 'worker-a',
          '${executionId}', 'completed', 15, 12, '', 2, 15, 30),
        ('job-queued', 'CapturedUser', 'owner-a', 'job', 'worker-a',
          NULL, 'terminated', 16, 16, '', 3, NULL, 10000);
      INSERT INTO workload_events (id, workload_id, state, metadata, created_at) VALUES
        (41, 'job-running', 'running',
          '{ "executionId": "${executionId}", "generation": 3, "podUid": "retained-pod", "containerId": "retained-container", "submissionRevision": 2, "previousExecutionId": null, "message": "Worker started" }', 15),
        (42, 'service-a', 'recovering', '{ "message": "retained VM history" }', 16);
      INSERT INTO vms (id, workload_id, cluster_id, cloud_id, created_at, checkpoint_host_path)
        VALUES (11, 'service-a', NULL, 'retained-cloud-id', 10,
          '/var/lib/anycloud/deployments/service-a/checkpoint');
    `);
    database.query(
      'UPDATE workloads SET requested_compute_provider = ? WHERE worker_id IS NOT NULL',
      ['Kubernetes'],
    );
    const env = await crypto.encryptSecret('{ "CONFIG": "preserved" }');
    const username = await crypto.encryptSecret('CapturedUser');
    const token = await crypto.encryptSecret('TOKEN_CANARY');
    for (const [column, ids] of [
      [
        'worker_id',
        ['worker-a', 'worker-draining', 'worker-deleted', 'shared-id'],
      ],
      ['workload_id', ['shared-id', 'service-a']],
    ] as const) {
      for (const id of ids) {
        database.query(
          `INSERT INTO container_specs (${column}, image, image_digest, command,
            docker_options, env, registry_username, registry_token)
           VALUES (?, 'accepted:image', 'sha256:retained', '[ "run" ]', '{ "cpus": "2" }', ?, ?, ?)`,
          [id, env, username, token],
        );
      }
    }
  }

  it('installs separate Workload and Deployment schemas on a fresh database', async () => {
    await runMigrations(database, undefined, '2.0.0');
    const current = snapshot();
    expect(current.tables.deployments).toEqual([]);
    expect(current.tables.workloads).toEqual([]);
    expect(current.tables.workers).toBeUndefined();
    expect(
      current.schema.filter(({ name, sql }) => /worker/i.test(name + sql)),
    ).toEqual([]);
    expect(
      database.query('SELECT version FROM _migrations WHERE version = 106'),
    ).toEqual([{ version: 106 }]);
    expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
    await runMigrations(database, undefined, '2.0.0');
    expect(snapshot()).toEqual(current);
  });

  it('preserves records, row identities, ciphertext, Jobs and history through the rename, then drops the Cluster history at 0122', async () => {
    await populateWorkers();
    const before = snapshot();
    const encrypt = vi.spyOn(crypto, 'encryptSecret');
    const decrypt = vi.spyOn(crypto, 'decryptSecret');
    // 0121 is the last schema that still holds the Cluster-era rows.
    await runMigrations(database, 121);
    const renamed = snapshot();
    for (const [table, rows] of Object.entries(before.tables)) {
      if (table === '_migrations' || table === '_metadata') continue;
      expect(
        renamed.tables[table === 'workers' ? 'deployments' : table],
        table,
      ).toEqual(
        rows.map((row) => ({
          ...Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key === 'worker_id' ? 'deployment_id' : key,
              value,
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
          ...(table === 'workloads' ? { node_pool_id: null } : {}),
        })),
      );
    }
    expect(
      renamed.tables._migrations.filter((row) => Number(row.version) <= 105),
    ).toEqual(before.tables._migrations);
    expect(encrypt).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();

    // 0122 removes every Cluster Deployment, its Jobs, events and specs, and
    // keeps the VM-host Workloads untouched.
    await runMigrations(database, undefined, '2.0.0');
    const after = snapshot();
    // 0126's cluster record reuses the table name; nothing lands in it here.
    expect(after.tables.clusters).toEqual([]);
    expect(after.tables.deployments).toEqual([]);
    // 0128 adds public endpoint columns; 0129 adds the cleanup reason.
    expect(after.tables.workloads).toEqual(
      renamed.tables.workloads
        .filter((row) => row.deployment_id === null)
        .map((row) => ({
          ...row,
          public_endpoint_ip: null,
          public_endpoint_state: null,
          public_endpoint_error: null,
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
        })),
    );
    expect(after.tables.workload_events).toEqual(
      renamed.tables.workload_events.filter(
        (row) => row.workload_id === 'service-a',
      ),
    );
    expect(after.tables.container_specs).toEqual(
      renamed.tables.container_specs
        .filter((row) => row.deployment_id === null)
        // 0148 adds a managed Deployment's image Entrypoint.
        .map((row) => ({ ...row, entrypoint: null })),
    );
    expect(after.tables.vms).toEqual(
      renamed.tables.vms.map(
        ({ cluster_id: _dropped, root_installation_id, ...row }) => ({
          ...row,
          cluster_id: root_installation_id,
          // 0137 adds the launch failure columns.
          launch_diagnosis: null,
          launch_region_denied: null,
          // 0153 adds the remediation breaker's stamp.
          remediated_at: null,
        }),
      ),
    );
    expect(after.tables._metadata).toEqual(
      before.tables._metadata.map((row) =>
        row.key === 'schema_app_version' ? { ...row, value: '2.0.0' } : row,
      ),
    );
    for (const table of ['workloads', 'container_specs']) {
      expect(sqlite.pragma(`foreign_key_list(${table})`)).toContainEqual(
        expect.objectContaining({
          table: 'deployments',
          from: 'deployment_id',
          to: 'id',
        }),
      );
    }
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(() => database.query('SELECT worker_id FROM workloads')).toThrow(
      'no such column',
    );
    expect(() => database.query('SELECT * FROM workers')).toThrow(
      'no such table',
    );
    await runMigrations(database, undefined, '2.0.0');
    expect(snapshot()).toEqual(after);
  });

  it.each(['script', 'receipt', 'version', 'ownership', 'foreign key'])(
    'rolls back the schema, data, receipt and version after a %s failure and permits retry',
    async (failure) => {
      await populateWorkers();
      if (failure === 'receipt')
        database.exec(`CREATE TRIGGER reject_rename BEFORE INSERT ON _migrations
        WHEN NEW.version = 106 BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END`);
      if (failure === 'version')
        database.exec(`CREATE TRIGGER reject_rename BEFORE UPDATE ON _metadata
        WHEN NEW.value = '2.0.0' BEGIN SELECT RAISE(ABORT, 'injected version failure'); END`);
      if (failure === 'ownership')
        database.exec(`INSERT INTO workers
        (id, owner_user_id, name, cluster_id, gpu_count, created_at, updated_at)
        VALUES ('missing-spec', 'owner-a', 'Missing', 'cluster-a', 0, 1, 1)`);
      if (failure === 'foreign key') {
        sqlite.pragma('foreign_keys = OFF');
        database.exec(
          "INSERT INTO workload_events (workload_id, state) VALUES ('missing-owner', 'running')",
        );
        sqlite.pragma('foreign_keys = ON');
      }
      const before = snapshot();
      const exec = database.exec;
      database.exec = (sql) => {
        exec(sql);
        if (
          failure === 'script' &&
          sql.includes('ALTER TABLE workers RENAME')
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
        database.exec('DROP TRIGGER reject_rename');
      if (failure === 'ownership')
        database.exec("DELETE FROM workers WHERE id = 'missing-spec'");
      if (failure === 'foreign key')
        database.exec(
          "DELETE FROM workload_events WHERE workload_id = 'missing-owner'",
        );
      await runMigrations(database, undefined, '2.0.0');
      expect(
        database.query('SELECT version FROM _migrations WHERE version = 106'),
      ).toEqual([{ version: 106 }]);
      auditContainerSpecOwnership(database);
    },
  );

  it('retains ownership and identity guards after rename and checks them again on startup', async () => {
    await populateWorkers();
    await runMigrations(database, undefined, '2.0.0');
    // Current-schema Deployments target node pools; seed one owner chain.
    sqlite.exec(`
      INSERT INTO credentials (id, encrypted_data, cloud_provider)
        VALUES ('compute-a', 'x', 'AWS');
      INSERT INTO clusters (id, owner_user_id, name, state, step, kubernetes_identity,
        encrypted_connection, created_at, updated_at)
        VALUES ('root-a', 'owner-a', 'root-a', 'ready', 'release', 'uid-a', 'enc', 1, 1);
      INSERT INTO node_pools (id, cluster_id, owner_user_id, name, state, compute_credential_id,
        region, vm_type, min_vm_count, max_vm_count, created_at, updated_at)
        VALUES ('node-pool-a', 'root-a', 'owner-a', 'aws-east', 'ready', 'compute-a',
          'us-east-1', 't3.small', 1, 1, 1, 1);
      INSERT INTO deployments (id, owner_user_id, name, node_pool_id, gpu_count,
        max_concurrent_jobs_per_replica, generation, deletion_requested_at,
        deleted_at, created_at, updated_at) VALUES
        ('deployment-a', 'owner-a', 'Model Deployments', 'node-pool-a', 0, 3, 4, NULL, NULL, 1, 20),
        ('deployment-draining', 'owner-a', 'Draining', 'node-pool-a', 0, 1, 2, 20, NULL, 1, 20),
        ('deployment-deleted', 'owner-a', 'Retired', 'node-pool-a', 0, 1, 1, 10, 20, 1, 20);
      INSERT INTO workloads (id, user_id, owner_user_id, workload_type, deployment_id,
        current_execution_id, state, started_at, submitted_at, docker_command)
        VALUES ('job-running', 'CapturedUser', 'owner-a', 'job', 'deployment-a',
          '${executionId}', 'running', 15, 12, '');
    `);
    for (const id of [
      'deployment-a',
      'deployment-draining',
      'deployment-deleted',
    ]) {
      database.query(
        `INSERT INTO container_specs (deployment_id, image, registry_username)
         VALUES (?, 'accepted:image', ?)`,
        [id, await crypto.encryptSecret('CapturedUser')],
      );
    }
    sqlite.pragma('recursive_triggers = OFF');
    const before = snapshot();
    for (const sql of [
      "UPDATE deployments SET id = 'renamed' WHERE id = 'deployment-a'",
      "UPDATE deployments SET owner_user_id = 'other' WHERE id = 'deployment-a'",
      "UPDATE deployments SET node_pool_id = 'other' WHERE id = 'deployment-a'",
      "UPDATE deployments SET deletion_requested_at = NULL WHERE id = 'deployment-draining'",
      "UPDATE deployments SET deleted_at = NULL WHERE id = 'deployment-deleted'",
      "INSERT OR REPLACE INTO deployments (id, owner_user_id, name, node_pool_id, gpu_count, created_at, updated_at) VALUES ('replacement', 'owner-a', 'MODEL DEPLOYMENTS', 'node-pool-a', 0, 1, 1)",
      "UPDATE workloads SET deployment_id = NULL WHERE id = 'job-running'",
      "DELETE FROM deployments WHERE id = 'deployment-a'",
      "DELETE FROM workloads WHERE id = 'service-a'",
      "DELETE FROM container_specs WHERE deployment_id = 'deployment-a'",
      "UPDATE container_specs SET deployment_id = 'deployment-deleted' WHERE deployment_id = 'deployment-a'",
      "INSERT INTO container_specs (workload_id, image, registry_username) VALUES ('job-running', 'image', 'ciphertext')",
      "DELETE FROM node_pools WHERE id = 'node-pool-a'",
    ]) {
      expect(() => database.exec(sql), sql).toThrow();
      expect(snapshot(), sql).toEqual(before);
    }
    database.exec(
      "UPDATE container_specs SET image = 'new:image' WHERE deployment_id = 'deployment-a'",
    );
    expect(
      database.query(
        "SELECT image FROM container_specs WHERE workload_id = 'shared-id'",
      ),
    ).toEqual([{ image: 'accepted:image' }]);
    // Event history restricts parent deletion; remove the fixture event before
    // exercising the VM and container-spec cascades.
    database.exec(
      "DELETE FROM workload_events WHERE workload_id = 'service-a'",
    );
    database.exec("DELETE FROM workloads WHERE id = 'service-a'");
    expect(database.query('SELECT * FROM vms')).toEqual([]);
    database.exec("DELETE FROM deployments WHERE id = 'deployment-deleted'");
    expect(
      database.query(
        "SELECT * FROM container_specs WHERE deployment_id = 'deployment-deleted'",
      ),
    ).toEqual([]);
    auditContainerSpecOwnership(database);
    database.exec(
      "DROP TRIGGER container_specs_no_detach; DELETE FROM container_specs WHERE deployment_id = 'deployment-a'",
    );
    const damaged = snapshot();
    await expect(runMigrations(database, undefined, '3.0.0')).rejects.toThrow(
      'ownership check failed',
    );
    expect(snapshot()).toEqual(damaged);
  });
});
