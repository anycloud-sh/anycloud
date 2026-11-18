/**
 * GCP Cleanup Integration Test
 *
 * Tests the account resource sweep for GCP.
 *
 * NOTE: This test is for local development/verification only.
 * NOT included in CI - CI uses ci/cleanup/gcp.ts in pre/post cleanup jobs instead.
 *
 * Requirements:
 * - GCP credentials in environment (from .env.gcp):
 *   - GCP_PROJECT_ID
 *   - GCP_PRIVATE_KEY
 *   - GCP_CLIENT_EMAIL
 *
 * Run with:
 *   source .env.gcp && yarn test test/integration/gcp-cleanup.spec.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { completeCloudConfig } from '../../src/shared/cloud-config.js';
import { TEST_RESOURCE_SWEEP_OPTIONS } from '../helpers/resource-sweep-policy';
import { GCP } from '../../src/api/services/gateways/gcp';
import {
  CloudConfig,
  CloudType,
  type GCPCreds,
} from '../../src/shared/cloud.js';
import { useTestCatalogs } from './helpers/test-catalogs.js';

useTestCatalogs();

describe('GCP resource sweep integration', () => {
  const region = 'us-central1';
  const availabilityZone = 'a';
  const credentials: GCPCreds = {
    projectId: process.env.GCP_PROJECT_ID!,
    privateKey: process.env.GCP_PRIVATE_KEY!,
    clientEmail: process.env.GCP_CLIENT_EMAIL!,
  };
  const testConfig: CloudConfig = {
    cloudProvider: CloudType.GCP,
    credentials,
    region,
    availabilityZone,
    vmType: 'e2-medium',
  };

  beforeAll(async () => {
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

    // Cleanup orphaned resources before tests
    console.log('Running pre-test cleanup...');
    const gcp = new GCP(completeCloudConfig(testConfig));
    const result = await gcp
      .sweeper()
      .sweepResources(TEST_RESOURCE_SWEEP_OPTIONS);
    console.log(
      `Pre-test cleanup: removed ${result.vmIds.length} VMs, ${result.otherResources.length} other resources`,
    );
  }, 300000); // 5 minute timeout for cleanup

  afterAll(async () => {
    // Cleanup orphaned resources after tests (runs even on failure/cancellation)
    console.log('Running post-test cleanup...');
    const gcp = new GCP(completeCloudConfig(testConfig));
    const result = await gcp
      .sweeper()
      .sweepResources(TEST_RESOURCE_SWEEP_OPTIONS);
    console.log(
      `Post-test cleanup: removed ${result.vmIds.length} VMs, ${result.otherResources.length} other resources`,
    );
  }, 300000); // 5 minute timeout for cleanup

  it('should cleanup resources with ended_at label', async () => {
    const timestamp = Date.now();
    const vmId = `cleanup-ended-${timestamp}`;
    const workloadId = `cleanup-fw-${timestamp}`;

    const gcp = new GCP(completeCloudConfig(testConfig));

    // Create firewall and VM
    await gcp
      .compute()
      .upsertFirewall([], workloadId, '0.0.0-test', 'anycloud-test');
    const _vm = await gcp.compute().newVM({
      startupScript: '#!/bin/bash\necho "cleanup test"',
      ipWhitelist: [],
      vmId,
      workloadId,
      version: '0.0.0-test',
      userId: 'anycloud-test',
    });

    // Manually add ended_at label to instance
    const [instance] = await gcp.instancesClient.get({
      project: credentials.projectId,
      zone: gcp['zone'], // Use the full zone (region-suffix)
      instance: vmId,
    });

    const labels = instance.labels || {};
    labels.anycloud_ended_at = Date.now().toString();

    const [setLabelsOp] = await gcp.instancesClient.setLabels({
      project: credentials.projectId,
      zone: gcp['zone'], // Use the full zone (region-suffix)
      instance: vmId,
      instancesSetLabelsRequestResource: {
        labels,
        labelFingerprint: instance.labelFingerprint,
      },
    });
    await gcp.waitForOperation(setLabelsOp);

    // Run cleanup
    const result = await gcp
      .sweeper()
      .sweepResources(TEST_RESOURCE_SWEEP_OPTIONS);

    expect(result.vmIds).toContain(vmId);
    // A public-SSH VM uses the shared rules, which no sweep takes.
    expect(
      result.otherResources.some(
        (r) => r.type === 'firewall' && r.id.startsWith('anycloud-shared-vm'),
      ),
    ).toBe(false);
    // Only check that our specific resources didn't error
    const ourVmError = result.errors.find((e) => e.resourceId === vmId);
    expect(ourVmError).toBeUndefined();

    // Verify VM was deleted
    const vms = await gcp.compute().getAllVMs();
    const foundVM = vms.find((v) => v.cloudId === vmId);
    expect(foundVM).toBeUndefined();
  }, 300000); // 5 min timeout

  it('should cleanup test resources (empty userId)', async () => {
    const timestamp = Date.now();
    const vmId = `cleanup-test-${timestamp}`;
    const workloadId = `cleanup-test-fw-${timestamp}`;

    const gcp = new GCP(completeCloudConfig(testConfig));

    // Create resources with userId=''
    await gcp.compute().upsertFirewall([], workloadId, '0.0.0-test', '');
    const _vm = await gcp.compute().newVM({
      startupScript: '#!/bin/bash\necho "test resource"',
      ipWhitelist: [],
      vmId,
      workloadId,
      version: '0.0.0-test',
      userId: '',
    });

    // Run cleanup
    const result = await gcp
      .sweeper()
      .sweepResources(TEST_RESOURCE_SWEEP_OPTIONS);

    expect(result.vmIds).toContain(vmId);
    // Only check that our specific resources didn't error
    const ourVmError = result.errors.find((e) => e.resourceId === vmId);
    expect(ourVmError).toBeUndefined();

    // Verify VM was deleted
    const vms = await gcp.compute().getAllVMs();
    const foundVM = vms.find((v) => v.cloudId === vmId);
    expect(foundVM).toBeUndefined();
  }, 300000);

  it('should not delete active resources', async () => {
    const timestamp = Date.now();
    const vmId = `cleanup-active-${timestamp}`;
    const workloadId = `cleanup-active-fw-${timestamp}`;

    const gcp = new GCP(completeCloudConfig(testConfig));

    // Create resources without ended_at label and with real userId
    await gcp
      .compute()
      .upsertFirewall([], workloadId, '0.0.0-test', 'real-user');
    const _vm = await gcp.compute().newVM({
      startupScript: '#!/bin/bash\necho "active resource"',
      ipWhitelist: [],
      vmId,
      workloadId,
      version: '0.0.0-test',
      userId: 'real-user',
    });

    // Run cleanup
    const result = await gcp
      .sweeper()
      .sweepResources(TEST_RESOURCE_SWEEP_OPTIONS);

    // Should not include our VM
    expect(result.vmIds).not.toContain(vmId);

    // Verify VM still exists
    const vms = await gcp.compute().getAllVMs();
    const foundVM = vms.find((v) => v.cloudId === vmId);
    expect(foundVM).toBeDefined();
    expect(foundVM?.cloudId).toBe(vmId);

    // Cleanup after test
    await gcp.compute().terminateVMs([vmId]);
    await gcp.compute().terminateNetworking(workloadId);
  }, 300000);

  it('should support dry run', async () => {
    const timestamp = Date.now();
    const vmId = `cleanup-dryrun-${timestamp}`;
    const workloadId = `cleanup-dryrun-fw-${timestamp}`;

    const gcp = new GCP(completeCloudConfig(testConfig));

    // Create resources
    await gcp
      .compute()
      .upsertFirewall([], workloadId, '0.0.0-test', 'anycloud-test');
    const _vm = await gcp.compute().newVM({
      startupScript: '#!/bin/bash\necho "dryrun test"',
      ipWhitelist: [],
      vmId,
      workloadId,
      version: '0.0.0-test',
      userId: 'anycloud-test',
    });

    // Tag with ended_at
    const [instance] = await gcp.instancesClient.get({
      project: credentials.projectId,
      zone: gcp['zone'], // Use the full zone (region-suffix)
      instance: vmId,
    });

    const labels = instance.labels || {};
    labels.anycloud_ended_at = Date.now().toString();

    const [setLabelsOp] = await gcp.instancesClient.setLabels({
      project: credentials.projectId,
      zone: gcp['zone'], // Use the full zone (region-suffix)
      instance: vmId,
      instancesSetLabelsRequestResource: {
        labels,
        labelFingerprint: instance.labelFingerprint,
      },
    });
    await gcp.waitForOperation(setLabelsOp);

    // Dry run
    const dryResult = await gcp.sweeper().sweepResources({
      ...TEST_RESOURCE_SWEEP_OPTIONS,
      dryRun: true,
    });
    expect(dryResult.vmIds).toContain(vmId);

    // Verify VM NOT deleted (still exists)
    let vms = await gcp.compute().getAllVMs();
    let foundVM = vms.find((v) => v.cloudId === vmId);
    expect(foundVM).toBeDefined();

    // Actual cleanup
    const result = await gcp
      .sweeper()
      .sweepResources(TEST_RESOURCE_SWEEP_OPTIONS);
    expect(result.vmIds).toContain(vmId);

    // Verify VM was deleted this time
    vms = await gcp.compute().getAllVMs();
    foundVM = vms.find((v) => v.cloudId === vmId);
    expect(foundVM).toBeUndefined();
  }, 300000);
});
