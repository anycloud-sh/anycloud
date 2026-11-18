import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { errorMessage } from '../../shared/log-diagnostics.js';
import {
  API_BACKUP_MANIFEST_KEY,
  type ApiBackupInventory,
} from '../../shared/api-backup-manifest.js';
import type { CloudStorage } from './gateways/cloud.js';
import type { DB } from './repositories/db.js';

/** Fixed object keys; bucket versioning keeps the history. */
export const API_DATABASE_BACKUP_KEY = 'anycloud-api/database.sqlite';
export const API_CIPHER_KEY_BACKUP_KEY = 'anycloud-api/cipher.key';
export const API_DATABASE_BACKUP_INTERVAL_MS = 60 * 60_000;

export interface ApiDatabaseBackupDependencies {
  db: Pick<DB, 'backup'>;
  storage: Pick<CloudStorage, 'uploadObject' | 'getBucketVersioning'>;
  bucket: string;
  /** The key that decrypts the database's stored credentials and secrets. */
  cipherKey: string;
  /** The installation id, which a restore reuses. */
  clusterId: string;
  /** `backup.json`'s `cloud` and `account`: where restore's guard looks for the VM. */
  location?: { cloud: string; account: string };
  /** `backup.json`'s `name`, `region` and `vmType`, for the restore command. */
  target?: { name: string; region: string; vmType: string };
  schemaAppVersion(): Promise<string | null>;
  /** Where the installation's resources live, for a delete from any machine. */
  inventory?(): Promise<ApiBackupInventory>;
  log: {
    info(message: string, metadata?: Record<string, unknown>): void;
    warn(message: string, metadata?: Record<string, unknown>): void;
  };
  now?(): number;
  /** Test seam for the hourly timer. */
  setInterval?(fn: () => void, ms: number): { unref?(): unknown };
}

export interface ApiDatabaseBackup {
  /**
   * Online backup to a temp file, uploaded whole under the fixed key; answers
   * the manifest's `backedUpAt`.
   */
  run(reason: string): Promise<string>;
  /**
   * One-time check that the bucket keeps object versions, then the hourly
   * timer. Refuses (returns false, logs the operator step) when versioning
   * is off: without it every hourly upload would overwrite the only copy.
   */
  start(): Promise<boolean>;
  /**
   * Stops the hourly timer without waiting: a backup still running fails when
   * the database closes, or stops before its manifest.
   */
  stop(): void;
}

class ApiDatabaseBackupUnavailableError extends Error {
  constructor(reason: string) {
    super(`Database backup is unavailable: ${reason}`);
    this.name = 'ApiDatabaseBackupUnavailableError';
  }
}

export function createApiDatabaseBackup(
  deps: ApiDatabaseBackupDependencies,
): ApiDatabaseBackup {
  const now = deps.now ?? (() => Date.now());
  const schedule = deps.setInterval ?? setInterval;
  let inFlight: Promise<string> | null = null;
  let stopped = false;
  let timer: ReturnType<typeof schedule> | undefined;

  async function backupOnce(reason: string): Promise<string> {
    if (!deps.db.backup) {
      throw new ApiDatabaseBackupUnavailableError(
        'this database does not support online backup',
      );
    }
    const started = now();
    const backedUpAt = new Date(started).toISOString();
    const dir = await mkdtemp(join(tmpdir(), 'anycloud-db-backup-'));
    const path = join(dir, 'database.sqlite');
    try {
      await deps.db.backup(path);
      const { size } = await stat(path);
      const hash = createHash('sha256');
      await pipeline(createReadStream(path), hash);
      const databaseSha256 = hash.digest('hex');
      // Read before the uploads so nothing touches the database after the copy.
      const schemaAppVersion = await deps.schemaAppVersion();
      // A failed read leaves the inventory out rather than failing the backup:
      // a delete without it sweeps only the management VM's cloud and says so.
      const inventory = await deps.inventory?.().catch((error: unknown) => {
        deps.log.warn('API backup inventory unavailable', {
          id: 'system',
          error: errorMessage(error),
        });
        return undefined;
      });
      // The key never rotates; uploading it every time keeps it present if the
      // object is lost. The invariant is the database first and the manifest
      // last, so a manifest only ever names a database that was uploaded.
      const key = Buffer.from(deps.cipherKey);
      await deps.storage.uploadObject(deps.bucket, API_CIPHER_KEY_BACKUP_KEY, {
        kind: 'buffer',
        bytes: key,
        contentLength: key.length,
      });
      await deps.storage.uploadObject(deps.bucket, API_DATABASE_BACKUP_KEY, {
        kind: 'file',
        path,
        contentLength: size,
      });
      const manifest = Buffer.from(
        JSON.stringify({
          version: 1,
          clusterId: deps.clusterId,
          backedUpAt,
          schemaAppVersion,
          databaseSha256,
          ...inventory,
          ...deps.location,
          ...deps.target,
        }),
      );
      await deps.storage.uploadObject(deps.bucket, API_BACKUP_MANIFEST_KEY, {
        kind: 'buffer',
        bytes: manifest,
        contentLength: manifest.length,
      });
      deps.log.info('API database backed up', {
        id: 'system',
        reason,
        bucket: deps.bucket,
        key: API_DATABASE_BACKUP_KEY,
        bytes: size,
        durationMs: now() - started,
      });
      return backedUpAt;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  return {
    run(reason) {
      // One backup at a time; a caller joins the one in flight.
      inFlight ??= backupOnce(reason).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    async start() {
      if (!deps.storage.getBucketVersioning) {
        deps.log.warn(
          'API database backup not started: cannot verify bucket versioning',
          {
            id: 'system',
            bucket: deps.bucket,
          },
        );
        return false;
      }
      const versioning = await deps.storage.getBucketVersioning(deps.bucket);
      if (versioning !== 'enabled') {
        deps.log.warn(
          'Hourly API database backup not started: the bucket keeps no object versions, so each upload would replace the only copy (the pre-release backup still runs and does exactly that). Enable versioning (AWS: aws s3api put-bucket-versioning --bucket <name> --versioning-configuration Status=Enabled; GCP: gcloud storage buckets update gs://<name> --versioning; Azure: az storage account blob-service-properties update --account-name <account> --enable-versioning true), then restart the API',
          { id: 'system', bucket: deps.bucket },
        );
        return false;
      }
      timer = schedule(() => {
        if (stopped) return;
        void this.run('hourly').catch((error: unknown) => {
          deps.log.warn('API database backup failed', {
            id: 'system',
            error: errorMessage(error),
          });
        });
      }, API_DATABASE_BACKUP_INTERVAL_MS);
      timer.unref?.();
      return true;
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer as Parameters<typeof clearInterval>[0]);
    },
  };
}
