import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import BetterSqlite3 from 'better-sqlite3';
import {
  applyMigration,
  runMigrations,
} from '../../../../src/api/services/repositories/migrations.js';
import type { MigrationDatabase } from '../../../../src/api/services/repositories/migration-database.js';

describe('numbered migration transactions', () => {
  let sqlite: BetterSqlite3.Database;
  let database: MigrationDatabase;

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
    await runMigrations(database, 0);
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS _metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO _metadata VALUES ('schema_app_version', '1.0.0');
      CREATE TABLE ledger_items (value TEXT NOT NULL);
      INSERT INTO ledger_items VALUES ('original');
    `);
  });

  afterEach(() => {
    sqlite.close();
  });

  function apply(sql: string, version = 101, appVersion = '2.0.0'): void {
    applyMigration(
      database,
      { version, filename: `0${version}_runner_fixture.sql`, sql },
      appVersion,
    );
  }

  function guard(): unknown {
    return sqlite
      .prepare("SELECT value FROM _metadata WHERE key = 'schema_app_version'")
      .pluck()
      .get();
  }

  function versions(): unknown[] {
    return sqlite
      .prepare('SELECT version FROM _migrations ORDER BY version')
      .pluck()
      .all();
  }

  function assertUnchanged(): void {
    expect(
      sqlite.prepare('SELECT value FROM ledger_items').pluck().all(),
    ).toEqual(['original']);
    expect(
      sqlite
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'new_table'")
        .get(),
    ).toBeUndefined();
    expect(versions()).toEqual([]);
    expect(guard()).toBe('1.0.0');
    expect(sqlite.inTransaction).toBe(false);
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
  }

  it('0036/S16 executes complete trigger bodies, quoted semicolons, and subsequent statements', () => {
    apply(`
      CREATE TABLE trigger_receipts (value TEXT NOT NULL);
      -- COMMIT; and BEGIN; here are comments, not transaction control.
      CREATE TRIGGER "END; receipt" AFTER INSERT ON ledger_items
      BEGIN
        INSERT INTO trigger_receipts VALUES (
          CASE WHEN NEW.value = 'semi; COMMIT; it''s literal'
            THEN 'matched; END;' ELSE 'other' END
        );
        /* ROLLBACK; must not terminate the enclosing transaction. */
        UPDATE ledger_items SET value = NEW.value || '; suffix'
          WHERE rowid = NEW.rowid;
      END;
      INSERT INTO ledger_items VALUES ('semi; COMMIT; it''s literal');
      CREATE INDEX idx_ledger_items_value ON ledger_items(value);
    `);

    expect(
      sqlite.prepare('SELECT value FROM trigger_receipts').pluck().all(),
    ).toEqual(['matched; END;']);
    expect(
      sqlite
        .prepare('SELECT value FROM ledger_items ORDER BY rowid')
        .pluck()
        .all(),
    ).toEqual(['original', "semi; COMMIT; it's literal; suffix"]);
    expect(versions()).toEqual([101]);
    expect(guard()).toBe('2.0.0');
    expect(sqlite.inTransaction).toBe(false);
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'idx_ledger_items_value'",
        )
        .get(),
    ).toBeDefined();
  });

  it.each(['ABORT', 'ROLLBACK'])(
    '0036/S16 rolls back SQL when migration bookkeeping raises %s',
    (action) => {
      sqlite.exec(`
        CREATE TRIGGER reject_migration BEFORE INSERT ON _migrations
        WHEN NEW.version = 101
        BEGIN
          SELECT RAISE(${action}, 'cannot record migration');
        END;
      `);

      expect(() =>
        apply(`
        CREATE TABLE new_table (id INTEGER);
        UPDATE ledger_items SET value = 'changed';
      `),
      ).toThrow('cannot record migration');
      assertUnchanged();
    },
  );

  it.each(['INSERT', 'UPDATE'])(
    '0036/S16 rolls back the migration record and SQL when the app guard %s fails',
    (operation) => {
      sqlite.exec(`
        CREATE TRIGGER reject_guard BEFORE ${operation} ON _metadata
        WHEN NEW.key = 'schema_app_version' AND NEW.value = '2.0.0'
        BEGIN
          SELECT RAISE(ABORT, 'cannot advance app guard');
        END;
      `);

      expect(() =>
        apply(`
        CREATE TABLE new_table (id INTEGER);
        UPDATE ledger_items SET value = 'changed';
      `),
      ).toThrow('cannot advance app guard');
      assertUnchanged();
    },
  );

  it('0036/S16 keeps the successfully committed prefix when a later migration fails', () => {
    apply("UPDATE ledger_items SET value = 'first committed'");

    expect(() =>
      apply(
        `
      CREATE TABLE new_table (id INTEGER);
      UPDATE ledger_items SET value = 'must roll back';
      INSERT INTO nonexistent_table VALUES (1);
    `,
        102,
        '3.0.0',
      ),
    ).toThrow();

    expect(versions()).toEqual([101]);
    expect(guard()).toBe('2.0.0');
    expect(sqlite.prepare('SELECT value FROM ledger_items').pluck().get()).toBe(
      'first committed',
    );
    expect(
      sqlite
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'new_table'")
        .get(),
    ).toBeUndefined();
    expect(sqlite.inTransaction).toBe(false);

    apply("UPDATE ledger_items SET value = 'retry committed'", 102, '3.0.0');
    expect(versions()).toEqual([101, 102]);
    expect(guard()).toBe('3.0.0');
  });

  it('0036/S16 restores foreign keys when a historical rebuild fails at bookkeeping', async () => {
    await runMigrations(database, 41);
    const before = sqlite
      .prepare(
        "SELECT name, sql FROM sqlite_schema WHERE name IN ('workloads', 'vms') ORDER BY name",
      )
      .all();
    sqlite.exec(`
      CREATE TRIGGER reject_rebuild BEFORE INSERT ON _migrations
      WHEN NEW.version = 42
      BEGIN SELECT RAISE(ABORT, 'rebuild receipt failed'); END;
    `);
    const filename = '0042_enforce_credential_fks.sql';
    expect(() =>
      applyMigration(
        database,
        {
          version: 42,
          filename,
          sql: readFileSync(
            join(process.cwd(), 'migrations', filename),
            'utf8',
          ),
        },
        '2.0.0',
      ),
    ).toThrow('rebuild receipt failed');

    expect(
      sqlite
        .prepare(
          "SELECT name, sql FROM sqlite_schema WHERE name IN ('workloads', 'vms') ORDER BY name",
        )
        .all(),
    ).toEqual(before);
    expect(versions()).not.toContain(42);
    expect(guard()).toBe('1.0.0');
    expect(sqlite.inTransaction).toBe(false);
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it.each([
    'BEGIN',
    'BEGIN IMMEDIATE',
    'COMMIT',
    'END TRANSACTION',
    'END',
    'ROLLBACK',
    'SAVEPOINT nested',
    'RELEASE nested',
    'PRAGMA foreign_keys = OFF',
    'PRAGMA main.foreign_keys = OFF',
    'PRAGMA "foreign_keys" = OFF',
  ])(
    'rejects unknown transaction control before applying any SQL: %s',
    (control) => {
      expect(() =>
        apply(`
      UPDATE ledger_items SET value = 'changed';
      ${control};
      CREATE TABLE new_table (id INTEGER);
    `),
      ).toThrow();
      assertUnchanged();
    },
  );

  it('does not mistake CASE END or quoted identifiers for transaction control', () => {
    apply(`
      CREATE TABLE [COMMIT] ("END" TEXT);
      INSERT INTO [COMMIT] VALUES (CASE WHEN 1 THEN 'BEGIN; END;' ELSE 'no' END);
    `);
    expect(sqlite.prepare('SELECT "END" FROM [COMMIT]').pluck().get()).toBe(
      'BEGIN; END;',
    );
    expect(versions()).toEqual([101]);
  });

  it('refuses an outer transaction without committing or rolling it back', () => {
    sqlite.exec("BEGIN; UPDATE ledger_items SET value = 'outer write';");
    expect(() => apply('CREATE TABLE new_table (id INTEGER)')).toThrow();
    expect(sqlite.inTransaction).toBe(true);
    expect(versions()).toEqual([]);
    sqlite.exec('ROLLBACK');
    assertUnchanged();
  });

  it('0036/S23 rolls back a migration that conflicts with existing schema', () => {
    expect(() =>
      apply(`
      CREATE TABLE new_table (id INTEGER);
      UPDATE ledger_items SET value = 'changed';
      ALTER TABLE ledger_items ADD COLUMN value TEXT;
    `),
    ).toThrow(/duplicate column/i);
    assertUnchanged();
  });

  it('0036/S23 rejects a missing migration 84 record without inferring a repair', async () => {
    await runMigrations(database, undefined, '2.0.0');
    sqlite.exec('DELETE FROM _migrations WHERE version = 84');
    const snapshot = () => ({
      schema: sqlite
        .prepare('SELECT name, sql FROM sqlite_schema ORDER BY name')
        .all(),
      workloads: sqlite.prepare('SELECT * FROM workloads ORDER BY id').all(),
      migrations: sqlite
        .prepare('SELECT version, applied_at FROM _migrations ORDER BY version')
        .all(),
      metadata: sqlite
        .prepare('SELECT key, value FROM _metadata ORDER BY key')
        .all(),
    });
    const before = snapshot();

    // Its table is gone from the current schema. Replaying it must fail
    // without changing anything.
    await expect(runMigrations(database, undefined, '3.0.0')).rejects.toThrow(
      /no such table: deployments/i,
    );

    expect(snapshot()).toEqual(before);
    expect(versions()).not.toContain(84);
    expect(guard()).toBe('2.0.0');
    expect(sqlite.inTransaction).toBe(false);
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('keeps the old guard if version-only startup bookkeeping fails', async () => {
    await runMigrations(database, undefined, '2.0.0');
    const before = versions();
    sqlite.exec(`
      CREATE TRIGGER reject_version_only BEFORE UPDATE ON _metadata
      WHEN NEW.key = 'schema_app_version' AND NEW.value = '3.0.0'
      BEGIN SELECT RAISE(ABORT, 'version-only guard failed'); END;
    `);
    await expect(runMigrations(database, undefined, '3.0.0')).rejects.toThrow(
      'version-only guard failed',
    );
    expect(guard()).toBe('2.0.0');
    expect(versions()).toEqual(before);
    expect(sqlite.inTransaction).toBe(false);
  });
});
