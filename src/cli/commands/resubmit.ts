import { Command } from 'commander';
import { apiClient } from '../services/auth.js';
import { printInfo, printError, createSpinner } from '../utils/output.js';
import { resolveWorkloadIds } from './shared.js';
import { detectSession } from '../session/detect.js';

export function createResubmitCommand(): Command {
  return new Command('resubmit')
    .description('Resubmit one or more workloads in a terminal state')
    .argument('[ids...]', 'Workload IDs (omit for interactive picker)')
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud resubmit abc123 def456
  $ anycloud resubmit              # interactive multi-select picker (TTY)

Non-interactive mode (CI/automation):
  $ ANYCLOUD_WORKLOAD_ID=abc123,def456 anycloud resubmit
`,
    )
    .action(async (ids: string[]) => {
      try {
        const client = await apiClient();
        const detected = detectSession();

        const workloadIds = await resolveWorkloadIds(ids, {
          // The API returns the resubmittable set (terminal but not completed),
          // bounded — no client-side filter or row cap to wire here.
          stateClass: 'resubmittable',
          noneMessage:
            'No failed, errored, invalid, or terminated workloads to resubmit.',
          cancelMessage: 'No workloads selected.',
        });

        for (const workloadId of workloadIds) {
          printInfo(`Resubmitting: ${workloadId}`);
          const spinner = createSpinner('Resubmitting workload...').start();
          try {
            const response = await client.workloads.resubmit({
              params: { id: workloadId },
              body: { session: detected?.session },
            });
            spinner.succeed('Workload resubmitted!');

            if (response.message) {
              printInfo(response.message);
            }
          } catch (error) {
            spinner.fail(`Failed to resubmit ${workloadId}`);
            printError((error as Error).message);
          }
        }
        console.log('');
      } catch (error) {
        printError(`Failed to resubmit workload: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}
