import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import type { ArtifactStore } from './artifacts.js';
import type { CleanupRegistration, CleanupStack } from './cleanup.js';

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}
interface OwnedBucket {
  readonly name: string;
  readonly registration: CleanupRegistration;
  identity?: DirectoryIdentity;
  absent: boolean;
}

function absent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Local bucket authority is the original host/root plus exact directory identity. */
export class LocalJobStorage {
  readonly #root: string;
  readonly #host: string;
  readonly #cleanup: Pick<CleanupStack, 'defer'>;
  readonly #artifacts: Pick<ArtifactStore, 'json'>;
  readonly #childrenAbsent: () => void;
  readonly #buckets = new Map<string, OwnedBucket>();
  #clusterIdentity: DirectoryIdentity | undefined;

  constructor(dependencies: {
    readonly root: string;
    readonly host: string;
    readonly cleanup: Pick<CleanupStack, 'defer'>;
    readonly artifacts: Pick<ArtifactStore, 'json'>;
    readonly childrenAbsent: () => void;
  }) {
    this.#root = dependencies.root;
    this.#host = dependencies.host;
    this.#cleanup = dependencies.cleanup;
    this.#artifacts = dependencies.artifacts;
    this.#childrenAbsent = dependencies.childrenAbsent;
  }

  async create(name: string, seed?: string): Promise<void> {
    if (
      !/^j-(?:input|output|checkpoint)-[a-z0-9-]{1,48}$/u.test(name) ||
      this.#buckets.has(name)
    )
      throw new Error(
        'Local Job bucket name is outside its registered namespace',
      );
    await this.#assertRoot();
    const bucket: OwnedBucket = {
      name,
      absent: false,
      registration: this.#cleanup.defer(`Local Job bucket ${name}`, () =>
        this.#remove(name),
      ),
    };
    this.#buckets.set(name, bucket);
    await this.#artifacts.json(`job-bucket-${name}-intent`, {
      host: this.#host,
      root: this.#root,
      name,
    });
    try {
      // Deliberately non-recursive: an existing directory never becomes owned.
      await mkdir(path.join(this.#root, name));
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'EEXIST'
      ) {
        this.#buckets.delete(name);
        bucket.registration.complete();
      }
      throw error;
    }
    const identity = await lstat(path.join(this.#root, name));
    if (!identity.isDirectory() || identity.isSymbolicLink())
      throw new Error('Local Job bucket is not an owned directory');
    bucket.identity = { dev: identity.dev, ino: identity.ino };
    await chmod(path.join(this.#root, name), 0o777);
    if (name.startsWith('j-output-')) {
      await mkdir(path.join(this.#root, name, '.anycloud', 'logs'), {
        recursive: true,
      });
      await chmod(path.join(this.#root, name, '.anycloud', 'logs'), 0o777);
    }
    if (seed !== undefined) await this.write(name, 'seed.txt', seed);
  }

  async read(name: string, file: string): Promise<string | undefined> {
    await this.#assertBucket(name);
    const target = this.#file(name, file);
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error('Local Job object is not an ordinary file');
      return (await readFile(target, 'utf8')).trimEnd();
    } catch (error) {
      if (absent(error)) return undefined;
      throw error;
    }
  }

  async write(name: string, file: string, value: string): Promise<void> {
    await this.#assertBucket(name);
    await writeFile(this.#file(name, file), `${value}\n`, { flag: 'wx' });
  }

  async release(): Promise<void> {
    const failures: unknown[] = [];
    for (const name of this.#buckets.keys()) {
      try {
        await this.#remove(name);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Local Job storage cleanup failed');
  }

  async #remove(name: string): Promise<void> {
    const bucket = this.#buckets.get(name);
    if (!bucket || bucket.absent) return;
    this.#childrenAbsent();
    await this.#assertRoot();
    // A complete root inventory establishes absence; a delete acknowledgement
    // or an empty object list never does. Keep unknown identities registered.
    const before = await readdir(this.#root);
    if (before.includes(name)) {
      await this.#assertBucket(name);
      await rm(path.join(this.#root, name), { recursive: true, force: false });
    }
    const after = await readdir(this.#root);
    await this.#assertRoot();
    if (after.includes(name))
      throw new Error('Local Job bucket remains after deletion');
    await this.#artifacts.json(`job-bucket-${name}-absence`, {
      host: this.#host,
      root: this.#root,
      name,
      inventoryComplete: true,
      absent: true,
    });
    bucket.absent = true;
    bucket.registration.complete();
  }

  async #assertBucket(name: string): Promise<void> {
    await this.#assertRoot();
    const bucket = this.#buckets.get(name);
    if (!bucket?.identity || bucket.absent)
      throw new Error('Local Job bucket has no captured directory identity');
    const stat = await lstat(path.join(this.#root, name));
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== bucket.identity.dev ||
      stat.ino !== bucket.identity.ino
    )
      throw new Error(
        'Local Job bucket changed its original directory identity',
      );
  }

  async #assertRoot(): Promise<void> {
    if ((await realpath(this.#root)) !== this.#root)
      throw new Error('Local Job storage root is redirected');
    const stat = await lstat(this.#root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Local Job storage root is not a directory');
    const original = this.#clusterIdentity;
    if (original && (stat.dev !== original.dev || stat.ino !== original.ino))
      throw new Error('Local Job storage root changed identity');
    this.#clusterIdentity ??= { dev: stat.dev, ino: stat.ino };
  }

  #file(name: string, file: string): string {
    if (!/^[a-z0-9-]+\.txt$/u.test(file))
      throw new Error('Local Job object name is outside its fixture');
    return path.join(this.#root, name, file);
  }
}
