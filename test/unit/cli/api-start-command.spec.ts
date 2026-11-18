import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SSH_RUNTIME_TMPFS } from '../../../src/shared/ssh-runtime.js';

const { spawnSyncMock, spawnMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawnSync: spawnSyncMock,
  spawn: spawnMock,
}));

const spinner = {
  text: '',
  start: vi.fn(() => spinner),
  stop: vi.fn(),
  fail: vi.fn(),
};

vi.mock('../../../src/cli/utils/output.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/cli/utils/output.js')>();
  return {
    ...actual,
    createSpinner: vi.fn(() => spinner),
    printInfo: vi.fn(),
    printError: vi.fn(),
    printWarning: vi.fn(),
  };
});

import { createApiCommand } from '../../../src/cli/commands/api.js';
import {
  printError,
  printInfo,
  printWarning,
} from '../../../src/cli/utils/output.js';

function dockerResult(
  overrides: Partial<ReturnType<typeof spawnSyncMock>> = {},
) {
  return {
    status: 0,
    stdout: '',
    stderr: '',
    ...overrides,
  };
}

function configureDockerSuccess() {
  spawnSyncMock.mockImplementation((_cmd: string, args: string[] = []) => {
    if (args[0] === 'info') return dockerResult();
    if (args[0] === 'logs') return dockerResult({ status: 1 });
    if (args[0] === 'run') return dockerResult({ stdout: 'container-id\n' });
    if (args[0] === 'inspect' && args.includes('anycloud-conductor')) {
      return dockerResult({ stdout: 'false\n' });
    }
    if (args[0] === 'inspect' && args.includes('anycloud-api')) {
      return dockerResult({ stdout: 'false\n' });
    }
    return dockerResult();
  });
}

async function runStart(argv: string[]) {
  const cmd = createApiCommand();
  cmd.exitOverride();
  await cmd.parseAsync(['start', ...argv], { from: 'user' });
}

function dockerRunArgs(): string[] {
  const call = spawnSyncMock.mock.calls.find(
    ([cmd, args]) =>
      cmd === 'docker' && Array.isArray(args) && args[0] === 'run',
  );
  expect(call).toBeDefined();
  return call?.[1] as string[];
}

