import { z } from 'zod';

const apiAccessUserSchema = z
  .object({
    userId: z.string().regex(/^[1-9]\d*$/),
    username: z.string().min(1),
  })
  .strict();

/** An owner-issued service token's name, as its `service:<name>` ID holds it. */
export const serviceNameSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/,
    'A service name is 1-63 lowercase letters, digits and hyphens, starting and ending with a letter or digit',
  );

const serviceMemberSchema = z
  .object({
    kind: z.literal('service'),
    userId: z.string().startsWith('service:'),
    username: z.string().min(1),
  })
  .strict();

/**
 * A GitHub member, an owner-issued service token, or a Deployment name registered for its replicas'
 * ServiceAccount token (RFC 0049 C29), with the live Deployment that holds
 * the name, if any.
 */
export const apiAccessMemberSchema = z.discriminatedUnion('kind', [
  apiAccessUserSchema.extend({ kind: z.literal('github') }),
  serviceMemberSchema,
  z
    .object({
      kind: z.literal('serviceaccount'),
      userId: z.string().startsWith('serviceaccount:'),
      username: z.string().min(1),
      deploymentId: z.string().nullable(),
    })
    .strict(),
]);

export const apiAccessUsersResponseSchema = z
  .object({
    owner: apiAccessUserSchema,
    users: z.array(apiAccessMemberSchema),
  })
  .strict();

export const grantApiAccessInputSchema = z.union([
  z.object({ username: z.string().trim().min(1) }).strict(),
  // A Deployment name, as `CreateDeploymentInput` takes it.
  z.object({ serviceAccount: z.string().trim().min(1).max(64) }).strict(),
]);

export const apiAccessUserIdSchema = z.string().min(1);

/** A hosted API's own bearer, returned only by the exchange and rotate. */
export const apiTokenResponseSchema = z
  .object({ token: z.string().startsWith('acapi_') })
  .strict();

export const issueServiceTokenInputSchema = z
  .object({ name: serviceNameSchema })
  .strict();

/** The one response that carries a service's token. */
export const serviceTokenIssuedSchema = serviceMemberSchema
  .extend({ token: z.string().startsWith('acapi_') })
  .strict();

export type ApiAccessMember = z.output<typeof apiAccessMemberSchema>;
export type ApiAccessUsersResponse = z.output<
  typeof apiAccessUsersResponseSchema
>;
export type ServiceTokenIssued = z.output<typeof serviceTokenIssuedSchema>;
export type GrantApiAccessInput = z.output<typeof grantApiAccessInputSchema>;
