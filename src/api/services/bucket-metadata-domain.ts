import type {
  BucketBaseQuery,
  BucketEntryPage,
  BucketListPage,
  BucketObjectQuery,
  CreateBucketQuery,
  ListBucketObjectsQuery,
  ListBucketsQuery,
} from '../../shared/api-contract/bucket-metadata-schemas.js';
import { supportsObjectStorage } from '../../shared/providers.js';
import type {
  CloudConfig,
  CloudCredentials,
  CloudType,
} from '../../shared/cloud.js';
import type {
  MintStorageTokensQuery,
  StorageTokensResponse,
} from '../../shared/api-contract/storage-token-schemas.js';
import type { User } from './entities.js';
import { mintStorageTokens } from './storage-token-domain.js';
import {
  canListBuckets,
  canListObjects,
  type CloudStorage,
} from './gateways/cloud.js';
import { throughBucketStorage } from './bucket-storage-operation.js';

export class InvalidBucketRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBucketRequestError';
  }
}

export interface BucketMetadataDomain {
  list(query: ListBucketsQuery, signal?: AbortSignal): Promise<BucketListPage>;
  objects(
    query: ListBucketObjectsQuery,
    signal?: AbortSignal,
  ): Promise<BucketEntryPage>;
  create(
    actor: User,
    query: CreateBucketQuery,
    clientVersion: string,
    signal?: AbortSignal,
  ): Promise<void>;
  delete(query: BucketBaseQuery, signal?: AbortSignal): Promise<void>;
  exists(
    query: BucketBaseQuery,
    signal?: AbortSignal,
  ): Promise<{ exists: boolean }>;
  deleteObject(query: BucketObjectQuery, signal?: AbortSignal): Promise<void>;
  storageTokens(
    actor: User,
    query: MintStorageTokensQuery,
    signal?: AbortSignal,
  ): Promise<StorageTokensResponse>;
}

export interface BucketMetadataDomainDependencies {
  resolveCredential(name: string): Promise<{
    id: string;
    cloudProvider: CloudType;
    creds: CloudCredentials;
  } | null>;
  createStorage(config: CloudConfig): CloudStorage;
  now(): number;
  isApiBackupBucket(bucket: string, cloud: CloudType): boolean;
  audit(line: Record<string, unknown>): void;
}

async function resolveStorage(
  query: BucketBaseQuery,
  dependencies: BucketMetadataDomainDependencies,
): Promise<CloudStorage> {
  const resolved = await dependencies.resolveCredential(query.credentialName);
  if (!resolved) {
    throw new InvalidBucketRequestError(
      `Credential "${query.credentialName}" not found`,
    );
  }
  return dependencies.createStorage({
    cloudProvider: resolved.cloudProvider,
    credentials: resolved.creds,
    region: query.region,
  });
}

async function resolveListStorage(
  query: {
    credentialName: string;
    region?: string;
  },
  dependencies: BucketMetadataDomainDependencies,
): Promise<CloudStorage> {
  const resolved = await dependencies.resolveCredential(query.credentialName);
  if (!resolved) {
    throw new InvalidBucketRequestError(
      `Credential "${query.credentialName}" not found`,
    );
  }
  if (!supportsObjectStorage(resolved.cloudProvider)) {
    throw new InvalidBucketRequestError(
      `${resolved.cloudProvider} credentials do not support bucket listing`,
    );
  }
  return dependencies.createStorage({
    cloudProvider: resolved.cloudProvider,
    credentials: resolved.creds,
    region: query.region,
  });
}

export function createBucketMetadataDomain(
  dependencies: BucketMetadataDomainDependencies,
): BucketMetadataDomain {
  return {
    async list(query, signal) {
      signal?.throwIfAborted();
      const storage = await resolveListStorage(query, dependencies);
      if (!canListBuckets(storage)) {
        throw new InvalidBucketRequestError(
          `${storage.type} does not support bucket listing`,
        );
      }
      const result = await throughBucketStorage(
        storage,
        { ...query, action: 'list buckets' },
        signal,
        (options) =>
          storage.listBuckets(
            {
              pageSize: query.pageSize ?? 1000,
              ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
            },
            options,
          ),
      );
      signal?.throwIfAborted();
      result.buckets.sort((left, right) => left.name.localeCompare(right.name));
      return result;
    },

    async objects(query, signal) {
      signal?.throwIfAborted();
      const storage = await resolveListStorage(query, dependencies);
      if (!canListObjects(storage)) {
        throw new InvalidBucketRequestError(
          `${storage.type} does not support object listing`,
        );
      }
      const result = await throughBucketStorage(
        storage,
        { ...query, action: 'list objects in' },
        signal,
        (options) =>
          storage.listObjects(
            query.bucketName,
            {
              prefix: query.prefix ?? '',
              recursive: query.recursive ?? false,
              pageSize: query.pageSize ?? 1000,
              ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
            },
            options,
          ),
      );
      signal?.throwIfAborted();
      result.entries.sort((left, right) => left.key.localeCompare(right.key));
      return result;
    },

    async create(actor, query, clientVersion, signal) {
      signal?.throwIfAborted();
      const storage = await resolveStorage(query, dependencies);
      const workloadId = `cli-${actor.username}-${dependencies.now()}`;
      await throughBucketStorage(
        storage,
        { ...query, action: 'create bucket' },
        signal,
        (options) =>
          storage.upsertBucket(
            query.bucketName,
            clientVersion,
            workloadId,
            actor.username,
            options,
          ),
      );
      signal?.throwIfAborted();
    },

    async delete(query, signal) {
      signal?.throwIfAborted();
      const storage = await resolveStorage(query, dependencies);
      await throughBucketStorage(
        storage,
        { ...query, action: 'delete bucket' },
        signal,
        (options) => storage.deleteBucket(query.bucketName, options),
      );
      signal?.throwIfAborted();
    },

    async exists(query, signal) {
      signal?.throwIfAborted();
      const storage = await resolveStorage(query, dependencies);
      const exists = await throughBucketStorage(
        storage,
        { ...query, action: 'check bucket' },
        signal,
        (options) => storage.hasBucket(query.bucketName, options),
      );
      signal?.throwIfAborted();
      return { exists };
    },

    async deleteObject(query, signal) {
      signal?.throwIfAborted();
      const storage = await resolveStorage(query, dependencies);
      await throughBucketStorage(
        storage,
        { ...query, action: 'delete' },
        signal,
        (options) =>
          storage.deleteObject(query.bucketName, query.remotePath, options),
      );
      signal?.throwIfAborted();
    },

    storageTokens: (actor, query, signal) =>
      mintStorageTokens(actor, query, dependencies, signal),
  };
}
