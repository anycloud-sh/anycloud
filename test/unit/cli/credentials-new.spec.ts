import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';
import { ORPCError } from '@orpc/client';
import { CloudType, type CloudCredentials } from '../../../src/shared/cloud.js';

const api = vi.hoisted(() => ({
  listCredentials: vi.fn(),
  saveCredential: vi.fn(),
}));

const spinnerMock = vi.hoisted(() => ({
  succeed: vi.fn(),
  warn: vi.fn(),
  fail: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('../../../src/cli/utils/output.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/cli/utils/output.js')>();
  return {
    ...actual,
    exitWithError: (msg: string) => {
      throw new Error(msg);
    },
    createSpinner: vi.fn(() => ({
      start: () => spinnerMock,
    })),
    printInfo: vi.fn(),
    printSuccess: vi.fn(),
    printWarning: vi.fn(),
    printError: vi.fn(),
  };
});

vi.mock('../../../src/cli/utils/safe-prompts.js', () => ({
  safePrompts: vi.fn(),
  shouldAllowPrompts: vi.fn(),
}));

vi.mock('../../../src/shared/services/api-client/rpc.js', () => {
  return {
    createApiClient: () => ({
      credentials: {
        list: api.listCredentials,
        save: api.saveCredential,
      },
    }),
  };
});

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock(),
);

vi.mock('crypto', async (importActual) => {
  const actual = await importActual<typeof import('crypto')>();
  return {
    ...actual,
    randomUUID: vi.fn(() => 'abcdef12-3456-7890-abcd-ef1234567890'),
  };
});

vi.mock('../../../src/cli/services/slurp/aws.js', () => ({
  isAWSCLIInstalled: vi.fn(),
  getCurrentAWSProfile: vi.fn(() => process.env.AWS_PROFILE || 'default'),
  getAWSCLIInstallCommand: vi.fn(() => 'brew install awscli'),
  listAWSProfileNames: vi.fn(),
  listImportableAWSProfileSummaries: vi.fn(),
  resolveAWSProfileSource: vi.fn(),
}));

vi.mock(
  '../../../src/cli/services/credential-bootstrap/aws.js',
  async (original) => ({
    ...(await original<
      typeof import('../../../src/cli/services/credential-bootstrap/aws.js')
    >()),
    getAWSGenerationPreview: vi.fn(),
    generateAWSCredentials: vi.fn(),
  }),
);

vi.mock(
  '../../../src/cli/services/credential-onboarding/aws-validation.js',
  () => ({ validateAWSAccessCredentials: vi.fn() }),
);

vi.mock('../../../src/cli/services/slurp/azure.js', () => ({
  isAzureCLIInstalled: vi.fn(),
  isAzureCLILoggedIn: vi.fn(),
  loginToAzure: vi.fn(),
  getAzureCLIInstallCommand: vi.fn(() => 'brew install azure-cli'),
  getCurrentAzureSubscription: vi.fn(),
  listAzureSubscriptions: vi.fn(),
}));

vi.mock('../../../src/cli/services/credential-bootstrap/azure.js', () => ({
  AzurePermissionError: class extends Error {},
  generateAzureServicePrincipal: vi.fn(),
  getAzureGenerationPreview: vi.fn(),
}));

vi.mock(
  '../../../src/cli/services/credential-bootstrap/gcp.js',
  async (original) => ({
    ...(await original<
      typeof import('../../../src/cli/services/credential-bootstrap/gcp.js')
    >()),
    getGCPGenerationPreview: vi.fn(),
    generateGCPCredentials: vi.fn(),
  }),
);

vi.mock('../../../src/cli/services/slurp/gcp.js', () => ({
  getADCPath: vi.fn(() => '/keys/gcp.json'),
  getAllServiceAccountKeyPaths: vi.fn(),
  getGCloudInstallCommand: vi.fn(
    () => 'curl https://sdk.cloud.google.com | bash',
  ),
  isGCloudInstalled: vi.fn(async () => true),
  prepareGCPServiceAccountKeyImport: vi.fn(),
}));

vi.mock(
  '../../../src/cli/services/credential-onboarding/gcp-key-files.js',
  () => ({
    readServiceAccountKey: vi.fn(),
    readServiceAccountKeySummary: vi.fn(),
    extractGCPCredentials: (credentials: {
      project_id: string;
      client_email: string;
      private_key: string;
    }) => ({
      projectId: credentials.project_id,
      clientEmail: credentials.client_email,
      privateKey: credentials.private_key,
    }),
  }),
);

import {
  acquireAzureGeneratedCredentials,
  acquireCredentialsFromOptions,
  acquireCredentialsInteractive,
  acquireGeneratedCredentials,
  buildAzureGeneratedCredentials,
  buildCredentialsFromOptions,
  buildCredentialsInteractive,
  resolveCredentialName,
  validateAzureGenerationSelection,
  validateGenerationSelection,
} from '../../../src/cli/services/credential-onboarding/index.js';
import { createNewCommand } from '../../../src/cli/commands/credentials/new.js';
import {
  safePrompts,
  shouldAllowPrompts,
} from '../../../src/cli/utils/safe-prompts.js';
import {
  isAWSCLIInstalled,
  listAWSProfileNames,
  listImportableAWSProfileSummaries,
  resolveAWSProfileSource,
} from '../../../src/cli/services/slurp/aws.js';
import {
  generateAWSCredentials,
  getAWSGenerationPreview,
} from '../../../src/cli/services/credential-bootstrap/aws.js';
import { validateAWSAccessCredentials } from '../../../src/cli/services/credential-onboarding/aws-validation.js';
import {
  isAzureCLIInstalled,
  isAzureCLILoggedIn,
  loginToAzure,
  getCurrentAzureSubscription,
  listAzureSubscriptions,
} from '../../../src/cli/services/slurp/azure.js';
import {
  generateAzureServicePrincipal,
  getAzureGenerationPreview,
} from '../../../src/cli/services/credential-bootstrap/azure.js';
import {
  getGCPGenerationPreview,
  generateGCPCredentials,
} from '../../../src/cli/services/credential-bootstrap/gcp.js';
import { gcpOperator } from '../../../src/cli/services/credential-bootstrap/gcp-cli-runner.js';
import { GCPBootstrapError } from '../../../src/cli/services/credential-bootstrap/gcp-transport.js';
import {
  createSpinner,
  printError,
  printInfo,
  printSuccess,
  printWarning,
} from '../../../src/cli/utils/output.js';
import {
  getAllServiceAccountKeyPaths,
  prepareGCPServiceAccountKeyImport,
} from '../../../src/cli/services/slurp/gcp.js';
import {
  readServiceAccountKey,
  readServiceAccountKeySummary,
  type GCPServiceAccountKey,
} from '../../../src/cli/services/credential-onboarding/gcp-key-files.js';
import { apiClient } from '../../../src/cli/services/auth.js';

const listApiCredentials = api.listCredentials;
const saveApiCredential = api.saveCredential;

function mockGCPGeneration() {
  const operator = gcpOperator('operator@example.com', 'selected-project', {});
  const preview = {
    operator,
    projectNumber: '123456789012',
    accountId: 'anycloud-test-gcp',
    email: 'anycloud-test-gcp@selected-project.iam.gserviceaccount.com',
  };
  const cleanup = vi.fn().mockResolvedValue(undefined);
  const generated = {
    projectId: operator.projectId,
    clientEmail: preview.email,
    privateKey: 'PRIVATE-GENERATED-GCP-KEY',
    ownership: {
      projectId: operator.projectId,
      projectNumber: preview.projectNumber,
      email: preview.email,
      uniqueId: '222222222222222222222',
      invocationId: '00000000-0000-4000-8000-000000000001',
      keyIds: ['abc123'],
      projectRoles: [`projects/${operator.projectId}/roles/anycloud`],
    },
    cleanup,
  };
  vi.mocked(getGCPGenerationPreview).mockResolvedValue(preview);
  vi.mocked(generateGCPCredentials).mockResolvedValue(generated);
  return { preview, generated, cleanup };
}

function mockAWSGeneration() {
  vi.mocked(getAWSGenerationPreview).mockImplementation(
    async (operator, credentialName) => ({
      operator,
      caller: {
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:role/Operator',
        UserId: 'AROAOPERATOR',
      },
      userName: `anycloud-${credentialName}`,
    }),
  );
  vi.mocked(generateAWSCredentials).mockImplementation(async (preview) => {
    expect(spinnerMock.stop).not.toHaveBeenCalled();
    return {
      accessKeyId: 'AKIA-GENERATED',
      secretAccessKey: 'SECRET-GENERATED',
      ownership: {
        accountId: preview.caller.Account,
        userName: preview.userName,
        userId: 'AIDAGENERATED',
        invocationId: '00000000-0000-4000-8000-000000000002',
        accessKeyIds: ['AKIA-GENERATED'],
        inlinePolicyNames: [],
      },
      cleanup: vi.fn().mockResolvedValue(undefined),
    };
  });
}

function testHttpError(
  status: number,
  message: string,
): ORPCError<string, unknown> {
  return new ORPCError('TEST_HTTP_ERROR', { status, message });
}

const AWS_VARS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
];
const AZURE_VARS = [
  'AZURE_APPLICATION_ID',
  'AZURE_SECRET',
  'AZURE_SUBSCRIPTION_ID',
  'AZURE_DIRECTORY_ID',
];
const GCP_VARS = ['GCP_PROJECT_ID', 'GCP_CLIENT_EMAIL', 'GCP_PRIVATE_KEY'];
const LAMBDA_VARS = ['LAMBDA_API_KEY'];
const CLOUDFLARE_VARS = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'];
const ALL_VARS = [
  'ANYCLOUD_CLOUD_PROVIDER',
  ...AWS_VARS,
  ...AZURE_VARS,
  ...GCP_VARS,
  ...LAMBDA_VARS,
  ...CLOUDFLARE_VARS,
];

const IMPORT_CASES: Array<{
  provider: string;
  label: string;
  environment: Record<string, string>;
  flags: string[];
  credential: CloudCredentials;
  source: string;
  review: string[];
  secret: string;
}> = [
  {
    provider: 'aws',
    label: 'AWS',
    environment: {
      AWS_ACCESS_KEY_ID: 'AKIA-ENV',
      AWS_SECRET_ACCESS_KEY: 'AWS-ENV-SECRET',
    },
    flags: [
      '--access-key-id',
      'AKIA-ENV',
      '--secret-access-key',
      'AWS-ENV-SECRET',
    ],
    credential: {
      cloudProvider: CloudType.AWS,
      accessKeyId: 'AKIA-ENV',
      secretAccessKey: 'AWS-ENV-SECRET',
    },
    source: 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY',
    review: [
      'Account ID: 123456789012',
      'Identity: arn:aws:iam::123456789012:user/imported',
    ],
    secret: 'AWS-ENV-SECRET',
  },
  {
    provider: 'azure',
    label: 'Azure',
    environment: {
      AZURE_APPLICATION_ID: 'env-app',
      AZURE_SECRET: 'AZURE-ENV-SECRET',
      AZURE_SUBSCRIPTION_ID: 'env-sub',
      AZURE_DIRECTORY_ID: 'env-tenant',
    },
    flags: [
      '--application-id',
      'env-app',
      '--secret',
      'AZURE-ENV-SECRET',
      '--subscription-id',
      'env-sub',
      '--directory-id',
      'env-tenant',
    ],
    credential: {
      cloudProvider: CloudType.Azure,
      applicationId: 'env-app',
      secret: 'AZURE-ENV-SECRET',
      subscriptionId: 'env-sub',
      directoryId: 'env-tenant',
    },
    source: 'Azure environment variables',
    review: [
      'Application ID: env-app',
      'Subscription ID: env-sub',
      'Tenant ID: env-tenant',
    ],
    secret: 'AZURE-ENV-SECRET',
  },
  {
    provider: 'gcp',
    label: 'GCP',
    environment: {
      GCP_PROJECT_ID: 'env-project',
      GCP_CLIENT_EMAIL: 'env@env-project.iam.gserviceaccount.com',
      GCP_PRIVATE_KEY:
        '-----BEGIN PRIVATE KEY-----\nGCP-ENV-SECRET\n-----END PRIVATE KEY-----',
    },
    flags: [
      '--project-id',
      'env-project',
      '--client-email',
      'env@env-project.iam.gserviceaccount.com',
      '--private-key',
      '-----BEGIN PRIVATE KEY-----\nGCP-ENV-SECRET\n-----END PRIVATE KEY-----',
    ],
    credential: {
      cloudProvider: CloudType.GCP,
      projectId: 'env-project',
      clientEmail: 'env@env-project.iam.gserviceaccount.com',
      privateKey:
        '-----BEGIN PRIVATE KEY-----\nGCP-ENV-SECRET\n-----END PRIVATE KEY-----',
    },
    source: 'GCP_PROJECT_ID, GCP_CLIENT_EMAIL, and GCP_PRIVATE_KEY',
    review: [
      'Project ID: env-project',
      'Service account: env@env-project.iam.gserviceaccount.com',
    ],
    secret: 'GCP-ENV-SECRET',
  },
  {
    provider: 'lambda',
    label: 'Lambda Labs',
    environment: { LAMBDA_API_KEY: 'LAMBDA-ENV-SECRET' },
    flags: ['--api-key', 'LAMBDA-ENV-SECRET'],
    credential: {
      cloudProvider: CloudType.Lambda,
      apiKey: 'LAMBDA-ENV-SECRET',
    },
    source: 'LAMBDA_API_KEY',
    review: [],
    secret: 'LAMBDA-ENV-SECRET',
  },
];

