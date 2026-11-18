import {
  type ServiceQuotasClient,
  GetServiceQuotaCommand,
  ListRequestedServiceQuotaChangeHistoryCommand,
  type RequestedServiceQuotaChange,
  type RequestStatus as AwsRequestStatus,
} from '@aws-sdk/client-service-quotas';
import {
  type AccountClient,
  ListRegionsCommand,
} from '@aws-sdk/client-account';
import { DescribeRegionsCommand } from '@aws-sdk/client-ec2';
import { type QuotaStatusEntry } from '../../../shared/api-contract/quota-schemas.js';
import {
  type AWSCreds,
  type AWSRoleCreds,
  CloudType,
} from '../../../shared/cloud.js';
import { QuotaProviderStatus } from '../../../shared/quota.js';
import { getRegions } from '../../../shared/cloud-config.js';
import {
  AWS_QUOTA_CODES,
  awsQuotaNameFor,
  awsQuotaResourceKey,
} from '../../../shared/quota-resolvers/aws.js';
import { resolveQuotaResourcesForTarget } from '../../../shared/quota-groups.js';
import { type QuotaResource } from '../../../shared/quota-resolvers/types.js';
import {
  QUOTA_REGION_TIMEOUT_MS,
  AWS_CANDIDATE_PREFLIGHT_REGION_TIMEOUT_MS,
  AWS_CANDIDATE_PREFLIGHT_REGION_CONCURRENCY,
} from '../../config.js';
import { withTimeout } from '../../../shared/utils.js';
import { runCandidatePreflightUnitSweep } from '../candidate-preflight-cache.js';
import { log } from '../logger.js';
import { errorMessage } from '../../../shared/log-diagnostics.js';
import {
  awsClientCredentials,
  type AwsClientCredentials,
  createAwsAccountClient,
  createAwsEc2Client,
  createAwsServiceQuotasClient,
} from '../provider-clients/aws.js';

const EC2_SERVICE_CODE = 'ec2';

/**
 * Max regions queried concurrently when fanning out per-region Service Quotas
 * reads. Service Quotas has a low request-rate limit, so keep this small to
 * avoid ThrottlingException when scanning all enabled regions (vs. just the
 * handful of common ones).
 */
const QUOTA_REGION_CONCURRENCY = 5;

/**
 * Service Quotas codes keyed by (family, purchaseOption).
 * Values are the vCPU-based account-wide limits that actually matter for
 * provisioning GPU / standard instances.
 * See: https://docs.aws.amazon.com/ec2/latest/instancetypes/ec2-quotas.html
 */
const AWS_REQUEST_STATUS = {
  Approved: 'APPROVED',
  Denied: 'DENIED',
  CaseClosed: 'CASE_CLOSED',
  NotApproved: 'NOT_APPROVED',
  InvalidRequest: 'INVALID_REQUEST',
} as const satisfies Record<string, AwsRequestStatus>;

const TERMINAL_REQUEST_STATUSES = new Set<string>([
  AWS_REQUEST_STATUS.Approved,
  AWS_REQUEST_STATUS.Denied,
  AWS_REQUEST_STATUS.CaseClosed,
  AWS_REQUEST_STATUS.NotApproved,
  AWS_REQUEST_STATUS.InvalidRequest,
]);

function isActiveAwsQuotaStatus(status: string | undefined): boolean {
  if (!status) return false;
  return !TERMINAL_REQUEST_STATUSES.has(status);
}

export interface AwsOpenRequest {
  region: string;
  quotaCode: string;
  quotaName: string;
  status: string;
  requestedLimit: number;
  requestId: string;
  requestedAt: Date;
  caseId?: string;
  url?: string;
}

export interface AwsRecentRequest extends AwsOpenRequest {
  grantedLimit: number | null;
  resolution: AwsQuotaResolution;
}

export enum AwsQuotaResolution {
  Approved = 'approved',
  Partial = 'partial',
  Denied = 'denied',
  Pending = 'pending',
}

interface AwsCurrentLimit {
  region: string;
  quotaCode: string;
  resourceName: string;
  currentLimit: number;
}

export interface AwsZeroQuotaRegionsResult {
  zeroRegions: Set<string>;
  unknownRegions: Set<string>;
  complete: boolean;
}

