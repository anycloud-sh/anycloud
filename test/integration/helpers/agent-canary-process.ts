import { spawn } from 'node:child_process';
import { isRecord } from './json';

const SHUTDOWN_GRACE_MS = 5_000;
const OUTPUT_LIMIT = 64 * 1024;

/** Own a canary's process group, pipes, exit deadline, and bounded diagnostics. */
export function startCanaryProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) {
  const child = spawn(command, args, {
    ...options,
    stdio: 'pipe',
    detached: process.platform !== 'win32',
  });
  let stdout = '';
  let stderr = '';
  let failure: Error | undefined;
  let closed = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (data: string) => {
    stdout = (stdout + data).slice(-OUTPUT_LIMIT);
  });
  child.stderr.on('data', (data: string) => {
    stderr = (stderr + data).slice(-OUTPUT_LIMIT);
  });
  child.on('error', (error) => {
    failure = error;
  });
  child.stdin.on('error', (error) => {
    failure = error;
  });
  const completion = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('close', (code, signal) => {
      closed = true;
      resolve({ code, signal });
    });
  });

  function diagnostic(message: string): Error {
    return Object.assign(
      new Error(`${command}: ${message}\n${stderr}\n${stdout}`),
      { stdout, stderr },
    );
  }

  async function waitForExit(timeoutMs: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        completion,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(diagnostic(`timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function killGroup(): void {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ESRCH') throw error;
    }
  }

  let stopping: Promise<void> | undefined;
  function stop(graceMs = SHUTDOWN_GRACE_MS): Promise<void> {
    stopping ??= (async () => {
      try {
        if (!closed) {
          child.stdin.end();
          try {
            await waitForExit(graceMs);
          } catch {
            try {
              killGroup();
            } catch (error) {
              if (!isRecord(error) || error.code !== 'EPERM') throw error;
              // macOS can reject a group signal while its leader awaits reaping.
              // Close the child before the final, strict group cleanup below.
              child.kill('SIGKILL');
            }
            await waitForExit(SHUTDOWN_GRACE_MS);
          }
        }
      } finally {
        // A CLI can exit while one of its descendants remains alive.
        try {
          killGroup();
        } finally {
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
        }
      }
    })();
    return stopping;
  }

  async function waitForSuccess(timeoutMs: number): Promise<void> {
    const result = await waitForExit(timeoutMs);
    if (failure) throw diagnostic(failure.message);
    if (result.code !== 0) {
      throw diagnostic(`exited with ${result.signal ?? result.code}`);
    }
  }

  return { child, stop, waitForSuccess };
}
