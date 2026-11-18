import {
  BucketAccessDeniedError,
  BucketThrottledError,
  DeployError,
} from '../../shared/errors.js';
import type {
  CloudStorage,
  CloudStorageOperationOptions,
} from './gateways/cloud.js';
import type { CloudType } from '../../shared/cloud.js';
import {
  retryAfterMs,
  type RetryAfterHeaders,
} from '../../shared/retry-after.js';
import { getApiBackupConfig } from '../config.js';
import { log } from './logger.js';

export class BucketCredentialNotReadyError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'BucketCredentialNotReadyError';
    this.cause = cause;
  }
}

/** The bucket action a user asked for, named in a denied or throttled error. */
export interface BucketStorageRequest {
  credentialName: string;
  /** Reads as "cannot <action> <bucket>/<key>", e.g. "upload to". */
  action: string;
  bucketName?: string;
  remotePath?: string;
}

/**
 * Whether a bucket is this API's own backup bucket, which holds its cipher key
 * and database, so no caller may reach it. Matched by cloud and name only: an
 * S3 access-point ARN or alias that resolves to the same bucket is not
 * recognized.
 */
export function isApiBackupBucket(
  bucket: string | undefined,
  cloudProvider: CloudType,
): boolean {
  const backup = getApiBackupConfig();
  return (
    backup !== undefined &&
    bucket === backup.bucket &&
    cloudProvider === backup.cloudProvider
  );
}

export async function throughBucketStorage<T>(
  storage: CloudStorage,
  request: BucketStorageRequest,
  signal: AbortSignal | undefined,
  operation: (options: CloudStorageOperationOptions) => Promise<T>,
): Promise<T> {
  if (isApiBackupBucket(request.bucketName, storage.type))
    throw new BucketAccessDeniedError(
      `Bucket "${request.bucketName}" is this API's own backup bucket and cannot be used through the bucket API.`,
      undefined,
    );
  try {
    return await operation({ signal });
  } catch (error) {
    throw await bucketStorageError(storage, request, error);
  }
}

async function bucketStorageError(
  storage: CloudStorage,
  request: BucketStorageRequest,
  error: unknown,
): Promise<unknown> {
  // The gateway already reported a missing bucket or object.
  if (error instanceof DeployError) return error;
  const { credentialName, action, bucketName, remotePath } = request;
  const failure = await storage
    .classifyStorageFailure?.(error, bucketName, remotePath)
    .catch(() => undefined);
  const subject = [action, [bucketName, remotePath].filter(Boolean).join('/')]
    .filter(Boolean)
    .join(' ');
  // The provider's raw message and request ID stay in the server log: they
  // can name IAM principals and accounts.
  if (failure?.kind === 'denied') {
    const message = `Access denied: credential "${credentialName}" cannot ${subject} (${storage.type} ${failure.code}). Check the credential and its ${storage.type} permissions.`;
    log.warn(message, { code: 'BUCKET_ACCESS_DENIED', error });
    return new BucketAccessDeniedError(message, error);
  }
  if (failure?.kind === 'throttled') {
    const message = `${storage.type} throttled credential "${credentialName}" trying to ${subject} (${failure.code}). Retry shortly.`;
    log.warn(message, { code: 'BUCKET_THROTTLED', error });
    return new BucketThrottledError(
      message,
      error,
      throttledRetryAfterSeconds(error, Date.now()),
    );
  }
  if (storage.isCredentialNotReady?.(error)) {
    return new BucketCredentialNotReadyError(
      `Cloud permissions for credential "${credentialName}" may still be propagating. Retry shortly; if this continues, verify its cloud roles.`,
      error,
    );
  }
  return error;
}

/** The `Retry-After` a throttled call answers: the provider's hint, bounded. */
const THROTTLED_RETRY_AFTER_SECONDS = { fallback: 1, min: 1, max: 30 };

/**
 * The AWS SDK keeps its raw response on `$response`; Azure's RestError and
 * GCS's ApiError and GaxiosError keep theirs on `response`.
 */
function throttledRetryAfterSeconds(error: unknown, now: number): number {
  const { $response, response } = (error ?? {}) as {
    $response?: { headers?: RetryAfterHeaders };
    response?: { headers?: RetryAfterHeaders };
  };
  const hintMs = retryAfterMs(($response ?? response)?.headers, now);
  if (hintMs === undefined) return THROTTLED_RETRY_AFTER_SECONDS.fallback;
  const { min, max } = THROTTLED_RETRY_AFTER_SECONDS;
  return Math.min(max, Math.max(min, Math.ceil(hintMs / 1_000)));
}
