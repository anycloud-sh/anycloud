import { z } from 'zod';

// Common wire primitives only. Family-specific names, identifiers, and
// semantic constraints stay in their own schema modules.
export const noInputSchema = z.object({}).strict().optional();
export const noContentSchema = z.void();

export const messageResponseSchema = z
  .object({ message: z.string().min(1) })
  .strict();

export const booleanQueryValueSchema = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');
