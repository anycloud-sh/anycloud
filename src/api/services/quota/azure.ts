import type { TokenCredential } from '@azure/identity';
import type { AzureQuotaExtensionAPI } from '@azure/arm-quota';
import type { MicrosoftSupport } from '@azure/arm-support';
import { type QuotaStatusEntry } from '../../../shared/api-contract/quota-schemas.js';
import { type AzureConnectionCreds, CloudType } from '../../../shared/cloud.js';
import { QuotaProviderStatus } from '../../../shared/quota.js';
import { getGPUVMTypes, getRegions } from '../../../shared/cloud-config.js';
import { getAzureQuotaResourceKeyForVMType } from '../../../shared/quota-resolvers/azure.js';
import {
  AZURE_QUOTA_RESOURCE_KEYS,
  canonicalAzureQuotaResourceKey,
  createAzureQuotaIdentity,
  type AzureQuotaResourceKey,
} from '../../../shared/quota-resolvers/azure-identity.js';
import {
  AZURE_PUBLIC_IP_QUOTA_SCHEMA_DRIFT_EVENT_CODE,
  isAcceptedAzurePublicIpQuotaProviderId,
  looksLikeAzurePublicIpQuotaProviderId,
  resolveAzurePublicIpQuota,
  type AzurePublicIpQuotaCandidate,
  type AzurePublicIpQuotaResolution,
} from '../../../shared/quota-resolvers/azure-public-ip.js';
import { armClientOptions } from '../azure-client-options.js';
import {
  QUOTA_REGION_TIMEOUT_MS,
  AZURE_CANDIDATE_PREFLIGHT_REGION_TIMEOUT_MS,
  AZURE_CANDIDATE_PREFLIGHT_REGION_CONCURRENCY,
} from '../../config.js';
import { sleep, withTimeout } from '../../../shared/utils.js';
import type {
  AzurePendingRequest,
  AzureQuotaInfo,
  ReadOnlyAzureQuotaInfo,
  SupportTicketInfo,
  WritableAzureQuotaInfo,
} from './types.js';
import { log } from '../logger.js';
import { runCandidatePreflightUnitSweep } from '../candidate-preflight-cache.js';
import { errorMessage } from '../../../shared/log-diagnostics.js';
import {
  createAzureCredential,
  createAzureComputeManagementClient,
  createAzureQuotaExtensionClient,
  createAzureResourceManagementClient,
  createAzureSupportClient,
} from '../provider-clients/azure.js';

const TICKET_DESC_RE = /Resource Manager,\s*(\w+),\s*(.+?)\s*\/\s*(\d+)/;
const TICKET_RESOURCE_KEY_RE = /^AnyCloudQuotaResourceKey:\s*(.+?)\s*$/im;
const LEGACY_TICKET_RESOURCE_RE = /^AnyCloudQuotaResource:\s*(.+?)\s*$/im;

const CORES_RESOURCE_KEY = AZURE_QUOTA_RESOURCE_KEYS.cores;
const LOW_PRIORITY_CORES_RESOURCE_KEY =
  AZURE_QUOTA_RESOURCE_KEYS.lowPriorityCores;
const PENDING_QUOTA_REQUEST_STATES = ['InProgress', 'Accepted'] as const;

interface SupportTicketReadResult {
  tickets: SupportTicketInfo[];
  complete: boolean;
}

interface AzurePendingRequestWithProviderId extends AzurePendingRequest {
  providerId: string;
}

interface AzurePendingRequestReadResult {
  requests: Map<AzureQuotaResourceKey, AzurePendingRequestWithProviderId[]>;
  providerCandidates: AzurePublicIpQuotaDriftCandidate[];
  complete: boolean;
}

function isNetworkQuotaScope(scope: string): boolean {
  return /\/providers\/Microsoft\.Network\//iu.test(scope);
}

function isAcceptedPublicIpProviderPair(
  first: string,
  second: string,
): boolean {
  return (
    first !== second &&
    isAcceptedAzurePublicIpQuotaProviderId(first) &&
    isAcceptedAzurePublicIpQuotaProviderId(second)
  );
}

function canJoinQuotaEndpointProviderIds(
  scope: string,
  limitProviderId: string,
  endpointProviderId: string,
): boolean {
  return (
    limitProviderId === endpointProviderId ||
    !isNetworkQuotaScope(scope) ||
    (!looksLikeAzurePublicIpQuotaProviderId(limitProviderId) &&
      !looksLikeAzurePublicIpQuotaProviderId(endpointProviderId)) ||
    isAcceptedPublicIpProviderPair(limitProviderId, endpointProviderId)
  );
}

function canDeferNetworkPublicIpCollisionToResolver(
  scope: string,
  first: string,
  second: string,
): boolean {
  return (
    first !== second &&
    isNetworkQuotaScope(scope) &&
    looksLikeAzurePublicIpQuotaProviderId(first) &&
    looksLikeAzurePublicIpQuotaProviderId(second)
  );
}

