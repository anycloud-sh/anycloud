/**
 * Database Abstraction Layer
 *
 * Uses SQLite (better-sqlite3) for local storage.
 */

import { log } from '../logger.js';
import { memoizeAsync } from '../../../shared/utils.js';
import { readFileSync } from 'fs';
import BetterSqlite3 from 'better-sqlite3';
import { setImmediate as yieldToIo } from 'node:timers/promises';
import { runMigrations } from './migrations.js';
import { auditContainerSpecOwnership } from './container-spec-ownership.js';

export interface DBTransaction {
  query<T>(sql: string, params?: unknown[]): T[];
}

type Synchronous<T> = T extends PromiseLike<unknown> ? never : T;

export interface DB {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: DBTransaction) => Synchronous<T>): Promise<T>;
  /**
   * Consistent read-only snapshot that does not wait behind queued writes, for
   * user-facing reads only. Statements SQLite cannot prove read-only throw.
   * Never call it from a transaction callback or rely on it to order after a
   * write that has not settled; awaited writes are always visible.
   */
  read<T>(fn: (reader: DBTransaction) => Synchronous<T>): Promise<T>;
  init?(): Promise<void>;
  /**
   * Coherent copy of the live database at `destinationPath` through SQLite's
   * online backup API: writes continue meanwhile and the copy is a consistent
   * snapshot (in-memory databases are not backed up).
   */
  backup?(destinationPath: string): Promise<void>;
}

export interface CloseableDB extends DB {
  close(): void;
}

const DEFAULT_SLOW_QUERY_THRESHOLD_MS = 100;
const SLOW_QUERY_COOLDOWN_MS = 60_000;

let cachedTestTemplate:
  | { path: string; serializedDatabase: Buffer }
  | undefined;

function readTestDatabaseTemplate(): Buffer | undefined {
  if (process.env.IS_TEST !== 'true') return undefined;
  const path = process.env.ANYCLOUD_TEST_DB_TEMPLATE_PATH;
  if (!path) return undefined;
  if (cachedTestTemplate?.path !== path) {
    cachedTestTemplate = {
      path,
      serializedDatabase: readFileSync(path),
    };
  }
  // better-sqlite3 deserializes a Buffer into a private in-memory database.
  // Copy the Buffer too, so every reset is independent even if that contract
  // changes internally.
  return Buffer.from(cachedTestTemplate.serializedDatabase);
}

const slowQueryLogs = new Map<
  string,
  { lastLoggedAt: number; suppressed: number }
>();

function slowQueryThresholdMs(): number {
  const raw = process.env.ANYCLOUD_DB_SLOW_QUERY_MS;
  if (raw === undefined) return DEFAULT_SLOW_QUERY_THRESHOLD_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_SLOW_QUERY_THRESHOLD_MS;
}

function statementKey(sql: string): string {
  return sql
    .replace(/'(?:''|[^'])*'/g, '?')
    .replace(/"(?:""|[^"])*"/g, '?')
    .replace(/\s+/g, ' ')
    .trim();
}

function maybeLogSlowQuery(sql: string, durationMs: number): void {
  const thresholdMs = slowQueryThresholdMs();
  if (durationMs < thresholdMs) return;

  const key = statementKey(sql);
  const now = Date.now();
  const state = slowQueryLogs.get(key);
  if (state && now - state.lastLoggedAt < SLOW_QUERY_COOLDOWN_MS) {
    state.suppressed += 1;
    return;
  }

  log.warn('Slow SQLite query', {
    id: 'system',
    durationMs,
    thresholdMs,
    statement: key,
    suppressedSinceLast: state?.suppressed ?? 0,
  });
  slowQueryLogs.set(key, { lastLoggedAt: now, suppressed: 0 });
}

function requireSynchronous<T>(result: T): T {
  if (result !== null && typeof result === 'object' && 'then' in result) {
    void Promise.resolve(result).catch(() => undefined);
    throw new Error('SQLite transaction callback must be synchronous');
  }
  return result;
}

