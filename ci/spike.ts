import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export function parseSpikeArguments(value: string): string[] {
  if (value.length > 32_768) throw new Error('Spike arguments exceed 32 KiB');
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length > 128 ||
    !parsed.every((item) => typeof item === 'string' && !item.includes('\0'))
  ) {
    throw new Error(
      'Spike arguments must be a JSON array of at most 128 strings without NUL bytes',
    );
  }
  return parsed;
}

export function spikeEntrypoint(root: string, experiment: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(experiment)) {
    throw new Error(
      'Experiment must be one lowercase, hyphen-separated directory name',
    );
  }
  const directory = resolve(realpathSync(root), 'experiments', experiment);
  if (
    realpathSync(directory) !== directory ||
    !lstatSync(directory).isDirectory()
  ) {
    throw new Error(
      'Experiment must be a regular directory under experiments/',
    );
  }
  const entrypoint = resolve(directory, 'run.ts');
  for (const path of [entrypoint, resolve(directory, 'README.md')]) {
    if (!lstatSync(path).isFile())
      throw new Error('Experiment requires regular run.ts and README.md files');
  }
  return entrypoint;
}

export function assertSpikeRevision(expected: string, actual: string): void {
  if (!/^[0-9a-f]{40}$/.test(expected) || actual !== expected) {
    throw new Error('Spike checkout must match the requested full commit SHA');
  }
}

export async function executeSpike(input: {
  root: string;
  entrypoint: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
}): Promise<number> {
  // Arguments are passed directly, never interpreted by a shell. Each
  // experiment owns provisioning and an independently resumable cleanup path.
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', input.entrypoint, ...input.args],
    {
      cwd: input.root,
      env: input.environment,
      stdio: 'inherit',
      detached: true,
    },
  );
  let interrupted: NodeJS.Signals | undefined;
  const forwardSignal = (signal: NodeJS.Signals): void => {
    interrupted = signal;
    if (
      child.pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const interrupt = (): void => forwardSignal('SIGINT');
  const terminate = (): void => forwardSignal('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (interrupted) resolve(interrupted === 'SIGINT' ? 130 : 143);
        else resolve(code ?? (signal === 'SIGINT' ? 130 : 143));
      });
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}
