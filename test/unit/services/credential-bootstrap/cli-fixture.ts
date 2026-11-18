import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa, type Options } from 'execa';
import { afterEach, expect, vi } from 'vitest';

interface Response {
  stdout?: string;
  stdoutBytes?: number[];
  stderr?: string;
  exitCode?: number;
  wait?: boolean;
  ignoreSigterm?: boolean;
  holdPipe?: 'stdout' | 'stderr';
  environment?: string[];
}

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Shorten both native Execa deadlines and application pipe-cleanup deadlines. */
export async function shortenCliDeadline(): Promise<void> {
  const actual = await vi.importActual<typeof import('execa')>('execa');
  const execute: (
    file: string,
    args: readonly string[],
    options: Options,
  ) => ReturnType<typeof execa> = execa;
  vi.mocked(execute).mockImplementationOnce((file, args, options) =>
    actual.execa(file, args, { ...options, timeout: 1_000 }),
  );
  const original = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(
    (callback, ms, ...args) =>
      original(callback, ms === 30_000 || ms === 60_000 ? 1_000 : ms, ...args),
  );
}

/** A real local CLI; only explicitly selected environment names are recorded. */
export async function cliFixture(binary: string, response: Response = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cloud-cli-runner-'));
  directories.push(directory);
  const executable = path.join(directory, binary);
  await symlink(process.execPath, path.join(directory, 'node'));
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const directory = path.dirname(process.argv[1]);
const response = JSON.parse(fs.readFileSync(path.join(directory, 'response.json'), 'utf8'));
process.on('SIGTERM', () => {
  fs.appendFileSync(path.join(directory, 'signals'), 'SIGTERM\\n');
  if (!response.ignoreSigterm) process.exit(0);
});
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const helper = response.holdPipe && require('node:child_process').spawn(
  process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['ignore', response.holdPipe === 'stdout' ? 'inherit' : 'ignore',
      response.holdPipe === 'stderr' ? 'inherit' : 'ignore'],
  });
fs.writeFileSync(path.join(directory, 'observed.json'), JSON.stringify({
  pid: process.pid,
  helperPid: helper?.pid,
  args: process.argv.slice(2),
  env: Object.fromEntries((response.environment ?? []).map(name => [name, process.env[name]])),
}));
process.stdout.write(response.stdoutBytes ? Buffer.from(response.stdoutBytes) : response.stdout ?? '');
process.stderr.write(response.stderr ?? '');
process.exitCode = response.exitCode ?? 0;
if (response.wait) setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
  const respond = async (value: Response) => {
    await rm(path.join(directory, 'observed.json'), { force: true });
    await writeFile(
      path.join(directory, 'response.json'),
      JSON.stringify(value),
    );
  };
  const observed = async () =>
    JSON.parse(
      await readFile(path.join(directory, 'observed.json'), 'utf8'),
    ) as {
      pid: number;
      helperPid?: number;
      args: string[];
      env: Record<string, string>;
    };
  await respond(response);
  vi.stubEnv('PATH', directory);
  return {
    executable,
    environment: { PATH: directory },
    respond,
    observed,
    signalCount: async () => {
      const signals = await readFile(
        path.join(directory, 'signals'),
        'utf8',
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return '';
      });
      return signals.split('SIGTERM').length - 1;
    },
    cleanup: async () => {
      const observation = await observed().catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        },
      );
      const pids = [observation?.pid, observation?.helperPid].filter(
        (pid): pid is number => pid !== undefined,
      );
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      await vi.waitFor(() => {
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      });
    },
  };
}
