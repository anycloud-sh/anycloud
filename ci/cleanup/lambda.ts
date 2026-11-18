#!/usr/bin/env node
/**
 * Cleanup orphaned Lambda resources
 *
 * This script is called by CI before and after Lambda integration test suites
 * to clean up any orphaned resources from previous failed test runs.
 *
 * Single fixed endpoint with a bounded per-request timeout, so it does not use
 * the shared region fan-out runner.
 *
 * Usage: npx tsx ci/cleanup/lambda.ts
 */

import { Lambda } from '../../src/api/services/gateways/lambda';
import { completeCloudConfig } from '../../src/shared/cloud-config.js';
import { CloudConfig, CloudType } from '../../src/shared/cloud.js';
import { CI_RESOURCE_SWEEP_POLICY } from './policy';

async function main() {
  if (!process.env.LAMBDA_API_KEY) {
    console.error(
      'Lambda credentials not found in environment. Please set LAMBDA_API_KEY',
    );
    process.exit(1);
  }

  const testConfig: CloudConfig = {
    cloudProvider: CloudType.Lambda,
    credentials: {
      apiKey: process.env.LAMBDA_API_KEY,
    },
    region: process.env.LAMBDA_REGION || 'us-east-2',
    vmType: 'cpu_4x_general',
  };

  console.log('Running Lambda cleanup...');
  const lambda = new Lambda(completeCloudConfig(testConfig));
  const result = await lambda
    .sweeper()
    .sweepResources({ policy: CI_RESOURCE_SWEEP_POLICY });
  console.log(`Cleanup complete: removed ${result.vmIds.length} VMs`);

  if (result.errors.length > 0) {
    console.log(
      `Warning: ${result.errors.length} errors occurred during cleanup:`,
    );
    result.errors.forEach((err) => {
      console.log(`  - ${err.resourceType} ${err.resourceId}: ${err.error}`);
    });
  }

  process.exit(0);
}

main().catch((error) => {
  console.error('Cleanup failed:', error);
  process.exit(1);
});
