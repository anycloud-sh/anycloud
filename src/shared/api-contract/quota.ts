import { z } from 'zod';
import { authenticatedEndpoints } from './base.js';
import {
  quotaStatusQuerySchema,
  quotaStatusResponseSchema,
} from './quota-schemas.js';

const authenticated = authenticatedEndpoints({}, 'Quota');
const statusRequestSchema = z.object({ query: quotaStatusQuerySchema });

export function quotaStatusTimeoutMs(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const parsed = Number(environment.QUOTA_STATUS_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 120_000;
}

const status = authenticated
  .query(
    {
      method: 'GET',
      path: '/quota/status',
      operationId: 'getQuotaStatus',
      summary: 'List quota requests and current limits',
      inputStructure: 'detailed',
    },
    {
      replay: 'never',
      timeoutMs: quotaStatusTimeoutMs(),
      waitMsTimeout: { minimumMs: 5_000, graceMs: 2_000 },
    },
  )
  .input(statusRequestSchema)
  .output(quotaStatusResponseSchema)
  .errors({
    QUOTA_STATUS_INVALID: {
      status: 400,
      message: 'Invalid quota status request',
    },
  });

const canceled = authenticated
  .query(
    {
      method: 'GET',
      path: '/quota/canceled',
      operationId: 'getCanceledQuotaSubmissions',
      summary: 'List canceled local quota submissions',
    },
    { replay: 'never' },
  )
  .input(z.object({}).strict())
  .output(quotaStatusResponseSchema);

export const quotaContract = { status, canceled };
