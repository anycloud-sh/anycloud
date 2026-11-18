import { type QuotaStatusEntry } from '../../../shared/api-contract/quota-schemas.js';
import {
  CloudType,
  type AWSCreds,
  type AzureConnectionCreds,
  type CloudCredentials,
} from '../../../shared/cloud.js';
import { QuotaProviderStatus } from '../../../shared/quota.js';
import { resolveCredentialByName } from '../cloud-config.js';
import { ensureCatalogBootstrapped } from '../../../shared/catalog/index.js';
import { InvalidAnycloudConfigError } from '../../../shared/errors.js';
import type { QuotaProvider } from './types.js';
import { awsQuotaStatus } from './aws.js';
import { azureQuotaStatus } from './azure.js';
import { listQuotaStatusOperationTargets } from '../repositories/quota-operations.js';
import { resolveOwnershipScope } from '../repositories/api-access-policy.js';
import {
  canceledQuotaStatusEntriesForTarget,
  completedQuotaStatusEntriesForTarget,
  plannedQuotaStatusEntriesForTarget,
} from './groups.js';
import { quotaStatusResourceKey } from '../../../shared/quota-groups.js';
import { CandidatePreflightCache } from '../candidate-preflight-cache.js';
import { log } from '../logger.js';
import type { User } from '../entities.js';

const PROVIDER_QUOTA_STATUS_CACHE_TTL_MS = 300_000;
export const PROVIDER_QUOTA_STATUS_INCOMPLETE_TTL_MS = 30_000;
const PROVIDER_QUOTA_STATUS_MAX_PENDING_SHARE_MS = 30_000;
const PROVIDER_QUOTA_STATUS_WAIT_MS = 120_000;

const providerQuotaStatusCache = new CandidatePreflightCache<
  QuotaStatusEntry[]
>();

export function clearProviderQuotaStatusCacheForTests(): void {
  providerQuotaStatusCache.clear();
}

/**
 * Which clouds support provider quota status reads, and how to build a
 * QuotaProvider from decrypted credentials. This is the single source of truth for
 * "does this cloud support quota": a cloud is supported iff it is in this map.
 * Quota is account-level — not a compute-gateway capability — so the handler
 * reaches the provider directly, with no gateway construction. Adding a cloud =
 * one entry.
 */
const QUOTA_PROVIDERS: Partial<
  Record<CloudType, (creds: CloudCredentials) => QuotaProvider>
> = {
  // The registry key already fixes the cloud, but the decrypted blob carries no
  // runtime discriminant (cloudProvider lives in the DB column, not the creds),
  // so the cloud-specific narrowing is a boundary cast — the same one the
  // gateway constructors make (`awsConfig.credentials as AWSCreds`).
  [CloudType.AWS]: (creds) => {
    const awsCreds = creds as AWSCreds;
    return {
      getQuotaStatus: (region) => awsQuotaStatus(awsCreds, region),
    };
  },
  [CloudType.Azure]: (creds) => {
    const azureCreds = creds as AzureConnectionCreds;
    return {
      getQuotaStatus: (region) => azureQuotaStatus(azureCreds, region),
    };
  },
};

interface ResolvedQuotaCredential {
  name: string;
  creds: CloudCredentials;
}

function requireCredentialName(credentialName: string | undefined): string {
  if (!credentialName || credentialName.trim() === '') {
    throw new InvalidAnycloudConfigError(
      'credentialName is required for quota status.',
    );
  }
  return credentialName;
}

async function resolveCredential(
  cloud: CloudType,
  credentialName: string,
): Promise<ResolvedQuotaCredential> {
  const row = await resolveCredentialByName(credentialName);
  if (!row) {
    throw new InvalidAnycloudConfigError(
      `Credential "${credentialName}" not found`,
    );
  }
  if (row.cloudProvider !== cloud) {
    throw new InvalidAnycloudConfigError(
      `Credential "${credentialName}" is for ${row.cloudProvider}, not ${cloud}`,
    );
  }
  return {
    name: credentialName,
    creds: row.creds,
  };
}

function isCurrentQuotaStatusEntry(entry: QuotaStatusEntry): boolean {
  return (
    entry.kind === 'current' ||
    ((entry.status || '').toUpperCase() === QuotaProviderStatus.Current &&
      typeof entry.currentLimit === 'number')
  );
}

