import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  listMock,
  beginCreateMock,
  quotaCreateOrUpdateMock,
  quotaListMock,
  quotaUsagesListMock,
  quotaRequestStatusListMock,
  communicationsListMock,
  computeManagementClientMock,
  resourceProviderGetMock,
  resourceProviderRegisterMock,
} = vi.hoisted(() => {
  return {
    listMock: vi.fn(),
    beginCreateMock: vi.fn(),
    quotaCreateOrUpdateMock: vi.fn(),
    quotaListMock: vi.fn(),
    quotaUsagesListMock: vi.fn(),
    quotaRequestStatusListMock: vi.fn(),
    communicationsListMock: vi.fn(),
    computeManagementClientMock: vi.fn().mockImplementation(function () {
      return {
        usageOperations: { list: vi.fn() },
      };
    }),
    resourceProviderGetMock: vi.fn(),
    resourceProviderRegisterMock: vi.fn(),
  };
});

vi.mock('@azure/arm-support', () => ({
  MicrosoftSupport: vi.fn().mockImplementation(function () {
    return {
      supportTickets: {
        list: listMock,
        beginCreateAndWait: beginCreateMock,
      },
      communications: { list: communicationsListMock },
    };
  }),
}));

vi.mock('@azure/arm-quota', () => ({
  AzureQuotaExtensionAPI: vi.fn().mockImplementation(function () {
    return {
      quota: { list: quotaListMock, createOrUpdate: quotaCreateOrUpdateMock },
      usages: { list: quotaUsagesListMock },
      quotaRequestStatus: { list: quotaRequestStatusListMock },
    };
  }),
}));

vi.mock('@azure/arm-compute', () => ({
  ComputeManagementClient: computeManagementClientMock,
}));

vi.mock('@azure/arm-resources', () => ({
  ResourceManagementClient: vi.fn().mockImplementation(function () {
    return {
      providers: {
        get: resourceProviderGetMock,
        register: resourceProviderRegisterMock,
      },
    };
  }),
}));

vi.mock('@azure/identity', () => ({
  ClientSecretCredential: vi.fn(),
}));

vi.mock('../../../src/api/services/logger', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  AzureQuotaProvider,
  azureQuotaStatus,
  mergeAzureQuotaSources,
  parseQuotaTicketDescription,
  seriesNameFor,
} from '../../../src/api/services/quota/azure.js';
import type {
  AzurePendingReadState,
  AzureQuotaInfo,
  ReadOnlyAzureQuotaInfo,
  WritableAzureQuotaInfo,
} from '../../../src/api/services/quota/types.js';
import { CloudType } from '../../../src/shared/cloud.js';
import {
  azureQuotaResourceKey,
  createAzureQuotaIdentity,
  type AzureQuotaResourceKey,
} from '../../../src/shared/quota-resolvers/azure-identity.js';
import { AZURE_PUBLIC_IP_QUOTA_SCHEMA_DRIFT_EVENT_CODE } from '../../../src/shared/quota-resolvers/azure-public-ip.js';
import {
  AZURE_CANDIDATE_PREFLIGHT_REGION_TIMEOUT_MS,
  QUOTA_REGION_TIMEOUT_MS,
} from '../../../src/api/config.js';
import { internalsOf } from '../helpers/internals';

const creds = {
  directoryId: 'd',
  applicationId: 'a',
  secret: 's',
  subscriptionId: 'sub',
};

type CommonQuotaOverrides = Partial<
  Omit<
    AzureQuotaInfo,
    'providerId' | 'resourceKey' | 'writable' | 'pending' | 'scope'
  >
> & {
  resourceKey?: AzureQuotaResourceKey;
};

function readOnlyQuota(
  providerId: string,
  overrides: CommonQuotaOverrides = {},
): ReadOnlyAzureQuotaInfo {
  return {
    region: 'eastus',
    resourceName: providerId,
    ...createAzureQuotaIdentity(providerId),
    currentUsage: 0,
    limit: 0,
    unit: 'Count',
    writable: false,
    ...overrides,
  };
}

function writableQuota(
  providerId: string,
  overrides: CommonQuotaOverrides & {
    scope?: string;
    pending?: AzurePendingReadState;
  } = {},
): WritableAzureQuotaInfo {
  const { pending, scope, ...rest } = overrides;
  return {
    region: 'eastus',
    resourceName: providerId,
    ...createAzureQuotaIdentity(providerId),
    currentUsage: 0,
    limit: 0,
    unit: 'Count',
    ...rest,
    writable: true,
    scope: scope ?? 's',
    pending: pending ?? { requests: [], complete: true },
  };
}

function asyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const item of items) yield item;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('seriesNameFor', () => {
  it('strips Standard prefix and Family vCPUs suffix', () => {
    expect(seriesNameFor('Standard NCSv3 Family vCPUs')).toBe('NCSv3');
  });

  it('replaces underscores with spaces', () => {
    expect(seriesNameFor('NCASv3_Family')).toBe('NCASv3 Family');
  });

  it('returns input unchanged when no transforms apply', () => {
    expect(seriesNameFor('Plain')).toBe('Plain');
  });
});

describe('parseQuotaTicketDescription', () => {
  it('parses a well-formed description', () => {
    const parsed = parseQuotaTicketDescription(
      'Request Summary / New Limit: \nResource Manager, EASTUS, NCSv3 / 100',
    );
    expect(parsed).toEqual({
      region: 'EASTUS',
      seriesName: 'NCSv3',
      requestedLimit: 100,
    });
  });

  it('returns null on a non-matching string', () => {
    expect(parseQuotaTicketDescription('not a quota ticket')).toBeNull();
  });

  it('handles series names with spaces', () => {
    const parsed = parseQuotaTicketDescription(
      'Resource Manager, WESTUS2, NC6s v3 / 200',
    );
    expect(parsed).toEqual({
      region: 'WESTUS2',
      seriesName: 'NC6s v3',
      requestedLimit: 200,
    });
  });

  it('reads canonical and legacy metadata markers into the same key', () => {
    const canonical = parseQuotaTicketDescription(
      'Resource Manager, EASTUS, NCASv3 T4 / 8\n' +
        'AnyCloudQuotaResourceKey: Azure:Standard NCASv3_T4 Family',
    );
    const legacy = parseQuotaTicketDescription(
      'Resource Manager, EASTUS, NCASv3 T4 / 8\n' +
        'AnyCloudQuotaResource: Standard NCASv3_T4 Family',
    );

    expect(canonical?.resourceKey).toBe('azure:standardncasv3_t4family');
    expect(legacy?.resourceKey).toBe(canonical?.resourceKey);
  });

  it('keeps historical public-IP ticket markers on their old key', () => {
    const canonical = parseQuotaTicketDescription(
      'Resource Manager, EASTUS, Public IP Addresses / 200\n' +
        'AnyCloudQuotaResourceKey: azure:publicipaddresses',
    );
    const legacy = parseQuotaTicketDescription(
      'Resource Manager, EASTUS, Public IP Addresses / 200\n' +
        'AnyCloudQuotaResource: PublicIPAddresses',
    );

    expect(canonical?.resourceKey).toBe('azure:publicipaddresses');
    expect(legacy?.resourceKey).toBe(canonical?.resourceKey);
    expect(canonical?.resourceKey).not.toBe(
      'azure:standardskupublicipaddresses',
    );
  });
});

