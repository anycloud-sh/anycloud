import { z } from 'zod';
import { credentialNameSchema } from './credentials-schemas.js';

const requiredPathValueSchema = z.string().trim().min(1);
const optionalRegionSchema = z.string().trim().min(1).optional();
const optionalCursorSchema = z.string().min(1).optional();
const optionalPrefixSchema = z.string().optional();
const objectKeySchema = z.string().min(1);

const bucketSummarySchema = z
  .object({
    name: z.string().min(1),
    region: z.string().nullable(),
    createdAt: z.number().nonnegative().nullable(),
  })
  .strict();

/**
 * The item read carries only the identity a provider existence probe can
 * confirm. Listing is the source of region and creation metadata; the point of
 * a body here is that a declared not-found error stays readable by a client.
 */
export const bucketItemSchema = z.object({ name: z.string().min(1) }).strict();

const bucketPrefixEntrySchema = z
  .object({ kind: z.literal('prefix'), key: z.string() })
  .strict();

const bucketObjectEntrySchema = z
  .object({
    kind: z.literal('object'),
    key: z.string(),
    sizeBytes: z.number().int().nonnegative().nullable(),
    lastModifiedAt: z.number().nonnegative().nullable(),
  })
  .strict();

const bucketEntrySchema = z.discriminatedUnion('kind', [
  bucketPrefixEntrySchema,
  bucketObjectEntrySchema,
]);

export const bucketListPageSchema = z
  .object({
    buckets: z.array(bucketSummarySchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const bucketEntryPageSchema = z
  .object({
    entries: z.array(bucketEntrySchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

const pageSizeQuerySchema = z
  .string()
  .regex(/^\d+$/, 'pageSize must be an integer between 1 and 1000')
  .transform(Number)
  .pipe(
    z
      .number()
      .int()
      .min(1, 'pageSize must be an integer between 1 and 1000')
      .max(1000, 'pageSize must be an integer between 1 and 1000'),
  );

const credentialPathSchema = z
  .object({ credentialName: credentialNameSchema })
  .strict();
export const bucketPathParametersSchema = z
  .object({
    credentialName: credentialNameSchema,
    bucketName: requiredPathValueSchema,
  })
  .strict();
const regionQuerySchema = z.object({ region: optionalRegionSchema }).strict();
export const bucketObjectQueryParametersSchema = z
  .object({
    region: optionalRegionSchema,
    remotePath: objectKeySchema,
  })
  .strict();

export const listBucketsRequestSchema = z.object({
  params: credentialPathSchema,
  query: z
    .object({
      region: optionalRegionSchema,
      pageSize: pageSizeQuerySchema.optional(),
      cursor: optionalCursorSchema,
    })
    .strict(),
});

export const listBucketObjectsRequestSchema = z.object({
  params: bucketPathParametersSchema,
  query: z
    .object({
      region: optionalRegionSchema,
      prefix: optionalPrefixSchema,
      recursive: z
        .enum(['true', 'false'], {
          error: 'recursive must be true or false',
        })
        .transform((value) => value === 'true')
        .optional(),
      pageSize: pageSizeQuerySchema.optional(),
      cursor: optionalCursorSchema,
    })
    .strict(),
});

export const bucketRequestSchema = z.object({
  params: bucketPathParametersSchema,
  query: regionQuerySchema,
});

export const bucketObjectRequestSchema = z.object({
  params: bucketPathParametersSchema,
  query: bucketObjectQueryParametersSchema,
});

type ListBucketsRequest = z.output<typeof listBucketsRequestSchema>;
type ListBucketObjectsRequest = z.output<typeof listBucketObjectsRequestSchema>;
type BucketRequest = z.output<typeof bucketRequestSchema>;
type BucketObjectRequest = z.output<typeof bucketObjectRequestSchema>;

export type ListBucketsQuery = ListBucketsRequest['params'] &
  ListBucketsRequest['query'];
export type ListBucketObjectsQuery = ListBucketObjectsRequest['params'] &
  ListBucketObjectsRequest['query'];
export type CreateBucketQuery = BucketRequest['params'] &
  BucketRequest['query'];
export type BucketBaseQuery = CreateBucketQuery;
export type BucketObjectQuery = BucketObjectRequest['params'] &
  BucketObjectRequest['query'];
export type BucketSummary = z.output<typeof bucketSummarySchema>;
export type BucketEntry = z.output<typeof bucketEntrySchema>;
export type BucketObjectEntry = z.output<typeof bucketObjectEntrySchema>;
export type BucketListPage = z.output<typeof bucketListPageSchema>;
export type BucketEntryPage = z.output<typeof bucketEntryPageSchema>;
