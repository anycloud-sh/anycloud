import type { QuotaStatusEntry } from '../../shared/api-contract/quota-schemas.js';
import type { CloudType } from '../../shared/cloud.js';
import { QuotaProviderStatus } from '../../shared/quota.js';
import {
  quotaStatusResourceKey,
  quotaStatusEntrySpot,
} from '../../shared/quota-groups.js';
import { AZURE_QUOTA_RESOURCE_KEYS } from '../../shared/quota-resolvers/azure-identity.js';
import { parseAwsResourceName } from '../../shared/quota-resolvers/aws.js';
import type { ApiClient } from '../../shared/services/api-client/rpc.js';

export interface QuotaStatusClient {
  quota: Pick<ApiClient['quota'], 'status' | 'canceled'>;
}

export type QuotaStatusTarget = {
  cloud: CloudType;
  credentialName: string;
  region?: string;
  spotValues?: boolean[];
};

export type QuotaStatusRequest = { canceled: true } | QuotaStatusTarget;

export function filterStatusEntriesByQuotaType(
  entries: QuotaStatusEntry[],
  spotValues: boolean[] | undefined,
): QuotaStatusEntry[] {
  if (!spotValues || spotValues.length !== 1) return entries;
  const selectedSpot = spotValues[0];
  return entries.filter((entry) => {
    // A failed read of a whole scope gates both views.
    if (entry.kind === 'unavailable' && !entry.resourceKey) return true;
    const entrySpot = quotaStatusEntrySpot(entry);
    return entrySpot === undefined || entrySpot === selectedSpot;
  });
}

// Single source of truth for a quota resource's display family, keyed by the
// stable resourceKey with the provider display name as fallback. Both the
// status matrix and the region-picker hints derive their labels from here so
// the two surfaces cannot drift apart. parseQuotaName returns the raw name as
// `family` when it doesn't match, so the fallback preserves prior behavior.
function quotaDisplayFamily(resourceKey: string, resourceName: string): string {
  if (resourceKey === AZURE_QUOTA_RESOURCE_KEYS.standardSkuPublicIpAddresses) {
    return 'Public IPs';
  }
  if (resourceKey === AZURE_QUOTA_RESOURCE_KEYS.basicPublicIpAddresses) {
    return 'Basic Public IPs';
  }
  return parseQuotaName(resourceName).family;
}

/**
 * AWS Service Quotas names come in two shapes — spot: "All <family> Spot
 * Instance Requests", on-demand: "Running On-Demand <family> instances" (the
 * Standard family carries a letter list: "Standard (A, C, ...)"). Parse out
 * the family key and spot flag. Names from other clouds (e.g. Azure's
 * "Standard NCads H100 v5 Family vCPUs") pass through verbatim as their own
 * column with no spot flag — they already name their hardware.
 */
export function parseQuotaName(name: string): {
  family: string;
  spot: boolean;
  matched: boolean;
} {
  // Delegate to the resolver's single AWS name parser so the matrix/family
  // display and the resourceKey/spot derivation can never drift apart.
  const parsed = parseAwsResourceName(name);
  return parsed
    ? { family: parsed.family, spot: parsed.spot, matched: true }
    : { family: name, spot: false, matched: false };
}

/**
 * Status buckets for the matrix. Wider than statusToken's AWS-centric view:
 * AWS terminals NOT_APPROVED/INVALID_REQUEST and Azure's Failed are denials,
 * and Azure's InProgress/Accepted/Open (plus AWS CASE_OPENED/PENDING) are all
 * "open". Anything unrecognized counts as open rather than mislabeled.
 */
export type QuotaBucket = 'approved' | 'partial' | 'denied' | 'open';

const DENIED_STATUSES = new Set([
  QuotaProviderStatus.Denied,
  'FAILED',
  'NOT_APPROVED',
  'INVALID_REQUEST',
]);

