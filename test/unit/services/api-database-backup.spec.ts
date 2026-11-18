import BetterSqlite3 from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_CIPHER_KEY_BACKUP_KEY,
  API_DATABASE_BACKUP_INTERVAL_MS,
  API_DATABASE_BACKUP_KEY,
  createApiDatabaseBackup,
} from '../../../src/api/services/api-database-backup.js';
import {
  API_BACKUP_MANIFEST_KEY,
  parseApiBackupManifest,
} from '../../../src/shared/api-backup-manifest.js';
import {
  createDatabase,
  type CloseableDB,
} from '../../../src/api/services/repositories/db.js';
import type { CloudUploadSource } from '../../../src/api/services/gateways/cloud.js';

describe('API database backup', () => {
  let dir: string;
  let db: CloseableDB;
  let uploads: Array<{ bucket: string; key: string; bytes: Buffer }>;
  let databaseSha256: string;
  let versioning: 'enabled' | 'disabled';
  let failDatabaseUpload: boolean;
  let stallDatabaseUpload: boolean;
  let intervals: Array<{ ms: number }>;
  let hourly: (() => void) | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'anycloud-backup-spec-'));
    vi.stubEnv('SQLITE_PATH', join(dir, 'live.sqlite'));
    vi.stubEnv('IS_TEST', 'false');
    db = createDatabase();
    await db.init!();
    uploads = [];
    versioning = 'enabled';
    failDatabaseUpload = false;
    stallDatabaseUpload = false;
    intervals = [];
  });

  afterEach(() => {
    db.close();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  function backup(
    location?: { cloud: string; account: string },
    target?: { name: string; region: string; vmType: string },
    inventory?: Parameters<typeof createApiDatabaseBackup>[0]['inventory'],
  ) {
    return createApiDatabaseBackup({
      inventory,
      db,
      location,
      target,
      bucket: 'api-backups',
      cipherKey: 'k'.repeat(64),
      clusterId: 'prod-1-abcd',
      schemaAppVersion: async () => '0.1.65',
      now: () => Date.parse('2026-09-27T12:00:00Z'),
      storage: {
        uploadObject: async (
          bucket: string,
          key: string,
          source: CloudUploadSource,
        ) => {
          if (source.kind === 'buffer') {
            uploads.push({ bucket, key, bytes: source.bytes });
            return;
          }
          if (source.kind !== 'file') throw new Error('expected a file source');
          if (failDatabaseUpload) throw new Error('upload interrupted');
          if (stallDatabaseUpload) return new Promise<never>(() => undefined);
          databaseSha256 = createHash('sha256')
            .update(readFileSync(source.path))
            .digest('hex');
          // Read while the temp file still exists: the backup removes it after upload.
          const bytes = new BetterSqlite3(source.path, { readonly: true });
          const check = bytes
            .prepare('PRAGMA integrity_check')
            .pluck()
            .get() as string;
          const rows = bytes
            .prepare('SELECT count(*) FROM backup_probe')
            .pluck()
            .get() as number;
          bytes.close();
          uploads.push({
            bucket,
            key,
            bytes: Buffer.from(`${check}:${rows}:${source.contentLength}`),
          });
        },
        getBucketVersioning: async () => versioning,
      },
      log: { info: () => {}, warn: () => {} },
      setInterval: (fn, ms) => {
        intervals.push({ ms });
        hourly = fn;
        return { unref: () => {} };
      },
    });
  }

  it('produces an integrity-clean, consistent copy while writes continue, and uploads it whole under the fixed key', async () => {
    await db.query('CREATE TABLE backup_probe (n INTEGER PRIMARY KEY, v TEXT)');
    for (let n = 0; n < 500; n += 1) {
      await db.query('INSERT INTO backup_probe (n, v) VALUES (?, ?)', [
        n,
        'x'.repeat(200),
      ]);
    }
    // Concurrent writers keep going through the whole backup.
    const writers = (async () => {
      for (let n = 500; n < 900; n += 1) {
        await db.query('INSERT INTO backup_probe (n, v) VALUES (?, ?)', [
          n,
          'y'.repeat(200),
        ]);
      }
    })();
    // The answer is the manifest's time, which `api delete` reports.
    await expect(backup().run('spec')).resolves.toBe(
      '2026-09-27T12:00:00.000Z',
    );
    await writers;

    // Key, then database, then the manifest that pins them together.
    expect(uploads.map(({ bucket, key }) => `${bucket}/${key}`)).toEqual([
      `api-backups/${API_CIPHER_KEY_BACKUP_KEY}`,
      `api-backups/${API_DATABASE_BACKUP_KEY}`,
      `api-backups/${API_BACKUP_MANIFEST_KEY}`,
    ]);
    expect(uploads[0].bytes.toString()).toBe('k'.repeat(64));
    const [check, rows, length] = uploads[1].bytes.toString().split(':');
    expect(check).toBe('ok');
    // A consistent snapshot: at least the rows committed before the backup
    // began and never a torn count above what the writers produced.
    expect(Number(rows)).toBeGreaterThanOrEqual(500);
    expect(Number(rows)).toBeLessThanOrEqual(900);
    expect(Number(length)).toBeGreaterThan(0);
    expect(JSON.parse(uploads[2].bytes.toString())).toEqual({
      version: 1,
      clusterId: 'prod-1-abcd',
      backedUpAt: '2026-09-27T12:00:00.000Z',
      schemaAppVersion: '0.1.65',
      databaseSha256,
    });
  });

  it('records where the installation runs in the manifest, and still backs up when that read fails', async () => {
    await db.query('CREATE TABLE backup_probe (n INTEGER PRIMARY KEY)');
    const inventory = {
      credentials: [{ name: 'gcp', cloud: 'GCP', account: 'prod-project' }],
      pools: [
        {
          id: 'pool-a',
          name: 'gpu',
          cloud: 'GCP',
          credential: 'gcp',
          account: 'prod-project',
          region: 'us-central1',
          zone: null,
        },
      ],
    };
    await backup(undefined, undefined, async () => inventory).run('spec');
    expect(JSON.parse(uploads[2].bytes.toString())).toEqual({
      version: 1,
      clusterId: 'prod-1-abcd',
      backedUpAt: '2026-09-27T12:00:00.000Z',
      schemaAppVersion: '0.1.65',
      databaseSha256,
      ...inventory,
    });

    uploads = [];
    await backup(undefined, undefined, async () => {
      throw new Error('STS unreachable');
    }).run('spec');
    expect(Object.keys(JSON.parse(uploads[2].bytes.toString()))).toEqual([
      'version',
      'clusterId',
      'backedUpAt',
      'schemaAppVersion',
      'databaseSha256',
    ]);
  });

  it('records where the cluster ran and what it was, which a restore reads with the API gone', async () => {
    await db.query('CREATE TABLE backup_probe (n INTEGER PRIMARY KEY)');
    await backup(
      { cloud: 'gcp', account: 'proj-1' },
      { name: 'prod', region: 'us-central1', vmType: 'e2-standard-2' },
    ).run('spec');
    const manifest = parseApiBackupManifest(uploads[2].bytes.toString());
    expect(manifest).toMatchObject({
      cloud: 'gcp',
      account: 'proj-1',
      name: 'prod',
      region: 'us-central1',
      vmType: 'e2-standard-2',
    });
    expect(() =>
      parseApiBackupManifest(JSON.stringify({ ...manifest, vmType: 4 })),
    ).toThrow('malformed');
  });

  it('writes no manifest when the database upload fails', async () => {
    failDatabaseUpload = true;
    await expect(backup().run('spec')).rejects.toThrow('upload interrupted');
    expect(uploads.map(({ key }) => key)).toEqual([API_CIPHER_KEY_BACKUP_KEY]);
  });

  it('starts the hourly timer only when the bucket keeps object versions', async () => {
    versioning = 'disabled';
    await expect(backup().start()).resolves.toBe(false);
    expect(intervals).toEqual([]);
    versioning = 'enabled';
    await expect(backup().start()).resolves.toBe(true);
    expect(intervals).toEqual([{ ms: API_DATABASE_BACKUP_INTERVAL_MS }]);
  });

  it('stops without waiting for a stalled upload, which never writes its manifest', async () => {
    stallDatabaseUpload = true;
    const service = backup();
    await expect(service.start()).resolves.toBe(true);
    hourly!();
    await vi.waitFor(() =>
      expect(uploads.map(({ key }) => key)).toEqual([
        API_CIPHER_KEY_BACKUP_KEY,
      ]),
    );
    service.stop();
    hourly!();
    expect(uploads.map(({ key }) => key)).toEqual([API_CIPHER_KEY_BACKUP_KEY]);
  });
});
