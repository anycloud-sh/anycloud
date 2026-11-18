/**
 * Azure Cleanup Integration Test
 *
 * Tests the account resource sweep for Azure.
 *
 * NOTE: This test is for local development/verification only.
 * NOT included in CI - CI uses ci/cleanup/azure.ts in pre/post cleanup jobs instead.
 *
 * Requirements:
 * - Azure credentials in environment (from .env.azure):
 *   - AZURE_SUBSCRIPTION_ID
 *   - AZURE_TENANT_ID
 *   - AZURE_CLIENT_ID
 *   - AZURE_CLIENT_SECRET
 *
 * Run with:
 *   source .env.azure && yarn test test/integration/azure-cleanup.spec.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { completeCloudConfig } from '../../src/shared/cloud-config.js';
import { TEST_RESOURCE_SWEEP_OPTIONS } from '../helpers/resource-sweep-policy';
import { Azure, isAzureNotFound } from '../../src/api/services/gateways/azure';
import { CloudConfig, CloudType } from '../../src/shared/cloud.js';

describe('Azure resource sweep integration', () => {
  const region = 'eastus';
  const availabilityZone = undefined;
  const testConfig: CloudConfig = {
    cloudProvider: CloudType.Azure,
    credentials: {
      subscriptionId: process.env.AZURE_SUBSCRIPTION_ID!,
      directoryId: process.env.AZURE_TENANT_ID!,
      applicationId: process.env.AZURE_CLIENT_ID!,
      secret: process.env.AZURE_CLIENT_SECRET!,
    },
    region,
    availabilityZone,
    vmType: 'Standard_D2s_v5',
  };

  beforeAll(async () => {
    // Fail hard if Azure credentials are not configured
    if (
      !process.env.AZURE_SUBSCRIPTION_ID ||
      !process.env.AZURE_TENANT_ID ||
      !process.env.AZURE_CLIENT_ID ||
      !process.env.AZURE_CLIENT_SECRET
    ) {
      throw new Error(
        'Azure credentials not found in environment. Please set AZURE_SUBSCRIPTION_ID, AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET',
      );
    }

    // Cleanup orphaned resources before tests
    console.log('Running pre-test cleanup...');
    const azure = new Azure(completeCloudConfig(testConfig));
    const result = await azure
      .sweeper()
      .sweepResources(TEST_RESOURCE_SWEEP_OPTIONS);
    console.log(
      `Pre-test cleanup: removed ${result.vmIds.length} VMs, ${result.otherResources.length} other resources`,
    );
  }, 600000); // 10 minute timeout for cleanup (Azure is slower)

  afterAll(async () => {
    // Cleanup orphaned resources after tests (runs even on failure/cancellation)
    console.log('Running post-test cleanup...');
    const azure = new Azure(completeCloudConfig(testConfig));
    const result = await azure
      .sweeper()
      .sweepResources(TEST_RESOURCE_SWEEP_OPTIONS);
    console.log(
      `Post-test cleanup: removed ${result.vmIds.length} VMs, ${result.otherResources.length} other resources`,
    );
  }, 600000); // 10 minute timeout for cleanup (Azure is slower)

  it('should cleanup resources with ended_at tag', async () => {
    const timestamp = Date.now();
    const vmId = `cleanup-ended-${timestamp}`;
    const workloadId = `cleanup-fw-${timestamp}`;

    const azure = new Azure(completeCloudConfig(testConfig));

    // Create firewall/vnet and VM
    await azure
      .compute()
      .upsertFirewall([], workloadId, '0.0.0-test', 'anycloud-test');
    const _vm = await azure.compute().newVM({
      startupScript: '#!/bin/bash\necho "cleanup test"',
      ipWhitelist: [],
      vmId,
      workloadId,
      version: '0.0.0-test',
      userId: 'anycloud-test',
    });

    await azure.initializeAzure();
    const resourceGroup = azure.resourceGroup;

    // Manually tag VM with ended_at
    const vmData = await azure.computeClient.virtualMachines.get(
      resourceGroup,
      vmId,
    );
    const updatePoller =
      await azure.computeClient.virtualMachines.beginCreateOrUpdate(
        resourceGroup,
        vmId,
        {
          ...vmData,
          tags: {
            ...vmData.tags,
            anycloud_ended_at: Date.now().toString(),
          },
        },
      );
    await updatePoller.pollUntilDone();

    // Also tag the VNet with ended_at. A public-SSH VM has no NSG of its
    // own: it uses the region's shared one, which no sweep takes.
    const vnetList = azure.networkClient.virtualNetworks.list(resourceGroup);
    for await (const vnet of vnetList) {
      if (vnet.tags?.anycloud_deployment === workloadId && vnet.name) {
        const vnetUpdate =
          await azure.networkClient.virtualNetworks.beginCreateOrUpdate(
            resourceGroup,
            vnet.name,
            {
              ...vnet,
              tags: {
                ...vnet.tags,
                anycloud_ended_at: Date.now().toString(),
              },
            },
          );
        await vnetUpdate.pollUntilDone();
      }
    }

    // Run cleanup
    const result = await azure
      .sweeper()
      .sweepResources(TEST_RESOURCE_SWEEP_OPTIONS);

    expect(result.vmIds).toContain(vmId);
    expect(
      result.otherResources.some(
        (r) => r.type === 'nsg' && r.id === 'anycloud-shared-vm',
      ),
    ).toBe(false);
    expect(result.otherResources.some((r) => r.type === 'vnet')).toBe(true);
    // Only check that our specific resources didn't error
    const ourVmError = result.errors.find((e) => e.resourceId === vmId);
    expect(ourVmError).toBeUndefined();

    // Verify VM was deleted
    try {
      await azure.computeClient.virtualMachines.get(resourceGroup, vmId);
      expect.fail('VM should have been deleted');
    } catch (error) {
      expect(isAzureNotFound(error)).toBe(true);
    }
  }, 600000); // 10 min timeout for Azure

  it('should cleanup test resources (empty userId)', async () => {
    const timestamp = Date.now();
    const vmId = `cleanup-test-${timestamp}`;
    const workloadId = `cleanup-test-fw-${timestamp}`;

    const azure = new Azure(completeCloudConfig(testConfig));

    // Create resources with userId=''
    await azure.compute().upsertFirewall([], workloadId, '0.0.0-test', '');
    const _vm = await azure.compute().newVM({
      startupScript: '#!/bin/bash\necho "test resource"',
      ipWhitelist: [],
      vmId,
      workloadId,
      version: '0.0.0-test',
      userId: '',
    });

    // Run cleanup
    const result = await azure
      .sweeper()
      .sweepResources(TEST_RESOURCE_SWEEP_OPTIONS);

    expect(result.vmIds).toContain(vmId);
    // Only check that our specific resources didn't error
    const ourVmError = result.errors.find((e) => e.resourceId === vmId);
    expect(ourVmError).toBeUndefined();

    // Verify VM was deleted
    await azure.initializeAzure();
    const resourceGroup = azure.resourceGroup;
    try {
      await azure.computeClient.virtualMachines.get(resourceGroup, vmId);
      expect.fail('VM should have been deleted');
    } catch (error) {
      expect(isAzureNotFound(error)).toBe(true);
    }
  }, 600000);

  it('should not delete active resources', async () => {
    const timestamp = Date.now();
    const vmId = `cleanup-active-${timestamp}`;
    const workloadId = `cleanup-active-fw-${timestamp}`;

    const azure = new Azure(completeCloudConfig(testConfig));

    // Create resources without ended_at tag and with real userId
    await azure
      .compute()
      .upsertFirewall([], workloadId, '0.0.0-test', 'real-user');
    const _vm = await azure.compute().newVM({
      startupScript: '#!/bin/bash\necho "active resource"',
      ipWhitelist: [],
      vmId,
      workloadId,
      version: '0.0.0-test',
      userId: 'real-user',
    });

    // Run cleanup
    const result = await azure
      .sweeper()
      .sweepResources(TEST_RESOURCE_SWEEP_OPTIONS);

    // Should not include our VM
    expect(result.vmIds).not.toContain(vmId);

    // Verify VM still exists
    await azure.initializeAzure();
    const resourceGroup = azure.resourceGroup;
    const vmData = await azure.computeClient.virtualMachines.get(
      resourceGroup,
      vmId,
    );
    expect(vmData.name).toBe(vmId);

    // Cleanup after test
    await azure.compute().terminateVMs([vmId]);
    await azure.compute().terminateNetworking(workloadId);
  }, 600000);

  it('should support dry run', async () => {
    const timestamp = Date.now();
    const vmId = `cleanup-dryrun-${timestamp}`;
    const workloadId = `cleanup-dryrun-fw-${timestamp}`;

    const azure = new Azure(completeCloudConfig(testConfig));

    // Create resources with ended_at tag
    await azure
      .compute()
      .upsertFirewall([], workloadId, '0.0.0-test', 'anycloud-test');
    const _vm = await azure.compute().newVM({
      startupScript: '#!/bin/bash\necho "dryrun test"',
      ipWhitelist: [],
      vmId,
      workloadId,
      version: '0.0.0-test',
      userId: 'anycloud-test',
    });

    await azure.initializeAzure();
    const resourceGroup = azure.resourceGroup;

    // Tag with ended_at
    const vmData = await azure.computeClient.virtualMachines.get(
      resourceGroup,
      vmId,
    );
    const updatePoller =
      await azure.computeClient.virtualMachines.beginCreateOrUpdate(
        resourceGroup,
        vmId,
        {
          ...vmData,
          tags: {
            ...vmData.tags,
            anycloud_ended_at: Date.now().toString(),
          },
        },
      );
    await updatePoller.pollUntilDone();

    // Dry run
    const dryResult = await azure.sweeper().sweepResources({
      ...TEST_RESOURCE_SWEEP_OPTIONS,
      dryRun: true,
    });
    expect(dryResult.vmIds).toContain(vmId);

    // Verify VM NOT deleted (still exists)
    const stillExists = await azure.computeClient.virtualMachines.get(
      resourceGroup,
      vmId,
    );
    expect(stillExists.name).toBe(vmId);

    // Actual cleanup
    const result = await azure
      .sweeper()
      .sweepResources(TEST_RESOURCE_SWEEP_OPTIONS);
    expect(result.vmIds).toContain(vmId);

    // Verify VM was deleted this time
    try {
      await azure.computeClient.virtualMachines.get(resourceGroup, vmId);
      expect.fail('VM should have been deleted');
    } catch (error) {
      expect(isAzureNotFound(error)).toBe(true);
    }
  }, 600000);
});
