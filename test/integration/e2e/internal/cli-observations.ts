import type { CliClient } from './cli.js';
import { isRecord, type CommandResult, type StatusResponse } from './types.js';

/**
 * What a user or agent sees through the CLI for a live or finished Job:
 * `wait`, `status` and `logs --follow` as RFC 0041 promises them.
 */

function completed(result: CommandResult, label: string): CommandResult {
  if (
    result.signal ||
    result.aborted ||
    result.spawnError ||
    result.timedOut ||
    result.outputTruncated ||
    result.exitCode !== 0
  )
    throw new Error(
      `${label} did not complete successfully (exit ${String(result.exitCode)}${result.timedOut ? ', timed out' : ''}): ${result.stderr.trim().slice(-500)}`,
    );
  return result;
}

/** `wait` exits 0 with a succeeded result, and `status` shows `finished, exit 0`. */
export async function completedJobByCli(
  cli: Pick<CliClient, 'run'>,
  id: string,
): Promise<{
  readonly waitSucceeded: boolean;
  readonly statusFinished: boolean;
}> {
  const options = { timeoutMs: 90_000, recordArtifact: false } as const;
  const wait = completed(
    await cli.run(['wait', id, '--json', '--timeout', '60s'], {
      ...options,
      label: 'cli-wait-completed-job',
    }),
    'CLI wait for the completed Job',
  );
  const result: unknown = JSON.parse(
    wait.stdout.trim().split('\n').at(-1) ?? '',
  );
  const status = completed(
    await cli.run(['status', id, '--verbose'], {
      ...options,
      label: 'cli-status-completed-job',
    }),
    'CLI status for the completed Job',
  );
  return {
    waitSucceeded:
      isRecord(result) &&
      result.type === 'result' &&
      result.outcome === 'succeeded',
    statusFinished: status.stdout.includes('finished, exit 0'),
  };
}

/** The checkpoint facts `status --json` reports for a Workload. */
export async function statusCheckpoint(
  cli: Pick<CliClient, 'runWithTransientRetries'>,
  id: string,
): Promise<StatusResponse['checkpoint']> {
  // A brief API outage is retried; any other failure is final.
  const status = completed(
    await cli.runWithTransientRetries(['status', id, '--json'], {
      timeoutMs: 90_000,
      recordArtifact: false,
      label: 'cli-status-checkpoint',
    }),
    'CLI status for checkpoint health',
  );
  const response = JSON.parse(status.stdout) as StatusResponse;
  return response.checkpoint;
}

/**
 * `logs --follow 2>&1 | grep -m1 pattern` returns once the marker appears: the
 * CLI notices its reader is gone and exits 0 instead of streaming on.
 */
export async function logsStopWithTheirReader(
  cli: Pick<CliClient, 'runToFirstMatch'>,
  id: string,
  pattern: string,
): Promise<{ readonly matched: boolean; readonly cliExitedZero: boolean }> {
  const result = await cli.runToFirstMatch(['logs', id, '--follow'], pattern, {
    timeoutMs: 180_000,
    recordArtifact: false,
    label: 'cli-logs-follow-first-match',
  });
  const lines = result.stdout.trim().split('\n');
  return {
    matched:
      !result.timedOut &&
      lines.length === 2 &&
      new RegExp(pattern, 'u').test(lines[0] ?? ''),
    cliExitedZero: !result.timedOut && lines.at(-1) === 'exit:0',
  };
}

/** `anycloud wait <id>` exits 0 with a ready state record (a running Service or VM). */
export async function waitReadyByCli(
  cli: Pick<CliClient, 'run'>,
  id: string,
  timeoutMs: number,
): Promise<boolean> {
  const wait = await cli.run(
    ['wait', id, '--json', '--timeout', `${Math.ceil(timeoutMs / 1000)}s`],
    {
      timeoutMs: timeoutMs + 60_000,
      recordArtifact: false,
      label: 'cli-wait-ready',
    },
  );
  return (
    wait.exitCode === 0 &&
    wait.stdout
      .trim()
      .split('\n')
      .some((line) => {
        try {
          const record: unknown = JSON.parse(line);
          return (
            isRecord(record) && record.type === 'state' && record.ready === true
          );
        } catch {
          return false;
        }
      })
  );
}

/**
 * `anycloud wait <vm>` reports the VM ready, and an `anycloud exec` run
 * straight after it succeeds: RFC 0041's readiness promise.
 */
export async function vmReadyByCli(
  cli: Pick<CliClient, 'run'>,
  id: string,
  timeoutMs: number,
): Promise<{ readonly waitReady: boolean; readonly execAfterWait: boolean }> {
  const waitReady = await waitReadyByCli(cli, id, timeoutMs);
  if (!waitReady) return { waitReady, execAfterWait: false };
  const exec = await cli.run(['exec', id, 'true'], {
    timeoutMs: 120_000,
    recordArtifact: false,
    label: 'cli-exec-after-wait',
  });
  return { waitReady, execAfterWait: exec.exitCode === 0 && !exec.timedOut };
}
