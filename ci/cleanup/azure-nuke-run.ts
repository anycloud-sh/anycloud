#!/usr/bin/env node
/**
 * Delete Azure resources for one nuke test run.
 *
 * This is intentionally narrower than ci/cleanup/azure.ts: it only deletes
 * resources tagged with an anycloud_deployment value matching the supplied
 * nuke run prefix, and it does not weaken the normal orphan-age cleanup rules.
 *
 * Usage:
 *   npx tsx ci/cleanup/azure-nuke-run.ts nuke-123456-
 */

import { ComputeManagementClient } from '@azure/arm-compute';
import { NetworkManagementClient } from '@azure/arm-network';
import { ResourceManagementClient } from '@azure/arm-resources';
import { ClientSecretCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Azure } from '../../src/api/services/gateways/azure.js';
import { completeCloudConfig } from '../../src/shared/cloud-config.js';
import { CloudType } from '../../src/shared/cloud.js';

export type TagMap = Record<string, string | undefined> | undefined;
type NamedTaggedResource = {
  id?: string;
  name?: string;
  tags?: TagMap;
};

type AzureCredentialsEnv = {
  AZURE_SUBSCRIPTION_ID?: string;
  AZURE_TENANT_ID?: string;
  AZURE_CLIENT_ID?: string;
  AZURE_CLIENT_SECRET?: string;
  GITHUB_RUN_ATTEMPT?: string;
  GITHUB_RUN_ID?: string;
  TEST_RUN?: string;
};

function azureCredentialsEnv(env: NodeJS.ProcessEnv): AzureCredentialsEnv {
  return {
    AZURE_SUBSCRIPTION_ID: env.AZURE_SUBSCRIPTION_ID,
    AZURE_TENANT_ID: env.AZURE_TENANT_ID,
    AZURE_CLIENT_ID: env.AZURE_CLIENT_ID,
    AZURE_CLIENT_SECRET: env.AZURE_CLIENT_SECRET,
    GITHUB_RUN_ATTEMPT: env.GITHUB_RUN_ATTEMPT,
    GITHUB_RUN_ID: env.GITHUB_RUN_ID,
    TEST_RUN: env.TEST_RUN,
  };
}

type ResourceType =
  | 'vm'
  | 'nic'
  | 'publicIp'
  | 'nsg'
  | 'vnet'
  | 'disk'
  | 'container';

type CleanupError = {
  type: ResourceType | 'resourceGroup';
  id: string;
  error: string;
};

export type NukeRunCleanupSummary = {
  prefix: string;
  resourceGroups: string[];
  deleted: Record<ResourceType, number>;
  errors: CleanupError[];
};

const POLL_TIMEOUT_MS = 5 * 60 * 1000;

type WorkloadPrefixCleanupOptions = {
  requireAnycloudTestUser?: boolean;
  ownedApiIdentity?: string;
  region?: string;
  terminateVm?: (name: string) => Promise<void>;
  subscriptionId?: string;
  resourcePrefix?: string;
};

export function validateNukeCleanupPrefix(
  rawPrefix: string | undefined,
): string {
  const prefix = rawPrefix?.trim() ?? '';
  if (!/^nuke-[A-Za-z0-9][A-Za-z0-9._-]*-$/.test(prefix)) {
    throw new Error(
      `Expected a specific nuke run prefix like "nuke-123456-" (got "${rawPrefix ?? ''}")`,
    );
  }
  return prefix;
}

export function validateServeCleanupPrefix(
  rawPrefix: string | undefined,
): string {
  const prefix = rawPrefix?.trim() ?? '';
  if (!/^serve-[A-Za-z0-9][A-Za-z0-9._-]*-$/.test(prefix)) {
    throw new Error(
      `Expected a specific serve run prefix like "serve-123456-" (got "${rawPrefix ?? ''}")`,
    );
  }
  return prefix;
}

export function serveCleanupPrefixFromEnv(env: AzureCredentialsEnv): string {
  if (env.GITHUB_RUN_ID) {
    const runId = env.GITHUB_RUN_ID.slice(-9);
    const attempt = env.GITHUB_RUN_ATTEMPT || '1';
    return validateServeCleanupPrefix(`serve-${runId}${attempt}-`);
  }
  if (env.TEST_RUN) {
    return validateServeCleanupPrefix(`serve-${env.TEST_RUN}-`);
  }
  throw new Error(
    'Cannot derive serve cleanup prefix: set GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT or TEST_RUN',
  );
}

