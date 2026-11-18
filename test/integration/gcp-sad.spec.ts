/**
 * GCP Sad Path Integration Test
 *
 * Tests error handling and cleanup when VM creation fails.
 *
 * Requirements:
 * - GCP credentials in environment (from .env.gcp):
 *   - GCP_PROJECT_ID
 *   - GCP_PRIVATE_KEY
 *   - GCP_CLIENT_EMAIL
 *
 * Run with:
 *   source .env.gcp && yarn test test/integration/gcp-sad.spec.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { completeCloudConfig } from '../../src/shared/cloud-config.js';
import { GCP } from '../../src/api/services/gateways/gcp';
import { getZonesForVMType } from '../../src/shared/cloud-config';
import { CloudConfig, CloudType } from '../../src/shared/cloud.js';
import { ensureVMTerminated } from './gcp-test-utils';
import { errorText } from './helpers/external-errors';
import { useTestCatalogs } from './helpers/test-catalogs.js';

useTestCatalogs();

describe('GCP sad path integration', () => {
  beforeAll(() => {
    // Fail hard if GCP credentials are not configured
    if (
      !process.env.GCP_PROJECT_ID ||
      !process.env.GCP_PRIVATE_KEY ||
      !process.env.GCP_CLIENT_EMAIL
    ) {
      throw new Error(
        'GCP credentials not found in environment. Please set GCP_PROJECT_ID, GCP_PRIVATE_KEY, and GCP_CLIENT_EMAIL',
      );
    }
  });

  const region = 'us-central1';
  const vmType = 'e2-medium';
  const availabilityZone = getZonesForVMType(region, vmType)[0];
  if (!availabilityZone) {
    throw new Error(
      `Published GCP catalog has no compatible ${region} zone for ${vmType}`,
    );
  }
  const testConfig: CloudConfig = {
    cloudProvider: CloudType.GCP,
    credentials: {
      projectId: process.env.GCP_PROJECT_ID!,
      privateKey: process.env.GCP_PRIVATE_KEY!,
      clientEmail: process.env.GCP_CLIENT_EMAIL!,
    },
    region,
    availabilityZone,
    vmType,
  };

  it('should handle VM creation failure and cleanup firewall', async () => {
    const timestamp = Date.now();
    const vmId = `sad-test-${timestamp}`;
    const workloadId = `fw-${vmId}`;

    // Keep the machine type and zone catalog-valid so constructor preflight
    // succeeds. A negative boot-disk size reaches instances.insert and makes
    // GCP reject VM creation after the firewall has been created.
    const badConfig: CloudConfig = {
      ...testConfig,
      diskSizeGb: -1,
    };

    const gcp = new GCP(completeCloudConfig(badConfig));
    let firewallCreated = false;

    try {
      await gcp.compute().upsertFirewall([], workloadId, '0.3.2', '');
      firewallCreated = true;

      let creationFailure: unknown;
      try {
        await gcp.compute().newVM({
          startupScript: '#!/bin/bash\necho "this should fail"',
          ipWhitelist: [],
          vmId,
          workloadId,
          version: '0.3.2',
          userId: '',
        });
      } catch (error) {
        creationFailure = error;
      }

      expect(creationFailure).toBeDefined();
      const failureText = errorText(creationFailure);
      expect(failureText).toMatch(/diskSizeGb|disk size/i);
      expect(failureText).toMatch(/invalid|greater than|positive/i);

      // Verify VM was not created.
      await ensureVMTerminated(gcp, vmId);
    } finally {
      if (firewallCreated) {
        // If GCP unexpectedly accepted the invalid request, avoid leaking the
        // VM while preserving the assertion failure from above.
        const vmExists = (await gcp.compute().getAllVMs()).some(
          (vm) => vm.cloudId === vmId,
        );
        if (vmExists) {
          await gcp.compute().terminateVMs([vmId]);
        }
        await gcp.compute().terminateNetworking(workloadId);
      }
    }

    // Verify every firewall created for this workload was removed.
    const remainingFirewalls: string[] = [];
    for await (const firewall of gcp.firewallsClient.listAsync({
      project: process.env.GCP_PROJECT_ID!,
    })) {
      if (firewall.targetTags?.includes(workloadId) && firewall.name) {
        remainingFirewalls.push(firewall.name);
      }
    }
    expect(remainingFirewalls).toEqual([]);
  }, 600000); // 10 minute timeout (allows for retry delays and cleanup)
});
