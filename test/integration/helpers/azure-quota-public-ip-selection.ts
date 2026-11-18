#!/usr/bin/env npx tsx
/**
 * Select the Standard IPv4 public-IP quota row from Azure's raw Network Quota
 * API inventory, using the same resolver production uses. Used by the
 * credentialed Azure quota E2E to compare AnyCloud's resolved value against
 * Azure's provider-native data without a second, hand-maintained matcher.
 *
 * Usage:
 *   npx tsx test/integration/helpers/azure-quota-public-ip-selection.ts \
 *     --network-quota-file /tmp/azure-network-quotas-eastus.json
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import {
  AZURE_QUOTA_RESOURCE_KEYS,
  createAzureQuotaIdentity,
} from '../../../src/shared/quota-resolvers/azure-identity.js';
import {
  resolveAzurePublicIpQuota,
  type AzurePublicIpQuotaCandidate,
} from '../../../src/shared/quota-resolvers/azure-public-ip.js';

interface Args {
  networkQuotaFile: string;
}

interface RawNetworkQuota {
  properties?: {
    name?: { value?: string; localizedValue?: string };
    limit?: { value?: number };
    unit?: string;
  };
  name?: string;
}

interface PublicIpQuotaCandidate extends AzurePublicIpQuotaCandidate {
  limit: number | undefined;
  name: string;
}

export interface SelectedPublicIpQuota {
  key: string;
  limit: number;
  name: string;
  providerId: string;
}

function parseArgs(args = process.argv.slice(2)): Args {
  let networkQuotaFile = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--network-quota-file' && args[i + 1]) {
      networkQuotaFile = args[++i];
    }
  }
  if (!networkQuotaFile) {
    throw new Error(
      'Usage: azure-quota-public-ip-selection.ts --network-quota-file <path>',
    );
  }
  return { networkQuotaFile };
}

/**
 * Resolve every named provider row before inspecting the selected limit. This
 * prevents a malformed accepted row from being discarded before it can make
 * a second accepted or unknown public-IP row ambiguous.
 */
export function selectAzurePublicIpQuota(
  rows: readonly RawNetworkQuota[],
): SelectedPublicIpQuota | undefined {
  const candidates: PublicIpQuotaCandidate[] = [];
  const seenProviderRows = new Map<
    string,
    { limit: number | undefined; unit: string }
  >();
  for (const row of rows) {
    const providerId = row.properties?.name?.value ?? row.name ?? '';
    const limit = row.properties?.limit?.value;
    if (!providerId) continue;
    const unit = row.properties?.unit ?? 'Count';
    const existing = seenProviderRows.get(providerId);
    if (existing) {
      if (existing.limit !== limit || existing.unit !== unit) {
        throw new Error(
          `Azure quota limits returned conflicting duplicate rows for ${providerId}`,
        );
      }
      continue;
    }
    seenProviderRows.set(providerId, { limit, unit });
    candidates.push({
      ...createAzureQuotaIdentity(providerId),
      limit,
      name: row.properties?.name?.localizedValue ?? '',
    });
  }

  const resolution = resolveAzurePublicIpQuota(candidates);
  if (resolution.kind !== 'selected') {
    return undefined;
  }

  const { selected } = resolution;
  if (typeof selected.limit !== 'number') return undefined;

  return {
    key: AZURE_QUOTA_RESOURCE_KEYS.standardSkuPublicIpAddresses,
    limit: selected.limit,
    name: selected.name,
    providerId: selected.providerId,
  };
}

export function main(): void {
  const { networkQuotaFile } = parseArgs();
  const rows: RawNetworkQuota[] = JSON.parse(
    readFileSync(networkQuotaFile, 'utf-8'),
  );
  const result = selectAzurePublicIpQuota(rows);
  if (result) {
    console.log(
      [result.key, result.limit, result.name, result.providerId].join('\t'),
    );
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
