import { describe, expect, it } from 'vitest';
import {
  type QuotaRequestEntry,
  type QuotaStatusEntry,
} from '../../../src/shared/api-contract/quota-schemas.js';
import { CloudType } from '../../../src/shared/cloud.js';
import {
  completedQuotaStatusEntriesForTarget,
  plannedQuotaStatusEntriesForTarget,
} from '../../../src/api/services/quota/groups.js';
import {
  canonicalQuotaResourceKey,
  canonicalizeQuotaRequestEntries,
  canonicalizeQuotaRequestEntry,
  quotaStatusEntrySpot,
  quotaSupportedRegionsForVmType,
  resolveQuotaResourcesForTarget,
  quotaStatusResourceKey,
} from '../../../src/shared/quota-groups.js';
import {
  parseStoredQuotaRequestEntries,
  type QuotaStatusOperationTargetRow,
} from '../../../src/api/services/repositories/quota-operations.js';
import {
  QuotaOperationStatus,
  QuotaOperationTargetStatus,
  QuotaRequestStatus,
} from '../../../src/shared/quota.js';

describe('quota planned resource groups', () => {
  it('derives an AWS quota group from vmType and spot', () => {
    expect(
      resolveQuotaResourcesForTarget({
        cloud: CloudType.AWS,
        vmType: 'g6e.48xlarge',
        spot: true,
      }),
    ).toEqual([
      {
        key: 'aws:l-3819a6df',
        providerId: 'L-3819A6DF',
        name: 'All G and VT Spot Instance Requests',
        kind: 'vm-family',
        unit: 'vcpus',
        required: 192,
      },
    ]);
  });

  it.each([
    {
      vmType: 'g6e.48xlarge',
      spot: false,
      key: 'aws:l-db2e81ba',
      providerId: 'L-DB2E81BA',
      name: 'Running On-Demand G and VT instances',
      required: 192,
    },
    {
      vmType: 'p5.48xlarge',
      spot: true,
      key: 'aws:l-7212ccbc',
      providerId: 'L-7212CCBC',
      name: 'All P Spot Instance Requests',
      required: 192,
    },
    {
      vmType: 'trn1.32xlarge',
      spot: false,
      key: 'aws:l-2c3b7624',
      providerId: 'L-2C3B7624',
      name: 'Running On-Demand Trn instances',
      required: 128,
    },
    {
      vmType: 'inf2.48xlarge',
      spot: true,
      key: 'aws:l-b5d1601b',
      providerId: 'L-B5D1601B',
      name: 'All Inf Spot Instance Requests',
      required: 192,
    },
    {
      vmType: 'm7i.2xlarge',
      spot: false,
      key: 'aws:l-1216c47a',
      providerId: 'L-1216C47A',
      name: 'Running On-Demand Standard instances',
      required: 8,
    },
  ])(
    'derives the AWS quota resource plan for $vmType spot=$spot',
    ({ vmType, spot, key, providerId, name, required }) => {
      expect(
        resolveQuotaResourcesForTarget({
          cloud: CloudType.AWS,
          vmType,
          spot,
        }),
      ).toEqual([
        {
          key,
          providerId,
          name,
          kind: 'vm-family',
          unit: 'vcpus',
          required,
        },
      ]);
    },
  );

  it('derives Azure spot aggregate and public-IP groups without the family', () => {
    // Spot draws from a separate quota pool: the VM-family quota never gates
    // spot launches, so spot targets plan no family resource.
    expect(
      resolveQuotaResourcesForTarget({
        cloud: CloudType.Azure,
        vmType: 'Standard_NC40ads_H100_v5',
        spot: true,
        includePublicIpQuota: true,
      }),
    ).toEqual([
      {
        key: 'azure:lowprioritycores',
        name: 'Total Regional Low-priority vCPUs',
        kind: 'regional-aggregate',
        unit: 'vcpus',
        required: 40,
      },
      {
        key: 'azure:standardskupublicipaddresses',
        name: 'Public IP Addresses - Standard',
        kind: 'network',
        unit: 'count',
        required: 1,
      },
    ]);
  });

  it('derives Azure family, aggregate, and public-IP groups for on-demand targets', () => {
    expect(
      resolveQuotaResourcesForTarget({
        cloud: CloudType.Azure,
        vmType: 'Standard_NC40ads_H100_v5',
        spot: false,
        includePublicIpQuota: true,
      }),
    ).toEqual([
      {
        key: 'azure:standardncadsh100v5family',
        name: 'Standard NCads H100 v5 Family vCPUs',
        kind: 'vm-family',
        unit: 'vcpus',
        required: 40,
      },
      {
        key: 'azure:cores',
        name: 'Total Regional vCPUs',
        kind: 'regional-aggregate',
        unit: 'vcpus',
        required: 40,
      },
      {
        key: 'azure:standardskupublicipaddresses',
        name: 'Public IP Addresses - Standard',
        kind: 'network',
        unit: 'count',
        required: 1,
      },
    ]);
  });

  it('uses Azure quota group metadata for NCASv3 T4 instead of parsing the VM name', () => {
    expect(
      resolveQuotaResourcesForTarget({
        cloud: CloudType.Azure,
        vmType: 'Standard_NC4as_T4_v3',
        spot: false,
        includePublicIpQuota: false,
      })[0],
    ).toEqual({
      key: 'azure:standardncasv3_t4family',
      name: 'Standard NCas T4 v3 Family vCPUs',
      kind: 'vm-family',
      unit: 'vcpus',
      required: 4,
    });
  });

  it('uses the on-demand aggregate and omits public IPs when not requested', () => {
    expect(
      resolveQuotaResourcesForTarget({
        cloud: CloudType.Azure,
        vmType: 'Standard_D2as_v5',
        spot: false,
        includePublicIpQuota: false,
      }),
    ).toEqual([
      {
        key: 'azure:standarddasv5family',
        name: 'Standard Das v5 Family vCPUs',
        kind: 'vm-family',
        unit: 'vcpus',
        required: 2,
      },
      {
        key: 'azure:cores',
        name: 'Total Regional vCPUs',
        kind: 'regional-aggregate',
        unit: 'vcpus',
        required: 2,
      },
    ]);
  });

  it('classifies AWS quota status entries by canonical resource key', () => {
    expect(
      quotaStatusEntrySpot({
        cloud: CloudType.AWS,
        region: 'us-east-1',
        resourceName: 'L-7212CCBC',
        resourceKey: 'aws:l-7212ccbc',
        status: 'CURRENT',
      }),
    ).toBe(true);
    expect(
      quotaStatusEntrySpot({
        cloud: CloudType.AWS,
        region: 'us-east-1',
        resourceName: 'L-417A185B',
        resourceKey: 'aws:l-417a185b',
        status: 'CURRENT',
      }),
    ).toBe(false);
  });

  it('classifies Azure aggregate and family quota status entries by quota type', () => {
    expect(
      quotaStatusEntrySpot({
        cloud: CloudType.Azure,
        region: 'eastus',
        resourceName: 'Total Regional Low-priority vCPUs',
        resourceKey: 'azure:lowprioritycores',
        status: 'CURRENT',
      }),
    ).toBe(true);
    expect(
      quotaStatusEntrySpot({
        cloud: CloudType.Azure,
        region: 'eastus',
        resourceName: 'Total Regional vCPUs',
        resourceKey: 'azure:cores',
        status: 'CURRENT',
      }),
    ).toBe(false);
    // Family quotas gate only on-demand launches, so a spot-scoped status
    // view hides them — the resource's gating role beats the filed intent,
    // even for rows from historical spot-filed operations.
    expect(
      quotaStatusEntrySpot({
        cloud: CloudType.Azure,
        region: 'eastus',
        resourceName: 'Standard NCads H100 v5 Family vCPUs',
        resourceKey: 'azure:standardncadsh100v5family',
        status: 'CURRENT',
      }),
    ).toBe(false);
    expect(
      quotaStatusEntrySpot({
        cloud: CloudType.Azure,
        region: 'eastus',
        resourceName: 'Standard NCads H100 v5 Family vCPUs',
        resourceKey: 'azure:standardncadsh100v5family',
        status: 'APPROVED',
        spot: true,
      }),
    ).toBe(false);
    // Public IP quota gates both pricing models, so the resource cannot
    // classify itself — the entry's stored spot flag is the fallback there.
    expect(
      quotaStatusEntrySpot({
        cloud: CloudType.Azure,
        region: 'eastus',
        resourceName: 'Public IP Addresses - Standard',
        resourceKey: 'azure:standardskupublicipaddresses',
        status: 'CURRENT',
      }),
    ).toBeUndefined();
    expect(
      quotaStatusEntrySpot({
        cloud: CloudType.Azure,
        region: 'eastus',
        resourceName: 'Public IP Addresses - Standard',
        resourceKey: 'azure:standardskupublicipaddresses',
        status: 'QUEUED',
        spot: true,
      }),
    ).toBe(true);
    // Historical public-IP rows can lack a stored resourceKey; the display
    // name then synthesizes a family-SHAPED key via the ticket-series
    // fallback (azure:standardpublicipaddressesstandardfamily). That must
    // not classify as a VM family — the stored flag still governs.
    expect(
      quotaStatusEntrySpot({
        cloud: CloudType.Azure,
        region: 'eastus',
        resourceName: 'Public IP Addresses - Standard',
        status: 'APPROVED',
        spot: true,
      }),
    ).toBe(true);
    expect(
      quotaStatusEntrySpot({
        cloud: CloudType.Azure,
        region: 'eastus',
        resourceName: 'Public IP Addresses - Standard',
        status: 'APPROVED',
      }),
    ).toBeUndefined();
  });

  it('defaults Azure local operation status rows to include public IP quota', () => {
    const entries = plannedQuotaStatusEntriesForTarget({
      id: 'quota-target-1',
      operation_id: 'quota-1',
      target_index: 0,
      vm_type: 'Standard_D2as_v5',
      region: 'eastus',
      spot: 0,
      include_public_ip_quota: null,
      status: QuotaOperationTargetStatus.Pending,
      attempts: 0,
      entries_json: null,
      error: null,
      started_at: null,
      completed_at: null,
      updated_at: Date.parse('2026-06-20T16:20:30.000Z'),
      operation_status: QuotaOperationStatus.Queued,
      operation_cloud_provider: CloudType.Azure,
      operation_credential_name: 'azure-prod',
      operation_created_at: Date.parse('2026-06-20T16:20:30.000Z'),
      operation_updated_at: Date.parse('2026-06-20T16:20:30.000Z'),
    } satisfies QuotaStatusOperationTargetRow);

    expect(entries.map((entry) => entry.resourceKey)).toEqual([
      'azure:standarddasv5family',
      'azure:cores',
      'azure:standardskupublicipaddresses',
    ]);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'local_operation',
          resourceName: 'Public IP Addresses - Standard',
          status: 'QUEUED',
        }),
      ]),
    );
  });

  it('maps completed operation entries to local quota status rows', () => {
    const entries = completedQuotaStatusEntriesForTarget({
      id: 'quota-target-1',
      operation_id: 'quota-1',
      target_index: 0,
      vm_type: 'g6e.48xlarge',
      region: 'us-east-1',
      spot: 0,
      include_public_ip_quota: null,
      status: QuotaOperationTargetStatus.Completed,
      attempts: 1,
      entries_json: JSON.stringify([
        {
          cloud: CloudType.AWS,
          region: 'us-east-1',
          resourceName: 'G and VT',
          previousLimit: 0,
          requestedLimit: 192,
          grantedLimit: null,
          status: 'submitted',
          providerRequestId: 'provider-request-1',
          providerCaseId: 'case-1',
          url: 'https://example.com/case-1',
        },
        {
          cloud: CloudType.AWS,
          region: 'us-east-1',
          resourceName: 'Running On-Demand P instances',
          previousLimit: 0,
          requestedLimit: 192,
          grantedLimit: null,
          status: 'failed',
        },
      ]),
      error: null,
      started_at: Date.parse('2026-06-20T16:20:30.000Z'),
      completed_at: Date.parse('2026-06-20T16:21:30.000Z'),
      updated_at: Date.parse('2026-06-20T16:21:30.000Z'),
      operation_status: QuotaOperationStatus.Completed,
      operation_cloud_provider: CloudType.AWS,
      operation_credential_name: 'aws-prod',
      operation_created_at: Date.parse('2026-06-20T16:20:00.000Z'),
      operation_updated_at: Date.parse('2026-06-20T16:21:30.000Z'),
    } satisfies QuotaStatusOperationTargetRow);

    expect(entries).toEqual([
      expect.objectContaining({
        kind: 'request',
        source: 'local_operation',
        cloud: CloudType.AWS,
        region: 'us-east-1',
        resourceName: 'Running On-Demand G and VT instances',
        resourceKey: 'aws:l-db2e81ba',
        status: 'submitted',
        requestedLimit: 192,
        providerRequestId: 'provider-request-1',
        providerCaseId: 'case-1',
        operationId: 'quota-1',
        operationTargetId: 'quota-target-1',
        vmType: 'g6e.48xlarge',
        spot: false,
        requestedAt: '2026-06-20T16:20:00.000Z',
      }),
    ]);
  });

  it('keeps historical public-IP keys distinct in completed Azure operation entries', () => {
    const entries = completedQuotaStatusEntriesForTarget({
      id: 'quota-target-azure',
      operation_id: 'quota-azure',
      target_index: 0,
      vm_type: 'Standard_NC4as_T4_v3',
      region: 'eastus',
      spot: 0,
      include_public_ip_quota: 1,
      status: QuotaOperationTargetStatus.Completed,
      attempts: 1,
      entries_json: JSON.stringify([
        {
          cloud: CloudType.Azure,
          region: 'eastus',
          resourceName: 'Standard NCas T4 v3 Family vCPUs',
          resourceKey: 'azure:standardncasv3t4family',
          previousLimit: 0,
          requestedLimit: 4,
          grantedLimit: null,
          status: 'submitted',
        },
        {
          cloud: CloudType.Azure,
          region: 'eastus',
          resourceName: 'Public IP Addresses - Standard',
          resourceKey: 'azure:publicipv4addressesstandard',
          previousLimit: 10,
          requestedLimit: 20,
          grantedLimit: null,
          status: 'submitted',
        },
        {
          cloud: CloudType.Azure,
          region: 'eastus',
          resourceName: 'Public IP Addresses - Standard',
          previousLimit: 10,
          requestedLimit: 20,
          grantedLimit: null,
          status: 'submitted',
        },
      ]),
      error: null,
      started_at: Date.parse('2026-06-20T16:20:30.000Z'),
      completed_at: Date.parse('2026-06-20T16:21:30.000Z'),
      updated_at: Date.parse('2026-06-20T16:21:30.000Z'),
      operation_status: QuotaOperationStatus.Completed,
      operation_cloud_provider: CloudType.Azure,
      operation_credential_name: 'azure-prod',
      operation_created_at: Date.parse('2026-06-20T16:20:00.000Z'),
      operation_updated_at: Date.parse('2026-06-20T16:21:30.000Z'),
    } satisfies QuotaStatusOperationTargetRow);

    expect(entries).toEqual([
      expect.objectContaining({
        resourceName: 'Standard NCas T4 v3 Family vCPUs',
        resourceKey: 'azure:standardncasv3_t4family',
      }),
      expect.objectContaining({
        resourceName: 'Public IP Addresses - Standard',
        resourceKey: 'azure:publicipv4addressesstandard',
      }),
      expect.objectContaining({
        resourceName: 'Public IP Addresses - Standard',
      }),
    ]);
    expect(entries[2].resourceKey).not.toBe(
      'azure:standardskupublicipaddresses',
    );
  });

  it('normalizes provider status names to the same resource keys', () => {
    const familyEntry: QuotaStatusEntry = {
      cloud: CloudType.Azure,
      region: 'eastus',
      resourceName: 'Standard NCads H100 v5 Family vCPUs',
      status: 'InProgress',
    };
    const supportTicketEntry: QuotaStatusEntry = {
      cloud: CloudType.Azure,
      region: 'eastus',
      resourceName: 'NCads H100 v5',
      status: 'Open',
    };
    const publicIpEntry: QuotaStatusEntry = {
      cloud: CloudType.Azure,
      region: 'eastus',
      resourceName: 'Public IPv4 Addresses - Standard',
      resourceKey: 'azure:IPv4StandardSkuPublicIpAddresses',
      status: 'CURRENT',
    };
    const awsEntry: QuotaStatusEntry = {
      cloud: CloudType.AWS,
      region: 'us-east-1',
      resourceName:
        'All Standard (A, C, D, H, I, M, R, T, Z) Spot Instance Requests',
      status: 'PENDING',
    };
    const awsLegacyKeyEntry: QuotaStatusEntry = {
      cloud: CloudType.AWS,
      region: 'us-east-1',
      resourceName: 'Running On-Demand G and VT instances',
      resourceKey: 'aws:on-demand:gandvt',
      status: 'PENDING',
    };

    expect(quotaStatusResourceKey(familyEntry)).toBe(
      'azure:standardncadsh100v5family',
    );
    expect(quotaStatusResourceKey(supportTicketEntry)).toBe(
      'azure:standardncadsh100v5family',
    );
    expect(quotaStatusResourceKey(publicIpEntry)).toBe(
      'azure:standardskupublicipaddresses',
    );
    expect(quotaStatusResourceKey(awsEntry)).toBe('aws:l-34b43a08');
    expect(quotaStatusResourceKey(awsLegacyKeyEntry)).toBe('aws:l-db2e81ba');
  });

  it('canonicalizes explicit Azure request-entry keys without inventing missing keys', () => {
    const explicit: QuotaRequestEntry = {
      cloud: CloudType.Azure,
      region: 'eastus',
      resourceName: 'Standard NCASv3 T4 Family vCPUs',
      resourceKey: 'AZURE:Standard NCASv3_T4 Family',
      previousLimit: 0,
      requestedLimit: 4,
      grantedLimit: null,
      status: QuotaRequestStatus.Submitted,
    };
    const keyless: QuotaRequestEntry = {
      cloud: CloudType.Azure,
      region: 'eastus',
      resourceName: 'Standard NCASv3 T4 Family vCPUs',
      previousLimit: 0,
      requestedLimit: 4,
      grantedLimit: null,
      status: QuotaRequestStatus.Submitted,
    };

    expect(
      canonicalQuotaResourceKey(CloudType.Azure, explicit.resourceKey!),
    ).toBe('azure:standardncasv3_t4family');
    expect(canonicalizeQuotaRequestEntry(CloudType.Azure, explicit)).toEqual({
      ...explicit,
      resourceKey: 'azure:standardncasv3_t4family',
    });
    expect(
      canonicalizeQuotaRequestEntry(CloudType.Azure, {
        ...explicit,
        resourceName: 'Public IP Addresses',
        resourceKey: 'azure:publicipaddresses',
      }).resourceKey,
    ).toBe('azure:publicipaddresses');
    expect(canonicalizeQuotaRequestEntry(CloudType.Azure, keyless)).toBe(
      keyless,
    );
    const canonicalized = canonicalizeQuotaRequestEntries(CloudType.Azure, [
      explicit,
      keyless,
    ]);
    expect(canonicalized[0].resourceKey).toBe('azure:standardncasv3_t4family');
    expect(canonicalized[1]).toBe(keyless);
  });

  it('reads stored quota entries only as an array of entry objects', () => {
    const entry: QuotaRequestEntry = {
      cloud: CloudType.Azure,
      region: 'eastus',
      resourceName: 'Standard NCASv3 T4 Family vCPUs',
      resourceKey: 'AZURE:Standard NCASv3_T4 Family',
      previousLimit: 0,
      requestedLimit: 4,
      grantedLimit: null,
      status: QuotaRequestStatus.Submitted,
    };

    expect(
      parseStoredQuotaRequestEntries(JSON.stringify([entry]), CloudType.Azure),
    ).toEqual([{ ...entry, resourceKey: 'azure:standardncasv3_t4family' }]);
    for (const stored of [
      null,
      '[',
      '{}',
      JSON.stringify([entry, null]),
      JSON.stringify([entry, []]),
      JSON.stringify([entry, 'entry']),
    ]) {
      expect(parseStoredQuotaRequestEntries(stored, CloudType.Azure)).toEqual(
        [],
      );
    }
  });

  it('derives the underscore-bearing key from an Azure display name', () => {
    // A keyless status/completed entry (e.g. a legacy row) carrying Azure's real
    // localizedValue must resolve to the SAME key the resolver assigns from the
    // VM type. resolveQuotaResourcesForTarget keys NC4as_T4_v3 as
    // 'azure:standardncasv3_t4family' (with the underscore), so the name path
    // must restore it rather than stripping the separator.
    const keyFromVmType = resolveQuotaResourcesForTarget({
      cloud: CloudType.Azure,
      vmType: 'Standard_NC4as_T4_v3',
      spot: false,
      includePublicIpQuota: false,
    })[0].key;
    expect(keyFromVmType).toBe('azure:standardncasv3_t4family');

    const keyFromName = quotaStatusResourceKey({
      cloud: CloudType.Azure,
      region: 'eastus',
      resourceName: 'Standard NCASv3 T4 Family vCPUs',
      status: 'CURRENT',
    });
    expect(keyFromName).toBe(keyFromVmType);
  });

  it('returns AWS regions with sufficient current quota for a VM type', () => {
    expect(
      quotaSupportedRegionsForVmType({
        cloud: CloudType.AWS,
        vmType: 't3.large',
        spot: false,
        regions: ['us-east-1', 'us-west-2'],
        entries: [
          {
            kind: 'current',
            cloud: CloudType.AWS,
            region: 'us-east-1',
            resourceName: 'Running On-Demand Standard instances',
            status: 'CURRENT',
            currentLimit: 2,
          },
          {
            kind: 'current',
            cloud: CloudType.AWS,
            region: 'us-west-2',
            resourceName: 'Running On-Demand Standard instances',
            status: 'CURRENT',
            currentLimit: 1,
          },
        ],
      }),
    ).toEqual(['us-east-1']);
  });

  it('requires every Azure quota resource to be present and sufficient', () => {
    const supported = quotaSupportedRegionsForVmType({
      cloud: CloudType.Azure,
      vmType: 'Standard_NC40ads_H100_v5',
      spot: false,
      includePublicIpQuota: true,
      regions: ['eastus2', 'westus3', 'southcentralus'],
      entries: [
        {
          kind: 'current',
          cloud: CloudType.Azure,
          region: 'eastus2',
          resourceName: 'Standard NCads H100 v5 Family vCPUs',
          status: 'CURRENT',
          currentLimit: 40,
        },
        {
          kind: 'current',
          cloud: CloudType.Azure,
          region: 'eastus2',
          resourceName: 'Total Regional vCPUs',
          status: 'CURRENT',
          currentLimit: 80,
        },
        {
          kind: 'current',
          cloud: CloudType.Azure,
          region: 'eastus2',
          resourceName: 'Public IPv4 Addresses - Standard',
          resourceKey: 'azure:standardskupublicipaddresses',
          status: 'CURRENT',
          currentLimit: 1,
        },
        {
          kind: 'current',
          cloud: CloudType.Azure,
          region: 'westus3',
          resourceName: 'Standard NCads H100 v5 Family vCPUs',
          status: 'CURRENT',
          currentLimit: 40,
        },
        {
          kind: 'current',
          cloud: CloudType.Azure,
          region: 'westus3',
          resourceName: 'Total Regional vCPUs',
          status: 'CURRENT',
          currentLimit: 20,
        },
        {
          kind: 'current',
          cloud: CloudType.Azure,
          region: 'southcentralus',
          resourceName: 'Standard NCads H100 v5 Family vCPUs',
          status: 'CURRENT',
          currentLimit: 40,
        },
        {
          kind: 'current',
          cloud: CloudType.Azure,
          region: 'southcentralus',
          resourceName: 'Total Regional vCPUs',
          status: 'CURRENT',
          currentLimit: 80,
        },
      ],
    });

    expect(supported).toEqual(['eastus2']);
  });
});