interface AzurePublicIpQuotaDriftCandidate extends AzurePublicIpQuotaCandidate {
  resourceName: string;
}

type AzurePublicIpQuotaDriftResolution = Extract<
  AzurePublicIpQuotaResolution<AzurePublicIpQuotaDriftCandidate>,
  { kind: 'unknown' | 'ambiguous' }
>;

function reportPublicIpQuotaSchemaDrift(
  resolution: AzurePublicIpQuotaDriftResolution,
  region: string,
  operation: 'status' | 'request' | 'inventory',
  endpoint?: 'usages' | 'pending',
): void {
  log.warn('Azure public IP quota schema drift detected', {
    id: 'system',
    eventCode: AZURE_PUBLIC_IP_QUOTA_SCHEMA_DRIFT_EVENT_CODE,
    region,
    operation,
    ...(endpoint && { endpoint }),
    resolution: resolution.kind,
    ...(resolution.kind === 'ambiguous' && {
      acceptedCandidates: resolution.acceptedCandidates.map((quota) => ({
        providerId: quota.providerId,
        resourceKey: quota.resourceKey,
        resourceName: quota.resourceName,
      })),
    }),
    unknownCandidates: resolution.unknownCandidates.map((quota) => ({
      providerId: quota.providerId,
      resourceKey: quota.resourceKey,
      resourceName: quota.resourceName,
    })),
  });
}

function assertNoNetworkEndpointPublicIpSchemaDrift(
  candidates: readonly AzurePublicIpQuotaDriftCandidate[],
  region: string,
  endpoint: 'usages' | 'pending',
): void {
  const resolution = resolveAzurePublicIpQuota(candidates);
  // Exact ignored resources (including Basic PublicIPAddresses) resolve as
  // absent and remain available for distinct read-only status rows. Unknown or
  // ambiguous endpoint identities fail the Network scope closed after emitting
  // the canary-visible drift signal.
  if (resolution.kind !== 'unknown' && resolution.kind !== 'ambiguous') return;
  reportPublicIpQuotaSchemaDrift(resolution, region, 'inventory', endpoint);
  throw publicIpQuotaSchemaDriftError(resolution, region);
}

function publicIpQuotaSchemaDriftError(
  resolution: AzurePublicIpQuotaDriftResolution,
  region: string,
): Error {
  const unknownIds = resolution.unknownCandidates
    .map((quota) => quota.providerId)
    .join(', ');
  if (resolution.kind === 'ambiguous') {
    const acceptedIds = resolution.acceptedCandidates
      .map((quota) => quota.providerId)
      .join(', ');
    return new Error(
      `Azure returned ambiguous public IP quota resources in ${region}: ` +
        `accepted=[${acceptedIds || 'none'}], ` +
        `unrecognized=[${unknownIds || 'none'}]; no quota request was submitted`,
    );
  }
  return new Error(
    `Azure returned unrecognized public IP quota resource(s) in ${region}: ${unknownIds}; no quota request was submitted`,
  );
}

function quotaDisplayName(
  localizedValue: unknown,
  resourceKey: AzureQuotaResourceKey,
): string {
  return typeof localizedValue === 'string' && localizedValue.trim()
    ? localizedValue
    : resourceKey;
}

export function parseQuotaTicketDescription(description: string): {
  region: string;
  seriesName: string;
  requestedLimit: number;
  resourceKey?: AzureQuotaResourceKey;
} | null {
  const m = description.match(TICKET_DESC_RE);
  if (!m) return null;
  const canonicalMarker = description.match(TICKET_RESOURCE_KEY_RE)?.[1];
  let resourceKey = canonicalMarker
    ? canonicalAzureQuotaResourceKey(canonicalMarker)
    : null;
  if (!resourceKey) {
    const legacyProviderId = description.match(LEGACY_TICKET_RESOURCE_RE)?.[1];
    if (legacyProviderId) {
      try {
        resourceKey = createAzureQuotaIdentity(
          legacyProviderId.trim(),
        ).resourceKey;
      } catch {
        resourceKey = null;
      }
    }
  }
  return {
    region: m[1],
    seriesName: m[2].trim(),
    requestedLimit: Number(m[3]),
    ...(resourceKey && { resourceKey }),
  };
}

function azurePortalSupportUrl(ticketId: string): string {
  return `https://portal.azure.com/#blade/Microsoft_Azure_Support/HelpAndSupportBlade/supportRequest/srId/${ticketId}`;
}

export interface AzureInsufficientQuotaRegionsResult {
  insufficientRegions: Set<string>;
  unknownRegions: Set<string>;
  complete: boolean;
}

