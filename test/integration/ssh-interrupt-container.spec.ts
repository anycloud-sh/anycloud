/**
 * Cancelled workload exec commands that run inside a workload container.
 *
 * ssh-interrupt.spec.ts covers commands running on the VM itself. On VM-host
 * providers — five of the seven — workload exec instead runs
 * `docker exec <id> sh -c <cmd>`, and a signal sent on the VM reaches only the
 * `docker exec` client: dockerd keeps running the process inside the container
 * regardless. So the guard has to be pushed across that boundary, and this leg
 * asserts on the process inside the *workload* container rather than on the VM.
 *
 * The sshd container gets a docker CLI pointed at the host daemon, so the
 * workload container is a sibling rather than docker-in-docker.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { SSHManager } from '../../src/api/services/gateways/ssh';
import { channelBoundCommand } from '../../src/api/services/gateways/channel-bound-command';
import { shellEscape } from '../../src/shared/utils';
import {
  startSshdContainer,
  type SshdContainer,
  UBUNTU_BASE_IMAGE,
} from './helpers/sshd-container';

const SSH_PORT = 2227; // 2223/2224 keepalive, 2225 interrupt
const WORKLOAD = 'ac-exec-boundary-workload';

const SILENT_COMMAND = 'sleep 51234';
const SILENT_PATTERN = 'sleep 5123[4]';

/** What workload exec builds for a VM-host provider, guard inside the container. */
function containerExec(command: string): string {
  return `docker exec -i ${shellEscape(WORKLOAD)} sh -c ${shellEscape(
    channelBoundCommand(command),
  )}`;
}

/** The same shape with no guard at all — the leak this leg exists to prevent. */
function unguardedContainerExec(command: string): string {
  return `docker exec -i ${shellEscape(WORKLOAD)} sh -c ${shellEscape(command)}`;
}

describe('cancelled container commands against real OpenSSH', () => {
  let container: SshdContainer;
  let ssh: SSHManager;

  beforeAll(async () => {
    container = await startSshdContainer({
      tag: 'ssh-exec-boundary-test',
      port: SSH_PORT,
      withDocker: true,
    });
    ssh = new SSHManager('127.0.0.1', container.privateKey, SSH_PORT);

    execSync(`docker rm -f ${WORKLOAD}`, { stdio: 'ignore' });
    execSync(
      `docker run -d --name ${WORKLOAD} ${UBUNTU_BASE_IMAGE} sleep 3600`,
      { stdio: 'ignore' },
    );
  }, 240000);

  afterAll(async () => {
    execSync(`docker rm -f ${WORKLOAD}`, { stdio: 'ignore' });
    await SSHManager.closeConnection('127.0.0.1', SSH_PORT);
    container?.stop();
  });

  /** Count matching processes inside the workload container, not on the VM. */
  function workloadProcessCount(pattern: string): number {
    const out = execSync(
      `docker exec ${WORKLOAD} sh -c "pgrep -f '${pattern}' | wc -l"`,
    ).toString();
    return Number(out.trim());
  }

  async function runAndCancel(remoteCommand: string): Promise<void> {
    const controller = new AbortController();
    const run = ssh.execStream(remoteCommand, {
      signal: controller.signal,
      onStdout: () => {},
    });
    await vi.waitFor(
      () => expect(workloadProcessCount(SILENT_PATTERN)).toBeGreaterThan(0),
      { timeout: 30000, interval: 500 },
    );
    controller.abort(new Error('Client disconnected'));
    await expect(run).rejects.toThrow('SSH command aborted');
  }

  it('stops a command running inside the workload container', async () => {
    await runAndCancel(containerExec(SILENT_COMMAND));

    await vi.waitFor(
      () => expect(workloadProcessCount(SILENT_PATTERN)).toBe(0),
      { timeout: 30000, interval: 500 },
    );
  }, 120000);

  it('leaks the same command when the guard is outside the container', async () => {
    // The control. A signal on the VM stops the `docker exec` client, and
    // dockerd carries on running what is behind it — which is why the guard has
    // to be inside. If this ever stops leaking, docker changed and the extra
    // wrapping layer can go.
    await runAndCancel(unguardedContainerExec(SILENT_COMMAND));

    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(workloadProcessCount(SILENT_PATTERN)).toBeGreaterThan(0);

    execSync(`docker exec ${WORKLOAD} pkill -9 -f '^sleep 51234$' || true`, {
      stdio: 'ignore',
      timeout: 10_000,
    });
  }, 120000);

  it('preserves exit status and stream separation through the container', async () => {
    let stdout = '';
    let stderr = '';
    const code = await ssh.execStream(
      containerExec('echo to-stdout; echo to-stderr >&2; exit 42'),
      {
        onStdout: (chunk) => {
          stdout += chunk.toString();
        },
        onStderr: (chunk) => {
          stderr += chunk.toString();
        },
      },
    );

    // `-i` changes stdin handling for every container-based exec, so the parts
    // callers actually depend on are pinned here too.
    expect(code).toBe(42);
    expect(stdout.trim()).toBe('to-stdout');
    expect(stderr.trim()).toBe('to-stderr');
  }, 120000);
});
