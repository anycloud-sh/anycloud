/**
 * Azure optimizer prefilter integration tests
 *
 * Read-only coverage for the Azure optimizer path. These tests call Azure ARM
 * quota/usage and Resource SKUs list APIs, then exercise
 * resolveProvisioningConfig() before provisioning. They must not create VMs,
 * public IPs, NICs, quota tickets, or support requests.
 *
 * Requirements:
 * - AZURE_SUBSCRIPTION_ID
 * - AZURE_TENANT_ID
 * - AZURE_CLIENT_ID
 * - AZURE_CLIENT_SECRET
 *
 * Optional inputs:
 * - AZURE_PREFILTER_VM_TYPE, default Standard_NC40ads_H100_v5
 * - AZURE_PREFILTER_NO_QUOTA_REGION, default australiaeast
 * - AZURE_PREFILTER_COMPUTE_RESTRICTED_REGION, required for restriction coverage
 *
 * Run with:
 *   source .env.azure && yarn test:azure-prefilter
 */
import { randomUUID } from 'crypto';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { AzureQuotaProvider } from '../../src/api/services/quota/azure';
import { createAzureCatalogOverlayProvider } from '../../src/api/services/catalog-overlays/azure.js';
import type { CatalogOverlayProvider } from '../../src/api/services/catalog-overlay.js';
import { CandidateRegionAvailability } from '../../src/api/services/gateways/cloud.js';
import {
  encryptCredential,
  hashCredential,
  resolveProvisioningConfig,
} from '../../src/api/services/cloud-config';
import {
  getCredentialSecretStore,
  resetPersistence,
  getWorkloadQueryStore as queries,
} from '../../src/api/services/persistence.js';
import { getWorkloadAdmissionWriter } from '../../src/api/services/workload-admission-writer.js';
import {
  getRegionsForVMType,
  getVCPUsForVMType,
} from '../../src/shared/cloud-config';
import { getAzureQuotaResourceKeyForVMType } from '../../src/shared/quota-resolvers/azure';
import { type StoredWorkload } from '../../src/api/services/workload-record.js';
import {
  CloudType,
  type AzureCredentials,
  type AzureCreds,
} from '../../src/shared/cloud.js';
import { WorkloadState } from '../../src/shared/workload.js';
import { useTestCatalogs } from './helpers/test-catalogs.js';

useTestCatalogs();

const VM_TYPE =
  process.env.AZURE_PREFILTER_VM_TYPE ?? 'Standard_NC40ads_H100_v5';
const NO_QUOTA_REGION =
  process.env.AZURE_PREFILTER_NO_QUOTA_REGION ?? 'australiaeast';
const COMPUTE_RESTRICTED_REGION =
  process.env.AZURE_PREFILTER_COMPUTE_RESTRICTED_REGION;

function requireAzureEnv(): void {
  if (
    !process.env.AZURE_SUBSCRIPTION_ID ||
    !process.env.AZURE_TENANT_ID ||
    !process.env.AZURE_CLIENT_ID ||
    !process.env.AZURE_CLIENT_SECRET
  ) {
    throw new Error(
      'Azure credentials not found. Set AZURE_SUBSCRIPTION_ID, AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET',
    );
  }
}

function azureCreds(): AzureCreds {
  return {
    subscriptionId: process.env.AZURE_SUBSCRIPTION_ID!,
    directoryId: process.env.AZURE_TENANT_ID!,
    applicationId: process.env.AZURE_CLIENT_ID!,
    secret: process.env.AZURE_CLIENT_SECRET!,
  };
}

function azureCloudCreds(): AzureCredentials {
  return {
    cloudProvider: CloudType.Azure,
    ...azureCreds(),
  };
}

async function validateAzureReadAccess(
  provider: AzureQuotaProvider,
  overlay: CatalogOverlayProvider,
): Promise<void> {
  // Both operations are read-only. Overlay refresh uses the same bounded,
  // region-filtered Resource SKUs path as production, but this integration
  // test awaits it so assertions have a complete observation.
  await provider.listCurrentStatusQuotas(NO_QUOTA_REGION);
  await overlay.refresh('integration-read-access');
}

function normalizeAzureLocation(location: string): string {
  return location.replace(/\s+/g, '').toLowerCase();
}

function normalizeRegionSet(regions: Iterable<string>): Set<string> {
  return new Set(Array.from(regions, normalizeAzureLocation));
}

function requiredVCPUs(): number {
  const vCPUs = getVCPUsForVMType(VM_TYPE, CloudType.Azure);
  if (vCPUs === undefined) {
    throw new Error(`${VM_TYPE} is missing vCPU metadata in the Azure catalog`);
  }
  return vCPUs;
}

function candidateRegions(): string[] {
  const regions = getRegionsForVMType(VM_TYPE, CloudType.Azure, true);
  if (regions.length === 0) {
    throw new Error(`${VM_TYPE} has no spot regions in the Azure catalog`);
  }
  return regions;
}

