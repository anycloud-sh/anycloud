import { execa } from 'execa';

import type { ArtifactStore } from './artifacts.js';
import type { CommandOptions, CommandResult } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

interface CapturedText {
  value: string;
  truncated: boolean;
}

function appendCaptured(current: CapturedText, chunk: Buffer): CapturedText {
  const next = current.value + chunk.toString('utf8');
  if (Buffer.byteLength(next) <= MAX_OUTPUT_BYTES) {
    return { value: next, truncated: current.truncated };
  }
  const tail = Buffer.from(next).subarray(-MAX_OUTPUT_BYTES).toString('utf8');
  return { value: tail, truncated: true };
}

function validateTimeout(timeoutMs: number): void {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `process timeout must be an integer between 1 and ${MAX_TIMEOUT_MS}ms`,
    );
  }
}

export class ProcessRunner {
  readonly #artifacts: ArtifactStore;
  readonly #signal: AbortSignal;
  readonly #defaultCwd: string;

  constructor(
    artifacts: ArtifactStore,
    signal: AbortSignal,
    defaultCwd: string,
  ) {
    this.#artifacts = artifacts;
    this.#signal = signal;
    this.#defaultCwd = defaultCwd;
  }

  async run(
    executable: string,
    args: readonly string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    if (executable.length === 0) throw new Error('executable cannot be empty');
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    validateTimeout(timeoutMs);
    const startedAt = Date.now();

    let stdout: CapturedText = { value: '', truncated: false };
    let stderr: CapturedText = { value: '', truncated: false };
    let combined: CapturedText = { value: '', truncated: false };
    const deadline = AbortSignal.timeout(timeoutMs);
    const cancellation = options.signal
      ? AbortSignal.any([this.#signal, options.signal])
      : this.#signal;
    const child = execa(executable, args, {
      cwd: options.cwd ?? this.#defaultCwd,
      env: { ...process.env, ...options.env },
      extendEnv: false,
      input: options.stdin ?? '',
      buffer: false,
      encoding: 'buffer',
      reject: false,
      cleanup: false,
      windowsHide: false,
      verbose: 'none',
      killDescendants: process.platform !== 'win32',
      cancelSignal: AbortSignal.any([cancellation, deadline]),
      forceKillAfterDelay: 1_000,
    });
    // Retain tails while draining: Execa's maxBuffer would terminate the command.
    child.nodeChildProcess.stdout!.on('data', (chunk: Buffer) => {
      stdout = appendCaptured(stdout, chunk);
      combined = appendCaptured(combined, chunk);
    });
    child.nodeChildProcess.stderr!.on('data', (chunk: Buffer) => {
      stderr = appendCaptured(stderr, chunk);
      combined = appendCaptured(combined, chunk);
    });
    const outcome = await child;
    const result: CommandResult = {
      executable,
      args: [...args],
      exitCode: child.nodeChildProcess.exitCode,
      signal: child.nodeChildProcess.signalCode,
      stdout: stdout.value,
      stderr: stderr.value,
      combined: combined.value,
      durationMs: Date.now() - startedAt,
      // Both can occur before drainage, while Execa retains its first cause.
      timedOut: deadline.aborted,
      aborted: cancellation.aborted,
      outputTruncated:
        stdout.truncated || stderr.truncated || combined.truncated,
      ...(child.pid === undefined && outcome.code
        ? { spawnError: outcome.originalMessage }
        : {}),
    };

    if (options.recordArtifact !== false) {
      await this.#artifacts.command(
        options.label ?? executable.split('/').at(-1) ?? 'command',
        result,
      );
    }
    return result;
  }
}