describe('mergeAzureQuotaSources', () => {
  it('merges by resourceKey with explicit source field ownership', () => {
    const pending = {
      complete: true,
      requests: [
        {
          requestedLimit: 128,
          status: 'InProgress',
          submitTime: new Date('2026-07-10T00:00:00Z'),
          providerRequestId: 'quota-request-1',
        },
      ],
    } satisfies AzurePendingReadState;
    const compute = readOnlyQuota('Standard NCASv3_T4 Family', {
      resourceName: 'Compute Usage display',
      currentUsage: 7,
      limit: 64,
      unit: 'Count',
    });
    const computeOnly = readOnlyQuota('computeOnlyFamily', { limit: 12 });
    const quota = writableQuota('StandardNCASv3_T4Family', {
      resourceName: 'Quota API display',
      currentUsage: 99,
      limit: 999,
      unit: 'DifferentUnit',
      scope: 'quota-scope',
      pending,
    });
    const quotaOnly = writableQuota('quotaOnlyFamily', {
      limit: 23,
      scope: 'quota-only-scope',
    });

    const result = mergeAzureQuotaSources(
      [compute, computeOnly],
      [quota, quotaOnly],
    );

    expect(result.map((row) => row.resourceKey)).toEqual([
      'azure:standardncasv3_t4family',
      'azure:computeonlyfamily',
      'azure:quotaonlyfamily',
    ]);
    expect(result[0]).toEqual({
      region: 'eastus',
      resourceName: 'Compute Usage display',
      providerId: 'StandardNCASv3_T4Family',
      resourceKey: 'azure:standardncasv3_t4family',
      currentUsage: 7,
      limit: 64,
      unit: 'Count',
      writable: true,
      scope: 'quota-scope',
      pending,
    });
    expect(result[1].writable).toBe(false);
    expect(result[2]).toBe(quotaOnly);
  });

  it('rejects duplicate identities within the Quota API source', () => {
    expect(() =>
      mergeAzureQuotaSources(
        [],
        [
          writableQuota('Standard NCASv3_T4 Family'),
          writableQuota('StandardNCASv3_T4Family'),
        ],
      ),
    ).toThrow('duplicate resource key');
  });
});

describe('AzureQuotaProvider.ensureProviderRegistered', () => {
  beforeEach(() => {
    resourceProviderGetMock.mockReset();
    resourceProviderRegisterMock.mockReset();
  });

  it('returns true when the provider is already registered', async () => {
    resourceProviderGetMock.mockResolvedValue({
      registrationState: 'Registered',
    });

    const provider = new AzureQuotaProvider(creds);

    await expect(
      provider.ensureProviderRegistered('Microsoft.Compute'),
    ).resolves.toBe(true);
    expect(resourceProviderRegisterMock).not.toHaveBeenCalled();
  });

  it('returns true after registration completes', async () => {
    vi.useFakeTimers();
    resourceProviderGetMock
      .mockResolvedValueOnce({ registrationState: 'NotRegistered' })
      .mockResolvedValueOnce({ registrationState: 'Registered' });
    resourceProviderRegisterMock.mockResolvedValue({});

    const onComputeRegistrationChanged = vi.fn();
    const provider = new AzureQuotaProvider(
      creds,
      onComputeRegistrationChanged,
    );
    const result = provider.ensureProviderRegistered('Microsoft.Compute');

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(result).resolves.toBe(true);
    expect(resourceProviderRegisterMock).toHaveBeenCalledWith(
      'Microsoft.Compute',
    );
    expect(onComputeRegistrationChanged).toHaveBeenCalledTimes(2);
  });

  it('returns false when registration does not complete before the deadline', async () => {
    vi.useFakeTimers();
    resourceProviderGetMock.mockResolvedValue({
      registrationState: 'Registering',
    });
    resourceProviderRegisterMock.mockResolvedValue({});

    const provider = new AzureQuotaProvider(creds);
    const result = provider.ensureProviderRegistered('Microsoft.Compute');

    await vi.advanceTimersByTimeAsync(130_000);

    await expect(result).resolves.toBe(false);
  });
});

