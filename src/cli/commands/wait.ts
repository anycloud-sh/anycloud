import { Command } from 'commander';
import { apiClient } from '../services/auth.js';
import { printError, setJsonMode } from '../utils/output.js';
import {
  SIGINT_EXIT_CODE,
  isInterrupted,
  runUntilInterrupted,
} from '../utils/interrupt.js';
import { readWorkloadStatus } from '../use-cases/workload-status.js';
import { sleep } from '../../shared/utils.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import {
  WAIT_EXIT,
  parseWaitTarget,
  parseWaitTimeout,
  waitForTargets,
  type WaitObservation,
  type WaitTarget,
} from '../use-cases/workload-wait.js';
import { formatWaitRecord } from '../renderers/workload-wait.js';

/**
 * Wait on Workloads, Deployments, node pools or clusters that already exist,
 * as `wait` and as `--wait` after a create or upgrade. Returns the exit code.
 */
export async function runWait(
  targets: readonly (string | WaitTarget)[],
  options: { json?: boolean; timeout?: string },
): Promise<number> {
  try {
    const parsed = targets.map((target) =>
      typeof target === 'string' ? parseWaitTarget(target) : target,
    );
    const timeoutMs =
      options.timeout === undefined
        ? undefined
        : parseWaitTimeout(options.timeout);
    const api = await apiClient({
      missingExitCode: WAIT_EXIT['observer-error'],
    });
    const read = async (
      target: WaitTarget,
      signal?: AbortSignal,
    ): Promise<WaitObservation> => {
      const params = { params: { id: target.id } };
      switch (target.kind) {
        case 'workload':
          return {
            kind: target.kind,
            status: await readWorkloadStatus(
              api,
              { id: target.id },
              { signal },
            ),
          };
        case 'deployment':
          return {
            kind: target.kind,
            deployment: (await api.deployments.get(params, { signal }))
              .deployment,
          };
        case 'node-pool':
          return {
            kind: target.kind,
            nodePool: (await api.nodePools.get(params, { signal })).nodePool,
          };
        case 'cluster':
          return {
            kind: target.kind,
            cluster: (await api.clusters.get(params, { signal })).cluster,
          };
      }
    };
    return await runUntilInterrupted('Wait', (signal) =>
      waitForTargets(
        parsed,
        {
          read,
          emit: (record) =>
            console.log(formatWaitRecord(record, options.json === true)),
          now: Date.now,
          sleep,
        },
        { timeoutMs, signal },
      ),
    );
  } catch (error) {
    if (isInterrupted(error)) return SIGINT_EXIT_CODE;
    printError(`Failed to wait: ${errorMessage(error)}`);
    return WAIT_EXIT['observer-error'];
  }
}

export function createWaitCommand(): Command {
  return (
    new Command('wait')
      .description(
        '⏳ Wait until Workloads, Deployments, node pools or clusters are ready',
      )
      .argument(
        '<id...>',
        'Workload IDs, or deployment/<id>, node-pool/<id>, cluster/<id>',
      )
      // A usage error is not a failed Workload: exit 2, keeping 1 for failures.
      .exitOverride((error) =>
        process.exit(error.exitCode === 0 ? 0 : WAIT_EXIT['observer-error']),
      )
      .option('--json', 'Emit one JSON record per line')
      .option(
        '--timeout <duration>',
        'Give up after this long (90s, 30m, 2h); nothing is stopped',
      )
      .addHelpText(
        'after',
        `
Examples:
  $ anycloud wait train-a                       # until the Job completes
  $ anycloud wait screen-1 screen-2 --json      # NDJSON, one record per change
  $ anycloud wait analysis-vm --timeout 30m     # until the VM is running
  $ anycloud wait node-pool/gpu deployment/inference   # until both are ready

A Job succeeds when it completes; a Service, VM, node pool or cluster when it
runs; a Deployment when the Pod on its latest revision is ready. Any other
final state is a failure. Prints a line when something changes state or
reports why it waits, and a heartbeat after 30 minutes without one.
Exit codes: 0 every target succeeded, 1 one failed, 2 the wait could not
observe one, 4 the timeout elapsed, 130 Ctrl-C. Waiting never changes what it
waits on.
`,
      )
      .action(
        async (
          ids: string[],
          options: { json?: boolean; timeout?: string },
        ) => {
          if (options.json) setJsonMode(true);
          process.exitCode = await runWait(ids, options);
        },
      )
  );
}