function awsProfileSummaries(profileNames: string[]) {
  return profileNames.map((profileName) => ({
    profileName,
    accessKeyId: `AKIA-${profileName.toUpperCase()}`,
  }));
}

describe('buildCredentialsFromOptions', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of ALL_VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of ALL_VARS) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
  });

  it('builds AWS credentials from flags', async () => {
    const creds = await buildCredentialsFromOptions({
      provider: 'aws',
      accessKeyId: 'AKIA-FLAG',
      secretAccessKey: 'SECRET-FLAG',
    });
    expect(creds).toEqual({
      cloudProvider: CloudType.AWS,
      accessKeyId: 'AKIA-FLAG',
      secretAccessKey: 'SECRET-FLAG',
    });
  });

  it.each([
    { profile: 'operator' },
    { accessKeyId: 'AKIA-EXISTING', secretAccessKey: 'SECRET-EXISTING' },
    {},
  ])(
    '0038/S2 rejects an ignored account target during non-interactive import: %j',
    async (fields) => {
      vi.clearAllMocks();
      process.env.AWS_ACCESS_KEY_ID = 'AKIA-ENV';
      process.env.AWS_SECRET_ACCESS_KEY = 'SECRET-ENV';
      await expect(
        buildCredentialsFromOptions({
          provider: 'aws',
          accountId: '999999999999',
          ...fields,
        }),
      ).rejects.toThrow('--account-id only applies to AWS generation');
      expect(resolveAWSProfileSource).not.toHaveBeenCalled();
      expect(validateAWSAccessCredentials).not.toHaveBeenCalled();
    },
  );

  it('normalizes provider case', async () => {
    const creds = await buildCredentialsFromOptions({
      provider: 'AWS',
      accessKeyId: 'AKIA',
      secretAccessKey: 's',
    });
    expect(creds.cloudProvider).toBe(CloudType.AWS);
  });

  it('falls back to env vars when flags are absent', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIA-ENV';
    process.env.AWS_SECRET_ACCESS_KEY = 'SECRET-ENV';
    const creds = await buildCredentialsFromOptions({ provider: 'aws' });
    expect(creds).toEqual({
      cloudProvider: CloudType.AWS,
      accessKeyId: 'AKIA-ENV',
      secretAccessKey: 'SECRET-ENV',
    });
  });

  it('prefers flag over env var (precedence)', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIA-ENV';
    process.env.AWS_SECRET_ACCESS_KEY = 'SECRET-ENV';
    const creds = await buildCredentialsFromOptions({
      provider: 'aws',
      accessKeyId: 'AKIA-FLAG',
    });
    expect(creds).toMatchObject({
      accessKeyId: 'AKIA-FLAG',
      secretAccessKey: 'SECRET-ENV',
    });
  });

  it('imports a durable AWS profile explicitly', async () => {
    vi.mocked(resolveAWSProfileSource).mockResolvedValue({
      kind: 'static',
      credentials: {
        profileName: 'production',
        accessKeyId: 'AKIA-PRODUCTION',
        secretAccessKey: 'SECRET-PRODUCTION',
        region: 'us-gov-west-1',
      },
    });

    await expect(
      buildCredentialsFromOptions({
        provider: 'aws',
        profile: 'production',
      }),
    ).resolves.toEqual({
      cloudProvider: CloudType.AWS,
      accessKeyId: 'AKIA-PRODUCTION',
      secretAccessKey: 'SECRET-PRODUCTION',
    });
  });

  it('returns imported AWS region metadata outside the credential object', async () => {
    vi.mocked(resolveAWSProfileSource).mockResolvedValue({
      kind: 'static',
      credentials: {
        profileName: 'production',
        accessKeyId: 'AKIA-PRODUCTION',
        secretAccessKey: 'SECRET-PRODUCTION',
        region: 'us-gov-west-1',
      },
    });

    const acquired = await acquireCredentialsFromOptions({
      provider: 'aws',
      profile: 'production',
    });

    expect(acquired.metadata).toEqual({ awsRegion: 'us-gov-west-1' });
    expect(acquired.credential).not.toHaveProperty('region');
  });

  it('rejects a profile selector for non-AWS providers', async () => {
    await expect(
      buildCredentialsFromOptions({
        provider: 'azure',
        profile: 'production',
      }),
    ).rejects.toThrow(/--profile.*only.*aws/i);
  });

  it('rejects ambiguous AWS profile and key flags', async () => {
    await expect(
      buildCredentialsFromOptions({
        provider: 'aws',
        profile: 'production',
        accessKeyId: 'AKIA-FLAG',
      }),
    ).rejects.toThrow(/cannot combine --profile.*--access-key-id/i);
  });

  it('rejects temporary environment credentials when either key comes from the environment', async () => {
    process.env.AWS_SECRET_ACCESS_KEY = 'SECRET-TEMPORARY';
    process.env.AWS_SESSION_TOKEN = 'SESSION-TEMPORARY';

    await expect(
      buildCredentialsFromOptions({
        provider: 'aws',
        accessKeyId: 'ASIA-FLAG',
      }),
    ).rejects.toThrow(/temporary AWS session credentials/i);
  });

  it('errors when --provider is missing and ANYCLOUD_CLOUD_PROVIDER not set', async () => {
    await expect(buildCredentialsFromOptions({})).rejects.toThrow(/provider/i);
  });

  it('falls back to ANYCLOUD_CLOUD_PROVIDER when --provider is absent', async () => {
    process.env.ANYCLOUD_CLOUD_PROVIDER = 'lambda';
    process.env.LAMBDA_API_KEY = 'LAMBDA-KEY';
    const creds = await buildCredentialsFromOptions({});
    expect(creds).toEqual({
      cloudProvider: CloudType.Lambda,
      apiKey: 'LAMBDA-KEY',
    });
  });

  it('errors when AWS secret is missing entirely', async () => {
    await expect(
      buildCredentialsFromOptions({
        provider: 'aws',
        accessKeyId: 'AKIA',
      }),
    ).rejects.toThrow(/secret-access-key/);
  });

  it('builds Azure credentials from flags', async () => {
    const creds = await buildCredentialsFromOptions({
      provider: 'azure',
      applicationId: 'app-id',
      secret: 's',
      subscriptionId: 'sub',
      directoryId: 'dir',
    });
    expect(creds).toEqual({
      cloudProvider: CloudType.Azure,
      applicationId: 'app-id',
      secret: 's',
      subscriptionId: 'sub',
      directoryId: 'dir',
    });
  });

  it('builds GCP credentials from inline flags', async () => {
    const creds = await buildCredentialsFromOptions({
      provider: 'gcp',
      projectId: 'proj',
      clientEmail: 'sa@proj.iam.gserviceaccount.com',
      privateKey: '-----BEGIN PRIVATE KEY-----\nfoo\n-----END PRIVATE KEY-----',
    });
    expect(creds).toMatchObject({
      cloudProvider: CloudType.GCP,
      projectId: 'proj',
      clientEmail: 'sa@proj.iam.gserviceaccount.com',
    });
  });

  it('builds Lambda credentials from flag', async () => {
    const creds = await buildCredentialsFromOptions({
      provider: 'lambda',
      apiKey: 'LAMBDA-KEY',
    });
    expect(creds).toEqual({
      cloudProvider: CloudType.Lambda,
      apiKey: 'LAMBDA-KEY',
    });
  });

  it('builds Cloudflare credentials from flags, reusing --account-id', async () => {
    const creds = await buildCredentialsFromOptions({
      provider: 'cloudflare',
      accountId: 'cf-account',
      apiToken: 'cf-token',
      jurisdiction: 'eu',
    });
    expect(creds).toEqual({
      cloudProvider: CloudType.Cloudflare,
      accountId: 'cf-account',
      apiToken: 'cf-token',
      jurisdiction: 'eu',
    });
  });

  it('falls back to the Cloudflare environment when --provider cloudflare is explicit', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'cf-env-account';
    process.env.CLOUDFLARE_API_TOKEN = 'cf-env-token';
    await expect(
      buildCredentialsFromOptions({ provider: 'cloudflare' }),
    ).resolves.toEqual({
      cloudProvider: CloudType.Cloudflare,
      accountId: 'cf-env-account',
      apiToken: 'cf-env-token',
    });
  });

  it('rejects --jurisdiction outside Cloudflare', async () => {
    await expect(
      buildCredentialsFromOptions({
        provider: 'aws',
        accessKeyId: 'AKIA-FLAG',
        secretAccessKey: 'SECRET-FLAG',
        jurisdiction: 'eu',
      }),
    ).rejects.toThrow(
      '--jurisdiction is only supported with --provider cloudflare',
    );
  });

  it('errors on invalid cloud value', async () => {
    await expect(
      buildCredentialsFromOptions({ provider: 'oracle' }),
    ).rejects.toThrow(/invalid.*cloud/i);
  });
});