export function hasWorkloadPrefix(
  tags: TagMap,
  prefix: string,
  options: WorkloadPrefixCleanupOptions = {},
): boolean {
  if (options.ownedApiIdentity) {
    return (
      tags?.anycloud_owner_api === options.ownedApiIdentity &&
      typeof tags.anycloud_resource === 'string' &&
      tags.anycloud_resource.length > 0 &&
      !tags.anycloud_deployment
    );
  }
  if (
    typeof tags?.anycloud_deployment !== 'string' ||
    !tags.anycloud_deployment.startsWith(prefix)
  ) {
    return false;
  }
  if (
    options.requireAnycloudTestUser &&
    tags.anycloud_user !== 'anycloud-test'
  ) {
    return false;
  }
  return true;
}

export function hasNukeWorkloadPrefix(tags: TagMap, prefix: string): boolean {
  return hasWorkloadPrefix(tags, prefix);
}

export function hasServeWorkloadPrefix(tags: TagMap, prefix: string): boolean {
  return hasWorkloadPrefix(tags, prefix, { requireAnycloudTestUser: true });
}

export function isAnycloudRegionalResourceGroup(
  name: string | undefined,
): name is string {
  return !!name && name.startsWith('anycloud-') && name !== 'anycloud-storage';
}

export function storageAccountNameForSubscription(
  subscriptionId: string,
): string {
  const subPrefix = subscriptionId.replace(/-/g, '').substring(0, 8);
  return `anycloud${subPrefix}`.substring(0, 24);
}

function requireAzureCredentials(env: AzureCredentialsEnv) {
  const missing = [
    'AZURE_SUBSCRIPTION_ID',
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET',
  ].filter((key) => !env[key as keyof AzureCredentialsEnv]);
  if (missing.length > 0) {
    throw new Error(
      `Azure credentials missing from environment: ${missing.join(', ')}`,
    );
  }

  return {
    subscriptionId: env.AZURE_SUBSCRIPTION_ID!,
    tenantId: env.AZURE_TENANT_ID!,
    clientId: env.AZURE_CLIENT_ID!,
    clientSecret: env.AZURE_CLIENT_SECRET!,
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const parts = [record.code, record.statusCode, record.message]
      .filter((part) => part !== undefined && part !== null)
      .map(String);
    if (parts.length > 0) return parts.join(': ');
  }
  return String(error);
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  return (
    record.statusCode === 404 ||
    record.code === 'ResourceNotFound' ||
    record.code === 'NotFound'
  );
}

async function withPollTimeout<T>(
  promise: Promise<T>,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error(`${label} timed out after ${POLL_TIMEOUT_MS}ms`)),
          POLL_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function taggedResources<T extends NamedTaggedResource>(
  iterator: AsyncIterable<T>,
  prefix: string,
  options: WorkloadPrefixCleanupOptions = {},
): Promise<T[]> {
  const matches: T[] = [];
  for await (const resource of iterator) {
    if (hasWorkloadPrefix(resource.tags, prefix, options)) {
      if (
        options.ownedApiIdentity &&
        (!resource.name ||
          resource.name.includes('/') ||
          !options.resourcePrefix ||
          resource.id?.toLowerCase() !==
            `${options.resourcePrefix}/${resource.name}`.toLowerCase())
      )
        throw new Error(
          'Owned Azure resource has an invalid subscription, group, type, or name',
        );
      if (!resource.name) continue;
      matches.push(resource);
    }
  }
  return matches;
}

async function deleteAzureResource(
  summary: NukeRunCleanupSummary,
  type: ResourceType,
  id: string,
  startDelete: () => Promise<{ pollUntilDone: () => Promise<unknown> }>,
): Promise<void> {
  try {
    const poller = await startDelete();
    await withPollTimeout(poller.pollUntilDone(), `${type} ${id}`);
    summary.deleted[type] += 1;
    console.log(`Deleted Azure ${type}: ${id}`);
  } catch (error) {
    if (isNotFound(error)) {
      console.log(`Azure ${type} already gone: ${id}`);
      return;
    }
    const message = errorMessage(error);
    summary.errors.push({ type, id, error: message });
    console.warn(`Failed to delete Azure ${type} ${id}: ${message}`);
  }
}