export function seriesNameFor(resourceName: string): string {
  return resourceName
    .replace(/^Standard\s+/, '')
    .replace(/\s+Family\s+vCPUs$/i, '')
    .replace(/_/g, ' ');
}

export function mergeAzureQuotaSources(
  computeUsages: ReadOnlyAzureQuotaInfo[],
  quotaApiResults: WritableAzureQuotaInfo[],
): AzureQuotaInfo[] {
  const quotaByKey = new Map<AzureQuotaResourceKey, WritableAzureQuotaInfo>();
  for (const quota of quotaApiResults) {
    if (quotaByKey.has(quota.resourceKey)) {
      throw new Error(
        `Azure quota API returned duplicate resource key ${quota.resourceKey}`,
      );
    }
    quotaByKey.set(quota.resourceKey, quota);
  }

  const merged = computeUsages.map((compute): AzureQuotaInfo => {
    const quota = quotaByKey.get(compute.resourceKey);
    if (!quota) return compute;
    quotaByKey.delete(compute.resourceKey);
    return {
      region: compute.region,
      resourceName: compute.resourceName,
      providerId: quota.providerId,
      resourceKey: compute.resourceKey,
      currentUsage: compute.currentUsage,
      limit: compute.limit,
      unit: compute.unit,
      writable: true,
      scope: quota.scope,
      pending: quota.pending,
    };
  });

  merged.push(...quotaByKey.values());
  return merged;
}

export class AzureQuotaProvider {
  private credential: TokenCredential;
  private subscriptionId: string;
  private onComputeRegistrationChanged?: () => void;

  constructor(
    creds: AzureConnectionCreds,
    onComputeRegistrationChanged?: () => void,
  ) {
    this.credential = createAzureCredential(creds);
    this.subscriptionId = creds.subscriptionId;
    this.onComputeRegistrationChanged = onComputeRegistrationChanged;
  }

  private regionScope(region: string): string {
    return `subscriptions/${this.subscriptionId}/providers/Microsoft.Compute/locations/${region}`;
  }

  private networkScope(region: string): string {
    return `subscriptions/${this.subscriptionId}/providers/Microsoft.Network/locations/${region}`;
  }

  /**
   * Ensure a resource provider is registered in all regions. Parallel to the
   * AWS region opt-in: without this, provider-scoped reads (e.g. Compute SKUs)
   * only see regions the subscription has previously registered in, which can
   * silently collapse to a handful. Idempotent; polls until Registered or
   * 2 minutes elapse (registration is async on Azure's side).
   */
  async ensureProviderRegistered(
    namespace: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const client = createAzureResourceManagementClient(
      this.credential,
      this.subscriptionId,
      armClientOptions(),
    );
    const getProvider = () =>
      signal
        ? client.providers.get(namespace, { abortSignal: signal })
        : client.providers.get(namespace);
    const registerProvider = () =>
      signal
        ? client.providers.register(namespace, { abortSignal: signal })
        : client.providers.register(namespace);

    const current = await getProvider();
    if (current.registrationState === 'Registered') return true;

    await registerProvider();
    if (namespace === 'Microsoft.Compute') {
      this.onComputeRegistrationChanged?.();
    }

    // Check before sleeping: registration often completes immediately, and a
    // flat 10s lead-in wait charges every fast registration for the slow ones.
    const deadline = Date.now() + 2 * 60_000;
    while (Date.now() < deadline) {
      const p = await getProvider();
      if (p.registrationState === 'Registered') {
        if (namespace === 'Microsoft.Compute') {
          this.onComputeRegistrationChanged?.();
        }
        return true;
      }
      await sleep(10_000, signal);
    }
    log.warn('Provider registration did not reach Registered within deadline', {
      id: 'system',
      namespace,
    });
    return false;
  }

  /** Merge quota sources by canonical identity with explicit field ownership. */
  private async listMergedQuotas(
    region: string,
    signal?: AbortSignal,
    onQuotaApiFailure?: (error: unknown) => void,
  ): Promise<AzureQuotaInfo[]> {
    const [quotaApiResult, computeUsages] = await Promise.allSettled([
      onQuotaApiFailure
        ? withTimeout(
            this.listQuotasForScope(region, this.regionScope(region), signal),
            QUOTA_REGION_TIMEOUT_MS / 3,
            `Azure Compute quota requests ${region}`,
          )
        : this.listQuotasForScope(region, this.regionScope(region), signal),
      this.listComputeUsages(region, signal),
    ]);
    if (computeUsages.status === 'rejected') throw computeUsages.reason;
    if (quotaApiResult.status === 'rejected') {
      if (!onQuotaApiFailure) throw quotaApiResult.reason;
      onQuotaApiFailure(quotaApiResult.reason);
      return computeUsages.value;
    }
    return mergeAzureQuotaSources(computeUsages.value, quotaApiResult.value);
  }

