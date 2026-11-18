import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  canListBuckets,
  canListObjects,
} from '../../../../src/api/services/gateways/cloud';
import { createLocalFilesystemStorage } from '../../../../src/api/services/gateways/local-storage';
import {
  BucketNotFoundError,
  ObjectNotFoundError,
} from '../../../../src/shared/errors';

describe('Local filesystem storage', () => {
  let tempDir: string;
  let root: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anycloud-local-storage-'));
    root = join(tempDir, 'buckets');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('implements bucket and object lifecycle with streaming downloads', async () => {
    const storage = createLocalFilesystemStorage(root);
    expect(await storage.hasBucket('bucket-one')).toBe(false);

    await storage.upsertBucket('bucket-one', 'v1', 'workload', 'user');
    await storage.uploadObject('bucket-one', 'nested/data.txt', {
      kind: 'buffer',
      bytes: Buffer.from('local-object'),
      contentLength: 12,
    });

    expect(await storage.hasBucket('bucket-one')).toBe(true);
    const download = await storage.downloadObject(
      'bucket-one',
      'nested/data.txt',
    );
    expect(download.contentLength).toBe(12);
    expect(await streamText(download.stream)).toBe('local-object');

    await storage.deleteObject('bucket-one', 'nested/data.txt');
    await storage.deleteObject('bucket-one', 'nested/data.txt');
    await expect(
      storage.downloadObject('bucket-one', 'nested/data.txt'),
    ).rejects.toBeInstanceOf(ObjectNotFoundError);
    await storage.deleteBucket('bucket-one');
    await storage.deleteBucket('bucket-one');
    expect(await storage.hasBucket('bucket-one')).toBe(false);
    await expect(
      storage.downloadObject('bucket-one', 'nested/data.txt'),
    ).rejects.toBeInstanceOf(BucketNotFoundError);
    await expect(
      storage.uploadObject('bucket-one', 'data.txt', {
        kind: 'buffer',
        bytes: Buffer.from('x'),
        contentLength: 1,
      }),
    ).rejects.toBeInstanceOf(BucketNotFoundError);
    if (!canListObjects(storage)) throw new Error('Expected object listing');
    await expect(
      storage.listObjects('bucket-one', {
        prefix: '',
        recursive: true,
        pageSize: 1,
      }),
    ).rejects.toBeInstanceOf(BucketNotFoundError);
  });

  it('lists buckets and recursive/non-recursive object pages', async () => {
    const storage = createLocalFilesystemStorage(root);
    for (const bucket of ['bucket-a', 'bucket-b', 'bucket-c']) {
      await storage.upsertBucket(bucket, 'v1', 'workload', 'user');
    }
    await storage.uploadObject('bucket-a', 'top.txt', bufferSource('top'));
    await storage.uploadObject(
      'bucket-a',
      'nested/one.txt',
      bufferSource('one'),
    );
    await storage.uploadObject(
      'bucket-a',
      'nested/deep/two.txt',
      bufferSource('two'),
    );

    expect(canListBuckets(storage)).toBe(true);
    expect(canListObjects(storage)).toBe(true);
    if (!canListBuckets(storage) || !canListObjects(storage)) return;

    const first = await storage.listBuckets({ pageSize: 2 });
    expect(first.buckets.map(({ name }) => name)).toEqual([
      'bucket-a',
      'bucket-b',
    ]);
    expect(first.nextCursor).toBe('local:2');
    await expect(
      storage.listBuckets({ pageSize: 2, cursor: first.nextCursor! }),
    ).resolves.toMatchObject({
      buckets: [expect.objectContaining({ name: 'bucket-c' })],
      nextCursor: null,
    });

    await expect(
      storage.listObjects('bucket-a', {
        prefix: '',
        recursive: false,
        pageSize: 10,
      }),
    ).resolves.toMatchObject({
      entries: [
        { kind: 'prefix', key: 'nested/' },
        { kind: 'object', key: 'top.txt', sizeBytes: 3 },
      ],
      nextCursor: null,
    });
    const recursive = await storage.listObjects('bucket-a', {
      prefix: 'nested/',
      recursive: true,
      pageSize: 10,
    });
    expect(recursive.entries.map(({ key }) => key)).toEqual([
      'nested/deep/two.txt',
      'nested/one.txt',
    ]);
  });

  it('rejects traversal and symbolic-link escapes', async () => {
    const storage = createLocalFilesystemStorage(root);
    await storage.upsertBucket('bucket-one', 'v1', 'workload', 'user');

    await expect(
      storage.uploadObject('bucket-one', '../escape', bufferSource('bad')),
    ).rejects.toThrow('Invalid Local object path');
    await expect(
      storage.uploadObject('../escape', 'object', bufferSource('bad')),
    ).rejects.toThrow('Invalid Local bucket name');

    const outside = join(tempDir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret'), 'secret');
    symlinkSync(outside, join(root, 'bucket-one', 'linked'));
    await expect(
      storage.downloadObject('bucket-one', 'linked/secret'),
    ).rejects.toThrow('symbolic link');

    symlinkSync(outside, join(root, 'linked-bucket'));
    await expect(
      storage.upsertBucket('linked-bucket', 'v1', 'workload', 'user'),
    ).rejects.toThrow('not found');
  });
});

function bufferSource(text: string) {
  const bytes = Buffer.from(text);
  return { kind: 'buffer' as const, bytes, contentLength: bytes.length };
}

async function streamText(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
