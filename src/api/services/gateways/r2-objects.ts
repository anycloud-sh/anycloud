import type { Readable } from 'node:stream';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { BucketEntryPage } from '../../../shared/api-contract/bucket-metadata-schemas.js';
import {
  openCloudUploadSource,
  type CloudDownload,
  type CloudObjectListOptions,
  type CloudUploadSource,
  type StorageFailure,
} from './cloud.js';

/** S3 object operations for Cloudflare R2, mirroring the AWS gateway's. */

function s3ErrorCode(error: unknown): string | undefined {
  const e = error as { Code?: string; code?: string; name?: string } | null;
  return e?.Code ?? e?.code ?? e?.name;
}

function isS3ErrorCode(error: unknown, code: string): boolean {
  const e = error as { Code?: string; code?: string; name?: string } | null;
  return (
    e?.name === code ||
    e?.name === `${code}Exception` ||
    e?.Code === code ||
    e?.code === code
  );
}

function s3Status(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } } | null)
    ?.$metadata?.httpStatusCode;
}

export function isS3NotFound(error: unknown): boolean {
  return (
    isS3ErrorCode(error, 'NoSuchBucket') ||
    (error as { name?: string } | null)?.name === 'NotFound' ||
    s3Status(error) === 404
  );
}

/**
 * From S3's status and error code only. A key S3 cannot confirm absent
 * without ListBucket is AccessDenied, so it reads as denied, not missing.
 */
export function classifyS3Failure(error: unknown): StorageFailure | undefined {
  const status = s3Status(error);
  const code = s3ErrorCode(error) ?? `HTTP ${status}`;
  if (isS3ErrorCode(error, 'NoSuchBucket')) {
    return { kind: 'bucket-missing', code };
  }
  if (isS3ErrorCode(error, 'NoSuchKey')) {
    return { kind: 'object-missing', code };
  }
  if (status === 403 || isS3ErrorCode(error, 'ExpiredToken')) {
    return { kind: 'denied', code };
  }
  if (status === 429 || isS3ErrorCode(error, 'SlowDown')) {
    return { kind: 'throttled', code };
  }
  return undefined;
}

export async function listS3ObjectPage(
  client: S3Client,
  bucketName: string,
  options: CloudObjectListOptions,
  signal?: AbortSignal,
): Promise<BucketEntryPage> {
  const response = await client.send(
    new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: options.prefix || undefined,
      Delimiter: options.recursive ? undefined : '/',
      MaxKeys: options.pageSize,
      ContinuationToken: options.cursor,
    }),
    { abortSignal: signal },
  );
  const entries: BucketEntryPage['entries'] = [];
  for (const prefix of response.CommonPrefixes ?? []) {
    if (prefix.Prefix) entries.push({ kind: 'prefix', key: prefix.Prefix });
  }
  for (const object of response.Contents ?? []) {
    if (!object.Key) continue;
    entries.push({
      kind: 'object',
      key: object.Key,
      sizeBytes: object.Size ?? null,
      lastModifiedAt: object.LastModified?.getTime() ?? null,
    });
  }
  // Entries stay in provider order here; the route sorts each page once.
  return { entries, nextCursor: response.NextContinuationToken ?? null };
}

export async function uploadS3Object(
  client: S3Client,
  bucketName: string,
  remotePath: string,
  source: CloudUploadSource,
): Promise<void> {
  // lib-storage's Upload reads from the stream and chooses single-PUT vs
  // multipart based on actual byte count, so a fixed ContentLength is
  // redundant and risks confusing the SDK on the multipart path.
  await new Upload({
    client,
    params: {
      Bucket: bucketName,
      Key: remotePath,
      Body: openCloudUploadSource(source),
    },
  }).done();
}

export async function downloadS3Object(
  client: S3Client,
  bucketName: string,
  remotePath: string,
): Promise<CloudDownload> {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucketName, Key: remotePath }),
  );
  if (!response.Body) {
    throw new Error(`Empty response body for s3://${bucketName}/${remotePath}`);
  }
  return {
    stream: response.Body as Readable,
    contentLength: response.ContentLength,
  };
}
