import { z } from 'zod';
import { CLOUDFLARE_JURISDICTIONS, CloudType } from '../cloud.js';
import { booleanQueryValueSchema } from './common-schemas.js';

const requiredStringSchema = z.string().min(1);
export const credentialNameSchema = z.string().trim().min(1);

export const awsCredentialSchema = z
  .object({
    cloudProvider: z.literal(CloudType.AWS),
    accessKeyId: requiredStringSchema,
    secretAccessKey: requiredStringSchema,
    sessionToken: requiredStringSchema.optional(),
  })
  .strict();

export const gcpCredentialSchema = z
  .object({
    cloudProvider: z.literal(CloudType.GCP),
    projectId: requiredStringSchema,
    clientEmail: requiredStringSchema,
    privateKey: requiredStringSchema,
    billingExportDataset: requiredStringSchema.optional(),
  })
  .strict();

export const azureCredentialSchema = z
  .object({
    cloudProvider: z.literal(CloudType.Azure),
    applicationId: requiredStringSchema,
    secret: requiredStringSchema,
    subscriptionId: requiredStringSchema,
    directoryId: requiredStringSchema,
  })
  .strict();

export const lambdaCredentialSchema = z
  .object({
    cloudProvider: z.literal(CloudType.Lambda),
    apiKey: requiredStringSchema,
  })
  .strict();

const cloudflareCredentialSchema = z
  .object({
    cloudProvider: z.literal(CloudType.Cloudflare),
    accountId: requiredStringSchema,
    apiToken: requiredStringSchema,
    jurisdiction: z.enum(CLOUDFLARE_JURISDICTIONS).optional(),
  })
  .strict();

export const cloudCredentialSchema = z.discriminatedUnion('cloudProvider', [
  awsCredentialSchema,
  gcpCredentialSchema,
  azureCredentialSchema,
  lambdaCredentialSchema,
  cloudflareCredentialSchema,
]);

/*
 * A role connection (RFC 0047 amendments 8 and 9) saves no secret: a
 * self-hosted API exchanges its own ServiceAccount token for each session.
 * Saved only, never inline, so `cloudCredentialSchema` stays key-only.
 */
const awsRoleConnectionRequestSchema = z
  .object({
    cloudProvider: z.literal(CloudType.AWS),
    kind: z.literal('role'),
    // STS is called in the aws partition only.
    roleArn: z.string().regex(/^arn:aws:iam::\d{12}:role\/.+$/, {
      message:
        'Expected an IAM role ARN in the aws partition: arn:aws:iam::<account>:role/<name>',
    }),
  })
  .strict();

const gcpRoleConnectionRequestSchema = z
  .object({
    cloudProvider: z.literal(CloudType.GCP),
    kind: z.literal('role'),
    workloadIdentityProvider: z
      .string()
      .regex(
        /^projects\/\d+\/locations\/global\/workloadIdentityPools\/[^/]+\/providers\/[^/]+$/,
      ),
    // A user-managed account, whose domain names its project.
    serviceAccountEmail: z
      .string()
      .regex(/^[^@]+@[a-z][a-z0-9-]+\.iam\.gserviceaccount\.com$/),
  })
  .strict();

const azureRoleConnectionRequestSchema = z
  .object({
    cloudProvider: z.literal(CloudType.Azure),
    kind: z.literal('role'),
    applicationId: requiredStringSchema,
    directoryId: requiredStringSchema,
    subscriptionId: requiredStringSchema,
  })
  .strict();

const roleConnectionRequestSchema = z.discriminatedUnion('cloudProvider', [
  awsRoleConnectionRequestSchema,
  gcpRoleConnectionRequestSchema,
  azureRoleConnectionRequestSchema,
]);

/** What the cloud trusts, recorded as data (RFC 0047 § Trust conditions). */
const roleConnectionTrust = {
  issuer: requiredStringSchema,
  audience: requiredStringSchema,
  subject: requiredStringSchema,
};

const roleConnectionSchema = z.discriminatedUnion('cloudProvider', [
  awsRoleConnectionRequestSchema.extend(roleConnectionTrust),
  gcpRoleConnectionRequestSchema.extend(roleConnectionTrust),
  azureRoleConnectionRequestSchema.extend(roleConnectionTrust),
]);

const savedCredentialSchema = z.union([
  cloudCredentialSchema,
  roleConnectionSchema,
]);

/** A stored credential: a key, or a role connection. */
export function parseSavedCredential(value: unknown): SavedCredential {
  return savedCredentialSchema.parse(value);
}

