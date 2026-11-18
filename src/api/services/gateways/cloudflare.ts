import { createHash } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { BucketListPage } from '../../../shared/api-contract/bucket-metadata-schemas.js';
import {
  CloudType,
  type CloudflareCreds,
  type CloudflareJurisdiction,
} from '../../../shared/cloud.js';
import type { ResolvedCloudConfig } from '../../../shared/cloud-config.js';
import {
  CLOUDFLARE_API,
  verifyCloudflareToken,
} from '../../../shared/cloudflare-token.js';
import { InvalidAnycloudConfigError } from '../../../shared/errors.js';
import { log } from '../logger.js';
import { createR2S3Client } from '../provider-clients/cloudflare.js';
import {
  createCloudStorage,
  type CloudListPageOptions,
  type CloudStorage,
  type StorageFailure,
} from './cloud.js';
import {
  classifyS3Failure,
  downloadS3Object,
  isS3NotFound,
  listS3ObjectPage,
  uploadS3Object,
} from './r2-objects.js';

const REST_TIMEOUT_MS = 30_000;
// 36 h; R2 allows up to 7 days. RFC 0047 amendment 10's 12 h is AWS's alone.
const SCOPED_TOKEN_TTL_SECONDS = 129_600;
// R2 has one region; the jurisdiction picks the endpoint instead.
const R2_REGION = 'auto';

/** The account's S3 endpoint for a jurisdiction. */
function r2Endpoint(
  accountId: string,
  jurisdiction: CloudflareJurisdiction = 'default',
): string {
  const host =
    jurisdiction === 'default'
      ? 'r2.cloudflarestorage.com'
      : `${jurisdiction}.r2.cloudflarestorage.com`;
  return `https://${accountId}.${host}`;
}

/** A failed call to Cloudflare's REST API, by HTTP status and API codes. */
class CloudflareApiError extends Error {
  constructor(
    readonly status: number,
    readonly codes: number[],
    message: string,
  ) {
    super(message);
    this.name = 'CloudflareApiError';
  }
}

function classifyR2Failure(error: unknown): StorageFailure | undefined {
  if (!(error instanceof CloudflareApiError)) return classifyS3Failure(error);
  const code = `HTTP ${error.status}`;
  if (error.status === 401 || error.status === 403) {
    return { kind: 'denied', code };
  }
  if (error.status === 429) return { kind: 'throttled', code };
  return undefined;
}

function isR2NotFound(error: unknown): boolean {
  return error instanceof CloudflareApiError
    ? error.status === 404
    : isS3NotFound(error);
}

/**
 * Cloudflare R2. Objects go through the S3 API with keys derived from the API
 * token (the token ID and the SHA-256 of the token). Buckets go through the
 * REST API, which takes the jurisdiction and pages bucket listings.
 */
