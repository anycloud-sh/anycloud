import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RestError } from '@azure/core-rest-pipeline';
import { calculateVmCosts } from '../../../../src/api/services/cost-calculation/index.js';
import type { VmCostIdentity } from '../../../../src/api/services/cost-calculation/contracts.js';
import type { VmNeedingCost } from '../../../../src/api/services/repositories/billing.js';
import { CloudType } from '../../../../src/shared/cloud.js';

const { costExplorer, usage, sendRequest, bigQuery } = vi.hoisted(() => ({
  costExplorer: vi.fn(),
  usage: vi.fn(),
  sendRequest: vi.fn(),
  bigQuery: vi.fn(),
}));
vi.mock(
  '../../../../src/api/services/provider-clients/azure.js',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    createAzureCredential: () => ({}),
    createAzureCostManagementClient: () => ({ query: { usage }, sendRequest }),
  }),
);
vi.mock(
  '../../../../src/api/services/provider-clients/aws.js',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    createAwsCostExplorerClient: () => ({ send: costExplorer }),
  }),
);
vi.mock(
  '../../../../src/api/services/provider-clients/gcp.js',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    createGcpBigQueryClient: () => ({ query: bigQuery }),
  }),
);

const vm = (owner: string): VmNeedingCost => ({
  cloud_id: `vm-${owner}`,
  workload_id: owner,
  node_pool_id: null,
  cluster_id: null,
  resource_id: owner,
  resource_tag: 'anycloud_deployment',
  credential_id: 'credential',
  created_at: Date.UTC(2026, 9, 1),
  ended_at: Date.UTC(2026, 9, 2),
  cloud_provider: CloudType.Azure,
  region: null,
  vm_type: null,
});
const groups = [[vm('a')], [vm('b')]];
const azure: VmCostIdentity = {
  cloudProvider: CloudType.Azure,
  credentials: {
    applicationId: 'application',
    secret: 'synthetic-no-authority',
    directoryId: 'directory',
    subscriptionId: 'subscription',
  },
};
const columns = [{ name: 'Cost' }, { name: 'ResourceId' }];
const armId = (leaf: string) =>
  `/subscriptions/subscription/resourceGroups/rg/providers/Microsoft.Compute/${leaf}`;

beforeEach(() => vi.resetAllMocks());

