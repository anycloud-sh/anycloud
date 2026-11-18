import { z } from 'zod';
import { CloudType } from '../cloud.js';
import { credentialNameSchema } from './credentials-schemas.js';

const STORAGE_TOKEN_LIFETIME_SECONDS = {
  min: 60,
  max: 3_600,
  default: 900,
} as const;
/** A GCP access boundary holds at most 10 rules. */
const MAX_STORAGE_TOKEN_GRANTS = 10;
const MAX_PREFIX_BYTES = 1_024;

/**
 * `*`, `?` and `$` are wildcards or variables in an AWS policy, a quote or
 * backslash ends a GCP condition's string, and `%` and `#` read differently
 * once a client encodes a key into a URL.
 */
const PREFIX_FORBIDDEN = /[\p{Cc}\\*?$'"%#]/u;

/**
 * Why a storage prefix can't be granted, or undefined. `''` is the whole
 * bucket; anything else is relative path segments ending in `/`, so a
 * granted prefix never matches a sibling (`a/b/` never covers `a/bc/`).
 */
function storagePrefixProblem(prefix: string): string | undefined {
  if (prefix === '') return undefined;
  if (new TextEncoder().encode(prefix).length > MAX_PREFIX_BYTES)
    return `is over ${MAX_PREFIX_BYTES} bytes`;
  if (!prefix.endsWith('/')) return 'must end in "/"';
  if (PREFIX_FORBIDDEN.test(prefix))
    return 'has a control character or one of \\ * ? $ \' " % #';
  const segments = prefix.slice(0, -1).split('/');
  if (segments.some((segment) => ['', '.', '..'].includes(segment)))
    return 'has an empty, "." or ".." segment, or starts with "/"';
  return undefined;
}

const storagePrefixSchema = z.string().superRefine((prefix, ctx) => {
  const problem = storagePrefixProblem(prefix);
  if (problem) ctx.addIssue({ code: 'custom', message: `Prefix ${problem}` });
});

const storageGrantModeSchema = z.enum(['read', 'readwrite']);

const storageTokenGrantSchema = z
  .object({
    bucket: z.string().trim().min(1),
    prefix: storagePrefixSchema.default(''),
    mode: storageGrantModeSchema,
    /** AWS and Azure never delete; GCP deletes inside a readwrite prefix. */
    noDelete: z.boolean().default(true),
  })
  .strict();

export const mintStorageTokensBodySchema = z
  .object({
    lifetimeSeconds: z
      .number()
      .int()
      .min(STORAGE_TOKEN_LIFETIME_SECONDS.min)
      .max(STORAGE_TOKEN_LIFETIME_SECONDS.max)
      .default(STORAGE_TOKEN_LIFETIME_SECONDS.default),
    grants: z
      .array(storageTokenGrantSchema)
      .min(1)
      .max(MAX_STORAGE_TOKEN_GRANTS),
  })
  .strict();

export const mintStorageTokensRequestSchema = z.object({
  params: z.object({ credentialName: credentialNameSchema }).strict(),
  query: z.object({ region: z.string().trim().min(1).optional() }).strict(),
  body: mintStorageTokensBodySchema,
});

const secret = z.string().min(1);
/** Each token: indexes into the request's `grants`, and the cloud's own expiry. */
const tokensOf = <T extends z.ZodRawShape>(credentials: T) =>
  z.array(
    z
      .object({
        grants: z.array(z.number().int().nonnegative()).min(1),
        expiresAt: z.number().int().positive(),
        credentials: z.object(credentials).strict(),
      })
      .strict(),
  );

// cloudtype-boundary-ok: each cloud's SDK takes its own token and endpoint.
export const storageTokensResponseSchema = z.discriminatedUnion('cloud', [
  z
    .object({
      cloud: z.literal(CloudType.AWS),
      region: secret,
      tokens: tokensOf({
        accessKeyId: secret,
        secretAccessKey: secret,
        sessionToken: secret,
      }),
    })
    .strict(),
  z
    .object({
      cloud: z.literal(CloudType.GCP),
      tokens: tokensOf({ accessToken: secret }),
    })
    .strict(),
  // cloudtype-boundary-ok: as above.
  z
    .object({
      cloud: z.literal(CloudType.Azure),
      accountUrl: z.string().url(),
      tokens: tokensOf({ sasToken: secret }),
    })
    .strict(),
]);

type MintStorageTokensRequest = z.output<typeof mintStorageTokensRequestSchema>;
export type MintStorageTokensQuery = MintStorageTokensRequest['params'] &
  MintStorageTokensRequest['query'] &
  MintStorageTokensRequest['body'];
export type StorageTokensResponse = z.output<
  typeof storageTokensResponseSchema
>;
