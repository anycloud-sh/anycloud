import type { RestError } from '@azure/core-rest-pipeline';
import type { CloudConfig } from '../../../shared/cloud.js';
import { retryAfterMs } from '../../../shared/retry-after.js';
import { providerHttpStatus } from '../gateways/cloud.js';

/** Provider billing APIs need compute identity, not workload configuration. */
export type VmCostIdentity = Pick<CloudConfig, 'cloudProvider' | 'credentials'>;

export type VmCostMap = Map<string, number>;

/** One tag shared by a batch of owner groups, one id per group. */
export interface VmCostResource {
  tag: 'anycloud_deployment' | 'anycloud_resource';
  ids: string[];
}

/** Whether a billing API rejected a query because its caller is throttled. */
export function isBillingThrottle(err: unknown): boolean {
  const { name, errors } = (err ?? {}) as {
    name?: unknown;
    errors?: { reason?: unknown }[];
  };
  return (
    providerHttpStatus(err) === 429 ||
    name === 'LimitExceededException' || // AWS Cost Explorer, HTTP 400
    !!errors?.some((e) => e.reason === 'rateLimitExceeded') // BigQuery, 403
  );
}

const COST_MANAGEMENT_RETRY_AFTER =
  /^x-ms-ratelimit-microsoft\.costmanagement-[a-z]+-retry-after$/;

/**
 * The longest wait, in ms, that Azure Cost Management named for a throttled
 * query. It names one per quota, never in `Retry-After`, so its SDK ignores
 * them. A zero or unreadable wait names none.
 */
export function costManagementRetryAfterMs(err: unknown): number | undefined {
  const { response } = (err ?? {}) as Partial<RestError>;
  const names = Object.keys(response?.headers?.toJSON?.() ?? {}).filter(
    (name) => COST_MANAGEMENT_RETRY_AFTER.test(name),
  );
  return retryAfterMs(response?.headers, Date.now(), { names }) || undefined;
}