async function azureUnavailableRegions(
  provider: AzureQuotaProvider,
  overlay: CatalogOverlayProvider,
  regions: string[],
): Promise<Set<string>> {
  const quotaInsufficient = await provider.getInsufficientQuotaRegions(
    getAzureQuotaResourceKeyForVMType(VM_TYPE),
    requiredVCPUs(),
    true,
    regions,
  );
  const snapshot = overlay.read();
  return normalizeRegionSet([
    ...quotaInsufficient.insufficientRegions,
    ...regions.filter(
      (region) =>
        snapshot?.assessCandidate({ vmType: VM_TYPE, region }) !==
        CandidateRegionAvailability.Verified,
    ),
  ]);
}

async function createQueuedAzureWorkload(
  input: { region?: string; vmType?: string | string[] } = {},
): Promise<StoredWorkload> {
  const writer = getWorkloadAdmissionWriter();
  const credentials = azureCloudCreds();
  const credentialId = await writer.upsertCredential(
    hashCredential(credentials),
    await encryptCredential(credentials),
    CloudType.Azure,
  );
  const id = `az-prefilter-${randomUUID()}`;
  await writer.createWorkload({
    id,
    userId: 'azure-prefilter-test',
    workloadType: 'job',
    image: 'alpine:latest',
    requestedComputeProvider: CloudType.Azure,
    region: input.region,
    vmType: input.vmType ?? VM_TYPE,
    spot: true,
    dockerCommand: 'docker run --rm alpine:latest true',
    sshPrivateKey: 'test-private-key',
    credentialId,
  });
  const workload = await queries().getWorkload(id);
  if (!workload) throw new Error(`Failed to create workload ${id}`);
  return workload;
}

describe('Azure optimizer prefilter integration', { timeout: 180_000 }, () => {
  let provider: AzureQuotaProvider;
  let overlay: CatalogOverlayProvider;

  beforeAll(async () => {
    requireAzureEnv();
    provider = new AzureQuotaProvider(azureCreds());
    overlay = createAzureCatalogOverlayProvider(azureCreds());
    await validateAzureReadAccess(provider, overlay);

    const catalogRegions = normalizeRegionSet(candidateRegions());
    expect(catalogRegions).toContain(normalizeAzureLocation(NO_QUOTA_REGION));
  });

  beforeEach(() => {
    resetPersistence();
  });

  it('marks a configured no-quota region unavailable for spot', async () => {
    const insufficient = await provider.getInsufficientQuotaRegions(
      getAzureQuotaResourceKeyForVMType(VM_TYPE),
      requiredVCPUs(),
      true,
      [NO_QUOTA_REGION],
    );

    expect(normalizeRegionSet(insufficient.insufficientRegions)).toContain(
      normalizeAzureLocation(NO_QUOTA_REGION),
    );
  });

  it('marks a configured Compute/SKU-restricted region unavailable', () => {
    if (!COMPUTE_RESTRICTED_REGION) {
      throw new Error('AZURE_PREFILTER_COMPUTE_RESTRICTED_REGION is required');
    }

    expect(
      overlay.read()?.assessCandidate({
        vmType: VM_TYPE,
        region: COMPUTE_RESTRICTED_REGION,
      }),
    ).toBe(CandidateRegionAvailability.Unknown);
  });

  it('does not resolve a region-unpinned workload to any quota- or Compute-unavailable region', async () => {
    const regions = candidateRegions();
    const unavailable = await azureUnavailableRegions(
      provider,
      overlay,
      regions,
    );
    const workload = await createQueuedAzureWorkload();

    const resolution = await resolveProvisioningConfig(
      workload,
      queries(),
      getCredentialSecretStore(),
    );

    if (resolution.state === WorkloadState.Invalid) {
      expect(
        regions.every((r) => unavailable.has(normalizeAzureLocation(r))),
      ).toBe(true);
      expect(resolution.message).toMatch(/lack enough quota or Compute access/);
      return;
    }

    if (resolution.state !== WorkloadState.Provisioning) {
      throw new Error(
        `Expected provisioning resolution, received ${resolution.state}: ${resolution.message}`,
      );
    }
    if (!resolution.config.region) {
      throw new Error('Resolver returned provisioning config without region');
    }
    expect(unavailable).not.toContain(
      normalizeAzureLocation(resolution.config.region),
    );
  });

  it('returns Invalid instead of provisioning when every optimizer candidate is filtered', async () => {
    const workload = await createQueuedAzureWorkload({
      region: NO_QUOTA_REGION,
      // Array input forces the optimizer path while keeping scalar-pinned
      // user-region behavior unchanged.
      vmType: [VM_TYPE],
    });

    const resolution = await resolveProvisioningConfig(
      workload,
      queries(),
      getCredentialSecretStore(),
    );

    if (resolution.state !== WorkloadState.Invalid) {
      throw new Error(
        `Expected invalid resolution, received ${resolution.state}`,
      );
    }
    expect(resolution.message).toMatch(/lack enough quota or Compute access/);
  });
});
