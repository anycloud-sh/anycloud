import { type QuotaStatusEntry } from '../../../src/shared/api-contract/quota-schemas.js';
import { CloudType } from '../../../src/shared/cloud.js';

export function entry(overrides: Partial<QuotaStatusEntry>): QuotaStatusEntry {
  return {
    cloud: CloudType.AWS,
    region: 'us-east-1',
    resourceName: 'All P Spot Instance Requests',
    status: 'CASE_OPENED',
    requestedLimit: 96,
    requestId: 'r-1',
    requestedAt: '2026-06-04T20:00:00.000Z',
    ...overrides,
  };
}

export function current(
  overrides: Partial<QuotaStatusEntry>,
): QuotaStatusEntry {
  return {
    kind: 'current',
    cloud: CloudType.AWS,
    region: 'us-east-1',
    resourceName: 'All P Spot Instance Requests',
    status: 'CURRENT',
    currentLimit: 0,
    ...overrides,
  };
}

export function local(overrides: Partial<QuotaStatusEntry>): QuotaStatusEntry {
  return {
    kind: 'request',
    source: 'local_operation',
    cloud: CloudType.AWS,
    region: 'us-east-1',
    resourceName: 'All P Spot Instance Requests',
    resourceKey: 'aws:l-7212ccbc',
    status: 'QUEUED',
    requestId: 'quota-local',
    operationId: 'quota-local',
    operationTargetId: 'quota-target-local',
    vmType: 'p5.48xlarge',
    spot: true,
    ...overrides,
  };
}
