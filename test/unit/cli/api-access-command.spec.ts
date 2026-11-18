import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

const mocks = vi.hoisted(() => ({
  grantApiAccessUser: vi.fn(),
  issueServiceToken: vi.fn(),
  rotateServiceToken: vi.fn(),
  listApiAccessUsers: vi.fn(),
  printError: vi.fn(),
  printInfo: vi.fn(),
  printSuccess: vi.fn(),
  revokeApiAccessUser: vi.fn(),
  apiBearer: vi.fn(),
  setJsonMode: vi.fn(),
}));

vi.mock('../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: () => ({
    apiAccess: {
      grant: mocks.grantApiAccessUser,
      issueServiceToken: mocks.issueServiceToken,
      rotateServiceToken: mocks.rotateServiceToken,
      list: mocks.listApiAccessUsers,
      revoke: mocks.revokeApiAccessUser,
    },
  }),
}));

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock(() => mocks.apiBearer()),
);

vi.mock('../../../src/cli/commands/shared.js', () => ({}));

vi.mock('../../../src/cli/utils/output.js', () => ({
  printError: mocks.printError,
  printInfo: mocks.printInfo,
  printSuccess: mocks.printSuccess,
  setJsonMode: mocks.setJsonMode,
}));

import {
  createApiAccessCommand,
  createApiTokenCommand,
} from '../../../src/cli/commands/api-access.js';

async function runAccess(argv: string[]): Promise<void> {
  const command = createApiAccessCommand();
  command.exitOverride();
  await command.parseAsync(argv, { from: 'user' });
}

const SERVICE = { kind: 'service', userId: 'service:ci', username: 'ci' };
const SERVICE_TOKEN = `acapi_${'a'.repeat(43)}`;

describe('api access command', () => {
  let exitSpy: MockInstance<typeof process.exit>;
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiBearer.mockResolvedValue('owner-token');
    mocks.grantApiAccessUser.mockResolvedValue({
      kind: 'github',
      userId: '2',
      username: 'member',
    });
    mocks.listApiAccessUsers.mockResolvedValue({
      owner: { userId: '1', username: 'owner' },
      users: [{ kind: 'github', userId: '2', username: 'member' }],
    });
    mocks.revokeApiAccessUser.mockResolvedValue({
      userId: '2',
      username: 'member',
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit:${code ?? 0}`);
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('adds a GitHub user through the active API', async () => {
    await runAccess(['add', 'Member']);

    expect(mocks.grantApiAccessUser).toHaveBeenCalledWith({
      username: 'Member',
    });
    expect(mocks.printSuccess).toHaveBeenCalledWith(
      'Granted hosted API access to member (2).',
    );
  });

  it('lists the owner and allowed users', async () => {
    await runAccess(['list']);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('owner'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('member'));
  });

  it.each(['Member', '2'])(
    'removes a GitHub user by username or immutable id (%s)',
    async (identifier) => {
      await runAccess(['remove', identifier]);

      expect(mocks.listApiAccessUsers).toHaveBeenCalledWith();
      expect(mocks.revokeApiAccessUser).toHaveBeenCalledWith({
        params: { userId: '2' },
      });
      expect(mocks.printSuccess).toHaveBeenCalledWith(
        'member (2) no longer has hosted API access.',
      );
      expect(mocks.printInfo).toHaveBeenCalledWith(
        'Existing workloads were not stopped.',
      );
      expect(mocks.printInfo).toHaveBeenCalledWith(
        'Review them with: anycloud list --user 2',
      );
    },
  );

  it('reports an entry that was already gone as revoked, not failed', async () => {
    mocks.revokeApiAccessUser.mockResolvedValue(null);

    await runAccess(['remove', 'member']);

    expect(mocks.printError).not.toHaveBeenCalled();
    expect(mocks.printSuccess).toHaveBeenCalledWith(
      'member (2) no longer has hosted API access.',
    );
    expect(mocks.printInfo).toHaveBeenCalledWith(
      'Review them with: anycloud list --user 2',
    );
  });

  it.each(['owner', '1'])(
    'refuses to remove the hosted API owner (%s)',
    async (identifier) => {
      await expect(runAccess(['remove', identifier])).rejects.toThrow(
        'process.exit:1',
      );

      expect(mocks.revokeApiAccessUser).not.toHaveBeenCalled();
      expect(mocks.printError).toHaveBeenCalledWith(
        'Failed to remove API access: The hosted API owner cannot be removed',
      );
    },
  );

  it('rejects an unknown removal target before issuing DELETE', async () => {
    await expect(runAccess(['remove', 'unknown'])).rejects.toThrow(
      'process.exit:1',
    );

    expect(mocks.revokeApiAccessUser).not.toHaveBeenCalled();
    expect(mocks.printError).toHaveBeenCalledWith(
      expect.stringContaining('does not have hosted API access'),
    );
  });

  it('emits machine-readable access JSON', async () => {
    await runAccess(['list', '--json']);

    expect(mocks.setJsonMode).toHaveBeenCalledWith(true);
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        owner: { userId: '1', username: 'owner' },
        users: [{ kind: 'github', userId: '2', username: 'member' }],
      }),
    );
  });

  it('issues a service token, printing only the token on stdout, or JSON', async () => {
    mocks.issueServiceToken.mockResolvedValue({
      ...SERVICE,
      token: SERVICE_TOKEN,
    });
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    await runAccess(['add', '--service', 'ci']);
    await runAccess(['add', '--service', 'ci', '--json']);

    expect(mocks.issueServiceToken).toHaveBeenCalledWith({ name: 'ci' });
    expect(mocks.grantApiAccessUser).not.toHaveBeenCalled();
    expect(logSpy.mock.calls).toEqual([
      [SERVICE_TOKEN],
      [JSON.stringify({ ...SERVICE, token: SERVICE_TOKEN })],
    ]);
    expect(stderr).toHaveBeenCalledTimes(1);
    stderr.mockRestore();
  });

  it('rotates a service token through the active API', async () => {
    vi.stubEnv('API_URL', 'https://api.example.com');
    mocks.rotateServiceToken.mockResolvedValue({ token: SERVICE_TOKEN });
    const command = createApiTokenCommand();
    command.exitOverride();

    await command.parseAsync(['rotate', '--service', 'ci', '--json'], {
      from: 'user',
    });

    expect(mocks.rotateServiceToken).toHaveBeenCalledWith({
      params: { name: 'ci' },
    });
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ token: SERVICE_TOKEN }),
    );
    vi.unstubAllEnvs();
  });

  it('removes a service by its name and lists one by its ID', async () => {
    mocks.listApiAccessUsers.mockResolvedValue({
      owner: { userId: '1', username: 'owner' },
      users: [SERVICE],
    });

    await runAccess(['remove', '--service', 'ci']);
    await runAccess(['list']);

    expect(mocks.revokeApiAccessUser).toHaveBeenCalledWith({
      params: { userId: 'service:ci' },
    });
    expect(String(logSpy.mock.calls[0]![0])).toMatch(
      /member\s.*service\s.*ci\s.*service:ci/,
    );
  });

  it('refuses --service beside another target', async () => {
    await expect(
      runAccess(['add', 'member', '--service', 'ci']),
    ).rejects.toThrow('process.exit:1');
    expect(mocks.issueServiceToken).not.toHaveBeenCalled();
  });
});
