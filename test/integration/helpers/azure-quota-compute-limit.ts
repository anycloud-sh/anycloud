#!/usr/bin/env npx tsx
/**
 * Find the provider-native compute quota limit for a canonical Azure family
 * key, checking the Compute Usage API first and falling back to the Compute
 * Quota API. Used by the credentialed Azure quota E2E to compare AnyCloud's
 * resolved value against Azure's provider-native data without a second,
 * hand-maintained matcher.
 *
 * Usage:
 *   npx tsx test/integration/helpers/azure-quota-compute-limit.ts \
 *     --resource-key azure:standardncasv3_t4family \
 *     --compute-usage-file /tmp/azure-compute-usages-eastus.json \
 *     --compute-quota-file /tmp/azure-compute-quotas-eastus.json
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import {
  canonicalAzureQuotaResourceKey,
  createAzureQuotaIdentity,
} from '../../../src/shared/quota-resolvers/azure-identity.js';

interface Args {
  resourceKey: string;
  computeUsageFile: string;
  computeQuotaFile: string;
}

interface RawComputeUsageRow {
  name?: { value?: string } | string;
  limit?: number;
}

interface RawComputeQuotaRow {
  properties?: { name?: { value?: string }; limit?: { value?: number } };
  name?: string;
}

function parseArgs(args = process.argv.slice(2)): Args {
  let resourceKey = '';
  let computeUsageFile = '';
  let computeQuotaFile = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--resource-key' && args[i + 1]) {
      resourceKey = args[++i];
    } else if (args[i] === '--compute-usage-file' && args[i + 1]) {
      computeUsageFile = args[++i];
    } else if (args[i] === '--compute-quota-file' && args[i + 1]) {
      computeQuotaFile = args[++i];
    }
  }
  if (!resourceKey || !computeUsageFile || !computeQuotaFile) {
    throw new Error(
      'Usage: azure-quota-compute-limit.ts --resource-key <azure:...> ' +
        '--compute-usage-file <path> --compute-quota-file <path>',
    );
  }
  return { resourceKey, computeUsageFile, computeQuotaFile };
}

/**
 * Compute Usage wins even when its limit is 0 — the regression this whole
 * matcher exists to keep pinned. A matched row without a numeric limit is
 * skipped in favor of the next matching row (or the Quota API fallback),
 * never treated as a match with an empty limit.
 */
export function findAzureComputeProviderLimit(
  resourceKey: string,
  usageRows: readonly RawComputeUsageRow[],
  quotaRows: readonly RawComputeQuotaRow[],
): number | undefined {
  const target = canonicalAzureQuotaResourceKey(resourceKey);
  if (!target) return undefined;

  for (const row of usageRows) {
    const name = typeof row.name === 'string' ? row.name : row.name?.value;
    if (!name || createAzureQuotaIdentity(name).resourceKey !== target) {
      continue;
    }
    if (typeof row.limit === 'number') return row.limit;
  }

  for (const row of quotaRows) {
    const name = row.properties?.name?.value ?? row.name;
    if (!name || createAzureQuotaIdentity(name).resourceKey !== target) {
      continue;
    }
    const limit = row.properties?.limit?.value;
    if (typeof limit === 'number') return limit;
  }

  return undefined;
}

export function main(): void {
  const { resourceKey, computeUsageFile, computeQuotaFile } = parseArgs();
  const usageRows: RawComputeUsageRow[] = JSON.parse(
    readFileSync(computeUsageFile, 'utf-8'),
  );
  const quotaRows: RawComputeQuotaRow[] = JSON.parse(
    readFileSync(computeQuotaFile, 'utf-8'),
  );
  const limit = findAzureComputeProviderLimit(
    resourceKey,
    usageRows,
    quotaRows,
  );
  if (typeof limit === 'number') {
    console.log(String(limit));
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
