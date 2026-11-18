import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { chmod, lstat, mkdir, readdir, rename, rm } from 'fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
  win32,
} from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { BucketObjectEntry } from '../../../shared/api-contract/bucket-metadata-schemas.js';
import type { ApiClient } from '../../../shared/services/api-client/rpc.js';
import { type CloudType } from '../../../shared/cloud.js';
import { supportsObjectStorage } from '../../../shared/providers.js';

const DEFAULT_BUCKET_CONCURRENCY = 4;
const MAX_BUCKET_CONCURRENCY = 32;
const OBJECT_LIST_PAGE_SIZE = 1000;

export interface BucketBatchItem {
  key: string;
  sizeBytes: number | null;
}

export interface UploadManifestItem extends BucketBatchItem {
  localPath: string;
  sizeBytes: number;
}

export interface DownloadManifestItem extends BucketBatchItem {
  kind: 'file' | 'directory';
  localPath: string;
  relativeParts: string[];
}

export type BucketBatchOperation = 'upload' | 'download' | 'delete';

export interface BucketBatchResult {
  operation: BucketBatchOperation;
  totalObjects: number;
  completedObjects: number;
  failedObjects: number;
  totalBytes: number | null;
  completedBytes: number | null;
}

export interface BucketBatchFailure {
  key: string;
  error: Error;
}

export class BucketBatchOperationError extends Error {
  constructor(
    public readonly result: BucketBatchResult,
    public readonly failures: BucketBatchFailure[],
  ) {
    super(
      `${result.failedObjects} object(s) failed; ${result.completedObjects} succeeded`,
    );
    this.name = 'BucketBatchOperationError';
  }
}

export class DownloadIntegrityError extends Error {
  constructor(
    public readonly expectedBytes: number | null,
    public readonly receivedBytes: number | null,
  ) {
    super(
      expectedBytes === null
        ? 'Download integrity could not be verified because the server did not report the object size'
        : `Download was incomplete: expected ${expectedBytes} bytes, received ${receivedBytes ?? 0}`,
    );
    this.name = 'DownloadIntegrityError';
  }
}

export class DownloadDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DownloadDestinationError';
  }
}

function errorMessage(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function nullableByteSum(
  items: Array<{ sizeBytes: number | null }>,
): number | null {
  if (items.some((item) => item.sizeBytes === null)) return null;
  return items.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
}

export function formatBucketBytes(bytes: number | null): string {
  if (bytes === null) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

export function formatBucketBatchResult(result: BucketBatchResult): string {
  const bytes =
    result.completedBytes === null
      ? 'size unknown'
      : formatBucketBytes(result.completedBytes);
  return `${result.completedObjects}/${result.totalObjects} object(s), ${bytes}`;
}

export function resolveBucketConcurrency(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_BUCKET_CONCURRENCY;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `--concurrency must be an integer between 1 and ${MAX_BUCKET_CONCURRENCY}`,
    );
  }
  const concurrency = Number(raw);
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_BUCKET_CONCURRENCY
  ) {
    throw new Error(
      `--concurrency must be an integer between 1 and ${MAX_BUCKET_CONCURRENCY}`,
    );
  }
  return concurrency;
}

export function validateDirectoryPrefix(
  prefix: string,
  options: { allowEmpty: boolean },
): void {
  if (!options.allowEmpty && prefix.length === 0) {
    throw new Error(
      'Recursive deletion requires a non-empty prefix ending in /',
    );
  }
  if (prefix.length > 0 && !prefix.endsWith('/')) {
    throw new Error('Directory prefixes must be empty or end in /');
  }
}

export function validateRecursiveProvider(provider: CloudType): void {
  if (!supportsObjectStorage(provider)) {
    throw new Error(
      `${provider} credentials do not support recursive bucket operations`,
    );
  }
}