describe('batched billing queries', () => {
  it('asks Azure once for many groups, follows nextLink, and splits rows per VM', async () => {
    const nextLink =
      'https://management.azure.com/next?api-version=2023-03-01&$skiptoken=1';
    usage.mockResolvedValue({
      columns,
      rows: [[2, armId('virtualMachines/vm-a')]],
      nextLink,
    });
    sendRequest.mockResolvedValue({
      status: 200,
      bodyAsText: JSON.stringify({
        properties: {
          columns,
          rows: [
            [3, armId('virtualMachines/vm-b')],
            [0.5, armId('disks/vm-b_OsDisk_1')],
          ],
          nextLink: null,
        },
      }),
    });

    await expect(calculateVmCosts(azure, groups)).resolves.toEqual(
      new Map([
        ['vm-a', 2],
        ['vm-b', 3.5],
      ]),
    );
    expect(usage).toHaveBeenCalledOnce();
    expect(usage.mock.calls[0][1].dataset.granularity).toBe('None');
    expect(usage.mock.calls[0][1].dataset.filter).toEqual({
      tags: { name: 'anycloud_deployment', operator: 'In', values: ['a', 'b'] },
    });
    expect(sendRequest).toHaveBeenCalledOnce();
    expect(sendRequest.mock.calls[0][0]).toMatchObject({
      url: nextLink,
      method: 'POST',
    });
  });

  it("does not give one owner's Azure resources to another owner's VM", async () => {
    // Owner `job-0` names its VMs `job-0-<n>`, which also reads as a resource
    // of owner `job`'s VM `job-0`; `job-0-0` is an already settled attempt.
    usage.mockResolvedValue({
      columns,
      rows: [
        [5, armId('virtualMachines/job-0-0')],
        [2, armId('virtualMachines/job-0')],
        [3, armId('virtualMachines/job-0-1')],
      ],
    });

    await expect(
      calculateVmCosts(azure, [
        [{ ...vm('job'), cloud_id: 'job-0' }],
        [{ ...vm('job-0'), cloud_id: 'job-0-1' }],
      ]),
    ).resolves.toEqual(
      new Map([
        ['job-0', 2],
        ['job-0-1', 3],
      ]),
    );
  });

  it("keeps a VM's own OS disk when a nested owner shares the batch", async () => {
    usage.mockResolvedValue({
      columns,
      rows: [
        [2, armId('virtualMachines/job-0')],
        [0.5, armId('disks/job-0_OsDisk_1_0123abcd')],
        [3, armId('virtualMachines/job-0-1')],
      ],
    });

    await expect(
      calculateVmCosts(azure, [
        [{ ...vm('job'), cloud_id: 'job-0' }],
        [{ ...vm('job-0'), cloud_id: 'job-0-1' }],
      ]),
    ).resolves.toEqual(
      new Map([
        ['job-0', 2.5],
        ['job-0-1', 3],
      ]),
    );
  });

  it('falls back to one query per group when a batch is rejected with 400', async () => {
    usage.mockImplementation(async (_scope, query) => {
      const [owner, ...rest] = query.dataset.filter.tags.values;
      if (rest.length > 0) {
        throw new RestError('Bad request', { statusCode: 400 });
      }
      return {
        columns,
        rows: [[1, armId(`virtualMachines/vm-${owner}`)]],
      };
    });

    await expect(calculateVmCosts(azure, groups)).resolves.toEqual(
      new Map([
        ['vm-a', 1],
        ['vm-b', 1],
      ]),
    );
    expect(usage).toHaveBeenCalledTimes(3);
  });

  it('settles the rest when one group still fails in the per-group fallback', async () => {
    usage.mockImplementation(async (_scope, query) => {
      const [owner, ...rest] = query.dataset.filter.tags.values;
      if (rest.length > 0 || owner === 'b') {
        throw new RestError('Bad request', { statusCode: 400 });
      }
      return {
        columns,
        rows: [[1, armId(`virtualMachines/vm-${owner}`)]],
      };
    });

    await expect(
      calculateVmCosts(azure, [...groups, [vm('c')]]),
    ).resolves.toEqual(
      new Map([
        ['vm-a', 1],
        ['vm-c', 1],
      ]),
    );
  });

  it('stops the per-group fallback when the provider throttles', async () => {
    usage.mockImplementation(async (_scope, query) => {
      const status = query.dataset.filter.tags.values.length > 1 ? 400 : 429;
      throw new RestError('Rejected', { statusCode: status });
    });

    await expect(calculateVmCosts(azure, groups)).rejects.toMatchObject({
      statusCode: 429,
    });
    expect(usage).toHaveBeenCalledTimes(2);
  });

  it('does not split a batch that AWS Cost Explorer throttles', async () => {
    // Cost Explorer throttles with HTTP 400, the status that splits a batch.
    costExplorer.mockRejectedValue(
      Object.assign(new Error('Rate exceeded'), {
        name: 'LimitExceededException',
        $metadata: { httpStatusCode: 400 },
      }),
    );
    const aws: VmCostIdentity = {
      cloudProvider: CloudType.AWS,
      credentials: {
        accessKeyId: 'access',
        secretAccessKey: 'synthetic-no-authority',
      },
    };

    await expect(calculateVmCosts(aws, groups)).rejects.toMatchObject({
      name: 'LimitExceededException',
    });
    expect(costExplorer).toHaveBeenCalledOnce();
  });

  it('asks the GCP billing export once for many groups', async () => {
    bigQuery.mockResolvedValue([
      [
        { resource_name: 'vm-a', net_cost: 2, currency: 'USD' },
        { resource_name: 'vm-b', net_cost: 3, currency: 'USD' },
      ],
    ]);
    const gcp: VmCostIdentity = {
      cloudProvider: CloudType.GCP,
      credentials: {
        projectId: 'project',
        privateKey: 'synthetic-no-authority',
        clientEmail: 'billing@project.iam.gserviceaccount.com',
        billingExportDataset: 'project.dataset',
      },
    };

    await expect(calculateVmCosts(gcp, groups)).resolves.toEqual(
      new Map([
        ['vm-a', 2],
        ['vm-b', 3],
      ]),
    );
    expect(bigQuery).toHaveBeenCalledOnce();
    expect(bigQuery.mock.calls[0][0].params.resourceIds).toEqual(['a', 'b']);
  });
});
