import { execFile } from 'node:child_process';

export interface LocalKubernetesCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

function commandDisplay(command: string, args: readonly string[]): string {
  return [command, ...args]
    .map((part) =>
      /^[A-Za-z0-9_./:=,@+-]+$/u.test(part) ? part : JSON.stringify(part),
    )
    .join(' ');
}

export function executeLocalKubernetesCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
  } = {},
): Promise<LocalKubernetesCommandOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        encoding: 'utf8',
        env: options.env ?? process.env,
        maxBuffer: 64 * 1024 * 1024,
        timeout: options.timeoutMs ?? 180_000,
      },
      (error, stdout, stderr) => {
        const output = {
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        };
        if (!error) {
          resolve(output);
          return;
        }
        reject(
          new Error(
            `${commandDisplay(command, args)} failed: ${error.message}\n${output.stdout}${output.stderr}`,
          ),
        );
      },
    );
  });
}

export async function localKubernetesCommandSucceeds(
  command: string,
  args: readonly string[],
): Promise<boolean> {
  try {
    await executeLocalKubernetesCommand(command, args, { timeoutMs: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every retained container's state and log, in listing order. Everything goes
 * through `process.stderr.write`: Vitest buffers `console.error` and flushes
 * it later, so mixing the two channels put each header after another
 * container's log.
 */
export async function dumpLocalKubernetesDiagnostics(
  runId?: string,
  redact: (text: string) => string = (text) => text,
  options: { readonly since?: string } = {},
): Promise<void> {
  const write = (text: string) => process.stderr.write(redact(text));
  write(
    options.since
      ? `Local Kubernetes E2E cleanup finished; container logs since ${options.since}\n`
      : 'Local Kubernetes E2E failed; dumping retained container logs\n',
  );
  try {
    const { stdout: listing } = await executeLocalKubernetesCommand(
      'docker',
      [
        'ps',
        '-a',
        '--filter',
        `label=${runId ? `com.anycloud.e2e-run=${runId}` : 'com.anycloud.e2e-cluster-local=true'}`,
        '--format',
        '{{.ID}} {{.Names}} {{.Status}}',
      ],
      { timeoutMs: 15_000 },
    );
    if (!listing.trim()) {
      write('No Anycloud-managed local Kubernetes containers remain\n');
      return;
    }
    write(listing);
    for (const line of listing.trim().split(/\r?\n/u)) {
      const [containerId, containerName = containerId, ...status] =
        line.split(/\s+/u);
      if (!containerId) continue;
      try {
        // Restart and exit counts tell a crashed agent from a stuck one.
        const { stdout: state } = await executeLocalKubernetesCommand(
          'docker',
          [
            'inspect',
            '--format',
            'restarts={{.RestartCount}} exit={{.State.ExitCode}} started={{.State.StartedAt}}',
            containerId,
          ],
          { timeoutMs: 15_000 },
        );
        const logs = await executeLocalKubernetesCommand(
          'docker',
          [
            'logs',
            ...(options.since ? ['--since', options.since] : []),
            containerId,
          ],
          { timeoutMs: 30_000 },
        );
        write(
          `--- ${containerName} (${status.join(' ')}; ${state.trim()}) ---\n${logs.stdout}${logs.stderr}`,
        );
      } catch (error) {
        write(`could not read ${containerName} logs: ${String(error)}\n`);
      }
    }
  } catch (error) {
    write(
      `could not enumerate local Kubernetes diagnostics: ${String(error)}\n`,
    );
  }
}
