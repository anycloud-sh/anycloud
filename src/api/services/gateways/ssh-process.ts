import { fork, type ChildProcess } from 'node:child_process';
import { createBirpc, type BirpcReturn } from 'birpc';
import {
  SSH_PROCESS_CHUNK_BYTES,
  type SshOutput,
  type SshProcessHost,
  type SshProcessResult,
  type SshProcessWorker,
} from './ssh-process-protocol.js';

export class SshProcessError extends Error {}
export class SshLaunchError extends SshProcessError {}
export class SshProcessTimeoutError extends Error {}

interface RunOptions {
  binary?: 'ssh' | 'ssh-keygen';
  stdin?: Buffer;
  ignoreStdin?: boolean;
  signal?: AbortSignal;
  deadlineAt?: number;
  onStdout?: (chunk: Buffer) => void | Promise<void>;
  onStderr?: (chunk: Buffer) => void | Promise<void>;
  onSpawn?: (pid: number) => void;
}

interface Command {
  options: RunOptions;
  offset: number;
  writes: Promise<void>;
  failure?: Error;
}

interface Helper {
  child: ChildProcess;
  rpc: BirpcReturn<SshProcessWorker, SshProcessHost>;
  ready: Promise<void>;
  commands: Map<number, Command>;
  exited: Promise<void>;
  onExit: () => void;
}

export class SshProcessBroker {
  private helper?: Helper;
  private nextId = 1;
  private stopping = false;

  async run(
    args: string[],
    options: RunOptions = {},
  ): Promise<SshProcessResult> {
    if (this.stopping)
      throw new SshLaunchError('SSH process helper is shutting down');
    if (options.signal?.aborted)
      throw new SshLaunchError('SSH command aborted');
    if (
      options.deadlineAt !== undefined &&
      performance.now() >= options.deadlineAt
    )
      throw new SshLaunchError('SSH process launch timed out');
    const helper = this.helper ?? this.start();
    const id = this.nextId++;
    const entry: Command = { options, offset: 0, writes: Promise.resolve() };
    helper.commands.set(id, entry);
    helper.child.ref();
    helper.child.channel?.ref();
    let waiting = true;
    let cancelStart!: (error: Error) => void;
    const startCancelled = new Promise<never>((_resolve, reject) => {
      cancelStart = reject;
    });
    const cancel = (failure: Error) => {
      entry.failure ??= failure;
      if (waiting) cancelStart(entry.failure);
      else void helper.rpc.cancel.asEvent(id).catch(() => undefined);
    };
    const abort = () => cancel(new Error('SSH command aborted'));
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer =
      options.deadlineAt === undefined
        ? undefined
        : setTimeout(
            () =>
              cancel(
                waiting
                  ? new SshLaunchError('SSH process launch timed out')
                  : new SshProcessTimeoutError('SSH command timed out'),
              ),
            Math.max(0, options.deadlineAt - performance.now()),
          );
    try {
      await Promise.race([helper.ready, startCancelled]);
      waiting = false;
      if (entry.failure) throw entry.failure;
      const result = await helper.rpc.run(
        id,
        args,
        options.ignoreStdin ? 'ignore' : 'pipe',
        options.stdin !== undefined,
        options.binary ?? 'ssh',
      );
      if (entry.failure) throw entry.failure;
      if (result.error)
        throw Object.assign(new Error(result.error.message), {
          code: result.error.code,
        });
      return result;
    } catch (error) {
      throw entry.failure ?? error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      helper.commands.delete(id);
      if (helper.commands.size === 0) {
        helper.child.unref();
        helper.child.channel?.unref();
      }
    }
  }

  private start(): Helper {
    const source = import.meta.url.endsWith('.ts');
    const child = fork(
      new URL(
        source ? './ssh-process-helper.ts' : './ssh-process-helper.js',
        import.meta.url,
      ),
      [],
      {
        execArgv: source ? ['--import', 'tsx'] : [],
        env: {},
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'advanced',
        detached: true,
      },
    );
    const commands = new Map<number, Command>();
    const rpc = createBirpc<SshProcessWorker, SshProcessHost>(
      {
        input(id) {
          const entry = commands.get(id);
          if (
            !entry ||
            entry.failure ||
            !entry.options.stdin ||
            entry.offset === entry.options.stdin.length
          )
            return null;
          const chunk = entry.options.stdin.subarray(
            entry.offset,
            entry.offset + SSH_PROCESS_CHUNK_BYTES,
          );
          entry.offset += chunk.length;
          return chunk;
        },
        async output(id, stream: SshOutput, chunk) {
          const entry = commands.get(id);
          if (!entry || entry.failure) return;
          entry.writes = entry.writes
            .then(async () => {
              if (!entry.failure)
                await (
                  stream === 'stdout'
                    ? entry.options.onStdout
                    : entry.options.onStderr
                )?.(chunk);
            })
            .catch((error: unknown) => {
              entry.failure ??=
                error instanceof Error ? error : new Error(String(error));
              void rpc.cancel.asEvent(id).catch(() => undefined);
            });
          await entry.writes;
        },
        started(id, pid) {
          commands.get(id)?.options.onSpawn?.(pid);
        },
      },
      {
        timeout: -1,
        post: (message) => {
          if (child.connected)
            child.send(message, (error) => {
              if (error) this.fail(helper);
            });
        },
        on: (listener) => {
          child.on('message', listener);
        },
        off: (listener) => {
          child.off('message', listener);
        },
      },
    );
    const startupTimer = setTimeout(() => this.fail(helper), 10_000);
    const helper: Helper = {
      child,
      rpc,
      commands,
      ready: rpc.ready().finally(() => clearTimeout(startupTimer)),
      exited: new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.once('error', () => {
          if (child.pid === undefined) resolve();
        });
      }),
      onExit: () => this.killGroup(child),
    };
    this.helper = helper;
    process.once('exit', helper.onExit);
    child.once('error', () => this.fail(helper));
    child.once('disconnect', () => this.fail(helper));
    child.once('exit', () => this.fail(helper));
    return helper;
  }

  private killGroup(child: ChildProcess): void {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }

  private fail(helper: Helper): void {
    if (this.helper !== helper) return;
    this.helper = undefined;
    helper.rpc.$close(new SshProcessError('SSH process helper disconnected'));
    process.removeListener('exit', helper.onExit);
    this.killGroup(helper.child);
    if (helper.child.connected) helper.child.disconnect();
  }

  async close(): Promise<void> {
    this.stopping = true;
    const helper = this.helper;
    if (!helper) return;
    helper.child.ref();
    helper.child.channel?.ref();
    const timer = setTimeout(() => this.fail(helper), 2000);
    try {
      await helper.rpc.shutdown.asEvent().catch(() => undefined);
      await helper.exited;
    } finally {
      clearTimeout(timer);
    }
  }
}

const broker = new SshProcessBroker();
export const runSshProcess = (args: string[], options?: RunOptions) =>
  broker.run(args, options);
export const shutdownSshProcesses = () => broker.close();
