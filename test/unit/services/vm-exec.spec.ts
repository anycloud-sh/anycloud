import { describe, it, expect, vi, afterEach } from 'vitest';
import { exec as cpExec, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { runDetachedOnVm } from '../../../src/api/services/vm-exec';
import { SSHExecError } from '../../../src/api/services/gateways/ssh';

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

// Dispatch a mocked exec by command, returning poll responses in sequence
// (repeating the last). A poll response of 'THROW' makes that poll throw an
// SSHExecError — a transient SSH stream drop mid-run. Handles both the systemd
// (systemd-run / systemctl) and no-systemd (nohup / kill) command shapes.
function makeExec(opts: {
  systemd?: boolean;
  poll: string[];
  logTail?: string;
}) {
  let i = 0;
  const calls: string[] = [];
  const fn = vi.fn(async (cmd: string) => {
    calls.push(cmd);
    if (cmd.includes('ps -p 1'))
      return ok(opts.systemd === false ? 'init' : 'systemd');
    if (cmd.includes('systemd-run')) return ok(''); // systemd launch
    if (cmd.includes('nohup')) return ok(''); // no-systemd launch
    if (cmd.includes('tail -c')) return ok(opts.logTail ?? 'work log\n');
    if (cmd.includes('systemctl stop')) return ok(''); // systemd stop
    if (cmd.includes('kill ') && !cmd.includes('kill -0')) return ok(''); // no-systemd stop
    // Poll: systemd 'systemctl is-active …' or no-systemd 'kill -0 …'.
    const r = opts.poll[Math.min(i, opts.poll.length - 1)];
    i++;
    if (r === 'THROW') {
      throw new SSHExecError(
        'SSH stream closed abnormally before command completed',
        '',
        '',
      );
    }
    return ok(r);
  });
  return { fn, calls };
}

const baseOpts = (over: Record<string, unknown> = {}) => ({
  unit: 'ac-test-1',
  command: 'do-work',
  totalTimeoutMs: 300,
  pollIntervalMs: 5,
  controlTimeoutMs: 1000,
  ...over,
});

describe('runDetachedOnVm', () => {
  it('launches a systemd transient unit and resolves once the sentinel reports success', async () => {
    const { fn, calls } = makeExec({
      poll: ['active', 'active', 'DONE 0'],
      logTail: 'pulled ok',
    });

    const res = await runDetachedOnVm(fn, baseOpts() as any);

    expect(res.logTail).toContain('pulled ok');
    expect(calls.some((c) => c.includes('ps -p 1'))).toBe(true); // probed systemd
    expect(
      calls.some((c) => c.includes('systemd-run') && c.includes('ac-test-1')),
    ).toBe(true);
    const poll = calls.find(
      (c) => c.includes('systemctl is-active') && c.includes('.done'),
    )!;
    // The reading after the poll's wait on the VM.
    const probe = poll.slice(poll.indexOf('probe_state='));
    expect(probe.indexOf('systemctl is-active')).toBeLessThan(
      probe.indexOf('[ -f /tmp/ac-test-1.done ]'),
    );
  });

  it('falls back to nohup (not systemd-run) on a host without systemd', async () => {
    // This is the vmstartup regression in unit form: no systemd → must not use systemd-run.
    const { fn, calls } = makeExec({
      systemd: false,
      poll: ['active', 'DONE 0'],
    });

    await expect(runDetachedOnVm(fn, baseOpts() as any)).resolves.toMatchObject(
      {},
    );

    expect(calls.some((c) => c.includes('nohup'))).toBe(true);
    expect(calls.some((c) => c.includes('systemd-run'))).toBe(false);
  });

  it('recovers when a poll hits a transient SSH stream drop mid-run', async () => {
    const { fn } = makeExec({ poll: ['active', 'THROW', 'DONE 0'] });
    await expect(runDetachedOnVm(fn, baseOpts() as any)).resolves.toMatchObject(
      {},
    );
  });

  it('accepts completion that appears while reconciling an inactive worker', async () => {
    const { fn, calls } = makeExec({ poll: ['inactive', 'DONE 0'] });

    await expect(
      runDetachedOnVm(fn, baseOpts({ maxLaunches: 1 }) as any),
    ).resolves.toMatchObject({});

    expect(calls.filter((c) => c.includes('systemd-run'))).toHaveLength(1);
  });

  it('continues without relaunching when reconciliation finds the worker active', async () => {
    const { fn, calls } = makeExec({
      poll: ['inactive', 'active', 'DONE 0'],
    });

    await expect(
      runDetachedOnVm(fn, baseOpts({ maxLaunches: 1 }) as any),
    ).resolves.toMatchObject({});

    expect(calls.filter((c) => c.includes('systemd-run'))).toHaveLength(1);
  });

  it('retries without relaunching when reconciliation hits a transient SSH failure', async () => {
    const { fn, calls } = makeExec({
      poll: ['inactive', 'THROW', 'DONE 0'],
    });

    await expect(
      runDetachedOnVm(fn, baseOpts({ maxLaunches: 1 }) as any),
    ).resolves.toMatchObject({});

    expect(calls.filter((c) => c.includes('systemd-run'))).toHaveLength(1);
  });

  it('throws DetachedRunError (with exit code + log tail) when the run exits non-zero', async () => {
    const { fn, calls } = makeExec({
      poll: ['DONE 1'],
      logTail: 'manifest unknown',
    });

    await expect(
      runDetachedOnVm(fn, baseOpts({ maxLaunches: 2 }) as any),
    ).rejects.toMatchObject({
      name: 'DetachedRunError',
      exitCode: 1,
      logTail: expect.stringContaining('manifest unknown'),
    });
    expect(calls.filter((c) => c.includes('systemd-run')).length).toBe(2); // relaunched to the cap
  });

  it('preserves the log tail when a unit vanishes without a sentinel', async () => {
    const { fn, calls } = makeExec({
      poll: ['inactive'],
      logTail: 'worker failed before recording its result',
    });

    await expect(
      runDetachedOnVm(fn, baseOpts({ maxLaunches: 1 }) as any),
    ).rejects.toMatchObject({
      name: 'DetachedRunError',
      exitCode: null,
      logTail: expect.stringContaining('worker failed'),
    });
    expect(calls.filter((c) => c.includes('systemctl is-active'))).toHaveLength(
      2,
    );
  });

  it('throws and stops the unit if the run never finishes within budget', async () => {
    vi.useFakeTimers();
    const { fn, calls } = makeExec({ poll: ['active'] }); // never completes

    try {
      const run = runDetachedOnVm(
        fn,
        baseOpts({
          totalTimeoutMs: 8_000,
          hasSystemd: true,
        }) as any,
      );
      const error = run.catch((reason) => reason);
      await vi.advanceTimersByTimeAsync(8_100);

      await expect(error).resolves.toMatchObject({
        name: 'DetachedRunError',
        exitCode: null,
        message: 'did not complete within 8 sec',
      });
      expect(
        calls.some(
          (c) => c.includes('systemctl stop') && !c.includes('systemd-run'),
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows an activity-bounded run to exceed any fixed wall-clock duration', async () => {
    let now = 0;
    let polls = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { fn, calls } = makeExec({ poll: [] });
    fn.mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      if (cmd.includes('systemd-run')) return ok('');
      if (cmd.includes('tail -c')) return ok('hydrated');
      if (cmd.includes('systemctl stop')) return ok('');
      if (cmd.includes('systemctl is-active')) {
        now += 8 * 60 * 1000;
        polls++;
        return ok(polls < 4 ? `active\n${polls * 100}` : 'DONE 0');
      }
      return ok('');
    });

    try {
      await expect(
        runDetachedOnVm(
          fn,
          baseOpts({
            totalTimeoutMs: undefined,
            inactivityTimeoutMs: 10 * 60 * 1000,
            pollIntervalMs: 1,
            hasSystemd: true,
          }) as any,
        ),
      ).resolves.toMatchObject({ logTail: 'hydrated' });
      expect(now).toBeGreaterThan(14 * 60 * 1000);
      expect(
        calls.some(
          (c) => c.includes('systemctl stop') && !c.includes('systemd-run'),
        ),
      ).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it('stops an activity-bounded run whose log stops growing', async () => {
    vi.useFakeTimers();
    const { fn, calls } = makeExec({
      poll: ['active\n100'],
      logTail: 'last progress',
    });

    try {
      const run = runDetachedOnVm(
        fn,
        baseOpts({
          totalTimeoutMs: undefined,
          inactivityTimeoutMs: 10,
        }) as any,
      );
      const error = run.catch((reason) => reason);
      await vi.advanceTimersByTimeAsync(100);

      await expect(error).resolves.toMatchObject({
        name: 'DetachedRunError',
        exitCode: null,
        logTail: expect.stringContaining('last progress'),
      });
      expect(
        calls.some(
          (c) => c.includes('systemctl stop') && !c.includes('systemd-run'),
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops an activity-bounded run whose polls keep failing', async () => {
    vi.useFakeTimers();
    const { fn, calls } = makeExec({
      poll: ['THROW'],
      logTail: 'last progress',
    });

    try {
      const run = runDetachedOnVm(
        fn,
        baseOpts({
          totalTimeoutMs: undefined,
          inactivityTimeoutMs: 10,
          hasSystemd: true,
        }) as any,
      );
      const error = run.catch((reason) => reason);
      await vi.advanceTimersByTimeAsync(100);

      // Without a total budget an unreadable worker must still be given up on:
      // the inactivity clock is the only bound, so it has to be consulted when
      // the poll itself fails, not just when it succeeds.
      await expect(error).resolves.toMatchObject({
        name: 'DetachedRunError',
        exitCode: null,
        message: expect.stringContaining('produced no output within'),
      });
      expect(
        calls.some(
          (c) => c.includes('systemctl stop') && !c.includes('systemd-run'),
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('adopts an active detached run after a controller restart', async () => {
    const { fn, calls } = makeExec({
      poll: ['active\n0\nsame-work', 'DONE 0'],
    });

    await expect(
      runDetachedOnVm(
        fn,
        baseOpts({
          hasSystemd: true,
          runIdentity: 'same-work',
        }) as any,
      ),
    ).resolves.toMatchObject({});

    expect(calls.some((c) => c.includes('systemd-run'))).toBe(false);
  });

  it('replaces an active detached run when its identity does not match', async () => {
    const { fn, calls } = makeExec({
      poll: ['active\n0\nstale-work', 'DONE 0'],
    });

    await expect(
      runDetachedOnVm(
        fn,
        baseOpts({
          hasSystemd: true,
          runIdentity: 'current-work',
        }) as any,
      ),
    ).resolves.toMatchObject({});

    expect(calls.some((c) => c.includes('systemd-run'))).toBe(true);
  });

  it('requires either a total or inactivity timeout policy', async () => {
    const { fn } = makeExec({ poll: ['DONE 0'] });
    await expect(
      runDetachedOnVm(fn, baseOpts({ totalTimeoutMs: undefined }) as any),
    ).rejects.toThrow('requires a total or inactivity timeout policy');
  });

  it('skips the probe when hasSystemd is supplied', async () => {
    const { fn, calls } = makeExec({ poll: ['DONE 0'] });
    await runDetachedOnVm(fn, baseOpts({ hasSystemd: true }) as any);
    expect(calls.some((c) => c.includes('ps -p 1'))).toBe(false);
  });

  it('passes env via --setenv (not inlined into the command body)', async () => {
    const { fn, calls } = makeExec({ poll: ['DONE 0'] });
    await runDetachedOnVm(
      fn,
      baseOpts({
        command: 'echo "$AC_IMG"',
        env: { AC_IMG: 'ghcr.io/x:latest' },
      }) as any,
    );
    const launch = calls.find((c) => c.includes('systemd-run'))!;
    expect(launch).toContain('--setenv=AC_IMG=');
    // command body references the var (systemd-escaped), not the literal value
    expect(launch).toContain('echo "$$AC_IMG"');
  });

  it('escapes $ so systemd hands sh the script verbatim', async () => {
    const command =
      'ref=${AC_PULL_IMAGE#ghcr.io/}; repo=${ref%%@*}; echo "$repo" $? $$';
    const { fn, calls } = makeExec({ poll: ['DONE 0'] });
    await runDetachedOnVm(fn, baseOpts({ command }) as any);

    const launch = calls.find((c) => c.includes('systemd-run'))!;
    const quoted = launch.slice(launch.indexOf('/bin/sh -c ') + 11);
    // Unquote with a real shell, as the SSH session does.
    const systemdArg = execFileSync(
      '/bin/sh',
      ['-c', `printf '%s' ${quoted}`],
      {
        encoding: 'utf8',
      },
    );
    // Every run of `$` is even, so systemd expands no `${…}` …
    expect(systemdArg).not.toMatch(/(?:^|[^$])(?:\$\$)*\$(?!\$)/);
    // … and systemd's `$$` → `$` restores the original script.
    const script = systemdArg.replace(/\$\$/g, '$');
    expect(script.startsWith(`(\n${command}\n) > /tmp/ac-test-1.log`)).toBe(
      true,
    );
    expect(script).toContain('exit_code=$?');
  });

  it('leaves the nohup script unescaped', async () => {
    const command = 'echo ${AC_IMG#ghcr.io/}';
    const { fn, calls } = makeExec({ systemd: false, poll: ['DONE 0'] });
    await runDetachedOnVm(fn, baseOpts({ command }) as any);

    const launch = calls.find((c) => c.includes('nohup'))!;
    expect(launch).toContain(command);
    expect(launch).not.toContain('$$');
  });
});

// Real-shell integration: run the actual nohup / pidfile / sentinel / poll command
// strings against a local POSIX shell. The mocked-exec tests above cover the loop
// logic but never execute the real commands, so a quoting / `& echo $! > pid` bug
// would slip past them. Forces the no-systemd `nohup` path (portable to macOS +
// Linux CI; the systemd path is covered by the real-VM e2e legs).
function shellExec(cmd: string, timeoutMs?: number) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      cpExec(
        cmd,
        { shell: '/bin/sh', timeout: timeoutMs ?? 10_000 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`exit ${(err as { code?: number }).code ?? 1}`));
          } else {
            resolve({
              code: 0,
              stdout: String(stdout),
              stderr: String(stderr),
            });
          }
        },
      );
    },
  );
}

describe('runDetachedOnVm against a real local shell (nohup path)', () => {
  const units: string[] = [];
  const realOpts = (unit: string, over: Record<string, unknown> = {}) => {
    units.push(unit);
    return {
      unit,
      command: 'true',
      hasSystemd: false, // exercise the portable nohup path for real
      totalTimeoutMs: 8_000,
      pollIntervalMs: 40,
      controlTimeoutMs: 8_000,
      ...over,
    };
  };
  afterEach(() => {
    for (const u of units.splice(0)) {
      for (const ext of ['done', 'identity', 'log', 'pid']) {
        rmSync(`/tmp/${u}.${ext}`, { force: true });
      }
    }
  });

  it('runs a real detached command to success and returns its log output', async () => {
    const unit = `ac-it-ok-${process.pid}`;
    const res = await runDetachedOnVm(
      shellExec,
      realOpts(unit, { command: "printf 'hello detached'" }) as never,
    );
    expect(res.logTail).toContain('hello detached');
    expect(existsSync(`/tmp/${unit}.done`)).toBe(true);
  });

  it('sees a result within half a second, in one poll that waits on the VM', async () => {
    let polls = 0;
    const exec = (cmd: string, timeoutMs?: number) => {
      if (cmd.includes('[ -f /tmp/ac-it-wait-')) polls++;
      return shellExec(cmd, timeoutMs);
    };
    const startedAt = Date.now();
    await runDetachedOnVm(
      exec,
      realOpts(`ac-it-wait-${process.pid}`, {
        command: 'sleep 2',
        pollIntervalMs: 15_000,
        totalTimeoutMs: 20_000,
      }) as never,
    );
    // Polls backed off from half a second would see it at 3.5 s, in three.
    expect(Date.now() - startedAt).toBeLessThan(3_200);
    expect(polls).toBe(1);
  });

  it('surfaces a non-zero exit from the real detached command', async () => {
    await expect(
      runDetachedOnVm(
        shellExec,
        realOpts(`ac-it-fail-${process.pid}`, {
          command: '(exit 7)',
          maxLaunches: 1,
        }) as never,
      ),
    ).rejects.toMatchObject({ name: 'DetachedRunError', exitCode: 7 });
  });

  it('records a failure even when the worker enables shell errexit', async () => {
    await expect(
      runDetachedOnVm(
        shellExec,
        realOpts(`ac-it-errexit-${process.pid}`, {
          command: 'set -eu\nfalse',
          maxLaunches: 1,
        }) as never,
      ),
    ).rejects.toMatchObject({ name: 'DetachedRunError', exitCode: 1 });
  });

  it('times out (and stops) a real long-running detached command', async () => {
    await expect(
      runDetachedOnVm(
        shellExec,
        realOpts(`ac-it-timeout-${process.pid}`, {
          command: 'sleep 3',
          totalTimeoutMs: 300,
        }) as never,
      ),
    ).rejects.toMatchObject({ name: 'DetachedRunError', exitCode: null });
  });

  it('adopts a real in-flight run whose recorded identity matches', async () => {
    const unit = `ac-it-adopt-${process.pid}`;
    const identity = 'a'.repeat(64);
    const opts = () =>
      realOpts(unit, { command: 'sleep 3', runIdentity: identity }) as never;

    const first = runDetachedOnVm(shellExec, opts());
    let launchedPid = '';
    while (!launchedPid) {
      launchedPid = existsSync(`/tmp/${unit}.pid`)
        ? readFileSync(`/tmp/${unit}.pid`, 'utf8').trim()
        : '';
      if (!launchedPid) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(readFileSync(`/tmp/${unit}.identity`, 'utf8').trim()).toBe(identity);

    // A second controller asking for the same work must reattach to the running
    // worker, not kill it and start over — the restart case the e2e leg proves
    // against a real VM.
    await Promise.all([first, runDetachedOnVm(shellExec, opts())]);
    expect(readFileSync(`/tmp/${unit}.pid`, 'utf8').trim()).toBe(launchedPid);
  }, 20_000);
});