describe('buildAzureGeneratedCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAzureGenerationPreview).mockImplementation(
      async (subscriptionId) => ({
        subscriptionId,
        tenantId: 'tenant-generated',
        scope: `/subscriptions/${subscriptionId}`,
        roles: ['Contributor'],
      }),
    );
  });

  it.each(['aws', 'gcp', 'lambda'])(
    'rejects %s generation before consulting the Azure CLI',
    async (provider) => {
      await expect(
        buildAzureGeneratedCredentials('generated', {
          provider,
          generate: true,
        }),
      ).rejects.toThrow(/--generate is only supported with --provider azure/i);
      expect(isAzureCLIInstalled).not.toHaveBeenCalled();
      expect(generateAzureServicePrincipal).not.toHaveBeenCalled();
    },
  );

  it('generates Azure credentials for an explicit subscription without prompts', async () => {
    vi.mocked(isAzureCLIInstalled).mockResolvedValue(true);
    vi.mocked(isAzureCLILoggedIn).mockResolvedValue(true);
    vi.mocked(generateAzureServicePrincipal).mockResolvedValue({
      applicationId: 'app-generated',
      secret: 'generated-secret',
      tenantId: 'tenant-generated',
      secretExpiresAt: '2028-08-13T15:00:00Z',
    });

    await expect(
      buildAzureGeneratedCredentials('generated', {
        provider: 'azure',
        generate: true,
        subscriptionId: 'sub-generated',
      }),
    ).resolves.toEqual({
      cloudProvider: CloudType.Azure,
      applicationId: 'app-generated',
      secret: 'generated-secret',
      subscriptionId: 'sub-generated',
      directoryId: 'tenant-generated',
    });
    expect(safePrompts).not.toHaveBeenCalled();
    expect(getAzureGenerationPreview).toHaveBeenCalledWith('sub-generated');
    expect(generateAzureServicePrincipal).toHaveBeenCalledWith(
      'sub-generated',
      'generated',
    );
    expect(printInfo).toHaveBeenCalledWith('Roles: Contributor');
    expect(printInfo).toHaveBeenCalledWith(
      expect.stringMatching(/required operator access.*assign that role/i),
    );
    expect(printInfo).toHaveBeenCalledWith(
      'Secret expires: 2028-08-13T15:00:00Z',
    );
  });

  it('uses the active Azure subscription when no selector is passed', async () => {
    vi.mocked(isAzureCLIInstalled).mockResolvedValue(true);
    vi.mocked(isAzureCLILoggedIn).mockResolvedValue(true);
    vi.mocked(getCurrentAzureSubscription).mockResolvedValue({
      id: 'sub-active',
      tenantId: 'tenant-active',
    });
    vi.mocked(generateAzureServicePrincipal).mockResolvedValue({
      applicationId: 'app-generated',
      secret: 'generated-secret',
      tenantId: 'tenant-active',
    });

    await buildAzureGeneratedCredentials('generated', {
      provider: 'azure',
      generate: true,
    });

    expect(getAzureGenerationPreview).toHaveBeenCalledWith('sub-active');
    expect(generateAzureServicePrincipal).toHaveBeenCalledWith(
      'sub-active',
      'generated',
    );
  });

  it('rejects credential material while allowing the subscription selector', async () => {
    expect(() =>
      validateAzureGenerationSelection('generated', {
        provider: 'azure',
        generate: true,
        subscriptionId: 'sub-generated',
        applicationId: 'existing-app',
      }),
    ).toThrow(/--generate.*--application-id/i);
    expect(generateAzureServicePrincipal).not.toHaveBeenCalled();
  });

  it.each([
    [{ projectId: 'wrong-project' }, /--project-id/i],
    [{ profile: 'wrong-profile' }, /--profile/i],
  ])('rejects selectors outside Azure generation', (selector, message) => {
    expect(() =>
      validateAzureGenerationSelection('generated', {
        provider: 'azure',
        generate: true,
        ...selector,
      }),
    ).toThrow(message);
    expect(generateAzureServicePrincipal).not.toHaveBeenCalled();
  });

  it('rejects overwrite before calling the Azure CLI', () => {
    expect(() =>
      validateAzureGenerationSelection('generated', {
        provider: 'azure',
        generate: true,
        overwrite: true,
      }),
    ).toThrow(/--generate.*--overwrite/i);
    expect(isAzureCLIInstalled).not.toHaveBeenCalled();
    expect(generateAzureServicePrincipal).not.toHaveBeenCalled();
  });

  it.each([
    ['x'.repeat(248), /Azure application/i],
    ['invalid\nname', /Azure application/i],
  ])('rejects invalid generated Azure names locally', (name, message) => {
    expect(() =>
      validateAzureGenerationSelection(name, {
        provider: 'azure',
        generate: true,
      }),
    ).toThrow(message);
  });

  it('returns generated credentials with an explicit lifecycle lease', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    vi.mocked(isAzureCLIInstalled).mockResolvedValue(true);
    vi.mocked(isAzureCLILoggedIn).mockResolvedValue(true);
    vi.mocked(generateAzureServicePrincipal).mockResolvedValue({
      applicationId: 'app-leased',
      secret: 'leased-secret',
      tenantId: 'tenant-generated',
      cleanup,
    });

    const acquired = await acquireAzureGeneratedCredentials('leased', {
      provider: 'azure',
      generate: true,
      subscriptionId: 'sub-generated',
    });

    expect(acquired.lease?.credential).toBe(acquired.credential);
    expect(acquired.lease?.state).toBe('pending');
    await acquired.lease?.rollback();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
describe('credentials new command', () => {
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(safePrompts).mockReset();
    vi.mocked(isAWSCLIInstalled).mockResolvedValue(false);
    vi.mocked(listImportableAWSProfileSummaries).mockResolvedValue([]);
    vi.mocked(getAllServiceAccountKeyPaths).mockResolvedValue([]);
    for (const name of ALL_VARS) vi.stubEnv(name, undefined);
    vi.mocked(shouldAllowPrompts).mockReturnValue(false);
    vi.mocked(listApiCredentials).mockReset().mockResolvedValue([]);
    vi.mocked(saveApiCredential).mockReset().mockResolvedValue(undefined);
    vi.mocked(validateAWSAccessCredentials).mockResolvedValue({
      account: '123456789012',
      arn: 'arn:aws:iam::123456789012:user/imported',
      userId: 'AIDAIMPORTED',
    });
    vi.mocked(getAzureGenerationPreview).mockImplementation(
      async (subscriptionId) => ({
        subscriptionId,
        tenantId: 'tenant-command',
        scope: `/subscriptions/${subscriptionId}`,
        roles: ['Contributor'],
      }),
    );
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    exitSpy.mockRestore();
  });

  it('generates and saves Azure credentials in a non-interactive process', async () => {
    vi.mocked(isAzureCLIInstalled).mockResolvedValue(true);
    vi.mocked(isAzureCLILoggedIn).mockResolvedValue(true);
    vi.mocked(generateAzureServicePrincipal).mockResolvedValue({
      applicationId: 'app-command',
      secret: 'secret-command',
      tenantId: 'tenant-command',
    });
    const command = createNewCommand().exitOverride();

    await command.parseAsync(
      [
        'command',
        '--provider',
        'azure',
        '--generate',
        '--subscription-id',
        'sub-command',
      ],
      { from: 'user' },
    );

    expect(shouldAllowPrompts).toHaveBeenCalled();
    expect(generateAzureServicePrincipal).toHaveBeenCalledWith(
      'sub-command',
      'command',
    );
    expect(saveApiCredential).toHaveBeenCalledWith(
      {
        params: { name: 'command' },
        query: { overwrite: 'false' },
        body: {
          cloudProvider: CloudType.Azure,
          applicationId: 'app-command',
          secret: 'secret-command',
          subscriptionId: 'sub-command',
          directoryId: 'tenant-command',
        },
      },
      { context: { retry: 0 } },
    );
  });

  // Guard: generation creates cloud identities, so it must stop on a missing
  // local API token before any provider call.
  it.each([
    ['aws', '--profile', 'operator', '--account-id', '123456789012'],
    [
      'gcp',
      '--gcloud-account',
      'operator@example.com',
      '--project-id',
      'selected-project',
    ],
    ['azure', '--subscription-id', 'sub-command'],
  ])(
    'creates nothing in %s without a local API token',
    async (provider, ...flags) => {
      mockAWSGeneration();
      mockGCPGeneration();
      vi.mocked(isAzureCLIInstalled).mockResolvedValue(true);
      vi.mocked(isAzureCLILoggedIn).mockResolvedValue(true);
      vi.mocked(apiClient).mockImplementationOnce(() => process.exit(1));

      await expect(
        createNewCommand()
          .exitOverride()
          .parseAsync(
            ['guard', '--provider', provider, '--generate', ...flags],
            {
              from: 'user',
            },
          ),
      ).rejects.toThrow('process.exit:1');

      expect(apiClient).toHaveBeenCalledTimes(1);
      expect(getAWSGenerationPreview).not.toHaveBeenCalled();
      expect(generateAWSCredentials).not.toHaveBeenCalled();
      expect(getGCPGenerationPreview).not.toHaveBeenCalled();
      expect(generateGCPCredentials).not.toHaveBeenCalled();
      expect(generateAzureServicePrincipal).not.toHaveBeenCalled();
    },
  );

  it.each(['aws', 'gcp'])(
    'rejects incomplete or unsupported %s generation before API or provider access',
    async (provider) => {
      const command = createNewCommand().exitOverride();

      await expect(
        command.parseAsync(
          ['unsupported', '--provider', provider, '--generate'],
          { from: 'user' },
        ),
      ).rejects.toThrow(/process\.exit:1/);

      expect(apiClient).not.toHaveBeenCalled();
      expect(listApiCredentials).not.toHaveBeenCalled();
      expect(isAzureCLIInstalled).not.toHaveBeenCalled();
      expect(generateAzureServicePrincipal).not.toHaveBeenCalled();
      expect(printError).toHaveBeenCalledWith(
        expect.stringMatching(
          provider === 'aws'
            ? /AWS --generate requires --profile and --account-id/
            : /GCP --generate requires --gcloud-account and --project-id/i,
        ),
      );
    },
  );

  it.each(['confirmed', 'rejected', 'uncertain'])(
    '0038/S3 uses the normal save lease for GCP (%s)',
    async (outcome) => {
      const { generated, cleanup } = mockGCPGeneration();
      if (outcome === 'rejected')
        saveApiCredential.mockRejectedValueOnce(
          testHttpError(400, 'Invalid save'),
        );
      if (outcome === 'uncertain') {
        saveApiCredential.mockRejectedValueOnce(new Error('Response lost'));
        listApiCredentials.mockResolvedValueOnce([]).mockResolvedValueOnce([
          {
            name: 'test-gcp',
            cloudProvider: CloudType.GCP,
            projectId: generated.projectId,
            clientEmail: generated.clientEmail,
          },
        ]);
      }
      const pending = createNewCommand()
        .exitOverride()
        .parseAsync(
          [
            'test-gcp',
            '--provider',
            'gcp',
            '--generate',
            '--gcloud-account',
            'operator@example.com',
            '--project-id',
            'selected-project',
          ],
          { from: 'user' },
        );
      if (outcome === 'confirmed') await pending;
      else await expect(pending).rejects.toThrow('process.exit:1');
      expect(saveApiCredential).toHaveBeenCalledExactlyOnceWith(
        {
          params: { name: 'test-gcp' },
          query: { overwrite: 'false' },
          body: {
            cloudProvider: CloudType.GCP,
            projectId: generated.projectId,
            clientEmail: generated.clientEmail,
            privateKey: generated.privateKey,
          },
        },
        { context: { retry: 0 } },
      );
      expect(cleanup).toHaveBeenCalledTimes(outcome === 'rejected' ? 1 : 0);
      expect(safePrompts).not.toHaveBeenCalled();
      expect(JSON.stringify(vi.mocked(printInfo).mock.calls)).not.toContain(
        generated.privateKey,
      );
    },
  );

  it.each([false, true])(
    'explicitly replaces imported credentials only with --overwrite (interactive: %s)',
    async (interactive) => {
      vi.mocked(shouldAllowPrompts).mockReturnValue(interactive);
      const command = createNewCommand().exitOverride();

      await command.parseAsync(
        [
          'command',
          '--provider',
          'aws',
          '--access-key-id',
          'AKIAREPLACEMENT',
          '--secret-access-key',
          'replacement-secret',
          '--overwrite',
        ],
        { from: 'user' },
      );

      expect(listApiCredentials).not.toHaveBeenCalled();
      expect(validateAWSAccessCredentials).toHaveBeenCalledWith({
        accessKeyId: 'AKIAREPLACEMENT',
        secretAccessKey: 'replacement-secret',
      });
      expect(saveApiCredential).toHaveBeenCalledWith(
        {
          params: { name: 'command' },
          query: { overwrite: 'true' },
          body: {
            cloudProvider: CloudType.AWS,
            accessKeyId: 'AKIAREPLACEMENT',
            secretAccessKey: 'replacement-secret',
          },
        },
        undefined,
      );
      expect(safePrompts).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'imports and validates an explicit AWS profile without confirmation (interactive: %s)',
    async (interactive) => {
      vi.mocked(shouldAllowPrompts).mockReturnValue(interactive);
      vi.mocked(resolveAWSProfileSource).mockResolvedValue({
        kind: 'static',
        credentials: {
          profileName: 'production',
          accessKeyId: 'AKIA-PRODUCTION',
          secretAccessKey: 'SECRET-PRODUCTION',
          region: 'us-gov-west-1',
        },
      });
      const command = createNewCommand().exitOverride();

      await command.parseAsync(
        ['profile-import', '--provider', 'aws', '--profile', 'production'],
        { from: 'user' },
      );

      expect(validateAWSAccessCredentials).toHaveBeenCalledWith(
        {
          accessKeyId: 'AKIA-PRODUCTION',
          secretAccessKey: 'SECRET-PRODUCTION',
        },
        'us-gov-west-1',
      );
      expect(saveApiCredential).toHaveBeenCalledWith(
        {
          params: { name: 'profile-import' },
          query: { overwrite: 'false' },
          body: {
            cloudProvider: CloudType.AWS,
            accessKeyId: 'AKIA-PRODUCTION',
            secretAccessKey: 'SECRET-PRODUCTION',
          },
        },
        undefined,
      );
      expect(safePrompts).not.toHaveBeenCalled();
    },
  );

  it.each([true, false, undefined])(
    'requires source selection and root-identity review before saving a sole profile (consent: %s)',
    async (confirmed) => {
      vi.mocked(shouldAllowPrompts).mockReturnValue(true);
      vi.mocked(listImportableAWSProfileSummaries).mockResolvedValue(
        awsProfileSummaries(['default']),
      );
      vi.mocked(resolveAWSProfileSource).mockResolvedValue({
        kind: 'static',
        credentials: {
          profileName: 'default',
          accessKeyId: 'AKIA-ROOT',
          secretAccessKey: 'SECRET-ROOT',
          region: 'us-west-2',
        },
      });
      vi.mocked(validateAWSAccessCredentials).mockResolvedValue({
        account: '123456789012',
        arn: 'arn:aws:iam::123456789012:root',
        userId: '123456789012',
      });
      vi.mocked(safePrompts)
        .mockImplementationOnce(async () => {
          expect(resolveAWSProfileSource).not.toHaveBeenCalled();
          expect(validateAWSAccessCredentials).not.toHaveBeenCalled();
          expect(saveApiCredential).not.toHaveBeenCalled();
          return { value: 'aws-profile:default' };
        })
        .mockImplementationOnce(async () => {
          expect(validateAWSAccessCredentials).toHaveBeenCalledExactlyOnceWith(
            { accessKeyId: 'AKIA-ROOT', secretAccessKey: 'SECRET-ROOT' },
            'us-west-2',
          );
          expect(printInfo).toHaveBeenCalledWith(
            'Source: AWS profile "default"',
          );
          expect(printInfo).toHaveBeenCalledWith('Account ID: 123456789012');
          expect(printInfo).toHaveBeenCalledWith(
            'Identity: arn:aws:iam::123456789012:root',
          );
          expect(saveApiCredential).not.toHaveBeenCalled();
          return { confirmed };
        });

      await createNewCommand().parseAsync(['reviewed', '--provider', 'aws'], {
        from: 'user',
      });

      expect(safePrompts).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          type: 'confirm',
          message: 'Save these AWS credentials as "reviewed"?',
          initial: true,
        }),
      );
      expect(saveApiCredential).toHaveBeenCalledTimes(confirmed ? 1 : 0);
      expect(printError).not.toHaveBeenCalled();
      expect(JSON.stringify(vi.mocked(printInfo).mock.calls)).not.toContain(
        'SECRET-ROOT',
      );
    },
  );

  it('keeps environment imports selectable when AWS profile discovery fails', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIA-ENV');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'SECRET-ENV');
    vi.mocked(isAWSCLIInstalled).mockResolvedValue(true);
    vi.mocked(listImportableAWSProfileSummaries).mockRejectedValueOnce(
      new Error('profile inventory unreadable'),
    );
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ value: 'environment' })
      .mockImplementationOnce(async () => {
        expect(saveApiCredential).not.toHaveBeenCalled();
        return { confirmed: true };
      });

    await createNewCommand().parseAsync(['environment', '--provider', 'aws'], {
      from: 'user',
    });

    expect(printWarning).toHaveBeenCalledWith(
      'Could not discover AWS profiles: profile inventory unreadable',
    );
    expect(safePrompts).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        choices: ['environment', 'enter', 'create', 'admin'].map((value) =>
          expect.objectContaining({ value }),
        ),
      }),
    );
    expect(safePrompts).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: 'confirm', initial: true }),
    );
    expect(validateAWSAccessCredentials).toHaveBeenCalledExactlyOnceWith({
      accessKeyId: 'AKIA-ENV',
      secretAccessKey: 'SECRET-ENV',
    });
    expect(saveApiCredential).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        body: {
          cloudProvider: CloudType.AWS,
          accessKeyId: 'AKIA-ENV',
          secretAccessKey: 'SECRET-ENV',
        },
      }),
      undefined,
    );
  });

  describe.each(IMPORT_CASES)('$label shared import consent', (testCase) => {
    it.each([true, false, undefined])(
      'reviews the selected source before persistence (consent: %s)',
      async (confirmed) => {
        vi.mocked(shouldAllowPrompts).mockReturnValue(true);
        for (const [name, value] of Object.entries(testCase.environment))
          vi.stubEnv(name, value);
        vi.mocked(safePrompts)
          .mockImplementationOnce(async () => {
            expect(saveApiCredential).not.toHaveBeenCalled();
            expect(validateAWSAccessCredentials).not.toHaveBeenCalled();
            expect(prepareGCPServiceAccountKeyImport).not.toHaveBeenCalled();
            return { value: 'environment' };
          })
          .mockImplementationOnce(async () => {
            for (const line of [
              `Provider: ${testCase.label}`,
              'Credential name: shared-review',
              `Source: ${testCase.source}`,
              ...testCase.review,
            ])
              expect(printInfo).toHaveBeenCalledWith(line);
            expect(saveApiCredential).not.toHaveBeenCalled();
            return { confirmed };
          });

        await createNewCommand().parseAsync(
          ['shared-review', '--provider', testCase.provider],
          { from: 'user' },
        );

        expect(safePrompts).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            type: 'select',
            initial: 0,
            message: `How would you like to add ${testCase.label} credentials?`,
          }),
        );
        expect(safePrompts).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            type: 'confirm',
            initial: true,
            message: `Save these ${testCase.label} credentials as "shared-review"?`,
          }),
        );
        if (confirmed) {
          expect(saveApiCredential).toHaveBeenCalledExactlyOnceWith(
            {
              params: { name: 'shared-review' },
              query: { overwrite: 'false' },
              body: testCase.credential,
            },
            undefined,
          );
        } else {
          expect(saveApiCredential).not.toHaveBeenCalled();
        }
        expect(printError).not.toHaveBeenCalled();
        expect(
          [
            ...vi.mocked(printInfo).mock.calls,
            ...vi.mocked(printSuccess).mock.calls,
          ]
            .flat()
            .join('\n'),
        ).not.toContain(testCase.secret);
        expect(JSON.stringify(vi.mocked(safePrompts).mock.calls)).not.toContain(
          testCase.secret,
        );
        if (testCase.provider !== 'aws') {
          expect(validateAWSAccessCredentials).not.toHaveBeenCalled();
          expect(printSuccess).not.toHaveBeenCalledWith(
            expect.stringContaining('authenticated'),
          );
        }
      },
    );

    it('cancels at source selection before acquisition', async () => {
      for (const [name, value] of Object.entries(testCase.environment))
        vi.stubEnv(name, value);
      vi.mocked(safePrompts).mockResolvedValueOnce({});
      await expect(
        acquireCredentialsInteractive('cancel-source', {
          provider: testCase.provider,
        }),
      ).rejects.toThrow('process.exit:0');
      expect(validateAWSAccessCredentials).not.toHaveBeenCalled();
      expect(prepareGCPServiceAccountKeyImport).not.toHaveBeenCalled();
      expect(saveApiCredential).not.toHaveBeenCalled();
    });

    it.each([true, false])(
      'keeps complete credential flags prompt-free (interactive: %s)',
      async (interactive) => {
        vi.mocked(shouldAllowPrompts).mockReturnValue(interactive);
        await createNewCommand().parseAsync(
          ['explicit', '--provider', testCase.provider, ...testCase.flags],
          { from: 'user' },
        );
        expect(saveApiCredential).toHaveBeenCalledExactlyOnceWith(
          {
            params: { name: 'explicit' },
            query: { overwrite: 'false' },
            body: testCase.credential,
          },
          undefined,
        );
        expect(safePrompts).not.toHaveBeenCalled();
        expect(listImportableAWSProfileSummaries).not.toHaveBeenCalled();
        expect(getAllServiceAccountKeyPaths).not.toHaveBeenCalled();
      },
    );

    it('keeps noninteractive environment credentials prompt-free', async () => {
      for (const [name, value] of Object.entries(testCase.environment))
        vi.stubEnv(name, value);
      await createNewCommand().parseAsync(
        ['automation', '--provider', testCase.provider],
        { from: 'user' },
      );
      expect(saveApiCredential).toHaveBeenCalledExactlyOnceWith(
        {
          params: { name: 'automation' },
          query: { overwrite: 'false' },
          body: testCase.credential,
        },
        undefined,
      );
      expect(safePrompts).not.toHaveBeenCalled();
    });
  });

  it.each([true, false, undefined])(
    'defers the prepared GCP key copy until approval (consent: %s)',
    async (confirmed) => {
      vi.mocked(shouldAllowPrompts).mockReturnValue(true);
      const persist = vi.fn().mockResolvedValue(undefined);
      vi.mocked(prepareGCPServiceAccountKeyImport).mockResolvedValue({
        projectId: 'upload-project',
        clientEmail: 'upload@upload-project.iam.gserviceaccount.com',
        privateKey:
          '-----BEGIN PRIVATE KEY-----\nUPLOADED-SECRET\n-----END PRIVATE KEY-----',
        keyFilePath: '/anycloud/anycloud-imported-key.json',
        persist,
      });
      vi.mocked(safePrompts)
        .mockResolvedValueOnce({ value: 'upload' })
        .mockResolvedValueOnce({ value: '/keys/imported-key.json' })
        .mockImplementationOnce(async () => {
          expect(printInfo).toHaveBeenCalledWith(
            'Source: Service-account key file: /keys/imported-key.json',
          );
          expect(printInfo).toHaveBeenCalledWith('Project ID: upload-project');
          expect(persist).not.toHaveBeenCalled();
          expect(saveApiCredential).not.toHaveBeenCalled();
          return { confirmed };
        });
      vi.mocked(saveApiCredential).mockImplementationOnce(async () => {
        expect(persist).toHaveBeenCalledOnce();
      });

      await createNewCommand().parseAsync(['gcp-upload', '--provider', 'gcp'], {
        from: 'user',
      });

      expect(persist).toHaveBeenCalledTimes(confirmed ? 1 : 0);
      expect(saveApiCredential).toHaveBeenCalledTimes(confirmed ? 1 : 0);
      expect(vi.mocked(printInfo).mock.calls.flat().join('\n')).not.toContain(
        'UPLOADED-SECRET',
      );
    },
  );

  it('does not save when an approved local import cannot be persisted', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(prepareGCPServiceAccountKeyImport).mockResolvedValue({
      projectId: 'upload-project',
      clientEmail: 'upload@upload-project.iam.gserviceaccount.com',
      privateKey: 'private-key',
      keyFilePath: '/anycloud/key.json',
      persist: vi
        .fn()
        .mockRejectedValue(new Error('Cannot write imported key')),
    });
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ value: 'upload' })
      .mockResolvedValueOnce({ value: '/keys/key.json' })
      .mockResolvedValueOnce({ confirmed: true });

    await expect(
      createNewCommand().parseAsync(['failed-copy', '--provider', 'gcp'], {
        from: 'user',
      }),
    ).rejects.toThrow('process.exit:1');
    expect(saveApiCredential).not.toHaveBeenCalled();
    expect(printError).toHaveBeenCalledWith(
      'Failed to add credentials: Cannot write imported key',
    );
  });

  it.each([
    { outcome: 'saved', save: () => Promise.resolve(undefined) },
    {
      outcome: 'rejected',
      save: () => Promise.reject(new Error('API unavailable')),
    },
  ])(
    'shows a saving spinner until the save is $outcome',
    async ({ outcome, save }) => {
      vi.mocked(shouldAllowPrompts).mockReturnValue(true);
      vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIA-ENV');
      vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'SECRET-ENV');
      Object.values(spinnerMock).forEach((mock) => mock.mockReset());
      vi.mocked(safePrompts)
        .mockResolvedValueOnce({ value: 'environment' })
        .mockResolvedValueOnce({ confirmed: true });
      vi.mocked(saveApiCredential).mockImplementation(() => {
        expect(createSpinner).toHaveBeenLastCalledWith(
          'Saving credentials "spinner"...',
        );
        expect(spinnerMock.stop).not.toHaveBeenCalled();
        return save();
      });

      const pending = createNewCommand().parseAsync(
        ['spinner', '--provider', 'aws'],
        { from: 'user' },
      );
      if (outcome === 'saved') {
        await pending;
        expect(printSuccess).toHaveBeenCalledWith(
          'Credentials "spinner" saved successfully!',
        );
      } else {
        await expect(pending).rejects.toThrow('process.exit:1');
        expect(printError).toHaveBeenCalledWith(
          'Failed to add credentials: API unavailable',
        );
      }
      expect(saveApiCredential).toHaveBeenCalledOnce();
      expect(spinnerMock.stop).toHaveBeenCalledOnce();
    },
  );

  it('does not offer save confirmation when a selected profile fails authentication', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(listImportableAWSProfileSummaries).mockResolvedValue(
      awsProfileSummaries(['default']),
    );
    vi.mocked(resolveAWSProfileSource).mockResolvedValue({
      kind: 'static',
      credentials: {
        profileName: 'default',
        accessKeyId: 'AKIA-INVALID',
        secretAccessKey: 'SECRET-INVALID',
      },
    });
    vi.mocked(safePrompts).mockResolvedValueOnce({
      value: 'aws-profile:default',
    });
    vi.mocked(validateAWSAccessCredentials).mockRejectedValue(
      new Error('AWS credentials could not be authenticated'),
    );

    await expect(
      createNewCommand().parseAsync(['invalid', '--provider', 'aws'], {
        from: 'user',
      }),
    ).rejects.toThrow('process.exit:1');

    expect(safePrompts).toHaveBeenCalledOnce();
    expect(saveApiCredential).not.toHaveBeenCalled();
  });

  it('requires confirmation after completing partial key flags from the environment', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'SECRET-ENV');
    vi.mocked(safePrompts).mockResolvedValueOnce({ confirmed: false });

    await createNewCommand().parseAsync(
      ['partial', '--provider', 'aws', '--access-key-id', 'AKIA-FLAG'],
      { from: 'user' },
    );

    expect(validateAWSAccessCredentials).toHaveBeenCalledExactlyOnceWith({
      accessKeyId: 'AKIA-FLAG',
      secretAccessKey: 'SECRET-ENV',
    });
    expect(safePrompts).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: 'confirm', initial: true }),
    );
    expect(saveApiCredential).not.toHaveBeenCalled();
    expect(listImportableAWSProfileSummaries).not.toHaveBeenCalled();
  });

  it('completes partial Azure flags and reviews the combined fields before saving', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.stubEnv('AZURE_SECRET', 'partial-azure-secret');
    vi.stubEnv('AZURE_SUBSCRIPTION_ID', 'partial-subscription');
    vi.stubEnv('AZURE_DIRECTORY_ID', 'partial-tenant');
    vi.mocked(safePrompts).mockImplementationOnce(async () => {
      expect(printInfo).toHaveBeenCalledWith('Application ID: explicit-app');
      expect(printInfo).toHaveBeenCalledWith('Tenant ID: partial-tenant');
      expect(saveApiCredential).not.toHaveBeenCalled();
      return { confirmed: true };
    });
    await createNewCommand().parseAsync(
      [
        'partial-azure',
        '--provider',
        'azure',
        '--application-id',
        'explicit-app',
      ],
      { from: 'user' },
    );
    expect(safePrompts).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: 'confirm', initial: true }),
    );
    expect(saveApiCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          cloudProvider: CloudType.Azure,
          applicationId: 'explicit-app',
          secret: 'partial-azure-secret',
          subscriptionId: 'partial-subscription',
          directoryId: 'partial-tenant',
        },
      }),
      undefined,
    );
  });

  it('offers Azure environment credentials completed by a subscription flag', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.stubEnv('AZURE_APPLICATION_ID', 'environment-app');
    vi.stubEnv('AZURE_SECRET', 'environment-secret');
    vi.stubEnv('AZURE_DIRECTORY_ID', 'environment-tenant');
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ value: 'environment' })
      .mockImplementationOnce(async () => {
        expect(printInfo).toHaveBeenCalledWith('Subscription ID: flag-sub');
        expect(saveApiCredential).not.toHaveBeenCalled();
        return { confirmed: true };
      });

    await createNewCommand().parseAsync(
      ['mixed-azure', '--provider', 'azure', '--subscription-id', 'flag-sub'],
      { from: 'user' },
    );

    expect(safePrompts).toHaveBeenCalledTimes(2);
    expect(safePrompts).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: 'confirm', initial: true }),
    );
    expect(saveApiCredential).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        body: {
          cloudProvider: CloudType.Azure,
          applicationId: 'environment-app',
          secret: 'environment-secret',
          subscriptionId: 'flag-sub',
          directoryId: 'environment-tenant',
        },
      }),
      undefined,
    );
  });

  it('does not save AWS keys that fail exact-key authentication', async () => {
    vi.mocked(validateAWSAccessCredentials).mockRejectedValue(
      new Error('AWS credentials could not be authenticated'),
    );
    const command = createNewCommand().exitOverride();

    await expect(
      command.parseAsync(
        [
          'invalid',
          '--provider',
          'aws',
          '--access-key-id',
          'AKIA-INVALID',
          '--secret-access-key',
          'invalid-secret',
        ],
        { from: 'user' },
      ),
    ).rejects.toThrow(/process\.exit:1/);

    expect(saveApiCredential).not.toHaveBeenCalled();
  });

  it('checks for a duplicate Azure name before creating cloud resources', async () => {
    vi.mocked(listApiCredentials).mockResolvedValue([
      { name: 'duplicate', cloudProvider: CloudType.Azure },
    ]);
    const command = createNewCommand().exitOverride();

    await expect(
      command.parseAsync(
        [
          'duplicate',
          '--provider',
          'azure',
          '--generate',
          '--subscription-id',
          'sub-duplicate',
        ],
        { from: 'user' },
      ),
    ).rejects.toThrow(/process\.exit:1/);

    expect(generateAzureServicePrincipal).not.toHaveBeenCalled();
    expect(saveApiCredential).not.toHaveBeenCalled();
  });
});
describe('buildCredentialsInteractive', () => {
  let exitSpy: MockInstance<typeof process.exit>;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(safePrompts).mockReset();
    vi.mocked(isAWSCLIInstalled).mockResolvedValue(false);
    Object.values(spinnerMock).forEach((mock) => mock.mockReset());
    vi.mocked(listImportableAWSProfileSummaries).mockResolvedValue([]);
    vi.mocked(getAllServiceAccountKeyPaths).mockResolvedValue([]);
    vi.mocked(readServiceAccountKeySummary).mockResolvedValue({
      projectId: 'discovered-project',
      clientEmail: 'service@discovered-project.iam.gserviceaccount.com',
    });
    vi.mocked(resolveAWSProfileSource).mockImplementation(
      async (profileName) => ({
        kind: 'missing',
        profileName,
      }),
    );
    for (const name of ALL_VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
  });

  afterEach(() => {
    for (const name of ALL_VARS) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
    exitSpy.mockRestore();
  });

  it('AWS: short-circuits prompts when both flags are present', async () => {
    const creds = await buildCredentialsInteractive('my-aws', {
      provider: 'aws',
      accessKeyId: 'AKIA-X',
      secretAccessKey: 'SECRET-Y',
    });
    expect(creds).toEqual({
      cloudProvider: CloudType.AWS,
      accessKeyId: 'AKIA-X',
      secretAccessKey: 'SECRET-Y',
    });
    expect(safePrompts).not.toHaveBeenCalled();
  });

  it.each([
    'profile',
    'environment profile',
    'discovered profile',
    'inline',
    'manual',
  ])(
    '0038/S2 rejects an ignored account target during interactive %s acquisition',
    async (source) => {
      vi.mocked(isAWSCLIInstalled).mockResolvedValue(false);
      if (source === 'environment profile') process.env.AWS_PROFILE = 'work';
      const choosesProfile =
        source === 'discovered profile' || source === 'environment profile';
      if (choosesProfile) {
        vi.mocked(listImportableAWSProfileSummaries).mockResolvedValue(
          awsProfileSummaries(['work']),
        );
        vi.mocked(safePrompts).mockResolvedValueOnce({
          value: 'aws-profile:work',
        });
      }
      if (source === 'manual')
        vi.mocked(safePrompts).mockResolvedValueOnce({ value: 'enter' });
      await expect(
        buildCredentialsInteractive('account-target', {
          provider: 'aws',
          accountId: '999999999999',
          ...(source === 'profile' ? { profile: 'work' } : {}),
          ...(source === 'inline'
            ? {
                accessKeyId: 'AKIA-EXISTING',
                secretAccessKey: 'SECRET-EXISTING',
              }
            : {}),
        }),
      ).rejects.toThrow('--account-id only applies to AWS generation');
      expect(resolveAWSProfileSource).not.toHaveBeenCalled();
      expect(validateAWSAccessCredentials).not.toHaveBeenCalled();
      expect(safePrompts).toHaveBeenCalledTimes(
        choosesProfile || source === 'manual' ? 1 : 0,
      );
    },
  );

  it('AWS: combines explicit and environment keys before profile discovery', async () => {
    process.env.AWS_SECRET_ACCESS_KEY = 'SECRET-ENV';
    vi.mocked(listImportableAWSProfileSummaries).mockResolvedValue(
      awsProfileSummaries(['work']),
    );

    await expect(
      acquireCredentialsInteractive('my-aws', {
        provider: 'aws',
        accessKeyId: 'AKIA-FLAG',
      }),
    ).resolves.toEqual({
      credential: {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIA-FLAG',
        secretAccessKey: 'SECRET-ENV',
      },
      metadata: { importConfirmationSource: 'Provided access keys' },
    });
    expect(listImportableAWSProfileSummaries).not.toHaveBeenCalled();
    expect(safePrompts).not.toHaveBeenCalled();
  });

  it('AWS: prompts for a missing explicit key field before profile discovery', async () => {
    vi.mocked(listImportableAWSProfileSummaries).mockResolvedValue(
      awsProfileSummaries(['work']),
    );
    vi.mocked(safePrompts).mockResolvedValueOnce({ value: 'SECRET-PROMPTED' });

    await expect(
      buildCredentialsInteractive('my-aws', {
        provider: 'aws',
        accessKeyId: 'AKIA-FLAG',
      }),
    ).resolves.toEqual({
      cloudProvider: CloudType.AWS,
      accessKeyId: 'AKIA-FLAG',
      secretAccessKey: 'SECRET-PROMPTED',
    });
    expect(listImportableAWSProfileSummaries).not.toHaveBeenCalled();
    expect(safePrompts).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'password',
        message: expect.stringMatching(/Secret Access Key/i),
      }),
    );
  });

  it('AWS: existing creds file → profile picker chosen → loads profile creds', async () => {
    vi.mocked(listImportableAWSProfileSummaries).mockResolvedValue(
      awsProfileSummaries(['default', 'work']),
    );
    vi.mocked(resolveAWSProfileSource).mockResolvedValue({
      kind: 'static',
      credentials: {
        profileName: 'work',
        accessKeyId: 'AKIA-WORK',
        secretAccessKey: 'SECRET-WORK',
        region: 'us-west-2',
      },
    });
    vi.mocked(safePrompts).mockResolvedValueOnce({
      value: 'aws-profile:work',
    });

    const creds = await buildCredentialsInteractive('my-aws', {
      provider: 'aws',
    });
    expect(creds).toEqual({
      cloudProvider: CloudType.AWS,
      accessKeyId: 'AKIA-WORK',
      secretAccessKey: 'SECRET-WORK',
    });
  });

  it('AWS: no creds file, no CLI → manual prompt path (text + password)', async () => {
    vi.mocked(isAWSCLIInstalled).mockResolvedValue(false);
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ value: 'enter' })
      .mockResolvedValueOnce({ value: 'AKIA-MANUAL' })
      .mockResolvedValueOnce({ value: 'SECRET-MANUAL' });

    const creds = await buildCredentialsInteractive('my-aws', {
      provider: 'aws',
    });
    expect(creds).toEqual({
      cloudProvider: CloudType.AWS,
      accessKeyId: 'AKIA-MANUAL',
      secretAccessKey: 'SECRET-MANUAL',
    });
    const calls = vi.mocked(safePrompts).mock.calls.map((c) => c[0]);
    expect(calls[0]).toMatchObject({
      type: 'select',
      choices: ['enter', 'admin'].map((value) =>
        expect.objectContaining({ value }),
      ),
    });
    expect(calls[1]).toMatchObject({
      type: 'text',
      message: expect.stringMatching(/Access Key/i),
    });
    expect(calls[2]).toMatchObject({
      type: 'password',
      message: expect.stringMatching(/Secret Access Key/i),
    });
  });

  it('AWS: authenticated static profile imports its existing keys', async () => {
    vi.mocked(listImportableAWSProfileSummaries).mockResolvedValue(
      awsProfileSummaries(['default']),
    );
    vi.mocked(safePrompts).mockResolvedValueOnce({
      value: 'aws-profile:default',
    });
    vi.mocked(resolveAWSProfileSource).mockResolvedValue({
      kind: 'static',
      credentials: {
        profileName: 'default',
        accessKeyId: 'AKIA-EXISTING',
        secretAccessKey: 'SECRET-EXISTING',
      },
    });

    const creds = await buildCredentialsInteractive('my-aws', {
      provider: 'aws',
    });
    expect(creds).toEqual({
      cloudProvider: CloudType.AWS,
      accessKeyId: 'AKIA-EXISTING',
      secretAccessKey: 'SECRET-EXISTING',
    });
  });

  it('AWS: explicit static profile imports without consulting ambient auth', async () => {
    vi.mocked(resolveAWSProfileSource).mockResolvedValue({
      kind: 'static',
      credentials: {
        profileName: 'production',
        accessKeyId: 'AKIA-PRODUCTION',
        secretAccessKey: 'SECRET-PRODUCTION',
      },
    });

    await expect(
      buildCredentialsInteractive('my-aws', {
        provider: 'aws',
        profile: 'production',
      }),
    ).resolves.toEqual({
      cloudProvider: CloudType.AWS,
      accessKeyId: 'AKIA-PRODUCTION',
      secretAccessKey: 'SECRET-PRODUCTION',
    });
  });

  it('AWS: temporary profile is rejected instead of being persisted', async () => {
    vi.mocked(resolveAWSProfileSource).mockResolvedValue({
      kind: 'temporary',
      credentials: {
        profileName: 'temporary',
        accessKeyId: 'ASIA-TEMPORARY',
        secretAccessKey: 'SECRET-TEMPORARY',
        sessionToken: 'SESSION-TEMPORARY',
      },
    });

    await expect(
      buildCredentialsInteractive('my-aws', {
        provider: 'aws',
        profile: 'temporary',
      }),
    ).rejects.toThrow(/temporary session credentials.*durable static profile/i);
  });

  it('AWS: no static profile falls back to manual entry', async () => {
    vi.mocked(isAWSCLIInstalled).mockResolvedValue(true);
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ value: 'enter' })
      .mockResolvedValueOnce({ value: 'AKIA-MANUAL' })
      .mockResolvedValueOnce({ value: 'SECRET-MANUAL' });

    const creds = await buildCredentialsInteractive('my-aws', {
      provider: 'aws',
    });

    expect(creds).toEqual({
      cloudProvider: CloudType.AWS,
      accessKeyId: 'AKIA-MANUAL',
      secretAccessKey: 'SECRET-MANUAL',
    });
  });

  it('AWS: explicit non-static profile points to durable credential options', async () => {
    vi.mocked(resolveAWSProfileSource).mockResolvedValue({
      kind: 'non-static',
      profileName: 'sso-dev',
    });

    await expect(
      buildCredentialsInteractive('my-aws', {
        provider: 'aws',
        profile: 'sso-dev',
      }),
    ).rejects.toThrow(/cannot be imported.*durable static profile/i);
  });

  it('AWS: AWS_PROFILE highlights an eligible profile and still requires selection', async () => {
    process.env.AWS_PROFILE = 'work';
    vi.mocked(listImportableAWSProfileSummaries).mockResolvedValue(
      awsProfileSummaries(['default', 'work']),
    );
    vi.mocked(safePrompts).mockResolvedValueOnce({ value: 'aws-profile:work' });
    vi.mocked(resolveAWSProfileSource).mockResolvedValue({
      kind: 'static',
      credentials: {
        profileName: 'work',
        accessKeyId: 'AKIA-WORK',
        secretAccessKey: 'SECRET-WORK',
      },
    });

    await expect(
      buildCredentialsInteractive('my-aws', { provider: 'aws' }),
    ).resolves.toEqual({
      cloudProvider: CloudType.AWS,
      accessKeyId: 'AKIA-WORK',
      secretAccessKey: 'SECRET-WORK',
    });
    expect(safePrompts).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: 'select', initial: 1 }),
    );
  });

  it.each(['missing', 'sso-dev'])(
    'AWS: unavailable ambient profile %s leaves durable profiles selectable',
    async (profileName) => {
      process.env.AWS_PROFILE = profileName;
      vi.mocked(listImportableAWSProfileSummaries).mockResolvedValue(
        awsProfileSummaries(['work']),
      );
      vi.mocked(safePrompts).mockResolvedValueOnce({
        value: 'aws-profile:work',
      });
      vi.mocked(resolveAWSProfileSource).mockResolvedValue({
        kind: 'static',
        credentials: {
          profileName: 'work',
          accessKeyId: 'AKIA-WORK',
          secretAccessKey: 'SECRET-WORK',
        },
      });

      await expect(
        buildCredentialsInteractive('my-aws', { provider: 'aws' }),
      ).resolves.toEqual({
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIA-WORK',
        secretAccessKey: 'SECRET-WORK',
      });
      expect(resolveAWSProfileSource).toHaveBeenCalledExactlyOnceWith('work');
      expect(safePrompts).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ type: 'select', initial: 0 }),
      );
    },
  );

  it('AWS: environment keys are offered first alongside profiles, manual entry, and generation', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIA-ENV';
    process.env.AWS_SECRET_ACCESS_KEY = 'SECRET-ENV';
    process.env.AWS_PROFILE = 'work';
    vi.mocked(isAWSCLIInstalled).mockResolvedValue(true);
    vi.mocked(listImportableAWSProfileSummaries).mockResolvedValue(
      awsProfileSummaries(['work']),
    );
    vi.mocked(safePrompts).mockResolvedValueOnce({ value: 'environment' });

    await expect(
      acquireCredentialsInteractive('my-aws', { provider: 'aws' }),
    ).resolves.toEqual({
      credential: {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIA-ENV',
        secretAccessKey: 'SECRET-ENV',
      },
      metadata: {
        importConfirmationSource: 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY',
      },
    });
    expect(safePrompts).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: 'select',
        initial: 0,
        choices: [
          { title: 'Use access keys from environment', value: 'environment' },
          { title: 'AWS profile: work (current)', value: 'aws-profile:work' },
          { title: 'Enter existing access keys', value: 'enter' },
          { title: 'Create an IAM user with AWS CLI', value: 'create' },
          { title: "I don't have AWS access keys", value: 'admin' },
        ],
      }),
    );
    expect(resolveAWSProfileSource).not.toHaveBeenCalled();
  });

  it.each([undefined, 'SESSION-ENV'])(
    'AWS: fresh manual entry ignores ambient keys and session token %s',
    async (sessionToken) => {
      process.env.AWS_ACCESS_KEY_ID = 'AKIA-ENV';
      process.env.AWS_SECRET_ACCESS_KEY = 'SECRET-ENV';
      if (sessionToken) process.env.AWS_SESSION_TOKEN = sessionToken;
      vi.mocked(listImportableAWSProfileSummaries).mockResolvedValue(
        awsProfileSummaries(['default']),
      );
      vi.mocked(safePrompts)
        .mockResolvedValueOnce({ value: 'enter' })
        .mockResolvedValueOnce({ value: 'AKIA-MANUAL' })
        .mockResolvedValueOnce({ value: 'SECRET-MANUAL' });

      await expect(
        acquireCredentialsInteractive('my-aws', { provider: 'aws' }),
      ).resolves.toEqual({
        credential: {
          cloudProvider: CloudType.AWS,
          accessKeyId: 'AKIA-MANUAL',
          secretAccessKey: 'SECRET-MANUAL',
        },
        metadata: { importConfirmationSource: 'Manually entered access keys' },
      });
      expect(resolveAWSProfileSource).not.toHaveBeenCalled();
      expect(safePrompts).toHaveBeenCalledTimes(3);
      expect(safePrompts).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          type: 'text',
          message: 'AWS Access Key ID:',
        }),
      );
      expect(safePrompts).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          type: 'password',
          message: 'AWS Secret Access Key:',
        }),
      );
      if (sessionToken) {
        expect(safePrompts).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            choices: [
              {
                title: 'AWS profile: default (current)',
                value: 'aws-profile:default',
              },
              { title: 'Enter existing access keys', value: 'enter' },
              { title: "I don't have AWS access keys", value: 'admin' },
            ],
          }),
        );
      }
    },
  );

  it('AWS: canceling source selection does not read or authenticate a profile', async () => {
    vi.mocked(listImportableAWSProfileSummaries).mockResolvedValue(
      awsProfileSummaries(['default']),
    );
    vi.mocked(safePrompts).mockResolvedValueOnce({});

    await expect(
      buildCredentialsInteractive('my-aws', { provider: 'aws' }),
    ).rejects.toThrow('process.exit:0');
    expect(resolveAWSProfileSource).not.toHaveBeenCalled();
    expect(validateAWSAccessCredentials).not.toHaveBeenCalled();
  });

  it('AWS: incomplete static profile reports its missing field', async () => {
    vi.mocked(resolveAWSProfileSource).mockResolvedValue({
      kind: 'incomplete',
      profileName: 'broken',
      missing: ['aws_secret_access_key'],
    });

    await expect(
      buildCredentialsInteractive('my-aws', {
        provider: 'aws',
        profile: 'broken',
      }),
    ).rejects.toThrow(/broken.*aws_secret_access_key/i);
  });

  it('AWS: missing explicit profile lists available static profiles', async () => {
    vi.mocked(listImportableAWSProfileSummaries).mockResolvedValue(
      awsProfileSummaries(['default', 'production']),
    );

    await expect(
      buildCredentialsInteractive('my-aws', {
        provider: 'aws',
        profile: 'missing',
      }),
    ).rejects.toThrow(
      /missing.*available static profiles: default, production/i,
    );
  });

  it('AWS: explicit profile overrides ambient access-key environment variables', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIA-AMBIENT';
    process.env.AWS_SECRET_ACCESS_KEY = 'SECRET-AMBIENT';
    vi.mocked(resolveAWSProfileSource).mockResolvedValue({
      kind: 'static',
      credentials: {
        profileName: 'production',
        accessKeyId: 'AKIA-PRODUCTION',
        secretAccessKey: 'SECRET-PRODUCTION',
      },
    });

    await expect(
      buildCredentialsInteractive('my-aws', {
        provider: 'aws',
        profile: 'production',
      }),
    ).resolves.toMatchObject({
      accessKeyId: 'AKIA-PRODUCTION',
      secretAccessKey: 'SECRET-PRODUCTION',
    });
  });

  it('Azure: short-circuits prompts when all four fields are present', async () => {
    const creds = await buildCredentialsInteractive('my-azure', {
      provider: 'azure',
      applicationId: 'app',
      secret: 's',
      subscriptionId: 'sub',
      directoryId: 'dir',
    });
    expect(creds).toEqual({
      cloudProvider: CloudType.Azure,
      applicationId: 'app',
      secret: 's',
      subscriptionId: 'sub',
      directoryId: 'dir',
    });
    expect(safePrompts).not.toHaveBeenCalled();
    expect(isAzureCLIInstalled).not.toHaveBeenCalled();
  });

  it('Azure: explicitly entering an existing principal never consults Azure CLI', async () => {
    process.env.AZURE_APPLICATION_ID = 'ambient-app';
    process.env.AZURE_SECRET = 'ambient-secret';
    process.env.AZURE_SUBSCRIPTION_ID = 'ambient-sub';
    process.env.AZURE_DIRECTORY_ID = 'ambient-tenant';
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ value: 'enter' })
      .mockResolvedValueOnce({ value: 'app-id' })
      .mockResolvedValueOnce({ value: 'secret-pw' })
      .mockResolvedValueOnce({ value: 'sub-id' })
      .mockResolvedValueOnce({ value: 'dir-id' });

    const creds = await buildCredentialsInteractive('my-azure', {
      provider: 'azure',
    });

    expect(creds).toEqual({
      cloudProvider: CloudType.Azure,
      applicationId: 'app-id',
      secret: 'secret-pw',
      subscriptionId: 'sub-id',
      directoryId: 'dir-id',
    });
    expect(isAzureCLIInstalled).not.toHaveBeenCalled();
    expect(generateAzureServicePrincipal).not.toHaveBeenCalled();
    expect(safePrompts).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        initial: 0,
        choices: [
          {
            title: 'Use service principal credentials from environment',
            value: 'environment',
          },
          {
            title: 'Enter existing service principal credentials',
            value: 'enter',
          },
          {
            title: 'Create a service principal with Azure CLI',
            value: 'create',
          },
          {
            title: "I don't have Azure service principal credentials",
            value: 'admin',
          },
        ],
      }),
    );
  });

  it('Azure: explicit creation previews permissions and confirms before mutation', async () => {
    process.env.AZURE_APPLICATION_ID = 'ambient-app';
    process.env.AZURE_SECRET = 'ambient-secret';
    process.env.AZURE_SUBSCRIPTION_ID = 'sub-gen';
    process.env.AZURE_DIRECTORY_ID = 'ambient-tenant';
    vi.mocked(isAzureCLIInstalled).mockResolvedValue(true);
    vi.mocked(isAzureCLILoggedIn).mockResolvedValue(true);
    vi.mocked(listAzureSubscriptions).mockResolvedValue([
      {
        id: 'sub-gen',
        name: 'Test Sub',
        tenantId: 'tenant-gen',
        isDefault: true,
      },
    ]);
    vi.mocked(getAzureGenerationPreview).mockResolvedValue({
      subscriptionId: 'sub-gen',
      tenantId: 'tenant-gen',
      scope: '/subscriptions/sub-gen',
      roles: ['Contributor'],
    });
    vi.mocked(generateAzureServicePrincipal).mockResolvedValue({
      applicationId: 'app-gen',
      secret: 'secret-gen',
      tenantId: 'tenant-gen',
    });
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ value: 'create' })
      .mockResolvedValueOnce({ confirmed: true });

    const creds = await buildCredentialsInteractive('my-azure', {
      provider: 'azure',
    });

    expect(printInfo).toHaveBeenCalledWith('Tenant: tenant-gen');
    expect(printInfo).toHaveBeenCalledWith('Subscription: sub-gen');
    expect(printInfo).toHaveBeenCalledWith('Scope: /subscriptions/sub-gen');
    expect(printInfo).toHaveBeenCalledWith('Roles: Contributor');
    expect(printInfo).toHaveBeenCalledWith(
      expect.stringMatching(/required operator access.*assign that role/i),
    );
    expect(safePrompts).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: 'confirm',
        initial: true,
        message: 'Create these Azure credentials?',
      }),
    );
    expect(generateAzureServicePrincipal).toHaveBeenCalledWith(
      'sub-gen',
      'my-azure',
    );
    expect(creds).toMatchObject({
      cloudProvider: CloudType.Azure,
      subscriptionId: 'sub-gen',
      directoryId: 'tenant-gen',
    });
  });

  it('Azure: declining creation exits before provider mutation', async () => {
    vi.mocked(isAzureCLIInstalled).mockResolvedValue(true);
    vi.mocked(isAzureCLILoggedIn).mockResolvedValue(true);
    vi.mocked(listAzureSubscriptions).mockResolvedValue([
      {
        id: 'sub-cancel',
        tenantId: 'tenant-cancel',
        isDefault: true,
      },
    ]);
    vi.mocked(getAzureGenerationPreview).mockResolvedValue({
      subscriptionId: 'sub-cancel',
      tenantId: 'tenant-cancel',
      scope: '/subscriptions/sub-cancel',
      roles: ['Contributor'],
    });
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ value: 'create' })
      .mockResolvedValueOnce({ confirmed: false });

    await expect(
      buildCredentialsInteractive('my-azure', { provider: 'azure' }),
    ).rejects.toThrow(/process\.exit:0/);

    expect(getAzureGenerationPreview).toHaveBeenCalledWith('sub-cancel');
    expect(generateAzureServicePrincipal).not.toHaveBeenCalled();
  });

  it('Azure: explicit creation can open browser login', async () => {
    vi.mocked(isAzureCLIInstalled).mockResolvedValue(true);
    vi.mocked(isAzureCLILoggedIn)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    vi.mocked(listAzureSubscriptions).mockResolvedValue([
      {
        id: 'sub-login',
        tenantId: 'tenant-login',
        isDefault: true,
      },
    ]);
    vi.mocked(getAzureGenerationPreview).mockResolvedValue({
      subscriptionId: 'sub-login',
      tenantId: 'tenant-login',
      scope: '/subscriptions/sub-login',
      roles: ['Contributor'],
    });
    vi.mocked(generateAzureServicePrincipal).mockResolvedValue({
      applicationId: 'app-login',
      secret: 'secret-login',
      tenantId: 'tenant-login',
    });
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ value: 'create' })
      .mockResolvedValueOnce({ confirmed: true });

    await buildCredentialsInteractive('my-azure', { provider: 'azure' });

    expect(loginToAzure).toHaveBeenCalledOnce();
    expect(generateAzureServicePrincipal).toHaveBeenCalledWith(
      'sub-login',
      'my-azure',
    );
  });

  it('Azure: multiple subscriptions preserve the active selection and preview the chosen target', async () => {
    vi.mocked(isAzureCLIInstalled).mockResolvedValue(true);
    vi.mocked(isAzureCLILoggedIn).mockResolvedValue(true);
    vi.mocked(listAzureSubscriptions).mockResolvedValue([
      { id: 'sub-dev', name: 'Development', tenantId: 'tenant-dev' },
      {
        id: 'sub-prod',
        name: 'Production',
        tenantId: 'tenant-prod',
        isDefault: true,
      },
    ]);
    vi.mocked(getAzureGenerationPreview).mockResolvedValue({
      subscriptionId: 'sub-dev',
      tenantId: 'tenant-dev',
      scope: '/subscriptions/sub-dev',
      roles: ['Contributor'],
    });
    vi.mocked(generateAzureServicePrincipal).mockResolvedValue({
      applicationId: 'app-multi',
      secret: 'secret-multi',
      tenantId: 'tenant-dev',
    });
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ value: 'create' })
      .mockResolvedValueOnce({ value: 'sub-dev' })
      .mockResolvedValueOnce({ confirmed: true });

    await buildCredentialsInteractive('my-azure', { provider: 'azure' });

    expect(safePrompts).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: 'select',
        message: 'Select Azure subscription:',
        initial: 1,
      }),
    );
    expect(getAzureGenerationPreview).toHaveBeenCalledWith('sub-dev');
    expect(generateAzureServicePrincipal).toHaveBeenCalledWith(
      'sub-dev',
      'my-azure',
    );
  });

  it('Azure: choosing creation without Azure CLI fails without switching acquisition modes', async () => {
    vi.mocked(isAzureCLIInstalled).mockResolvedValue(false);
    vi.mocked(safePrompts).mockResolvedValueOnce({ value: 'create' });

    await expect(
      buildCredentialsInteractive('my-azure', { provider: 'azure' }),
    ).rejects.toThrow(/generation requires the Azure CLI/i);

    expect(generateAzureServicePrincipal).not.toHaveBeenCalled();
    expect(safePrompts).toHaveBeenCalledOnce();
  });
  it('GCP: short-circuits prompts when all three flags are present (regression: no privateKey prompt)', async () => {
    const creds = await buildCredentialsInteractive('my-gcp', {
      provider: 'gcp',
      projectId: 'proj',
      clientEmail: 'sa@proj.iam.gserviceaccount.com',
      privateKey: '-----BEGIN PRIVATE KEY-----\nfoo\n-----END PRIVATE KEY-----',
    });
    expect(creds.cloudProvider).toBe(CloudType.GCP);
    expect(safePrompts).not.toHaveBeenCalled();
    expect(getAllServiceAccountKeyPaths).not.toHaveBeenCalled();
  });

  it('AWS: interactive generation without profiles explains how to add one', async () => {
    vi.mocked(isAWSCLIInstalled).mockResolvedValue(true);
    vi.mocked(listAWSProfileNames).mockResolvedValue([]);
    vi.mocked(safePrompts).mockResolvedValueOnce({ value: 'create' });

    await expect(
      buildCredentialsInteractive('no-profiles', { provider: 'aws' }),
    ).rejects.toThrow(
      'No AWS profiles found. Run "aws configure --profile <name>" or "aws configure sso", then try again.',
    );
    expect(safePrompts).toHaveBeenCalledOnce();
    expect(getAWSGenerationPreview).not.toHaveBeenCalled();
  });

  it.each([
    { current: 'work', initial: 1 },
    // A stale AWS_PROFILE falls back to the first listed profile.
    { current: 'missing', initial: 0 },
  ])(
    'AWS: operator picker lists every profile and highlights $current',
    async ({ current, initial }) => {
      process.env.AWS_PROFILE = current;
      vi.mocked(isAWSCLIInstalled).mockResolvedValue(true);
      vi.mocked(listAWSProfileNames).mockResolvedValue([
        'default',
        'work',
        'sso-admin',
      ]);
      mockAWSGeneration();
      vi.mocked(safePrompts)
        .mockResolvedValueOnce({ value: 'create' })
        .mockResolvedValueOnce({ value: 'sso-admin' })
        .mockResolvedValueOnce({ confirmed: true });

      await expect(
        buildCredentialsInteractive('picked', { provider: 'aws' }),
      ).resolves.toMatchObject({
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIA-GENERATED',
      });
      expect(safePrompts).toHaveBeenNthCalledWith(2, {
        type: 'select',
        name: 'value',
        message: 'AWS operator profile:',
        choices: ['default', 'work', 'sso-admin'].map((name) => ({
          title: name === current ? `${name} (current)` : name,
          value: name,
        })),
        initial,
      });
      expect(getAWSGenerationPreview).toHaveBeenCalledWith(
        expect.objectContaining({ profile: 'sso-admin' }),
        'picked',
        undefined,
      );
      expect(safePrompts).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ type: 'confirm', initial: true }),
      );
      expect(createSpinner).toHaveBeenCalledWith(
        'Creating IAM user "anycloud-picked"...',
      );
      expect(spinnerMock.stop).toHaveBeenCalledOnce();
    },
  );

  it('AWS: --profile skips the operator picker', async () => {
    vi.mocked(isAWSCLIInstalled).mockResolvedValue(true);
    mockAWSGeneration();

    await expect(
      acquireGeneratedCredentials('flagged', {
        provider: 'aws',
        generate: true,
        profile: 'operator',
        accountId: '123456789012',
      }),
    ).resolves.toMatchObject({
      credential: { accessKeyId: 'AKIA-GENERATED' },
    });
    expect(listAWSProfileNames).not.toHaveBeenCalled();
    expect(safePrompts).not.toHaveBeenCalled();
    expect(getAWSGenerationPreview).toHaveBeenCalledWith(
      expect.objectContaining({ profile: 'operator' }),
      'flagged',
      '123456789012',
    );
  });

  it.each([true, false])(
    '0038/S3 GCP previews generation despite environment credentials and requires explicit confirmation (%s)',
    async (confirmed) => {
      process.env.GCP_PROJECT_ID = 'ambient-project';
      process.env.GCP_CLIENT_EMAIL =
        'ambient@ambient-project.iam.gserviceaccount.com';
      process.env.GCP_PRIVATE_KEY = 'AMBIENT-GCP-KEY';
      const { preview, generated } = mockGCPGeneration();
      vi.mocked(safePrompts)
        .mockResolvedValueOnce({ value: 'create' })
        .mockImplementationOnce(async () => {
          expect(generateGCPCredentials).not.toHaveBeenCalled();
          expect(printInfo).toHaveBeenCalledWith(
            `GCP operator: ${preview.operator.account}`,
          );
          expect(printInfo).toHaveBeenCalledWith(
            `Project ID: ${preview.operator.projectId} (project number ${preview.projectNumber})`,
          );
          expect(printInfo).toHaveBeenCalledWith(
            `Service account to create: ${preview.email}`,
          );
          expect(printInfo).toHaveBeenCalledWith(
            expect.stringContaining('Project role: anycloud'),
          );
          return { confirmed };
        });
      const pending = buildCredentialsInteractive('test-gcp', {
        provider: 'gcp',
        gcloudAccount: preview.operator.account,
        projectId: preview.operator.projectId,
      });
      if (confirmed) {
        await expect(pending).resolves.toMatchObject({
          cloudProvider: CloudType.GCP,
          privateKey: generated.privateKey,
        });
        expect(generateGCPCredentials).toHaveBeenCalledExactlyOnceWith(preview);
        expect(createSpinner).toHaveBeenCalledWith(
          `Creating service account ${preview.email}...`,
        );
        expect(spinnerMock.stop).toHaveBeenCalled();
      } else {
        await expect(pending).rejects.toThrow('process.exit:0');
        expect(generateGCPCredentials).not.toHaveBeenCalled();
        expect(createSpinner).not.toHaveBeenCalledWith(
          `Creating service account ${preview.email}...`,
        );
      }
      expect(safePrompts).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ type: 'confirm', initial: true }),
      );
    },
  );

  it('GCP: a generation permission denial asks for an administrator', async () => {
    const { preview } = mockGCPGeneration();
    vi.mocked(generateGCPCredentials).mockRejectedValue(
      Object.assign(new Error('GCP request failed (HTTP 403).'), {
        cause: new GCPBootstrapError(
          'GCP request failed (HTTP 403, PERMISSION_DENIED).',
          403,
          'PERMISSION_DENIED',
        ),
      }),
    );
    await expect(
      acquireGeneratedCredentials('test-gcp', {
        provider: 'gcp',
        gcloudAccount: preview.operator.account,
        projectId: preview.operator.projectId,
      }),
    ).rejects.toThrow(
      `Ask your GCP administrator for one of these:\n  - A JSON key for a dedicated Anycloud service account\n  - Permission for ${preview.operator.account} in project ${preview.operator.projectId}`,
    );
  });

  it('GCP: no discovered key opens the service-account JSON import flow', async () => {
    process.env.GCP_PROJECT_ID = 'ambient-project';
    process.env.GCP_CLIENT_EMAIL =
      'ambient@ambient-project.iam.gserviceaccount.com';
    process.env.GCP_PRIVATE_KEY = 'AMBIENT-PRIVATE-KEY';
    vi.mocked(getAllServiceAccountKeyPaths).mockResolvedValue([]);
    const persist = vi.fn().mockResolvedValue(undefined);
    vi.mocked(prepareGCPServiceAccountKeyImport).mockResolvedValue({
      projectId: 'proj-up',
      clientEmail: 'sa@proj-up.iam.gserviceaccount.com',
      privateKey: '-----BEGIN PRIVATE KEY-----\nup\n-----END PRIVATE KEY-----',
      keyFilePath: '/tmp/key.json',
      persist,
    });
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ value: 'upload' })
      .mockResolvedValueOnce({ value: '/tmp/key.json' });

    const creds = await buildCredentialsInteractive('my-gcp', {
      provider: 'gcp',
    });
    expect(prepareGCPServiceAccountKeyImport).toHaveBeenCalledWith(
      '/tmp/key.json',
    );
    expect(persist).not.toHaveBeenCalled();
    expect(creds).toMatchObject({
      cloudProvider: CloudType.GCP,
      projectId: 'proj-up',
    });
    expect(safePrompts).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        initial: 0,
        choices: [
          {
            title: 'Use service account credentials from environment',
            value: 'environment',
          },
          {
            title: 'Upload existing service account key file',
            value: 'upload',
          },
          { title: 'Create a service account with gcloud', value: 'create' },
          { title: "I don't have a GCP service account key", value: 'admin' },
        ],
      }),
    );
  });

  it('0038/S3 rejects a generation operator on the chosen import route', async () => {
    vi.mocked(safePrompts).mockResolvedValueOnce({ value: 'upload' });
    await expect(
      buildCredentialsInteractive('test-gcp', {
        provider: 'gcp',
        gcloudAccount: 'operator@example.com',
      }),
    ).rejects.toThrow('--gcloud-account selects a generation operator');
    expect(prepareGCPServiceAccountKeyImport).not.toHaveBeenCalled();
    expect(generateGCPCredentials).not.toHaveBeenCalled();
  });

  it.each([
    { overwrite: true },
    { privateKey: 'explicit-key' },
    { clientEmail: 'other@example.com' },
    { accountId: '123456789012' },
    { profile: 'aws-operator' },
    { subscriptionId: 'azure-subscription' },
  ])(
    '0038/S3 rejects conflicting generation options before provider access: %j',
    (conflict) => {
      expect(() =>
        validateGenerationSelection('test-gcp', {
          provider: 'gcp',
          generate: true,
          gcloudAccount: 'operator@example.com',
          projectId: 'selected-project',
          ...conflict,
        }),
      ).toThrow();
      expect(getGCPGenerationPreview).not.toHaveBeenCalled();
      expect(generateGCPCredentials).not.toHaveBeenCalled();
    },
  );

  it('GCP: ADC + existing key file selected → reads the canonical key material (no privateKey prompt)', async () => {
    vi.mocked(getAllServiceAccountKeyPaths).mockResolvedValue([
      '/keys/main.json',
    ]);
    const key = {
      type: 'service_account',
      project_id: 'proj-read',
      private_key_id: 'key-id',
      private_key:
        '-----BEGIN PRIVATE KEY-----\nread\n-----END PRIVATE KEY-----',
      client_email: 'sa@proj-read.iam.gserviceaccount.com',
      client_id: 'client-id',
      auth_uri: 'https://accounts.example.test/auth',
      token_uri: 'https://accounts.example.test/token',
      auth_provider_x509_cert_url: 'https://accounts.example.test/certs',
      client_x509_cert_url: 'https://accounts.example.test/client-cert',
    } satisfies GCPServiceAccountKey;
    vi.mocked(readServiceAccountKey).mockResolvedValue(key);
    vi.mocked(safePrompts).mockResolvedValueOnce({
      value: 'gcp-key-file:%2Fkeys%2Fmain.json',
    });

    const creds = await buildCredentialsInteractive('my-gcp', {
      provider: 'gcp',
    });
    expect(readServiceAccountKey).toHaveBeenCalledWith('/keys/main.json');
    expect(creds.cloudProvider).toBe(CloudType.GCP);
    // Regression guard: no prompt asked for the PEM directly
    const promptMessages = vi
      .mocked(safePrompts)
      .mock.calls.map((c) => c[0])
      .map((q) => (Array.isArray(q) ? q[0] : q))
      .map((q) => q.message);
    expect(promptMessages.some((m) => /private key/i.test(String(m)))).toBe(
      false,
    );
  });

  it.each([true, false])(
    'GCP: preserves key ordering and materializes only the chosen key (environment: %s)',
    async (hasEnvironment) => {
      if (hasEnvironment) {
        process.env.GCP_PROJECT_ID = 'ambient-project';
        process.env.GCP_CLIENT_EMAIL =
          'ambient@ambient-project.iam.gserviceaccount.com';
        process.env.GCP_PRIVATE_KEY = 'AMBIENT-GCP-KEY';
      }
      vi.mocked(getAllServiceAccountKeyPaths).mockResolvedValue([
        '/keys/newest.json',
        '/keys/older.json',
      ]);
      vi.mocked(readServiceAccountKey).mockResolvedValue({
        type: 'service_account',
        project_id: 'chosen-project',
        private_key_id: 'chosen-id',
        private_key: 'CHOSEN-PRIVATE-KEY',
        client_email: 'chosen@chosen-project.iam.gserviceaccount.com',
        client_id: 'client-id',
        auth_uri: '',
        token_uri: '',
        auth_provider_x509_cert_url: '',
        client_x509_cert_url: '',
      });
      vi.mocked(safePrompts).mockImplementationOnce(async () => {
        expect(readServiceAccountKey).not.toHaveBeenCalled();
        return { value: 'gcp-key-file:%2Fkeys%2Folder.json' };
      });
      const acquired = await acquireCredentialsInteractive('chosen', {
        provider: 'gcp',
      });
      expect(readServiceAccountKey).toHaveBeenCalledExactlyOnceWith(
        '/keys/older.json',
      );
      expect(acquired.credential).toMatchObject({
        projectId: 'chosen-project',
        privateKey: 'CHOSEN-PRIVATE-KEY',
      });
      expect(acquired.metadata?.importConfirmationSource).toContain(
        '/keys/older.json',
      );
      expect(safePrompts).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          initial: 0,
          choices: [
            ...(hasEnvironment
              ? [
                  {
                    title: 'Use service account credentials from environment',
                    value: 'environment',
                  },
                ]
              : []),
            {
              title: '/keys/newest.json (most recent)',
              value: 'gcp-key-file:%2Fkeys%2Fnewest.json',
            },
            {
              title: '/keys/older.json',
              value: 'gcp-key-file:%2Fkeys%2Folder.json',
            },
            {
              title: 'Upload existing service account key file',
              value: 'upload',
            },
            { title: 'Create a service account with gcloud', value: 'create' },
            { title: "I don't have a GCP service account key", value: 'admin' },
          ],
        }),
      );
      expect(prepareGCPServiceAccountKeyImport).not.toHaveBeenCalled();
    },
  );

  it('Lambda: short-circuits when --api-key is present', async () => {
    const creds = await buildCredentialsInteractive('my-lambda', {
      provider: 'lambda',
      apiKey: 'LAMBDA-FLAG',
    });
    expect(creds).toEqual({
      cloudProvider: CloudType.Lambda,
      apiKey: 'LAMBDA-FLAG',
    });
    expect(safePrompts).not.toHaveBeenCalled();
  });

  it('Lambda: no flag → password prompt fires once', async () => {
    vi.mocked(safePrompts).mockResolvedValueOnce({ value: 'LAMBDA-PROMPT' });

    const creds = await buildCredentialsInteractive('my-lambda', {
      provider: 'lambda',
    });
    expect(creds).toEqual({
      cloudProvider: CloudType.Lambda,
      apiKey: 'LAMBDA-PROMPT',
    });
    expect(safePrompts).toHaveBeenCalledTimes(1);
    expect(vi.mocked(safePrompts).mock.calls[0][0]).toMatchObject({
      type: 'password',
    });
  });

  it.each([
    {
      provider: 'lambda',
      environmentVariable: 'LAMBDA_API_KEY',
      cloudProvider: CloudType.Lambda,
    },
  ])(
    '$provider: selecting manual entry ignores the ambient API key',
    async ({ provider, environmentVariable, cloudProvider }) => {
      process.env[environmentVariable] = 'AMBIENT-API-KEY';
      vi.mocked(safePrompts)
        .mockResolvedValueOnce({ value: 'enter' })
        .mockResolvedValueOnce({ value: 'FRESH-API-KEY' });
      const acquired = await acquireCredentialsInteractive('manual-api-key', {
        provider,
      });
      expect(acquired.credential).toEqual({
        cloudProvider,
        apiKey: 'FRESH-API-KEY',
      });
      expect(acquired.metadata?.importConfirmationSource).toBe(
        'Manually entered API key',
      );
      expect(safePrompts).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          initial: 0,
          choices: [
            { title: 'Use API key from environment', value: 'environment' },
            { title: 'Enter an API key', value: 'enter' },
          ],
        }),
      );
      expect(safePrompts).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ type: 'password' }),
      );
    },
  );

  it('provider picker fires when --provider missing and no env', async () => {
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ value: 'lambda' })
      .mockResolvedValueOnce({ value: 'LAMBDA-VIA-PICKER' });

    const creds = await buildCredentialsInteractive('my-cred', {});
    expect(creds.cloudProvider).toBe(CloudType.Lambda);
    expect(vi.mocked(safePrompts).mock.calls[0][0]).toMatchObject({
      type: 'select',
      message: expect.stringMatching(/cloud provider/i),
    });
  });
});

describe('resolveCredentialName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the passed name without prompting', async () => {
    const name = await resolveCredentialName('prod-aws');
    expect(name).toBe('prod-aws');
    expect(shouldAllowPrompts).not.toHaveBeenCalled();
    expect(safePrompts).not.toHaveBeenCalled();
  });

  it('prompts for the name on a TTY when omitted', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(safePrompts).mockResolvedValueOnce({ value: 'prompted-name' });

    const name = await resolveCredentialName(undefined);
    expect(name).toBe('prompted-name');
    expect(vi.mocked(safePrompts).mock.calls[0][0]).toMatchObject({
      type: 'text',
      message: expect.stringMatching(/name/i),
    });
  });

  it('errors when the name is omitted and prompts are disallowed', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(false);
    await expect(resolveCredentialName(undefined)).rejects.toThrow(
      /Missing credential name/,
    );
    expect(safePrompts).not.toHaveBeenCalled();
  });
});
