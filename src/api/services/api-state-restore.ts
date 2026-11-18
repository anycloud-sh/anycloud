import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  readApiBackupManifest,
  type BackupStorage,
} from './api-backup-manifest.js';
import {
  API_CIPHER_KEY_BACKUP_KEY,
  API_DATABASE_BACKUP_KEY,
} from './api-database-backup.js';

/**
 * Fill an empty hosted API state directory from the bucket's backup: the
 * cipher key, then the database, checked against the manifest. A directory
 * that already has a database is left alone, so later Pod restarts never
 * overwrite live state.
 */
export interface RestoreStateDependencies {
  dir: string;
  bucket: string;
  storage: BackupStorage;
}

export async function restoreApiState(
  deps: RestoreStateDependencies,
): Promise<'restored' | 'present'> {
  const databasePath = join(deps.dir, 'api.db');
  if (existsSync(databasePath)) return 'present';
  const manifest = await readApiBackupManifest(deps.storage, deps.bucket);
  if (!manifest || manifest === 'unrestorable') {
    throw new Error(`Bucket ${deps.bucket} holds no hosted API backup`);
  }
  const staging = join(deps.dir, '.restore');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const download = async (key: string, path: string) => {
    const { stream } = await deps.storage.downloadObject(deps.bucket, key);
    await pipeline(stream, createWriteStream(path, { mode: 0o600 }));
  };
  try {
    await download(API_CIPHER_KEY_BACKUP_KEY, join(staging, 'cipher.key'));
    const database = join(staging, 'api.db');
    await download(API_DATABASE_BACKUP_KEY, database);
    const hash = createHash('sha256');
    await pipeline(createReadStream(database), hash);
    if (hash.digest('hex') !== manifest.databaseSha256) {
      throw new Error(
        `The backup in ${deps.bucket} was interrupted: restore the ${API_DATABASE_BACKUP_KEY} version with SHA-256 ${manifest.databaseSha256}, then create again`,
      );
    }
    // The key first; the database last, since a database is what the API
    // treats as existing state.
    await rename(join(staging, 'cipher.key'), join(deps.dir, 'cipher.key'));
    await chmod(join(deps.dir, 'cipher.key'), 0o600);
    // Never let SQLite replay a stale write-ahead log against the restored file.
    await rm(`${databasePath}-wal`, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    await rename(database, databasePath);
    return 'restored';
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
