/**
 * Regression for an indefinite SSH stream starving later VM operations.
 *
 * The legacy pool retired a connection after five minutes, but waited for every
 * active channel to drain before replacing it. A log follower is deliberately
 * indefinite, so the first command after that age waited forever. Advancing
 * Date.now() preserves the original regression trigger without a five-minute
 * sleep; real timers still bound the responsiveness assertion.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  SSHManager,
  sshRuntimeDirectory,
} from '../../src/api/services/gateways/ssh';
import { channelBoundCommand } from '../../src/api/services/gateways/channel-bound-command';
import * as sshProcesses from '../../src/api/services/gateways/ssh-process';
import {
  createTransport,
  createUserTransport,
} from '../../src/api/services/gateways/transport';
import type { VmTransport } from '../../src/api/services/gateways/transport-contract';
import {
  startSshdContainer,
  type SshdContainer,
} from './helpers/sshd-container';

const SSH_PORT = 2226;
const FOLLOW_COMMAND = "echo anycloud-follow-ready; sh -c 'sleep 34567'";
const FOLLOW_PATTERN = 'sleep 3456[7]';
const LEGACY_MAX_AGE_MS = 5 * 60 * 1000;
const SHORT_COMMAND_DEADLINE_MS = 3_000;
const TIMEOUT_COMMAND = "echo timeout-ready; sh -c 'sleep 45678'";
const TIMEOUT_PATTERN = 'sleep 4567[8]';
const SILENT_COMMAND = "sh -c 'sleep 33221'";
const SILENT_PATTERN = 'sleep 3322[1]';
const RECOVERED_COMMAND = 'sleep 5; printf master-loss-recovered';
const RECOVERED_PATTERN = 'master-loss-recovere[d]';
const USER_FOLLOWER_COUNT = 10;
const USER_FOLLOW_PATTERN = 'sleep 5678[9]';
const CAPACITY_FOLLOW_PATTERN = 'sleep 6789[0]';
const CAPACITY_SENTINEL = '/tmp/anycloud-user-capacity-overflow';

function ownedClientPid(marker: string): number {
  const listing = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
  });
  expect(listing.status).toBe(0);
  const lines = listing.stdout.split('\n');
  const owners = new Set([process.pid]);
  for (const line of lines) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (
      match &&
      Number(match[2]) === process.pid &&
      /ssh-process-helper\.(ts|js)/.test(match[3])
    )
      owners.add(Number(match[1]));
  }
  const clients = lines.flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    return match &&
      owners.has(Number(match[2])) &&
      /(?:^|\/)ssh\s/.test(match[3]) &&
      match[3].includes(marker)
      ? [Number(match[1])]
      : [];
  });
  expect(clients).toHaveLength(1);
  return clients[0];
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Short SSH command was starved by an active follower for ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function settlesWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(label + ' did not settle within ' + timeoutMs + 'ms'),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('SSH stream starvation regression', () => {
  let container: SshdContainer;
  let ssh: SSHManager;

  beforeAll(async () => {
    container = await startSshdContainer({
      tag: 'ssh-starvation-test',
      port: SSH_PORT,
    });
    ssh = new SSHManager('127.0.0.1', container.privateKey, SSH_PORT);
  }, 180_000);

  afterAll(async () => {
    await SSHManager.closeConnection('127.0.0.1', SSH_PORT);
    container?.stop();
  });

  async function remoteProcessCount(pattern = FOLLOW_PATTERN): Promise<number> {
    const { stdout } = await ssh.exec("pgrep -f '" + pattern + "' | wc -l", 1);
    return Number(stdout.trim());
  }

  function containerProcessCount(pattern = FOLLOW_PATTERN): number {
    const result = spawnSync(
      'docker',
      [
        'exec',
        container.containerId,
        'sh',
        '-c',
        `pgrep -f '${pattern}' | wc -l`,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    return Number(result.stdout.trim());
  }

  function controlPaths(): string[] {
    const directory = sshRuntimeDirectory();
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => name.startsWith('cm-'))
      .map((name) => join(directory, name));
  }

  async function closeMasters(): Promise<void> {
    await SSHManager.closeConnection('127.0.0.1', SSH_PORT);
  }

  function controlMasterCheck(controlPath: string) {
    return spawnSync(
      'ssh',
      [
        '-F',
        '/dev/null',
        '-S',
        controlPath,
        '-O',
        'check',
        '-p',
        String(SSH_PORT),
        '-l',
        'root',
        '--',
        '127.0.0.1',
      ],
      { encoding: 'utf8' },
    );
  }

  function controlMasterIsLive(controlPath: string): boolean {
    return controlMasterCheck(controlPath).status === 0;
  }

  function controlMasterPid(controlPath: string): number {
    const result = controlMasterCheck(controlPath);
    expect(result.status).toBe(0);
    const match = (result.stderr + result.stdout).match(/pid=(\d+)/);
    if (!match) {
      throw new Error(
        'OpenSSH did not report a control-master pid: ' +
          result.stderr +
          result.stdout,
      );
    }
    return Number(match[1]);
  }

  it('keeps short commands responsive while an old follower remains active', async () => {
    const controller = new AbortController();
    let followerSettled = false;
    let readyOutput = '';
    let resolveReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const follower = ssh
      .execStream(channelBoundCommand(FOLLOW_COMMAND), {
        signal: controller.signal,
        onStdout: (chunk) => {
          readyOutput += chunk.toString();
          if (readyOutput.includes('anycloud-follow-ready')) resolveReady?.();
        },
      })
      .finally(() => {
        followerSettled = true;
      });

    await within(ready, 20_000);
    await vi.waitFor(
      async () => expect(await remoteProcessCount()).toBeGreaterThan(0),
      { timeout: 20_000, interval: 500 },
    );

    const actualNow = Date.now;
    const agedNow = actualNow() + LEGACY_MAX_AGE_MS + 1;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => agedNow);
    let shortCommand:
      | Promise<{ stdout: string; stderr: string; code: number }>
      | undefined;

    try {
      shortCommand = ssh.exec('printf short-command-ready', 1, false, 5_000);
      const result = await within(shortCommand, SHORT_COMMAND_DEADLINE_MS);

      expect(result.stdout).toBe('short-command-ready');
      expect(followerSettled).toBe(false);
      expect(await remoteProcessCount()).toBeGreaterThan(0);
    } finally {
      nowSpy.mockRestore();
      controller.abort(new Error('Test cleanup'));
      await expect(follower).rejects.toThrow('SSH command aborted');
      await shortCommand?.catch(() => undefined);
    }

    await vi.waitFor(async () => expect(await remoteProcessCount()).toBe(0), {
      timeout: 20_000,
      interval: 500,
    });
  }, 90_000);

  it('keeps platform commands responsive when user streams fill one SSH connection', async () => {
    await closeMasters();

    const platform = createTransport(
      '127.0.0.1',
      container.privateKey,
      SSH_PORT,
    );
    const user = createUserTransport(
      '127.0.0.1',
      container.privateKey,
      SSH_PORT,
    );
    const controllers = Array.from(
      { length: USER_FOLLOWER_COUNT },
      () => new AbortController(),
    );
    const settled = controllers.map(() => false);
    const outputs = controllers.map(() => '');
    const readyResolvers: Array<() => void> = [];
    const ready = controllers.map(
      (_controller, index) =>
        new Promise<void>((resolve) => {
          readyResolvers[index] = resolve;
        }),
    );
    const followers = controllers.map((controller, index) =>
      user
        .execStream(
          channelBoundCommand(
            `echo user-follow-ready-${index}; sh -c 'sleep 56789'`,
          ),
          {
            signal: controller.signal,
            onStdout: (chunk) => {
              outputs[index] += chunk.toString();
              if (outputs[index].includes(`user-follow-ready-${index}`)) {
                readyResolvers[index]?.();
              }
            },
          },
        )
        .finally(() => {
          settled[index] = true;
        }),
    );
    const followerOutcomes = followers.map((follower) =>
      follower.catch((error: unknown) => error),
    );
    let platformCommand: ReturnType<VmTransport['exec']> | undefined;

    try {
      await settlesWithin(Promise.all(ready), 20_000, 'User followers');

      platformCommand = platform.exec(
        'printf platform-command-ready',
        1,
        false,
        5_000,
      );
      const result = await within(platformCommand, SHORT_COMMAND_DEADLINE_MS);

      expect(result.stdout).toBe('platform-command-ready');
      expect(settled).toEqual(controllers.map(() => false));
      expect(controlPaths()).toHaveLength(2);
      expect(new Set(controlPaths().map(controlMasterPid))).toHaveProperty(
        'size',
        2,
      );
    } finally {
      controllers.forEach((controller) =>
        controller.abort(new Error('Test cleanup')),
      );
      const outcomes = await settlesWithin(
        Promise.all(followerOutcomes),
        20_000,
        'User follower cleanup',
      );
      await platformCommand?.catch(() => undefined);

      for (const outcome of outcomes) {
        expect(outcome).toBeInstanceOf(Error);
        if (outcome instanceof Error) {
          expect(outcome.message).toContain('SSH command aborted');
        }
      }
      await vi.waitFor(
        async () =>
          expect(await remoteProcessCount(USER_FOLLOW_PATTERN)).toBe(0),
        { timeout: 20_000, interval: 500 },
      );
    }
  }, 90_000);

  it('rejects an eleventh user session without opening a fallback connection', async () => {
    await closeMasters();

    const user = createUserTransport(
      '127.0.0.1',
      container.privateKey,
      SSH_PORT,
    );
    const controllers = Array.from(
      { length: USER_FOLLOWER_COUNT },
      () => new AbortController(),
    );
    const settled = controllers.map(() => false);
    const outputs = controllers.map(() => '');
    const readyResolvers: Array<() => void> = [];
    const ready = controllers.map(
      (_controller, index) =>
        new Promise<void>((resolve) => {
          readyResolvers[index] = resolve;
        }),
    );
    const followers = controllers.map((controller, index) =>
      user
        .execStream(
          channelBoundCommand(
            `echo capacity-follow-ready-${index}; sh -c 'sleep 67890'`,
          ),
          {
            signal: controller.signal,
            onStdout: (chunk) => {
              outputs[index] += chunk.toString();
              if (outputs[index].includes(`capacity-follow-ready-${index}`)) {
                readyResolvers[index]?.();
              }
            },
          },
        )
        .finally(() => {
          settled[index] = true;
        }),
    );
    const followerOutcomes = followers.map((follower) =>
      follower.catch((error: unknown) => error),
    );
    const overflow = within(
      user.exec(`touch ${CAPACITY_SENTINEL}`).catch((error: unknown) => error),
      1_000,
    );

    try {
      await settlesWithin(Promise.all(ready), 20_000, 'Capacity followers');

      const outcome = await overflow;

      expect(outcome).toMatchObject({
        name: 'SSHUserSessionCapacityError',
        code: 'SSH_USER_SESSION_CAPACITY',
        message:
          'SSH user session limit of 10 reached; wait for an active user command to finish',
      });
      expect(settled).toEqual(controllers.map(() => false));
      expect(controlPaths()).toHaveLength(1);
      await expect(
        ssh.exec(
          `test ! -e ${CAPACITY_SENTINEL} && printf capacity-not-executed`,
          1,
        ),
      ).resolves.toMatchObject({ stdout: 'capacity-not-executed' });

      controllers[0].abort(new Error('Release one capacity slot'));
      await expect(
        settlesWithin(
          followerOutcomes[0],
          10_000,
          'Cancelled capacity follower',
        ),
      ).resolves.toMatchObject({ message: 'SSH command aborted' });
      await expect(
        user.exec('printf released-capacity-slot'),
      ).resolves.toMatchObject({ stdout: 'released-capacity-slot' });
      expect(settled.slice(1)).toEqual(controllers.slice(1).map(() => false));
    } finally {
      controllers.forEach((controller) =>
        controller.abort(new Error('Test cleanup')),
      );
      const outcomes = await settlesWithin(
        Promise.all(followerOutcomes),
        20_000,
        'Capacity follower cleanup',
      );

      for (const outcome of outcomes) {
        expect(outcome).toBeInstanceOf(Error);
        if (outcome instanceof Error) {
          expect(outcome.message).toContain('SSH command aborted');
        }
      }
      await vi.waitFor(
        async () =>
          expect(await remoteProcessCount(CAPACITY_FOLLOW_PATTERN)).toBe(0),
        { timeout: 20_000, interval: 500 },
      );
      await ssh.exec(`rm -f ${CAPACITY_SENTINEL}`, 1).catch(() => undefined);
    }
  }, 90_000);

  it('coalesces concurrent bootstrap into one master per purpose', async () => {
    await closeMasters();

    const user = createUserTransport(
      '127.0.0.1',
      container.privateKey,
      SSH_PORT,
    );
    const [platformResults, userResults] = await Promise.all([
      Promise.all(
        Array.from({ length: 8 }, (_value, index) =>
          ssh.exec('printf platform-bootstrap-' + index, 1, false, 10_000),
        ),
      ),
      Promise.all(
        Array.from({ length: 8 }, (_value, index) =>
          user.exec('printf user-bootstrap-' + index, 1, false, 10_000),
        ),
      ),
    ]);

    expect(platformResults.map((result) => result.stdout)).toEqual(
      Array.from(
        { length: 8 },
        (_value, index) => 'platform-bootstrap-' + index,
      ),
    );
    expect(userResults.map((result) => result.stdout)).toEqual(
      Array.from({ length: 8 }, (_value, index) => 'user-bootstrap-' + index),
    );
    expect(controlPaths()).toHaveLength(2);
    expect(new Set(controlPaths().map(controlMasterPid))).toHaveProperty(
      'size',
      2,
    );
    expect(
      readdirSync(sshRuntimeDirectory()).filter(
        (name) => name.startsWith('identity-') || name.startsWith('generated-'),
      ),
    ).toEqual([]);
  }, 90_000);

  it('recreates a killed user master without disturbing the platform master', async () => {
    await closeMasters();

    const user = createUserTransport(
      '127.0.0.1',
      container.privateKey,
      SSH_PORT,
    );
    const controller = new AbortController();
    let output = '';
    let resolveReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const follower = user.execStream(channelBoundCommand(FOLLOW_COMMAND), {
      signal: controller.signal,
      onStdout: (chunk) => {
        output += chunk.toString();
        if (output.includes('anycloud-follow-ready')) resolveReady?.();
      },
    });

    try {
      await settlesWithin(ready, 20_000, 'Follower startup');
      const [userControlPath] = controlPaths();
      expect(userControlPath).toBeDefined();
      const userPid = controlMasterPid(userControlPath);
      await vi.waitFor(
        async () => expect(await remoteProcessCount()).toBeGreaterThan(0),
        { timeout: 20_000, interval: 500 },
      );

      const platformControlPath = controlPaths().find(
        (path) => path !== userControlPath,
      );
      expect(platformControlPath).toBeDefined();
      const platformPid = controlMasterPid(platformControlPath!);
      process.kill(userPid, 'SIGKILL');

      await expect(
        settlesWithin(follower, 10_000, 'Follower after master death'),
      ).rejects.toThrow(/SSH stream closed abnormally/);
      expect(existsSync(userControlPath)).toBe(true);
      expect(controlMasterPid(platformControlPath!)).toBe(platformPid);
      await expect(
        ssh.exec('printf surviving-platform-master', 1, false, 10_000),
      ).resolves.toMatchObject({ stdout: 'surviving-platform-master' });

      await expect(
        user.exec('printf recreated-user-master', 1, false, 10_000),
      ).resolves.toMatchObject({ code: 0, stdout: 'recreated-user-master' });
      expect(controlPaths()).toHaveLength(2);
      expect(controlMasterPid(userControlPath)).not.toBe(userPid);
      expect(controlMasterPid(platformControlPath!)).toBe(platformPid);
      await vi.waitFor(async () => expect(await remoteProcessCount()).toBe(0), {
        timeout: 20_000,
        interval: 500,
      });
    } finally {
      controller.abort(new Error('Test cleanup'));
      await follower.catch(() => undefined);
    }
  }, 90_000);

  it('does not rerun a streamed command whose master died mid-command', async () => {
    await closeMasters();

    const user = createUserTransport(
      '127.0.0.1',
      container.privateKey,
      SSH_PORT,
    );
    const controller = new AbortController();
    // Silent on purpose. A command that has announced itself leaves output
    // behind, which is the signal that a session existed; this one leaves the
    // client looking exactly like one that never reached its master.
    const stream = user.execStream(channelBoundCommand(SILENT_COMMAND), {
      signal: controller.signal,
    });

    try {
      // Read the user master before any platform command creates the second
      // one, since a silent command offers nothing else to wait on.
      await vi.waitFor(() => expect(controlPaths()).toHaveLength(1), {
        timeout: 20_000,
        interval: 100,
      });
      const [userControlPath] = controlPaths();
      await vi.waitFor(
        async () =>
          expect(await remoteProcessCount(SILENT_PATTERN)).toBeGreaterThan(0),
        { timeout: 20_000, interval: 500 },
      );

      process.kill(controlMasterPid(userControlPath), 'SIGKILL');

      await expect(
        settlesWithin(stream, 20_000, 'Silent stream after master death'),
      ).rejects.toMatchObject({ name: 'SSHMasterUnreachableError' });
      // A rerun rebuilds the master before it spawns a client, and it happens
      // before this promise settles — so a master still dead here is proof
      // that the user's command was not run a second time.
      expect(controlMasterIsLive(userControlPath)).toBe(false);
      await vi.waitFor(
        async () => expect(await remoteProcessCount(SILENT_PATTERN)).toBe(0),
        { timeout: 20_000, interval: 500 },
      );

      await expect(
        user.exec('printf usable-after-loss', 1, false, 10_000),
      ).resolves.toMatchObject({ stdout: 'usable-after-loss' });
    } finally {
      controller.abort(new Error('Test cleanup'));
      await stream.catch(() => undefined);
    }
  }, 90_000);

  it.each(['user', 'platform'] as const)(
    'completes a single-attempt %s command after a stream preflight and master death',
    async (purpose) => {
      await closeMasters();

      const transport =
        purpose === 'platform'
          ? ssh
          : createUserTransport('127.0.0.1', container.privateKey, SSH_PORT);
      // maxAttempts 1: whatever answers here cannot have come from a retry the
      // caller paid for, and cannot have come from the first run either, whose
      // client died before its command wrote anything.
      const command = transport.exec(RECOVERED_COMMAND, 1, false, 30_000);

      try {
        await vi.waitFor(() => expect(controlPaths()).toHaveLength(1), {
          timeout: 20_000,
          interval: 100,
        });
        const [controlPath] = controlPaths();
        await vi.waitFor(
          () =>
            expect(containerProcessCount(RECOVERED_PATTERN)).toBeGreaterThan(0),
          { timeout: 20_000, interval: 500 },
        );
        const pid = controlMasterPid(controlPath);

        // A stream preflight validates this same master while the silent command
        // still holds its original descriptor. Recovery must invalidate both.
        expect(await transport.execStream('true')).toBe(0);
        expect(controlMasterPid(controlPath)).toBe(pid);
        expect(containerProcessCount(RECOVERED_PATTERN)).toBeGreaterThan(0);
        process.kill(pid, 'SIGKILL');

        await expect(
          settlesWithin(command, 30_000, 'Single-attempt command after loss'),
        ).resolves.toMatchObject({ code: 0, stdout: 'master-loss-recovered' });
        expect(controlMasterPid(controlPath)).not.toBe(pid);
      } finally {
        await command.catch(() => undefined);
        // `exec` does not bind its command to the channel, so the abandoned first
        // run outlives its client and has to drain before the next test.
        await vi.waitFor(
          () => expect(containerProcessCount(RECOVERED_PATTERN)).toBe(0),
          { timeout: 30_000, interval: 500 },
        );
      }
    },
    90_000,
  );

  it('recreates a killed platform master without disturbing a user stream', async () => {
    await closeMasters();

    const user = createUserTransport(
      '127.0.0.1',
      container.privateKey,
      SSH_PORT,
    );
    const controller = new AbortController();
    let followerSettled = false;
    let output = '';
    let resolveReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const follower = user
      .execStream(channelBoundCommand(FOLLOW_COMMAND), {
        signal: controller.signal,
        onStdout: (chunk) => {
          output += chunk.toString();
          if (output.includes('anycloud-follow-ready')) resolveReady?.();
        },
      })
      .finally(() => {
        followerSettled = true;
      });

    try {
      await settlesWithin(ready, 20_000, 'User follower startup');
      const [userControlPath] = controlPaths();
      expect(userControlPath).toBeDefined();
      const userPid = controlMasterPid(userControlPath);

      await expect(
        ssh.exec('printf platform-master-ready', 1, false, 10_000),
      ).resolves.toMatchObject({ stdout: 'platform-master-ready' });
      const platformControlPath = controlPaths().find(
        (path) => path !== userControlPath,
      );
      expect(platformControlPath).toBeDefined();
      const platformPid = controlMasterPid(platformControlPath!);
      process.kill(platformPid, 'SIGKILL');

      await expect(
        ssh.exec('printf recreated-platform-master', 1, false, 10_000),
      ).resolves.toMatchObject({ stdout: 'recreated-platform-master' });
      expect(controlMasterPid(platformControlPath!)).not.toBe(platformPid);
      expect(controlMasterPid(userControlPath)).toBe(userPid);
      expect(followerSettled).toBe(false);
      await vi.waitFor(
        async () => expect(await remoteProcessCount()).toBeGreaterThan(0),
        { timeout: 20_000, interval: 500 },
      );
    } finally {
      controller.abort(new Error('Test cleanup'));
      await expect(follower).rejects.toThrow('SSH command aborted');
      await vi.waitFor(async () => expect(await remoteProcessCount()).toBe(0), {
        timeout: 20_000,
        interval: 500,
      });
    }
  }, 90_000);

  it('closes both purpose masters and an active user stream for a terminated VM', async () => {
    await closeMasters();
    const user = createUserTransport(
      '127.0.0.1',
      container.privateKey,
      SSH_PORT,
    );
    const controller = new AbortController();
    let output = '';
    let resolveReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const follower = user.execStream(channelBoundCommand(FOLLOW_COMMAND), {
      signal: controller.signal,
      onStdout: (chunk) => {
        output += chunk.toString();
        if (output.includes('anycloud-follow-ready')) resolveReady?.();
      },
    });

    try {
      await settlesWithin(ready, 20_000, 'Close follower startup');
      await ssh.exec('printf platform-close-ready', 1);
      expect(controlPaths()).toHaveLength(2);

      const closed = SSHManager.closeConnection('127.0.0.1', SSH_PORT);
      await expect(
        settlesWithin(follower, 10_000, 'Follower during master close'),
      ).rejects.toThrow(/SSH stream closed abnormally/);
      // Synchronous on purpose: it pins what awaiting the close buys. Polling
      // here would pass just as well against a promise that resolves while
      // OpenSSH is still tearing the socket down — the race this suite hit.
      await closed;
      expect(controlPaths()).toEqual([]);
      await vi.waitFor(() => expect(containerProcessCount()).toBe(0), {
        timeout: 20_000,
        interval: 500,
      });
    } finally {
      controller.abort(new Error('Test cleanup'));
      await follower.catch(() => undefined);
    }

    expect(controlPaths()).toEqual([]);
  }, 90_000);

  it('times out a stream, cleans the remote process, and keeps the master usable', async () => {
    const controller = new AbortController();
    let output = '';
    let resolveReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const timed = ssh.execStream(channelBoundCommand(TIMEOUT_COMMAND), {
      signal: controller.signal,
      commandTimeoutMs: 3_000,
      onStdout: (chunk) => {
        output += chunk.toString();
        if (output.includes('timeout-ready')) resolveReady?.();
      },
    });
    const timedOutcome = timed.catch((error: unknown) => error);

    try {
      await settlesWithin(ready, 20_000, 'Timeout probe startup');
      await vi.waitFor(
        async () =>
          expect(await remoteProcessCount(TIMEOUT_PATTERN)).toBeGreaterThan(0),
        { timeout: 20_000, interval: 250 },
      );
      const timeoutResult: unknown = await timedOutcome;
      expect(timeoutResult).toBeInstanceOf(Error);
      if (!(timeoutResult instanceof Error)) {
        throw new Error('Timed SSH stream unexpectedly succeeded');
      }
      expect(timeoutResult.message).toContain(
        'SSH command timed out after 3000ms',
      );
      await vi.waitFor(
        async () => expect(await remoteProcessCount(TIMEOUT_PATTERN)).toBe(0),
        { timeout: 20_000, interval: 500 },
      );
      await expect(ssh.exec('printf after-timeout', 1)).resolves.toMatchObject({
        stdout: 'after-timeout',
      });
    } finally {
      controller.abort(new Error('Test cleanup'));
      await timedOutcome;
    }
  }, 90_000);

  it('fails a stream on client loss without replaying its remote command', async () => {
    const path = '/tmp/anycloud-client-failure-counter';
    let output = '';
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const controller = new AbortController();
    const outcome = ssh
      .execStream(
        channelBoundCommand(
          `printf x >> ${path}; printf client-command-ready; sleep 76543`,
        ),
        {
          signal: controller.signal,
          onStdout: (chunk) => {
            output += chunk.toString();
            if (output.includes('client-command-ready')) markReady();
          },
        },
      )
      .catch((error: unknown) => error);
    try {
      await settlesWithin(ready, 20_000, 'Client failure command startup');
      process.kill(ownedClientPid('client-command-ready'), 'SIGKILL');
      const error = await settlesWithin(
        outcome,
        3_000,
        'Interrupted SSH stream',
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        'SSH stream closed abnormally',
      );
      expect((await ssh.exec(`cat ${path}`, 1)).stdout).toBe('x');
      await vi.waitFor(
        async () => {
          expect(await remoteProcessCount('sleep 7654[3]')).toBe(0);
        },
        { timeout: 10_000 },
      );
    } finally {
      controller.abort();
      await outcome;
      await ssh.exec(`rm -f ${path}`, 1).catch(() => undefined);
    }
  });

  it.each(['stdout', 'stderr'] as const)(
    'does not rerun a platform command that wrote %s before master loss',
    async (output) => {
      await closeMasters();
      const marker = 'platform-partial-output';
      let markReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        markReady = resolve;
      });
      const run = sshProcesses.runSshProcess;
      const handler = output === 'stdout' ? 'onStdout' : 'onStderr';
      const starts = vi
        .spyOn(sshProcesses, 'runSshProcess')
        .mockImplementation((args, options = {}) =>
          run(args, {
            ...options,
            [handler]: async (chunk: Buffer) => {
              if (
                args.at(-1)?.includes(marker) &&
                chunk.toString().includes(marker)
              )
                markReady();
              await options[handler]?.(chunk);
            },
          }),
        );
      const command = channelBoundCommand(
        `printf ${marker}${output === 'stderr' ? ' >&2' : ''}; sleep 76019`,
      );
      const outcome = ssh
        .exec(command, 1, false, 10_000)
        .catch((error: unknown) => error);
      try {
        await settlesWithin(
          ready,
          10_000,
          'Platform output before master loss',
        );
        process.kill(controlMasterPid(controlPaths()[0]), 'SIGKILL');
        expect(
          await settlesWithin(outcome, 5000, 'Platform master loss'),
        ).toMatchObject({ name: 'SSHExecError' });
        expect(
          starts.mock.calls.filter(([args]) => args.at(-1) === command),
        ).toHaveLength(1);
      } finally {
        starts.mockRestore();
        await outcome;
      }
    },
  );

  it('reuses established platform masters while retaining preflight checks for streams', async () => {
    await ssh.exec('printf polling-ready', 1);
    const starts = vi.spyOn(sshProcesses, 'runSshProcess');
    try {
      for (let index = 0; index < 3; index++) {
        expect((await ssh.exec('printf polling-' + index, 1)).stdout).toBe(
          'polling-' + index,
        );
      }
      const checks = starts.mock.calls.filter(
        ([args]) => args.includes('-O') && args.includes('check'),
      ).length;
      process.stdout.write(
        JSON.stringify({
          event: 'ssh-platform-launches',
          commands: 3,
          launches: starts.mock.calls.length,
          checks,
        }) + '\n',
      );
      expect(starts).toHaveBeenCalledTimes(3);
      expect(checks).toBe(0);
      starts.mockClear();
      expect(await ssh.execStream('printf checked-stream')).toBe(0);
      expect(starts).toHaveBeenCalledTimes(2);
      expect(
        starts.mock.calls.filter(
          ([args]) => args.includes('-O') && args.includes('check'),
        ),
      ).toHaveLength(1);
    } finally {
      starts.mockRestore();
    }
  });

  it('recovers concurrent polling after an idle master exits and removes its socket', async () => {
    await closeMasters();
    await ssh.exec('printf before-idle-exit', 1);
    const [path] = controlPaths();
    const pid = controlMasterPid(path);
    process.kill(pid, 'SIGTERM');
    await vi.waitFor(() => expect(existsSync(path)).toBe(false), {
      timeout: 5000,
    });
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        ssh.exec('printf recovered-' + index, 1),
      ),
    );
    expect(results.map((result) => result.stdout)).toEqual([
      'recovered-0',
      'recovered-1',
      'recovered-2',
      'recovered-3',
    ]);
    expect(controlPaths()).toHaveLength(1);
    expect(controlMasterPid(path)).not.toBe(pid);
  });

  it('keeps a replacement master when an older client failure finishes late', async () => {
    await closeMasters();
    const controller = new AbortController();
    let markReady!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const outcome = ssh
      .execStream(
        channelBoundCommand('printf late-failure-ready; sleep 76017'),
        {
          signal: controller.signal,
          onStdout: async () => {
            markReady();
            await blocked;
          },
        },
      )
      .catch((error: unknown) => error);
    try {
      await settlesWithin(ready, 10_000, 'Old stream startup');
      const [path] = controlPaths();
      const oldPid = controlMasterPid(path);
      process.kill(ownedClientPid('late-failure-ready'), 'SIGKILL');
      process.kill(oldPid, 'SIGTERM');
      await vi.waitFor(() => expect(existsSync(path)).toBe(false), {
        timeout: 5000,
      });
      expect((await ssh.exec('printf replacement-ready', 1)).stdout).toBe(
        'replacement-ready',
      );
      const replacementPid = controlMasterPid(path);
      const starts = vi.spyOn(sshProcesses, 'runSshProcess');
      try {
        release();
        expect(
          await settlesWithin(outcome, 5000, 'Old client failure'),
        ).toBeInstanceOf(Error);
        expect((await ssh.exec('printf after-old-failure', 1)).stdout).toBe(
          'after-old-failure',
        );
        expect(starts).toHaveBeenCalledTimes(1);
        expect(controlMasterPid(path)).toBe(replacementPid);
      } finally {
        starts.mockRestore();
      }
    } finally {
      release();
      controller.abort();
      await outcome;
    }
  });

  it('preserves stream backpressure and uploads binary files over stdin', async () => {
    let activeWrites = 0;
    let maxActiveWrites = 0;
    let receivedBytes = 0;
    const streamCode = await ssh.execStream('yes x | head -c 262144', {
      onStdout: async (chunk) => {
        activeWrites++;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        await new Promise((resolve) => setTimeout(resolve, 5));
        receivedBytes += chunk.length;
        activeWrites--;
      },
    });

    expect(streamCode).toBe(0);
    expect(receivedBytes).toBe(262_144);
    expect(maxActiveWrites).toBe(1);

    const directory = '/tmp/anycloud-upload-test';
    const path = directory + '/payload.bin';
    // Cross several native pipe buffers and finish with a partial buffer.
    const payload = randomBytes(1024 * 1024 + 9);
    try {
      await ssh.writeFile(path, payload, {
        mode: 0o640,
        directoryMode: 0o750,
        maxAttempts: 1,
      });
      const result = await ssh.exec(
        "base64 -w0 '" +
          path +
          "'; printf '\\n'; stat -c '%a' '" +
          path +
          "'; stat -c '%a' '" +
          directory +
          "'",
        1,
      );
      expect(result.stdout.trim().split('\n')).toEqual([
        payload.toString('base64'),
        '640',
        '750',
      ]);
    } finally {
      await ssh.exec("rm -rf '" + directory + "'", 1).catch(() => undefined);
    }
  }, 90_000);

  it.each(['abort', 'handler'] as const)(
    'settles %s after the SSH client has exited',
    async (reason) => {
      for (const command of ['printf done', 'yes x | head -c 100009']) {
        const controller = new AbortController();
        const stream = ssh.execStream(command, {
          signal: controller.signal,
          onStdout: async () => {
            // Let the short producer exit while its output remains paused.
            await new Promise((resolve) => setTimeout(resolve, 100));
            if (reason === 'abort') controller.abort();
            else throw new Error('Consumer failed after producer exit');
          },
        });
        await expect(settlesWithin(stream, 2_000, reason)).rejects.toThrow(
          reason === 'abort'
            ? 'SSH command aborted'
            : 'Consumer failed after producer exit',
        );
      }
    },
  );
});
