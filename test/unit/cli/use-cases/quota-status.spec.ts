import { describe, it, expect, vi } from 'vitest';
import {
  parseQuotaName,
  quotaBucket,
  filterStatusEntriesByQuotaType,
  quotaStatusView,
  readQuotaStatus,
  type QuotaStatusClient,
} from '../../../../src/cli/use-cases/quota-status.js';
import { CloudType } from '../../../../src/shared/cloud.js';
import { current, entry, local } from '../../helpers/quota-status-entries.js';

describe('parseQuotaName', () => {
  it('parses AWS spot family names', () => {
    expect(parseQuotaName('All G and VT Spot Instance Requests')).toEqual({
      family: 'G and VT',
      spot: true,
      matched: true,
    });
  });

  it('parses AWS on-demand family names', () => {
    expect(parseQuotaName('Running On-Demand G and VT instances')).toEqual({
      family: 'G and VT',
      spot: false,
      matched: true,
    });
  });

  it('strips the Standard letter list in both shapes', () => {
    expect(
      parseQuotaName(
        'All Standard (A, C, D, H, I, M, R, T, Z) Spot Instance Requests',
      ),
    ).toEqual({ family: 'Standard', spot: true, matched: true });
    expect(
      parseQuotaName(
        'Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances',
      ),
    ).toEqual({ family: 'Standard', spot: false, matched: true });
  });

  it('passes other clouds through verbatim', () => {
    expect(parseQuotaName('Standard NCads H100 v5 Family vCPUs')).toEqual({
      family: 'Standard NCads H100 v5 Family vCPUs',
      spot: false,
      matched: false,
    });
  });
});

describe('quotaBucket', () => {
  it.each([
    ['APPROVED', 'approved'],
    ['PARTIAL', 'partial'],
    ['DENIED', 'denied'],
    ['Failed', 'denied'],
    ['NOT_APPROVED', 'denied'],
    ['INVALID_REQUEST', 'denied'],
    ['CASE_OPENED', 'open'],
    ['InProgress', 'open'],
    ['Accepted', 'open'],
    ['Open', 'open'],
    ['', 'open'],
  ])('buckets %s as %s', (status, bucket) => {
    expect(quotaBucket(entry({ status }))).toBe(bucket);
  });
});

describe('filterStatusEntriesByQuotaType', () => {
  const azureCurrent = (resourceName: string, resourceKey: string) =>
    current({
      cloud: CloudType.Azure,
      region: 'eastus',
      resourceName,
      resourceKey,
    });

  const family = azureCurrent(
    'Standard NCASv3_T4 Family vCPUs',
    'azure:standardncasv3_t4family',
  );
  const spotAggregate = azureCurrent(
    'Total Regional Low-priority vCPUs',
    'azure:lowprioritycores',
  );
  const cores = azureCurrent('Total Regional vCPUs', 'azure:cores');
  const publicIp = azureCurrent(
    'Public IP Addresses - Standard',
    'azure:standardskupublicipaddresses',
  );

  // A family request from a historical spot-filed operation: the stored spot
  // flag records filed intent, but the quota it requested gates only
  // on-demand launches, so it belongs to the on-demand view.
  const historicalSpotFamily = local({
    cloud: CloudType.Azure,
    region: 'eastus',
    resourceName: 'Standard NCASv3_T4 Family vCPUs',
    resourceKey: 'azure:standardncasv3_t4family',
    vmType: 'Standard_NC4as_T4_v3',
  });

  it('scopes an Azure spot view to the quotas that gate spot', () => {
    expect(
      filterStatusEntriesByQuotaType(
        [family, spotAggregate, cores, publicIp, historicalSpotFamily],
        [true],
      ),
    ).toEqual([spotAggregate, publicIp]);
  });

  it('keeps family, cores, and public IP rows in an Azure on-demand view', () => {
    expect(
      filterStatusEntriesByQuotaType(
        [family, spotAggregate, cores, publicIp, historicalSpotFamily],
        [false],
      ),
    ).toEqual([family, cores, publicIp, historicalSpotFamily]);
  });

  it('keeps a failed scope read in both views', () => {
    const scope = {
      kind: 'unavailable' as const,
      cloud: CloudType.Azure,
      region: 'eastus',
      resourceName: 'Compute usages',
      status: 'UNAVAILABLE',
      message: 'NoRegisteredProviderFound',
    };
    for (const spot of [true, false])
      expect(filterStatusEntriesByQuotaType([family, scope], [spot])).toContain(
        scope,
      );
  });
});

