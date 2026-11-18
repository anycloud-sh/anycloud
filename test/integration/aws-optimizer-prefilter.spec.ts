/**
 * AWS optimizer prefilter integration tests
 *
 * Read-only coverage for the AWS optimizer path. These tests call AWS Account
 * and Service Quotas read APIs, then exercise resolveProvisioningConfig()
 * before provisioning. They must not create EC2 instances, security groups,
 * quota requests, or region opt-in requests.
 *
 * Requirements:
 * - AWS_ACCESS_KEY_ID
 * - AWS_SECRET_ACCESS_KEY
 *
 * Optional inputs:
 * - AWS_SESSION_TOKEN
 * - AWS_PREFILTER_VM_TYPE, default g6e.48xlarge
 * - AWS_PREFILTER_SPOT, default false
 * - AWS_PREFILTER_ZERO_QUOTA_REGION, required for hard quota coverage
 * - AWS_PREFILTER_DISABLED_REGION, required for disabled-region coverage
 *
 * Run with:
 *   source .env.aws && yarn test:aws-prefilter
 */
import { randomUUID } from 'crypto';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { AwsQuotaProvider } from '../../src/api/services/quota/aws';
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
import { getRegionsForVMType } from '../../src/shared/cloud-config';
import { type StoredWorkload } from '../../src/api/services/workload-record.js';
import {
  CloudType,
  type AWSCredentials,
  type AWSCreds,
} from '../../src/shared/cloud.js';
import { WorkloadState } from '../../src/shared/workload.js';
import { useTestCatalogs } from './helpers/test-catalogs.js';

useTestCatalogs();

const VM_TYPE = process.env.AWS_PREFILTER_VM_TYPE ?? 'g6e.48xlarge';
const SPOT = /^(1|true|yes)$/i.test(process.env.AWS_PREFILTER_SPOT ?? '');
const ZERO_QUOTA_REGION = process.env.AWS_PREFILTER_ZERO_QUOTA_REGION;
const DISABLED_REGION = process.env.AWS_PREFILTER_DISABLED_REGION;

function requireAwsEnv(): void {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error(
      'AWS credentials not found. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY',
    );
  }

  if (process.env.CI === 'true' && !ZERO_QUOTA_REGION) {
    throw new Error(
      'Set AWS_PREFILTER_ZERO_QUOTA_REGION in CI for hard AWS quota prefilter coverage',
    );
  }
}

function awsCreds(): AWSCreds {
  return {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    sessionToken: process.env.AWS_SESSION_TOKEN || undefined,
  };
}

function awsCloudCreds(): AWSCredentials {
  return {
    cloudProvider: CloudType.AWS,
    ...awsCreds(),
  };
}

async function validateAwsReadAccess(
  provider: AwsQuotaProvider,
): Promise<void> {
  await provider.getEnabledRegions();
  const [region] = candidateRegions();
  await provider.getZeroQuotaRegions(VM_TYPE, SPOT, [region]);
}

function candidateRegions(): string[] {
  const regions = getRegionsForVMType(VM_TYPE, CloudType.AWS, SPOT);
  if (regions.length === 0) {
    throw new Error(
      `${VM_TYPE} has no ${SPOT ? 'spot' : 'on-demand'} regions in the AWS catalog`,
    );
  }
  return regions;
}

function expectRegionInCatalog(region: string): void {
  expect(candidateRegions()).toContain(region);
}

async function configuredUnavailableRegion(
  provider: AwsQuotaProvider,
): Promise<string> {
  if (ZERO_QUOTA_REGION) {
    expectRegionInCatalog(ZERO_QUOTA_REGION);
    const zeroResult = await provider.getZeroQuotaRegions(VM_TYPE, SPOT, [
      ZERO_QUOTA_REGION,
    ]);
    expect(zeroResult.zeroRegions).toContain(ZERO_QUOTA_REGION);
    return ZERO_QUOTA_REGION;
  }

  if (DISABLED_REGION) {
    expectRegionInCatalog(DISABLED_REGION);
    const enabled = await provider.getEnabledRegions();
    expect(enabled).not.toContain(DISABLED_REGION);
    return DISABLED_REGION;
  }

  throw new Error(
    'Set AWS_PREFILTER_ZERO_QUOTA_REGION or AWS_PREFILTER_DISABLED_REGION for the all-filtered resolver assertion',
  );
}

