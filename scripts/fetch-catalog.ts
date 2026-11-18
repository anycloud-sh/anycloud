#!/usr/bin/env npx tsx
/**
 * Fetch cloud VM catalog and write to CSV.
 *
 * Usage:
 *   npx tsx scripts/fetch-catalog.ts --cloud azure --output /tmp/azure-vms.csv
 *   npx tsx scripts/fetch-catalog.ts --cloud gcp   --output /tmp/gcp-vms.csv
 *
 * Environment variables (for Azure):
 *   AZURE_SUBSCRIPTION_ID, AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
 * Environment variables (for GCP):
 *   GCP_PROJECT_ID, GCP_CLIENT_EMAIL, GCP_PRIVATE_KEY
 * AWS uses the SDK credential chain and requires ec2:DescribeRegions and
 * ec2:DescribeInstanceTypes to enrich the upstream hardware/pricing CSV.
 */

import { writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { pathToFileURL } from 'url';
import {
  AzureCatalogFetcher,
  type UsageFamilyObservation,
} from '../src/shared/catalog/azure.js';
import { GcpCatalogFetcher } from '../src/shared/catalog/gcp.js';
import { LambdaCatalogFetcher } from '../src/shared/catalog/lambda.js';
import { fetchAwsCatalog } from './catalog-aws.js';
import {
  entriesToCSV,
  type CloudCatalogFetcher,
} from '../src/shared/catalog/fetcher.js';
import {
  canonicalAzureQuotaResourceKey,
  createAzureQuotaIdentity,
} from '../src/shared/quota-resolvers/azure-identity.js';

export interface LegacyUsageFamilyEntry {
  raw: string;
  regions: string;
}

export interface UsageFamiliesV2 {
  version: 2;
  families: Record<string, UsageFamilyObservation>;
}

export function buildAzureUsageFamilyArtifacts(
  observations: Readonly<Record<string, UsageFamilyObservation>>,
): {
  legacy: Record<string, LegacyUsageFamilyEntry>;
  v2: UsageFamiliesV2;
} {
  const legacyEntries: Array<[string, LegacyUsageFamilyEntry]> = [];
  const v2Entries: Array<[string, UsageFamilyObservation]> = [];

  for (const [rawKey, observation] of Object.entries(observations).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const key = canonicalAzureQuotaResourceKey(rawKey);
    if (key === null || key !== rawKey) {
      throw new Error(`Invalid canonical Azure usage-family key: ${rawKey}`);
    }
    const rawNames = [...new Set(observation.rawNames)].sort();
    if (
      rawNames.length === 0 ||
      rawNames.some(
        (rawName) => createAzureQuotaIdentity(rawName).resourceKey !== key,
      )
    ) {
      throw new Error(`Azure usage-family raw names do not match ${key}`);
    }

    const regions = observation.regions;
    legacyEntries.push([
      key.slice('azure:'.length),
      { raw: rawNames[0], regions },
    ]);
    v2Entries.push([key, { rawNames, regions }]);
  }

  return {
    legacy: Object.fromEntries(legacyEntries),
    v2: { version: 2, families: Object.fromEntries(v2Entries) },
  };
}

function parseArgs(): { cloud: string; output: string } {
  const args = process.argv.slice(2);
  let cloud = '';
  let output = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cloud' && args[i + 1]) {
      cloud = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      output = args[++i];
    }
  }

  if (!cloud || !output) {
    console.error(
      'Usage: fetch-catalog.ts --cloud <aws|azure|gcp|lambda> --output <path>',
    );
    process.exit(1);
  }

  return { cloud, output };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function buildFetcher(cloud: string): CloudCatalogFetcher {
  switch (cloud) {
    case 'azure':
      return new AzureCatalogFetcher({
        subscriptionId: requireEnv('AZURE_SUBSCRIPTION_ID'),
        tenantId: requireEnv('AZURE_TENANT_ID'),
        clientId: requireEnv('AZURE_CLIENT_ID'),
        clientSecret: requireEnv('AZURE_CLIENT_SECRET'),
      });
    case 'gcp':
      return new GcpCatalogFetcher({
        projectId: requireEnv('GCP_PROJECT_ID'),
        clientEmail: requireEnv('GCP_CLIENT_EMAIL'),
        privateKey: requireEnv('GCP_PRIVATE_KEY'),
      });
    case 'lambda':
      return new LambdaCatalogFetcher({ apiKey: requireEnv('LAMBDA_API_KEY') });
    default:
      console.error(
        `Unsupported cloud: ${cloud}. Supported: azure, gcp, lambda.`,
      );
      process.exit(1);
  }
}

async function main({ cloud, output }: { cloud: string; output: string }) {
  if (cloud === 'aws') {
    // Write only after enrichment completes; failed metadata requests never publish partial data.
    writeFileSync(output, await fetchAwsCatalog(), 'utf-8');
    console.log(`Wrote enriched AWS catalog to ${output}`);
    return;
  }
  const fetcher = buildFetcher(cloud);

  console.log(`Fetching ${cloud} catalog...`);
  const entries = await fetcher.fetchAll();
  console.log(`Fetched ${entries.length} entries`);

  const csv = entriesToCSV(entries);
  writeFileSync(output, csv, 'utf-8');
  console.log(`Wrote catalog to ${output}`);

  // Azure-only: a second, independent artifact confirming what Azure's live
  // Usage API — the endpoint quota checks actually compare against — calls
  // each family the catalog resolved via the (separate) Resource SKUs API.
  // See AzureCatalogFetcher.fetchUsageFamilies for why this can't be derived
  // from the vms.csv data above.
  if (fetcher instanceof AzureCatalogFetcher) {
    const neededFamilyKeys = new Set(
      entries
        .map((entry) => entry.quotaGroup)
        .filter((group): group is string => !!group)
        .map((group) => createAzureQuotaIdentity(group).resourceKey),
    );
    const regions = new Set(entries.map((e) => e.region));
    console.log(
      `Fetching usage families for ${regions.size} regions (${neededFamilyKeys.size} needed keys)...`,
    );
    const usageFamilies = await fetcher.fetchUsageFamilies(
      neededFamilyKeys,
      regions,
    );
    const artifacts = buildAzureUsageFamilyArtifacts(usageFamilies);
    const outputDir = dirname(output);
    const usageFamiliesPath = join(outputDir, 'usage-families.json');
    writeFileSync(
      usageFamiliesPath,
      JSON.stringify(artifacts.legacy, null, 2) + '\n',
      'utf-8',
    );
    const usageFamiliesV2Path = join(outputDir, 'usage-families-v2.json');
    writeFileSync(
      usageFamiliesV2Path,
      JSON.stringify(artifacts.v2, null, 2) + '\n',
      'utf-8',
    );
    console.log(
      `Wrote usage families to ${usageFamiliesPath} and ${usageFamiliesV2Path}`,
    );
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  // Fetchers run in parallel in CI, so name the cloud on the failing line.
  const args = parseArgs();
  main(args).catch((err) => {
    console.error(`Fatal error fetching the ${args.cloud} catalog:`, err);
    process.exitCode = 1;
  });
}