export function quotaBucket(entry: QuotaStatusEntry): QuotaBucket {
  const status = (entry.status || '').toUpperCase();
  if (status === QuotaProviderStatus.Approved) return 'approved';
  if (status === QuotaProviderStatus.Partial) return 'partial';
  if (DENIED_STATUSES.has(status)) return 'denied';
  return 'open';
}

export function isCurrentStatusEntry(entry: QuotaStatusEntry): boolean {
  return (
    entry.kind === 'current' ||
    ((entry.status || '').toUpperCase() === QuotaProviderStatus.Current &&
      typeof entry.currentLimit === 'number')
  );
}

export function isLocalOperationStatusEntry(entry: QuotaStatusEntry): boolean {
  return entry.source === 'local_operation';
}

function statusCellKey(entry: QuotaStatusEntry): string {
  const { spot } = parseQuotaName(entry.resourceName);
  return `${spot}:${entry.region}:${quotaStatusResourceKey(entry)}`;
}

export function statusCellValue(entry: QuotaStatusEntry): number {
  return isCurrentStatusEntry(entry)
    ? (entry.currentLimit ?? 0)
    : (entry.requestedLimit ?? 0);
}

/**
 * Latest entry per (offering, region, family) cell. Superseded duplicates
 * (e.g. ladder resubmits) are --json-only, and the summary counts must agree
 * with the cells the matrix shows, so dedupe once before either.
 */
function latestPerCell(entries: QuotaStatusEntry[]): QuotaStatusEntry[] {
  const cells = new Map<string, QuotaStatusEntry>();
  for (const entry of entries) {
    const key = statusCellKey(entry);
    const prev = cells.get(key);
    const submittedAt = entry.requestedAt
      ? new Date(entry.requestedAt).getTime()
      : 0;
    const prevSubmittedAt = prev?.requestedAt
      ? new Date(prev.requestedAt).getTime()
      : 0;
    if (!prev || submittedAt > prevSubmittedAt) {
      cells.set(key, entry);
    }
  }
  return [...cells.values()];
}

function visibleStatusEntries(allEntries: QuotaStatusEntry[]): {
  entries: QuotaStatusEntry[];
  requestEntries: QuotaStatusEntry[];
  currentEntries: QuotaStatusEntry[];
  showZeroCurrentLimits: boolean;
} {
  const requestEntries = latestPerCell(
    allEntries.filter((entry) => !isCurrentStatusEntry(entry)),
  );
  const currentEntries = latestPerCell(allEntries.filter(isCurrentStatusEntry));
  const requestKeys = new Set(requestEntries.map(statusCellKey));
  const hasNonZeroCurrent = currentEntries.some(
    (entry) => (entry.currentLimit ?? 0) > 0,
  );
  const showZeroCurrentLimits =
    requestEntries.length === 0 &&
    currentEntries.length > 0 &&
    !hasNonZeroCurrent;
  const visibleCurrent = currentEntries.filter((entry) => {
    if (requestKeys.has(statusCellKey(entry))) return false;
    const currentLimit = entry.currentLimit ?? 0;
    return showZeroCurrentLimits || currentLimit > 0;
  });
  return {
    entries: [...requestEntries, ...visibleCurrent],
    requestEntries,
    currentEntries,
    showZeroCurrentLimits,
  };
}

export type StatusMatrixFamily = {
  key: string;
  family: string;
  total: number;
};

export function matrixFamilyFor(entry: QuotaStatusEntry): StatusMatrixFamily {
  const resourceKey = quotaStatusResourceKey(entry);
  const family = quotaDisplayFamily(resourceKey, entry.resourceName);

  return {
    // Retain the display family as part of the column identity, then include
    // the stable resource key so distinct quota resources with the same
    // display name cannot overwrite one another.
    key: `${resourceKey}\0${family}`,
    family,
    total: 0,
  };
}

