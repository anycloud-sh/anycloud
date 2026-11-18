import {
  type QuotaRequestEntry,
  type QuotaStatusEntry,
} from '../../../shared/api-contract/quota-schemas.js';
import { CloudType } from '../../../shared/cloud.js';
import {
  QuotaOperationTargetStatus,
  QuotaProviderStatus,
  QuotaRequestStatus,
} from '../../../shared/quota.js';
import {
  resolveQuotaResourcesForTarget,
  quotaStatusResourceKey,
} from '../../../shared/quota-groups.js';
import {
  parseStoredQuotaRequestEntries,
  type QuotaStatusOperationTargetRow,
} from '../repositories/quota-operations.js';

const COMPLETED_STATUS_BRIDGE_STATUSES = new Set<QuotaRequestStatus>([
  QuotaRequestStatus.Submitted,
  QuotaRequestStatus.Watching,
  QuotaRequestStatus.TimedOut,
  QuotaRequestStatus.Approved,
]);

function statusForTarget(
  status: Exclude<
    QuotaOperationTargetStatus,
    QuotaOperationTargetStatus.Completed
  >,
): QuotaProviderStatus.Queued | QuotaProviderStatus.Running {
  return status === QuotaOperationTargetStatus.Running
    ? QuotaProviderStatus.Running
    : QuotaProviderStatus.Queued;
}

export function plannedQuotaStatusEntriesForTarget(
  target: QuotaStatusOperationTargetRow,
): QuotaStatusEntry[] {
  const status = target.status;
  if (status === QuotaOperationTargetStatus.Completed) return [];

  const cloud = target.operation_cloud_provider;
  return resolveQuotaResourcesForTarget({
    cloud,
    vmType: target.vm_type,
    spot: target.spot === 1,
    includePublicIpQuota:
      cloud === CloudType.Azure
        ? target.include_public_ip_quota !== 0
        : target.include_public_ip_quota === 1,
  }).map((resource) => ({
    kind: 'request',
    source: 'local_operation',
    cloud,
    region: target.region,
    resourceName: resource.name,
    resourceKey: resource.key,
    status: statusForTarget(status),
    requestId: target.operation_id,
    requestedAt: new Date(target.operation_created_at).toISOString(),
    operationId: target.operation_id,
    operationTargetId: target.id,
    vmType: target.vm_type,
    spot: target.spot === 1,
  }));
}

export function canceledQuotaStatusEntriesForTarget(
  target: QuotaStatusOperationTargetRow,
): QuotaStatusEntry[] {
  if (!target.error?.startsWith('Canceled:')) return [];
  return targetResources(target).map((resource) => ({
    kind: 'request',
    source: 'local_operation',
    cloud: target.operation_cloud_provider,
    region: target.region,
    resourceName: resource.name,
    resourceKey: resource.key,
    status: 'CANCELED',
    requestId: target.operation_id,
    requestedAt: new Date(target.operation_created_at).toISOString(),
    operationId: target.operation_id,
    operationTargetId: target.id,
    vmType: target.vm_type,
    spot: target.spot === 1,
    message: target.error ?? undefined,
  }));
}

function targetResources(target: QuotaStatusOperationTargetRow) {
  const cloud = target.operation_cloud_provider;
  return resolveQuotaResourcesForTarget({
    cloud,
    vmType: target.vm_type,
    spot: target.spot === 1,
    includePublicIpQuota:
      cloud === CloudType.Azure
        ? target.include_public_ip_quota !== 0
        : target.include_public_ip_quota === 1,
  });
}

function completedEntryResourceKey(
  target: QuotaStatusOperationTargetRow,
  entry: QuotaRequestEntry,
): string {
  const resources = targetResources(target);
  if (target.operation_cloud_provider === CloudType.AWS && resources[0]) {
    return resources[0].key;
  }

  const entryKey = quotaStatusResourceKey({
    cloud: target.operation_cloud_provider,
    region: entry.region || target.region,
    resourceName: entry.resourceName,
    ...(entry.resourceKey && { resourceKey: entry.resourceKey }),
    status: entry.status,
  });
  return (
    resources.find(
      (resource) =>
        resource.key === entryKey ||
        // Keep generic compute display/provider-name recovery, but never use
        // a planned Network label to reconstruct a historical public-IP key.
        (resource.kind !== 'network' &&
          (resource.name === entry.resourceName ||
            resource.providerId === entry.resourceName)),
    )?.key ?? entryKey
  );
}

function completedEntryResourceName(
  target: QuotaStatusOperationTargetRow,
  entry: QuotaRequestEntry,
): string {
  if (target.operation_cloud_provider === CloudType.AWS) {
    return targetResources(target)[0]?.name ?? entry.resourceName;
  }
  return entry.resourceName;
}

export function completedQuotaStatusEntriesForTarget(
  target: QuotaStatusOperationTargetRow,
): QuotaStatusEntry[] {
  if (target.status !== QuotaOperationTargetStatus.Completed) return [];

  return parseStoredQuotaRequestEntries(
    target.entries_json,
    target.operation_cloud_provider,
  )
    .filter((entry) => COMPLETED_STATUS_BRIDGE_STATUSES.has(entry.status))
    .map((entry) => {
      const statusEntry: QuotaStatusEntry = {
        kind: 'request',
        source: 'local_operation',
        cloud: target.operation_cloud_provider,
        region: entry.region || target.region,
        resourceName: completedEntryResourceName(target, entry),
        resourceKey: completedEntryResourceKey(target, entry),
        status: entry.status,
        requestId: entry.requestId ?? target.operation_id,
        requestedAt: new Date(target.operation_created_at).toISOString(),
        operationId: target.operation_id,
        operationTargetId: target.id,
        vmType: target.vm_type,
        spot: target.spot === 1,
        previousLimit: entry.previousLimit,
        requestedLimit: entry.requestedLimit,
        grantedLimit: entry.grantedLimit,
        ...(entry.providerRequestId && {
          providerRequestId: entry.providerRequestId,
        }),
        ...(entry.providerCaseId && { providerCaseId: entry.providerCaseId }),
        ...(entry.url && { url: entry.url }),
      };
      return statusEntry;
    });
}