describe('api start command', () => {
  let anycloudDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    spinner.text = '';
    anycloudDir = mkdtempSync(path.join(tmpdir(), 'anycloud-api-start-'));
    vi.stubEnv('ANYCLOUD_DIR', anycloudDir);
    vi.stubEnv('ANYCLOUD_API_LABEL', 'tester@workstation');
    vi.stubEnv('IS_TEST', 'true');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    configureDockerSuccess();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(anycloudDir, { recursive: true, force: true });
  });

  it('binds the local API to loopback with private state and SSH runtime storage', async () => {
    await runStart(['--port', '9090']);

    const args = dockerRunArgs();
    expect(args).toContain('127.0.0.1:9090:8080');
    expect(args).toContain(`${anycloudDir}:/root/.anycloud`);
    expect(args).toContain('ANYCLOUD_API_LABEL=tester@workstation');
    expect(args).toContain('--tmpfs');
    expect(args).toContain(SSH_RUNTIME_TMPFS);
    expect(args.join(' ')).not.toContain('/var/run/docker.sock');
    expect(args.filter((arg) => arg === '-v')).toHaveLength(1);
  });

  it('writes an owner-only local API token and keeps a valid one', async () => {
    const tokenPath = path.join(anycloudDir, 'local-api-token');
    await runStart([]);
    const first = readFileSync(tokenPath, 'utf8');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);

    await runStart([]);
    expect(readFileSync(tokenPath, 'utf8')).toBe(first);
  });

  it('replaces a malformed local API token', async () => {
    const tokenPath = path.join(anycloudDir, 'local-api-token');
    writeFileSync(tokenPath, 'not-a-token', { mode: 0o644 });
    await runStart([]);
    expect(readFileSync(tokenPath, 'utf8')).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it('does not expose a Local runtime opt-in', () => {
    const start = createApiCommand().commands.find(
      (command) => command.name() === 'start',
    );
    expect(start?.options.map((option) => option.long)).not.toContain(
      '--enable-local-docker',
    );
  });

  it('uses an explicit --version to select the image tag and label instead of the CLI version', async () => {
    await runStart(['--port', '9092', '--version', '1.2.3']);

    const args = dockerRunArgs();
    expect(args).toContain('ghcr.io/anycloud-sh/api:1.2.3');
    expect(args).toContain('sh.anycloud.version=1.2.3');
  });

  it('rejects an invalid --version value', async () => {
    const cmd = createApiCommand();
    // exitOverride() only affects the command it's called on, not
    // subcommands already attached via addCommand() — override the
    // 'start' subcommand itself so its option-parser errors reject
    // instead of calling process.exit().
    const start = cmd.commands.find((c) => c.name() === 'start');
    start
      ?.exitOverride()
      .configureOutput({ writeErr: () => {}, writeOut: () => {} });

    await expect(
      cmd.parseAsync(
        ['start', '--port', '9093', '--version', 'not-a-version'],
        { from: 'user' },
      ),
    ).rejects.toMatchObject({ code: 'commander.invalidArgument' });
  });

  describe('waiting for health', () => {
    // After `docker run`, the container is up until `exitsAfterMs` has
    // passed, `docker inspect` answers as `inspect` says, and /health answers
    // once `healthyAfterMs` has passed.
    function startSlowly(opts: {
      healthyAfterMs?: number;
      exitsAfterMs?: number;
      inspect?: ReturnType<typeof dockerResult>;
    }) {
      vi.useFakeTimers();
      let runAt: number | null = null;
      spawnSyncMock.mockImplementation((_cmd: string, args: string[] = []) => {
        if (args[0] === 'run') runAt = Date.now();
        if (args[0] === 'inspect' && args.includes('anycloud-api')) {
          if (runAt !== null && opts.inspect) return opts.inspect;
          const running =
            runAt !== null &&
            (opts.exitsAfterMs === undefined ||
              Date.now() - runAt < opts.exitsAfterMs);
          return dockerResult({ stdout: `${running}\tnull\n` });
        }
        if (args[0] === 'logs') return dockerResult({ status: 1 });
        return dockerResult();
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          const up =
            opts.healthyAfterMs !== undefined &&
            runAt !== null &&
            Date.now() - runAt >= opts.healthyAfterMs;
          if (!up) throw new TypeError('fetch failed');
          return { ok: true };
        }),
      );
      vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`exit ${code}`);
      });
      const start = runStart(['--port', '9094']).catch((e: Error) => e);
      return { start, advance: () => vi.advanceTimersByTimeAsync(130_000) };
    }

    function restartPolicySet(): boolean {
      return spawnSyncMock.mock.calls.some(
        ([, args]) => args[0] === 'update' && args.includes('unless-stopped'),
      );
    }

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('waits past the old 15s budget, shows progress, and sets the restart policy', async () => {
      const { start, advance } = startSlowly({ healthyAfterMs: 40_000 });
      await advance();

      expect(await start).toBeUndefined();
      expect(printInfo).toHaveBeenCalledWith('Still starting after 15s...');
      expect(printInfo).toHaveBeenCalledWith('Still starting after 30s...');
      expect(restartPolicySet()).toBe(true);
    });

    it.each([
      ['at once', 0, 1_000],
      ['in the last window', 119_800, 130_000],
    ])(
      'reports a container that exits %s as exited',
      async (_case, exitsAfterMs, waitMs) => {
        const { start } = startSlowly({ exitsAfterMs });
        await vi.advanceTimersByTimeAsync(waitMs);

        expect(await start).toEqual(new Error('exit 1'));
        expect(printError).toHaveBeenCalledWith(
          'The API server container exited before it was healthy.',
        );
        expect(printInfo).toHaveBeenCalledWith(
          'Check logs with: docker logs anycloud-api',
        );
        expect(restartPolicySet()).toBe(false);
      },
    );

    it('reports a container still running at the deadline as still starting', async () => {
      const { start, advance } = startSlowly({});
      await advance();

      expect(await start).toEqual(new Error('exit 4'));
      expect(printWarning).toHaveBeenCalledWith(
        expect.stringContaining('still starting after 120s'),
      );
      expect(printInfo).toHaveBeenCalledWith(
        'Check it with: anycloud api status',
      );
      expect(restartPolicySet()).toBe(true);
    });

    it.each([
      [
        'cannot reach the daemon',
        dockerResult({ status: 1, stderr: 'error during connect' }),
      ],
      [
        'times out',
        dockerResult({
          status: null,
          error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
        }),
      ],
    ])('keeps waiting when docker inspect %s', async (_case, inspect) => {
      const { start, advance } = startSlowly({
        healthyAfterMs: 20_000,
        inspect,
      });
      await advance();

      expect(await start).toBeUndefined();
      expect(printError).not.toHaveBeenCalled();
      expect(restartPolicySet()).toBe(true);
    });
  });
});
