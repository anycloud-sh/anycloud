import { spawnSync } from 'node:child_process';
import * as childProcesses from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SshProcessBroker } from '../../../../src/api/services/gateways/ssh-process.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, fork: vi.fn(actual.fork) };
});

const brokers: SshProcessBroker[] = [];
// Cold source helpers load tsx before the SSH client can connect.
const HELPER_SETUP_TIMEOUT_MS = 5000;

function broker(): SshProcessBroker {
  const value = new SshProcessBroker();
  brokers.push(value);
  return value;
}

function command(
  owner: SshProcessBroker,
  args: string[],
  signal?: AbortSignal,
) {
  const child: { pid?: number } = {};
  const errors: Error[] = [];
  let stderr = '';
  const closed = owner
    .run(args, {
      ignoreStdin: true,
      signal,
      onSpawn: (pid) => {
        child.pid = pid;
      },
      onStderr: (chunk) => {
        stderr += chunk.toString();
      },
    })
    .catch((error: Error) => {
      errors.push(error);
      return { code: null, signal: null };
    });
  return { child, errors, closed, stderr: () => stderr };
}

function parentPid(pid: number): number {
  const result = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  return Number(result.stdout.trim());
}

function isRunning(pid: number): boolean {
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {
    encoding: 'utf8',
  });
  return result.status === 0 && !result.stdout.trim().startsWith('Z');
}

