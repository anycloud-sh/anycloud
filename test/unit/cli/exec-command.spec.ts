import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';

vi.mock('../../../src/cli/commands/shared.js', () => ({
  resolveWorkloadId: vi.fn(),
}));

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock(),
);

vi.mock('../../../src/shared/services/api-client/native.js', () => ({
  executeWorkloadCommand: vi.fn(),
}));

vi.mock('../../../src/shared/services/api-client/runtime.js', () => ({
  getAnycloudVersion: vi.fn(),
}));

vi.mock('../../../src/cli/utils/output.js', () => ({
  printError: vi.fn(),
}));

import { createExecCommand } from '../../../src/cli/commands/exec.js';
import { resolveWorkloadId } from '../../../src/cli/commands/shared.js';
import { nativeApiBearer } from '../../../src/cli/services/auth.js';
import { executeWorkloadCommand } from '../../../src/shared/services/api-client/native.js';
import { getAnycloudVersion } from '../../../src/shared/services/api-client/runtime.js';

describe('createExecCommand', () => {
  const savedExitCode = process.exitCode;
  let exitSpy: MockInstance<typeof process.exit>;
  let stdoutSpy: MockInstance<typeof process.stdout.write>;
  let stderrSpy: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    process.exitCode = undefined;
    vi.clearAllMocks();
    vi.mocked(resolveWorkloadId).mockResolvedValue('dep-1');
    vi.mocked(nativeApiBearer).mockResolvedValue('gh-token');
    vi.mocked(getAnycloudVersion).mockReturnValue('0.0.0-test');
    vi.mocked(executeWorkloadCommand).mockImplementation(
      async (
        _accessToken,
        _request,
        handlers: {
          stdout?: (chunk: Buffer) => void | Promise<void>;
        } = {},
      ) => {
        await handlers.stdout?.(Buffer.from('out\n'));
        return 0;
      },
    );
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('help exposes one provider-neutral runtime command surface', () => {
    const help = createExecCommand().helpInformation();

    expect(help).toContain("running workload's container");
    expect(help).not.toContain('workload container');
    expect(help).not.toContain('--vm');
  });

  it('executes through the API and prints stdout', async () => {
    await createExecCommand().parseAsync(['node', 'test', 'dep-1', 'echo ok']);

    expect(executeWorkloadCommand).toHaveBeenCalledWith(
      'gh-token',
      {
        id: 'dep-1',
        command: 'echo ok',
      },
      expect.objectContaining({
        stdout: expect.any(Function),
        stderr: expect.any(Function),
      }),
    );
    expect(stdoutSpy).toHaveBeenCalledWith(Buffer.from('out\n'));
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('prints stderr and exits with the remote exit code', async () => {
    vi.mocked(executeWorkloadCommand).mockImplementation(
      async (
        _accessToken,
        _request,
        handlers: {
          stderr?: (chunk: Buffer) => void | Promise<void>;
        } = {},
      ) => {
        await handlers.stderr?.(Buffer.from('bad\n'));
        return 42;
      },
    );

    await createExecCommand().parseAsync(['node', 'test', 'dep-1', 'false']);

    expect(stderrSpy).toHaveBeenCalledWith(Buffer.from('bad\n'));
    expect(process.exitCode).toBe(42);
  });

  it('rejects the removed host diagnostic flag', async () => {
    await expect(
      createExecCommand().parseAsync([
        'node',
        'test',
        'dep-1',
        '--vm',
        'df -h',
      ]),
    ).rejects.toThrow('process.exit:1');

    expect(executeWorkloadCommand).not.toHaveBeenCalled();
  });
});
