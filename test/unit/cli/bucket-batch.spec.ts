import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { createServer } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ listBucketObjects: vi.fn() }));
import {
  BucketBatchOperationError,
  DownloadIntegrityError,
  buildDownloadManifest,
  buildUploadManifest,
  listAllBucketObjects,
  resolveBucketConcurrency,
  runBucketBatch,
  validateRecursiveProvider,
  writeStreamAtomically,
} from '../../../src/cli/commands/bucket/batch.js';
import type { BucketObjectEntry } from '../../../src/shared/api-contract/bucket-metadata-schemas.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { createApiClient } from '../../../src/shared/services/api-client/rpc.js';

vi.mock('../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: (accessToken: string) => ({
    bucket: {
      objects: ({ query }: { query: Record<string, string> }) =>
        api.listBucketObjects(accessToken, {
          ...query,
          ...(query.pageSize ? { pageSize: Number(query.pageSize) } : {}),
          ...(query.recursive ? { recursive: query.recursive === 'true' } : {}),
        }),
    },
  }),
}));

const listBucketObjects = api.listBucketObjects;

describe('bucket recursive batch helpers', () => {
  let workDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    workDir = mkdtempSync(join(tmpdir(), 'bucket-batch-test-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('builds a sorted upload manifest and ignores empty directories', async () => {
    const source = join(workDir, 'source');
    mkdirSync(join(source, 'empty'), { recursive: true });
    mkdirSync(join(source, 'nested'), { recursive: true });
    writeFileSync(join(source, 'z'), 'zz');
    writeFileSync(join(source, 'nested', '.hidden'), 'h');

    const manifest = await buildUploadManifest(source, 'prefix/');

    expect(manifest.map(({ key, sizeBytes }) => ({ key, sizeBytes }))).toEqual([
      { key: 'prefix/nested/.hidden', sizeBytes: 1 },
      { key: 'prefix/z', sizeBytes: 2 },
    ]);
  });

  it('rejects symlinks before returning an upload manifest', async () => {
    const source = join(workDir, 'source');
    mkdirSync(source);
    writeFileSync(join(source, 'target'), 'x');
    symlinkSync(join(source, 'target'), join(source, 'link'));

    await expect(buildUploadManifest(source, '')).rejects.toThrow(/symlinks/);
  });

  it('rejects special files before returning an upload manifest', async () => {
    const source = join(workDir, 'source');
    const socketPath = join(source, 'socket');
    mkdirSync(source);
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });

    try {
      await expect(buildUploadManifest(source, '')).rejects.toThrow(
        /regular files/,
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('rejects traversal, separator, marker, and collision hazards', async () => {
    const fixture = (key: string, sizeBytes: number | null = 1) => ({
      kind: 'object' as const,
      key,
      sizeBytes,
      lastModifiedAt: null,
    });
    const destination = join(workDir, 'download');

    await expect(
      buildDownloadManifest([fixture('p/../escape')], 'p/', destination),
    ).rejects.toThrow(/safely/);
    await expect(
      buildDownloadManifest([fixture('p/a\\b')], 'p/', destination),
    ).rejects.toThrow(/safely/);
    await expect(
      buildDownloadManifest([fixture('/absolute')], '', destination),
    ).rejects.toThrow(/safely/);
    await expect(
      buildDownloadManifest([fixture('C:/absolute')], '', destination),
    ).rejects.toThrow(/safely/);
    await expect(
      buildDownloadManifest([fixture('p/a//b')], 'p/', destination),
    ).rejects.toThrow(/safely/);
    await expect(
      buildDownloadManifest([fixture('p/./file')], 'p/', destination),
    ).rejects.toThrow(/safely/);
    await expect(
      buildDownloadManifest([fixture('outside/file')], 'p/', destination),
    ).rejects.toThrow(/requested prefix/);
    await expect(
      buildDownloadManifest([fixture('p/marker/', null)], 'p/', destination),
    ).rejects.toThrow(/unknown size/);
    await expect(
      buildDownloadManifest([fixture('p/marker/', 1)], 'p/', destination),
    ).rejects.toThrow(/nonzero/);
    await expect(
      buildDownloadManifest(
        [fixture('p/a'), fixture('p/a/b')],
        'p/',
        destination,
      ),
    ).rejects.toThrow(/file\/directory collision/);
    await expect(
      buildDownloadManifest(
        [fixture('p/Name'), fixture('p/name')],
        'p/',
        destination,
      ),
    ).rejects.toThrow(/same local path/);
  });

  it('accepts zero-byte markers and overwrites a regular file atomically', async () => {
    const objects: BucketObjectEntry[] = [
      {
        kind: 'object',
        key: 'p/empty/',
        sizeBytes: 0,
        lastModifiedAt: null,
      },
      {
        kind: 'object',
        key: 'p/file',
        sizeBytes: 3,
        lastModifiedAt: null,
      },
    ];
    const destination = join(workDir, 'download');
    mkdirSync(destination);
    writeFileSync(join(destination, 'file'), 'old');

    const manifest = await buildDownloadManifest(objects, 'p/', destination);
    expect(manifest.map((item) => item.kind)).toEqual(['directory', 'file']);
    await writeStreamAtomically(
      Readable.from([Buffer.from('new')]),
      join(destination, 'file'),
      3,
    );
    expect(readFileSync(join(destination, 'file'), 'utf8')).toBe('new');
  });

  it('preserves existing permissions without changing new-file defaults', async () => {
    const destination = join(workDir, 'download');
    mkdirSync(destination);
    const existingPath = join(destination, 'existing');
    writeFileSync(existingPath, 'old');
    chmodSync(existingPath, 0o600);

    await writeStreamAtomically(
      Readable.from([Buffer.from('new')]),
      existingPath,
      3,
    );

    expect(statSync(existingPath).mode & 0o777).toBe(0o600);

    const newPath = join(destination, 'new');
    await writeStreamAtomically(
      Readable.from([Buffer.from('new')]),
      newPath,
      3,
    );

    expect(statSync(newPath).mode & 0o777).toBe(0o666 & ~process.umask());
  });

  it('rejects a clean early EOF and preserves the existing destination', async () => {
    const destination = join(workDir, 'download');
    mkdirSync(destination);
    const localPath = join(destination, 'file');
    writeFileSync(localPath, 'known-good');

    await expect(
      writeStreamAtomically(Readable.from([Buffer.from('cut')]), localPath, 10),
    ).rejects.toMatchObject({
      name: 'DownloadIntegrityError',
      expectedBytes: 10,
      receivedBytes: 3,
    } satisfies Partial<DownloadIntegrityError>);

    expect(readFileSync(localPath, 'utf8')).toBe('known-good');
  });

  it('rejects existing destination symlinks during download preflight', async () => {
    const destination = join(workDir, 'download');
    const outside = join(workDir, 'outside');
    mkdirSync(destination);
    mkdirSync(outside);
    symlinkSync(outside, join(destination, 'nested'), 'dir');
    const objects: BucketObjectEntry[] = [
      {
        kind: 'object',
        key: 'p/nested/file',
        sizeBytes: 1,
        lastModifiedAt: null,
      },
    ];

    await expect(
      buildDownloadManifest(objects, 'p/', destination),
    ).rejects.toThrow(/unsafe directory/);
  });

  it('rejects existing file and directory conflicts during preflight', async () => {
    const destination = join(workDir, 'download');
    mkdirSync(destination);
    writeFileSync(join(destination, 'parent'), 'file');
    mkdirSync(join(destination, 'target'));

    await expect(
      buildDownloadManifest(
        [
          {
            kind: 'object',
            key: 'p/parent/child',
            sizeBytes: 1,
            lastModifiedAt: null,
          },
        ],
        'p/',
        destination,
      ),
    ).rejects.toThrow(/unsafe directory/);
    await expect(
      buildDownloadManifest(
        [
          {
            kind: 'object',
            key: 'p/target',
            sizeBytes: 1,
            lastModifiedAt: null,
          },
        ],
        'p/',
        destination,
      ),
    ).rejects.toThrow(/not a regular file/);
  });

  it('bounds concurrency, attempts all items, and preserves failure order', async () => {
    const items = ['c', 'a', 'b'].map((key, index) => ({
      key,
      sizeBytes: index === 0 ? null : 1,
    }));
    let active = 0;
    let peak = 0;
    const attempted: string[] = [];

    let caught: BucketBatchOperationError | undefined;
    try {
      await runBucketBatch({
        operation: 'delete',
        label: 'Deleting',
        items,
        concurrency: 2,
        worker: async (item) => {
          attempted.push(item.key);
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          if (item.key !== 'a') throw new Error(`failed ${item.key}`);
        },
      });
    } catch (error) {
      if (error instanceof BucketBatchOperationError) caught = error;
      else throw error;
    }

    expect(peak).toBe(2);
    expect(attempted).toHaveLength(3);
    expect(caught?.failures.map((failure) => failure.key)).toEqual(['c', 'b']);
    expect(caught?.result).toMatchObject({
      completedObjects: 1,
      failedObjects: 2,
      totalBytes: null,
      completedBytes: 1,
    });
  });

  it('uses four workers by default and accepts both concurrency bounds', () => {
    expect(resolveBucketConcurrency(undefined)).toBe(4);
    expect(resolveBucketConcurrency('1')).toBe(1);
    expect(resolveBucketConcurrency('32')).toBe(32);
  });

  it('returns a complete zero-valued result for an empty manifest', async () => {
    await expect(
      runBucketBatch({
        operation: 'upload',
        label: 'Uploading',
        items: [],
        concurrency: 4,
        worker: async () => undefined,
      }),
    ).resolves.toEqual({
      operation: 'upload',
      totalObjects: 0,
      completedObjects: 0,
      failedObjects: 0,
      totalBytes: 0,
      completedBytes: 0,
    });
  });

  it('renders aggregate TTY progress on stderr without object-key output', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
    Object.defineProperty(process.stderr, 'isTTY', {
      configurable: true,
      value: true,
    });
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      await runBucketBatch({
        operation: 'download',
        label: 'Downloading aggregate',
        items: [
          { key: 'private/first-key', sizeBytes: 1 },
          { key: 'private/second-key', sizeBytes: 2 },
        ],
        concurrency: 2,
        worker: async () => undefined,
      });

      const output = stderrWrite.mock.calls
        .map(([chunk]) => String(chunk))
        .join('');
      expect(output).toContain('2/2 processed, 2 succeeded, 3 B / 3 B');
      expect(output).not.toContain('private/first-key');
      expect(output).not.toContain('private/second-key');
      expect(output.endsWith('\n')).toBe(true);
      expect(stdoutWrite).not.toHaveBeenCalled();
    } finally {
      stderrWrite.mockRestore();
      stdoutWrite.mockRestore();
      if (descriptor) {
        Object.defineProperty(process.stderr, 'isTTY', descriptor);
      } else {
        Reflect.deleteProperty(process.stderr, 'isTTY');
      }
    }
  });

  it('keeps aggregate progress silent for non-TTY stderr', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
    Object.defineProperty(process.stderr, 'isTTY', {
      configurable: true,
      value: false,
    });
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    try {
      await runBucketBatch({
        operation: 'delete',
        label: 'Deleting aggregate',
        items: [{ key: 'one', sizeBytes: 1 }],
        concurrency: 1,
        worker: async () => undefined,
      });
      expect(stderrWrite).not.toHaveBeenCalled();
    } finally {
      stderrWrite.mockRestore();
      if (descriptor) {
        Object.defineProperty(process.stderr, 'isTTY', descriptor);
      } else {
        Reflect.deleteProperty(process.stderr, 'isTTY');
      }
    }
  });

  it('exhausts recursive object pages and rejects repeated cursors', async () => {
    vi.mocked(listBucketObjects)
      .mockResolvedValueOnce({
        entries: [
          {
            kind: 'object',
            key: 'p/b',
            sizeBytes: 1,
            lastModifiedAt: null,
          },
        ],
        nextCursor: 'same',
      })
      .mockResolvedValueOnce({
        entries: [
          {
            kind: 'object',
            key: 'p/a',
            sizeBytes: 1,
            lastModifiedAt: null,
          },
        ],
        nextCursor: null,
      });

    await expect(
      listAllBucketObjects({
        client: createApiClient('token'),
        bucketName: 'bucket',
        prefix: 'p/',
        credentialName: 'prod',
      }),
    ).resolves.toEqual([
      {
        kind: 'object',
        key: 'p/a',
        sizeBytes: 1,
        lastModifiedAt: null,
      },
      {
        kind: 'object',
        key: 'p/b',
        sizeBytes: 1,
        lastModifiedAt: null,
      },
    ]);

    vi.mocked(listBucketObjects).mockReset().mockResolvedValue({
      entries: [],
      nextCursor: 'same',
    });
    await expect(
      listAllBucketObjects({
        client: createApiClient('token'),
        bucketName: 'bucket',
        prefix: 'p/',
        credentialName: 'prod',
      }),
    ).rejects.toThrow(/repeated pagination cursor/);
  });

  it.each(['0', '33', '-1', '1.5', 'many'])(
    'rejects invalid concurrency %s',
    (value) => {
      expect(() => resolveBucketConcurrency(value)).toThrow(/between 1 and 32/);
    },
  );

  it('rejects providers without native bucket object storage', () => {
    expect(() => validateRecursiveProvider(CloudType.Lambda)).toThrow(
      /do not support recursive/,
    );
    expect(() => validateRecursiveProvider(CloudType.Local)).toThrow(
      /do not support recursive/,
    );
  });
});