function caseUrl(caseId: string | undefined): string | undefined {
  if (!caseId) return undefined;
  return `https://support.console.aws.amazon.com/support/home#/case/?displayId=${caseId}`;
}

/**
 * Map over items with a bounded number of concurrent workers, preserving order.
 * Used to fan out per-region Service Quotas reads without tripping the API's low
 * request-rate limit. `fn` is expected to handle its own errors (the per-region
 * readers below catch and log), so a worker never rejects.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

export class AwsQuotaProvider {
  private creds: AwsClientCredentials;

  constructor(creds: AwsClientCredentials) {
    this.creds = creds;
  }

  private quotasClient(region: string): ServiceQuotasClient {
    return createAwsServiceQuotasClient(this.creds, {
      region,
      maxAttempts: 5,
    });
  }

  private accountClient(): AccountClient {
    // Account API is global; use us-east-1 as the control-plane region.
    return createAwsAccountClient(this.creds, {
      region: 'us-east-1',
      maxAttempts: 5,
    });
  }

  /**
   * List the regions this account has opted into (or that are on by default),
   * so the optimizer drops regions the account can't reach before they cost
   * a wasted provisioning attempt. The Account API answers in one call; a
   * credential without `account:ListRegions`, such as a restricted key or
   * role, gets EC2's DescribeRegions instead, which lists only the account's
   * enabled regions. If both are refused, the first error stands.
   */
  async getEnabledRegions(signal?: AbortSignal): Promise<Set<string>> {
    try {
      return await this.listAccountRegions(signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      try {
        return await this.describeEnabledRegions(signal);
      } catch {
        throw error;
      }
    }
  }

  private async listAccountRegions(signal?: AbortSignal): Promise<Set<string>> {
    const client = this.accountClient();
    const names: string[] = [];
    let nextToken: string | undefined;
    do {
      const command = new ListRegionsCommand({
        RegionOptStatusContains: ['ENABLED', 'ENABLED_BY_DEFAULT'],
        NextToken: nextToken,
      });
      const result = signal
        ? await client.send(command, { abortSignal: signal })
        : await client.send(command);
      for (const r of result.Regions ?? []) {
        if (typeof r.RegionName === 'string') names.push(r.RegionName);
      }
      nextToken = result.NextToken;
    } while (nextToken);
    return new Set(names);
  }

  private async describeEnabledRegions(
    signal?: AbortSignal,
  ): Promise<Set<string>> {
    // us-east-1 is never opt-in, and is where credentials are validated.
    const client = createAwsEc2Client(this.creds, {
      region: 'us-east-1',
      maxAttempts: 5,
    });
    const command = new DescribeRegionsCommand({ AllRegions: false });
    const result = signal
      ? await client.send(command, { abortSignal: signal })
      : await client.send(command);
    return new Set(
      (result.Regions ?? [])
        .map((region) => region.RegionName)
        .filter((name): name is string => typeof name === 'string'),
    );
  }

  /**
   * Find regions where the vCPU quota that gates `vmType` is literally 0
   * (i.e. account has never been granted any capacity for this family in
   * this region). Caller drops these from the candidate list. One
   * GetServiceQuota call per region — the quota code itself is constant
   * across regions for a given (vmType, spot) pair.
   */
  async getZeroQuotaRegions(
    vmType: string,
    spot: boolean,
    regions: string[],
    signal?: AbortSignal,
  ): Promise<AwsZeroQuotaRegionsResult> {
    const code = quotaCodeFor(vmType, spot);
    if (!code) {
      return {
        zeroRegions: new Set(),
        unknownRegions: new Set(),
        complete: true,
      };
    }
    const zero = new Set<string>();
    const sweep = await runCandidatePreflightUnitSweep({
      units: regions,
      concurrency: AWS_CANDIDATE_PREFLIGHT_REGION_CONCURRENCY,
      perUnitTimeoutMs: AWS_CANDIDATE_PREFLIGHT_REGION_TIMEOUT_MS,
      signal,
      operationName: (region) =>
        `AWS candidate quota ${region} ${vmType} ${spot ? 'spot' : 'on-demand'}`,
      readUnit: async (region, signal) =>
        this.getCurrentLimit(region, code, signal),
    });

    for (const [region, limit] of sweep.values) {
      if (limit === 0) zero.add(region);
    }

    if (sweep.failures.length > 0) {
      log.warn('Failed to read AWS quotas for candidate regions', {
        id: 'system',
        vmType,
        spot,
        failedRegions: sweep.failures.length,
        regions: sweep.failures
          .slice(0, 5)
          .map((failure) => failure.unit)
          .join(', '),
        durationMs: sweep.durationMs,
        error: errorMessage(sweep.failures[sweep.failures.length - 1]?.error),
      });
    }

    return {
      zeroRegions: zero,
      unknownRegions: new Set(sweep.failures.map((failure) => failure.unit)),
      complete: sweep.failures.length === 0,
    };
  }

  /**
   * Look up the current EC2 quota value for the given (region, code) pair.
   */
  private async getCurrentLimit(
    region: string,
    quotaCode: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const client = this.quotasClient(region);
    const command = new GetServiceQuotaCommand({
      ServiceCode: EC2_SERVICE_CODE,
      QuotaCode: quotaCode,
    });
    const result = signal
      ? await client.send(command, { abortSignal: signal })
      : await client.send(command);
    return result.Quota?.Value ?? 0;
  }

  /**
   * Read current EC2 quota limits for the relevant instance families.
   * These rows back `quota status` when there are no provider tickets. A
   * code or region that can't be read is an `unavailable` row with the
   * error, never a dropped one: a caller tells a key still
   * propagating from a quota that doesn't exist.
   */
  async listCurrentLimits(
    regions: string[],
    concurrency = QUOTA_REGION_CONCURRENCY,
  ): Promise<QuotaStatusEntry[]> {
    const targets = Object.entries(AWS_QUOTA_CODES).flatMap(
      ([family, codes]) =>
        [
          { family, quotaCode: codes.spot, spot: true },
          { family, quotaCode: codes.onDemand, spot: false },
        ] as const,
    );
    const unavailable = (
      region: string,
      resourceName: string,
      error: unknown,
      quotaCode?: string,
    ): QuotaStatusEntry => ({
      kind: 'unavailable',
      cloud: CloudType.AWS,
      region,
      resourceName,
      ...(quotaCode && { resourceKey: awsQuotaResourceKey(quotaCode) }),
      status: 'UNAVAILABLE',
      message: errorMessage(error),
    });

    const perRegion = (region: string): Promise<QuotaStatusEntry[]> =>
      Promise.all(
        targets.map(async ({ family, quotaCode, spot }) => {
          const resourceName = awsQuotaNameFor(family, spot);
          try {
            return awsCurrentToStatusEntry({
              region,
              quotaCode,
              resourceName,
              currentLimit: await this.getCurrentLimit(region, quotaCode),
            });
          } catch (err) {
            log.warn('Failed to read current AWS quota limit', {
              id: 'system',
              region,
              quotaCode,
              error: err,
            });
            return unavailable(region, resourceName, err, quotaCode);
          }
        }),
      );

    const perRegionResults = await mapWithConcurrency(
      regions,
      concurrency,
      (r) =>
        withTimeout(
          perRegion(r),
          QUOTA_REGION_TIMEOUT_MS,
          `AWS current quota ${r}`,
        ).catch((err): QuotaStatusEntry[] => {
          log.warn('AWS current quota region timed out', {
            id: 'system',
            region: r,
            error: err,
          });
          return [unavailable(r, 'EC2 current limits', err)];
        }),
    );
    return perRegionResults.flat();
  }

  /**
   * List open quota increase requests across all regions the user asked about.
   * AWS Service Quotas is per-region; caller supplies the list (usually the
   * set of regions they submitted for). Pass an empty list to get global-only
   * service-quota requests, which is rarely useful for EC2.
   */
  /**
   * Read the full (paginated) EC2 quota-change history for one region. Service
   * Quotas returns a NextToken when the history exceeds one page; without
   * draining it the per-region readers below would silently miss requests.
   */
  private async listAllQuotaChanges(
    region: string,
  ): Promise<RequestedServiceQuotaChange[]> {
    const client = this.quotasClient(region);
    const all: RequestedServiceQuotaChange[] = [];
    let nextToken: string | undefined;
    do {
      const res = await client.send(
        new ListRequestedServiceQuotaChangeHistoryCommand({
          ServiceCode: EC2_SERVICE_CODE,
          NextToken: nextToken,
        }),
      );
      all.push(...(res.RequestedQuotas ?? []));
      nextToken = res.NextToken;
    } while (nextToken);
    return all;
  }

  async listOpenRequests(regions: string[]): Promise<AwsOpenRequest[]> {
    const perRegion = async (region: string): Promise<AwsOpenRequest[]> => {
      const out: AwsOpenRequest[] = [];
      try {
        for (const req of await this.listAllQuotaChanges(region)) {
          if (!isActiveAwsQuotaStatus(req.Status)) continue;
          const status = req.Status ?? 'UNKNOWN';
          const caseId = req.CaseId;
          out.push({
            region,
            quotaCode: req.QuotaCode ?? '',
            quotaName: req.QuotaName ?? '',
            status,
            requestedLimit: req.DesiredValue ?? 0,
            requestId: req.Id ?? '',
            requestedAt: req.Created ?? new Date(),
            ...(caseId && { caseId }),
            ...(caseUrl(caseId) && { url: caseUrl(caseId)! }),
          });
        }
      } catch (err) {
        log.warn('Failed to list open AWS quota requests', {
          id: 'system',
          region,
          error: (err as Error).message,
        });
      }
      return out;
    };

    const perRegionResults = await mapWithConcurrency(
      regions,
      QUOTA_REGION_CONCURRENCY,
      perRegion,
    );
    return perRegionResults.flat();
  }

  /**
   * List recent quota requests in the given region, including resolved (APPROVED,
   * CASE_CLOSED) entries. For each resolved entry, fetches the current quota
   * value and reports whether the grant matched the request (partial vs full).
   *
   * `concurrency` bounds how many regions are queried at once. The background
   * monitor keeps the default cap (it isn't latency-sensitive); the user-facing
   * `quota status` read passes a higher value so the whole-catalog fan-out (every
   * AWS region) doesn't serialize into several waves and overrun the CLI's request
   * timeout. Each region targets an independent regional Service Quotas endpoint,
   * so widening the fan-out doesn't share a throttle bucket. Per-region time is
   * still bounded below (a hanging region can't block the whole read).
   */
  async listRecentRequests(
    regions: string[],
    sinceDays = 30,
    concurrency = QUOTA_REGION_CONCURRENCY,
  ): Promise<AwsRecentRequest[]> {
    const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

    const perRegion = async (region: string): Promise<AwsRecentRequest[]> => {
      const out: AwsRecentRequest[] = [];
      try {
        for (const req of await this.listAllQuotaChanges(region)) {
          if (!req.Status) continue;
          const created = req.Created ?? new Date();
          if (created.getTime() < cutoff) continue;
          const caseId = req.CaseId;
          const base: AwsOpenRequest = {
            region,
            quotaCode: req.QuotaCode ?? '',
            quotaName: req.QuotaName ?? '',
            status: req.Status,
            requestedLimit: req.DesiredValue ?? 0,
            requestId: req.Id ?? '',
            requestedAt: created,
            ...(caseId && { caseId }),
            ...(caseUrl(caseId) && { url: caseUrl(caseId)! }),
          };

          if (req.Status === AWS_REQUEST_STATUS.Denied) {
            out.push({
              ...base,
              grantedLimit: 0,
              resolution: AwsQuotaResolution.Denied,
            });
            continue;
          }

          const isResolved =
            req.Status === AWS_REQUEST_STATUS.Approved ||
            req.Status === AWS_REQUEST_STATUS.CaseClosed;
          if (!isResolved) {
            out.push({
              ...base,
              grantedLimit: null,
              resolution: AwsQuotaResolution.Pending,
            });
            continue;
          }

          const desired = req.DesiredValue ?? 0;
          let current = 0;
          try {
            current = await this.getCurrentLimit(region, base.quotaCode);
          } catch (err) {
            log.warn('Failed to fetch current limit for resolved request', {
              id: 'system',
              region,
              quotaCode: base.quotaCode,
              error: (err as Error).message,
            });
            out.push({
              ...base,
              grantedLimit: null,
              resolution: AwsQuotaResolution.Pending,
            });
            continue;
          }

          if (current >= desired) {
            out.push({
              ...base,
              grantedLimit: desired,
              resolution: AwsQuotaResolution.Approved,
            });
          } else {
            out.push({
              ...base,
              grantedLimit: current,
              resolution: AwsQuotaResolution.Partial,
            });
          }
        }
      } catch (err) {
        log.warn('Failed to list recent AWS quota requests', {
          id: 'system',
          region,
          error: (err as Error).message,
        });
      }
      return out;
    };

    // Cap each region so one hanging endpoint (a not-opted-in region whose
    // Service Quotas call never responds) can't block the whole fan-out past
    // the caller's budget. perRegion already swallows its own errors; this only
    // catches the timeout and drops that region to no entries.
    const perRegionResults = await mapWithConcurrency(
      regions,
      concurrency,
      (r) =>
        withTimeout(
          perRegion(r),
          QUOTA_REGION_TIMEOUT_MS,
          `AWS quota ${r}`,
        ).catch((err): AwsRecentRequest[] => {
          log.warn('AWS quota region timed out', {
            id: 'system',
            region: r,
            error: err,
          });
          return [];
        }),
    );
    return perRegionResults.flat();
  }
}