export async function listAllBucketObjects(options: {
  client: ApiClient;
  bucketName: string;
  prefix: string;
  credentialName: string;
  region?: string;
}): Promise<BucketObjectEntry[]> {
  const objects: BucketObjectEntry[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  const { client } = options;

  for (;;) {
    const page = await client.bucket.objects({
      params: {
        bucketName: options.bucketName,
        credentialName: options.credentialName,
      },
      query: {
        prefix: options.prefix,
        recursive: 'true',
        pageSize: String(OBJECT_LIST_PAGE_SIZE),
        ...(options.region ? { region: options.region } : {}),
        ...(cursor ? { cursor } : {}),
      },
    });
    for (const entry of page.entries) {
      if (entry.kind !== 'object') {
        throw new Error(
          `Recursive object listing returned unexpected prefix ${entry.key}`,
        );
      }
      objects.push(entry);
    }
    if (!page.nextCursor) break;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error('Bucket listing returned a repeated pagination cursor');
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  objects.sort((a, b) => a.key.localeCompare(b.key));
  return objects;
}

async function lstatIfExists(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function buildUploadManifest(
  localDirectory: string,
  prefix: string,
): Promise<UploadManifestItem[]> {
  validateDirectoryPrefix(prefix, { allowEmpty: true });
  const root = resolve(localDirectory);
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(
      `Recursive upload source must be a directory: ${localDirectory}`,
    );
  }

  const manifest: UploadManifestItem[] = [];
  const walk = async (directory: string, relativeParts: string[]) => {
    const names = (await readdir(directory)).sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const localPath = join(directory, name);
      const itemParts = [...relativeParts, name];
      const itemStat = await lstat(localPath);
      if (itemStat.isSymbolicLink()) {
        throw new Error(
          `Recursive upload does not allow symlinks: ${localPath}`,
        );
      }
      if (itemStat.isDirectory()) {
        await walk(localPath, itemParts);
        continue;
      }
      if (!itemStat.isFile()) {
        throw new Error(
          `Recursive upload only supports regular files: ${localPath}`,
        );
      }
      manifest.push({
        key: `${prefix}${itemParts.join('/')}`,
        localPath,
        sizeBytes: itemStat.size,
      });
    }
  };

  await walk(root, []);
  manifest.sort((a, b) => a.key.localeCompare(b.key));
  return manifest;
}

function safeRelativeParts(
  key: string,
  suffix: string,
  marker: boolean,
): string[] {
  if (
    isAbsolute(suffix) ||
    win32.isAbsolute(suffix) ||
    win32.parse(suffix).root
  ) {
    throw new Error(`Object key cannot be mapped safely: ${key}`);
  }
  if (suffix.includes('\\') || suffix.includes('\0')) {
    throw new Error(`Object key cannot be mapped safely: ${key}`);
  }
  const mapped = marker ? suffix.slice(0, -1) : suffix;
  if (mapped.length === 0) return [];
  const parts = mapped.split('/');
  if (
    parts.some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new Error(`Object key cannot be mapped safely: ${key}`);
  }
  return parts;
}

function collisionKey(path: string): string {
  return normalize(path).toLocaleLowerCase('en-US');
}

async function validateExistingDownloadPath(
  root: string,
  item: DownloadManifestItem,
): Promise<void> {
  let current = root;
  const directoryParts =
    item.kind === 'directory'
      ? item.relativeParts
      : item.relativeParts.slice(0, -1);
  for (const part of directoryParts) {
    current = join(current, part);
    const currentStat = await lstatIfExists(current);
    if (!currentStat) continue;
    if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
      throw new Error(
        `Download destination has an unsafe directory: ${current}`,
      );
    }
  }

  if (item.kind === 'file') {
    const targetStat = await lstatIfExists(item.localPath);
    if (targetStat && (targetStat.isSymbolicLink() || !targetStat.isFile())) {
      throw new Error(
        `Download destination is not a regular file: ${item.localPath}`,
      );
    }
  }
}

