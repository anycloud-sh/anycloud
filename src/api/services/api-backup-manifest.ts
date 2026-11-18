import type { CloudObjectLister, CloudStorage } from './gateways/cloud.js';
import { API_DATABASE_BACKUP_KEY } from './api-database-backup.js';
import {
  API_BACKUP_MANIFEST_KEY,
  parseApiBackupManifest,
  type ApiBackupManifest,
} from '../../shared/api-backup-manifest.js';

/** The storage a restore reads through; every cluster provider lists objects. */
export type BackupStorage = Pick<CloudStorage, 'type' | 'downloadObject'> &
  Partial<CloudObjectLister>;

/**
 * The bucket's manifest; null when it holds no hosted API backup, and
 * `unrestorable` when it holds a database without a manifest to restore it.
 */
export async function readApiBackupManifest(
  storage: BackupStorage,
  bucket: string,
): Promise<ApiBackupManifest | 'unrestorable' | null> {
  if (!storage.listObjects) {
    throw new Error(`${storage.type} storage cannot list objects`);
  }
  const page = await storage.listObjects(bucket, {
    prefix: 'anycloud-api/',
    recursive: false,
    pageSize: 100,
  });
  const keys = new Set(
    page.entries.flatMap((entry) =>
      entry.kind === 'object' ? [entry.key] : [],
    ),
  );
  if (!keys.has(API_BACKUP_MANIFEST_KEY)) {
    return keys.has(API_DATABASE_BACKUP_KEY) ? 'unrestorable' : null;
  }
  const { stream } = await storage.downloadObject(
    bucket,
    API_BACKUP_MANIFEST_KEY,
  );
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return parseApiBackupManifest(Buffer.concat(chunks).toString('utf8'));
}
