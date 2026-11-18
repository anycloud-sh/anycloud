import { beforeEach, describe, expect, it, vi } from 'vitest';

const azureMocks = vi.hoisted(() => {
  const state = {
    getGroup: vi.fn(),
    residuals: [] as Array<{ id?: string; tags?: Record<string, string> }>,
    terminateVMs: vi.fn(),
    containers: [] as Array<{
      metadata?: Record<string, string>;
      name?: string;
    }>,
    deletes: [] as string[],
    disks: [] as Array<{
      id?: string;
      name?: string;
      tags?: Record<string, string>;
    }>,
    groups: [] as Array<{ name?: string }>,
    nics: [] as Array<{ name?: string; tags?: Record<string, string> }>,
    nsgs: [] as Array<{ name?: string; tags?: Record<string, string> }>,
    publicIps: [] as Array<{ name?: string; tags?: Record<string, string> }>,
    vms: [] as Array<{
      id?: string;
      name?: string;
      tags?: Record<string, string>;
    }>,
    vnets: [] as Array<{ name?: string; tags?: Record<string, string> }>,
  };

  function list<T>(items: T[]): AsyncIterable<T> {
    return (async function* () {
      for (const item of items) yield item;
    })();
  }

  function deletePoller(type: string) {
    return async (resourceGroup: string, name: string) => {
      state.deletes.push(`${type}:${resourceGroup}:${name}`);
      return { pollUntilDone: async () => undefined };
    };
  }

  return { ...state, deletePoller, list };
});

vi.mock('@azure/identity', () => ({
  ClientSecretCredential: vi.fn(),
}));
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@azure/arm-resources', () => ({
  ResourceManagementClient: vi.fn().mockImplementation(function () {
    return {
      resourceGroups: {
        get: azureMocks.getGroup,
        list: () => azureMocks.list(azureMocks.groups),
      },
      resources: {
        listByResourceGroup: () => azureMocks.list(azureMocks.residuals),
      },
    };
  }),
}));

vi.mock('../../../src/api/services/gateways/azure.js', () => ({
  Azure: vi.fn().mockImplementation(function () {
    return { compute: () => ({ terminateVMs: azureMocks.terminateVMs }) };
  }),
}));

vi.mock('@azure/arm-compute', () => ({
  ComputeManagementClient: vi.fn().mockImplementation(function () {
    return {
      disks: {
        beginDelete: azureMocks.deletePoller('disk'),
        listByResourceGroup: () => azureMocks.list(azureMocks.disks),
      },
      virtualMachines: {
        beginDelete: azureMocks.deletePoller('vm'),
        list: () => azureMocks.list(azureMocks.vms),
      },
    };
  }),
}));

vi.mock('@azure/arm-network', () => ({
  NetworkManagementClient: vi.fn().mockImplementation(function () {
    return {
      networkInterfaces: {
        beginDelete: azureMocks.deletePoller('nic'),
        list: () => azureMocks.list(azureMocks.nics),
      },
      networkSecurityGroups: {
        beginDelete: azureMocks.deletePoller('nsg'),
        list: () => azureMocks.list(azureMocks.nsgs),
      },
      publicIPAddresses: {
        beginDelete: azureMocks.deletePoller('publicIp'),
        list: () => azureMocks.list(azureMocks.publicIps),
      },
      virtualNetworks: {
        beginDelete: azureMocks.deletePoller('vnet'),
        list: () => azureMocks.list(azureMocks.vnets),
      },
    };
  }),
}));

vi.mock('@azure/storage-blob', () => ({
  BlobServiceClient: vi.fn().mockImplementation(function () {
    return {
      getContainerClient: (name: string) => ({
        deleteIfExists: async () => {
          azureMocks.deletes.push(`container:${name}`);
          return true;
        },
      }),
      listContainers: () => azureMocks.list(azureMocks.containers),
    };
  }),
}));

