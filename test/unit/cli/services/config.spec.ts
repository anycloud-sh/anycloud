import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CloudType, DiskTier } from '../../../../src/shared/cloud.js';

vi.mock('../../../../src/cli/utils/output.js', () => ({
  exitWithError: (msg: string) => {
    throw new Error(msg);
  },
}));

vi.mock('../../../../src/cli/services/non-interactive.js', () => ({
  getCredentialsNameFromEnv: vi.fn(),
  getCredentialsFromEnv: vi.fn(),
}));

vi.mock('../../../../src/cli/services/credentials.js', () => ({
  getCredentialCloudProvider: vi.fn(),
}));

import { buildCloudConfigFromFlags } from '../../../../src/cli/services/config.js';
import {
  getCredentialsFromEnv,
  getCredentialsNameFromEnv,
} from '../../../../src/cli/services/non-interactive.js';
import { getCredentialCloudProvider } from '../../../../src/cli/services/credentials.js';

describe('buildCloudConfigFromFlags', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...savedEnv };
    vi.mocked(getCredentialsNameFromEnv).mockReturnValue(undefined);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('builds named-credential requests without fetching or setting cloudProvider', async () => {
    const resolved = await buildCloudConfigFromFlags({
      credentials: 'gcp-test',
      region: 'us-central1',
      vmType: 'e2-standard-2',
      spot: true,
      diskSizeGb: 100,
      diskTier: 'high',
      inputBucket: 'input-bucket',
      outputBucket: 'output-bucket',
      inputStorageCredentials: 'storage-in',
      inputStorageRegion: 'us-east-1',
      outputStorageCredentials: 'storage-out',
      outputStorageRegion: 'us-west-2',
      availabilityZone: 'a',
      gpuType: 'h100',
    });

    expect(getCredentialCloudProvider).not.toHaveBeenCalled();
    expect(resolved).toEqual({
      credentialName: 'gcp-test',
      inputStorageCredentialName: 'storage-in',
      outputStorageCredentialName: 'storage-out',
      gpuType: 'h100',
      cloudConfig: {
        region: 'us-central1',
        vmType: 'e2-standard-2',
        spot: true,
        diskSizeGb: 100,
        diskTier: DiskTier.High,
        inputBucket: 'input-bucket',
        outputBucket: 'output-bucket',
        inputStorageRegion: 'us-east-1',
        outputStorageRegion: 'us-west-2',
        availabilityZone: 'a',
      },
    });
    expect(resolved.cloudConfig).not.toHaveProperty('cloudProvider');
    expect(resolved.cloudConfig).not.toHaveProperty('credentials');
  });

  it('builds inline env credentials with cloudProvider and credentials', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'key';
    vi.mocked(getCredentialsFromEnv).mockReturnValue({
      cloudProvider: CloudType.AWS,
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    });

    const resolved = await buildCloudConfigFromFlags({
      region: 'us-east-1',
      vmType: 't3.micro',
    });

    expect(resolved.credentialName).toBeUndefined();
    expect(resolved.cloudConfig).toMatchObject({
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.micro',
      credentials: {
        accessKeyId: 'key',
        secretAccessKey: 'secret',
      },
    });
  });

  it.each([
    ['medium', DiskTier.Medium],
    ['high', DiskTier.High],
    ['ultra', DiskTier.Ultra],
  ])('accepts %s disk tier', async (input, expected) => {
    const resolved = await buildCloudConfigFromFlags({
      credentials: 'prod-aws',
      diskTier: input,
    });

    expect(resolved.cloudConfig.diskTier).toBe(expected);
  });

  it.each(['fast', 'best'])(
    'rejects invalid disk tier value %s',
    async (tier) => {
      await expect(
        buildCloudConfigFromFlags({
          credentials: 'prod-aws',
          diskTier: tier,
        }),
      ).rejects.toThrow(/--disk-tier must be one of/i);
    },
  );
});