async function awsUnavailableRegions(
  provider: AwsQuotaProvider,
  regions: string[],
): Promise<Set<string>> {
  const enabled = await provider.getEnabledRegions();
  const enabledCandidates = regions.filter((r) => enabled.has(r));
  const zeroResult = await provider.getZeroQuotaRegions(
    VM_TYPE,
    SPOT,
    enabledCandidates,
  );

  return new Set(
    regions.filter((r) => !enabled.has(r) || zeroResult.zeroRegions.has(r)),
  );
}

async function createQueuedAwsWorkload(
  input: { region?: string; vmType?: string | string[] } = {},
): Promise<StoredWorkload> {
  const writer = getWorkloadAdmissionWriter();
  const credentials = awsCloudCreds();
  const credentialId = await writer.upsertCredential(
    hashCredential(credentials),
    await encryptCredential(credentials),
    CloudType.AWS,
  );
  const id = `aws-prefilter-${randomUUID()}`;
  await writer.createWorkload({
    id,
    userId: 'aws-prefilter-test',
    workloadType: 'job',
    image: 'alpine:latest',
    requestedComputeProvider: CloudType.AWS,
    region: input.region,
    vmType: input.vmType ?? VM_TYPE,
    spot: SPOT,
    dockerCommand: 'docker run --rm alpine:latest true',
    sshPrivateKey: 'test-private-key',
    credentialId,
  });
  const workload = await queries().getWorkload(id);
  if (!workload) throw new Error(`Failed to create workload ${id}`);
  return workload;
}

describe('AWS optimizer prefilter integration', { timeout: 180_000 }, () => {
  let provider: AwsQuotaProvider;

  beforeAll(async () => {
    requireAwsEnv();
    provider = new AwsQuotaProvider(awsCreds());
    await validateAwsReadAccess(provider);
  });

  beforeEach(() => {
    resetPersistence();
  });

  it('marks a configured zero-quota region unavailable', async () => {
    if (!ZERO_QUOTA_REGION) {
      throw new Error('AWS_PREFILTER_ZERO_QUOTA_REGION is required');
    }

    expectRegionInCatalog(ZERO_QUOTA_REGION);
    const zeroResult = await provider.getZeroQuotaRegions(VM_TYPE, SPOT, [
      ZERO_QUOTA_REGION,
    ]);

    expect(zeroResult.zeroRegions).toContain(ZERO_QUOTA_REGION);
  });

  it('marks a configured disabled region unavailable', async () => {
    if (!DISABLED_REGION) {
      throw new Error('AWS_PREFILTER_DISABLED_REGION is required');
    }

    const enabled = await provider.getEnabledRegions();

    expect(enabled).not.toContain(DISABLED_REGION);
  });

  it('does not resolve a region-unpinned workload to any disabled or zero-quota region', async () => {
    const regions = candidateRegions();
    const unavailable = await awsUnavailableRegions(provider, regions);
    const workload = await createQueuedAwsWorkload();

    const resolution = await resolveProvisioningConfig(
      workload,
      queries(),
      getCredentialSecretStore(),
    );

    if (resolution.state === WorkloadState.Invalid) {
      expect(regions.every((r) => unavailable.has(r))).toBe(true);
      expect(resolution.message).toMatch(/not opted-in or have a vCPU quota/);
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
    expect(unavailable).not.toContain(resolution.config.region);
  });

  it('returns Invalid instead of provisioning when every optimizer candidate is filtered', async () => {
    const badRegion = await configuredUnavailableRegion(provider);

    const workload = await createQueuedAwsWorkload({
      region: badRegion,
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
    expect(resolution.message).toMatch(/not opted-in or have a vCPU quota/);
  });
});