describe('AzureQuotaProvider.getInsufficientQuotaRegions', () => {
  function withMergedQuotasByRegion(
    byRegion: Record<string, AzureQuotaInfo[]>,
  ): AzureQuotaProvider {
    const provider = new AzureQuotaProvider(creds);
    (provider as unknown as Record<string, unknown>).listMergedQuotas = vi
      .fn()
      .mockImplementation(async (region: string) => byRegion[region] ?? []);
    return provider;
  }

  it('keeps spot regions with both family and LowPriorityCores headroom', async () => {
    const provider = withMergedQuotasByRegion({
      eastus: [
        readOnlyQuota('standardncadsh100v5family', {
          resourceName: 'NC H100',
          limit: 40,
        }),
        readOnlyQuota('lowPriorityCores', {
          resourceName: 'Low Priority Cores',
          limit: 40,
        }),
      ],
    });

    const result = await provider.getInsufficientQuotaRegions(
      azureQuotaResourceKey('standardncadsh100v5family'),
      40,
      true,
      ['eastus'],
    );

    expect(result).toEqual({
      insufficientRegions: new Set(),
      unknownRegions: new Set(),
      complete: true,
    });
  });

  it('drops spot regions whose LowPriorityCores quota cannot fit the VM', async () => {
    const provider = withMergedQuotasByRegion({
      australiaeast: [
        readOnlyQuota('standardncadsh100v5family', {
          region: 'australiaeast',
          resourceName: 'NC H100',
          limit: 80,
        }),
        readOnlyQuota('lowPriorityCores', {
          region: 'australiaeast',
          resourceName: 'Low Priority Cores',
          limit: 3,
        }),
      ],
    });

    const result = await provider.getInsufficientQuotaRegions(
      azureQuotaResourceKey('standardncadsh100v5family'),
      40,
      true,
      ['australiaeast'],
    );

    expect(result).toEqual({
      insufficientRegions: new Set(['australiaeast']),
      unknownRegions: new Set(),
      complete: true,
    });
  });

  it('keeps spot regions whose family quota is exhausted when LowPriorityCores has headroom', async () => {
    // Live-verified against ARM preflight: a family limit of 0 rejects an
    // on-demand workload but not a spot one — spot draws only from the
    // regional low-priority pool.
    const provider = withMergedQuotasByRegion({
      eastus: [
        readOnlyQuota('Standard NCASv3_T4 Family', {
          resourceName: 'Standard NCASv3_T4 Family vCPUs',
          limit: 0,
        }),
        readOnlyQuota('lowPriorityCores', {
          resourceName: 'Total Regional Low-priority vCPUs',
          limit: 64,
        }),
      ],
    });

    const result = await provider.getInsufficientQuotaRegions(
      azureQuotaResourceKey('standardncasv3_t4family'),
      4,
      true,
      ['eastus'],
    );

    expect(result).toEqual({
      insufficientRegions: new Set(),
      unknownRegions: new Set(),
      complete: true,
    });
  });

  it('drops regions where Azure does not report the VM family quota', async () => {
    const provider = withMergedQuotasByRegion({
      uaenorth: [
        readOnlyQuota('lowPriorityCores', {
          region: 'uaenorth',
          resourceName: 'Low Priority Cores',
          limit: 80,
        }),
      ],
    });

    const result = await provider.getInsufficientQuotaRegions(
      azureQuotaResourceKey('standardncadsh100v5family'),
      40,
      true,
      ['uaenorth'],
    );

    expect(result).toEqual({
      insufficientRegions: new Set(['uaenorth']),
      unknownRegions: new Set(),
      complete: true,
    });
  });

  it('keeps a region whose family quota Azure reports with spaces in the name', async () => {
    // Azure's usage API is inconsistent about whitespace across families —
    // live data for NCASv3_T4 (Standard_NC4as_T4_v3) comes back as "Standard
    // NCASv3_T4 Family" while otherwise-identical families like NCADS_A100_v4
    // come back as "StandardNCADSA100v4Family". The catalog/live-SKU-derived
    // family key is always space-free ("standardncasv3_t4family").
    const provider = withMergedQuotasByRegion({
      westus2: [
        readOnlyQuota('Standard NCASv3_T4 Family', {
          region: 'westus2',
          resourceName: 'Standard NCASv3_T4 Family vCPUs',
          limit: 64,
        }),
        readOnlyQuota('lowPriorityCores', {
          region: 'westus2',
          resourceName: 'Total Regional Low-priority vCPUs',
          limit: 2048,
        }),
      ],
    });

    const result = await provider.getInsufficientQuotaRegions(
      azureQuotaResourceKey('standardncasv3_t4family'),
      4,
      true,
      ['westus2'],
    );

    expect(result).toEqual({
      insufficientRegions: new Set(),
      unknownRegions: new Set(),
      complete: true,
    });
  });

  it('partitions on-demand T4 regions using the spaced family and cores quotas', async () => {
    const provider = withMergedQuotasByRegion({
      eastus2: [
        readOnlyQuota('Standard NCASv3_T4 Family', {
          region: 'eastus2',
          resourceName: 'Standard NCASv3_T4 Family vCPUs',
          limit: 0,
        }),
        readOnlyQuota('cores', {
          region: 'eastus2',
          resourceName: 'Total Regional vCPUs',
          limit: 2048,
        }),
      ],
      westus2: [
        readOnlyQuota('Standard NCASv3_T4 Family', {
          region: 'westus2',
          resourceName: 'Standard NCASv3_T4 Family vCPUs',
          limit: 64,
        }),
        readOnlyQuota('cores', {
          region: 'westus2',
          resourceName: 'Total Regional vCPUs',
          limit: 2048,
        }),
      ],
    });

    const result = await provider.getInsufficientQuotaRegions(
      azureQuotaResourceKey('standardncasv3_t4family'),
      4,
      false,
      ['eastus2', 'westus2'],
    );

    expect(result).toEqual({
      insufficientRegions: new Set(['eastus2']),
      unknownRegions: new Set(),
      complete: true,
    });
  });

  it('times out one hung regional quota read without failing the whole sweep', async () => {
    vi.useFakeTimers();
    const provider = new AzureQuotaProvider(creds);
    const listMergedQuotas = vi
      .fn()
      .mockImplementation((region: string): Promise<AzureQuotaInfo[]> => {
        if (region === 'hungregion') {
          return new Promise<AzureQuotaInfo[]>(() => {});
        }
        return Promise.resolve([
          readOnlyQuota('standarddsv5family', {
            region,
            resourceName: 'DSv5',
            limit: 10,
          }),
          readOnlyQuota('lowPriorityCores', {
            region,
            resourceName: 'Low Priority Cores',
            limit: region === 'westus2' ? 1 : 10,
          }),
        ]);
      });
    (provider as unknown as Record<string, unknown>).listMergedQuotas =
      listMergedQuotas;

    const resultPromise = provider.getInsufficientQuotaRegions(
      azureQuotaResourceKey('standarddsv5family'),
      2,
      true,
      ['eastus', 'hungregion', 'westus2'],
    );

    await vi.advanceTimersByTimeAsync(
      AZURE_CANDIDATE_PREFLIGHT_REGION_TIMEOUT_MS + 1,
    );
    await expect(resultPromise).resolves.toEqual({
      insufficientRegions: new Set(['westus2']),
      unknownRegions: new Set(['hungregion']),
      complete: false,
    });
    expect(listMergedQuotas).toHaveBeenCalledTimes(3);
  });
});