describe('readQuotaStatus', () => {
  const spot = entry({});
  const onDemand = entry({ resourceName: 'Running On-Demand P instances' });
  const client = {
    quota: {
      status: vi.fn(async () => ({ entries: [spot, onDemand] })),
      canceled: vi.fn(async () => ({ entries: [onDemand] })),
    },
  };
  const read = (request: Parameters<typeof readQuotaStatus>[1]) =>
    readQuotaStatus(client as unknown as QuotaStatusClient, request);

  it('reads canceled local submissions without a status query', async () => {
    await expect(read({ canceled: true })).resolves.toEqual([onDemand]);
    expect(client.quota.canceled).toHaveBeenCalledWith({});
    expect(client.quota.status).not.toHaveBeenCalled();
  });

  it('omits an absent region and applies the quota-type filter', async () => {
    const target = { cloud: CloudType.AWS, credentialName: 'prod' };
    await expect(read({ ...target, spotValues: [true] })).resolves.toEqual([
      spot,
    ]);
    expect(client.quota.status).toHaveBeenLastCalledWith({ query: target });
    await read({ ...target, region: 'us-west-2' });
    expect(client.quota.status).toHaveBeenLastCalledWith({
      query: { ...target, region: 'us-west-2' },
    });
  });
});

describe('quotaStatusView', () => {
  const canceled = (overrides: Parameters<typeof local>[0]) =>
    local({ status: 'CANCELED', ...overrides });

  it('orders AWS sections and groups canceled targets and unavailable scopes', () => {
    const unavailable = entry({ kind: 'unavailable', region: 'eu-west-1' });
    const a = canceled({ resourceName: 'All P Spot Instance Requests' });
    const b = canceled({ resourceName: 'All G and VT Spot Instance Requests' });
    const c = canceled({ operationTargetId: undefined, operationId: 'op-2' });
    const view = quotaStatusView([
      entry({ status: 'APPROVED' }),
      entry({
        resourceName: 'Running On-Demand P instances',
        status: 'DENIED',
      }),
      entry({ resourceName: 'Custom quota' }),
      unavailable,
      a,
      b,
      c,
    ]);
    expect(view.sections.map((section) => section.label)).toEqual([
      'SPOT',
      'ON-DEMAND',
      'OTHER',
    ]);
    expect(view.summary).toBe('requests');
    expect(view.counts).toEqual({
      approved: 1,
      partial: 0,
      denied: 1,
      open: 1,
    });
    expect(view.canceledTargets).toEqual([[a, b], [c]]);
    expect(view.unavailable).toEqual([unavailable]);
  });

  it('drops empty AWS sections', () => {
    const view = quotaStatusView([
      entry({ resourceName: 'Running On-Demand P instances' }),
    ]);
    expect(view.sections.map((section) => section.label)).toEqual([
      'ON-DEMAND',
    ]);
  });

  it('keeps one unlabeled section of current limits for other clouds', () => {
    const azure = (currentLimit: number) =>
      current({
        cloud: CloudType.Azure,
        region: 'eastus',
        resourceName: 'Total Regional vCPUs',
        resourceKey: 'azure:cores',
        currentLimit,
      });
    const view = quotaStatusView([azure(0)]);
    expect(view.sections.map((section) => section.label)).toEqual([undefined]);
    expect(view.summary).toBe('zero-current');
    expect(quotaStatusView([azure(8)]).summary).toBe('current');
  });
});
