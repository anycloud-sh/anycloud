import { z } from 'zod';
import {
  bucketObjectQueryParametersSchema,
  bucketPathParametersSchema,
} from './bucket-metadata-schemas.js';
import { workloadPathParametersSchema } from './workload-management-schemas.js';

const nativeExecRequestSchema = z
  .object({
    params: workloadPathParametersSchema,
    body: z.object({ command: z.string().min(1) }).strict(),
  })
  .strict();

const nativeLogsRequestSchema = z
  .object({
    params: workloadPathParametersSchema,
    query: z
      .object({
        follow: z
          .enum(['true', 'false'])
          .transform((value) => value === 'true')
          .optional(),
      })
      .strict(),
  })
  .strict();

const nativeBucketObjectRequestSchema = z
  .object({
    params: bucketPathParametersSchema,
    query: bucketObjectQueryParametersSchema,
  })
  .strict();

export const nativeRouteInventory = {
  exec: {
    method: 'POST',
    expressPath: '/workloads/:id/exec',
    path: '/workloads/{id}/exec',
    requestSchema: nativeExecRequestSchema,
    successStatus: 200,
    transport: 'ndjson',
  },
  logs: {
    method: 'GET',
    expressPath: '/workloads/:id/logs',
    path: '/workloads/{id}/logs',
    requestSchema: nativeLogsRequestSchema,
    successStatus: 200,
    transport: 'ndjson',
  },
  uploadBucketObject: {
    method: 'PUT',
    expressPath:
      '/credentials/:credentialName/buckets/:bucketName/object-content',
    path: '/credentials/{credentialName}/buckets/{bucketName}/object-content',
    requestSchema: nativeBucketObjectRequestSchema,
    successStatus: 204,
    transport: 'bytes',
  },
  downloadBucketObject: {
    method: 'GET',
    expressPath:
      '/credentials/:credentialName/buckets/:bucketName/object-content',
    path: '/credentials/{credentialName}/buckets/{bucketName}/object-content',
    requestSchema: nativeBucketObjectRequestSchema,
    successStatus: 200,
    transport: 'bytes',
  },
} as const;

export const diagnosticRouteInventory = {
  health: {
    method: 'GET',
    expressPath: '/health',
    path: '/health',
    successStatus: 200,
    transport: 'text',
  },
  version: {
    method: 'GET',
    expressPath: '/v1/version',
    path: '/version',
    successStatus: 200,
    transport: 'json',
  },
} as const;

export type NativeBucketObjectRequest = z.output<
  typeof nativeBucketObjectRequestSchema
>;

export interface ExecRequest {
  id: string;
  command: string;
}

export type ExecStreamEvent =
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'error'; error: string }
  | { type: 'heartbeat' };

export interface LogsRequest {
  id: string;
  follow?: boolean;
}

/**
 * The logs target is not running yet: no live VM, or no workload container on
 * one. `logs --follow` waits and retries on this code; every other logs error
 * is final.
 */
export const LOGS_CONTAINER_NOT_READY = 'LOGS_CONTAINER_NOT_READY';