const TERMINAL_PROVIDER_QUOTA_STATUSES = new Set<string>([
  QuotaProviderStatus.Approved,
  'CASE_CLOSED',
  'CANCELED',
  'CANCELLED',
  'CLOSED',
  QuotaProviderStatus.Denied,
  'FAILED',
  'INVALID_REQUEST',
  'NOT_APPROVED',
  QuotaProviderStatus.Partial,
  'REJECTED',
  'SUCCEEDED',
]);

function isActiveProviderQuotaStatusEntry(entry: QuotaStatusEntry): boolean {
  if (isCurrentQuotaStatusEntry(entry)) return false;
  return !TERMINAL_PROVIDER_QUOTA_STATUSES.has(
    (entry.status || '').toUpperCase(),
  );
}

function quotaStatusMergeKey(entry: QuotaStatusEntry): string {
  return `${entry.cloud}:${entry.region}:${quotaStatusResourceKey(entry)}`;
}

function withResourceKey(entry: QuotaStatusEntry): QuotaStatusEntry {
  return {
    ...entry,
    resourceKey: quotaStatusResourceKey(entry),
  };
}

function providerIdentityValues(entry: QuotaStatusEntry): Set<string> {
  return new Set(
    [entry.providerRequestId, entry.providerCaseId, entry.requestId].filter(
      (value): value is string => Boolean(value),
    ),
  );
}

function localProviderIdentityValues(entry: QuotaStatusEntry): Set<string> {
  return new Set(
    [entry.providerRequestId, entry.providerCaseId, entry.requestId].filter(
      (value): value is string =>
        Boolean(value) &&
        value !== entry.operationId &&
        value !== entry.operationTargetId,
    ),
  );
}

function hasMatchingProviderIdentity(
  providerEntry: QuotaStatusEntry,
  localEntry: QuotaStatusEntry,
): boolean {
  const providerIds = providerIdentityValues(providerEntry);
  for (const value of localProviderIdentityValues(localEntry)) {
    if (providerIds.has(value)) return true;
  }
  return false;
}

