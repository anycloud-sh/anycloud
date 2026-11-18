import { authenticatedEndpoints } from './base.js';
import { noContentSchema } from './common-schemas.js';
import {
  bucketObjectRequestSchema,
  bucketRequestSchema,
  bucketEntryPageSchema,
  bucketItemSchema,
  bucketListPageSchema,
  listBucketObjectsRequestSchema,
  listBucketsRequestSchema,
} from './bucket-metadata-schemas.js';
import {
  mintStorageTokensRequestSchema,
  storageTokensResponseSchema,
} from './storage-token-schemas.js';

const authenticated = authenticatedEndpoints({}, 'Buckets');

// Bucket metadata calls can include provider control-plane discovery and SDK
// retries. Keep one budget for the whole JSON family so no caller silently
// falls back to the generic API deadline.
export const BUCKET_CONTROL_PLANE_TIMEOUT_MS = 60_000;
const bucketControlPlanePolicy = {
  timeoutMs: BUCKET_CONTROL_PLANE_TIMEOUT_MS,
};

const bucketRequestErrors = {
  BUCKET_REQUEST_INVALID: {
    status: 400,
    message: 'Invalid bucket request',
  },
  BUCKET_CREDENTIAL_NOT_READY: {
    status: 503,
    message: 'Cloud credential permissions are still propagating',
  },
  BUCKET_ACCESS_DENIED: {
    status: 403,
    message: 'The cloud provider denied this credential the bucket action',
  },
  BUCKET_THROTTLED: {
    status: 503,
    message: 'The cloud provider throttled the bucket action',
  },
};

const bucketErrors = {
  ...bucketRequestErrors,
  BUCKET_NOT_FOUND: {
    status: 404,
    message: 'Bucket not found',
  },
};

const list = authenticated
  .query(
    {
      method: 'GET',
      path: '/credentials/{credentialName}/buckets',
      operationId: 'listBuckets',
      summary: 'List buckets',
      inputStructure: 'detailed',
    },
    bucketControlPlanePolicy,
  )
  .input(listBucketsRequestSchema)
  .output(bucketListPageSchema)
  .errors(bucketRequestErrors);

const objects = authenticated
  .query(
    {
      method: 'GET',
      path: '/credentials/{credentialName}/buckets/{bucketName}/objects',
      operationId: 'listBucketObjects',
      summary: 'List bucket objects',
      inputStructure: 'detailed',
    },
    bucketControlPlanePolicy,
  )
  .input(listBucketObjectsRequestSchema)
  .output(bucketEntryPageSchema)
  .errors(bucketErrors);

const create = authenticated
  .command(
    {
      method: 'PUT',
      path: '/credentials/{credentialName}/buckets/{bucketName}',
      operationId: 'createBucket',
      summary: 'Create a bucket',
      inputStructure: 'detailed',
      successStatus: 204,
    },
    bucketControlPlanePolicy,
  )
  .input(bucketRequestSchema)
  .output(noContentSchema)
  .errors(bucketRequestErrors);

const remove = authenticated
  .command(
    {
      method: 'DELETE',
      path: '/credentials/{credentialName}/buckets/{bucketName}',
      operationId: 'deleteBucket',
      summary: 'Delete a bucket',
      inputStructure: 'detailed',
      successStatus: 204,
    },
    bucketControlPlanePolicy,
  )
  .input(bucketRequestSchema)
  .output(noContentSchema)
  .errors(bucketRequestErrors);

// A read, not a HEAD probe: a bodiless response would strip the declared
// not-found error, leaving a client unable to tell absence from failure.
const exists = authenticated
  .query(
    {
      method: 'GET',
      path: '/credentials/{credentialName}/buckets/{bucketName}',
      operationId: 'bucketExists',
      summary: 'Check whether a bucket exists',
      inputStructure: 'detailed',
    },
    bucketControlPlanePolicy,
  )
  .input(bucketRequestSchema)
  .output(bucketItemSchema)
  .errors(bucketErrors);

const deleteObject = authenticated
  .command(
    {
      method: 'DELETE',
      path: '/credentials/{credentialName}/buckets/{bucketName}/objects',
      operationId: 'deleteBucketObject',
      summary: 'Delete a bucket object',
      inputStructure: 'detailed',
      successStatus: 204,
    },
    bucketControlPlanePolicy,
  )
  .input(bucketObjectRequestSchema)
  .output(noContentSchema)
  .errors(bucketRequestErrors);

// Minting has no cloud side effect, so a retry only mints again.
const storageTokens = authenticated
  .command(
    {
      method: 'POST',
      path: '/credentials/{credentialName}/storage-tokens',
      operationId: 'mintStorageTokens',
      summary: 'Mint short-lived storage tokens scoped to bucket prefixes',
      inputStructure: 'detailed',
    },
    { ...bucketControlPlanePolicy, replay: 'safe' },
  )
  .input(mintStorageTokensRequestSchema)
  .output(storageTokensResponseSchema)
  .errors({
    BUCKET_CREDENTIAL_NOT_READY:
      bucketRequestErrors.BUCKET_CREDENTIAL_NOT_READY,
    BUCKET_ACCESS_DENIED: bucketRequestErrors.BUCKET_ACCESS_DENIED,
    BUCKET_THROTTLED: bucketRequestErrors.BUCKET_THROTTLED,
    STORAGE_TOKEN_REQUEST_INVALID: {
      status: 400,
      message: 'Invalid storage token request',
    },
    STORAGE_TOKEN_FORBIDDEN: {
      status: 403,
      message: 'The caller may not mint this storage token',
    },
    STORAGE_TOKEN_UNSUPPORTED: {
      status: 400,
      message: 'This credential cannot mint scoped storage tokens',
    },
  });

export const bucketMetadataContract = {
  list,
  objects,
  create,
  delete: remove,
  exists,
  deleteObject,
  storageTokens,
};