async function cleanupResourceGroup(
  prefix: string,
  resourceGroup: string,
  computeClient: ComputeManagementClient,
  networkClient: NetworkManagementClient,
  summary: NukeRunCleanupSummary,
  options: WorkloadPrefixCleanupOptions = {},
): Promise<void> {
  console.log(`Scanning ${resourceGroup} for ${prefix}* resources`);
  const scopedOptions = (type: string): WorkloadPrefixCleanupOptions => ({
    ...options,
    resourcePrefix: `/subscriptions/${options.subscriptionId}/resourceGroups/${resourceGroup}/providers/${type}`,
  });

  try {
    const vms = await taggedResources(
      computeClient.virtualMachines.list(resourceGroup),
      prefix,
      scopedOptions('Microsoft.Compute/virtualMachines'),
    );
    const nics = await taggedResources(
      networkClient.networkInterfaces.list(resourceGroup),
      prefix,
      scopedOptions('Microsoft.Network/networkInterfaces'),
    );
    const publicIps = await taggedResources(
      networkClient.publicIPAddresses.list(resourceGroup),
      prefix,
      scopedOptions('Microsoft.Network/publicIPAddresses'),
    );
    const nsgs = await taggedResources(
      networkClient.networkSecurityGroups.list(resourceGroup),
      prefix,
      scopedOptions('Microsoft.Network/networkSecurityGroups'),
    );
    const vnets = await taggedResources(
      networkClient.virtualNetworks.list(resourceGroup),
      prefix,
      scopedOptions('Microsoft.Network/virtualNetworks'),
    );
    const disks = await taggedResources(
      computeClient.disks.listByResourceGroup(resourceGroup),
      prefix,
      scopedOptions('Microsoft.Compute/disks'),
    );

    for (const vm of vms) {
      if (options.terminateVm) {
        // The gateway persists the attached OS disk's exact owner before
        // deleting its VM, including when a later cleanup process must retry.
        await options.terminateVm(vm.name!);
        summary.deleted.vm += 1;
        continue;
      }
      await deleteAzureResource(summary, 'vm', vm.name!, () =>
        computeClient.virtualMachines.beginDelete(resourceGroup, vm.name!),
      );
    }

    for (const nic of nics) {
      await deleteAzureResource(summary, 'nic', nic.name!, () =>
        networkClient.networkInterfaces.beginDelete(resourceGroup, nic.name!),
      );
    }

    for (const publicIp of publicIps) {
      await deleteAzureResource(summary, 'publicIp', publicIp.name!, () =>
        networkClient.publicIPAddresses.beginDelete(
          resourceGroup,
          publicIp.name!,
        ),
      );
    }

    for (const nsg of nsgs) {
      await deleteAzureResource(summary, 'nsg', nsg.name!, () =>
        networkClient.networkSecurityGroups.beginDelete(
          resourceGroup,
          nsg.name!,
        ),
      );
    }

    for (const vnet of vnets) {
      await deleteAzureResource(summary, 'vnet', vnet.name!, () =>
        networkClient.virtualNetworks.beginDelete(resourceGroup, vnet.name!),
      );
    }

    for (const disk of disks) {
      await deleteAzureResource(summary, 'disk', disk.name!, () =>
        computeClient.disks.beginDelete(resourceGroup, disk.name!),
      );
    }
  } catch (error) {
    const message = errorMessage(error);
    summary.errors.push({
      type: 'resourceGroup',
      id: resourceGroup,
      error: message,
    });
    console.warn(`Failed to scan ${resourceGroup}: ${message}`);
  }
}

async function cleanupContainers(
  prefix: string,
  subscriptionId: string,
  credential: ClientSecretCredential,
  summary: NukeRunCleanupSummary,
  options: WorkloadPrefixCleanupOptions = {},
): Promise<void> {
  const storageAccountName = storageAccountNameForSubscription(subscriptionId);
  const blobServiceClient = new BlobServiceClient(
    `https://${storageAccountName}.blob.core.windows.net`,
    credential,
  );

  try {
    for await (const container of blobServiceClient.listContainers({
      includeMetadata: true,
    })) {
      if (!container.name) continue;
      if (!hasWorkloadPrefix(container.metadata, prefix, options)) continue;

      try {
        await blobServiceClient
          .getContainerClient(container.name)
          .deleteIfExists();
        summary.deleted.container += 1;
        console.log(`Deleted Azure container: ${container.name}`);
      } catch (error) {
        const message = errorMessage(error);
        summary.errors.push({
          type: 'container',
          id: container.name,
          error: message,
        });
        console.warn(
          `Failed to delete Azure container ${container.name}: ${message}`,
        );
      }
    }
  } catch (error) {
    const message = errorMessage(error);
    summary.errors.push({
      type: 'container',
      id: 'list-containers',
      error: message,
    });
    console.warn(`Failed to list Azure containers: ${message}`);
  }
}

