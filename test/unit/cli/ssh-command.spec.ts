import { EventEmitter } from 'events';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

const { spawnMock, writeFileSyncMock, unlinkSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  unlinkSyncMock: vi.fn(),
}));
const api = vi.hoisted(() => ({ getSshAccess: vi.fn() }));
const runtime = vi.hoisted(() => ({ getAnycloudVersion: vi.fn() }));

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('fs', () => ({
  writeFileSync: writeFileSyncMock,
  unlinkSync: unlinkSyncMock,
}));

vi.mock('../../../src/cli/commands/shared.js', () => ({
  resolveWorkloadId: vi.fn(),
}));

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock(),
);

vi.mock('../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: () => ({
    workloads: { sshAccess: api.getSshAccess },
  }),
}));

vi.mock('../../../src/shared/services/api-client/runtime.js', () => ({
  getAnycloudVersion: runtime.getAnycloudVersion,
}));

vi.mock('../../../src/cli/utils/output.js', () => ({
  printError: vi.fn(),
  printInfo: vi.fn(),
}));

import {
  buildSshRemoteCommand,
  createSshCommand,
} from '../../../src/cli/commands/ssh.js';
import { resolveWorkloadId } from '../../../src/cli/commands/shared.js';
import { printError } from '../../../src/cli/utils/output.js';

const getAnycloudVersion = runtime.getAnycloudVersion;
const getSshAccess = api.getSshAccess;

describe('createSshCommand', () => {
  const savedExitCode = process.exitCode;
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(() => {
    process.exitCode = undefined;
    vi.clearAllMocks();
    vi.mocked(resolveWorkloadId).mockResolvedValue('dep-1');
    vi.mocked(getAnycloudVersion).mockReturnValue('0.0.0-test');
    vi.mocked(getSshAccess).mockResolvedValue({
      workloadId: 'dep-1',
      vmIp: '10.0.0.1',
      sshHost: 'ssh.example.com',
      sshPort: 2222,
      sshUsername: 'ubuntu',
      sshPrivateKey: 'test-private-key',
    });
    spawnMock.mockImplementation(() => {
      const proc = new EventEmitter();
      queueMicrotask(() => proc.emit('close', 0));
      return proc;
    });
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
    exitSpy.mockRestore();
  });

  it('shows host, VM alias, and snapshot modes in help', () => {
    const help = createSshCommand().helpInformation();

    expect(help).toContain('--host');
    expect(help).toContain('--vm');
    expect(help).toContain('--snapshot');
  });

  it('requests container SSH access by default and runs docker exec', async () => {
    await createSshCommand().parseAsync(['node', 'test', 'dep-1']);

    expect(getSshAccess).toHaveBeenCalledWith({
      params: { id: 'dep-1' },
      query: { mode: 'container' },
    });
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining('anycloud-ssh-dep-1-'),
      'test-private-key',
      { mode: 0o600 },
    );
    const sshArgs = spawnMock.mock.calls[0][1] as string[];
    expect(spawnMock.mock.calls[0][0]).toBe('ssh');
    expect(sshArgs).toContain('-i');
    expect(sshArgs).toContain('2222');
    expect(sshArgs).toContain('ubuntu@ssh.example.com');
    expect(sshArgs.at(-1)).toContain('docker exec -it');
    expect(sshArgs.at(-1)).toContain("'dep-1'");
    expect(sshArgs.at(-1)).toContain('/bin/sh');
    expect(unlinkSyncMock).toHaveBeenCalledWith(
      expect.stringContaining('anycloud-ssh-dep-1-'),
    );
  });

  it('requests VM mode and does not send a remote docker command', async () => {
    await createSshCommand().parseAsync(['node', 'test', 'dep-1', '--vm']);

    expect(getSshAccess).toHaveBeenCalledWith(
      expect.objectContaining({ query: { mode: 'vm' } }),
    );
    const sshArgs = spawnMock.mock.calls[0][1] as string[];
    expect(sshArgs.at(-1)).toBe('ubuntu@ssh.example.com');
  });

  it('uses --host as the preferred spelling for VM mode', async () => {
    await createSshCommand().parseAsync(['node', 'test', 'dep-1', '--host']);

    expect(getSshAccess).toHaveBeenCalledWith(
      expect.objectContaining({ query: { mode: 'vm' } }),
    );
    const sshArgs = spawnMock.mock.calls[0][1] as string[];
    expect(sshArgs.at(-1)).toBe('ubuntu@ssh.example.com');
  });

  it('requests snapshot mode and builds a snapshot shell command', async () => {
    await createSshCommand().parseAsync([
      'node',
      'test',
      'dep-1',
      '--snapshot',
    ]);

    expect(getSshAccess).toHaveBeenCalledWith(
      expect.objectContaining({ query: { mode: 'snapshot' } }),
    );
    const sshArgs = spawnMock.mock.calls[0][1] as string[];
    expect(sshArgs.at(-1)).toContain('docker commit');
    expect(sshArgs.at(-1)).toContain("'dep-1-snapshot'");
    expect(sshArgs.at(-1)).toContain('/bin/sh');
  });

  it('rejects conflicting VM and snapshot modes', async () => {
    await expect(
      createSshCommand().parseAsync([
        'node',
        'test',
        'dep-1',
        '--vm',
        '--snapshot',
      ]),
    ).rejects.toThrow('process.exit:1');

    expect(printError).toHaveBeenCalledWith(
      'Choose only one of --host, --vm, or --snapshot.',
    );
    expect(getSshAccess).not.toHaveBeenCalled();
  });

  it('builds escaped remote commands', () => {
    expect(buildSshRemoteCommand("dep'1", 'container')).toContain(
      "'dep'\\''1'",
    );
    expect(buildSshRemoteCommand('dep-1', 'vm')).toBeUndefined();
  });
});
