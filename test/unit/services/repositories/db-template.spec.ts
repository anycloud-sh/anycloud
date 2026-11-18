import BetterSqlite3 from 'better-sqlite3';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  resetDB,
  type CloseableDB,
} from '../../../../src/api/services/repositories/db.js';
import { encodeContainerSpec } from '../../../../src/api/services/container-spec.js';

describe('unit-test database template', () => {
  const standaloneDatabases: CloseableDB[] = [];
  const temporaryDirectories: string[] = [];

  beforeEach(() => {
    vi.stubEnv('SQLITE_PATH', ':memory:');
    resetDB();
  });

  afterEach(() => {
    for (const db of standaloneDatabases.splice(0)) db.close();
    for (const directory of temporaryDirectories.splice(0))
      rmSync(directory, { recursive: true, force: true });
    resetDB();
    vi.unstubAllEnvs();
  });

  function freshDatabase(): CloseableDB {
    const db = createDatabase();
    standaloneDatabases.push(db);
    return db;
  }

  function useCorruptedTemplate(
    corrupt: (database: BetterSqlite3.Database) => void,
  ): void {
    const source = process.env.ANYCLOUD_TEST_DB_TEMPLATE_PATH;
    if (!source) throw new Error('Test database template is unavailable');
    const directory = mkdtempSync(
      join(tmpdir(), 'anycloud-corrupt-db-template-'),
    );
    temporaryDirectories.push(directory);
    const path = join(directory, 'template.db');
    copyFileSync(source, path);
    const database = new BetterSqlite3(path);
    try {
      corrupt(database);
    } finally {
      database.close();
    }
    vi.stubEnv('ANYCLOUD_TEST_DB_TEMPLATE_PATH', path);
  }

  it('contains every current migration', async () => {
    expect(process.env.ANYCLOUD_TEST_DB_TEMPLATE_PATH).toBeTruthy();
    const migrationFiles = readdirSync(
      join(process.cwd(), 'migrations'),
    ).filter((file) => file.endsWith('.sql'));
    const applied = await freshDatabase().query<{ version: number }>(
      'SELECT version FROM _migrations ORDER BY version',
    );

    expect(applied).toHaveLength(migrationFiles.length);
  });

  it('creates isolated clones with foreign keys enabled', async () => {
    const first = freshDatabase();
    const second = freshDatabase();

    await first.query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider)
       VALUES ('only-in-first', '', 'AWS')`,
    );
    await second.query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider)
       VALUES ('second-credential', '', 'AWS')`,
    );
    const spec = await encodeContainerSpec({
      image: 'img',
      imageDigest: null,
      command: null,
      dockerOptions: null,
      env: null,
      registryUsername: 'u',
      registryToken: null,
    });
    await second.transaction((tx) => {
      tx.query(`INSERT INTO workloads (
        id, user_id, workload_type, state, started_at, docker_command, credential_id
      ) VALUES ('second-workload', 'u', 'job', 'PENDING', 0, 'cmd', 'second-credential')`);
      tx.query(
        `INSERT INTO container_specs (workload_id, image, registry_username)
        VALUES ('second-workload', ?, ?)`,
        [spec.image, spec.registry_username],
      );
    });
    await expect(
      second.query(
        `INSERT INTO vms (
          workload_id, ip, cloud_id, created_at, credential_id
        ) VALUES (
          'second-workload', '1.1.1.1', 'second-vm', 0, 'does-not-exist'
        )`,
      ),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);

    const secondCredentials = await second.query<{ id: string }>(
      `SELECT id FROM credentials WHERE id = 'only-in-first'`,
    );
    expect(secondCredentials).toEqual([]);
  });

  it('rejects template clones with missing container specs', async () => {
    useCorruptedTemplate((database) => {
      database.exec(`INSERT INTO workloads (
        id, user_id, workload_type, state, started_at, docker_command
      ) VALUES ('missing-spec', 'u', 'job', 'PENDING', 0, 'cmd')`);
    });

    await expect(freshDatabase().query('SELECT 1')).rejects.toThrow(
      'ownership check failed',
    );
  });

  it('rejects template clones with broken foreign keys', async () => {
    useCorruptedTemplate((database) => {
      database.pragma('foreign_keys = OFF');
      database.exec(`INSERT INTO workload_events (
        workload_id, state, created_at
      ) VALUES ('missing-owner', 'running', 10)`);
    });

    await expect(freshDatabase().query('SELECT 1')).rejects.toThrow(
      'foreign-key check failed',
    );
  });

  it('supports explicitly closing template-backed databases', async () => {
    const db = freshDatabase();
    await db.query('SELECT 1');

    db.close();

    await expect(db.query('SELECT 1')).rejects.toThrow('Database is closed');
  });
});
