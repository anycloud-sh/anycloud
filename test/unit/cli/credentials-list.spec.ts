import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listCredentials: vi.fn(),
}));

const sources = vi.hoisted(() => ({
  discover: vi.fn(),
}));

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock(),
);

vi.mock('../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: () => ({
    credentials: {
      list: api.listCredentials,
    },
  }),
}));

vi.mock('../../../src/cli/services/credential-onboarding/discovery.js', () => ({
  discoverCredentialSources: sources.discover,
}));

vi.mock('../../../src/cli/utils/output.js', () => ({
  printInfo: vi.fn(),
  printSuccess: vi.fn(),
  setJsonMode: vi.fn(),
}));

import { createListCommand } from '../../../src/cli/commands/credentials/list.js';

describe('credentials list command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listCredentials.mockResolvedValue([]);
    sources.discover.mockResolvedValue([]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders AWS profiles returned by the shared importability classification', async () => {
    sources.discover.mockResolvedValue([
      {
        id: 'aws-profile:config-static',
        kind: 'aws-profile',
        provider: 'AWS',
        profileName: 'config-static',
        source: 'aws profile: config-static',
        identity: 'Access Key: AKIA-CONFIG-STATIC',
      },
    ]);

    await createListCommand().parseAsync(['node', 'test']);

    expect(sources.discover).toHaveBeenCalledOnce();
    const rendered = vi
      .mocked(console.log)
      .mock.calls.flatMap((args) => args)
      .join('\n');
    expect(rendered).toContain('aws profile: config-static');
    expect(rendered).toContain('Access Key: AKIA-CONFIG-STATIC');
  });

  it('shows a saved Cloudflare credential by account and jurisdiction', async () => {
    api.listCredentials.mockResolvedValue([
      {
        name: 'r2',
        cloudProvider: 'Cloudflare',
        accountId: 'cf-account',
        jurisdiction: 'eu',
      },
    ]);

    await createListCommand().parseAsync(['node', 'test']);

    const rendered = vi
      .mocked(console.log)
      .mock.calls.flatMap((args) => args)
      .join('\n');
    expect(rendered).toContain('Account: cf-account');
    expect(rendered).toContain('Jurisdiction: eu');
  });

  it('renders redacted GCP identity metadata from discovery', async () => {
    sources.discover.mockResolvedValue([
      {
        id: 'gcp-key-file:%2Ftmp%2Fmissing-gcp-adc.json',
        kind: 'gcp-key-file',
        provider: 'GCP',
        keyPath: '/tmp/missing-gcp-adc.json',
        source: 'gcloud ADC',
        status: 'available',
        identity:
          'Project: discovered-project\nEmail: discovered@discovered-project.iam.gserviceaccount.com',
      },
    ]);

    await createListCommand().parseAsync(['node', 'test']);

    const rendered = vi
      .mocked(console.log)
      .mock.calls.flatMap((args) => args)
      .join('\n');
    expect(rendered).toContain('Project: discovered-project');
    expect(rendered).toContain(
      'Email: discovered@discovered-project.iam.gserviceaccount.com',
    );
    expect(rendered).not.toContain('PRIVATE-KEY-MUST-NOT-BE-RENDERED');
  });

  it('uses the same GCP key inventory as credential onboarding', async () => {
    sources.discover.mockResolvedValue([
      {
        id: 'gcp-key-file:%2FUsers%2Ftest%2F.anycloud%2Fanycloud-generated-key.json',
        kind: 'gcp-key-file',
        provider: 'GCP',
        keyPath: '/Users/test/.anycloud/anycloud-generated-key.json',
        source: 'anycloud key: anycloud-generated-key.json',
        status: 'available',
        identity:
          'Project: generated-project\nEmail: generated@generated-project.iam.gserviceaccount.com',
      },
    ]);

    await createListCommand().parseAsync(['node', 'test']);

    expect(sources.discover).toHaveBeenCalledOnce();
    const rendered = vi
      .mocked(console.log)
      .mock.calls.flatMap((args) => args)
      .join('\n');
    expect(rendered).toContain('anycloud key:');
    expect(rendered).toContain('Project: generated-project');
    expect(rendered).not.toContain('GENERATED-PRIVATE-KEY');
  });

  it('shows an unusable discovered GCP key without exposing its parse error', async () => {
    sources.discover.mockResolvedValue([
      {
        id: 'gcp-key-file:%2FUsers%2Ftest%2F.anycloud%2Fanycloud-invalid-key.json',
        kind: 'gcp-key-file',
        provider: 'GCP',
        keyPath: '/Users/test/.anycloud/anycloud-invalid-key.json',
        source: 'anycloud key: anycloud-invalid-key.json',
        status: 'invalid',
        identity: 'Invalid or unsupported service-account key',
      },
    ]);

    await createListCommand().parseAsync(['node', 'test']);

    const rendered = vi
      .mocked(console.log)
      .mock.calls.flatMap((args) => args)
      .join('\n');
    expect(rendered).toContain('anycloud key:');
    expect(rendered).toContain('Invalid or unsupported service-account key');
    expect(rendered).not.toContain('PRIVATE-KEY-MATERIAL');
  });

  it('shows each role connection by its identifiers', async () => {
    api.listCredentials.mockResolvedValue([
      {
        name: 'aws-role',
        cloudProvider: 'AWS',
        kind: 'role',
        roleArn: 'arn:aws:iam::123456789012:role/aws-stack-Role-1A2B',
      },
      {
        name: 'gcp-role',
        cloudProvider: 'GCP',
        kind: 'role',
        workloadIdentityProvider:
          'projects/1/locations/global/workloadIdentityPools/p/providers/q',
        serviceAccountEmail: 'anycloud-role@proj.iam.gserviceaccount.com',
      },
      {
        name: 'aws-key',
        cloudProvider: 'AWS',
        accessKeyId: 'AKIA-KEY',
      },
      {
        name: 'azure-role',
        cloudProvider: 'Azure',
        kind: 'role',
        applicationId: 'client-id',
        directoryId: 'tenant-id',
        subscriptionId: 'sub-id',
      },
    ]);

    await createListCommand().parseAsync(['node', 'test']);

    const rendered = vi
      .mocked(console.log)
      .mock.calls.flatMap((args) => args)
      .join('\n');
    for (const detail of [
      'Role: aws-stack-Role-1A2B',
      'Account: 123456789012',
      'Role: anycloud-role@proj.iam.gserviceaccount.com',
      'Provider: p/q (project 1)',
      'Role: client-id',
      'Tenant: tenant-id',
      'Subscription: sub-id',
    ])
      expect(rendered).toContain(detail);

    vi.mocked(console.log).mockClear();
    await createListCommand().parseAsync(['node', 'test', '--json']);
    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])).map(
        (credential: { kind: string }) => credential.kind,
      ),
    ).toEqual(['role', 'role', 'key', 'role']);
  });
});