function requestedAtMs(entry: QuotaStatusEntry): number | undefined {
  if (!entry.requestedAt) return undefined;
  const ms = new Date(entry.requestedAt).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function providerRequestMatchesCompletedLocal(
  providerEntry: QuotaStatusEntry,
  localEntry: QuotaStatusEntry,
): boolean {
  if (hasMatchingProviderIdentity(providerEntry, localEntry)) return true;
  if (quotaStatusMergeKey(providerEntry) !== quotaStatusMergeKey(localEntry)) {
    return false;
  }

  const providerRequestedAt = requestedAtMs(providerEntry);
  const localRequestedAt = requestedAtMs(localEntry);
  return (
    providerRequestedAt !== undefined &&
    localRequestedAt !== undefined &&
    providerRequestedAt >= localRequestedAt
  );
}

function isCompletedLocalStatusEntry(entry: QuotaStatusEntry): boolean {
  return (
    entry.source === 'local_operation' &&
    entry.status !== QuotaProviderStatus.Queued &&
    entry.status !== QuotaProviderStatus.Running
  );
}

function mergeQuotaStatusEntries(
  providerEntries: QuotaStatusEntry[],
  localEntries: QuotaStatusEntry[],
): QuotaStatusEntry[] {
  const provider = providerEntries.map((entry) =>
    entry.kind === 'unavailable' ? entry : withResourceKey(entry),
  );
  const providerRequests = provider.filter(
    (entry) =>
      entry.kind !== 'unavailable' && !isCurrentQuotaStatusEntry(entry),
  );
  const providerCurrent = provider.filter(isCurrentQuotaStatusEntry);
  const unavailable = provider.filter((entry) => entry.kind === 'unavailable');

  const activeProviderRequestKeys = new Set(
    providerRequests
      .filter(isActiveProviderQuotaStatusEntry)
      .map(quotaStatusMergeKey),
  );
  const local = localEntries.map(withResourceKey).filter((entry) => {
    if (entry.status === 'CANCELED') return true;
    if (isCompletedLocalStatusEntry(entry)) {
      return !providerRequests.some((providerEntry) =>
        providerRequestMatchesCompletedLocal(providerEntry, entry),
      );
    }
    return !activeProviderRequestKeys.has(quotaStatusMergeKey(entry));
  });

  return [...providerRequests, ...local, ...providerCurrent, ...unavailable];
}

export interface HandleQuotaStatusOptions {
  providerWaitMs?: number;
  failOpenProviderStatus?: boolean;
}

async function readProviderQuotaStatusCached(input: {
  ownerUserId: string;
  cloud: CloudType;
  credentialName: string;
  region: string | undefined;
  provider: QuotaProvider;
  options: HandleQuotaStatusOptions;
}): Promise<QuotaStatusEntry[]> {
  const waitTimeoutMs =
    input.options.providerWaitMs ?? PROVIDER_QUOTA_STATUS_WAIT_MS;
  const key = [
    'quota-status',
    input.ownerUserId,
    input.cloud,
    input.credentialName,
    input.region ?? 'all',
  ].join(':');
  let providerError: unknown;
  const entries = await providerQuotaStatusCache.get(
    key,
    `quota status ${input.cloud} ${input.region ?? 'all'}`,
    () => input.provider.getQuotaStatus(input.region),
    {
      ttlMs: PROVIDER_QUOTA_STATUS_CACHE_TTL_MS,
      maxPendingShareMs: PROVIDER_QUOTA_STATUS_MAX_PENDING_SHARE_MS,
      waitTimeoutMs,
      shouldCache: Array.isArray,
      // A read with an unavailable row (a new key propagating, a throttled
      // code) is kept briefly, so a retry soon reads again without
      // hammering a cloud that's already failing.
      ttlFor: (entries) =>
        entries.some((entry) => entry.kind === 'unavailable')
          ? PROVIDER_QUOTA_STATUS_INCOMPLETE_TTL_MS
          : PROVIDER_QUOTA_STATUS_CACHE_TTL_MS,
      onFailOpen: (err) => {
        providerError = err;
        log.debug('Quota status provider read failed open', {
          cloud: input.cloud,
          credentialName: input.credentialName,
          region: input.region,
          waitTimeoutMs,
          error: err,
        });
      },
    },
  );

  if (entries) return entries;
  if (input.options.failOpenProviderStatus) return [];
  if (providerError instanceof Error) throw providerError;
  throw new Error('Quota status provider read failed.');
}

export async function handleQuotaStatus(
  user: Pick<User, 'id' | 'username'>,
  cloud: CloudType,
  credentialName: string | undefined,
  region: string | undefined,
  options: HandleQuotaStatusOptions = {},
): Promise<QuotaStatusEntry[]> {
  const makeProvider = QUOTA_PROVIDERS[cloud];
  if (!makeProvider) {
    throw new InvalidAnycloudConfigError(
      `Quota status is not supported for ${cloud}.`,
    );
  }
  // The no-region read enumerates this cloud's catalog regions via getRegions();
  // make sure the catalog is on disk first. The API fetches catalogs in the
  // background on startup, so an early call could otherwise race that fetch and
  // throw "No catalog data". Only the requested cloud, so an unrelated cloud's
  // catalog failure can't fail this request. No-op once present.
  const requiredCredentialName = requireCredentialName(credentialName);
  if (!region) await ensureCatalogBootstrapped(cloud);
  const resolved = await resolveCredential(cloud, requiredCredentialName);
  const provider = makeProvider(resolved.creds);
  const scope = await resolveOwnershipScope();
  const [providerEntries, statusTargets] = await Promise.all([
    readProviderQuotaStatusCached({
      ownerUserId: user.id,
      cloud,
      credentialName: resolved.name,
      region,
      provider,
      options,
    }),
    listQuotaStatusOperationTargets({
      scope,
      cloud,
      credentialName: resolved.name,
      ...(region && { region }),
    }),
  ]);
  const localEntries = statusTargets.flatMap((target) => [
    ...plannedQuotaStatusEntriesForTarget(target),
    ...canceledQuotaStatusEntriesForTarget(target),
    ...completedQuotaStatusEntriesForTarget(target),
  ]);
  return mergeQuotaStatusEntries(providerEntries, localEntries);
}

export async function handleCanceledQuotaStatus(): Promise<QuotaStatusEntry[]> {
  const scope = await resolveOwnershipScope();
  const targets = await listQuotaStatusOperationTargets({
    scope,
    canceledOnly: true,
  });
  return targets.flatMap(canceledQuotaStatusEntriesForTarget);
}