export async function buildDownloadManifest(
  objects: BucketObjectEntry[],
  prefix: string,
  localDirectory: string,
): Promise<DownloadManifestItem[]> {
  validateDirectoryPrefix(prefix, { allowEmpty: true });
  const root = resolve(localDirectory);
  const rootStat = await lstatIfExists(root);
  if (rootStat && (rootStat.isSymbolicLink() || !rootStat.isDirectory())) {
    throw new Error(
      `Recursive download destination must be a directory: ${localDirectory}`,
    );
  }

  const manifest: DownloadManifestItem[] = [];
  const targets = new Map<string, DownloadManifestItem>();
  for (const object of objects) {
    if (!object.key.startsWith(prefix)) {
      throw new Error(
        `Object ${object.key} does not start with requested prefix ${prefix}`,
      );
    }
    const suffix = object.key.slice(prefix.length);
    const marker = object.key.endsWith('/');
    if (marker && object.sizeBytes !== 0) {
      throw new Error(
        `Directory marker ${object.key} has nonzero or unknown size and cannot be downloaded safely`,
      );
    }
    const relativeParts = safeRelativeParts(object.key, suffix, marker);
    if (!marker && relativeParts.length === 0) {
      throw new Error(`Object key cannot be mapped safely: ${object.key}`);
    }
    const localPath = join(root, ...relativeParts);
    const fromRoot = relative(root, localPath);
    if (
      fromRoot === '..' ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      throw new Error(
        `Object key escapes the download directory: ${object.key}`,
      );
    }
    const item: DownloadManifestItem = {
      kind: marker ? 'directory' : 'file',
      key: object.key,
      localPath,
      relativeParts,
      sizeBytes: object.sizeBytes,
    };
    const targetKey = collisionKey(localPath);
    const existing = targets.get(targetKey);
    if (existing) {
      throw new Error(
        `Object keys ${existing.key} and ${object.key} map to the same local path`,
      );
    }
    targets.set(targetKey, item);
    manifest.push(item);
  }

  const fileTargets = new Set(
    manifest
      .filter((item) => item.kind === 'file')
      .map((item) => collisionKey(item.localPath)),
  );
  for (const item of manifest) {
    if (
      item.kind === 'directory' &&
      fileTargets.has(collisionKey(item.localPath))
    ) {
      throw new Error(
        `Object keys map to both a file and directory: ${item.key}`,
      );
    }
    let parent = dirname(item.localPath);
    while (parent !== root && parent.startsWith(`${root}${sep}`)) {
      if (fileTargets.has(collisionKey(parent))) {
        throw new Error(
          `Object keys create a file/directory collision at ${parent}`,
        );
      }
      parent = dirname(parent);
    }
    await validateExistingDownloadPath(root, item);
  }

  manifest.sort((a, b) => a.key.localeCompare(b.key));
  return manifest;
}

export async function materializeDownloadDirectory(
  path: string,
): Promise<void> {
  await mkdir(path, { recursive: true });
  const pathStat = await lstat(path);
  if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) {
    throw new Error(`Download destination is not a safe directory: ${path}`);
  }
}

