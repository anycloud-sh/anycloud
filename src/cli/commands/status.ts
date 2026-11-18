import { Command } from 'commander';
import { apiClient } from '../services/auth.js';
import {
  printError,
  createSpinner,
  printWorkloadHeader,
  setJsonMode,
} from '../utils/output.js';
import { resolveWorkloadId } from './shared.js';
import { resolveListWindow } from '../utils/list-window.js';
import {
  type WorkloadStatusInput as StatusRequest,
  type WorkloadStatusResponse as StatusResponse,
} from '../../shared/api-contract/workload-management-schemas.js';
import {
  SIGINT_EXIT_CODE,
  isInterrupted,
  runUntilInterrupted,
} from '../utils/interrupt.js';
import {
  DEFAULT_WATCH_INTERVAL_SECONDS,
  parseWatchInterval,
} from '../utils/watch.js';
import { buildStatusLines } from '../renderers/workload-status.js';
import {
  readWorkloadStatus,
  watchWorkloadStatus,
  workloadStatusView,
} from '../use-cases/workload-status.js';

const STATUS_WATCH_LABEL = 'Status watch';

function printStatus(
  response: StatusResponse,
  options: { verbose?: boolean; history?: boolean },
): void {
  // Workload metadata is returned alongside the status response, so
  // the header works for any workload regardless of age or --all.
  printWorkloadHeader(response.workload, {
    verbose: options.verbose,
    checkpoint: response.checkpoint,
    attempt: response.attempt,
    waiting: response.waiting,
  });
  const view = workloadStatusView(response, options);
  const lines = buildStatusLines(view, {
    ...options,
    columns: process.stdout.columns,
  });
  for (const line of lines) console.log(line);
}

export function createStatusCommand(): Command {
  return new Command('status')
    .description('📊 Get workload status')
    .argument('[id]', 'Workload ID (omit for interactive picker)')
    .option('--verbose', 'Show detailed logs')
    .option('--history', 'Show every event, including Service upgrade history')
    .option(
      '-w, --watch',
      'Poll status until the workload reaches a terminal state',
    )
    .option(
      '--interval <seconds>',
      `Polling interval for --watch (default ${DEFAULT_WATCH_INTERVAL_SECONDS}s)`,
    )
    .option(
      '-p, --period <window>',
      'Limit the picker to workloads started within this window (e.g. 24h, 7d)',
    )
    .option('-n, --limit <count>', 'Max workloads in the picker, newest first')
    .option('--json', 'Emit the raw StatusResponse as JSON')
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud status anycloud-123153255
  $ anycloud status                                 # TTY picker (newest workloads)
  $ anycloud status -p 7d                           # TTY picker, last 7 days
  $ anycloud status -n 500                          # TTY picker, newest 500
  $ anycloud status anycloud-123153255 --verbose    # show detailed logs
  $ anycloud status anycloud-123153255 --history    # show every event and Service upgrade
  $ anycloud status anycloud-123153255 --watch      # refresh until terminal
  $ anycloud status anycloud-123153255 --json       # machine-readable output
  $ anycloud status anycloud-123153255 --watch --json | jq -c '.workload.state'

Non-interactive mode (CI/automation):
  $ CI=true ANYCLOUD_WORKLOAD_ID=anycloud-123153255 anycloud status

  Environment variables:
    CI                       Disable the picker (set to true)
    GITHUB_TOKEN             GitHub token for authentication
    ANYCLOUD_WORKLOAD_ID   Workload ID to inspect

Output:
  ✅  completed

  Image       myapp:latest
  Cloud       azure / westus2
  VM          Standard_B2s
  Spot        yes
  Disk Size   400 GB
  CLI Version 0.1.5
  Bucket      my-bucket

  VMs:
    1.2.3.4
      ✓ container    running    2h
      ✓ bucket-sync  running

  [07:23:05] provisioning
  [07:24:01] starting
  [07:24:30] completed
`,
    )
    .action(
      async (
        id: string | undefined,
        options: {
          verbose?: boolean;
          history?: boolean;
          watch?: boolean;
          interval?: string;
          period?: string;
          limit?: string;
          json?: boolean;
        },
      ) => {
        try {
          if (options?.json) setJsonMode(true);
          const intervalSeconds = parseWatchInterval(options?.interval);
          const { limit, sinceMs } = resolveListWindow({
            period: options?.period,
            limit: options?.limit,
          });
          const workloadId = await resolveWorkloadId(id, {
            limit,
            sinceMs,
          });
          // Use longer timeout in verbose mode (20s vs 6s) to allow for slower health checks
          const api = await apiClient({
            requestTimeoutMs: options?.verbose ? 20_000 : undefined,
          });

          const statusRequest: StatusRequest = {
            id: workloadId,
            ...(options?.verbose && { verbose: true }),
          };
          if (options?.watch) {
            await runUntilInterrupted(STATUS_WATCH_LABEL, (signal) =>
              watchWorkloadStatus(api, statusRequest, {
                history: options?.history,
                intervalSeconds,
                signal,
                onStatus: (response, iteration) => {
                  if (options?.json) {
                    console.log(JSON.stringify(response));
                    return;
                  }
                  if (process.stdout.isTTY) {
                    process.stdout.write('\x1b[2J\x1b[H');
                  } else if (iteration > 0) {
                    console.log('');
                    console.log('---');
                  }
                  printStatus(response, options);
                },
              }),
            );
            return;
          }

          // Get status (credentials and SSH keys are now stored in API SQLite)
          const spinner = createSpinner(`Fetching status...`).start();
          const response = await readWorkloadStatus(
            api,
            statusRequest,
            options,
          );
          spinner.stop();

          if (options?.json) {
            console.log(JSON.stringify(response));
            return;
          }

          printStatus(response, options);
        } catch (error) {
          if (isInterrupted(error)) {
            process.exitCode = SIGINT_EXIT_CODE;
            return;
          }
          printError(`Failed to fetch status: ${(error as Error).message}`);
          process.exit(1);
        }
      },
    );
}