function awsCurrentFamiliesForSection(
  currentEntries: QuotaStatusEntry[],
  spot: boolean,
): string[] {
  return [
    ...new Set(
      currentEntries.flatMap((entry) => {
        const parsed = parseQuotaName(entry.resourceName);
        return parsed.matched && parsed.spot === spot ? [parsed.family] : [];
      }),
    ),
  ];
}

type QuotaStatusSection = {
  label?: string;
  entries: QuotaStatusEntry[];
  extraFamilies: string[];
};

export interface QuotaStatusView {
  entries: QuotaStatusEntry[];
  /** Request counts, current nonzero limits, or only zero current limits. */
  summary: 'requests' | 'current' | 'zero-current';
  counts: Record<QuotaBucket, number>;
  sections: QuotaStatusSection[];
  canceledTargets: QuotaStatusEntry[][];
  unavailable: QuotaStatusEntry[];
}

/**
 * What the status matrix shows: canceled local targets grouped for manual
 * follow-up, unavailable scopes, and the visible cells split into AWS spot and
 * on-demand sections (other clouds keep one section of provider quota names).
 */
export function quotaStatusView(
  allEntries: QuotaStatusEntry[],
): QuotaStatusView {
  const canceledTargets = new Map<string, QuotaStatusEntry[]>();
  for (const entry of allEntries) {
    if (entry.source !== 'local_operation' || entry.status !== 'CANCELED') {
      continue;
    }
    const key =
      entry.operationTargetId ??
      `${entry.operationId}:${entry.region}:${entry.vmType}`;
    canceledTargets.set(key, [...(canceledTargets.get(key) ?? []), entry]);
  }
  const visible = visibleStatusEntries(
    allEntries.filter(
      (entry) => entry.status !== 'CANCELED' && entry.kind !== 'unavailable',
    ),
  );
  const counts: Record<QuotaBucket, number> = {
    approved: 0,
    partial: 0,
    denied: 0,
    open: 0,
  };
  for (const entry of visible.requestEntries) counts[quotaBucket(entry)]++;
  const hasAwsStyleNames = visible.entries.some(
    (entry) => parseQuotaName(entry.resourceName).matched,
  );
  const awsSection = (spot: boolean, label: string): QuotaStatusSection => ({
    label,
    entries: visible.entries.filter((entry) => {
      const parsed = parseQuotaName(entry.resourceName);
      return parsed.matched && parsed.spot === spot;
    }),
    extraFamilies: awsCurrentFamiliesForSection(visible.currentEntries, spot),
  });
  const sections: QuotaStatusSection[] = hasAwsStyleNames
    ? [
        awsSection(true, 'SPOT'),
        awsSection(false, 'ON-DEMAND'),
        {
          label: 'OTHER',
          entries: visible.entries.filter(
            (entry) => !parseQuotaName(entry.resourceName).matched,
          ),
          extraFamilies: [],
        },
      ].filter((section) => section.entries.length > 0)
    : [{ entries: visible.entries, extraFamilies: [] }];
  const currentOnly =
    visible.requestEntries.length === 0 && visible.currentEntries.length > 0;
  return {
    entries: visible.entries,
    summary: !currentOnly
      ? 'requests'
      : visible.showZeroCurrentLimits
        ? 'zero-current'
        : 'current',
    counts,
    sections,
    canceledTargets: [...canceledTargets.values()],
    unavailable: allEntries.filter((entry) => entry.kind === 'unavailable'),
  };
}

export async function readQuotaStatus(
  client: QuotaStatusClient,
  request: QuotaStatusRequest,
): Promise<QuotaStatusEntry[]> {
  if ('canceled' in request) return (await client.quota.canceled({})).entries;
  const { cloud, credentialName, region, spotValues } = request;
  const response = await client.quota.status({
    query: { cloud, credentialName, ...(region && { region }) },
  });
  return filterStatusEntriesByQuotaType(response.entries, spotValues);
}
