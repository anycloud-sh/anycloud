import { afterEach, describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../../../../src/api/services/repositories/migrations.js';
import type { MigrationDatabase } from '../../../../src/api/services/repositories/migration-database.js';

let sqlite: BetterSqlite3.Database;
afterEach(() => sqlite?.close());

function database(): MigrationDatabase {
  sqlite = new BetterSqlite3(':memory:');
  return {
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
}

describe('Deployment submission migration', () => {
  it('adds submission defaults and covering queue indexes without acquisition storage', async () => {
    const db = database();
    await runMigrations(db, 102);
    await runMigrations(db);
    sqlite.exec(`
      INSERT INTO credentials(id,encrypted_data,cloud_provider) VALUES ('compute','x','AWS');
      INSERT INTO clusters(id,owner_user_id,name,state,step,kubernetes_identity,encrypted_connection,created_at,updated_at)
        VALUES ('root','owner','root','ready','release','uid','enc',1,1);
      INSERT INTO node_pools(id,cluster_id,owner_user_id,name,state,compute_credential_id,region,vm_type,min_vm_count,max_vm_count,created_at,updated_at)
        VALUES ('pool','root','owner','pool','ready','compute','us-east-1','t3.small',1,1,1,1);
      INSERT INTO deployments(id,owner_user_id,name,node_pool_id,gpu_count,max_concurrent_jobs_per_replica,generation,created_at,updated_at)
        VALUES ('deployment','owner','deployment','pool',0,1,1,1,1);
      INSERT INTO container_specs(deployment_id,image,registry_username) VALUES ('deployment','image','registry-owner');
      INSERT INTO workloads(id,user_id,deployment_id,workload_type,state,started_at,submitted_at,docker_command,current_execution_id)
        VALUES ('queued','owner','deployment','job','queued',10,10,'',NULL);
    `);
    expect(
      sqlite
        .prepare(
          'SELECT id, submission_revision, claim_deadline_at, first_claimed_at FROM workloads ORDER BY id',
        )
        .all(),
    ).toEqual([
      {
        id: 'queued',
        submission_revision: 0,
        claim_deadline_at: null,
        first_claimed_at: null,
      },
    ]);
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name LIKE '%acquisition%'",
        )
        .all(),
    ).toEqual([]);
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'idx_workloads_claim_deadline'",
        )
        .get(),
    ).toBeDefined();
    expect(
      sqlite
        .prepare<[], { name: string }>(
          'PRAGMA index_info(idx_workloads_deployment)',
        )
        .all()
        .map((column) => column.name),
    ).toEqual([
      'deployment_id',
      'state',
      'submitted_at',
      'id',
      'first_claimed_at',
      'claim_deadline_at',
      'submission_revision',
      'current_execution_id',
    ]);
    await runMigrations(db);
    expect(
      sqlite
        .prepare('SELECT version FROM _migrations WHERE version = 103')
        .all(),
    ).toHaveLength(1);
  });
});