/** A key, or a role connection to check. */
export const saveCredentialBodySchema = z.union([
  cloudCredentialSchema,
  roleConnectionRequestSchema,
]);

export const saveCredentialRequestSchema = z
  .object({
    params: z.object({ name: credentialNameSchema }).strict(),
    query: z
      .object({
        overwrite: booleanQueryValueSchema.optional().prefault('true'),
      })
      .strict(),
    body: saveCredentialBodySchema,
  })
  // Matches the CLI: a session credential expires, and minting the
  // bucket-scoped tokens VMs sync with needs a long-term IAM user key.
  .refine(({ body }) => !('sessionToken' in body && body.sessionToken), {
    message:
      'Temporary AWS session credentials cannot be saved because they expire. Use a long-lived IAM user access key.',
    path: ['body', 'sessionToken'],
  })
  .transform(({ params, query, body }) => ({
    ...params,
    ...query,
    ...body,
  }));

/**
 * The fields `credentials edit` can change. The server merges them into the
 * stored credential, so its secrets never leave the API.
 */
export const credentialUpdateSchema = z
  .object({
    ...awsCredentialSchema.shape,
    ...gcpCredentialSchema.shape,
    ...azureCredentialSchema.shape,
    ...lambdaCredentialSchema.shape,
    ...cloudflareCredentialSchema.shape,
  })
  .omit({
    cloudProvider: true,
    sessionToken: true,
    billingExportDataset: true,
    accountId: true,
  })
  .partial()
  .strict();

export const updateCredentialRequestSchema = z
  .object({
    params: z.object({ name: credentialNameSchema }).strict(),
    body: credentialUpdateSchema,
  })
  .transform(({ params, body }) => ({ name: params.name, fields: body }));

const authFailureMarker = {
  authFailedAt: z.number().int().nonnegative().optional(),
};

/** Present only on a role connection. */
const roleMarker = { kind: z.literal('role').optional() };

export const redactedCredentialSchema = z.discriminatedUnion('cloudProvider', [
  z
    .object({
      name: credentialNameSchema,
      cloudProvider: z.literal(CloudType.AWS),
      accessKeyId: requiredStringSchema.optional(),
      ...roleMarker,
      roleArn: requiredStringSchema.optional(),
      ...authFailureMarker,
    })
    .strict(),
  z
    .object({
      name: credentialNameSchema,
      cloudProvider: z.literal(CloudType.GCP),
      projectId: requiredStringSchema.optional(),
      clientEmail: requiredStringSchema.optional(),
      ...roleMarker,
      workloadIdentityProvider: requiredStringSchema.optional(),
      serviceAccountEmail: requiredStringSchema.optional(),
      ...authFailureMarker,
    })
    .strict(),
  z
    .object({
      name: credentialNameSchema,
      cloudProvider: z.literal(CloudType.Azure),
      subscriptionId: requiredStringSchema.optional(),
      applicationId: requiredStringSchema.optional(),
      ...roleMarker,
      directoryId: requiredStringSchema.optional(),
      ...authFailureMarker,
    })
    .strict(),
  z
    .object({
      name: credentialNameSchema,
      cloudProvider: z.literal(CloudType.Lambda),
      ...authFailureMarker,
    })
    .strict(),
  z
    .object({
      name: credentialNameSchema,
      cloudProvider: z.literal(CloudType.Cloudflare),
      accountId: requiredStringSchema.optional(),
      jurisdiction: z.enum(CLOUDFLARE_JURISDICTIONS).optional(),
      ...authFailureMarker,
    })
    .strict(),
]);

export const credentialListSchema = z.array(redactedCredentialSchema);

export const credentialErrorDataSchema = z
  .object({ name: credentialNameSchema })
  .strict();

export const credentialsExistDataSchema = z
  .object({ name: credentialNameSchema, existingName: credentialNameSchema })
  .strict();

export const credentialInUseDataSchema = z
  .object({
    name: credentialNameSchema,
    workloadIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type CloudCredential = z.output<typeof cloudCredentialSchema>;
export type RoleConnectionRequest = z.output<
  typeof roleConnectionRequestSchema
>;
export type RoleConnection = z.output<typeof roleConnectionSchema>;
export type SavedCredential = z.output<typeof savedCredentialSchema>;
export type SaveCredentialInput = z.output<typeof saveCredentialRequestSchema>;
export type RedactedCredential = z.output<typeof redactedCredentialSchema>;
export type CredentialUpdate = z.output<typeof credentialUpdateSchema>;
export type UpdateCredentialInput = z.output<
  typeof updateCredentialRequestSchema
>;
