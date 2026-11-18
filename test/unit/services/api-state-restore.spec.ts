import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readApiBackupManifest } from '../../../src/api/services/api-backup-manifest.js';
import {
  API_BACKUP_MANIFEST_KEY,
  parseApiBackupManifest,
} from '../../../src/shared/api-backup-manifest.js';
import {
  API_CIPHER_KEY_BACKUP_KEY,
  API_DATABASE_BACKUP_KEY,
} from '../../../src/api/services/api-database-backup.js';
import { restoreApiState } from '../../../src/api/services/api-state-restore.js';
import type { BackupStorage } from '../../../src/api/services/api-backup-manifest.js';
import { CloudType } from '../../../src/shared/cloud.js';

describe('hosted API state restore', () => {
  let dir: string;
  let objects: Map<string, Buffer>;
  const database = Buffer.from('SQLite format 3\0restored');

  function manifest(sha = createHash('sha256').update(database).digest('hex')) {
    return Buffer.from(
      JSON.stringify({
        version: 1,
        clusterId: 'prod-1-abcd',
        backedUpAt: '2026-09-27T12:00:00.000Z',
        schemaAppVersion: '0.1.65',
        databaseSha256: sha,
      }),
    );
  }

  const storage: BackupStorage = {
    type: CloudType.AWS,
    listObjects: async (_bucket: string, options: { prefix: string }) => ({
      entries: [...objects.keys()]
        .filter((key) => key.startsWith(options.prefix))
        .map((key) => ({
          kind: 'object' as const,
          key,
          sizeBytes: null,
          lastModifiedAt: null,
        })),
      nextCursor: null,
    }),
    downloadObject: async (_bucket: string, key: string) => ({
      stream: Readable.from([objects.get(key)!]),
    }),
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'anycloud-restore-spec-'));
    objects = new Map([
      [API_CIPHER_KEY_BACKUP_KEY, Buffer.from('k'.repeat(64))],
      [API_DATABASE_BACKUP_KEY, database],
      [API_BACKUP_MANIFEST_KEY, manifest()],
    ]);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the key with mode 0600 and the database, then leaves a populated volume alone', async () => {
    writeFileSync(join(dir, 'api.db-wal'), 'stale');
    writeFileSync(join(dir, 'api.db-shm'), 'stale');
    await expect(restoreApiState({ dir, bucket: 'b', storage })).resolves.toBe(
      'restored',
    );
    expect(readFileSync(join(dir, 'cipher.key'), 'utf8')).toBe('k'.repeat(64));
    expect(statSync(join(dir, 'cipher.key')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, 'api.db'))).toEqual(database);
    expect(existsSync(join(dir, '.restore'))).toBe(false);
    expect(existsSync(join(dir, 'api.db-wal'))).toBe(false);
    expect(existsSync(join(dir, 'api.db-shm'))).toBe(false);
    writeFileSync(join(dir, 'api.db'), 'live');
    await expect(restoreApiState({ dir, bucket: 'b', storage })).resolves.toBe(
      'present',
    );
    expect(readFileSync(join(dir, 'api.db'), 'utf8')).toBe('live');
  });

  it('replaces a cipher.key already on a volume that has no database', async () => {
    writeFileSync(join(dir, 'cipher.key'), 'generated-at-import');
    await expect(restoreApiState({ dir, bucket: 'b', storage })).resolves.toBe(
      'restored',
    );
    expect(readFileSync(join(dir, 'cipher.key'), 'utf8')).toBe('k'.repeat(64));
  });

  it('refuses a database that does not match its manifest and writes nothing', async () => {
    objects.set(API_BACKUP_MANIFEST_KEY, manifest('0'.repeat(64)));
    await expect(
      restoreApiState({ dir, bucket: 'b', storage }),
    ).rejects.toThrow(
      `was interrupted: restore the anycloud-api/database.sqlite version with SHA-256 ${'0'.repeat(64)}, then create again`,
    );
    expect(existsSync(join(dir, 'api.db'))).toBe(false);
    expect(existsSync(join(dir, 'cipher.key'))).toBe(false);
  });

  it('refuses a bucket with no backup, naming a database without a manifest', async () => {
    objects.delete(API_BACKUP_MANIFEST_KEY);
    await expect(readApiBackupManifest(storage, 'b')).resolves.toBe(
      'unrestorable',
    );
    objects.delete(API_DATABASE_BACKUP_KEY);
    await expect(readApiBackupManifest(storage, 'b')).resolves.toBeNull();
    await expect(
      restoreApiState({ dir, bucket: 'b', storage }),
    ).rejects.toThrow('holds no hosted API backup');
  });

  it('rejects a malformed manifest', () => {
    expect(() =>
      parseApiBackupManifest(JSON.stringify({ version: 1, clusterId: 'x' })),
    ).toThrow(`${API_BACKUP_MANIFEST_KEY} is malformed`);
    const valid = {
      version: 1,
      clusterId: 'x',
      backedUpAt: '2026-11-07T00:00:00.000Z',
      schemaAppVersion: null,
      databaseSha256: 'a'.repeat(64),
    };
    // Backups from before the inventory still parse; a bad inventory doesn't.
    expect(parseApiBackupManifest(JSON.stringify(valid))).toEqual(valid);
    expect(() =>
      parseApiBackupManifest(JSON.stringify({ ...valid, pools: {} })),
    ).toThrow(`${API_BACKUP_MANIFEST_KEY} is malformed`);
  });
});