async function stalledServer() {
  const connections = new Set<Socket>();
  let accepted = 0;
  const server = createServer((socket) => {
    accepted++;
    connections.add(socket);
    socket.on('error', () => undefined);
    socket.on('data', () => undefined);
    socket.once('close', () => connections.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing fixture port');
  return {
    accepted: () => accepted,
    connections,
    args: [
      '-F',
      '/dev/null',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=20',
      '-p',
      String(address.port),
      '--',
      '127.0.0.1',
    ],
    close: async () => {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

afterEach(async () => {
  await Promise.all(brokers.splice(0).map((owner) => owner.close()));
});

describe('SSH process helper', () => {
  it('isolates invalid command arguments from unrelated operations', async () => {
    const owner = broker();
    const invalid = command(owner, ['\u0000', 'unrelated-private-argument']);
    const healthy = command(owner, ['-V']);
    await invalid.closed;
    expect(invalid.errors).toHaveLength(1);
    expect(invalid.errors[0].message).toContain('null bytes');
    expect(invalid.errors[0].message).not.toContain(
      'unrelated-private-argument',
    );
    expect((await healthy.closed).code).toBe(0);
    expect(healthy.errors).toEqual([]);
  });

  it('multiplexes concurrent real SSH processes and drains their output', async () => {
    const owner = broker();
    const commands = Array.from({ length: 40 }, () => command(owner, ['-V']));
    const results = await Promise.all(commands.map((item) => item.closed));
    expect(results.every((result) => result.code === 0)).toBe(true);
    for (const item of commands) {
      expect(item.errors).toEqual([]);
      expect(item.stderr()).toContain('OpenSSH_');
    }
  });

  it('drains nonzero-exit output through a slow consumer', async () => {
    const owner = broker();
    let stderr = '';
    const result = await owner.run(['-p', 'not-a-port', '--', '127.0.0.1'], {
      ignoreStdin: true,
      onStderr: async (chunk) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        stderr += chunk.toString();
      },
    });
    expect(result.code).toBe(255);
    expect(stderr).toContain("Bad port 'not-a-port'");
  });

  it('fails affected commands, kills owned clients, and recreates the helper without replay', async () => {
    const server = await stalledServer();
    const owner = broker();
    try {
      const commands = Array.from({ length: 4 }, () =>
        command(owner, server.args),
      );
      await vi.waitFor(() => expect(server.accepted()).toBe(4), {
        timeout: HELPER_SETUP_TIMEOUT_MS,
      });
      const pids = commands.map((item) => item.child.pid!);
      const helperPid = parentPid(pids[0]);
      expect(helperPid).not.toBe(process.pid);
      expect(pids.every((pid) => parentPid(pid) === helperPid)).toBe(true);
      process.kill(helperPid, 'SIGKILL');
      await Promise.all(commands.map((item) => item.closed));
      for (const item of commands) {
        expect(item.errors).toHaveLength(1);
        expect(item.errors[0].message).toContain('SSH process helper');
      }
      await vi.waitFor(() => {
        expect(pids.some(isRunning)).toBe(false);
        expect(server.connections.size).toBe(0);
      });
      const next = command(owner, ['-V']);
      expect((await next.closed).code).toBe(0);
      expect(next.errors).toEqual([]);
      expect(server.accepted()).toBe(4);
    } finally {
      await owner.close();
      await server.close();
    }
  });

  it('cancels one command while unrelated commands continue', async () => {
    const server = await stalledServer();
    const owner = broker();
    const abort = new AbortController();
    try {
      const running = command(owner, server.args, abort.signal);
      await vi.waitFor(() => expect(server.accepted()).toBe(1), {
        timeout: HELPER_SETUP_TIMEOUT_MS,
      });
      const pid = running.child.pid!;
      abort.abort();
      await running.closed;
      expect(running.errors).toHaveLength(1);
      expect(running.errors[0].message).toBe('SSH command aborted');
      await vi.waitFor(() => expect(isRunning(pid)).toBe(false));
      expect((await command(owner, ['-V']).closed).code).toBe(0);
    } finally {
      await owner.close();
      await server.close();
    }
  });

  it('does not launch a command cancelled before helper readiness', async () => {
    const server = await stalledServer();
    const owner = broker();
    try {
      const abort = new AbortController();
      const cancelled = command(owner, server.args, abort.signal);
      abort.abort();
      await cancelled.closed;
      expect(cancelled.errors[0].message).toBe('SSH command aborted');
      expect(cancelled.child.pid).toBeUndefined();
      expect(server.accepted()).toBe(0);
      expect((await command(owner, ['-V']).closed).code).toBe(0);
    } finally {
      await owner.close();
      await server.close();
    }
  });

  it.each(['abort', 'handler'] as const)(
    'preserves %s failures while the consumer finishes after SSH exits',
    async (reason) => {
      const owner = broker();
      const abort = new AbortController();
      let pid: number | undefined;
      let started!: () => void;
      let release!: () => void;
      const consuming = new Promise<void>((resolve) => {
        started = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const handlerError = new Error('Late SSH consumer failed');
      const result = owner
        .run(['-V'], {
          ignoreStdin: true,
          signal: abort.signal,
          onSpawn: (value) => {
            pid = value;
          },
          onStderr: async () => {
            started();
            await released;
            if (reason === 'handler') throw handlerError;
          },
        })
        .catch((error: Error) => error);
      try {
        await consuming;
        await vi.waitFor(() => expect(isRunning(pid!)).toBe(false));
        if (reason === 'abort') abort.abort();
        release();
        const outcome = await result;
        expect(outcome).toBeInstanceOf(Error);
        expect((outcome as Error).message).toBe(
          reason === 'abort' ? 'SSH command aborted' : handlerError.message,
        );
        expect((await command(owner, ['-V']).closed).code).toBe(0);
      } finally {
        release();
        await owner.close();
      }
    },
  );

  it('reaps a stopped SSH client within the cancellation deadline', async () => {
    const server = await stalledServer();
    const owner = broker();
    const abort = new AbortController();
    try {
      const current = command(owner, server.args, abort.signal);
      await vi.waitFor(
        () => {
          expect(server.accepted()).toBe(1);
          expect(current.child.pid).toBeGreaterThan(0);
        },
        { timeout: HELPER_SETUP_TIMEOUT_MS },
      );
      const pid = current.child.pid!;
      process.kill(pid, 'SIGSTOP');
      await vi.waitFor(() => {
        const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {
          encoding: 'utf8',
        });
        expect(state.stdout.trim()).toMatch(/^T/);
      });
      const started = performance.now();
      abort.abort();
      await current.closed;
      expect(current.errors[0].message).toBe('SSH command aborted');
      expect(performance.now() - started).toBeLessThan(2500);
      expect(isRunning(pid)).toBe(false);
    } finally {
      await owner.close();
      await server.close();
    }
  });

  it('terminates an active command on helper shutdown and refuses new work', async () => {
    const server = await stalledServer();
    const owner = broker();
    try {
      const current = command(owner, server.args);
      await vi.waitFor(() => expect(server.accepted()).toBe(1), {
        timeout: HELPER_SETUP_TIMEOUT_MS,
      });
      const pid = current.child.pid!;
      await owner.close();
      expect((await current.closed).signal).toBe('SIGTERM');
      await vi.waitFor(() => expect(isRunning(pid)).toBe(false));
      await expect(owner.run(['-V'])).rejects.toThrow('shutting down');
    } finally {
      await owner.close();
      await server.close();
    }
  });

  it('honors a command deadline while the helper is still starting', async () => {
    const { fork } =
      await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
    const stalled = vi
      .spyOn(childProcesses, 'fork')
      .mockImplementation((...args) => {
        const child = fork(...args);
        process.kill(child.pid!, 'SIGSTOP');
        return child;
      });
    const owner = broker();
    try {
      const started = performance.now();
      await expect(
        owner.run(['-V'], { deadlineAt: started + 100 }),
      ).rejects.toThrow('timed out');
      expect(performance.now() - started).toBeLessThan(1000);
    } finally {
      stalled.mockRestore();
      await owner.close();
    }
  });
});
