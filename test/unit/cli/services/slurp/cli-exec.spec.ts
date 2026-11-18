import { execa } from 'execa';
import { platform } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  execAsync,
  isCliInstalled,
  spawnInteractive,
} from '../../../../../src/cli/services/slurp/cli-exec.js';
import { cliFixture } from '../../../services/credential-bootstrap/cli-fixture.js';

vi.mock('execa', { spy: true });
vi.mock('os', { spy: true });
afterEach(() => {
  vi.clearAllMocks();
  vi.mocked(platform).mockReset();
  vi.unstubAllEnvs();
});

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const nodeCommand = (script: string) =>
  `${quote(process.execPath)} -e ${quote(script)}`;

describe('cli-exec utilities', () => {
  it.each(['', 'plain', 'LF\n', 'CRLF\r\n', ' \t\n\n', 'é😀\n'])(
    'preserves exact captured output %j',
    async (output) => {
      await expect(
        execAsync(
          nodeCommand(`process.stdout.write(${JSON.stringify(output)})`),
        ),
      ).resolves.toBe(output);
    },
  );

  it('preserves shell syntax and replaces an explicitly supplied environment', async () => {
    await expect(execAsync('printf first && printf second')).resolves.toBe(
      'firstsecond',
    );
    vi.stubEnv('CLI_AMBIENT_MARKER', 'ambient');
    const command = nodeCommand(
      'process.stdout.write(JSON.stringify({selected:process.env.CLI_SELECTED,ambient:process.env.CLI_AMBIENT_MARKER}))',
    );
    await expect(
      execAsync(command, { env: { CLI_SELECTED: 'selected' } }),
    ).resolves.toBe('{"selected":"selected"}');
  });

  it('keeps stderr-first errors and the empty-stderr fallback', async () => {
    await expect(
      execAsync(
        nodeCommand('process.stderr.write("failure\\r\\n");process.exitCode=7'),
      ),
    ).rejects.toThrow('failure\r\n');
    const command = nodeCommand('process.exitCode=7');
    await expect(execAsync(command)).rejects.toThrow(
      `Command failed: ${command}\n`,
    );
  });

  it('decodes raw bytes as UTF-8 without altering their capture', async () => {
    const bytes = Array.from({ length: 256 }, (_, value) => value);
    const fixture = await cliFixture('raw-output', { stdoutBytes: bytes });
    await expect(
      execAsync(quote(fixture.executable), { env: fixture.environment }),
    ).resolves.toBe(Buffer.from(bytes).toString('utf8'));
    expect(await fixture.signalCount()).toBe(0);
  });

  it.each(['stdout', 'stderr'] as const)(
    'terminates on %s overflow even when a helper holds the other pipe',
    async (stream) => {
      const limit = 'é'.repeat(512 * 1024);
      const fixture = await cliFixture('output-limit', {
        stdout: limit,
        stderr: limit,
      });
      const command = `exec ${quote(fixture.executable)}`;
      await expect(execAsync(command)).resolves.toBe(limit);
      await fixture.respond({
        [stream]: limit + '!',
        wait: true,
        holdPipe: stream === 'stdout' ? 'stderr' : 'stdout',
      });
      let error: unknown;
      const pending = execAsync(command).catch((value: unknown) => {
        error = value;
      });
      try {
        const { pid, helperPid } = await vi.waitFor(fixture.observed);
        await vi.waitFor(() => expect(error).toBeInstanceOf(Error));
        expect((error as Error).message).toBe(
          stream === 'stdout' ? 'stdout maxBuffer length exceeded' : limit,
        );
        expect(() => process.kill(pid, 0)).toThrow();
        expect(process.kill(helperPid!, 0)).toBe(true);
        expect(await fixture.signalCount()).toBe(1);
      } finally {
        await fixture.cleanup();
        await pending;
      }
    },
  );

  it('checks installed and missing tools using their version commands', async () => {
    await expect(isCliInstalled(quote(process.execPath))).resolves.toBe(true);
    await expect(isCliInstalled('nonexistent-anycloud-cli-1231')).resolves.toBe(
      false,
    );
  });

  it('preserves interactive success, nonzero exits, signals, and launch failures', async () => {
    await expect(
      spawnInteractive(process.execPath, ['-e', '']),
    ).resolves.toBeUndefined();
    await expect(
      spawnInteractive(process.execPath, ['-e', 'process.exitCode=7']),
    ).rejects.toThrow(`${process.execPath} exited with code 7`);
    await expect(
      spawnInteractive(process.execPath, [
        '-e',
        'process.kill(process.pid,"SIGTERM")',
      ]),
    ).rejects.toThrow(`${process.execPath} exited with code null`);
    await expect(
      spawnInteractive('nonexistent-anycloud-cli-1231', []),
    ).rejects.toThrow('Failed to execute nonexistent-anycloud-cli-1231:');
  });

  it.each(['win32', 'darwin'] as const)(
    'keeps terminal and shell options on %s',
    async (os) => {
      vi.mocked(platform).mockReturnValueOnce(os);
      vi.mocked(execa).mockResolvedValueOnce(undefined as never);
      await spawnInteractive('tool', ['literal argument']);
      expect(execa).toHaveBeenCalledWith(
        'tool',
        ['literal argument'],
        expect.objectContaining({
          stdio: 'inherit',
          windowsHide: false,
          shell: os === 'win32',
          cleanup: false,
          forceKillAfterDelay: false,
        }),
      );
    },
  );
});
