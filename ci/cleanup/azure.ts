#!/usr/bin/env node
/**
 * Cleanup orphaned Azure resources
 *
 * This script is called by CI before and after Azure integration test suites
 * to clean up any orphaned resources from previous failed test runs.
 *
 * Usage: CIPHER_KEY=$(openssl rand -hex 32) npx tsx ci/cleanup/azure.ts
 */

import { ResourceManagementClient } from '@azure/arm-resources';
import { completeCloudConfig } from '../../src/shared/cloud-config.js';
import { ClientSecretCredential } from '@azure/identity';
import { Azure } from '../../src/api/services/gateways/azure';
import { CloudConfig, CloudType } from '../../src/shared/cloud.js';
import { CI_RESOURCE_SWEEP_POLICY } from './policy';
import { runCloudCleanup } from './runner';

function errorText(error: unknown): string {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.name, error.message);
    if (error.stack) parts.push(error.stack);
  }
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    for (const key of ['code', 'errorCode']) {
      const value = record[key];
      if (value !== undefined && value !== null) parts.push(String(value));
    }
  }
  if (parts.length === 0) parts.push(String(error));
  return parts.join('\n');
}

function errorSummary(error: unknown): string {
  const text = errorText(error);
  return text.split('\n').find((line) => line.trim().length > 0) ?? text;
}

function isAzureInvalidClientError(error: unknown): boolean {
  return /invalid_client|AADSTS70002(?:15|22)/i.test(errorText(error));
}

async function main() {
  if (
    !process.env.AZURE_SUBSCRIPTION_ID ||
    !process.env.AZURE_TENANT_ID ||
    !process.env.AZURE_CLIENT_ID ||
    !process.env.AZURE_CLIENT_SECRET
  ) {
    console.error(
      'Azure credentials not found in environment. Please set AZURE_SUBSCRIPTION_ID, AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET',
    );
    process.exit(1);
  }

  const credentials = {
    subscriptionId: process.env.AZURE_SUBSCRIPTION_ID!,
    directoryId: process.env.AZURE_TENANT_ID!,
    applicationId: process.env.AZURE_CLIENT_ID!,
    secret: process.env.AZURE_CLIENT_SECRET!,
  };

  // Discover all anycloud-* resource groups (one API call)
  console.log('Discovering Azure resource groups...');
  const azCred = new ClientSecretCredential(
    credentials.directoryId,
    credentials.applicationId,
    credentials.secret,
  );
  const resourcesClient = new ResourceManagementClient(
    azCred,
    credentials.subscriptionId,
  );

  const regions: string[] = [];
  for await (const group of resourcesClient.resourceGroups.list()) {
    // Match anycloud-{region} but not anycloud-storage
    if (
      group.name?.startsWith('anycloud-') &&
      !group.name.startsWith('anycloud-storage')
    ) {
      regions.push(group.name.replace('anycloud-', ''));
    }
  }

  if (regions.length === 0) {
    console.log('No anycloud resource groups found');
    process.exit(0);
  }

  console.log(
    `Found ${regions.length} anycloud resource group(s): ${regions.join(', ')}`,
  );

  const mkConfig = (region: string): CloudConfig => ({
    cloudProvider: CloudType.Azure,
    credentials,
    region,
    vmType: 'Standard_B1s',
  });

  await runCloudCleanup({
    cloud: 'Azure',
    units: regions,
    cleanupUnit: async (region) => {
      const azure = new Azure(completeCloudConfig(mkConfig(region)));
      const result = await azure.sweeper().sweepResources({
        policy: CI_RESOURCE_SWEEP_POLICY,
      });
      return result;
    },
    // Azure containers all live in a single shared storage account in the
    // anycloud-storage RG — run their cleanup once, not per region. The region
    // here is just a placeholder needed by the config; sweepStorage
    // talks to the shared storage account, not the regional resource group.
    accountWide: {
      label: 'container',
      run: () =>
        new Azure(
          completeCloudConfig(mkConfig(regions[0] || 'eastus')),
        ).sweeper().sweepStorage!({
          policy: CI_RESOURCE_SWEEP_POLICY,
        }),
    },
  });
}

main().catch((error) => {
  if (isAzureInvalidClientError(error)) {
    console.warn(
      `Azure cleanup skipped: configured service principal is rejected by Azure (${errorSummary(error)})`,
    );
    process.exit(0);
  }

  console.error('Cleanup failed:', error);
  process.exit(1);
});