function quotaResourceFor(
  vmType: string,
  spot: boolean,
): QuotaResource | undefined {
  return resolveQuotaResourcesForTarget({
    cloud: CloudType.AWS,
    vmType,
    spot,
  })[0];
}

export function quotaCodeFor(vmType: string, spot: boolean): string | null {
  return quotaResourceFor(vmType, spot)?.providerId ?? null;
}

function awsRecentToStatusEntry(r: AwsRecentRequest): QuotaStatusEntry {
  let status = r.status;
  let grantedLimit: number | null | undefined;
  if (r.resolution === AwsQuotaResolution.Partial) {
    status = QuotaProviderStatus.Partial;
    grantedLimit = r.grantedLimit;
  } else if (r.resolution === AwsQuotaResolution.Approved) {
    status = QuotaProviderStatus.Approved;
    grantedLimit = r.grantedLimit;
  } else if (r.resolution === AwsQuotaResolution.Denied) {
    status = QuotaProviderStatus.Denied;
    grantedLimit = 0;
  }
  return {
    kind: 'request',
    cloud: CloudType.AWS,
    region: r.region,
    resourceName: r.quotaName || r.quotaCode,
    resourceKey: awsQuotaResourceKey(r.quotaCode),
    status,
    requestedLimit: r.requestedLimit,
    requestId: r.caseId ?? r.requestId,
    requestedAt: r.requestedAt.toISOString(),
    providerRequestId: r.requestId,
    ...(r.caseId && { providerCaseId: r.caseId }),
    ...(r.url && { url: r.url }),
    ...(grantedLimit !== undefined && { grantedLimit }),
  };
}

function awsCurrentToStatusEntry(r: AwsCurrentLimit): QuotaStatusEntry {
  return {
    kind: 'current',
    cloud: CloudType.AWS,
    region: r.region,
    resourceName: r.resourceName,
    resourceKey: awsQuotaResourceKey(r.quotaCode),
    status: QuotaProviderStatus.Current,
    currentLimit: r.currentLimit,
  };
}

export async function awsQuotaStatus(
  creds: AWSCreds | AWSRoleCreds,
  region?: string,
): Promise<QuotaStatusEntry[]> {
  const provider = new AwsQuotaProvider(awsClientCredentials(creds));
  const regions = region ? [region] : getRegions(CloudType.AWS);
  // Query every region in parallel (Azure's status path already does this).
  // Capping at 5 here serialized the whole-catalog read into ~7 waves and was
  // overrunning the CLI request timeout; the regional endpoints are independent.
  const [recent, current] = await Promise.all([
    provider.listRecentRequests(regions, undefined, regions.length),
    provider.listCurrentLimits(regions, regions.length),
  ]);
  return [...recent.map(awsRecentToStatusEntry), ...current];
}