describe('AzureQuotaProvider quota ingestion', () => {
  const networkQuotaScope =
    'subscriptions/sub/providers/Microsoft.Network/locations/eastus';

  beforeEach(() => {
    quotaListMock.mockReset();
    quotaUsagesListMock.mockReset();
    quotaRequestStatusListMock.mockReset();
  });

  it('constructs one identity and retains the genuine pending subrequest id', async () => {
    quotaListMock.mockReturnValue(
      asyncIterable([
        {
          properties: {
            name: {
              value: 'Standard NCASv3_T4 Family',
              localizedValue: 'Standard NCASv3 T4 Family vCPUs',
            },
            limit: { value: 64 },
            unit: 'Count',
          },
        },
      ]),
    );
    quotaUsagesListMock.mockReturnValue(
      asyncIterable([
        {
          properties: {
            name: { value: 'standardncasv3_t4family' },
            usages: { value: 7 },
          },
        },
      ]),
    );
    quotaRequestStatusListMock.mockReturnValue(
      asyncIterable([
        {
          name: 'parent-request',
          properties: {
            provisioningState: 'InProgress',
            requestSubmitTime: '2026-07-10T12:00:00Z',
            value: [
              {
                subRequestId: 'subrequest-42',
                name: { value: 'STANDARDNCASV3_T4FAMILY' },
                limit: { value: 128 },
                provisioningState: 'InProgress',
              },
              {
                subRequestId: 'completed-subrequest',
                name: { value: 'STANDARDNCASV3_T4FAMILY' },
                limit: { value: 256 },
                provisioningState: 'Succeeded',
              },
            ],
          },
        },
        {
          name: 'accepted-parent-request',
          properties: {
            provisioningState: 'Accepted',
            requestSubmitTime: '2026-07-10T13:00:00Z',
            value: [
              {
                subRequestId: 'accepted-subrequest',
                name: { value: 'STANDARDNCASV3_T4FAMILY' },
                limit: { value: 192 },
              },
            ],
          },
        },
        {
          name: 'completed-parent-request',
          properties: {
            provisioningState: 'Succeeded',
            requestSubmitTime: '2026-07-09T12:00:00Z',
            value: [
              {
                subRequestId: 'completed-parent-subrequest',
                name: { value: 'STANDARDNCASV3_T4FAMILY' },
                limit: { value: 512 },
              },
            ],
          },
        },
      ]),
    );
    const provider = new AzureQuotaProvider(creds);

    const rows = await (provider as any).listQuotasForScope(
      'eastus',
      'quota-scope',
    );

    expect(quotaRequestStatusListMock).toHaveBeenCalledOnce();
    expect(quotaRequestStatusListMock).toHaveBeenCalledWith('quota-scope');
    expect(rows).toEqual([
      {
        region: 'eastus',
        resourceName: 'Standard NCASv3 T4 Family vCPUs',
        providerId: 'Standard NCASv3_T4 Family',
        resourceKey: 'azure:standardncasv3_t4family',
        currentUsage: 7,
        limit: 64,
        unit: 'Count',
        writable: true,
        scope: 'quota-scope',
        pending: {
          complete: true,
          requests: [
            {
              requestedLimit: 128,
              status: 'InProgress',
              submitTime: new Date('2026-07-10T12:00:00Z'),
              providerRequestId: 'subrequest-42',
            },
            {
              requestedLimit: 192,
              status: 'Accepted',
              submitTime: new Date('2026-07-10T13:00:00Z'),
              providerRequestId: 'accepted-subrequest',
            },
          ],
        },
      },
    ]);
  });

  it('preserves simultaneous accepted Network IDs for structured ambiguity handling', async () => {
    quotaListMock.mockReturnValue(
      asyncIterable([
        {
          properties: {
            name: { value: 'StandardSkuPublicIpAddresses' },
            limit: { value: 50 },
            unit: 'Count',
          },
        },
        {
          properties: {
            name: { value: 'IPv4StandardSkuPublicIpAddresses' },
            limit: { value: 50 },
            unit: 'Count',
          },
        },
      ]),
    );
    quotaUsagesListMock.mockReturnValue(asyncIterable([]));
    quotaRequestStatusListMock.mockReturnValue(asyncIterable([]));
    const provider = new AzureQuotaProvider(creds);

    const rows = await (provider as any).listQuotasForScope(
      'eastus',
      'subscriptions/sub/providers/Microsoft.Network/locations/eastus',
    );

    expect(rows.map((row: WritableAzureQuotaInfo) => row.providerId)).toEqual([
      'StandardSkuPublicIpAddresses',
      'IPv4StandardSkuPublicIpAddresses',
    ]);
    expect(rows.map((row: WritableAzureQuotaInfo) => row.resourceKey)).toEqual([
      'azure:standardskupublicipaddresses',
      'azure:standardskupublicipaddresses',
    ]);
  });

  it('coalesces identical exact provider rows during production limit ingestion', async () => {
    quotaListMock.mockReturnValue(
      asyncIterable([
        {
          properties: {
            name: {
              value: 'IPv4StandardSkuPublicIpAddresses',
              localizedValue: 'First page',
            },
            limit: { value: 50 },
            unit: 'Count',
          },
        },
        {
          properties: {
            name: {
              value: 'IPv4StandardSkuPublicIpAddresses',
              localizedValue: 'Second page',
            },
            limit: { value: 50 },
            unit: 'Count',
          },
        },
      ]),
    );
    quotaUsagesListMock.mockReturnValue(asyncIterable([]));
    quotaRequestStatusListMock.mockReturnValue(asyncIterable([]));
    const provider = new AzureQuotaProvider(creds);

    const rows = await (provider as any).listQuotasForScope(
      'eastus',
      networkQuotaScope,
    );

    expect(rows).toEqual([
      expect.objectContaining({
        providerId: 'IPv4StandardSkuPublicIpAddresses',
        resourceName: 'First page',
        limit: 50,
        unit: 'Count',
      }),
    ]);
  });

  it.each([
    { secondLimit: 51, secondUnit: 'Count' },
    { secondLimit: 50, secondUnit: 'Each' },
  ])(
    'rejects conflicting duplicate limit rows ($secondLimit/$secondUnit)',
    async ({ secondLimit, secondUnit }) => {
      quotaListMock.mockReturnValue(
        asyncIterable([
          {
            properties: {
              name: { value: 'IPv4StandardSkuPublicIpAddresses' },
              limit: { value: 50 },
              unit: 'Count',
            },
          },
          {
            properties: {
              name: { value: 'IPv4StandardSkuPublicIpAddresses' },
              limit: { value: secondLimit },
              unit: secondUnit,
            },
          },
        ]),
      );
      quotaUsagesListMock.mockReturnValue(asyncIterable([]));
      quotaRequestStatusListMock.mockReturnValue(asyncIterable([]));
      const provider = new AzureQuotaProvider(creds);

      await expect(
        (provider as any).listQuotasForScope('eastus', networkQuotaScope),
      ).rejects.toThrow('ambiguous canonical collision');
    },
  );

  it('joins accepted current spellings across limits, usages, and pending endpoints', async () => {
    quotaListMock.mockReturnValue(
      asyncIterable([
        {
          properties: {
            name: { value: 'IPv4StandardSkuPublicIpAddresses' },
            limit: { value: 50 },
            unit: 'Count',
          },
        },
      ]),
    );
    quotaUsagesListMock.mockReturnValue(
      asyncIterable([
        {
          properties: {
            name: { value: 'StandardSkuPublicIpAddresses' },
            usages: { value: 12 },
          },
        },
      ]),
    );
    quotaRequestStatusListMock.mockReturnValue(
      asyncIterable([
        {
          properties: {
            provisioningState: 'Accepted',
            requestSubmitTime: '2026-07-10T13:00:00Z',
            value: [
              {
                subRequestId: 'standard-public-ip-request',
                name: { value: 'StandardSkuPublicIpAddresses' },
                limit: { value: 100 },
              },
            ],
          },
        },
      ]),
    );
    const provider = new AzureQuotaProvider(creds);

    const rows = await (provider as any).listQuotasForScope(
      'eastus',
      'subscriptions/sub/providers/Microsoft.Network/locations/eastus',
    );

    expect(rows).toEqual([
      expect.objectContaining({
        providerId: 'IPv4StandardSkuPublicIpAddresses',
        resourceKey: 'azure:standardskupublicipaddresses',
        currentUsage: 12,
        pending: expect.objectContaining({
          requests: [
            expect.objectContaining({
              providerRequestId: 'standard-public-ip-request',
              requestedLimit: 100,
            }),
          ],
        }),
      }),
    ]);
  });

  it('preserves generic canonical endpoint joins for unrelated Network resources', async () => {
    quotaListMock.mockReturnValue(
      asyncIterable([
        {
          properties: {
            name: { value: 'VirtualNetworks' },
            limit: { value: 50 },
            unit: 'Count',
          },
        },
      ]),
    );
    quotaUsagesListMock.mockReturnValue(
      asyncIterable([
        {
          properties: {
            name: { value: 'virtual networks' },
            usages: { value: 12 },
          },
        },
      ]),
    );
    quotaRequestStatusListMock.mockReturnValue(
      asyncIterable([
        {
          properties: {
            provisioningState: 'Accepted',
            value: [
              {
                subRequestId: 'virtual-network-request',
                name: { value: 'VIRTUALNETWORKS' },
                limit: { value: 100 },
              },
            ],
          },
        },
      ]),
    );
    const provider = new AzureQuotaProvider(creds);

    const rows = await (provider as any).listQuotasForScope(
      'eastus',
      networkQuotaScope,
    );

    expect(rows).toEqual([
      expect.objectContaining({
        providerId: 'VirtualNetworks',
        currentUsage: 12,
        pending: expect.objectContaining({
          requests: [
            expect.objectContaining({
              providerRequestId: 'virtual-network-request',
              requestedLimit: 100,
            }),
          ],
        }),
      }),
    ]);
  });

  it('retains an exact Basic public-IP pending row on its distinct provider-derived key', async () => {
    quotaListMock.mockReturnValue(
      asyncIterable([
        {
          properties: {
            name: {
              value: 'PublicIPAddresses',
              localizedValue: 'Public IP Addresses',
            },
            limit: { value: 20 },
            unit: 'Count',
          },
        },
      ]),
    );
    quotaUsagesListMock.mockReturnValue(asyncIterable([]));
    quotaRequestStatusListMock.mockReturnValue(
      asyncIterable([
        {
          properties: {
            provisioningState: 'Accepted',
            value: [
              {
                subRequestId: 'basic-public-ip-request',
                name: { value: 'PublicIPAddresses' },
                limit: { value: 40 },
              },
            ],
          },
        },
      ]),
    );
    const provider = new AzureQuotaProvider(creds);

    const rows = await (provider as any).listQuotasForScope(
      'eastus',
      networkQuotaScope,
    );

    expect(rows).toEqual([
      expect.objectContaining({
        providerId: 'PublicIPAddresses',
        resourceKey: 'azure:publicipaddresses',
        pending: expect.objectContaining({
          requests: [
            expect.objectContaining({
              providerRequestId: 'basic-public-ip-request',
              requestedLimit: 40,
            }),
          ],
        }),
      }),
    ]);
  });
});

