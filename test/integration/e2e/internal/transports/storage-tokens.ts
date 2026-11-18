import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { BlobServiceClient } from '@azure/storage-blob';
import { Storage } from '@google-cloud/storage';
import { ORPCError } from '@orpc/client';
import { OAuth2Client } from 'google-auth-library';

import { CloudType } from '../../../../../src/shared/cloud.js';
import type { StorageTokensResponse } from '../../../../../src/shared/api-contract/storage-token-schemas.js';
import { createApiClient } from '../../../../../src/shared/services/api-client/rpc.js';
import { completedCommand } from '../api-assertions.js';
import type { ApiClient } from '../api.js';
import type { ArtifactStore } from '../artifacts.js';
import type { CleanupStack } from '../cleanup.js';
import { cliArgs } from '../cli-surface.js';
import type { CliClient } from '../cli.js';
import {
  SEEDED,
  type MintOutcome,
  type StorageTokenGrant,
  type StorageTokensPort,
  type StorageTokenTarget,
  type TokenAttempt,
} from '../contracts/storage-tokens.js';
import type { FixtureFiles } from '../files.js';
import type { ProviderProfiles } from '../profiles.js';

/** The storage regions the bucket-sync members use. */
const REGION: Record<StorageTokenTarget, string> = {
  aws: 'us-east-1',
  azure: 'eastus',
  gcp: 'us-central1',
};
const PREFIXES = ['read-a/', 'read-b/', 'out/', 'rw/', 'rw-x/'];

/** One minted token as a cloud SDK client; the secrets never leave here. */
interface TokenClient {
  read(bucket: string, key: string): Promise<Buffer>;
  write(bucket: string, key: string, body: Buffer): Promise<void>;
  list(bucket: string, prefix: string): Promise<string[]>;
  remove(bucket: string, key: string): Promise<void>;
}

const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

/** Deterministic bytes for a key, so a read-back proves the exact write. */
function body(key: string, bytes: number): Buffer {
  const seed = createHash('sha256').update(key).digest();
  return Buffer.alloc(bytes, seed);
}