export async function writeStreamAtomically(
  stream: NodeJS.ReadableStream,
  localPath: string,
  expectedBytes: number,
): Promise<number> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    throw new DownloadIntegrityError(null, null);
  }
  const parent = dirname(localPath);
  await mkdir(parent, { recursive: true });
  const before = await lstatIfExists(localPath);
  if (before && (before.isSymbolicLink() || !before.isFile())) {
    throw new DownloadDestinationError(
      `Download destination is not a regular file: ${localPath}`,
    );
  }
  // rename() would otherwise reset the destination to the umask default;
  // keep whatever mode the existing file already had.
  const preservedMode = before ? before.mode & 0o777 : undefined;
  const temporaryPath = join(
    parent,
    `.anycloud-${randomUUID()}-${localPath.split(sep).pop() ?? 'download'}.tmp`,
  );
  let receivedBytes = 0;
  const countBytes = new Transform({
    transform(chunk: Buffer | string, encoding, callback) {
      receivedBytes +=
        typeof chunk === 'string'
          ? Buffer.byteLength(chunk, encoding as BufferEncoding)
          : chunk.byteLength;
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      stream,
      countBytes,
      createWriteStream(temporaryPath, {
        flags: 'wx',
        ...(preservedMode === undefined ? {} : { mode: preservedMode }),
      }),
    );
    if (receivedBytes !== expectedBytes) {
      throw new DownloadIntegrityError(expectedBytes, receivedBytes);
    }
    const after = await lstatIfExists(localPath);
    if (after && (after.isSymbolicLink() || !after.isFile())) {
      throw new DownloadDestinationError(
        `Download destination changed during transfer: ${localPath}`,
      );
    }
    if (preservedMode !== undefined) await chmod(temporaryPath, preservedMode);
    await rename(temporaryPath, localPath);
    return receivedBytes;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

class BucketBatchProgress {
  private settled = 0;
  private completed = 0;
  private completedBytes = 0;
  private completedBytesKnown = true;
  private lastLength = 0;

  constructor(
    private readonly label: string,
    private readonly totalObjects: number,
    private readonly totalBytes: number | null,
  ) {}

  itemSettled(success: boolean, sizeBytes: number | null): void {
    this.settled++;
    if (success) {
      this.completed++;
      if (sizeBytes === null) this.completedBytesKnown = false;
      else this.completedBytes += sizeBytes;
    }
    this.render();
  }

  stop(): void {
    if (!process.stderr.isTTY || this.totalObjects === 0) return;
    this.render();
    process.stderr.write('\n');
  }

  private render(): void {
    if (!process.stderr.isTTY) return;
    const bytes = this.completedBytesKnown
      ? formatBucketBytes(this.completedBytes)
      : 'size unknown';
    const total =
      this.totalBytes === null
        ? ''
        : ` / ${formatBucketBytes(this.totalBytes)}`;
    const line = `   ${this.label}: ${this.settled}/${this.totalObjects} processed, ${this.completed} succeeded, ${bytes}${total}`;
    process.stderr.write(
      `\r${line}${' '.repeat(Math.max(0, this.lastLength - line.length))}`,
    );
    this.lastLength = line.length;
  }
}

export async function runBucketBatch<T extends BucketBatchItem>(options: {
  operation: BucketBatchOperation;
  label: string;
  items: T[];
  concurrency: number;
  worker: (item: T) => Promise<void>;
}): Promise<BucketBatchResult> {
  const results: PromiseSettledResult<void>[] = new Array(options.items.length);
  const totalBytes = nullableByteSum(options.items);
  const progress = new BucketBatchProgress(
    options.label,
    options.items.length,
    totalBytes,
  );
  let cursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(options.concurrency, options.items.length) },
      async () => {
        let index: number;
        while ((index = cursor++) < options.items.length) {
          const item = options.items[index];
          try {
            await options.worker(item);
            results[index] = { status: 'fulfilled', value: undefined };
            progress.itemSettled(true, item.sizeBytes);
          } catch (error) {
            results[index] = { status: 'rejected', reason: error };
            progress.itemSettled(false, item.sizeBytes);
          }
        }
      },
    ),
  );
  progress.stop();

  const completedItems = options.items.filter(
    (_item, index) => results[index]?.status === 'fulfilled',
  );
  const failures = options.items.flatMap((item, index) => {
    const result = results[index];
    return result?.status === 'rejected'
      ? [{ key: item.key, error: errorMessage(result.reason) }]
      : [];
  });
  const result: BucketBatchResult = {
    operation: options.operation,
    totalObjects: options.items.length,
    completedObjects: completedItems.length,
    failedObjects: failures.length,
    totalBytes,
    completedBytes: nullableByteSum(completedItems),
  };
  if (failures.length > 0) {
    throw new BucketBatchOperationError(result, failures);
  }
  return result;
}