import {
  cleanupAzureManagedGpuOwner,
  cleanupAzureServeRun,
} from '../../../ci/cleanup/azure-nuke-run';

const credentials = {
  AZURE_CLIENT_ID: 'client',
  AZURE_CLIENT_SECRET: 'secret',
  AZURE_SUBSCRIPTION_ID: '12345678-aaaa-bbbb-cccc-eeeeeeeeeeee',
  AZURE_TENANT_ID: 'tenant',
};
const resourceId = (type: string, name: string) =>
  `/subscriptions/${credentials.AZURE_SUBSCRIPTION_ID}/resourceGroups/anycloud-westus2/providers/${type}/${name}`;

describe('azure serve-run cleanup', () => {
  beforeEach(() => {
    azureMocks.getGroup.mockReset().mockResolvedValue({});
    azureMocks.terminateVMs
      .mockReset()
      .mockImplementation(async (ids: string[]) => ids);
    azureMocks.residuals.length = 0;
    azureMocks.containers.length = 0;
    azureMocks.deletes.length = 0;
    azureMocks.disks.length = 0;
    azureMocks.groups.length = 0;
    azureMocks.nics.length = 0;
    azureMocks.nsgs.length = 0;
    azureMocks.publicIps.length = 0;
    azureMocks.vms.length = 0;
    azureMocks.vnets.length = 0;
  });

  it('recovers only resource ownership for the exact hosted API and region through gateway VM teardown', async () => {
    const owner = 'a'.repeat(32);
    const tags = { anycloud_owner_api: owner, anycloud_resource: 'cluster-1' };
    azureMocks.vms.push(
      {
        id: resourceId('Microsoft.Compute/virtualMachines', 'owned'),
        name: 'owned',
        tags,
      },
      {
        name: 'other-run',
        tags: { ...tags, anycloud_owner_api: 'b'.repeat(32) },
      },
      { name: 'shared', tags: { managed_by: 'anycloud' } },
    );
    azureMocks.disks.push({
      id: resourceId('Microsoft.Compute/disks', 'orphaned-owned-disk'),
      name: 'orphaned-owned-disk',
      tags,
    });
    azureMocks.nsgs.push({ name: 'shared', tags: { managed_by: 'anycloud' } });
    azureMocks.containers.push({ name: 'shared-storage', metadata: tags });
    const result = await cleanupAzureManagedGpuOwner(
      'westus2',
      owner,
      credentials,
    );
    expect(azureMocks.getGroup).toHaveBeenCalledWith('anycloud-westus2');
    expect(azureMocks.terminateVMs).toHaveBeenCalledExactlyOnceWith(['owned']);
    expect(azureMocks.deletes).toEqual([
      'disk:anycloud-westus2:orphaned-owned-disk',
    ]);
    expect(result).toMatchObject({
      summary: { errors: [] },
      residualResources: [],
    });
  });

  it('retains supporting resources when gateway VM teardown cannot establish disk ownership', async () => {
    const owner = 'a'.repeat(32);
    const tags = { anycloud_owner_api: owner, anycloud_resource: 'cluster-1' };
    azureMocks.vms.push({
      id: resourceId('Microsoft.Compute/virtualMachines', 'owned'),
      name: 'owned',
      tags,
    });
    azureMocks.disks.push({
      id: resourceId('Microsoft.Compute/disks', 'disk'),
      name: 'disk',
      tags,
    });
    azureMocks.terminateVMs.mockRejectedValue(
      new Error('disk ownership conflict'),
    );
    const result = await cleanupAzureManagedGpuOwner(
      'westus2',
      owner,
      credentials,
    );
    expect(result.summary.errors).toEqual([
      expect.objectContaining({ error: 'disk ownership conflict' }),
    ]);
    expect(azureMocks.deletes).toEqual([]);
  });

  it('accepts authoritative absence, rejects denied inventory, and reports surviving owned resources', async () => {
    const owner = 'a'.repeat(32);
    azureMocks.getGroup.mockRejectedValueOnce({ statusCode: 404 });
    await expect(
      cleanupAzureManagedGpuOwner('westus2', owner, credentials),
    ).resolves.toMatchObject({ residualResources: [] });
    azureMocks.getGroup.mockRejectedValueOnce({ statusCode: 403 });
    await expect(
      cleanupAzureManagedGpuOwner('westus2', owner, credentials),
    ).rejects.toMatchObject({ statusCode: 403 });
    const id = `/subscriptions/${credentials.AZURE_SUBSCRIPTION_ID}/resourceGroups/anycloud-westus2/providers/Microsoft.Compute/disks/retained`;
    azureMocks.residuals.push({
      id,
      tags: { anycloud_owner_api: owner },
    });
    await expect(
      cleanupAzureManagedGpuOwner('westus2', owner, credentials),
    ).resolves.toMatchObject({ residualResources: [id] });
  });

  it('rejects a matching owner tag on a resource outside the selected group before any deletion', async () => {
    const owner = 'a'.repeat(32);
    azureMocks.disks.push({
      id: resourceId('Microsoft.Compute/disks', 'disk').replace(
        'anycloud-westus2',
        'customer',
      ),
      name: 'disk',
      tags: { anycloud_owner_api: owner, anycloud_resource: 'cluster-1' },
    });
    const result = await cleanupAzureManagedGpuOwner(
      'westus2',
      owner,
      credentials,
    );
    expect(result.summary.errors).toEqual([
      expect.objectContaining({
        error: expect.stringContaining('invalid subscription'),
      }),
    ]);
    expect(azureMocks.deletes).toEqual([]);
  });

  it('deletes only matching anycloud-test serve resources and summarizes them', async () => {
    const matchingTags = {
      anycloud_deployment: 'serve-123456-azure-gpu',
      anycloud_user: 'anycloud-test',
    };
    const customerTags = {
      anycloud_deployment: 'serve-123456-azure-gpu',
      anycloud_user: 'customer',
    };
    const otherRunTags = {
      anycloud_deployment: 'serve-999999-azure-gpu',
      anycloud_user: 'anycloud-test',
    };

    azureMocks.groups.push(
      { name: 'anycloud-westus' },
      { name: 'anycloud-storage' },
      { name: 'prod-anycloud-westus' },
    );
    azureMocks.vms.push(
      { name: 'vm-match', tags: matchingTags },
      { name: 'vm-customer', tags: customerTags },
      { name: 'vm-other-run', tags: otherRunTags },
    );
    azureMocks.nics.push({ name: 'nic-match', tags: matchingTags });
    azureMocks.publicIps.push({ name: 'pip-match', tags: matchingTags });
    azureMocks.nsgs.push({ name: 'nsg-match', tags: matchingTags });
    azureMocks.vnets.push({ name: 'vnet-match', tags: matchingTags });
    azureMocks.disks.push({ name: 'disk-match', tags: matchingTags });
    azureMocks.containers.push(
      { name: 'container-match', metadata: matchingTags },
      { name: 'container-customer', metadata: customerTags },
    );

    const summary = await cleanupAzureServeRun('serve-123456-', credentials);

    expect(summary.resourceGroups).toEqual(['anycloud-westus']);
    expect(summary.errors).toEqual([]);
    expect(summary.deleted).toEqual({
      container: 1,
      disk: 1,
      nic: 1,
      nsg: 1,
      publicIp: 1,
      vm: 1,
      vnet: 1,
    });
    expect(azureMocks.deletes).toEqual([
      'vm:anycloud-westus:vm-match',
      'nic:anycloud-westus:nic-match',
      'publicIp:anycloud-westus:pip-match',
      'nsg:anycloud-westus:nsg-match',
      'vnet:anycloud-westus:vnet-match',
      'disk:anycloud-westus:disk-match',
      'container:container-match',
    ]);
  });
});