  /**
   * Find Azure regions where this subscription cannot launch the requested
   * VM shape because the gating vCPU quotas have no room.
   *
   * Azure spot launches draw from a separate quota pool: only the regional
   * LowPriorityCores quota gates them, never the VM family quota (verified
   * against ARM preflight — a family limit of 0 rejects an on-demand launch
   * but not a spot one). On-demand launches are gated by the VM family quota
   * and, when Azure reports it, the regional total cores quota.
   *
   * If Azure does not report the target VM family in a region, treat that
   * region as unusable for this subscription/SKU regardless of pricing model.
   * This catches regions that the static catalog advertises but the customer's
   * subscription cannot provision.
   */
  async getInsufficientQuotaRegions(
    vmFamilyResourceKey: AzureQuotaResourceKey,
    requiredVCPUs: number,
    spot: boolean,
    regions: string[],
    signal?: AbortSignal,
  ): Promise<AzureInsufficientQuotaRegionsResult> {
    const insufficient = new Set<string>();
    const sweep = await runCandidatePreflightUnitSweep({
      units: regions,
      concurrency: AZURE_CANDIDATE_PREFLIGHT_REGION_CONCURRENCY,
      perUnitTimeoutMs: AZURE_CANDIDATE_PREFLIGHT_REGION_TIMEOUT_MS,
      signal,
      operationName: (region) =>
        `Azure candidate quota ${region} ${vmFamilyResourceKey}`,
      readUnit: async (region, signal) => this.listMergedQuotas(region, signal),
    });

    for (const [region, quotas] of sweep.values) {
      const byKey = new Map(quotas.map((q) => [q.resourceKey, q]));
      const hasHeadroom = (q: AzureQuotaInfo | undefined): boolean =>
        q !== undefined && q.limit - q.currentUsage >= requiredVCPUs;

      const family = byKey.get(vmFamilyResourceKey);
      if (family === undefined) {
        insufficient.add(region);
        continue;
      }

      if (spot) {
        if (!hasHeadroom(byKey.get(LOW_PRIORITY_CORES_RESOURCE_KEY))) {
          insufficient.add(region);
        }
        continue;
      }

      if (!hasHeadroom(family)) {
        insufficient.add(region);
        continue;
      }

      const totalRegionalCores = byKey.get(CORES_RESOURCE_KEY);
      if (totalRegionalCores && !hasHeadroom(totalRegionalCores)) {
        insufficient.add(region);
      }
    }

    if (sweep.failures.length > 0) {
      log.warn('Failed to read Azure quotas for candidate regions', {
        id: 'system',
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
      insufficientRegions: insufficient,
      unknownRegions: new Set(sweep.failures.map((failure) => failure.unit)),
      complete: sweep.failures.length === 0,
    };
  }

  /**
   * List any open (pending or in-progress) quota increase requests in the region.
   * Read-only — safe for the CLI status flow and the background poller.
   */
  async listOpenRequests(
    region: string,
    onUnavailable?: (scope: string, error: unknown) => void,
  ): Promise<WritableAzureQuotaInfo[]> {
    const out: WritableAzureQuotaInfo[] = [];
    for (const scope of [this.regionScope(region), this.networkScope(region)]) {
      try {
        const quotas = await this.listQuotasForScope(region, scope);
        out.push(...quotas.filter((q) => q.pending.requests.length > 0));
      } catch (err) {
        onUnavailable?.(
          isNetworkQuotaScope(scope) ? 'Network requests' : 'Compute requests',
          err,
        );
        log.warn('Azure quota status failed for scope', {
          id: 'system',
          region,
          scope,
          error: err,
        });
      }
    }
    return out;
  }

  /**
   * Current limits useful for user-facing status. Keep this narrower than
   * Azure's full quota list so status stays focused on launch blockers.
   */
  async listCurrentStatusQuotas(
    region: string,
    onUnavailable?: (scope: string, error: unknown) => void,
  ): Promise<AzureQuotaInfo[]> {
    const gpuFamilies = new Set<AzureQuotaResourceKey>();
    try {
      for (const vmType of getGPUVMTypes(CloudType.Azure, region, '*')) {
        const resourceKey = getAzureQuotaResourceKeyForVMType(vmType);
        if (resourceKey) gpuFamilies.add(resourceKey);
      }
    } catch (err) {
      log.warn('Failed to derive Azure GPU quota families for status', {
        id: 'system',
        region,
        error: err,
      });
    }

    const current: AzureQuotaInfo[] = [];
    const failures: unknown[] = [];
    let computeReadFailed = false;
    const networkRead = withTimeout(
      this.listQuotasForScope(region, this.networkScope(region)),
      QUOTA_REGION_TIMEOUT_MS / 3,
      `Azure Network quota limits ${region}`,
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      const compute = await this.listMergedQuotas(region, undefined, (err) => {
        onUnavailable?.('Compute requests', err);
      });
      current.push(
        ...compute.filter((q) => {
          return (
            gpuFamilies.has(q.resourceKey) ||
            q.resourceKey === CORES_RESOURCE_KEY ||
            q.resourceKey === LOW_PRIORITY_CORES_RESOURCE_KEY
          );
        }),
      );
    } catch (err) {
      computeReadFailed = true;
      failures.push(err);
      log.warn('Azure current quota status failed for compute scope', {
        id: 'system',
        region,
        error: err,
      });
    }

    try {
      const networkResult = await networkRead;
      if ('error' in networkResult) throw networkResult.error;
      const network = networkResult.value;
      const resolution = resolveAzurePublicIpQuota(network);
      if (resolution.kind === 'selected') {
        current.push(resolution.selected);
      } else if (
        resolution.kind === 'unknown' ||
        resolution.kind === 'ambiguous'
      ) {
        reportPublicIpQuotaSchemaDrift(resolution, region, 'status');
        onUnavailable?.(
          'Network limits',
          publicIpQuotaSchemaDriftError(resolution, region),
        );
      }
    } catch (err) {
      failures.push(err);
      onUnavailable?.('Network limits', err);
      log.warn('Azure current quota status failed for network scope', {
        id: 'system',
        region,
        error: err,
      });
    }

    if (computeReadFailed || (current.length === 0 && failures.length > 0)) {
      throw new Error(
        `Azure current quota status unavailable for ${region}: ${errorMessage(failures[0])}`,
      );
    }
    return current;
  }

  /**
   * List open quota-related support tickets for the subscription, optionally
   * filtered to a region by parsing the ticket description.
   */
  async listOpenSupportTickets(region?: string): Promise<SupportTicketInfo[]> {
    const supportClient = createAzureSupportClient(
      this.credential,
      this.subscriptionId,
      armClientOptions(),
    );
    const { tickets } = await this.listQuotaTickets(supportClient);
    if (!region) return tickets;
    const regionUpper = region.toUpperCase();
    return tickets.filter((t) => {
      const parsed = parseQuotaTicketDescription(t.description);
      return parsed?.region === regionUpper;
    });
  }

  private async listQuotaTickets(
    supportClient: MicrosoftSupport,
  ): Promise<SupportTicketReadResult> {
    const tickets: SupportTicketInfo[] = [];
    let complete = true;

    try {
      for await (const ticket of supportClient.supportTickets.list({
        filter: "status eq 'Open'",
      })) {
        if (!ticket.title?.toLowerCase().includes('quota')) continue;
        tickets.push({
          ticketId: ticket.supportTicketId ?? ticket.name ?? '',
          title: ticket.title ?? '',
          description: ticket.description ?? '',
          status: ticket.status ?? 'Unknown',
          severity: ticket.severity ?? 'Unknown',
          created: ticket.createdDate ?? new Date(),
        });
      }
    } catch (err) {
      complete = false;
      log.warn('Failed to list Azure support tickets', {
        id: 'system',
        error: err,
      });
    }

    return { tickets, complete };
  }

  private async listQuotasForScope(
    region: string,
    scope: string,
    signal?: AbortSignal,
  ): Promise<WritableAzureQuotaInfo[]> {
    const client = createAzureQuotaExtensionClient(
      this.credential,
      armClientOptions(),
    );

    const [limits, usages, pendingRead] = await Promise.all([
      this.collectPages<any>(
        client.quota.list(scope, { abortSignal: signal }),
        signal,
      ),
      this.collectPages<any>(
        client.usages.list(scope, { abortSignal: signal }),
        signal,
      ),
      this.listPendingRequests(client, scope, signal),
    ]);

    const usageMap = new Map<
      AzureQuotaResourceKey,
      { providerId: string; value: number }
    >();
    const usageProviderCandidates = new Map<
      string,
      AzurePublicIpQuotaDriftCandidate
    >();
    for (const usage of usages) {
      const name = usage.properties?.name?.value ?? usage.name;
      if (typeof name !== 'string' || !name.trim()) continue;
      const identity = createAzureQuotaIdentity(name);
      const value = usage.properties?.usages?.value ?? 0;
      if (!usageProviderCandidates.has(identity.providerId)) {
        usageProviderCandidates.set(identity.providerId, {
          ...identity,
          resourceName: quotaDisplayName(
            usage.properties?.name?.localizedValue,
            identity.resourceKey,
          ),
        });
      }
      const existing = usageMap.get(identity.resourceKey);
      if (existing) {
        const sameProvider = existing.providerId === identity.providerId;
        if (
          (sameProvider && existing.value !== Number(value)) ||
          (!sameProvider &&
            !canDeferNetworkPublicIpCollisionToResolver(
              scope,
              existing.providerId,
              identity.providerId,
            ))
        ) {
          throw new Error(
            `Azure quota usages returned an ambiguous canonical collision for ${identity.resourceKey}`,
          );
        }
        continue;
      }
      usageMap.set(identity.resourceKey, {
        providerId: identity.providerId,
        value: Number(value),
      });
    }

    if (isNetworkQuotaScope(scope)) {
      assertNoNetworkEndpointPublicIpSchemaDrift(
        [...usageProviderCandidates.values()],
        region,
        'usages',
      );
      assertNoNetworkEndpointPublicIpSchemaDrift(
        pendingRead.providerCandidates,
        region,
        'pending',
      );
    }

    const quotas: WritableAzureQuotaInfo[] = [];
    const firstLimitProviderByKey = new Map<AzureQuotaResourceKey, string>();
    const limitsByIdentity = new Map<
      string,
      { providerId: string; limit: number; unit: string }
    >();
    for (const item of limits) {
      const rawProviderId = item.properties?.name?.value ?? item.name;
      if (typeof rawProviderId !== 'string' || !rawProviderId.trim()) {
        log.warn('Skipping Azure quota row without a provider name', {
          id: 'system',
          region,
          scope,
        });
        continue;
      }
      const identity = createAzureQuotaIdentity(rawProviderId);
      const limitValue =
        item.properties?.limit && 'value' in item.properties.limit
          ? (item.properties.limit as { value: number }).value
          : 0;
      const unit = (item.properties?.unit as string) ?? 'Count';
      const identityKey = `${identity.resourceKey}\u0000${identity.providerId}`;
      const existing = limitsByIdentity.get(identityKey);
      if (existing) {
        if (existing.limit !== limitValue || existing.unit !== unit) {
          throw new Error(
            `Azure quota limits returned an ambiguous canonical collision for ${identity.resourceKey}`,
          );
        }
        continue;
      }
      const firstProvider = firstLimitProviderByKey.get(identity.resourceKey);
      if (
        firstProvider &&
        firstProvider !== identity.providerId &&
        !canDeferNetworkPublicIpCollisionToResolver(
          scope,
          firstProvider,
          identity.providerId,
        )
      ) {
        throw new Error(
          `Azure quota limits returned an ambiguous canonical collision for ${identity.resourceKey}`,
        );
      }
      if (!firstProvider) {
        firstLimitProviderByKey.set(identity.resourceKey, identity.providerId);
      }
      limitsByIdentity.set(identityKey, {
        providerId: identity.providerId,
        limit: limitValue,
        unit,
      });
      const usage = usageMap.get(identity.resourceKey);
      let usageValue = 0;
      if (usage) {
        if (
          canJoinQuotaEndpointProviderIds(
            scope,
            identity.providerId,
            usage.providerId,
          )
        ) {
          usageValue = usage.value;
        } else if (
          !canDeferNetworkPublicIpCollisionToResolver(
            scope,
            identity.providerId,
            usage.providerId,
          )
        ) {
          throw new Error(
            `Azure quota usage provider ID did not match limit provider ID for ${identity.resourceKey}`,
          );
        }
      }
      const pendingRequests = (
        pendingRead.requests.get(identity.resourceKey) ?? []
      )
        .filter((request) =>
          canJoinQuotaEndpointProviderIds(
            scope,
            identity.providerId,
            request.providerId,
          ),
        )
        .map(({ providerId: _providerId, ...request }) => request);

      quotas.push({
        ...identity,
        region,
        resourceName: quotaDisplayName(
          item.properties?.name?.localizedValue,
          identity.resourceKey,
        ),
        currentUsage: usageValue,
        limit: limitValue,
        unit,
        writable: true,
        scope,
        pending: {
          complete: pendingRead.complete,
          requests: pendingRequests,
        },
      });
    }

    return quotas;
  }

  private async listComputeUsages(
    region: string,
    signal?: AbortSignal,
  ): Promise<ReadOnlyAzureQuotaInfo[]> {
    const client = createAzureComputeManagementClient(
      this.credential,
      this.subscriptionId,
      armClientOptions(),
    );
    const quotas: ReadOnlyAzureQuotaInfo[] = [];
    const byKey = new Map<AzureQuotaResourceKey, ReadOnlyAzureQuotaInfo>();
    for await (const usage of client.usageOperations.list(region, {
      abortSignal: signal,
    })) {
      const rawProviderId = usage.name?.value;
      if (!rawProviderId) {
        log.warn('Skipping Azure compute usage without a provider name', {
          id: 'system',
          region,
        });
        continue;
      }
      const identity = createAzureQuotaIdentity(rawProviderId);
      const quota: ReadOnlyAzureQuotaInfo = {
        ...identity,
        region,
        resourceName: quotaDisplayName(
          usage.name?.localizedValue,
          identity.resourceKey,
        ),
        currentUsage: usage.currentValue ?? 0,
        limit: Number(usage.limit ?? 0),
        unit: usage.unit ?? 'Count',
        writable: false,
      };
      const existing = byKey.get(identity.resourceKey);
      if (existing) {
        if (
          existing.providerId !== quota.providerId ||
          existing.currentUsage !== quota.currentUsage ||
          existing.limit !== quota.limit ||
          existing.unit !== quota.unit
        ) {
          throw new Error(
            `Azure compute usages returned an ambiguous canonical collision for ${identity.resourceKey}`,
          );
        }
        continue;
      }
      byKey.set(identity.resourceKey, quota);
      quotas.push(quota);
    }
    return quotas;
  }

  private async listPendingRequests(
    client: AzureQuotaExtensionAPI,
    scope: string,
    signal?: AbortSignal,
  ): Promise<AzurePendingRequestReadResult> {
    const pendingMap = new Map<
      AzureQuotaResourceKey,
      AzurePendingRequestWithProviderId[]
    >();
    const providerCandidates = new Map<
      string,
      AzurePublicIpQuotaDriftCandidate
    >();

    try {
      // Azure rejects a boolean `or` expression in this endpoint's
      // provisioningState filter. Read one coherent request-history snapshot
      // and select both active states locally; separate filtered reads could
      // miss a request that transitions between snapshots.
      const pendingPages = signal
        ? client.quotaRequestStatus.list(scope, { abortSignal: signal })
        : client.quotaRequestStatus.list(scope);
      const requests = await withTimeout(
        this.collectPages<any>(pendingPages, signal),
        10_000,
        `Azure pending quota requests for ${scope}`,
      );

      for (const req of requests) {
        const subRequests = (req as any).properties?.value ?? [];
        for (const sub of subRequests) {
          const status =
            sub.provisioningState ??
            (req as any).properties?.provisioningState ??
            'Unknown';
          if (!PENDING_QUOTA_REQUEST_STATES.some((state) => state === status)) {
            continue;
          }

          const resourceName = sub.name?.value;
          if (!resourceName) continue;
          const identity = createAzureQuotaIdentity(resourceName);
          if (!providerCandidates.has(identity.providerId)) {
            providerCandidates.set(identity.providerId, {
              ...identity,
              resourceName: quotaDisplayName(
                sub.name?.localizedValue,
                identity.resourceKey,
              ),
            });
          }

          const limitValue =
            sub.limit && 'value' in sub.limit
              ? (sub.limit as { value: number }).value
              : 0;

          const submitTimeValue =
            (req as any).properties?.requestSubmitTime ?? new Date();
          const submitTime =
            submitTimeValue instanceof Date
              ? submitTimeValue
              : new Date(submitTimeValue);
          const entry: AzurePendingRequest = {
            requestedLimit: limitValue,
            status,
            submitTime: Number.isNaN(submitTime.getTime())
              ? new Date()
              : submitTime,
            ...((sub.subRequestId ?? req.name ?? req.id) && {
              providerRequestId: String(sub.subRequestId ?? req.name ?? req.id),
            }),
          };

          const existing = pendingMap.get(identity.resourceKey) ?? [];
          existing.push({ ...entry, providerId: identity.providerId });
          pendingMap.set(identity.resourceKey, existing);
        }
      }
    } catch (err) {
      log.warn('Failed to read Azure pending quota requests', {
        id: 'system',
        scope,
        error: errorMessage(err),
      });
      return {
        requests: pendingMap,
        providerCandidates: [...providerCandidates.values()],
        complete: false,
      };
    }

    return {
      requests: pendingMap,
      providerCandidates: [...providerCandidates.values()],
      complete: true,
    };
  }

  private async collectPages<T>(
    iterable: AsyncIterable<T>,
    signal?: AbortSignal,
  ): Promise<T[]> {
    const items: T[] = [];
    for await (const item of iterable) {
      signal?.throwIfAborted();
      items.push(item);
    }
    return items;
  }
}

export async function azureQuotaStatus(
  creds: AzureConnectionCreds,
  region?: string,
): Promise<QuotaStatusEntry[]> {
  const provider = new AzureQuotaProvider(creds);
  const regions = region ? [region] : getRegions(CloudType.Azure);
  const failures: unknown[] = [];
  let currentReadFailed = false;
  const unavailable: QuotaStatusEntry[] = [];
  const unavailableScopes = new Set<string>();
  const recordUnavailable = (region: string, scope: string, error: unknown) => {
    const key = `${region}:${scope}`;
    if (unavailableScopes.has(key)) return;
    unavailableScopes.add(key);
    unavailable.push({
      kind: 'unavailable',
      cloud: CloudType.Azure,
      region,
      resourceName: scope,
      status: 'UNAVAILABLE',
      message: errorMessage(error),
    });
  };

  // Fetch the subscription-wide tickets and the per-region open requests
  // CONCURRENTLY. Each is capped at QUOTA_REGION_TIMEOUT_MS; overlapping them
  // keeps the worst case at one cap rather than stacking the ticket read and
  // slowest region. Useful results survive individual read failures; a failure
  // that leaves no current data is reported below.
  const ticketsPromise = withTimeout(
    provider.listOpenSupportTickets(),
    QUOTA_REGION_TIMEOUT_MS,
    'Azure support tickets',
  ).catch((err): SupportTicketInfo[] => {
    failures.push(err);
    for (const r of regions) recordUnavailable(r, 'Support tickets', err);
    log.warn('Azure quota status (tickets) failed', {
      id: 'system',
      error: err,
    });
    return [];
  });

  const openByRegion = async (
    r: string,
  ): Promise<{ region: string; open: WritableAzureQuotaInfo[] }> => {
    try {
      const open = await withTimeout(
        provider.listOpenRequests(r, (scope, err) =>
          recordUnavailable(r, scope, err),
        ),
        QUOTA_REGION_TIMEOUT_MS,
        `Azure quota ${r}`,
      );
      return { region: r, open };
    } catch (err) {
      failures.push(err);
      recordUnavailable(r, 'Quota requests', err);
      log.warn('Azure quota status failed for region', {
        id: 'system',
        region: r,
        error: err,
      });
      return { region: r, open: [] };
    }
  };

  const currentByRegion = async (
    r: string,
  ): Promise<{ region: string; current: AzureQuotaInfo[] }> => {
    try {
      const current = await withTimeout(
        provider.listCurrentStatusQuotas(r, (scope, err) =>
          recordUnavailable(r, scope, err),
        ),
        QUOTA_REGION_TIMEOUT_MS,
        `Azure current quota ${r}`,
      );
      return { region: r, current };
    } catch (err) {
      failures.push(err);
      currentReadFailed = true;
      recordUnavailable(r, 'Compute limits', err);
      log.warn('Azure current quota status failed for region', {
        id: 'system',
        region: r,
        error: err,
      });
      return { region: r, current: [] };
    }
  };

  const [allTickets, perRegion, currentPerRegion] = await Promise.all([
    ticketsPromise,
    Promise.all(regions.map(openByRegion)),
    Promise.all(regions.map(currentByRegion)),
  ]);

  // Bucket subscription-wide tickets by parsed region for the per-region merge.
  const ticketsByRegion = new Map<string, SupportTicketInfo[]>();
  for (const t of allTickets) {
    const parsed = parseQuotaTicketDescription(t.description);
    const r = parsed?.region?.toLowerCase();
    if (!r) continue;
    const bucket = ticketsByRegion.get(r) ?? [];
    bucket.push(t);
    ticketsByRegion.set(r, bucket);
  }

  const entries: QuotaStatusEntry[] = [];
  const currentByRegionName = new Map(
    currentPerRegion.map((row) => [row.region, row.current]),
  );
  for (const { region: r, open } of perRegion) {
    for (const q of open) {
      for (const pending of q.pending.requests) {
        entries.push({
          kind: 'request',
          cloud: CloudType.Azure,
          region: r,
          resourceName: q.resourceName,
          resourceKey: q.resourceKey,
          status: pending.status,
          requestedLimit: pending.requestedLimit,
          ...(pending.providerRequestId && {
            providerRequestId: pending.providerRequestId,
          }),
          requestedAt: pending.submitTime.toISOString(),
        });
      }
    }
    for (const t of ticketsByRegion.get(r.toLowerCase()) ?? []) {
      const parsed = parseQuotaTicketDescription(t.description);
      entries.push({
        kind: 'request',
        cloud: CloudType.Azure,
        region: r,
        resourceName: parsed?.seriesName ?? t.title,
        ...(parsed?.resourceKey && { resourceKey: parsed.resourceKey }),
        status: t.status,
        requestedLimit: parsed?.requestedLimit ?? 0,
        requestId: t.ticketId,
        requestedAt: t.created.toISOString(),
        url: azurePortalSupportUrl(t.ticketId),
      });
    }
    for (const q of currentByRegionName.get(r) ?? []) {
      entries.push({
        kind: 'current',
        cloud: CloudType.Azure,
        region: r,
        resourceName: q.resourceName,
        resourceKey: q.resourceKey,
        status: QuotaProviderStatus.Current,
        currentLimit: q.limit,
      });
    }
  }
  // Keep useful partial regional results, but never cache failed reads as an
  // empty success or present request history as a successful current-quota read.
  if (
    failures.length > 0 &&
    (entries.length === 0 ||
      (currentReadFailed &&
        currentPerRegion.every(({ current }) => current.length === 0)))
  ) {
    throw new Error(
      `Azure quota status unavailable for ${region ?? 'all regions'}: ${errorMessage(failures[0])}`,
    );
  }
  return [...entries, ...unavailable];
}