describe('AzureQuotaProvider.listOpenRequests', () => {
  it('includes pending requests from Compute and Network quota scopes', async () => {
    const computeScope =
      'subscriptions/sub/providers/Microsoft.Compute/locations/eastus';
    const networkScope =
      'subscriptions/sub/providers/Microsoft.Network/locations/eastus';
    const computeQuota = writableQuota('standardncadsh100v5family', {
      resourceName: 'Standard NCads H100 v5 Family vCPUs',
      scope: computeScope,
      pending: {
        complete: true,
        requests: [
          { requestedLimit: 40, status: 'Accepted', submitTime: new Date() },
        ],
      },
    });
    const networkQuota = writableQuota('StandardSkuPublicIpAddresses', {
      resourceName: 'Public IP Addresses - Standard',
      currentUsage: 100,
      limit: 100,
      scope: networkScope,
      pending: {
        complete: true,
        requests: [
          { requestedLimit: 200, status: 'Accepted', submitTime: new Date() },
        ],
      },
    });
    const provider = new AzureQuotaProvider(creds);
    const listQuotasForScope = vi
      .fn()
      .mockImplementation((_region: string, scope: string) => {
        if (scope === computeScope) return Promise.resolve([computeQuota]);
        if (scope === networkScope) return Promise.resolve([networkQuota]);
        return Promise.resolve([]);
      });
    (
      provider as unknown as {
        listQuotasForScope: typeof listQuotasForScope;
      }
    ).listQuotasForScope = listQuotasForScope;

    const result = await provider.listOpenRequests('eastus');

    expect(listQuotasForScope).toHaveBeenCalledWith('eastus', computeScope);
    expect(listQuotasForScope).toHaveBeenCalledWith('eastus', networkScope);
    expect(result.map((q) => q.providerId)).toEqual([
      'standardncadsh100v5family',
      'StandardSkuPublicIpAddresses',
    ]);
  });
});

/** The private read the status and request paths both go through. */
type ProviderInternals = {
  listMergedQuotas: AzureQuotaProvider['listMergedQuotas'];
  listComputeUsages: AzureQuotaProvider['listComputeUsages'];
  listQuotasForScope: AzureQuotaProvider['listQuotasForScope'];
};

