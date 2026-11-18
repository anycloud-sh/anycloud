import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setImmediate as yieldToIo } from 'node:timers/promises';
import BetterSqlite3 from 'better-sqlite3';
import {
  createDatabase,
  type DB,
} from '../../../../src/api/services/repositories/db.js';
import { WorkloadQueryStore } from '../../../../src/api/services/repositories/workload-queries.js';
import { getApiAccessPolicy } from '../../../../src/api/services/repositories/api-access-policy.js';
import { WorkloadState } from '../../../../src/shared/workload.js';
import { createWorkload } from '../../../../src/api/services/repositories/workload-creation.js';

describe('DB', () => {
  let db: DB;
  let tmpDir: string;

  beforeEach(async () => {
    // Use a temp file per test to exercise file-based SQLite (mirrors anycloud api behaviour)
    tmpDir = mkdtempSync(join(tmpdir(), 'anycloud-db-test-'));
    vi.stubEnv('SQLITE_PATH', join(tmpDir, 'test.db'));
    db = createDatabase();
    // Create a test table
    await db.query(`
      CREATE TABLE IF NOT EXISTS test_items (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        value TEXT
      )
    `);
    // Clear any existing data
    await db.query('DELETE FROM test_items');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('initialization', () => {
    it('shares cold initialization across concurrent transactions', async () => {
      vi.stubEnv('SQLITE_PATH', join(tmpDir, 'cold.db'));
      const coldDb = createDatabase();

      const [first, second] = await Promise.all([
        coldDb.transaction((tx) =>
          tx.query<{ value: number }>('SELECT 1 AS value'),
        ),
        coldDb.transaction((tx) =>
          tx.query<{ value: number }>('SELECT 2 AS value'),
        ),
      ]);

      expect(first).toEqual([{ value: 1 }]);
      expect(second).toEqual([{ value: 2 }]);
    });

    it('can retry after initialization fails', async () => {
      vi.stubEnv('SQLITE_PATH', join(tmpDir, 'missing', 'failed.db'));
      const retryingDb = createDatabase();

      await expect(retryingDb.query('SELECT 1')).rejects.toThrow();

      vi.stubEnv('SQLITE_PATH', join(tmpDir, 'retry.db'));
      await expect(
        retryingDb.query<{ value: number }>('SELECT 1 AS value'),
      ).resolves.toEqual([{ value: 1 }]);
    });
  });

  describe('query', () => {
    it.each(['BEGIN', 'BEGIN IMMEDIATE', 'SAVEPOINT manual_query'])(
      'rejects a manual transaction opened with %s without affecting later writes',
      async (sql) => {
        await db.query('INSERT INTO test_items (id, name) VALUES (1, ?)', [
          'already-committed',
        ]);

        await expect(db.query(sql)).rejects.toThrow('use db.transaction()');

        await db.transaction((tx) => {
          tx.query('INSERT INTO test_items (id, name) VALUES (2, ?)', [
            'next-transaction',
          ]);
        });
        expect(
          await db.query<{ id: number }>(
            'SELECT id FROM test_items ORDER BY id',
          ),
        ).toEqual([{ id: 1 }, { id: 2 }]);
      },
    );

    it('lets I/O run during a burst of queries and transactions', async () => {
      let completed = 0;
      const observations: number[] = [];
      const sql = 'INSERT INTO test_items (id, name) VALUES (?, ?)';
      const operations = Array.from({ length: 20 }, (_, id) => {
        const params = [id, `item${id}`];
        const operation =
          id % 2 === 0
            ? db.query(sql, params)
            : db.transaction((tx) => tx.query(sql, params));
        return operation.finally(() => completed++);
      });
      const observe = async () => {
        while (completed < operations.length) {
          await yieldToIo();
          observations.push(completed);
        }
      };

      await Promise.all([...operations, observe()]);

      expect(observations.some((count) => count > 0 && count < 20)).toBe(true);
      const rows = await db.query<{ id: number }>(
        'SELECT id FROM test_items ORDER BY id',
      );
      expect(rows.map((row) => row.id)).toEqual(
        Array.from({ length: 20 }, (_, id) => id),
      );
    });

    it('rejects queued work when the connection closes', async () => {
      const closingDb = createDatabase();
      await closingDb.query('SELECT 1');
      const queued = closingDb.query('SELECT 2');
      closingDb.close();
      await expect(queued).rejects.toThrow('Database is closed');
    });

    it('should insert and select rows', async () => {
      await db.query(
        'INSERT INTO test_items (id, name, value) VALUES (?, ?, ?)',
        [1, 'item1', 'value1'],
      );

      const rows = await db.query<{ id: number; name: string; value: string }>(
        'SELECT * FROM test_items WHERE id = ?',
        [1],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('item1');
      expect(rows[0].value).toBe('value1');
    });

    it('should update rows', async () => {
      await db.query(
        'INSERT INTO test_items (id, name, value) VALUES (?, ?, ?)',
        [1, 'item1', 'old'],
      );
      await db.query('UPDATE test_items SET value = ? WHERE id = ?', [
        'new',
        1,
      ]);

      const rows = await db.query<{ value: string }>(
        'SELECT value FROM test_items WHERE id = ?',
        [1],
      );

      expect(rows[0].value).toBe('new');
    });

    it('should delete rows and return rowsAffected', async () => {
      await db.query(
        'INSERT INTO test_items (id, name, value) VALUES (?, ?, ?)',
        [1, 'item1', 'value1'],
      );
      const result = await db.query('DELETE FROM test_items WHERE id = ?', [1]);
      expect(result).toEqual([{ rowsAffected: 1 }]);

      const rows = await db.query<{ id: number }>(
        'SELECT * FROM test_items WHERE id = ?',
        [1],
      );
      expect(rows).toHaveLength(0);
    });

    it('should return empty array for SELECT with no matches', async () => {
      const rows = await db.query<{ id: number }>(
        'SELECT * FROM test_items WHERE id = ?',
        [999],
      );

      expect(rows).toEqual([]);
    });

    it('returns EXPLAIN QUERY PLAN rows for regression probes', async () => {
      const rows = await db.query<{ detail: string }>(
        'EXPLAIN QUERY PLAN SELECT * FROM test_items WHERE id = ?',
        [1],
      );

      expect(rows.some((row) => row.detail.includes('SEARCH test_items'))).toBe(
        true,
      );
    });

    it('should return rowsAffected: 0 for UPDATE that matches no rows', async () => {
      const result = await db.query(
        'UPDATE test_items SET value = ? WHERE id = ?',
        ['x', 999],
      );
      expect(result).toEqual([{ rowsAffected: 0 }]);
    });

    it('logs slow query shape without params or string literals, rate-limited', async () => {
      vi.stubEnv('ANYCLOUD_DB_SLOW_QUERY_MS', '0');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await db.query(`SELECT 'literal-secret' AS literal, ? AS value`, [
        'param-secret',
      ]);
      await db.query(`SELECT 'literal-secret' AS literal, ? AS value`, [
        'param-secret',
      ]);

      expect(warn).toHaveBeenCalledTimes(1);
      const payload = warn.mock.calls[0][0] as string;
      expect(payload).toContain('Slow SQLite query');
      expect(payload).toContain('SELECT ? AS literal, ? AS value');
      expect(payload).not.toContain('literal-secret');
      expect(payload).not.toContain('param-secret');

      warn.mockRestore();
    });
  });

  describe('transaction', () => {
    it('commits all synchronous statements together', async () => {
      await db.transaction((tx) => {
        tx.query('INSERT INTO test_items (id, name) VALUES (?, ?)', [
          1,
          'first',
        ]);
        tx.query('INSERT INTO test_items (id, name) VALUES (?, ?)', [
          2,
          'second',
        ]);
      });

      const rows = await db.query<{ id: number }>(
        'SELECT id FROM test_items ORDER BY id',
      );
      expect(rows.map((row) => row.id)).toEqual([1, 2]);
    });

    it('rolls back every statement when the callback throws', async () => {
      await expect(
        db.transaction((tx) => {
          tx.query('INSERT INTO test_items (id, name) VALUES (?, ?)', [
            1,
            'rolled-back',
          ]);
          throw new Error('stop transaction');
        }),
      ).rejects.toThrow('stop transaction');

      const rows = await db.query<{ id: number }>('SELECT id FROM test_items');
      expect(rows).toEqual([]);
    });

    it('rejects async callbacks before they can escape the transaction', async () => {
      await expect(
        // @ts-expect-error transaction callbacks must be synchronous
        db.transaction(async (tx) => {
          tx.query('INSERT INTO test_items (id, name) VALUES (?, ?)', [
            1,
            'rolled-back',
          ]);
          await Promise.resolve();
          tx.query('INSERT INTO test_items (id, name) VALUES (?, ?)', [
            2,
            'outside-transaction',
          ]);
        }),
      ).rejects.toThrow('transaction callback must be synchronous');

      await Promise.resolve();
      const rows = await db.query<{ id: number }>('SELECT id FROM test_items');
      expect(rows).toEqual([]);
    });
  });

  describe('write-ahead log', () => {
    const countRows = (path: string) => {
      const copy = new BetterSqlite3(path, { readonly: true });
      try {
        return (
          copy.prepare('SELECT COUNT(*) AS count FROM test_items').get() as {
            count: number;
          }
        ).count;
      } finally {
        copy.close();
      }
    };

    it('keeps a file database in WAL mode with FULL durability', async () => {
      expect(
        await db.query('SELECT journal_mode FROM pragma_journal_mode()'),
      ).toEqual([{ journal_mode: 'wal' }]);
      expect(
        await db.query('SELECT synchronous FROM pragma_synchronous()'),
      ).toEqual([{ synchronous: 2 }]);
    });

    it('folds the WAL into the database file on close', async () => {
      const path = join(tmpDir, 'closing.db');
      vi.stubEnv('SQLITE_PATH', path);
      const closing = createDatabase();
      await closing.query('CREATE TABLE test_items (id INTEGER PRIMARY KEY)');
      await closing.query('INSERT INTO test_items (id) VALUES (1), (2)');
      expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
      closing.close();
      expect(existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0).toBe(
        0,
      );
      // The database file alone holds every committed row.
      mkdirSync(join(tmpDir, 'alone'));
      copyFileSync(path, join(tmpDir, 'alone', 'closing.db'));
      expect(countRows(join(tmpDir, 'alone', 'closing.db'))).toBe(2);
    });

    it('backs up rows still in the WAL into one self-contained file', async () => {
      await db.query(
        'INSERT INTO test_items (id, name) VALUES (1, ?), (2, ?)',
        ['a', 'b'],
      );
      expect(statSync(join(tmpDir, 'test.db-wal')).size).toBeGreaterThan(0);
      const uploads = join(tmpDir, 'upload');
      mkdirSync(uploads);
      await db.backup!(join(uploads, 'database.sqlite'));
      expect(readdirSync(uploads)).toEqual(['database.sqlite']);
      expect(countRows(join(uploads, 'database.sqlite'))).toBe(2);
    });
  });

  describe('read path', () => {
    const count = (reader: DB) =>
      reader.read(
        (r) =>
          r.query<{ count: number }>(
            'SELECT COUNT(*) AS count FROM test_items',
          )[0]?.count,
      );

    it('answers before a long queue of writes and sees every settled write', async () => {
      const settled: string[] = [];
      const writes = Array.from({ length: 200 }, (_, i) =>
        db
          .query('INSERT INTO test_items (name) VALUES (?)', [`w${i}`])
          .then(() => settled.push('write')),
      );
      const read = count(db).then((value) => {
        settled.push('read');
        return value;
      });

      await expect(read).resolves.toBe(0);
      expect(settled).toEqual(['read']);
      await Promise.all(writes);
      await expect(count(db)).resolves.toBe(200);
      // Only a separate connection has made no changes of its own.
      await expect(
        db.read((r) => r.query('SELECT total_changes() AS n')[0]),
      ).resolves.toEqual({ n: 0 });
    });

    it('reads the access policy every request checks before queued writes', async () => {
      const settled: string[] = [];
      const writes = Array.from({ length: 50 }, (_, i) =>
        db
          .query('INSERT INTO test_items (name) VALUES (?)', [`w${i}`])
          .then(() => settled.push('write')),
      );
      await expect(getApiAccessPolicy(db)).resolves.toBeNull();
      expect(settled).toEqual([]);
      await Promise.all(writes);
    });

    it('rejects async callbacks', async () => {
      // @ts-expect-error read callbacks must be synchronous
      await expect(db.read(async () => [])).rejects.toThrow(
        'callback must be synchronous',
      );
    });

    it('rejects writes, and its connection is read-only to SQLite too', async () => {
      await expect(
        db.read((r) => r.query('UPDATE test_items SET value = ?', ['x'])),
      ).rejects.toThrow('db.read() accepts only read-only statements');
      const { readConnection } = db as unknown as {
        readConnection: BetterSqlite3.Database;
      };
      expect(() =>
        readConnection
          .prepare("INSERT INTO test_items (name) VALUES ('x')")
          .run(),
      ).toThrow(/readonly/);
    });

    it('serves workload list and status with the data the writer stored', async () => {
      const queries = new WorkloadQueryStore(db);
      await createWorkload(
        db,
        {
          id: 'read-path',
          userId: 'user-1',
          workloadType: 'job',
          image: 'img',
          dockerCommand: 'docker run img',
          sshPrivateKey: 'key',
        },
        { initialState: WorkloadState.Running },
      );
      const stored = await queries.getWorkload('read-path');
      const queued = vi.spyOn(db, 'query');

      const listed = await queries.listWorkloads({ kind: 'api' });
      const status = await queries.getWorkloadStatusForScope('read-path', {
        kind: 'api',
      });

      expect(listed.map((workload) => workload.id)).toEqual(['read-path']);
      expect(status?.workload).toEqual(stored);
      await expect(
        queries.listVms('read-path', { readPath: true }),
      ).resolves.toEqual([]);
      expect(queued).not.toHaveBeenCalled();
    });
  });

  describe('RETURNING + comment routing', () => {
    it('routes UPDATE ... RETURNING to .all() and returns the updated rows', async () => {
      await db.query(
        'INSERT INTO test_items (id, name, value) VALUES (?, ?, ?)',
        [1, 'item1', 'old'],
      );
      // Without the RETURNING→.all() branch, better-sqlite3's .run() silently
      // discards the returned rows and db.query yields [{ rowsAffected }].
      const rows = await db.query<{ id: number; name: string; value: string }>(
        'UPDATE test_items SET value = ? WHERE id = ? RETURNING *',
        ['new', 1],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 1, name: 'item1', value: 'new' });
    });

    it('does not misroute a write whose comment merely mentions RETURNING', async () => {
      await db.query(
        'INSERT INTO test_items (id, name, value) VALUES (?, ?, ?)',
        [1, 'item1', 'v'],
      );
      // The token RETURNING appears only in a `--` comment, so it must route to
      // .run() (not .all(), which would throw "does not return data"). This is
      // the exact shape of migration 0063's comment.
      const result = await db.query(
        `-- a harmless note mentioning RETURNING in prose\nUPDATE test_items SET value = ? WHERE id = ?`,
        ['v2', 1],
      );
      expect(result).toEqual([{ rowsAffected: 1 }]);
    });
  });

  describe('query for DDL', () => {
    it('should execute DDL statements', async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS another_table (
          id INTEGER PRIMARY KEY,
          data TEXT
        )
      `);

      // Should not throw when inserting into new table
      await db.query('INSERT INTO another_table (id, data) VALUES (?, ?)', [
        1,
        'test',
      ]);
      const rows = await db.query<{ data: string }>(
        'SELECT data FROM another_table WHERE id = ?',
        [1],
      );

      expect(rows[0].data).toBe('test');
    });
  });

  describe('foreign key enforcement', () => {
    const insertWorkload = (id: string, credentialId: string | null) =>
      db.transaction((tx) => {
        tx.query(
          `INSERT INTO workloads (id, user_id, workload_type, state, started_at, docker_command, credential_id)
           VALUES (?, 'u', 'job', 'PENDING', 0, 'cmd', ?)`,
          [id, credentialId],
        );
        tx.query(
          `INSERT INTO container_specs (workload_id, image, registry_username)
           VALUES (?, 'img', 'fixture-ciphertext')`,
          [id],
        );
      });

    const insertCredential = (id: string) =>
      db.query(
        `INSERT INTO credentials (id, encrypted_data, cloud_provider) VALUES (?, '', 'AWS')`,
        [id],
      );

    const insertVM = (workloadId: string, credentialId: string) =>
      db.query(
        `INSERT INTO vms (workload_id, ip, cloud_id, created_at, credential_id)
         VALUES (?, '1.1.1.1', 'cloud-id-1', 0, ?)`,
        [workloadId, credentialId],
      );

    it('rejects vms with credential_id that has no matching credential', async () => {
      await insertCredential('cred-real');
      await insertWorkload('d1', 'cred-real');
      await expect(insertVM('d1', 'does-not-exist')).rejects.toThrow(
        /FOREIGN KEY constraint failed/,
      );
    });

    it('blocks deletion of credentials that are still referenced by a vm (ON DELETE RESTRICT)', async () => {
      await insertCredential('cred-in-use');
      await insertWorkload('d1', 'cred-in-use');
      await insertVM('d1', 'cred-in-use');
      await expect(
        db.query(`DELETE FROM credentials WHERE id = ?`, ['cred-in-use']),
      ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    });

    it('rejects workload_events for non-existent workloads', async () => {
      await expect(
        db.query(
          `INSERT INTO workload_events (workload_id, state) VALUES (?, ?)`,
          ['no-such-workload', 'PENDING'],
        ),
      ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    });
  });
});
