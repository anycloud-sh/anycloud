import { InvalidBucketRequestError } from '../services/bucket-metadata-domain.js';
import {
  StorageTokenForbiddenError,
  StorageTokenRequestInvalidError,
  StorageTokenUnsupportedError,
} from '../services/storage-token-domain.js';
import { BucketCredentialNotReadyError } from '../services/bucket-storage-operation.js';
import {
  BucketAccessDeniedError,
  BucketNotFoundError,
  BucketThrottledError,
} from '../../shared/errors.js';
import {
  declaredAs,
  declaredError,
  mapDeclaredErrors,
  type DeclaredErrorMapping,
} from './errors.js';
import { authenticatedImplementation as authenticated } from './base.js';

type DeclaredFactory = (options: { message: string; cause: Error }) => Error;

/** The cloud-side failures every bucket route, and minting, declares. */
function cloudFailures(
  context: { resHeaders?: Headers },
  errors: {
    BUCKET_CREDENTIAL_NOT_READY: DeclaredFactory;
    BUCKET_ACCESS_DENIED: DeclaredFactory;
    BUCKET_THROTTLED: DeclaredFactory;
  },
): DeclaredErrorMapping[] {
  return [
    declaredAs(
      BucketCredentialNotReadyError,
      errors.BUCKET_CREDENTIAL_NOT_READY,
    ),
    declaredAs(BucketAccessDeniedError, errors.BUCKET_ACCESS_DENIED),
    declaredError(BucketThrottledError, (error) => {
      context.resHeaders?.set('Retry-After', String(error.retryAfterSeconds));
      return errors.BUCKET_THROTTLED({ message: error.message, cause: error });
    }),
  ];
}

function bucketFailures(
  context: { resHeaders?: Headers },
  errors: Parameters<typeof cloudFailures>[1] & {
    BUCKET_REQUEST_INVALID: DeclaredFactory;
  },
): DeclaredErrorMapping[] {
  return [
    declaredAs(InvalidBucketRequestError, errors.BUCKET_REQUEST_INVALID),
    ...cloudFailures(context, errors),
  ];
}

export const bucketMetadataRouter = {
  storageTokens: authenticated.bucket.storageTokens.handler(
    ({ context, input, signal, errors }) =>
      mapDeclaredErrors(
        () =>
          context.domains.bucketMetadata.storageTokens(
            context.actor,
            { ...input.params, ...input.query, ...input.body },
            signal,
          ),
        [
          declaredAs(
            StorageTokenRequestInvalidError,
            errors.STORAGE_TOKEN_REQUEST_INVALID,
          ),
          declaredAs(
            StorageTokenForbiddenError,
            errors.STORAGE_TOKEN_FORBIDDEN,
          ),
          declaredAs(
            StorageTokenUnsupportedError,
            errors.STORAGE_TOKEN_UNSUPPORTED,
          ),
          ...cloudFailures(context, errors),
        ],
      ),
  ),
  list: authenticated.bucket.list.handler(
    ({ context, input, signal, errors }) =>
      mapDeclaredErrors(
        () =>
          context.domains.bucketMetadata.list(
            { ...input.params, ...input.query },
            signal,
          ),
        bucketFailures(context, errors),
      ),
  ),
  objects: authenticated.bucket.objects.handler(
    ({ context, input, signal, errors }) =>
      mapDeclaredErrors(
        () =>
          context.domains.bucketMetadata.objects(
            { ...input.params, ...input.query },
            signal,
          ),
        [
          ...bucketFailures(context, errors),
          declaredAs(BucketNotFoundError, errors.BUCKET_NOT_FOUND),
        ],
      ),
  ),
  create: authenticated.bucket.create.handler(
    async ({ context, input, signal, errors }) => {
      await mapDeclaredErrors(
        () =>
          context.domains.bucketMetadata.create(
            context.actor,
            { ...input.params, ...input.query },
            context.clientVersion,
            signal,
          ),
        bucketFailures(context, errors),
      );
    },
  ),
  delete: authenticated.bucket.delete.handler(
    async ({ context, input, signal, errors }) => {
      await mapDeclaredErrors(
        () =>
          context.domains.bucketMetadata.delete(
            { ...input.params, ...input.query },
            signal,
          ),
        bucketFailures(context, errors),
      );
    },
  ),
  exists: authenticated.bucket.exists.handler(
    async ({ context, input, signal, errors }) => {
      const result = await mapDeclaredErrors(
        () =>
          context.domains.bucketMetadata.exists(
            { ...input.params, ...input.query },
            signal,
          ),
        bucketFailures(context, errors),
      );
      if (!result.exists) {
        throw errors.BUCKET_NOT_FOUND({ message: 'Bucket not found' });
      }
      return { name: input.params.bucketName };
    },
  ),
  deleteObject: authenticated.bucket.deleteObject.handler(
    async ({ context, input, signal, errors }) => {
      await mapDeclaredErrors(
        () =>
          context.domains.bucketMetadata.deleteObject(
            { ...input.params, ...input.query },
            signal,
          ),
        bucketFailures(context, errors),
      );
    },
  ),
};
