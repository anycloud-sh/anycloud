import { execa, type ExecaError } from 'execa';
import { platform } from 'os';

interface ExecAsyncOptions {
  env?: NodeJS.ProcessEnv;
}

/** Execute a shell command and return its exact stdout. */
export async function execAsync(
  command: string,
  options?: ExecAsyncOptions,
): Promise<string> {
  try {
    const child = execa(command, {
      shell: true,
      env: options?.env ?? process.env,
      extendEnv: false,
      // Bun rejects 'buffer'; latin1 preserves bytes and keeps maxBuffer a byte cap.
      encoding: 'latin1',
      stripFinalNewline: false,
      maxBuffer: 1024 * 1024,
      cleanup: false,
      forceKillAfterDelay: false,
      windowsHide: false,
      verbose: 'none',
    });
    let captureClosed = false;
    for (const stream of [child.stdout, child.stderr]) {
      stream?.once('close', () => {
        // Execa destroys an overflowing stream but does not terminate the child.
        if (stream.readableEnded || captureClosed) return;
        captureClosed = true;
        child.kill();
        child.stdout?.destroy();
        child.stderr?.destroy();
      });
    }
    const { stdout } = await child;
    return Buffer.from(stdout, 'latin1').toString('utf8');
  } catch (error) {
    const failure = error as ExecaError<{ encoding: 'latin1' }>;
    throw new Error(
      Buffer.from(failure.stderr ?? '', 'latin1').toString('utf8') ||
        (failure.isMaxBuffer
          ? 'stdout maxBuffer length exceeded'
          : failure.originalMessage || `Command failed: ${command}\n`),
    );
  }
}

/** Check a CLI by running its version command. */
export async function isCliInstalled(command: string): Promise<boolean> {
  try {
    await execAsync(`${command} --version`);
    return true;
  } catch {
    return false;
  }
}

/** Run an interactive CLI in the caller's terminal. */
export async function spawnInteractive(
  command: string,
  args: string[],
): Promise<void> {
  try {
    await execa(command, args, {
      stdio: 'inherit',
      shell: platform() === 'win32',
      windowsHide: false,
      cleanup: false,
      forceKillAfterDelay: false,
      verbose: 'none',
    });
  } catch (error) {
    const failure = error as ExecaError;
    throw new Error(
      failure.exitCode === undefined && failure.signal === undefined
        ? `Failed to execute ${command}: ${failure.originalMessage || failure.message}`
        : `${command} exited with code ${failure.exitCode ?? null}`,
    );
  }
}

/** A command's exit when it isn't 0, with what it wrote to stderr. */
export class CommandFailedError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(
      `${command} failed${exitCode === null ? '' : ` (exit ${exitCode})`}: ${stderr.trim() || 'no output'}`,
    );
    this.name = 'CommandFailedError';
  }
}

/** The executable isn't installed, or isn't on PATH. */
export class CommandNotFoundError extends Error {
  constructor(readonly executable: string) {
    super(`${executable} is not installed or not on PATH`);
    this.name = 'CommandNotFoundError';
  }
}

/**
 * Run an executable with argv, never a shell, and return its stdout. A
 * missing executable throws `CommandNotFoundError`, a cancel the signal's
 * reason, a timeout a plain error, and any non-zero exit
 * `CommandFailedError` with its stderr.
 */
export async function runArgv(
  executable: string,
  args: readonly string[],
  options: {
    input?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Added to this process's environment. */
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    /** Also show the child's stderr on ours (it is still captured). */
    showStderr?: boolean;
  } = {},
): Promise<string> {
  try {
    const { stdout } = await execa(executable, [...args], {
      input: options.input,
      ...(options.env && { env: options.env }),
      ...(options.cwd && { cwd: options.cwd }),
      ...(options.showStderr && { stderr: ['pipe', 'inherit'] as const }),
      cancelSignal: options.signal,
      timeout: options.timeoutMs,
      // Bun rejects 'buffer'; latin1 preserves bytes and keeps maxBuffer a byte cap.
      encoding: 'latin1',
      stripFinalNewline: false,
      maxBuffer: 16 * 1024 * 1024,
      cleanup: true,
      windowsHide: true,
      verbose: 'none',
    });
    return Buffer.from(stdout, 'latin1').toString('utf8');
  } catch (error) {
    const failure = error as ExecaError<{ encoding: 'latin1' }>;
    if ((failure as { code?: string }).code === 'ENOENT') {
      throw new CommandNotFoundError(executable);
    }
    if (failure.isCanceled && options.signal) {
      throw options.signal.reason;
    }
    if (failure.timedOut) {
      throw new Error(
        `${executable} ${args.slice(0, 3).join(' ')} timed out after ${options.timeoutMs} ms`,
      );
    }
    throw new CommandFailedError(
      `${executable} ${args.slice(0, 3).join(' ')}`,
      failure.exitCode ?? null,
      Buffer.from(failure.stderr ?? '', 'latin1').toString('utf8') ||
        failure.originalMessage ||
        failure.message,
    );
  }
}
