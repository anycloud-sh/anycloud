/**
 * Azure Sad Path Integration Test
 *
 * Tests failure scenarios: verifies that when VM creation fails (e.g., due to
 * invalid config or quota), partial resources (Public IP, NIC) are cleaned up.
 *
 * Requirements:
 * - Azure credentials in environment (from .env.azure):
 *   - AZURE_SUBSCRIPTION_ID
 *   - AZURE_TENANT_ID
 *   - AZURE_CLIENT_ID
 *   - AZURE_CLIENT_SECRET
 *
 * Run with:
 *   source .env.azure && yarn test test/integration/azure-sad.spec.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { completeCloudConfig } from '../../src/shared/cloud-config.js';
import { Azure, isAzureNotFound } from '../../src/api/services/gateways/azure';
import { CloudConfig, CloudType } from '../../src/shared/cloud.js';
import { ensureVMTerminated } from './azure-test-utils';
import {
  errorText,
  requireAzureAuthentication,
} from './helpers/external-errors';
import { useTestCatalogs } from './helpers/test-catalogs.js';

useTestCatalogs();

/** The region's standing public-SSH NSG (gateways/azure.ts). */
const SHARED_VM_NSG = 'anycloud-shared-vm';

describe('Azure sad path integration', () => {
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
    await requireAzureAuthentication({
      tenantId: process.env.AZURE_TENANT_ID,
      clientId: process.env.AZURE_CLIENT_ID,
      clientSecret: process.env.AZURE_CLIENT_SECRET,
    });
  });
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

  it('should clean up resources when VM creation fails due to invalid VM type', async () => {
    const timestamp = Date.now();
    const vmId = `cleanup-test-${timestamp}`;
    const workloadId = `fw-${vmId}`;

    // Create Azure instance with INVALID VM type to force failure. Every step
    // reuses this one instance: each fresh one reads the storage account
    // again, which the Storage resource provider throttles per subscription
    // in five-minute windows.
    const invalidConfig: CloudConfig = {
      ...testConfig,
      vmType: 'INVALID_VM_TYPE_DOES_NOT_EXIST',
    };
    const azure = new Azure(completeCloudConfig(invalidConfig));

    // Create vnet first (required - newVM expects vnet to exist)
    await azure.compute().upsertFirewall([], workloadId, '0.0.0-test', '');

    // The Job's own VNet carries its tags; public SSH alone is the region's
    // shared NSG, owned by no workload, so this Job makes none of its own.
    await azure.initializeAzure();
    const resourceGroup = azure.resourceGroup;

    const vnet = await azure.networkClient.virtualNetworks.get(
      resourceGroup,
      workloadId,
    );
    expect(vnet.tags?.anycloud_deployment).toBe(workloadId);
    expect(vnet.tags?.anycloud_version).toBe('0.0.0-test');

    const sharedNsg = await azure.networkClient.networkSecurityGroups.get(
      resourceGroup,
      SHARED_VM_NSG,
    );
    expect(sharedNsg.tags).toMatchObject({ anycloud_managed: 'shared' });
    await expect(
      azure.networkClient.networkSecurityGroups.get(resourceGroup, workloadId),
    ).rejects.toSatisfy(isAzureNotFound);

    // Attempt VM creation - should fail due to invalid VM type
    try {
      await azure.compute().newVM({
        startupScript: '#!/bin/bash\necho test',
        ipWhitelist: [],
        vmId,
        workloadId,
        version: '0.0.0-test',
        userId: '',
      });
      expect.fail('VM creation should have failed with invalid VM type');
    } catch (error) {
      // Verify it's an invalid SKU/VM type error, not some other error
      const errorStr = errorText(error);
      console.log('Azure error string:', errorStr);
      // Azure can abort the in-flight NIC create after the invalid VM-size
      // request poisons the provisioning operation, surfacing ResourceNotFound
      // for the same vmId instead of the original SKU validation text.
      const isAbortedNicCreate =
        errorStr.includes(`Microsoft.Network/networkInterfaces/${vmId}`) &&
        errorStr.includes('was not found');
      const isExpectedError =
        errorStr.includes('InvalidParameter') ||
        errorStr.includes('InvalidTemplateWorkload') ||
        errorStr.includes('SkuNotAvailable') ||
        errorStr.includes('INVALID_VM_TYPE') ||
        errorStr.includes('Operation was canceled') ||
        isAbortedNicCreate;
      if (!isExpectedError) {
        console.error(
          'Unexpected Azure error (not matching known patterns):',
          errorStr,
        );
      }
      expect(isExpectedError).toBe(true);

      // Check if partial resources were created before cleanup.
      // Azure may have already cleaned up the NIC/IP on its own after the
      // failed VM creation, so 404 is acceptable here.
      try {
        const nicBeforeCleanup =
          await azure.networkClient.networkInterfaces.get(resourceGroup, vmId);
        expect(nicBeforeCleanup.name).toBe(vmId);
      } catch (nicError) {
        if (!isAzureNotFound(nicError)) throw nicError;
      }

      try {
        const ipBeforeCleanup = await azure.networkClient.publicIPAddresses.get(
          resourceGroup,
          vmId,
        );
        expect(ipBeforeCleanup.name).toBe(vmId);
      } catch (ipError) {
        if (!isAzureNotFound(ipError)) throw ipError;
      }

      // Simulate vm-provisioner rollback: call terminateVMs + terminateNetworking to cleanup partial resources
      await azure.compute().terminateVMs([vmId]);
      await azure.compute().terminateNetworking(workloadId);
    }

    // Verify all resources (VM, NIC, Public IP) were deleted
    await ensureVMTerminated(azure, vmId);
    // Teardown leaves the shared NSG for every other Job in the region.
    await expect(
      azure.networkClient.networkSecurityGroups.get(
        resourceGroup,
        SHARED_VM_NSG,
      ),
    ).resolves.toMatchObject({ name: SHARED_VM_NSG });
  }, 600000); // 10 minute timeout (allows for NIC reservation retries and cleanup)
});
