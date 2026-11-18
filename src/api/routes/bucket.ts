import { createWriteStream } from 'fs';
import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { finished, pipeline } from 'stream/promises';
import { Router, type Request, type Response } from 'express';
import { type CloudConfig } from '../../shared/cloud.js';
import {
  nativeRouteInventory,
  type NativeBucketObjectRequest,
} from '../../shared/api-contract/native-schemas.js';
import { sendError } from '../middleware/error-handler.js';
import {
  parseNativeRequest,
  sendNativeApiError,
} from '../middleware/native-validation.js';
import {
  createStorageProvider,
  resolveCredentialByName,
} from '../services/cloud-config.js';
import {
  BucketCredentialNotReadyError,
  throughBucketStorage,
} from '../services/bucket-storage-operation.js';
import type { CloudUploadSource } from '../services/gateways/cloud.js';
import {
  BucketAccessDeniedError,
  BucketNotFoundError,
  BucketThrottledError,
  type DeployError,
  ObjectNotFoundError,
} from '../../shared/errors.js';
import type { ApiRequestTracker } from '../services/http-shutdown.js';

type ObjectParams = NativeBucketObjectRequest['params'] &
  NativeBucketObjectRequest['query'];

async function storageForObject(params: ObjectParams) {
  const resolved = await resolveCredentialByName(params.credentialName);
  if (!resolved) {
    return {
      ok: false,
      error: `Credential "${params.credentialName}" not found`,
    } as const;
  }
  const cloudConfig: CloudConfig = {
    cloudProvider: resolved.cloudProvider,
    credentials: resolved.creds,
    region: params.region,
  };
  return { ok: true, storage: createStorageProvider(cloudConfig) } as const;
}

async function spoolRequestBody(
  req: Request,
): Promise<{ source: CloudUploadSource; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'anycloud-upload-'));
  const path = join(dir, 'body');
  try {
    await pipeline(req, createWriteStream(path));
    const { size } = await stat(path);
    return {
      source: { kind: 'file', path, contentLength: size },
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

function declaredBucketCode(error: unknown): string | undefined {
  if (error instanceof BucketNotFoundError) return 'BUCKET_NOT_FOUND';
  if (error instanceof ObjectNotFoundError) return 'OBJECT_NOT_FOUND';
  if (error instanceof BucketAccessDeniedError) return 'BUCKET_ACCESS_DENIED';
  if (error instanceof BucketThrottledError) return 'BUCKET_THROTTLED';
  return undefined;
}

function sendBucketOperationError(res: Response, error: unknown): void {
  if (error instanceof BucketCredentialNotReadyError) {
    if (!res.headersSent) {
      sendNativeApiError(
        res,
        503,
        'BUCKET_CREDENTIAL_NOT_READY',
        error.message,
      );
    }
    return;
  }
  // A missing target, a denial and throttling are the caller's to act on:
  // declared, and logged no louder than WARN.
  const code = declaredBucketCode(error);
  if (code) {
    // Every declared bucket error is a DeployError.
    const { statusCode, message } = error as DeployError;
    if (res.headersSent) return;
    if (error instanceof BucketThrottledError) {
      res.setHeader('Retry-After', String(error.retryAfterSeconds));
    }
    sendNativeApiError(res, statusCode, code, message);
    return;
  }
  sendError(res, error, { code: 'BUCKET_OPERATION_FAILED' });
}

/** Native binary-transfer routes; bucket metadata is handled by oRPC. */
export function createBucketRouter(requests: ApiRequestTracker): Router {
  const router = Router();

  router.put(nativeRouteInventory.uploadBucketObject.expressPath, (req, res) =>
    requests.track('native.upload', async () => {
      try {
        const input = parseNativeRequest(
          nativeRouteInventory.uploadBucketObject.requestSchema,
          { params: req.params, query: req.query },
          res,
          'BUCKET_REQUEST_INVALID',
        );
        if (!input) return;
        const parsed = { ...input.params, ...input.query };
        const resolved = await storageForObject(parsed);
        if (!resolved.ok) {
          sendNativeApiError(res, 404, 'CREDENTIAL_NOT_FOUND', resolved.error);
          return;
        }
        const upload = await spoolRequestBody(req);
        try {
          await throughBucketStorage(
            resolved.storage,
            { ...parsed, action: 'upload to' },
            undefined,
            () =>
              resolved.storage.uploadObject(
                parsed.bucketName,
                parsed.remotePath,
                upload.source,
              ),
          );
        } finally {
          await upload.cleanup();
        }
        res.status(nativeRouteInventory.uploadBucketObject.successStatus).end();
      } catch (error) {
        sendBucketOperationError(res, error);
      }
    }),
  );

  router.get(
    nativeRouteInventory.downloadBucketObject.expressPath,
    (req, res) =>
      requests.track('native.download', async () => {
        try {
          const input = parseNativeRequest(
            nativeRouteInventory.downloadBucketObject.requestSchema,
            { params: req.params, query: req.query },
            res,
            'BUCKET_REQUEST_INVALID',
          );
          if (!input) return;
          const parsed = { ...input.params, ...input.query };
          const resolved = await storageForObject(parsed);
          if (!resolved.ok) {
            sendNativeApiError(
              res,
              404,
              'CREDENTIAL_NOT_FOUND',
              resolved.error,
            );
            return;
          }
          const { stream, contentLength } = await throughBucketStorage(
            resolved.storage,
            { ...parsed, action: 'download' },
            undefined,
            () =>
              resolved.storage.downloadObject(
                parsed.bucketName,
                parsed.remotePath,
              ),
          );
          res.status(nativeRouteInventory.downloadBucketObject.successStatus);
          res.setHeader('Content-Type', 'application/octet-stream');
          if (contentLength !== undefined) {
            res.setHeader('Content-Length', String(contentLength));
            res.setHeader('X-Anycloud-Object-Size', String(contentLength));
          }
          const closeDownload = () => stream.destroy();
          res.once('close', closeDownload);
          try {
            const completion = finished(stream, { cleanup: true });
            if (res.destroyed) stream.destroy();
            else stream.pipe(res);
            await completion;
          } finally {
            res.off('close', closeDownload);
          }
        } catch (error) {
          if (res.destroyed) return;
          if (res.headersSent) {
            res.destroy(error instanceof Error ? error : undefined);
          } else sendBucketOperationError(res, error);
        }
      }),
  );

  return router;
}
