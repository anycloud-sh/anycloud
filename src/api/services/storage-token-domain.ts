import {
  storageTokensResponseSchema,
  type MintStorageTokensQuery,
  type StorageTokensResponse,
} from '../../shared/api-contract/storage-token-schemas.js';
import {
  CloudType,
  type CloudConfig,
  type CloudCredentials,
} from '../../shared/cloud.js';
import { validateBucketName } from '../../shared/cloud-config.js';
import { BucketAccessDeniedError, DeployError } from '../../shared/errors.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import { PermissionDeniedError } from '../../shared/permission-denied.js';
import { throughBucketStorage } from './bucket-storage-operation.js';
import type { User } from './entities.js';
import {
  canMintScopedStorageToken,
  ScopedStoragePolicyTooLargeError,
  type CloudStorage,
  type ScopedStorageToken,
} from './gateways/cloud.js';

export class StorageTokenRequestInvalidError extends Error {
  name = 'StorageTokenRequestInvalidError';
}

export class StorageTokenForbiddenError extends Error {
  name = 'StorageTokenForbiddenError';
}

export class StorageTokenUnsupportedError extends Error {
  name = 'StorageTokenUnsupportedError';
}

export interface StorageTokenDependencies {
  resolveCredential(name: string): Promise<{
    cloudProvider: CloudType;
    creds: CloudCredentials;
  } | null>;
  createStorage(config: CloudConfig): CloudStorage;
  isApiBackupBucket(bucket: string, cloud: CloudType): boolean;
  /** One structured line per request; never a credential. */
  audit(line: Record<string, unknown>): void;
}

/**
 * One minter call per token: a SAS covers one container or directory, so
 * Azure mints one per grant; AWS and GCP put every grant in one token.
 */
function grantGroups(cloud: CloudType, count: number): number[][] {
  const indexes = [...Array(count).keys()];
  // cloudtype-boundary-ok: the minter's own limit (ScopedStorageTokenMinter).
  return cloud === CloudType.Azure ? indexes.map((i) => [i]) : [indexes];
}

/** The minter's failures as the endpoint declares them. */
function mintFailure(credentialName: string, error: unknown): unknown {
  if (error instanceof ScopedStoragePolicyTooLargeError)
    return new StorageTokenRequestInvalidError(error.message);
  if (error instanceof PermissionDeniedError)
    return new BucketAccessDeniedError(
      `Access denied: credential "${credentialName}" cannot mint a storage token (${error.message}).`,
      error,
    );
  // The minter's own refusal: STS refused it, or GCP's STS API is off.
  if (error instanceof DeployError && error.statusCode === 400)
    return new BucketAccessDeniedError(error.message, error);
  return error;
}

async function mint(
  storage: CloudStorage,
  query: MintStorageTokensQuery,
  signal: AbortSignal | undefined,
): Promise<{ grants: number[]; token: ScopedStorageToken }[]> {
  if (!canMintScopedStorageToken(storage))
    throw new StorageTokenUnsupportedError(
      `${storage.type} credentials cannot mint scoped storage tokens.`,
    );
  const tokens = [];
  for (const group of grantGroups(storage.type, query.grants.length)) {
    const grants = group.map((i) => {
      const { bucket, prefix, mode, noDelete } = query.grants[i]!;
      return {
        bucket,
        mode,
        ...(prefix && { prefix }),
        ...(noDelete && { noDelete: true as const }),
      };
    });
    const token = await throughBucketStorage(
      storage,
      {
        credentialName: query.credentialName,
        action: 'mint a storage token for',
      },
      signal,
      () =>
        storage.mintScopedStorageToken(grants, {
          lifetimeMs: query.lifetimeSeconds * 1000,
        }),
    ).catch((error: unknown) => {
      throw mintFailure(query.credentialName, error);
    });
    tokens.push({ grants: group, token: token! });
  }
  return tokens;
}

/**
 * Mint short-lived tokens for prefixes of a saved credential's buckets,
 * with the minter VM storage uses. Every admitted principal is a peer and
 * mints any grant; the backup bucket is refused before any cloud call, and every
 * request that passes validation leaves one audit line.
 */
export async function mintStorageTokens(
  actor: User,
  query: MintStorageTokensQuery,
  dependencies: StorageTokenDependencies,
  signal?: AbortSignal,
): Promise<StorageTokensResponse> {
  const audit = {
    principal: actor.id,
    credentialName: query.credentialName,
    grants: query.grants,
    lifetimeSeconds: query.lifetimeSeconds,
  };
  try {
    signal?.throwIfAborted();
    const resolved = await dependencies.resolveCredential(query.credentialName);
    if (!resolved)
      throw new StorageTokenRequestInvalidError(
        `Credential "${query.credentialName}" not found`,
      );
    const cloud = resolved.cloudProvider;
    // cloudtype-boundary-ok: the backends whose minter honors a prefix; R2
    // ignores it until CF3, and Local and Lambda have no token endpoint.
    if (![CloudType.AWS, CloudType.GCP, CloudType.Azure].includes(cloud))
      throw new StorageTokenUnsupportedError(
        `${cloud} storage has no prefix-scoped tokens; use an AWS, GCP or Azure credential.`,
      );
    if ('sessionToken' in resolved.creds && resolved.creds.sessionToken)
      throw new StorageTokenUnsupportedError(
        'An AWS key with a session token cannot mint: STS needs a long-term IAM user key or a role connection.',
      );
    for (const { bucket } of query.grants) {
      try {
        validateBucketName(cloud, bucket);
      } catch (error) {
        throw new StorageTokenRequestInvalidError(errorMessage(error));
      }
      if (dependencies.isApiBackupBucket(bucket, cloud))
        throw new StorageTokenForbiddenError(
          `Bucket "${bucket}" is this API's own backup bucket.`,
        );
    }
    const storage = dependencies.createStorage({
      cloudProvider: cloud,
      credentials: resolved.creds,
      region: query.region,
    });
    const minted = await mint(storage, query, signal);
    // cloudtype-boundary-ok: the endpoint each cloud's SDK sends a token to.
    const response = storageTokensResponseSchema.parse({
      cloud,
      ...(cloud === CloudType.AWS && { region: storage.region }),
      ...(cloud === CloudType.Azure && {
        accountUrl: `https://${storage.storageAccountName}.blob.core.windows.net`,
      }),
      tokens: minted.map(({ grants, token }) => {
        const { cloudProvider: _, ...credentials } = token.credentials;
        return { grants, expiresAt: token.expiresAt, credentials };
      }),
    });
    dependencies.audit({
      ...audit,
      outcome: 'minted',
      tokens: minted.map(({ grants, token }) => ({
        grants,
        expiresAt: token.expiresAt,
      })),
    });
    return response;
  } catch (error) {
    dependencies.audit({
      ...audit,
      outcome: 'refused',
      reason: errorMessage(error),
    });
    throw error;
  }
}