async function streamBytes(
  stream: AsyncIterable<Uint8Array> | undefined,
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream ?? []) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function clients(response: StorageTokensResponse): TokenClient[] {
  if (response.cloud === CloudType.AWS)
    return response.tokens.map(({ credentials }) => {
      const s3 = new S3Client({
        region: response.region,
        credentials,
        followRegionRedirects: true,
      });
      return {
        read: async (Bucket, Key) =>
          streamBytes(
            (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body as
              | AsyncIterable<Uint8Array>
              | undefined,
          ),
        write: async (Bucket, Key, Body) => {
          await new Upload({
            client: s3,
            params: { Bucket, Key, Body },
          }).done();
        },
        list: async (Bucket, Prefix) =>
          (
            (await s3.send(new ListObjectsV2Command({ Bucket, Prefix })))
              .Contents ?? []
          ).map(({ Key }) => Key ?? ''),
        remove: async (Bucket, Key) => {
          await s3.send(new DeleteObjectCommand({ Bucket, Key }));
        },
      };
    });
  if (response.cloud === CloudType.GCP)
    return response.tokens.map(({ credentials }) => {
      const authClient = new OAuth2Client();
      authClient.setCredentials({ access_token: credentials.accessToken });
      const storage = new Storage({ authClient, projectId: 'unused' });
      const file = (bucket: string, key: string) =>
        storage.bucket(bucket).file(key);
      return {
        read: async (bucket, key) => (await file(bucket, key).download())[0],
        // A resumable upload in 8 MiB chunks: several requests, like a part.
        write: (bucket, key, bytes) =>
          file(bucket, key).save(bytes, {
            resumable: true,
            chunkSize: 8 * 1024 * 1024,
          }),
        list: async (bucket, prefix) =>
          (await storage.bucket(bucket).getFiles({ prefix }))[0].map(
            (f) => f.name,
          ),
        remove: async (bucket, key) => {
          await file(bucket, key).delete();
        },
      };
    });
  return response.tokens.map(({ credentials }) => {
    const service = new BlobServiceClient(
      `${response.accountUrl}?${credentials.sasToken}`,
    );
    const blob = (bucket: string, key: string) =>
      service.getContainerClient(bucket).getBlockBlobClient(key);
    return {
      read: (bucket, key) => blob(bucket, key).downloadToBuffer(),
      write: async (bucket, key, bytes) => {
        await blob(bucket, key).uploadData(bytes, {
          blockSize: 4 * 1024 * 1024,
        });
      },
      list: async (bucket, prefix) => {
        const names: string[] = [];
        for await (const item of service
          .getContainerClient(bucket)
          .listBlobsFlat({ prefix }))
          names.push(item.name);
        return names;
      },
      remove: async (bucket, key) => {
        await blob(bucket, key).delete();
      },
    };
  });
}

/**
 * A cloud's refusal: 401 or 403, or STS's 400 for an expired session. Any
 * other answer, a 404 included, is not one. S3 names an expired session only
 * in `Code`, and a GCS resumable upload's error carries its status as
 * `status` with no numeric `code`.
 */
function refusal(error: unknown): string | undefined {
  const failure = error as {
    $metadata?: { httpStatusCode?: number };
    Code?: string;
    name?: string;
    code?: unknown;
    status?: number;
    statusCode?: number;
  };
  const status =
    failure.$metadata?.httpStatusCode ??
    failure.statusCode ??
    failure.status ??
    (typeof failure.code === 'number' ? failure.code : undefined);
  if (status === 401 || status === 403) return `${status} ${failure.name}`;
  if (status === 400 && (failure.Code ?? failure.name) === 'ExpiredToken')
    return '400 ExpiredToken';
  return undefined;
}

/**
 * A mint's tokens as the cloud's own SDK clients. An attempt is allowed
 * when any token allows it, and refused only when every one refuses.
 */
export class MintedTokens {
  readonly #tokens: TokenClient[];

  constructor(response: StorageTokensResponse) {
    this.#tokens = clients(response);
  }

  async #attempt(
    run: (client: TokenClient) => Promise<string>,
  ): Promise<TokenAttempt> {
    const refusals: string[] = [];
    for (const client of this.#tokens) {
      try {
        return { allowed: true, digest: await run(client) };
      } catch (error) {
        const refused = refusal(error);
        if (!refused) throw error;
        refusals.push(refused);
      }
    }
    return { allowed: false, refusal: refusals.join('; ') };
  }

  read(bucket: string, key: string) {
    return this.#attempt(async (c) => digest(await c.read(bucket, key)));
  }

  write(bucket: string, key: string, bytes: number) {
    const bytesOf = body(key, bytes);
    return this.#attempt(async (c) => {
      await c.write(bucket, key, bytesOf);
      return digest(bytesOf);
    });
  }

  list(bucket: string, prefix: string) {
    return this.#attempt(async (c) =>
      (await c.list(bucket, prefix)).sort().join(','),
    );
  }

  remove(bucket: string, key: string) {
    return this.#attempt(async (c) => {
      await c.remove(bucket, key);
      return 'removed';
    });
  }
}

interface Dependencies {
  readonly api: Pick<
    ApiClient,
    'saveCredential' | 'deleteCredential' | 'controller'
  >;
  readonly bearer: (url: string) => string;
  readonly cli: Pick<CliClient, 'run'>;
  readonly cleanup: Pick<CleanupStack, 'defer'>;
  readonly files: Pick<FixtureFiles, 'directory' | 'text'>;
  readonly profiles: Pick<ProviderProfiles, 'vm'>;
  readonly artifacts: Pick<ArtifactStore, 'json'>;
  readonly runId: string;
}

/** The `storage-tokens` family's cloud: the CI credential on the harness's API. */
export class StorageTokensTransport implements StorageTokensPort {
  readonly #d: Dependencies;
  #scope = { credentials: '', region: '' };
  #buckets: string[] = [];
  #tokens: MintedTokens | undefined;

  constructor(dependencies: Dependencies) {
    this.#d = dependencies;
  }

  async #cli(args: string[], label: string): Promise<void> {
    completedCommand(await this.#d.cli.run(args), label);
  }

