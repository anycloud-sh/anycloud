import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  updateCredential: vi.fn(),
}));

const gcp = vi.hoisted(() => ({
  readServiceAccountKey: vi.fn(),
}));

vi.mock(
  '../../../src/cli/services/credential-onboarding/gcp-key-files.js',
  () => ({
    readServiceAccountKey: gcp.readServiceAccountKey,
    extractGCPCredentials: (key: {
      project_id: string;
      client_email: string;
      private_key: string;
    }) => ({
      projectId: key.project_id,
      clientEmail: key.client_email,
      privateKey: key.private_key,
    }),
  }),
);

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock(),
);

vi.mock('../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: () => ({
    credentials: {
      update: api.updateCredential,
    },
  }),
}));

vi.mock('../../../src/cli/utils/output.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/cli/utils/output.js')>();
  return {
    ...actual,
    printError: vi.fn(),
    printSuccess: vi.fn(),
  };
});

import { createEditCommand } from '../../../src/cli/commands/credentials/edit.js';
import { printError } from '../../../src/cli/utils/output.js';

describe('credentials edit command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function edit(...args: string[]) {
    await createEditCommand().parseAsync(['node', 'test', ...args]);
  }

  it('sends only the supplied AWS field, never reading the stored secret', async () => {
    await edit('prod-aws', '--secret-access-key', 'new-secret');

    expect(api.updateCredential).toHaveBeenCalledExactlyOnceWith({
      params: { name: 'prod-aws' },
      body: { secretAccessKey: 'new-secret' },
    });
  });

  it('sends the selected Azure fields', async () => {
    await edit(
      'prod-azure',
      '--application-id',
      'new-application',
      '--directory-id',
      'new-directory',
    );

    expect(api.updateCredential).toHaveBeenCalledExactlyOnceWith({
      params: { name: 'prod-azure' },
      body: { applicationId: 'new-application', directoryId: 'new-directory' },
    });
  });

  it('sends GCP fields from a key file, with flags overriding all but the key', async () => {
    gcp.readServiceAccountKey.mockResolvedValue({
      project_id: 'file-project',
      client_email: 'from-file@file-project.iam.gserviceaccount.com',
      private_key: 'file-private-key',
    });

    await edit(
      'prod-gcp',
      '--key-file',
      '~/keys/replacement.json',
      '--project-id',
      'override-project',
      '--private-key',
      'ignored-flag-private-key',
    );

    expect(gcp.readServiceAccountKey).toHaveBeenCalledWith(
      '~/keys/replacement.json',
    );
    expect(api.updateCredential).toHaveBeenCalledExactlyOnceWith({
      params: { name: 'prod-gcp' },
      body: {
        projectId: 'override-project',
        clientEmail: 'from-file@file-project.iam.gserviceaccount.com',
        privateKey: 'file-private-key',
      },
    });
  });

  it('sends a Lambda API key', async () => {
    await edit('prod-lambda', '--api-key', 'new-api-key');

    expect(api.updateCredential).toHaveBeenCalledExactlyOnceWith({
      params: { name: 'prod-lambda' },
      body: { apiKey: 'new-api-key' },
    });
  });

  it.each([
    [
      ['--jurisdiction', 'apac'],
      '--jurisdiction must be default, eu, or fedramp',
    ],
    [['--secret', ''], '--secret must not be empty'],
  ])('explains an invalid flag %j', async (flags, message) => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);

    await expect(edit('prod', ...flags)).rejects.toThrow('exit');

    expect(printError).toHaveBeenCalledWith(
      `Failed to edit credentials: ${message}`,
    );
    expect(api.updateCredential).not.toHaveBeenCalled();
    exit.mockRestore();
  });
});
