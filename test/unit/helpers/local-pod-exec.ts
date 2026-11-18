import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import type { V1Status } from '@kubernetes/client-node';
import { vi } from 'vitest';
import { makeClusterKubernetesClientFixture } from './fixtures.js';

/**
 * `pods/exec` as the kubelet runs it, on this machine's `/bin/sh`: the
 * command's stdin is the stream's, its exit is a V1Status, and closing the
 * socket closes stdin, as the client library and the kubelet do.
 */
export function localExec(
  fixture: Parameters<typeof makeClusterKubernetesClientFixture>[0] = {},
) {
  const exec = vi.fn(
    async (
      _namespace: string,
      _pod: string,
      _container: string,
      command: string[],
      stdout: Writable,
      stderr: Writable,
      stdin: Readable,
      _tty: boolean,
      onStatus: (status: V1Status) => void,
    ) => {
      const child = spawn(command[0]!, command.slice(1));
      stdin.pipe(child.stdin);
      child.stdout.on('data', (chunk: Buffer) => stdout.write(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.write(chunk));
      const socket = Object.assign(new EventEmitter(), {
        close: () => {
          child.stdin.end();
          socket.emit('close');
        },
      });
      child.on('close', (code) => {
        onStatus(
          code === 0
            ? { status: 'Success' }
            : {
                status: 'Failure',
                details: {
                  causes: [{ reason: 'ExitCode', message: String(code) }],
                },
              },
        );
        stdout.end();
        stderr.end();
        socket.emit('close');
      });
      return socket;
    },
  );
  return {
    exec,
    cluster: makeClusterKubernetesClientFixture({ ...fixture, exec: { exec } }),
  };
}