describe('AzureQuotaProvider.listCurrentStatusQuotas', () => {
  it.each(['Compute requests', 'Network limits'] as const)(
    'keeps Compute limits when %s hangs',
    async (unavailableScope) => {
      vi.useFakeTimers();
      try {
        const provider = new AzureQuotaProvider(creds);
        const quota = readOnlyQuota('cores', { limit: 65 });
        (provider as unknown as Record<string, unknown>).listComputeUsages = vi
          .fn()
          .mockResolvedValue([quota]);
        (provider as unknown as Record<string, unknown>).listQuotasForScope = vi
          .fn()
          .mockImplementation((_region: string, scope: string) => {
            const hangingScope =
              unavailableScope === 'Compute requests'
                ? 'Microsoft.Compute'
                : 'Microsoft.Network';
            return scope.includes(hangingScope)
              ? new Promise(() => {})
              : Promise.resolve([]);
          });
        const unavailable = vi.fn();
        const result = provider.listCurrentStatusQuotas('eastus', unavailable);

        await vi.advanceTimersByTimeAsync(QUOTA_REGION_TIMEOUT_MS / 3);

        await expect(result).resolves.toEqual([quota]);
        expect(unavailable).toHaveBeenCalledWith(
          unavailableScope,
          expect.any(Error),
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('keeps Compute limits and reports unavailable Quota API request data', async () => {
    const provider = new AzureQuotaProvider(creds);
    const quotas = [
      readOnlyQuota('cores', { limit: 65 }),
      readOnlyQuota('lowprioritycores', { limit: 40 }),
      readOnlyQuota('standardncadsh100v5family', { limit: 20 }),
    ];
    let quotaApiAvailable = false;
    (provider as unknown as Record<string, unknown>).listComputeUsages = vi
      .fn()
      .mockResolvedValue(quotas);
    (provider as unknown as Record<string, unknown>).listQuotasForScope = vi
      .fn()
      .mockImplementation((_region: string, scope: string) =>
        scope.includes('Microsoft.Compute')
          ? quotaApiAvailable
            ? Promise.resolve([writableQuota('cores', { limit: 65 })])
            : Promise.reject(new Error('Microsoft.Quota unregistered'))
          : Promise.resolve([]),
      );
    const unavailable = vi.fn();

    await expect(
      provider.listCurrentStatusQuotas('eastus', unavailable),
    ).resolves.toEqual(quotas);
    expect(unavailable).toHaveBeenCalledWith(
      'Compute requests',
      expect.objectContaining({ message: 'Microsoft.Quota unregistered' }),
    );
    quotaApiAvailable = true;
    unavailable.mockClear();
    const recovered = await provider.listCurrentStatusQuotas(
      'eastus',
      unavailable,
    );
    expect(recovered).toHaveLength(3);
    expect(recovered[0]).toMatchObject({
      resourceKey: 'azure:cores',
      limit: 65,
      writable: true,
    });
    expect(unavailable).not.toHaveBeenCalled();
  });

  it('rejects a failed Compute read even when Network returns a public IP limit', async () => {
    const provider = new AzureQuotaProvider(creds);
    vi.spyOn(
      internalsOf<ProviderInternals>(provider),
      'listMergedQuotas',
    ).mockRejectedValue(new Error('Compute read unavailable'));
    (provider as unknown as Record<string, unknown>).listQuotasForScope = vi
      .fn()
      .mockResolvedValue([
        writableQuota('StandardSkuPublicIpAddresses', {
          resourceName: 'Public IP Addresses - Standard',
          limit: 50,
        }),
      ]);
    await expect(provider.listCurrentStatusQuotas('eastus')).rejects.toThrow(
      'Compute read unavailable',
    );
  });

  it('rejects when failed scopes leave no current quota rows', async () => {
    const provider = new AzureQuotaProvider(creds);
    const failure = new Error('compute read timed out');
    vi.spyOn(
      internalsOf<ProviderInternals>(provider),
      'listMergedQuotas',
    ).mockRejectedValue(failure);
    (provider as unknown as Record<string, unknown>).listQuotasForScope = vi
      .fn()
      .mockResolvedValue([]);
    await expect(
      provider.listCurrentStatusQuotas('eastus'),
    ).rejects.toMatchObject({
      message:
        'Azure current quota status unavailable for eastus: compute read timed out',
    });
  });

  it('rejects when the network scope fails after an empty compute read', async () => {
    const provider = new AzureQuotaProvider(creds);
    vi.spyOn(
      internalsOf<ProviderInternals>(provider),
      'listMergedQuotas',
    ).mockResolvedValue([]);
    const failure = new Error('network read timed out');
    (provider as unknown as Record<string, unknown>).listQuotasForScope = vi
      .fn()
      .mockRejectedValue(failure);
    await expect(provider.listCurrentStatusQuotas('eastus')).rejects.toThrow(
      'Azure current quota status unavailable for eastus: network read timed out',
    );
  });

  it('preserves useful current rows when another scope fails', async () => {
    const provider = new AzureQuotaProvider(creds);
    const quota = readOnlyQuota('cores', { limit: 65 });
    vi.spyOn(
      internalsOf<ProviderInternals>(provider),
      'listMergedQuotas',
    ).mockResolvedValue([quota]);
    (provider as unknown as Record<string, unknown>).listQuotasForScope = vi
      .fn()
      .mockRejectedValue(new Error('network read timed out'));
    await expect(provider.listCurrentStatusQuotas('eastus')).resolves.toEqual([
      quota,
    ]);
  });

  it('keeps only launch-blocking Network quotas', async () => {
    const provider = new AzureQuotaProvider(creds);
    vi.spyOn(
      internalsOf<ProviderInternals>(provider),
      'listMergedQuotas',
    ).mockResolvedValue([
      readOnlyQuota('cores', {
        resourceName: 'Total Regional vCPUs',
        limit: 65,
      }),
      readOnlyQuota('standardncadsh100v5family', {
        resourceName: 'Standard NCads H100 v5 Family vCPUs',
        limit: 40,
      }),
    ]);
    (provider as unknown as Record<string, unknown>).listQuotasForScope = vi
      .fn()
      .mockResolvedValue([
        writableQuota('PublicIpPrefixes', {
          resourceName: 'Public Ip Prefixes',
          limit: 2147483647,
          scope:
            'subscriptions/sub/providers/Microsoft.Network/locations/eastus',
        }),
        writableQuota('PublicIPAddresses', {
          resourceName: 'Public IP Addresses',
          limit: 100,
          scope:
            'subscriptions/sub/providers/Microsoft.Network/locations/eastus',
        }),
        writableQuota('StaticPublicIPAddresses', {
          resourceName: 'Static Public IP Addresses',
          limit: 100,
          scope:
            'subscriptions/sub/providers/Microsoft.Network/locations/eastus',
        }),
        writableQuota('IPv4StandardSkuPublicIpAddresses', {
          resourceName: 'Public IPv4 Addresses - Standard',
          limit: 50,
          scope:
            'subscriptions/sub/providers/Microsoft.Network/locations/eastus',
        }),
      ]);

    const result = await provider.listCurrentStatusQuotas('eastus');

    expect(result.map((q) => q.resourceKey)).toContain('azure:cores');
    expect(result.map((q) => q.resourceKey)).toContain(
      'azure:standardskupublicipaddresses',
    );
    expect(result.map((q) => q.resourceKey)).not.toContain(
      'azure:publicipprefixes',
    );
    expect(result.map((q) => q.resourceKey)).not.toContain(
      'azure:publicipaddresses',
    );
    expect(result.map((q) => q.resourceKey)).not.toContain(
      'azure:publicipv4addressesstandard',
    );
    expect(result.map((q) => q.resourceKey)).not.toContain(
      'azure:staticpublicipaddresses',
    );
  });

  it('omits an ambiguous public-IP status row and reports structured schema drift', async () => {
    const { log } = await import('../../../src/api/services/logger.js');
    const warnMock = vi.mocked(log.warn);
    const callsBefore = warnMock.mock.calls.length;

    const provider = new AzureQuotaProvider(creds);
    vi.spyOn(
      internalsOf<ProviderInternals>(provider),
      'listMergedQuotas',
    ).mockResolvedValue([]);
    (provider as unknown as Record<string, unknown>).listQuotasForScope = vi
      .fn()
      .mockResolvedValue([
        writableQuota('StandardSkuPublicIpAddresses', {
          resourceName: 'Public IP Addresses - Standard',
          limit: 50,
          scope:
            'subscriptions/sub/providers/Microsoft.Network/locations/eastus',
        }),
        writableQuota('PublicIPStandardPremiumAddresses', {
          resourceName: 'Public IP Standard Premium Addresses',
          limit: 30,
          scope:
            'subscriptions/sub/providers/Microsoft.Network/locations/eastus',
        }),
      ]);

    const result = await provider.listCurrentStatusQuotas('eastus');

    expect(result).toEqual([]);
    const driftWarnings = warnMock.mock.calls
      .slice(callsBefore)
      .filter(
        (call) =>
          call[1]?.eventCode === AZURE_PUBLIC_IP_QUOTA_SCHEMA_DRIFT_EVENT_CODE,
      );
    expect(driftWarnings).toHaveLength(1);
    expect(driftWarnings[0][1]).toMatchObject({
      region: 'eastus',
      operation: 'status',
      resolution: 'ambiguous',
      acceptedCandidates: [{ providerId: 'StandardSkuPublicIpAddresses' }],
      unknownCandidates: [{ providerId: 'PublicIPStandardPremiumAddresses' }],
    });
  });
});

describe('azureQuotaStatus', () => {
  it('retains delayed Compute limits when the concurrent Network read hangs', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(
        AzureQuotaProvider.prototype,
        'listOpenSupportTickets',
      ).mockResolvedValue([]);
      vi.spyOn(
        AzureQuotaProvider.prototype,
        'listOpenRequests',
      ).mockResolvedValue([]);
      vi.spyOn(
        internalsOf<ProviderInternals>(AzureQuotaProvider.prototype),
        'listComputeUsages',
      ).mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve([readOnlyQuota('cores', { limit: 65 })]),
              (QUOTA_REGION_TIMEOUT_MS * 3) / 4,
            ),
          ),
      );
      vi.spyOn(
        internalsOf<ProviderInternals>(AzureQuotaProvider.prototype),
        'listQuotasForScope',
      ).mockImplementation((_region, scope) =>
        scope.includes('Microsoft.Network')
          ? new Promise(() => {})
          : Promise.resolve([]),
      );

      const status = azureQuotaStatus(creds, 'eastus');
      await vi.advanceTimersByTimeAsync((QUOTA_REGION_TIMEOUT_MS * 3) / 4);

      await expect(status).resolves.toEqual([
        expect.objectContaining({ kind: 'current', currentLimit: 65 }),
        expect.objectContaining({
          kind: 'unavailable',
          resourceName: 'Network limits',
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  function emptyStatusReads() {
    vi.spyOn(
      AzureQuotaProvider.prototype,
      'listOpenSupportTickets',
    ).mockResolvedValue([]);
    vi.spyOn(
      AzureQuotaProvider.prototype,
      'listOpenRequests',
    ).mockResolvedValue([]);
    return vi
      .spyOn(AzureQuotaProvider.prototype, 'listCurrentStatusQuotas')
      .mockResolvedValue([]);
  }

  it.each(['eastus', undefined])(
    'rejects current-quota timeouts for %s instead of empty success',
    async (region) => {
      vi.useFakeTimers();
      try {
        emptyStatusReads().mockImplementation(() => new Promise(() => {}));
        const result = azureQuotaStatus(creds, region).then(
          () => undefined,
          (error: unknown) => error,
        );
        await vi.advanceTimersByTimeAsync(QUOTA_REGION_TIMEOUT_MS);
        expect(await result).toMatchObject({
          message: expect.stringMatching(
            /^Azure quota status unavailable for .*timed out after 1 minute/,
          ),
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('accepts a genuinely empty successful provider read', async () => {
    emptyStatusReads();
    await expect(azureQuotaStatus(creds, 'eastus')).resolves.toEqual([]);
  });

  it.each(['listOpenRequests', 'listOpenSupportTickets'] as const)(
    'does not present a failed %s read as empty success',
    async (method) => {
      emptyStatusReads();
      const failure = new Error('provider read unavailable');
      vi.spyOn(AzureQuotaProvider.prototype, method).mockRejectedValue(failure);
      await expect(azureQuotaStatus(creds, 'eastus')).rejects.toThrow(
        'Azure quota status unavailable for eastus: provider read unavailable',
      );
    },
  );

  it('retains current quotas when request history is unavailable', async () => {
    emptyStatusReads().mockResolvedValue([
      readOnlyQuota('cores', { limit: 65 }),
    ]);
    vi.spyOn(
      AzureQuotaProvider.prototype,
      'listOpenRequests',
    ).mockRejectedValue(new Error('request read unavailable'));
    await expect(azureQuotaStatus(creds, 'eastus')).resolves.toEqual([
      expect.objectContaining({ kind: 'current', currentLimit: 65 }),
      expect.objectContaining({
        kind: 'unavailable',
        region: 'eastus',
        resourceName: 'Quota requests',
        status: 'UNAVAILABLE',
      }),
    ]);
  });

  it('retains healthy regions when another current region fails', async () => {
    emptyStatusReads().mockImplementation(async (region) => {
      if (region !== 'eastus') throw new Error('regional read unavailable');
      return [readOnlyQuota('cores', { limit: 65 })];
    });
    const entries = await azureQuotaStatus(creds);
    expect(entries).toContainEqual(
      expect.objectContaining({
        region: 'eastus',
        kind: 'current',
        currentLimit: 65,
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'unavailable',
        resourceName: 'Compute limits',
      }),
    );
  });

  it('does not let request history hide failure of every current read', async () => {
    emptyStatusReads().mockRejectedValue(new Error('current read timed out'));
    vi.spyOn(
      AzureQuotaProvider.prototype,
      'listOpenRequests',
    ).mockResolvedValue([
      writableQuota('cores', {
        pending: {
          complete: true,
          requests: [
            {
              requestedLimit: 80,
              status: 'InProgress',
              submitTime: new Date(),
            },
          ],
        },
      }),
    ]);
    await expect(azureQuotaStatus(creds, 'eastus')).rejects.toThrow(
      'current read timed out',
    );
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns current quota rows when no open requests or tickets exist', async () => {
    vi.spyOn(
      AzureQuotaProvider.prototype,
      'listOpenSupportTickets',
    ).mockResolvedValue([]);
    vi.spyOn(
      AzureQuotaProvider.prototype,
      'listOpenRequests',
    ).mockResolvedValue([]);
    vi.spyOn(
      AzureQuotaProvider.prototype,
      'listCurrentStatusQuotas',
    ).mockResolvedValue([
      readOnlyQuota('standardncadsh100v5family', {
        resourceName: 'Standard NCads H100 v5 Family vCPUs',
        limit: 40,
      }),
    ]);

    const entries = await azureQuotaStatus(creds, 'eastus');

    expect(entries).toEqual([
      {
        kind: 'current',
        cloud: CloudType.Azure,
        region: 'eastus',
        resourceName: 'Standard NCads H100 v5 Family vCPUs',
        resourceKey: 'azure:standardncadsh100v5family',
        status: 'CURRENT',
        currentLimit: 40,
      },
    ]);
  });

  it('preserves provider quota keys for current rows whose family ids contain punctuation', async () => {
    vi.spyOn(
      AzureQuotaProvider.prototype,
      'listOpenSupportTickets',
    ).mockResolvedValue([]);
    vi.spyOn(
      AzureQuotaProvider.prototype,
      'listOpenRequests',
    ).mockResolvedValue([]);
    vi.spyOn(
      AzureQuotaProvider.prototype,
      'listCurrentStatusQuotas',
    ).mockResolvedValue([
      readOnlyQuota('standardncasv3_t4family', {
        resourceName: 'Standard NCASv3 T4 Family vCPUs',
        limit: 4,
      }),
    ]);

    const entries = await azureQuotaStatus(creds, 'eastus');

    expect(entries[0]).toMatchObject({
      kind: 'current',
      cloud: CloudType.Azure,
      region: 'eastus',
      resourceName: 'Standard NCASv3 T4 Family vCPUs',
      resourceKey: 'azure:standardncasv3_t4family',
      status: 'CURRENT',
      currentLimit: 4,
    });
  });

  it('serializes the real Azure pending request id, never the provider name', async () => {
    const submittedAt = new Date('2026-07-10T12:00:00Z');
    vi.spyOn(
      AzureQuotaProvider.prototype,
      'listOpenSupportTickets',
    ).mockResolvedValue([]);
    vi.spyOn(
      AzureQuotaProvider.prototype,
      'listOpenRequests',
    ).mockResolvedValue([
      writableQuota('Standard NCASv3_T4 Family', {
        resourceName: 'Standard NCASv3 T4 Family vCPUs',
        pending: {
          complete: true,
          requests: [
            {
              requestedLimit: 8,
              status: 'InProgress',
              submitTime: submittedAt,
              providerRequestId: 'quota-subrequest-123',
            },
          ],
        },
      }),
    ]);
    vi.spyOn(
      AzureQuotaProvider.prototype,
      'listCurrentStatusQuotas',
    ).mockResolvedValue([]);

    const entries = await azureQuotaStatus(creds, 'eastus');

    expect(entries).toEqual([
      expect.objectContaining({
        resourceKey: 'azure:standardncasv3_t4family',
        providerRequestId: 'quota-subrequest-123',
        requestedAt: submittedAt.toISOString(),
      }),
    ]);
    expect(entries[0].requestId).toBeUndefined();
  });

  it('keeps a historical public-IP pending request on its provider-derived key', async () => {
    const submittedAt = new Date('2026-07-10T12:00:00Z');
    vi.spyOn(
      AzureQuotaProvider.prototype,
      'listOpenSupportTickets',
    ).mockResolvedValue([]);
    // Historical provider identities are intentionally no longer folded onto
    // the current Standard pool in status output.
    vi.spyOn(
      AzureQuotaProvider.prototype,
      'listOpenRequests',
    ).mockResolvedValue([
      writableQuota('PublicIPAddresses', {
        resourceName: 'Public IP Addresses',
        pending: {
          complete: true,
          requests: [
            {
              requestedLimit: 2,
              status: 'InProgress',
              submitTime: submittedAt,
            },
          ],
        },
      }),
    ]);
    vi.spyOn(
      AzureQuotaProvider.prototype,
      'listCurrentStatusQuotas',
    ).mockResolvedValue([]);

    const entries = await azureQuotaStatus(creds, 'eastus');

    expect(entries).toEqual([
      expect.objectContaining({
        kind: 'request',
        resourceKey: 'azure:publicipaddresses',
        requestedAt: submittedAt.toISOString(),
      }),
    ]);
  });
});

describe('AzureQuotaProvider.getInsufficientQuotaRegions failure logging', () => {
  it('aggregates region read failures into one warning and fails open', async () => {
    const { log } = await import('../../../src/api/services/logger.js');
    const warnMock = vi.mocked(log.warn);
    const callsBefore = warnMock.mock.calls.length;

    const provider = new AzureQuotaProvider(creds);
    vi.spyOn(
      internalsOf<ProviderInternals>(provider),
      'listMergedQuotas',
    ).mockRejectedValue(new Error('socket hang up'));

    const result = await provider.getInsufficientQuotaRegions(
      azureQuotaResourceKey('standarddsv5family'),
      2,
      false,
      ['eastus', 'westus2', 'westeurope', 'northeurope'],
    );

    // Failed reads filter nothing — every region passes through (fail open).
    expect(result).toEqual({
      insufficientRegions: new Set(),
      unknownRegions: new Set([
        'eastus',
        'westus2',
        'westeurope',
        'northeurope',
      ]),
      complete: false,
    });

    // Four failing regions produce ONE aggregated warning, not one per region.
    const sweepWarnings = warnMock.mock.calls
      .slice(callsBefore)
      .filter(
        (call) =>
          call[0] === 'Failed to read Azure quotas for candidate regions',
      );
    expect(sweepWarnings).toHaveLength(1);
    expect(sweepWarnings[0][1]).toMatchObject({
      failedRegions: 4,
      error: 'socket hang up',
    });
  });
});