export async function cleanupAzureNukeRun(
  rawPrefix: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NukeRunCleanupSummary> {
  const prefix = validateNukeCleanupPrefix(rawPrefix);
  return cleanupAzureWorkloadPrefix(prefix, azureCredentialsEnv(env));
}

export async function cleanupAzureServeRun(
  rawPrefix: string | undefined = undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NukeRunCleanupSummary> {
  const azureEnv = azureCredentialsEnv(env);
  const prefix =
    rawPrefix === undefined || rawPrefix.trim() === ''
      ? serveCleanupPrefixFromEnv(azureEnv)
      : validateServeCleanupPrefix(rawPrefix);
  return cleanupAzureWorkloadPrefix(prefix, azureEnv, {
    requireAnycloudTestUser: true,
  });
}

/** Used only after the caller proves this hosted API's run is abandoned. */
export async function cleanupAzureManagedGpuOwner(
  region: string,
  apiIdentity: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ summary: NukeRunCleanupSummary; residualResources: string[] }> {
  if (!/^[a-z0-9-]+$/.test(region) || !/^[a-f0-9]{32}$/.test(apiIdentity)) {
    throw new Error('Exact Azure region and hosted API owner are required');
  }
  const credentials = requireAzureCredentials(azureCredentialsEnv(env));
  const resources = new ResourceManagementClient(
    new ClientSecretCredential(
      credentials.tenantId,
      credentials.clientId,
      credentials.clientSecret,
    ),
    credentials.subscriptionId,
  );
  const resourceGroup = `anycloud-${region}`;
  const options = {
    ownedApiIdentity: apiIdentity,
    region,
    subscriptionId: credentials.subscriptionId,
  };
  const compute = new Azure(
    completeCloudConfig({
      cloudProvider: CloudType.Azure,
      region,
      credentials: {
        subscriptionId: credentials.subscriptionId,
        directoryId: credentials.tenantId,
        applicationId: credentials.clientId,
        secret: credentials.clientSecret,
      },
    }),
  ).compute();
  const summary = await cleanupAzureWorkloadPrefix(
    apiIdentity,
    azureCredentialsEnv(env),
    {
      ...options,
      terminateVm: async (name) => {
        const terminated = await compute.terminateVMs([name]);
        if (!terminated.includes(name)) {
          throw new Error(`Azure did not confirm owned VM ${name} terminated`);
        }
      },
    },
  );
  const observe = async () => {
    const residualResources: string[] = [];
    try {
      for await (const resource of resources.resources.listByResourceGroup(
        resourceGroup,
      )) {
        // Unexpected resource kinds or conflicting scope tags must remain
        // visible as residuals even though the deletion selector rejects them.
        if (resource.tags?.anycloud_owner_api !== apiIdentity) continue;
        const prefix = `/subscriptions/${credentials.subscriptionId}/resourceGroups/${resourceGroup}/providers/`;
        if (!resource.id?.toLowerCase().startsWith(prefix.toLowerCase())) {
          throw new Error('Owned Azure resource has an invalid identity');
        }
        residualResources.push(resource.id);
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    return residualResources;
  };
  let residualResources = await observe();
  if (!residualResources.length) {
    await delay(5000);
    residualResources = await observe();
  }
  return { summary, residualResources };
}

async function cleanupAzureWorkloadPrefix(
  prefix: string,
  env: AzureCredentialsEnv,
  options: WorkloadPrefixCleanupOptions = {},
): Promise<NukeRunCleanupSummary> {
  const credentials = requireAzureCredentials(env);
  const credential = new ClientSecretCredential(
    credentials.tenantId,
    credentials.clientId,
    credentials.clientSecret,
  );

  const resourcesClient = new ResourceManagementClient(
    credential,
    credentials.subscriptionId,
  );
  const computeClient = new ComputeManagementClient(
    credential,
    credentials.subscriptionId,
  );
  const networkClient = new NetworkManagementClient(
    credential,
    credentials.subscriptionId,
  );
  const summary: NukeRunCleanupSummary = {
    prefix,
    resourceGroups: [],
    deleted: {
      vm: 0,
      nic: 0,
      publicIp: 0,
      nsg: 0,
      vnet: 0,
      disk: 0,
      container: 0,
    },
    errors: [],
  };

  if (options.region) {
    const name = `anycloud-${options.region}`;
    try {
      await resourcesClient.resourceGroups.get(name);
      summary.resourceGroups.push(name);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  } else {
    for await (const group of resourcesClient.resourceGroups.list()) {
      if (isAnycloudRegionalResourceGroup(group.name)) {
        summary.resourceGroups.push(group.name);
      }
    }
  }

  for (const resourceGroup of summary.resourceGroups) {
    await cleanupResourceGroup(
      prefix,
      resourceGroup,
      computeClient,
      networkClient,
      summary,
      options,
    );
  }

  if (!options.ownedApiIdentity) {
    await cleanupContainers(
      prefix,
      credentials.subscriptionId,
      credential,
      summary,
      options,
    );
  }
  return summary;
}

async function main(): Promise<void> {
  const summary = await cleanupAzureNukeRun(process.argv[2]);
  console.log(
    `Azure nuke cleanup summary for ${summary.prefix}: resourceGroups=${summary.resourceGroups.length} deleted=${JSON.stringify(summary.deleted)} errors=${summary.errors.length}`,
  );
  if (summary.errors.length > 0) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`Azure nuke cleanup failed: ${errorMessage(error)}`);
    process.exit(1);
  });
}
