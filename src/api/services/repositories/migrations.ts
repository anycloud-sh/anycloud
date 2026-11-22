/** Database startup migrations, executed through a private synchronous adapter. */
import { readFileSync, readdirSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as semver from 'semver';
import packageJson from '../../../../package.json' with { type: 'json' };
import { prepareMigrationSql } from './migration-sql.js';
import type { MigrationDatabase } from './migration-database.js';
import { auditContainerSpecOwnership } from './container-spec-ownership.js';
import { auditWorkloadRenameContainerSpecOwnership } from './workload-rename-ownership.js';
import {
  REMOVAL_MIGRATIONS,
  refuseRemovedWorkloads,
} from './removed-workloads-guard.js';

export interface MigrationSource {
  version: number;
  filename: string;
  sql: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_VERSION_KEY = 'schema_app_version';
const WORKLOAD_RENAME_MIGRATION = '0105_rename_deployments_to_workloads.sql';
const WORKLOAD_RENAME_VERSION = 105;
const DEPLOYMENT_RENAME_MIGRATION = '0106_rename_workers_to_deployments.sql';
const DEPLOYMENT_RENAME_VERSION = 106;
/**
 * Rebuilds of a table that other tables reference. New SQL carries no
 * connection controls, so the runner turns foreign keys off for exactly these
 * files and refuses to commit unless `foreign_key_check` is empty afterwards.
 */
const FOREIGN_KEY_REBUILD_MIGRATIONS: ReadonlySet<string> = new Set([
  '0102_container_specs.sql',
  '0121_deployment_node_pool_targets.sql',
  '0122_drop_clusters.sql',
  '0126_clusters.sql',
  '0127_cluster_steps.sql',
  '0139_node_pool_region_optional.sql',
  '0165_cluster_record.sql',
  '0172_remove_deployments.sql',
  '0173_remove_node_pools.sql',
]);
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', '..', 'migrations');

function auditForeignKeyIntegrity(
  db: MigrationDatabase,
  filename: string,
): void {
  if (db.query('PRAGMA foreign_key_check').length > 0) {
    throw new Error(
      `Migration ${filename} left dangling foreign keys; refusing to commit`,
    );
  }
}

function assertOutsideTransaction(db: MigrationDatabase): void {
  if (db.inTransaction) {
    throw new Error('Migrations require a connection outside any transaction');
  }
}

function transaction(db: MigrationDatabase, operation: () => void): void {
  assertOutsideTransaction(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    operation();
    if (!db.inTransaction) {
      throw new Error('Migration transaction ended before its commit');
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      // RAISE(ROLLBACK) and ON CONFLICT ROLLBACK can already have ended it.
      if (db.inTransaction) db.exec('ROLLBACK');
    } catch (rollbackError) {
      console.error('Failed to roll back migration transaction', rollbackError);
    }
    throw error;
  }
}

function enableForeignKeys(db: MigrationDatabase): void {
  db.exec('PRAGMA foreign_keys = ON');
  const enabled = db.query<{ foreign_keys: number }>('PRAGMA foreign_keys')[0];
  if (enabled?.foreign_keys !== 1) {
    throw new Error(
      'Could not restore foreign-key enforcement after migration',
    );
  }
}

function ensureMetadataTable(db: MigrationDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
}

function assertNotDowngradingApi(
  db: MigrationDatabase,
  appVersion: string,
): void {
  const storedVersion = db.query<{ value: string }>(
    'SELECT value FROM _metadata WHERE key = ?',
    [APP_VERSION_KEY],
  )[0]?.value;
  if (
    storedVersion &&
    semver.valid(storedVersion) &&
    semver.valid(appVersion) &&
    semver.gt(storedVersion, appVersion)
  ) {
    throw new Error(
      `Database was last used by anycloud API ${storedVersion}; ` +
        `refusing to start older API ${appVersion}. ` +
        'Run `anycloud update` to use the current API.',
    );
  }
}

function recordAppVersion(db: MigrationDatabase, appVersion: string): void {
  db.query(
    `INSERT INTO _metadata (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [APP_VERSION_KEY, appVersion],
  );
}

/** Apply one catalog entry with its receipt and optional application guard. */
export function applyMigration(
  db: MigrationDatabase,
  source: MigrationSource,
  appVersion?: string,
): void {
  assertOutsideTransaction(db);
  try {
    if (
      !Number.isSafeInteger(source.version) ||
      source.version <= 0 ||
      !/^\d{4}_[a-z0-9_]+\.sql$/.test(source.filename) ||
      Number(source.filename.slice(0, 4)) !== source.version
    ) {
      throw new Error('Invalid migration catalog entry');
    }
    const prepared = prepareMigrationSql(source.filename, source.sql);
    const isForeignKeyRebuild = FOREIGN_KEY_REBUILD_MIGRATIONS.has(
      source.filename,
    );
    if (prepared.disableForeignKeys || isForeignKeyRebuild)
      db.exec('PRAGMA foreign_keys = OFF');
    else enableForeignKeys(db);

    transaction(db, () => {
      if (appVersion !== undefined) {
        ensureMetadataTable(db);
        assertNotDowngradingApi(db, appVersion);
      }
      // Native SQLite handles trigger programs and every embedded semicolon.
      db.exec(prepared.sql);
      if (source.filename === WORKLOAD_RENAME_MIGRATION) {
        auditWorkloadRenameContainerSpecOwnership(db);
      } else if (source.filename === DEPLOYMENT_RENAME_MIGRATION) {
        auditContainerSpecOwnership(db);
      }
      if (isForeignKeyRebuild) auditForeignKeyIntegrity(db, source.filename);
      if (!db.inTransaction) {
        throw new Error('Migration SQL ended its runner-owned transaction');
      }
      db.query('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)', [
        source.version,
        Date.now(),
      ]);
      if (appVersion !== undefined) recordAppVersion(db, appVersion);
    });
  } catch (error) {
    try {
      enableForeignKeys(db);
    } catch (restoreError) {
      console.error(
        'Failed to restore migration connection state',
        restoreError,
      );
    }
    throw error;
  }
  enableForeignKeys(db);
}

/**
 * `upTo` stages a historical schema for upgrade fixtures. It does not apply or
 * check the application-version guard. Production always runs the full catalog.
 */
export async function runMigrations(
  db: MigrationDatabase,
  upTo?: number,
  appVersion = packageJson.version,
): Promise<void> {
  assertOutsideTransaction(db);
  enableForeignKeys(db);
  const isFullRun = upTo === undefined;
  transaction(db, () => {
    ensureMetadataTable(db);
    if (isFullRun) assertNotDowngradingApi(db, appVersion);
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`);
  });

  const appliedSet = new Set(
    db
      .query<{ version: number }>('SELECT version FROM _migrations')
      .map((row) => row.version),
  );
  let migrationFiles: string[];
  try {
    migrationFiles = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      .sort();
  } catch {
    return;
  }

  const pending = migrationFiles.filter((filename) => {
    const version = parseInt(basename(filename).split('_')[0], 10);
    return (
      !isNaN(version) &&
      !appliedSet.has(version) &&
      (upTo === undefined || version <= upTo)
    );
  });
  if (pending.some((filename) => REMOVAL_MIGRATIONS.has(filename))) {
    refuseRemovedWorkloads(db);
  }
  let appliedCount = 0;
  for (const filename of pending) {
    const version = parseInt(basename(filename).split('_')[0], 10);
    console.log(`  [apply] ${filename}`);
    applyMigration(
      db,
      {
        version,
        filename,
        sql: readFileSync(join(MIGRATIONS_DIR, filename), 'utf8'),
      },
      isFullRun ? appVersion : undefined,
    );
    appliedSet.add(version);
    appliedCount++;
  }

  if (appliedSet.has(DEPLOYMENT_RENAME_VERSION)) {
    auditContainerSpecOwnership(db);
  } else if (appliedSet.has(WORKLOAD_RENAME_VERSION)) {
    auditWorkloadRenameContainerSpecOwnership(db);
  }
  if (isFullRun) {
    // Version-only startup is an atomic bookkeeping operation too.
    transaction(db, () => {
      assertNotDowngradingApi(db, appVersion);
      recordAppVersion(db, appVersion);
    });
  }
  console.log(
    appliedCount > 0
      ? `  [migrations] Applied ${appliedCount} migration(s)`
      : `  [migrations] Up to date (${appliedSet.size} applied)`,
  );
}
