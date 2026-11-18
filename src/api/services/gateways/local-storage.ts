import { randomUUID } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  type Dirent,
  type Stats,
} from 'node:fs';
import { lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, posix, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { BucketEntryPage } from '../../../shared/api-contract/bucket-metadata-schemas.js';
import { CloudType } from '../../../shared/cloud.js';
import {
  createCloudStorage,
  openCloudUploadSource,
  type CloudDownload,
  type CloudListPageOptions,
  type CloudObjectListOptions,
  type CloudStorage,
  type CloudUploadRequest,
} from './cloud.js';
import { storageCoordinationKey } from './storage-coordinator.js';

/**
 * Filesystem object store used only by the Local smolvm substrate. The same
 * root is mounted into every guest, so rclone sees ordinary bucket directories
 * while the API exercises the normal CloudStorage control-plane contract.
 */
export function createLocalFilesystemStorage(rootPath: string): CloudStorage {
  const store = new LocalFilesystemStore(rootPath);
  return createCloudStorage({
    type: CloudType.Local,
    region: 'local',
    rawBucketCoordinationKey: (bucketName) =>
      storageCoordinationKey([CloudType.Local, store.rootPath, bucketName]),
    rawHasBucket: (bucketName) => store.hasBucket(bucketName),
    rawUpsertBucketUncoordinated: (bucketName) =>
      store.upsertBucket(bucketName),
    rawDeleteBucket: (bucketName) => store.deleteBucket(bucketName),
    rawDeleteObject: (bucketName, remotePath) =>
      store.deleteObject(bucketName, remotePath),
    rawUploadObject: (request) => store.uploadObject(request),
    rawDownloadObject: (bucketName, remotePath) =>
      store.downloadObject(bucketName, remotePath),
    rawListBuckets: (options) => store.listBuckets(options),
    rawListObjects: (bucketName, options) =>
      store.listObjects(bucketName, options),
    isNotFound: isNotFound,
    classifyStorageFailure: async (error, bucketName, remotePath) => {
      if (!isNotFound(error) || bucketName === undefined) return undefined;
      const code = 'ENOENT';
      if (remotePath === undefined) return { kind: 'bucket-missing', code };
      return (await store.hasBucket(bucketName))
        ? { kind: 'object-missing', code }
        : { kind: 'bucket-missing', code };
    },
  });
}

class LocalFilesystemStore {
  readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath);
    if (this.rootPath === resolve(sep)) {
      throw new Error('Local storage root cannot be the filesystem root');
    }
  }

  async hasBucket(bucketName: string): Promise<boolean> {
    await this.assertRootDirectoryIfPresent();
    const bucketPath = this.bucketPath(bucketName);
    try {
      const info = await lstat(bucketPath);
      return info.isDirectory() && !info.isSymbolicLink();
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async upsertBucket(bucketName: string): Promise<void> {
    await mkdir(this.rootPath, { recursive: true });
    await this.assertRootDirectory();
    const bucketPath = this.bucketPath(bucketName);
    await mkdir(bucketPath, { recursive: true });
    await this.assertBucketDirectory(bucketName, bucketPath);
  }

  async deleteBucket(bucketName: string): Promise<void> {
    await this.assertRootDirectoryIfPresent();
    const bucketPath = this.bucketPath(bucketName);
    const info = await lstat(bucketPath);
    if (info.isSymbolicLink()) {
      throw new Error(`Local bucket is a symbolic link: ${bucketName}`);
    }
    await rm(bucketPath, { recursive: true, force: true });
  }

  async deleteObject(bucketName: string, remotePath: string): Promise<void> {
    const objectPath = await this.safeObjectPath(bucketName, remotePath);
    await rm(objectPath, { force: true });
  }

  async uploadObject(request: CloudUploadRequest): Promise<void> {
    const objectPath = await this.safeObjectPath(
      request.bucketName,
      request.remotePath,
    );
    const parent = resolve(objectPath, '..');
    await mkdir(parent, { recursive: true });
    await this.assertNoSymlinkComponents(parent);
    const tempPath = resolve(parent, `.anycloud-upload-${randomUUID()}`);

    try {
      await pipeline(
        openCloudUploadSource(request.source),
        createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }),
      );
      await rename(tempPath, objectPath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async downloadObject(
    bucketName: string,
    remotePath: string,
  ): Promise<CloudDownload> {
    const objectPath = await this.safeObjectPath(bucketName, remotePath);
    const info = await lstat(objectPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw notFoundError(`${bucketName}/${remotePath}`);
    }
    return {
      stream: createReadStream(objectPath),
      contentLength: info.size,
    };
  }

  async listBuckets(options: CloudListPageOptions) {
    await this.assertRootDirectoryIfPresent();
    let entries: Dirent[];
    try {
      entries = await readdir(this.rootPath, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return { buckets: [], nextCursor: null };
      throw error;
    }
    const names = entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
    const { values, nextCursor } = page(names, options);
    const buckets = await Promise.all(
      values.map(async (name) => {
        const info = await stat(this.bucketPath(name));
        return {
          name,
          region: 'local',
          createdAt: finiteTimestamp(info.birthtimeMs || info.ctimeMs),
        };
      }),
    );
    return { buckets, nextCursor };
  }

  async listObjects(
    bucketName: string,
    options: CloudObjectListOptions,
  ): Promise<BucketEntryPage> {
    await this.assertRootDirectory();
    const bucketPath = this.bucketPath(bucketName);
    await this.assertBucketDirectory(bucketName, bucketPath);
    const objects = await this.walkObjects(bucketPath);
    const matching = objects.filter(({ key }) =>
      key.startsWith(options.prefix),
    );
    const entries = options.recursive
      ? matching.map(toObjectEntry)
      : collapseObjectPrefixes(matching, options.prefix);
    const { values, nextCursor } = page(entries, options);
    return { entries: values, nextCursor };
  }

  private bucketPath(bucketName: string): string {
    if (
      !bucketName ||
      bucketName === '.' ||
      bucketName === '..' ||
      bucketName.includes('/') ||
      bucketName.includes('\\') ||
      bucketName.includes('\0')
    ) {
      throw new Error(`Invalid Local bucket name: ${bucketName}`);
    }
    return this.withinRoot(resolve(this.rootPath, bucketName));
  }

  private async safeObjectPath(
    bucketName: string,
    remotePath: string,
  ): Promise<string> {
    if (
      !remotePath ||
      isAbsolute(remotePath) ||
      remotePath.includes('\\') ||
      remotePath.includes('\0') ||
      posix.normalize(remotePath) !== remotePath ||
      remotePath.split('/').some((part) => !part || part === '..')
    ) {
      throw new Error(`Invalid Local object path: ${remotePath}`);
    }

    const bucketPath = this.bucketPath(bucketName);
    await this.assertBucketDirectory(bucketName, bucketPath);
    const objectPath = this.withinRoot(resolve(bucketPath, remotePath));
    await this.assertNoSymlinkComponents(resolve(objectPath, '..'));
    return objectPath;
  }

  private async assertBucketDirectory(
    bucketName: string,
    bucketPath: string,
  ): Promise<void> {
    let info: Stats;
    try {
      info = await lstat(bucketPath);
    } catch (error) {
      if (isNotFound(error)) throw notFoundError(bucketName);
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw notFoundError(bucketName);
    }
  }

  private async assertRootDirectory(): Promise<void> {
    const info = await lstat(this.rootPath);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(
        `Local storage root is not a directory: ${this.rootPath}`,
      );
    }
  }

  private async assertRootDirectoryIfPresent(): Promise<void> {
    try {
      await this.assertRootDirectory();
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  private withinRoot(candidate: string): string {
    if (
      candidate !== this.rootPath &&
      !candidate.startsWith(`${this.rootPath}${sep}`)
    ) {
      throw new Error(`Local storage path escapes ${this.rootPath}`);
    }
    return candidate;
  }

  private async assertNoSymlinkComponents(candidate: string): Promise<void> {
    await this.assertRootDirectory();
    const relative = candidate
      .slice(this.rootPath.length)
      .split(sep)
      .filter(Boolean);
    let current = this.rootPath;
    for (const segment of relative) {
      current = resolve(current, segment);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) {
          throw new Error(
            `Local storage path contains a symbolic link: ${current}`,
          );
        }
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
    }
  }

  private async walkObjects(
    directory: string,
    prefix = '',
  ): Promise<Array<{ key: string; info: Stats }>> {
    const entries = await readdir(directory, { withFileTypes: true });
    const objects: Array<{ key: string; info: Stats }> = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (
        entry.isSymbolicLink() ||
        entry.name.startsWith('.anycloud-upload-')
      ) {
        continue;
      }
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        objects.push(...(await this.walkObjects(path, key)));
      } else if (entry.isFile()) {
        objects.push({ key, info: await stat(path) });
      }
    }
    return objects;
  }
}

function toObjectEntry({ key, info }: { key: string; info: Stats }) {
  return {
    kind: 'object' as const,
    key,
    sizeBytes: info.size,
    lastModifiedAt: finiteTimestamp(info.mtimeMs),
  };
}

function collapseObjectPrefixes(
  objects: Array<{ key: string; info: Stats }>,
  prefix: string,
): BucketEntryPage['entries'] {
  const entries = new Map<string, BucketEntryPage['entries'][number]>();
  for (const object of objects) {
    const remainder = object.key.slice(prefix.length);
    const slash = remainder.indexOf('/');
    if (slash >= 0) {
      const key = `${prefix}${remainder.slice(0, slash + 1)}`;
      entries.set(key, { kind: 'prefix', key });
    } else {
      entries.set(object.key, toObjectEntry(object));
    }
  }
  return [...entries.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function page<T>(
  values: T[],
  options: CloudListPageOptions,
): { values: T[]; nextCursor: string | null } {
  const offset = decodeCursor(options.cursor);
  const end = Math.min(values.length, offset + options.pageSize);
  return {
    values: values.slice(offset, end),
    nextCursor: end < values.length ? `local:${end}` : null,
  };
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = /^local:(\d+)$/.exec(cursor);
  if (!match) throw new Error(`Invalid Local storage cursor: ${cursor}`);
  return Number(match[1]);
}

function finiteTimestamp(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function notFoundError(path: string): NodeJS.ErrnoException {
  const error = new Error(
    `Local storage path not found: ${path}`,
  ) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
