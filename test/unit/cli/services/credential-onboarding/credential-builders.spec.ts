import { describe, expect, it } from 'vitest';
import {
  buildCredentialFromEnvironment,
  buildCredentialFromFields,
  CredentialProviderNotDetectedError,
  MissingCredentialEnvironmentVariableError,
} from '../../../../../src/cli/services/credential-onboarding/credential-builders.js';
import { CloudType } from '../../../../../src/shared/cloud.js';

describe('canonical credential builders', () => {
  it.each([
    [
      CloudType.AWS,
      { accessKeyId: 'AKIA-FIELDS', secretAccessKey: 'aws-secret' },
      {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIA-FIELDS',
        secretAccessKey: 'aws-secret',
      },
    ],
    [
      CloudType.Azure,
      {
        applicationId: 'azure-application',
        secret: 'azure-secret',
        subscriptionId: 'azure-subscription',
        directoryId: 'azure-directory',
      },
      {
        cloudProvider: CloudType.Azure,
        applicationId: 'azure-application',
        secret: 'azure-secret',
        subscriptionId: 'azure-subscription',
        directoryId: 'azure-directory',
      },
    ],
    [
      CloudType.GCP,
      {
        projectId: 'gcp-project',
        clientEmail: 'service@gcp-project.iam.gserviceaccount.com',
        privateKey: 'gcp-private-key',
      },
      {
        cloudProvider: CloudType.GCP,
        projectId: 'gcp-project',
        clientEmail: 'service@gcp-project.iam.gserviceaccount.com',
        privateKey: 'gcp-private-key',
      },
    ],
    [
      CloudType.Lambda,
      { apiKey: 'lambda-key' },
      { cloudProvider: CloudType.Lambda, apiKey: 'lambda-key' },
    ],
    [
      CloudType.Cloudflare,
      { accountId: 'cf-account', apiToken: 'cf-token', jurisdiction: 'eu' },
      {
        cloudProvider: CloudType.Cloudflare,
        accountId: 'cf-account',
        apiToken: 'cf-token',
        jurisdiction: 'eu',
      },
    ],
  ] as const)('builds canonical %s fields', (provider, fields, expected) => {
    expect(buildCredentialFromFields(provider, fields)).toEqual(expected);
  });

  it('rejects an incomplete or empty provider shape', () => {
    expect(() =>
      buildCredentialFromFields(CloudType.AWS, {
        accessKeyId: 'AKIA-INCOMPLETE',
      }),
    ).toThrow();
    expect(() =>
      buildCredentialFromFields(CloudType.Lambda, { apiKey: '' }),
    ).toThrow();
  });

  it.each([
    [
      CloudType.AWS,
      {
        AWS_ACCESS_KEY_ID: 'AKIA-ENV',
        AWS_SECRET_ACCESS_KEY: 'aws-secret',
        AWS_SESSION_TOKEN: 'temporary-session',
      },
      {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIA-ENV',
        secretAccessKey: 'aws-secret',
      },
    ],
    [
      CloudType.Azure,
      {
        AZURE_APPLICATION_ID: 'azure-application',
        AZURE_SECRET: 'azure-secret',
        AZURE_SUBSCRIPTION_ID: 'azure-subscription',
        AZURE_DIRECTORY_ID: 'azure-directory',
      },
      {
        cloudProvider: CloudType.Azure,
        applicationId: 'azure-application',
        secret: 'azure-secret',
        subscriptionId: 'azure-subscription',
        directoryId: 'azure-directory',
      },
    ],
    [
      CloudType.GCP,
      {
        GCP_PROJECT_ID: 'gcp-project',
        GCP_CLIENT_EMAIL: 'service@gcp-project.iam.gserviceaccount.com',
        GCP_PRIVATE_KEY: 'gcp-private-key',
      },
      {
        cloudProvider: CloudType.GCP,
        projectId: 'gcp-project',
        clientEmail: 'service@gcp-project.iam.gserviceaccount.com',
        privateKey: 'gcp-private-key',
      },
    ],
    [
      CloudType.Lambda,
      { LAMBDA_API_KEY: 'lambda-key' },
      { cloudProvider: CloudType.Lambda, apiKey: 'lambda-key' },
    ],
  ] as const)(
    'builds canonical %s environment credentials',
    (provider, environment, expected) => {
      expect(buildCredentialFromEnvironment(provider, environment)).toEqual(
        expected,
      );
    },
  );

  it('preserves AWS-first environment auto-detection precedence', () => {
    expect(
      buildCredentialFromEnvironment(undefined, {
        AWS_ACCESS_KEY_ID: 'AKIA-FIRST',
        AWS_SECRET_ACCESS_KEY: 'aws-secret',
        LAMBDA_API_KEY: 'lambda-key',
      }),
    ).toMatchObject({
      cloudProvider: CloudType.AWS,
      accessKeyId: 'AKIA-FIRST',
    });
  });

  it('never auto-detects storage-only Cloudflare from Wrangler-style environment', () => {
    expect(() =>
      buildCredentialFromEnvironment(undefined, {
        CLOUDFLARE_ACCOUNT_ID: 'cf-account',
        CLOUDFLARE_API_TOKEN: 'cf-token',
      }),
    ).toThrow(CredentialProviderNotDetectedError);
  });

  it('distinguishes missing provider detection from a missing required field', () => {
    expect(() => buildCredentialFromEnvironment(undefined, {})).toThrow(
      CredentialProviderNotDetectedError,
    );
    expect(() =>
      buildCredentialFromEnvironment(CloudType.AWS, {
        AWS_ACCESS_KEY_ID: 'AKIA-INCOMPLETE',
      }),
    ).toThrow(MissingCredentialEnvironmentVariableError);
  });
});
