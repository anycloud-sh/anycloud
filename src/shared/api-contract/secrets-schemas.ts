import { z } from 'zod';

// One leading underscore marks a Secret `secrets list` hides without --all.
const SECRET_NAME_PATTERN =
  /^(?:_[a-zA-Z][a-zA-Z0-9_-]{0,62}|[a-zA-Z][a-zA-Z0-9_-]{0,63})$/;
const SECRET_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const secretNameSchema = z
  .string()
  .regex(
    SECRET_NAME_PATTERN,
    'must start with a letter, or one underscore and a letter, and contain only letters, numbers, underscores, or hyphens (at most 64 characters)',
  );

const secretValueSchema = z
  .string()
  .refine((value) => !/[\r\n\0]/.test(value), {
    message: 'must not contain newline, carriage return, or NUL bytes',
  });

const secretValuesSchema = z
  .record(
    z.string().regex(SECRET_KEY_PATTERN, {
      message:
        'must start with a letter or underscore and contain only letters, numbers, or underscores',
    }),
    secretValueSchema,
  )
  .refine((values) => Object.keys(values).length > 0, {
    message: 'must contain at least one value',
  });

const secretSummarySchema = z
  .object({
    name: secretNameSchema,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export const listSecretsResponseSchema = z.array(secretSummarySchema);

export const saveSecretBodySchema = z
  .object({ values: secretValuesSchema })
  .strict();

export const saveSecretRequestSchema = z
  .object({
    params: z.object({ name: secretNameSchema }).strict(),
    body: saveSecretBodySchema,
  })
  .transform(({ params, body }) => ({ ...params, ...body }));

export const secretInUseDataSchema = z
  .object({
    name: secretNameSchema,
    workloadIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type SecretSummary = z.output<typeof secretSummarySchema>;
export type SaveSecretInput = z.output<typeof saveSecretRequestSchema>;
