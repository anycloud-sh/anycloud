import { execa, type Subprocess } from 'execa';
import { access, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import type { ArtifactStore } from './artifacts.js';

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

interface ManagedProcessCommand {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly executable: string;
  readonly label: string;
  readonly readyTimeoutMs: number;
}

export interface ManagedProcessLaunch<Ready> extends ManagedProcessCommand {
  readonly parseReady: (value: unknown, childPid: number) => Ready;
  readonly readyPath: string;
}

export interface ObservedProcessLaunch<Ready> extends ManagedProcessCommand {
  readonly signal: AbortSignal;
  readonly probeReady: (
    childPid: number,
    deadlineAt: number,
  ) => Promise<Ready | undefined>;
}

interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

function appendCaptured(current: string, chunk: Buffer): string {
  const next = current + chunk.toString('utf8');
  if (Buffer.byteLength(next) <= MAX_CAPTURE_BYTES) return next;
  return Buffer.from(next).subarray(-MAX_CAPTURE_BYTES).toString('utf8');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Owns one long-lived child incarnation and its retained evidence. */
export class ManagedProcess<Ready> {
  readonly #artifacts: ArtifactStore;
  #child: Subprocess | undefined;
  #label: string | undefined;
  #ready: Ready | undefined;
  #stderr = '';
  #stdout = '';

  constructor(artifacts: ArtifactStore) {
    this.#artifacts = artifacts;
  }

  get active(): boolean {
    return this.#child !== undefined;
  }

  get ready(): Ready {
    if (this.#ready === undefined) {
      throw new Error('Managed process has not emitted a valid ready record');
    }
    return this.#ready;
  }

  async start(launch: ManagedProcessLaunch<Ready>): Promise<Ready> {
    if (await pathExists(launch.readyPath)) {
      throw new Error(
        `Managed-process ready record already exists: ${launch.readyPath}`,
      );
    }
    return this.startWithProbe({
      ...launch,
      signal: new AbortController().signal,
      probeReady: async (childPid) => {
        if (!(await pathExists(launch.readyPath))) return undefined;
        const serialized = await readFile(launch.readyPath, 'utf8');
        // A writer that truncates before it writes exposes an empty file for a
        // moment; that is "not ready yet", not a malformed record.
        if (serialized.length === 0) return undefined;
        let candidate: unknown;
        try {
          candidate = JSON.parse(serialized);
        } catch (error) {
          throw new Error('Managed-process ready record is not valid JSON', {
            cause: error,
          });
        }
        return launch.parseReady(candidate, childPid);
      },
    });
  }

  /** The shipped API emits no fixture ready file; observe its real health route. */
  async startWithProbe(launch: ObservedProcessLaunch<Ready>): Promise<Ready> {
    if (this.#child) throw new Error('Managed process is already running');
    launch.signal.throwIfAborted();
    if (
      !Number.isSafeInteger(launch.readyTimeoutMs) ||
      launch.readyTimeoutMs <= 0
    ) {
      throw new Error('Managed-process readiness timeout must be positive');
    }
    this.#label = launch.label;
    this.#ready = undefined;
    this.#stderr = '';
    this.#stdout = '';
    const child = execa(launch.executable, launch.args, {
      cwd: launch.cwd,
      env: { ...process.env, ...launch.env },
      extendEnv: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      buffer: false,
      encoding: 'buffer',
      reject: false,
      cleanup: false,
      windowsHide: false,
      verbose: 'none',
      killDescendants: process.platform !== 'win32',
      forceKillAfterDelay: 5_000,
    });
    this.#child = child;
    child.nodeChildProcess.stdout!.on('data', (chunk: Buffer) => {
      this.#stdout = appendCaptured(this.#stdout, chunk);
    });
    child.nodeChildProcess.stderr!.on('data', (chunk: Buffer) => {
      this.#stderr = appendCaptured(this.#stderr, chunk);
    });
    const exit = child.then((outcome) => ({ kind: 'exit' as const, outcome }));

    try {
      const deadline = Date.now() + launch.readyTimeoutMs;
      while (Date.now() < deadline) {
        launch.signal.throwIfAborted();
        if (child.pid === undefined) {
          const outcome = await child;
          throw new Error(
            outcome.originalMessage ??
              'Managed process has no operating-system PID',
          );
        }
        const ready = await launch.probeReady(child.pid, deadline);
        launch.signal.throwIfAborted();
        if (Date.now() >= deadline) break;
        if (ready !== undefined) {
          this.#ready = ready;
          return ready;
        }
        const exited = await Promise.race([
          exit,
          delay(50, { kind: 'pending' as const }),
        ]);
        if (exited.kind === 'exit') {
          if (exited.outcome.code)
            throw new Error(exited.outcome.originalMessage);
          throw new Error(
            `Managed process exited before readiness (code ${String(child.nodeChildProcess.exitCode)}, signal ${String(child.nodeChildProcess.signalCode)})`,
          );
        }
      }
      throw new Error(
        `Managed process did not become ready within ${launch.readyTimeoutMs}ms`,
      );
    } catch (error) {
      child.kill('SIGKILL');
      await child;
      await this.captureDiagnostics('start-failure');
      this.#clear();
      throw error;
    }
  }

  async crash(): Promise<ProcessExit> {
    const child = this.#requiredChild();
    child.kill('SIGKILL');
    await child;
    await this.captureDiagnostics('crash');
    this.#clear();
    return {
      code: child.nodeChildProcess.exitCode,
      signal: child.nodeChildProcess.signalCode,
    };
  }

  async stop(requireSuccess = false): Promise<void> {
    const child = this.#child;
    if (!child) return;
    child.kill();
    await child;
    await this.captureDiagnostics('stop');
    this.#clear();
    if (requireSuccess && child.nodeChildProcess.exitCode !== 0) {
      throw new Error(
        `Managed process did not stop cleanly (code ${String(child.nodeChildProcess.exitCode)}, signal ${String(child.nodeChildProcess.signalCode)})`,
      );
    }
  }

  async captureDiagnostics(suffix = 'live'): Promise<void> {
    if (!this.#label) return;
    await this.#artifacts.text(
      `${this.#label}-${suffix}`,
      `[stdout]\n${this.#stdout}\n\n[stderr]\n${this.#stderr}\n`,
    );
  }

  #requiredChild(): Subprocess {
    if (!this.#child) throw new Error('Managed process is not running');
    return this.#child;
  }

  #clear(): void {
    this.#child = undefined;
    this.#ready = undefined;
  }
}
