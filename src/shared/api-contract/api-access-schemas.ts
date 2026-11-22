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

/** A GitHub member, or an owner-issued service token. */
export const apiAccessMemberSchema = z.discriminatedUnion('kind', [
  apiAccessUserSchema.extend({ kind: z.literal('github') }),
  serviceMemberSchema,
]);

export const apiAccessUsersResponseSchema = z
  .object({
    owner: apiAccessUserSchema,
    users: z.array(apiAccessMemberSchema),
  })
  .strict();

export const grantApiAccessInputSchema = z
  .object({ username: z.string().trim().min(1) })
  .strict();

export const apiAccessUserIdSchema = z.string().min(1);

/** A hosted API's own bearer, returned only by the exchange and rotate. */
export const apiTokenResponseSchema = z
  .object({ token: z.string().startsWith('acapi_') })
  .strict();

/** The GitHub Apps whose user tokens a hosted API exchanges. */
export const githubAppsSchema = z
  .object({ githubAppIds: z.array(z.number().int().positive()) })
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
