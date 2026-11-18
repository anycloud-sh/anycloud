/**
 * Cancelled remote commands against real OpenSSH sshd.
 *
 * Killing a local SSH client closes its session, but that alone does not prove
 * the remote command stops. A command that writes nothing never takes a SIGPIPE
 * from the closed pipe, so it can remain alive after the client disappears.
 *
 * `channelBoundCommand` is what closes that gap, and these tests run it against
 * `/usr/sbin/sshd` in a container. They assert on the remote process, since the
 * guarantee is about what is left running on the VM after a cancel.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { SSHManager } from '../../src/api/services/gateways/ssh';
import { channelBoundCommand } from '../../src/api/services/gateways/channel-bound-command';
import {
  startSshdContainer,
  type SshdContainer,
} from './helpers/sshd-container';

const SSH_PORT = 2225; // ssh-keepalive holds 2223/2224

/**
 * Silent and long-running, like `docker logs -f` against an idle container, and
 * nested one shell deep so the real process is never the pid the wrapper
 * backgrounds — which is why the guard has to signal a process group at all.
 *
 * This does not model workload exec's `docker exec <id> sh -c <cmd>` on VM-host
 * providers, where the guard has to run inside the container instead — a signal
 * on the VM stops only the `docker exec` client. That path is covered by
 * ssh-interrupt-container.spec.ts.
 */
const SILENT_COMMAND = "sh -c 'sleep 12345'";
/** Bracket keeps pgrep from matching its own command line. */
const SILENT_PATTERN = 'sleep 1234[5]';

/** Same shape as SILENT_COMMAND, run unwrapped to show what the wrapper buys. */
const UNGUARDED_COMMAND = "sh -c 'sleep 23456'";
const UNGUARDED_PATTERN = 'sleep 2345[6]';

/** Ignores SIGTERM, so only an escalation to SIGKILL can stop it. */
const STUBBORN_COMMAND =
  'trap "" TERM; while : ; do sleep 0.2; done # anycloud-stubborn-probe';
const STUBBORN_PATTERN = 'anycloud-stubborn-prob[e]';

describe('cancelled remote commands against real OpenSSH', () => {
  let container: SshdContainer;
  let ssh: SSHManager;

  beforeAll(async () => {
    container = await startSshdContainer({
      tag: 'ssh-interrupt-test',
      port: SSH_PORT,
    });
    ssh = new SSHManager('127.0.0.1', container.privateKey, SSH_PORT);
  }, 180000);

  afterAll(async () => {
    await SSHManager.closeConnection('127.0.0.1', SSH_PORT);
    container?.stop();
  });

  /** Count matching remote processes without pgrep's exit code failing exec. */
  async function remoteProcessCount(pattern: string): Promise<number> {
    const { stdout } = await ssh.exec(`pgrep -f '${pattern}' | wc -l`, 1);
    return Number(stdout.trim());
  }

  async function waitForRemoteProcess(pattern: string): Promise<void> {
    await vi.waitFor(
      async () => expect(await remoteProcessCount(pattern)).toBeGreaterThan(0),
      { timeout: 20000, interval: 500 },
    );
  }

  /** Start a command, wait for it to be running, then cancel it. */
  async function runAndCancel(command: string, pattern: string): Promise<void> {
    const controller = new AbortController();
    const run = ssh.execStream(channelBoundCommand(command), {
      signal: controller.signal,
      onStdout: () => {},
    });
    await waitForRemoteProcess(pattern);
    controller.abort(new Error('Client disconnected'));
    await expect(run).rejects.toThrow('SSH command aborted');
  }

  it('stops a silent remote command', async () => {
    await runAndCancel(SILENT_COMMAND, SILENT_PATTERN);

    // The guarantee a cancelled follow makes. Nothing else can stop this
    // command: it writes nothing, so the closed channel costs it no pipe.
    await vi.waitFor(
      async () => expect(await remoteProcessCount(SILENT_PATTERN)).toBe(0),
      { timeout: 20000, interval: 500 },
    );
  }, 90000);

  it('stops a command that ignores SIGTERM', async () => {
    await runAndCancel(STUBBORN_COMMAND, STUBBORN_PATTERN);

    // `anycloud exec` runs whatever the caller asks for, so a command that traps
    // SIGTERM must not be able to outlive the cancel. The guard has to survive
    // the signal it sends to its own process group to get this far.
    await vi.waitFor(
      async () => expect(await remoteProcessCount(STUBBORN_PATTERN)).toBe(0),
      { timeout: 20000, interval: 500 },
    );
  }, 90000);

  it('leaks the same command without the wrapper', async () => {
    // The wrapper is what stops the command, not the channel close. This pins
    // that: cancelling an unwrapped command leaves it running because a silent
    // command takes no SIGPIPE from the closed channel.
    //
    // If this ever fails, sshd's behaviour changed and the wrapper may no
    // longer be needed — worth checking before assuming the test is wrong.
    const controller = new AbortController();
    const run = ssh.execStream(UNGUARDED_COMMAND, {
      signal: controller.signal,
      onStdout: () => {},
    });
    await waitForRemoteProcess(UNGUARDED_PATTERN);
    controller.abort(new Error('Client disconnected'));
    await expect(run).rejects.toThrow('SSH command aborted');

    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(await remoteProcessCount(UNGUARDED_PATTERN)).toBeGreaterThan(0);

    await ssh.exec("pkill -9 -f '^sleep 23456$' || true", 1, false, 10_000);
  }, 90000);

  it('preserves exit status and stream separation', async () => {
    let stdout = '';
    let stderr = '';
    const code = await ssh.execStream(
      channelBoundCommand(
        "sh -c 'echo to-stdout; echo to-stderr >&2; exit 42'",
      ),
      {
        onStdout: (chunk) => {
          stdout += chunk.toString();
        },
        onStderr: (chunk) => {
          stderr += chunk.toString();
        },
      },
    );

    // The wrapper runs for every exec-stream caller, so a swallowed exit code
    // or a merged stream would be a regression in `anycloud exec`.
    expect(code).toBe(42);
    expect(stdout.trim()).toBe('to-stdout');
    expect(stderr.trim()).toBe('to-stderr');
  }, 90000);

  it('returns as soon as a command exits on its own', async () => {
    const started = Date.now();
    const code = await ssh.execStream(channelBoundCommand('sleep 1'), {
      onStdout: () => {},
    });

    expect(code).toBe(0);
    // The guard is still blocked on stdin at this point; the wrapper must not
    // wait for the channel to close before returning.
    expect(Date.now() - started).toBeLessThan(10000);
  }, 90000);
});
