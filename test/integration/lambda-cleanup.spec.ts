/**
 * Lambda Cleanup Integration Test
 *
 * Tests the account resource sweep for Lambda.
 * Lambda uses instance names (ac|userId|timestamp) as pseudo-tags
 * since the API has no tagging support.
 *
 * NOTE: This test is for local development/verification only.
 * NOT included in CI - CI uses ci/cleanup/lambda.ts in pre/post cleanup jobs instead.
 *
 * Requirements:
 * - Lambda Labs API key in environment:
 *   - LAMBDA_API_KEY
 *
 * Run with:
 *   source .env && yarn test test/integration/lambda-cleanup.spec.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { completeCloudConfig } from '../../src/shared/cloud-config.js';
import { TEST_RESOURCE_SWEEP_OPTIONS } from '../helpers/resource-sweep-policy';
import { Lambda } from '../../src/api/services/gateways/lambda';
import { CloudConfig, CloudType } from '../../src/shared/cloud.js';
import { ensureVMTerminated } from './lambda-test-utils';

describe('Lambda resource sweep integration', () => {
  const region = 'us-east-1';
  const availabilityZone = undefined;
  const testConfig: CloudConfig = {
    cloudProvider: CloudType.Lambda,
    credentials: {
      apiKey: process.env.LAMBDA_API_KEY!,
    },
    region,
    availabilityZone,
    vmType: 'cpu_4x_general',
  };

  beforeAll(async () => {
    if (!process.env.LAMBDA_API_KEY) {
      throw new Error(
        'Lambda credentials not found in environment. Please set LAMBDA_API_KEY',
      );
    }

    // Cleanup orphaned resources before tests
    console.log('Running pre-test cleanup...');
    const lambda = new Lambda(completeCloudConfig(testConfig));
    const result = await lambda
      .sweeper()
      .sweepResources(TEST_RESOURCE_SWEEP_OPTIONS);
    console.log(`Pre-test cleanup: removed ${result.vmIds.length} VMs`);
  }, 300000);

  afterAll(async () => {
    // Cleanup orphaned resources after tests
    console.log('Running post-test cleanup...');
    const lambda = new Lambda(completeCloudConfig(testConfig));
    const result = await lambda
      .sweeper()
      .sweepResources(TEST_RESOURCE_SWEEP_OPTIONS);
    console.log(`Post-test cleanup: removed ${result.vmIds.length} VMs`);
  }, 300000);

  it('should not delete active resources (with userId)', async () => {
    const timestamp = Date.now();
    const vmId = `cleanup-active-${timestamp}`;
    const workloadId = `cleanup-active-${timestamp}`;

    const lambda = new Lambda(completeCloudConfig(testConfig));

    // Create instance with a real userId — cleanup should skip it
    const vm = await lambda.compute().newVM({
      startupScript: '#!/bin/bash\necho "active resource"',
      ipWhitelist: [],
      vmId,
      workloadId,
      version: '0.0.0-test',
      userId: 'real-user',
    });

    // Run cleanup
    const result = await lambda
      .sweeper()
      .sweepResources(TEST_RESOURCE_SWEEP_OPTIONS);

    // Should NOT include our VM (has userId and is young)
    expect(result.vmIds).not.toContain(vm.cloudId);

    // Verify VM still exists
    const allVMs = await lambda.compute().getAllVMs();
    expect(allVMs.some((v) => v.cloudId === vm.cloudId)).toBe(true);

    // Cleanup after test — and assert the gateway confirmed it, not just that
    // the instance eventually disappeared. terminateVMs omits any vmId whose
    // confirmation poll times out, leaving the row live and the workload
    // billing; ensureVMTerminated polls independently for two minutes, so on
    // its own it passes straight through that failure.
    const deleted = await lambda.compute().terminateVMs([vm.cloudId]);
    expect(deleted).toContain(vm.cloudId);
    await ensureVMTerminated(lambda, vm.cloudId);
  }, 600000);

  it('should support dry run', async () => {
    const lambda = new Lambda(completeCloudConfig(testConfig));

    // Dry run should not terminate anything
    const result = await lambda.sweeper().sweepResources({
      ...TEST_RESOURCE_SWEEP_OPTIONS,
      dryRun: true,
    });

    // Even if orphans are found, they should NOT be terminated
    // We can't easily verify this without creating a > 3hr old instance,
    // but we can verify the method returns without error
    expect(result.errors).toHaveLength(0);
  }, 60000);
});
