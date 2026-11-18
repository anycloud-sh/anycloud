import { describe, expect, test } from 'vitest';

import { Redactor } from '../integration/e2e/internal/artifacts.js';
import { Environment } from '../integration/e2e/internal/environment.js';
import { ProviderProfiles } from '../integration/e2e/internal/profiles.js';

describe('GPU Service qualification profiles', () => {
  const input = {
    AWS_ACCESS_KEY_ID: 'aws-access',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    AWS_SESSION_TOKEN: 'aws-session',
    AZURE_CLIENT_ID: 'azure-client',
    AZURE_CLIENT_SECRET: 'azure-secret',
    AZURE_TENANT_ID: 'azure-tenant',
    AZURE_SUBSCRIPTION_ID: 'azure-subscription',
    GCP_PROJECT_ID: 'gcp-project',
    GCP_CLIENT_EMAIL: 'gcp-email',
    GCP_PRIVATE_KEY: 'gcp-key',
    LAMBDA_API_KEY: 'lambda-key',
    VM_SMOKE_REGION: 'wrong-vm-region',
    VM_SMOKE_DISK_SIZE_GB: '999',
    SERVE_SMOKE_REGION: 'wrong-service-region',
    SERVE_SMOKE_DISK_SIZE_GB: '777',
  };

  test.each([
    {
      provider: 'aws' as const,
      cloudProvider: 'AWS',
      vmTypes: ['g6e.xlarge'],
      disk: 100,
    },
    {
      provider: 'azure' as const,
      cloudProvider: 'Azure',
      vmTypes: ['Standard_NC4as_T4_v3'],
      disk: 50,
    },
    {
      provider: 'gcp' as const,
      cloudProvider: 'GCP',
      vmTypes: ['g2-standard-4'],
      disk: 50,
    },
    {
      provider: 'lambda' as const,
      cloudProvider: 'Lambda',
      vmTypes: ['gpu_1x_a10'],
      disk: 50,
    },
  ])(
    'keeps $provider qualification independent of ordinary smoke placement',
    ({ provider, cloudProvider, vmTypes, disk }) => {
      const redactor = new Redactor();
      const profiles = new ProviderProfiles(new Environment(input, redactor));
      const profile = profiles.gpuServe(provider);
      expect(profile).toMatchObject({
        slug: provider,
        provider: cloudProvider,
        credentialName: `${provider}-test`,
        vmTypes,
        diskSizeGb: disk,
        gpus: 'all',
      });
      expect(profile.credential).toEqual(profiles.vm(provider).credential);
      expect(profile.region).toBe(provider === 'gcp' ? 'us-east4' : undefined);
      expect(profile.runtime).toBe(provider === 'gcp' ? 'nvidia' : undefined);
      expect(profiles.serve(provider)).toMatchObject({
        region: 'wrong-service-region',
        diskSizeGb: 777,
      });
      expect(redactor.text(JSON.stringify(profile.credential))).not.toContain(
        provider === 'aws'
          ? 'aws-secret'
          : provider === 'azure'
            ? 'azure-secret'
            : provider === 'gcp'
              ? 'gcp-key'
              : 'lambda-key',
      );
    },
  );

  test('requires the selected provider credential before provisioning', () => {
    const profiles = new ProviderProfiles(new Environment({}, new Redactor()));
    expect(() => profiles.gpuServe('lambda')).toThrow('LAMBDA_API_KEY');
  });
});
