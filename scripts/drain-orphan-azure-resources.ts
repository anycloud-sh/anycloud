#!/usr/bin/env node
/**
 * Operator script: drain orphan Azure compute/network resources in
 * `anycloud-*` resource groups that production cleanup left behind. Targets:
 *  - Network Interfaces, Public IPs, NSGs, Virtual Networks
 *
 * Considers a resource an orphan candidate when ANY of:
 *  - tags.anycloud_user == 'anycloud-test' (test fixture)
 *  - tags.anycloud_ended_at is set (cleanup tagged it but never deleted)
 *  - resource has no tags at all (older-schema artifact, predates current
 *    tagging scheme)
 *
 * Customer-owned resources (any other tags.anycloud_user) are never
 * targeted. For VNets we additionally check that no IP configurations are
 * attached before deleting — that protects against deleting any still-in-use
 * legacy resources.
 *
 * Safety: dry-run by default. Deletion requires `--delete`, an exact resource
 * group, a resource-name prefix, and interactive confirmation. Uses
 * DefaultAzureCredential so it falls back to an active `az login` session if
 * env-based SP creds are rotated.
 *
 * Usage:
 *   export AZURE_SUBSCRIPTION_ID=...
 *   npx tsx scripts/drain-orphan-azure-resources.ts             # dry-run
 *   npx tsx scripts/drain-orphan-azure-resources.ts \
 *     --delete --resource-group anycloud-example --name-prefix owned-prefix
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DefaultAzureCredential } from '@azure/identity';
import { NetworkManagementClient } from '@azure/arm-network';
import { ResourceManagementClient } from '@azure/arm-resources';

export interface AzureDrainArgs {
  delete: boolean;
  resourceGroup?: string;
  namePrefix?: string;
}

function requiredFlagValue(
  argv: string[],
  index: number,
  flag: string,
): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a non-empty value.`);
  }
  return value;
}

export function parseAzureDrainArgs(argv: string[]): AzureDrainArgs {
  const args: AzureDrainArgs = { delete: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--delete') {
      args.delete = true;
    } else if (argument === '--resource-group') {
      args.resourceGroup = requiredFlagValue(argv, index, argument);
      index++;
    } else if (argument === '--name-prefix') {
      args.namePrefix = requiredFlagValue(argv, index, argument);
      index++;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return args;
}

export function assertAzureDeletionScope(args: AzureDrainArgs): void {
  if (!args.delete) return;
  if (!args.resourceGroup || !args.namePrefix) {
    throw new Error(
      '--delete requires both --resource-group <exact-name> and --name-prefix <prefix>.',
    );
  }
}

async function promptYes(question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/N] `);
  return new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (data) => {
      resolve(String(data).trim().toLowerCase() === 'y');
    });
  });
}

interface Tags {
  [key: string]: string | undefined;
}

function isOrphanCandidate(tags: Tags | undefined): boolean {
  if (!tags || Object.keys(tags).length === 0) return true;
  if (tags.anycloud_user === 'anycloud-test') return true;
  if (tags.anycloud_ended_at) return true;
  return false;
}

async function main() {
  const args = parseAzureDrainArgs(process.argv.slice(2));
  assertAzureDeletionScope(args);
  if (!process.env.AZURE_SUBSCRIPTION_ID) {
    console.error('Set AZURE_SUBSCRIPTION_ID.');
    process.exit(1);
  }
  const cred = new DefaultAzureCredential();
  const subId = process.env.AZURE_SUBSCRIPTION_ID;
  const networkClient = new NetworkManagementClient(cred, subId);
  const resourceClient = new ResourceManagementClient(cred, subId);

  console.log(`Mode: ${args.delete ? 'DELETE' : 'DRY-RUN'}\n`);

  // Enumerate anycloud-* resource groups (exclude storage)
  const rgs: string[] = [];
  for await (const rg of resourceClient.resourceGroups.list()) {
    if (
      rg.name?.startsWith('anycloud-') &&
      !rg.name.startsWith('anycloud-storage') &&
      (!args.resourceGroup || rg.name === args.resourceGroup)
    ) {
      rgs.push(rg.name);
    }
  }
  console.log(
    `Scanning ${rgs.length} ${args.resourceGroup ? `exact resource group (${args.resourceGroup})` : 'anycloud-* resource groups'}\n`,
  );

  type Target = { rg: string; name: string; kind: string };
  const targets: Target[] = [];

  // VNets — check no IP configs before flagging
  for (const rg of rgs) {
    for await (const vnet of networkClient.virtualNetworks.list(rg)) {
      if (
        !vnet.name ||
        (args.namePrefix && !vnet.name.startsWith(args.namePrefix))
      ) {
        continue;
      }
      if (!isOrphanCandidate(vnet.tags)) continue;
      const ipConfigs = (vnet.subnets ?? []).reduce(
        (n, s) => n + (s.ipConfigurations?.length ?? 0),
        0,
      );
      if (ipConfigs > 0) continue;
      targets.push({ rg, name: vnet.name, kind: 'vnet' });
    }
  }
  console.log(`VNets: ${targets.filter((t) => t.kind === 'vnet').length}`);

  // NSGs
  for (const rg of rgs) {
    for await (const nsg of networkClient.networkSecurityGroups.list(rg)) {
      if (
        !nsg.name ||
        (args.namePrefix && !nsg.name.startsWith(args.namePrefix))
      ) {
        continue;
      }
      if (!isOrphanCandidate(nsg.tags)) continue;
      targets.push({ rg, name: nsg.name, kind: 'nsg' });
    }
  }
  console.log(`NSGs: ${targets.filter((t) => t.kind === 'nsg').length}`);

  // NICs
  for (const rg of rgs) {
    for await (const nic of networkClient.networkInterfaces.list(rg)) {
      if (
        !nic.name ||
        (args.namePrefix && !nic.name.startsWith(args.namePrefix))
      ) {
        continue;
      }
      if (!isOrphanCandidate(nic.tags)) continue;
      targets.push({ rg, name: nic.name, kind: 'nic' });
    }
  }
  console.log(`NICs: ${targets.filter((t) => t.kind === 'nic').length}`);

  // Public IPs
  for (const rg of rgs) {
    for await (const pip of networkClient.publicIPAddresses.list(rg)) {
      if (
        !pip.name ||
        (args.namePrefix && !pip.name.startsWith(args.namePrefix))
      ) {
        continue;
      }
      if (!isOrphanCandidate(pip.tags)) continue;
      targets.push({ rg, name: pip.name, kind: 'publicIp' });
    }
  }
  console.log(
    `Public IPs: ${targets.filter((t) => t.kind === 'publicIp').length}`,
  );

  console.log(`\nTotal candidates: ${targets.length}`);
  if (!args.delete) {
    console.log('\nDry-run only — re-run with --delete to actually drain.');
    return;
  }
  if (targets.length === 0) {
    console.log('\nNothing to delete.');
    return;
  }

  const confirmed = await promptYes(
    `\nReally delete ${targets.length} Azure resource(s) in ${args.resourceGroup} whose names start with ${args.namePrefix}?`,
  );
  if (!confirmed) {
    console.log('Aborted.');
    return;
  }

  let deleted = 0;
  let failed = 0;
  // Delete in NIC → PublicIP → NSG → VNet order so dependencies clear.
  const order = ['nic', 'publicIp', 'nsg', 'vnet'];
  targets.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  for (const t of targets) {
    try {
      if (t.kind === 'vnet') {
        await networkClient.virtualNetworks.beginDeleteAndWait(t.rg, t.name);
      } else if (t.kind === 'nsg') {
        await networkClient.networkSecurityGroups.beginDeleteAndWait(
          t.rg,
          t.name,
        );
      } else if (t.kind === 'nic') {
        await networkClient.networkInterfaces.beginDeleteAndWait(t.rg, t.name);
      } else {
        await networkClient.publicIPAddresses.beginDeleteAndWait(t.rg, t.name);
      }
      console.log(`  deleted ${t.kind} ${t.rg}/${t.name}`);
      deleted++;
    } catch (error: any) {
      console.error(
        `  failed ${t.kind} ${t.rg}/${t.name}: ${error.code ?? error.message}`,
      );
      failed++;
    }
  }
  console.log(`\nDone: deleted=${deleted}, failed=${failed}`);
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  main().catch((error) => {
    console.error('drain-orphan-azure-resources failed:', error);
    process.exit(1);
  });
}
