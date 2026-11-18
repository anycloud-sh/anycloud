import { Command } from 'commander';
import { apiClient } from '../services/auth.js';
import { printInfo, printError, createSpinner } from '../utils/output.js';
import { resolveWorkloadIds } from './shared.js';
import { detectSession } from '../session/detect.js';

export function createTerminateCommand(): Command {
  return new Command('terminate')
    .description('🛑 Terminate one or more workloads')
    .argument('[ids...]', 'Workload IDs (omit for interactive picker)')
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud terminate abc123 def456 ghi789
  $ anycloud terminate              # interactive multi-select picker (TTY)

Non-interactive mode (CI/automation):
  $ ANYCLOUD_WORKLOAD_ID=abc123,def456 anycloud terminate

Output:
  Terminating: abc123
  ✓ Workload termination scheduled successfully!
`,
    )
    .action(async (ids: string[]) => {
      try {
        const client = await apiClient();
        const detected = detectSession();
        // Picker shows the server-filtered terminatable set (active, or a
        // terminal outcome whose provider cleanup is still pending), bounded
        // server-side.
        // Explicit ids skip the picker entirely; the terminate endpoint is
        // authoritative and handles terminal/unknown ids gracefully.
        const workloadIds = await resolveWorkloadIds(ids, {
          stateClass: 'terminatable',
          noneMessage: 'No workloads to terminate.',
          cancelMessage: '👋 No workloads selected, nothing to do.',
        });

        let hadFailure = false;
        for (const workloadId of workloadIds) {
          printInfo(`Terminating: ${workloadId}`);

          const spinner = createSpinner('Terminating workload...').start();
          try {
            const response = await client.workloads.terminate({
              params: { id: workloadId },
              query: { session: detected?.session },
            });
            spinner.succeed('Workload termination scheduled successfully!');

            if (response.message) {
              printInfo(response.message);
            }
          } catch (error) {
            hadFailure = true;
            spinner.fail(`Failed to terminate ${workloadId}`);
            printError((error as Error).message);
          }
        }
        if (hadFailure) process.exitCode = 1;
        console.log('');
      } catch (error) {
        printError(`Failed to terminate workload: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}
