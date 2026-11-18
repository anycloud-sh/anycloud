import { z } from 'zod';
import {
  dockerOptionsSchema,
  workloadIdSchema,
  workloadPathParametersSchema,
} from './workload-management-schemas.js';

const serviceUpgradeInputSchema = z
  .object({
    id: workloadIdSchema,
    image: z.string().min(1),
    command: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    binds: dockerOptionsSchema.shape.binds,
  })
  .strict();

export const serviceUpgradeBodySchema = serviceUpgradeInputSchema.omit({
  id: true,
});

export const serviceUpgradeRequestSchema = z.object({
  params: workloadPathParametersSchema,
  body: serviceUpgradeBodySchema,
});

export const serviceUpgradeResponseSchema = z
  .object({
    id: z.string().min(1),
    url: z.string().nullable(),
  })
  .strict();

export type ServiceUpgradeInput = z.output<typeof serviceUpgradeInputSchema>;
export type ServiceUpgradeResponse = z.output<
  typeof serviceUpgradeResponseSchema
>;
