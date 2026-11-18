import { z } from 'zod';
import { CloudType } from '../cloud.js';
import type { QuotaRequestStatus } from '../quota.js';
import { credentialNameSchema } from './credentials-schemas.js';

const cloudTypeSchema = z.enum(CloudType);

const quotaStatusEntrySchema = z
  .object({
    kind: z.enum(['request', 'current', 'unavailable']).optional(),
    source: z.literal('local_operation').optional(),
    cloud: cloudTypeSchema,
    region: z.string(),
    resourceName: z.string(),
    resourceKey: z.string().optional(),
    status: z.string(),
    requestedLimit: z.number().optional(),
    requestId: z.string().optional(),
    requestedAt: z.string().optional(),
    url: z.string().optional(),
    currentLimit: z.number().optional(),
    previousLimit: z.number().optional(),
    grantedLimit: z.number().nullable().optional(),
    providerRequestId: z.string().optional(),
    providerCaseId: z.string().optional(),
    operationId: z.string().optional(),
    operationTargetId: z.string().optional(),
    vmType: z.string().optional(),
    spot: z.boolean().optional(),
    message: z.string().optional(),
  })
  .strict();

export const quotaStatusResponseSchema = z
  .object({ entries: z.array(quotaStatusEntrySchema) })
  .strict();

const waitMsSchema = z
  .string()
  .transform(Number)
  .pipe(z.number().positive())
  .transform((value) => Math.max(500, Math.min(120_000, Math.floor(value))));

export const quotaStatusQuerySchema = z
  .object({
    cloud: cloudTypeSchema,
    credentialName: credentialNameSchema,
    region: z.string().trim().min(1).optional(),
    waitMs: waitMsSchema.optional(),
  })
  .strict();

export interface QuotaRequestEntry {
  cloud: CloudType;
  region: string;
  resourceName: string;
  resourceKey?: string;
  previousLimit: number;
  requestedLimit: number;
  grantedLimit: number | null;
  status: QuotaRequestStatus;
  message?: string;
  optInAction?: 'enabled' | 'enabling' | 'already-enabled';
  requestId?: string;
  providerRequestId?: string;
  providerCaseId?: string;
  url?: string;
}

export type QuotaStatusEntry = z.output<typeof quotaStatusEntrySchema>;
export type QuotaStatusQuery = z.output<typeof quotaStatusQuerySchema>;
export type QuotaStatusResponse = z.output<typeof quotaStatusResponseSchema>;