class SQLiteDatabase implements CloseableDB {
  private db: any;
  private readConnection: BetterSqlite3.Database | undefined;
  private closed = false;
  private readonly initialization = new Map<'database', Promise<void>>();
  private pendingOperation: Promise<void> = Promise.resolve();

  init(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('Database is closed'));
    }
    return memoizeAsync(this.initialization, 'database', async () => {
      // Read path lazily so tests can override via vi.stubEnv before first DB use
      const path = process.env.SQLITE_PATH ?? ':memory:';
      const testTemplate =
        path === ':memory:' ? readTestDatabaseTemplate() : undefined;
      const database = new BetterSqlite3(testTemplate ?? path);

      try {
        if (path !== ':memory:') {
          // Readers never wait behind the writer, and a commit appends to the
          // WAL instead of rewriting pages. better-sqlite3 lowers WAL durability
          // to NORMAL by default; FULL keeps every commit durable on return.
          database.pragma('journal_mode = WAL');
          database.pragma('synchronous = FULL');
        }
        if (!testTemplate) {
          await runMigrations({
            get inTransaction() {
              return database.inTransaction;
            },
            exec: (sql: string) => {
              database.exec(sql);
            },
            query: <T>(sql: string, params?: unknown[]): T[] => {
              const statement = database.prepare(sql);
              if (statement.reader) {
                return statement.all(...(params ?? [])) as T[];
              }
              const result = statement.run(...(params ?? []));
              return [{ rowsAffected: result.changes }] as T[];
            },
          });
        }

        // The runner restores enforcement and audits file-backed databases after
        // the full catalog. Serialized test templates skip the runner, so apply
        // the same combined ownership/foreign-key audit below.
        database.pragma('foreign_keys = ON');
        if (testTemplate) {
          auditContainerSpecOwnership({
            query: <T>(sql: string, params?: unknown[]): T[] =>
              database.prepare(sql).all(...(params ?? [])) as T[],
          });
        }

        // Refresh planner statistics after migrations and on each long-lived
        // connection open. The 0x10000 bit considers every table even though
        // this fresh connection has no query history; SQLite bounds the work.
        database.pragma('optimize = 0x10002');

        if (this.closed) {
          throw new Error('Database was closed during initialization');
        }
        // An in-memory database is private to its connection, so reads there
        // use the writer connection; they still bypass the operation queue.
        if (path !== ':memory:') {
          this.readConnection = new BetterSqlite3(path, {
            readonly: true,
            fileMustExist: true,
          });
        }
        this.db = database;
      } catch (error) {
        this.readConnection?.close();
        this.readConnection = undefined;
        database.close();
        throw error;
      }
    });
  }

  close(): void {
    this.closed = true;
    this.readConnection?.close();
    this.readConnection = undefined;
    if (this.db?.open) {
      // Other read-only connections may outlive this one, so closing alone
      // would leave committed pages in the WAL; fold them into the database
      // file so it is complete on its own.
      if (!this.db.memory) {
        const [result] = this.db.pragma('wal_checkpoint(TRUNCATE)') as {
          busy: number;
        }[];
        if (result?.busy) {
          log.warn('SQLite checkpoint at close was blocked by a reader', {
            id: 'system',
          });
        }
      }
      this.db.close();
    }
    this.db = undefined;
  }

  private execute<T>(sql: string, params?: unknown[], database = this.db): T[] {
    const start = Date.now();
    try {
      const stmt = database.prepare(sql);
      // Decide read-vs-write on the comment-stripped SQL: SELECT/WITH/EXPLAIN
      // read rows, and any write with a RETURNING clause also yields rows
      // (better-sqlite3 requires .all()/.get() for RETURNING, not .run()). Strip `--` line
      // comments first so a comment that mentions RETURNING can't misroute a
      // DDL statement. (Routing only — the original sql is prepared unchanged.)
      // Caveat: a literal RETURNING inside a string value (e.g. VALUES('RETURNING'))
      // would also route to .all() and throw — no such query exists today, and
      // the failure is a loud immediate throw, not a silent miswrite.
      const upper = sql
        .replace(/--[^\n]*/g, ' ')
        .trim()
        .toUpperCase();
      if (
        upper.startsWith('SELECT') ||
        upper.startsWith('WITH') ||
        upper.startsWith('EXPLAIN') ||
        /\bRETURNING\b/.test(upper)
      ) {
        return params ? (stmt.all(...params) as T[]) : (stmt.all() as T[]);
      }
      const result = params ? stmt.run(...params) : stmt.run();
      const row = { rowsAffected: result.changes };
      return [row as unknown as T];
    } finally {
      maybeLogSlowQuery(sql, Date.now() - start);
    }
  }

  private async run<T>(operation: () => T): Promise<T> {
    await this.init();
    // A shared tail gives I/O a turn between operations even when many callers
    // arrive together. A transaction stays synchronous from BEGIN to COMMIT.
    const result = this.pendingOperation.then(async () => {
      await yieldToIo();
      if (this.closed) throw new Error('Database is closed');
      return operation();
    });
    this.pendingOperation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.run(() => {
      const result = this.execute<T>(sql, params);
      // Each async query is an independent queue entry. An open transaction
      // would capture unrelated requests after the next yield.
      if (this.db.inTransaction) {
        this.db.exec('ROLLBACK');
        throw new Error(
          'Asynchronous queries cannot open transactions; use db.transaction()',
        );
      }
      return result;
    });
  }

  /**
   * better-sqlite3 runs each queued operation, including a whole transaction,
   * synchronously, so between queue entries the writer holds no lock and every
   * commit is visible to this snapshot.
   */
  async read<T>(fn: (reader: DBTransaction) => Synchronous<T>): Promise<T> {
    await this.init();
    if (this.closed) throw new Error('Database is closed');
    const database = this.readConnection ?? this.db;
    const reader: DBTransaction = {
      query: <R>(sql: string, params?: unknown[]): R[] => {
        const start = Date.now();
        try {
          const statement = database.prepare(sql);
          if (!statement.readonly) {
            throw new Error('db.read() accepts only read-only statements');
          }
          return statement.all(...(params ?? [])) as R[];
        } finally {
          maybeLogSlowQuery(sql, Date.now() - start);
        }
      },
    };
    return database.transaction(() => requireSynchronous(fn(reader)))() as T;
  }

  async backup(destinationPath: string): Promise<void> {
    await this.init();
    if (this.closed) throw new Error('Database is closed');
    await this.db.backup(destinationPath);
  }

  /**
   * Run synchronous statements in one better-sqlite3 transaction. The callback
   * is intentionally non-async so no other request can interleave work on this
   * connection between BEGIN and COMMIT.
   */
  transaction<T>(fn: (tx: DBTransaction) => Synchronous<T>): Promise<T> {
    return this.run(() => {
      let active = false;
      const tx: DBTransaction = {
        query: <R>(sql: string, params?: unknown[]) => {
          if (!active) {
            throw new Error('SQLite transaction callback is no longer active');
          }
          return this.execute<R>(sql, params);
        },
      };
      const run = this.db.transaction(() => {
        active = true;
        return requireSynchronous(fn(tx));
      });
      try {
        return run() as T;
      } finally {
        active = false;
      }
    });
  }
}

/** Create a fresh DB instance (for tests that need isolation) */
export function createDatabase(): CloseableDB {
  return new SQLiteDatabase();
}

/**
 * Singleton DB instance
 */
let dbInstance: DB | null = null;

export function getDB(): DB {
  if (!dbInstance) {
    dbInstance = new SQLiteDatabase();
  }
  return dbInstance;
}

/** Checkpoint and close the process database; the last step of shutdown. */
export function closeDB(): void {
  (dbInstance as CloseableDB | null)?.close();
}

/** Reset DB singleton (for test isolation) */
export function resetDB(): void {
  dbInstance = null;
}
