import { execa } from 'execa';
import { createBirpc } from 'birpc';
import { addAbortSignal } from 'node:stream';
import {
  SSH_PROCESS_CHUNK_BYTES,
  type SshOutput,
  type SshProcessHost,
  type SshProcessResult,
  type SshProcessWorker,
} from './ssh-process-protocol.js';

const commands = new Map<number, AbortController>();
let stopping = false;

const rpc = createBirpc<SshProcessHost, SshProcessWorker>(
  {
    ready() {},
    async run(id, args, stdin, input, binary): Promise<SshProcessResult> {
      if (stopping) throw new Error('SSH process helper is shutting down');
      const controller = new AbortController();
      commands.set(id, controller);
      const output = (stream: SshOutput) =>
        new WritableStream<Uint8Array>({
          async write(chunk) {
            for (
              let offset = 0;
              offset < chunk.length;
              offset += SSH_PROCESS_CHUNK_BYTES
            ) {
              if (controller.signal.aborted) return;
              await rpc.output(
                id,
                stream,
                Buffer.from(
                  chunk.buffer,
                  chunk.byteOffset + offset,
                  Math.min(SSH_PROCESS_CHUNK_BYTES, chunk.length - offset),
                ),
              );
            }
          },
        });
      async function* upload() {
        while (!controller.signal.aborted) {
          const chunk = await rpc.input(id);
          if (chunk === null) return;
          yield chunk;
        }
      }
      try {
        const child = execa(binary, args, {
          env: {},
          extendEnv: false,
          stdin: input ? upload() : stdin,
          stdout: output('stdout'),
          stderr: output('stderr'),
          encoding: 'buffer',
          buffer: false,
          reject: false,
          cancelSignal: controller.signal,
          forceKillAfterDelay: 1000,
          // Clients stay in the helper's group so the API can kill that group
          // if the helper dies before its own cleanup runs.
          killDescendants: false,
        });
        // A shared ControlMaster can hold the far ends of these pipes after
        // its client exits, so cancellation must also close the local streams.
        for (const stream of child.nodeChildProcess.stdio) {
          if (stream) addAbortSignal(controller.signal, stream);
        }
        child.nodeChildProcess.once('spawn', () => {
          void rpc.started(id, child.pid!).catch(() => controller.abort());
        });
        const result = await child;
        return {
          code: result.exitCode ?? null,
          signal: (result.signal ?? null) as NodeJS.Signals | null,
          ...(result instanceof Error &&
          result.exitCode === undefined &&
          result.signal === undefined
            ? { error: failure(result) }
            : {}),
        };
      } catch (error) {
        return { code: null, signal: null, error: failure(error as Error) };
      } finally {
        commands.delete(id);
        setImmediate(finishShutdown);
      }
    },
    cancel(id) {
      commands.get(id)?.abort();
    },
    shutdown,
  },
  {
    timeout: -1,
    post(message) {
      if (process.connected)
        process.send!(message, undefined, undefined, (error: Error | null) => {
          if (error) shutdown();
        });
    },
    on: (listener) => {
      process.on('message', listener);
    },
    off: (listener) => {
      process.off('message', listener);
    },
  },
);

function failure(error: {
  message?: string;
  originalMessage?: string;
  code?: string;
}) {
  return {
    // Execa's formatted message includes argv, which can contain credentials.
    message: (
      error.originalMessage ??
      error.message ??
      'SSH launch failed'
    ).slice(0, 500),
    code: error.code,
  };
}

function finishShutdown() {
  if (stopping && commands.size === 0 && process.connected)
    process.disconnect();
}

function shutdown() {
  stopping = true;
  for (const controller of commands.values()) controller.abort();
  finishShutdown();
}

process.on('disconnect', () => {
  rpc.$close();
  shutdown();
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
