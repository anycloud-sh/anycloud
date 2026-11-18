import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const output = vi.hoisted(() => ({ exitWithError: vi.fn() }));

vi.mock('../../../../src/cli/utils/output.js', () => ({
  exitWithError: output.exitWithError,
}));

import { getCredentialsFromEnv } from '../../../../src/cli/services/non-interactive';
import { CloudType } from '../../../../src/shared/cloud.js';

const PROVIDER_VARS = [
  'ANYCLOUD_CLOUD_PROVIDER',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_APPLICATION_ID',
  'AZURE_SECRET',
  'AZURE_SUBSCRIPTION_ID',
  'AZURE_DIRECTORY_ID',
  'GCP_PROJECT_ID',
  'GCP_CLIENT_EMAIL',
  'GCP_PRIVATE_KEY',
  'LAMBDA_API_KEY',
];

const providerCases = [
  {
    label: 'AWS',
    provider: 'aws',
    variables: {
      AWS_ACCESS_KEY_ID: 'AKIA-ENV',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
    },
    expected: {
      cloudProvider: CloudType.AWS,
      accessKeyId: 'AKIA-ENV',
      secretAccessKey: 'aws-secret',
    },
  },
  {
    label: 'Azure',
    provider: 'azure',
    variables: {
      AZURE_APPLICATION_ID: 'azure-application',
      AZURE_SECRET: 'azure-secret',
      AZURE_SUBSCRIPTION_ID: 'azure-subscription',
      AZURE_DIRECTORY_ID: 'azure-directory',
    },
    expected: {
      cloudProvider: CloudType.Azure,
      applicationId: 'azure-application',
      secret: 'azure-secret',
      subscriptionId: 'azure-subscription',
      directoryId: 'azure-directory',
    },
  },
  {
    label: 'GCP',
    provider: 'gcp',
    variables: {
      GCP_PROJECT_ID: 'gcp-project',
      GCP_CLIENT_EMAIL: 'service@gcp-project.iam.gserviceaccount.com',
      GCP_PRIVATE_KEY: 'gcp-private-key',
    },
    expected: {
      cloudProvider: CloudType.GCP,
      projectId: 'gcp-project',
      clientEmail: 'service@gcp-project.iam.gserviceaccount.com',
      privateKey: 'gcp-private-key',
    },
  },
  {
    label: 'Lambda',
    provider: 'lambda',
    variables: { LAMBDA_API_KEY: 'lambda-key' },
    expected: {
      cloudProvider: CloudType.Lambda,
      apiKey: 'lambda-key',
    },
  },
] as const;

const saved: Record<string, string | undefined> = {};

describe('getCredentialsFromEnv', () => {
  beforeEach(() => {
    output.exitWithError.mockImplementation((message: string) => {
      throw new Error(message);
    });
    for (const variable of PROVIDER_VARS) {
      saved[variable] = process.env[variable];
      delete process.env[variable];
    }
  });

  afterEach(() => {
    for (const variable of PROVIDER_VARS) {
      if (saved[variable] === undefined) delete process.env[variable];
      else process.env[variable] = saved[variable];
    }
  });

  it.each(providerCases)(
    'builds $label credentials for an explicit case-insensitive provider',
    ({ provider, variables, expected }) => {
      process.env.ANYCLOUD_CLOUD_PROVIDER = provider;
      Object.assign(process.env, variables);

      expect(getCredentialsFromEnv()).toEqual(expected);
    },
  );

  it.each(providerCases)(
    'auto-detects $label from its complete environment shape',
    ({ variables, expected }) => {
      Object.assign(process.env, variables);

      expect(getCredentialsFromEnv()).toEqual(expected);
    },
  );

  it('auto-detects when ANYCLOUD_CLOUD_PROVIDER is empty', () => {
    process.env.ANYCLOUD_CLOUD_PROVIDER = '';
    Object.assign(process.env, providerCases[0].variables);

    expect(getCredentialsFromEnv()).toEqual(providerCases[0].expected);
  });

  it('preserves the existing AWS-first auto-detection precedence', () => {
    for (const { variables } of providerCases) {
      Object.assign(process.env, variables);
    }

    expect(getCredentialsFromEnv()).toEqual(providerCases[0].expected);
  });

  it('uses the explicit provider instead of auto-detecting another complete shape', () => {
    process.env.ANYCLOUD_CLOUD_PROVIDER = 'lambda';
    Object.assign(process.env, providerCases[0].variables);
    Object.assign(process.env, providerCases[3].variables);

    expect(getCredentialsFromEnv()).toEqual(providerCases[3].expected);
  });

  it('does not persist an ambient AWS session token', () => {
    Object.assign(process.env, providerCases[0].variables);
    process.env.AWS_SESSION_TOKEN = 'temporary-session';

    expect(getCredentialsFromEnv()).toEqual(providerCases[0].expected);
  });

  it('preserves the missing provider guidance', () => {
    expect(() => getCredentialsFromEnv()).toThrow(
      'Could not auto-detect cloud provider from environment.\n' +
        '   Set ANYCLOUD_CLOUD_PROVIDER to AWS, Azure, GCP, or Lambda, and provide required credentials.',
    );
  });

  it('preserves the missing provider-field guidance', () => {
    process.env.ANYCLOUD_CLOUD_PROVIDER = 'aws';
    process.env.AWS_ACCESS_KEY_ID = 'AKIA-INCOMPLETE';

    expect(() => getCredentialsFromEnv()).toThrow(
      'AWS Secret Access Key required.\n' +
        '   Pass the equivalent flag or set AWS_SECRET_ACCESS_KEY environment variable.',
    );
  });

  it('preserves invalid provider guidance', () => {
    process.env.ANYCLOUD_CLOUD_PROVIDER = 'oracle';

    expect(() => getCredentialsFromEnv()).toThrow(
      'Invalid cloud "oracle". Must be aws, azure, gcp, or lambda.',
    );
  });
});