  async prepare(target: StorageTokenTarget) {
    const { api, cleanup, files, profiles, runId } = this.#d;
    const owner = profiles.vm(target);
    this.#scope = { credentials: owner.credentialName, region: REGION[target] };
    cleanup.defer(`storage-tokens-credential-${owner.credentialName}`, () =>
      api.deleteCredential(owner.credentialName, Date.now() + 120_000),
    );
    await api.saveCredential(owner.credentialName, owner.credential);
    const bucket = `anycloud-tok-${runId}`;
    const other = `anycloud-tok2-${runId}`;
    this.#buckets = [bucket, other];
    for (const name of this.#buckets) {
      await this.#cli(
        cliArgs('bucket create', this.#scope, [name]),
        'bucket create',
      );
      // A create whose reply was lost is left to the post-run storage sweep.
      cleanup.defer(`storage-tokens-bucket-${name}`, () => this.#delete(name));
    }
    for (const [name, key] of [
      ...SEEDED.map((key) => [bucket, key] as const),
      [other, 'read-a/ref.txt'] as const,
    ])
      await this.#cli(
        cliArgs('bucket upload', this.#scope, [
          name,
          await files.text(`storage-tokens/${name}/${key}`, `${runId} ${key}`),
          key,
        ]),
        'bucket upload',
      );
    return { bucket, other };
  }

  async #delete(name: string): Promise<void> {
    for (const prefix of PREFIXES)
      await this.#d.cli.run(
        cliArgs('bucket rm', { ...this.#scope, recursive: true, yes: true }, [
          name,
          prefix,
        ]),
      );
    await this.#cli(
      cliArgs('bucket delete', this.#scope, [name]),
      'bucket delete',
    );
  }

  #client() {
    const { api, bearer } = this.#d;
    return createApiClient(bearer(api.controller.url), {
      apiUrl: api.controller.url,
    });
  }

  async mint(
    grants: readonly StorageTokenGrant[],
    lifetimeSeconds: number,
  ): Promise<MintOutcome> {
    try {
      const response = await this.#client().bucket.storageTokens({
        params: { credentialName: this.#scope.credentials },
        query: { region: this.#scope.region },
        body: {
          lifetimeSeconds,
          grants: grants.map((grant) => ({ ...grant, noDelete: true })),
        },
      });
      this.#tokens = new MintedTokens(response);
      return {
        status: 200,
        tokens: response.tokens.map(({ grants, expiresAt }) => ({
          grants,
          expiresAt,
        })),
      };
    } catch (error) {
      if (!(error instanceof ORPCError)) throw error;
      return { status: error.status, code: String(error.code) };
    }
  }

  #minted(): MintedTokens {
    if (!this.#tokens) throw new Error('No storage tokens were minted');
    return this.#tokens;
  }

  read(bucket: string, key: string) {
    return this.#minted().read(bucket, key);
  }

  write(bucket: string, key: string, bytes: number) {
    return this.#minted().write(bucket, key, bytes);
  }

  list(bucket: string, prefix: string) {
    return this.#minted().list(bucket, prefix);
  }

  remove(bucket: string, key: string) {
    return this.#minted().remove(bucket, key);
  }

  async ownerDigest(bucket: string, key: string): Promise<string> {
    const directory = await this.#d.files.directory(
      `storage-tokens-download/${bucket}`,
    );
    const local = path.join(directory, key.replaceAll('/', '_'));
    const result = await this.#d.cli.run(
      cliArgs('bucket download', this.#scope, [bucket, key, local]),
    );
    if (result.exitCode !== 0) return 'absent';
    return digest(await readFile(local));
  }

  async dispose(): Promise<boolean> {
    for (const name of this.#buckets) await this.#delete(name);
    const exists = await Promise.all(
      this.#buckets.map((name) =>
        this.#client()
          .bucket.exists({
            params: {
              credentialName: this.#scope.credentials,
              bucketName: name,
            },
            query: { region: this.#scope.region },
          })
          .then(
            () => true,
            (error: unknown) => {
              if (
                error instanceof ORPCError &&
                error.code === 'BUCKET_NOT_FOUND'
              )
                return false;
              throw error;
            },
          ),
      ),
    );
    return exists.every((present) => !present);
  }

  async record(name: string, value: unknown): Promise<void> {
    await this.#d.artifacts.json(name, value);
  }
}