export function createCloudflareStorage(
  config: ResolvedCloudConfig,
): CloudStorage {
  const credentials = config.credentials as CloudflareCreds;
  if (config.region && config.region !== R2_REGION) {
    throw new InvalidAnycloudConfigError(
      `R2 has no regions (got "${config.region}"). The Cloudflare credential's jurisdiction picks the endpoint, so omit the region.`,
    );
  }
  const jurisdiction = credentials.jurisdiction ?? 'default';
  const bucketsPath = `/accounts/${encodeURIComponent(credentials.accountId)}/r2/buckets`;

  const endpoint = r2Endpoint(credentials.accountId, jurisdiction);
  // The SDK memoizes this provider per client, retrying after a failure.
  const s3 = createR2S3Client(
    async () => ({
      accessKeyId: (await verifyCloudflareToken(credentials)).id,
      secretAccessKey: createHash('sha256')
        .update(credentials.apiToken)
        .digest('hex'),
    }),
    endpoint,
  );

  // R2 serves no TLS certificate for an account that doesn't exist, so a
  // mistyped account ID fails the handshake on every S3 call.
  s3.middlewareStack.add(
    (next) => async (args) => {
      try {
        return await next(args);
      } catch (error) {
        if ((error as { code?: string } | null)?.code === 'EPROTO') {
          throw Object.assign(
            new InvalidAnycloudConfigError(
              `The TLS handshake with R2 for account ${credentials.accountId} failed, which usually means the account ID is wrong. Check the credential's account ID.`,
            ),
            { cause: error },
          );
        }
        throw error;
      }
    },
    { step: 'finalizeRequest', name: 'r2UnknownAccount' },
  );

  async function rest<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ result?: T; result_info?: { cursor?: string } }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credentials.apiToken}`,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (jurisdiction !== 'default')
      headers['cf-r2-jurisdiction'] = jurisdiction;
    const response = await fetch(`${CLOUDFLARE_API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(REST_TIMEOUT_MS)])
        : AbortSignal.timeout(REST_TIMEOUT_MS),
    });
    const parsed = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      errors?: Array<{ code: number; message: string }>;
      result?: T;
      result_info?: { cursor?: string };
    };
    if (!response.ok || !parsed.success) {
      const errors = parsed.errors ?? [];
      throw new CloudflareApiError(
        response.status,
        errors.map((e) => e.code),
        `Cloudflare ${method} ${path} failed with HTTP ${response.status}${errors.length ? `: ${errors.map((e) => e.message).join('; ')}` : ''}`,
      );
    }
    return parsed;
  }

  /** A refusal names the account, since a mistyped ID is the usual cause. */
  async function mintRequest<T>(method: string, path: string, body: unknown) {
    try {
      return await rest<T>(method, path, body);
    } catch (error) {
      if (
        error instanceof CloudflareApiError &&
        [401, 403, 404].includes(error.status)
      ) {
        throw new InvalidAnycloudConfigError(
          `Cloudflare refused R2 temporary credentials for account ${credentials.accountId} (HTTP ${error.status}). Check the credential's account ID, and that its API token has account-level R2 read and write.`,
        );
      }
      throw error;
    }
  }

  async function hasBucket(bucketName: string): Promise<boolean> {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
      return true;
    } catch (error) {
      if (isS3NotFound(error)) return false;
      throw error;
    }
  }

  async function emptyBucket(bucketName: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucketName,
          ContinuationToken: cursor,
        }),
      );
      const objects = (page.Contents ?? []).flatMap((o) =>
        o.Key ? [{ Key: o.Key }] : [],
      );
      if (objects.length) {
        const deleted = await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: { Objects: objects },
          }),
        );
        if (deleted.Errors?.length) {
          throw new Error(
            `Failed to delete ${deleted.Errors.length} objects from R2 bucket ${bucketName}: ${deleted.Errors[0]?.Code ?? 'unknown error'}`,
          );
        }
      }
      cursor = page.NextContinuationToken;
    } while (cursor);
    // An unfinished multipart upload keeps the bucket from being deleted.
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    do {
      const uploads = await s3.send(
        new ListMultipartUploadsCommand({
          Bucket: bucketName,
          KeyMarker: keyMarker,
          UploadIdMarker: uploadIdMarker,
        }),
      );
      for (const upload of uploads.Uploads ?? []) {
        await s3.send(
          new AbortMultipartUploadCommand({
            Bucket: bucketName,
            Key: upload.Key,
            UploadId: upload.UploadId,
          }),
        );
      }
      keyMarker = uploads.IsTruncated ? uploads.NextKeyMarker : undefined;
      uploadIdMarker = uploads.IsTruncated
        ? uploads.NextUploadIdMarker
        : undefined;
    } while (keyMarker || uploadIdMarker);
  }

  return createCloudStorage({
    type: CloudType.Cloudflare,
    region: R2_REGION,
    s3Endpoint: endpoint,
    // The credential schema already requires the account and token; whether
    // the token may mint shows only when Cloudflare is asked.
    validateScopedStorageTokenSource: () => undefined,
    mintScopedStorageToken: async (grants) => {
      if (grants.length === 0) return undefined;
      const buckets = new Set(grants.map((grant) => grant.bucket));
      if (buckets.size !== 1) {
        throw new Error(
          `R2 temporary credentials cover one bucket; got ${buckets.size}`,
        );
      }
      const readwrite = grants.some((grant) => grant.mode === 'readwrite');
      // The response carries no expiry, so count from the request.
      const requestedAt = Date.now();
      const { result } = await mintRequest<{
        accessKeyId?: string;
        secretAccessKey?: string;
        sessionToken?: string;
      }>(
        'POST',
        `/accounts/${encodeURIComponent(credentials.accountId)}/r2/temp-access-credentials`,
        {
          bucket: grants[0]!.bucket,
          parentAccessKeyId: (await verifyCloudflareToken(credentials)).id,
          permission: readwrite ? 'object-read-write' : 'object-read-only',
          ttlSeconds: SCOPED_TOKEN_TTL_SECONDS,
        },
      );
      if (
        !result?.accessKeyId ||
        !result.secretAccessKey ||
        !result.sessionToken
      ) {
        throw new Error(
          'R2 returned temporary credentials without a session token',
        );
      }
      return {
        // S3 session credentials, which rclone reads from the AWS_* variables.
        credentials: {
          cloudProvider: CloudType.AWS,
          accessKeyId: result.accessKeyId,
          secretAccessKey: result.secretAccessKey,
          sessionToken: result.sessionToken,
        },
        expiresAt: requestedAt + SCOPED_TOKEN_TTL_SECONDS * 1000,
      };
    },
    rawHasBucket: hasBucket,
    // R2 has no bucket tags; a bucket's owner is its account.
    rawUpsertBucketUncoordinated: async (bucketName) => {
      if (await hasBucket(bucketName)) return;
      try {
        await rest('POST', bucketsPath, { name: bucketName });
        log.info(`Created R2 bucket ${bucketName} (${jurisdiction})`);
      } catch (error) {
        // Bucket names are per account, so a conflict is usually our own
        // concurrent upsert. Confirm it, in case the name is taken in another
        // jurisdiction, where this endpoint can't reach it.
        if (
          error instanceof CloudflareApiError &&
          error.status === 409 &&
          (await hasBucket(bucketName))
        ) {
          return;
        }
        throw error;
      }
    },
    // A missing bucket fails the first listing with NoSuchBucket, which the
    // shared delete treats as already done.
    rawDeleteBucket: async (bucketName) => {
      await emptyBucket(bucketName);
      await rest('DELETE', `${bucketsPath}/${encodeURIComponent(bucketName)}`);
      log.info(`Deleted R2 bucket ${bucketName} (${jurisdiction})`);
    },
    rawDeleteObject: async (bucketName, remotePath) => {
      await s3.send(
        new DeleteObjectCommand({ Bucket: bucketName, Key: remotePath }),
      );
    },
    rawUploadObject: ({ bucketName, remotePath, source }) =>
      uploadS3Object(s3, bucketName, remotePath, source),
    rawDownloadObject: (bucketName, remotePath) =>
      downloadS3Object(s3, bucketName, remotePath),
    rawListBuckets: async (
      options: CloudListPageOptions,
      signal?: AbortSignal,
    ): Promise<BucketListPage> => {
      const query = new URLSearchParams({ per_page: String(options.pageSize) });
      if (options.cursor) query.set('cursor', options.cursor);
      const page = await rest<{
        buckets?: Array<{ name: string; creation_date?: string }>;
      }>('GET', `${bucketsPath}?${query}`, undefined, signal);
      return {
        buckets: (page.result?.buckets ?? []).map((bucket) => ({
          name: bucket.name,
          region: jurisdiction,
          createdAt: bucket.creation_date
            ? Date.parse(bucket.creation_date)
            : null,
        })),
        nextCursor: page.result_info?.cursor || null,
      };
    },
    rawListObjects: (bucketName, options, signal) =>
      listS3ObjectPage(s3, bucketName, options, signal),
    isNotFound: isR2NotFound,
    classifyStorageFailure: async (error) => classifyR2Failure(error),
  });
}
