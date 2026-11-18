#!/usr/bin/env node
/**
 * Cleanup orphaned GCP resources
 *
 * This script is called by CI before and after GCP integration test suites
 * to clean up any orphaned resources from previous failed test runs.
 *
 * Usage: CIPHER_KEY=$(openssl rand -hex 32) npx tsx ci/cleanup/gcp.ts
 */

import { InstancesClient } from '@google-cloud/compute';
import { completeCloudConfig } from '../../src/shared/cloud-config.js';
import { GCP } from '../../src/api/services/gateways/gcp';
import { CloudConfig, CloudType } from '../../src/shared/cloud.js';
import { sweepOnboardingSmokeBuckets } from './gcp-onboarding-buckets';
import { CI_RESOURCE_SWEEP_POLICY } from './policy';
import { runCloudCleanup } from './runner';

async function main() {
  const issues = [];

  if (process.env.GCP_PROJECT_ID === undefined) {
    issues.push('GCP_PROJECT_ID is missing (undefined)');
  } else if (process.env.GCP_PROJECT_ID.length === 0) {
    issues.push('GCP_PROJECT_ID is empty');
  }

  if (process.env.GCP_PRIVATE_KEY === undefined) {
    issues.push('GCP_PRIVATE_KEY is missing (undefined)');
  } else if (process.env.GCP_PRIVATE_KEY.length === 0) {
    issues.push('GCP_PRIVATE_KEY is empty');
  } else if (process.env.GCP_PRIVATE_KEY.length < 100) {
    issues.push(
      `GCP_PRIVATE_KEY is too short (${process.env.GCP_PRIVATE_KEY.length} chars, expected >1500)`,
    );
  }

  if (process.env.GCP_CLIENT_EMAIL === undefined) {
    issues.push('GCP_CLIENT_EMAIL is missing (undefined)');
  } else if (process.env.GCP_CLIENT_EMAIL.length === 0) {
    issues.push('GCP_CLIENT_EMAIL is empty');
  }

  if (issues.length > 0) {
    console.error('GCP credentials validation failed:');
    issues.forEach((issue) => console.error(`  - ${issue}`));
    console.error(
      '\nPlease check GitHub Secrets configuration or local .env.gcp file',
    );
    process.exit(1);
  }

  const credentials = {
    projectId: process.env.GCP_PROJECT_ID!,
    privateKey: process.env.GCP_PRIVATE_KEY!,
    clientEmail: process.env.GCP_CLIENT_EMAIL!,
  };

  // Discover all zones with anycloud instances using aggregatedList (one API call)
  console.log('Discovering zones with anycloud resources...');
  const instancesClient = new InstancesClient({
    projectId: credentials.projectId,
    credentials: {
      private_key: credentials.privateKey,
      client_email: credentials.clientEmail,
    },
  });

  const zones = new Set<string>();
  for await (const [
    _zonePath,
    instanceList,
  ] of instancesClient.aggregatedListAsync({
    project: credentials.projectId,
  })) {
    if (!instanceList.instances) continue;
    for (const instance of instanceList.instances) {
      if (instance.labels?.anycloud_deployment && instance.zone) {
        const zone = instance.zone.split('/').pop()!;
        zones.add(zone);
      }
    }
  }

  if (zones.size === 0) {
    console.log(
      'No anycloud instances found, checking for orphaned firewalls...',
    );
    // Still need to run cleanup in at least one zone to catch orphaned firewalls
    // (firewalls are project-wide, not zone-scoped)
    zones.add('us-central1-a');
  }

  console.log(
    `Found anycloud resources in ${zones.size} zone(s): ${[...zones].join(', ')}`,
  );

  await runCloudCleanup({
    cloud: 'GCP',
    units: [...zones],
    unitLabel: 'zone',
    cleanupUnit: (fullZone) => {
      // Extract region and zone suffix from full zone
      // (e.g. "us-central1-a" → region="us-central1", zone="a")
      const parts = fullZone.split('-');
      const zoneSuffix = parts.pop()!;
      const region = parts.join('-');

      const testConfig: CloudConfig = {
        cloudProvider: CloudType.GCP,
        credentials,
        region,
        availabilityZone: zoneSuffix,
        vmType: 'e2-micro',
      };
      return new GCP(completeCloudConfig(testConfig))
        .sweeper()
        .sweepResources({ policy: CI_RESOURCE_SWEEP_POLICY });
    },
    // Onboarding smoke buckets a failed key import left behind; buckets are
    // project-global, so once per run.
    accountWide: {
      label: 'bucket',
      run: () => sweepOnboardingSmokeBuckets(credentials),
    },
  });
}

main().catch((error) => {
  console.error('Cleanup failed:', error);
  process.exit(1);
});
