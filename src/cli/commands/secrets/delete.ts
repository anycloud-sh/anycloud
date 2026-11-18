import { Command } from 'commander';
import { apiClient } from '../../services/auth.js';
import { printSuccess, printError, printInfo } from '../../utils/output.js';

export function createDeleteCommand(): Command {
  return new Command('delete')
    .description('🗑️  Delete a secret')
    .argument('<name>', 'Name of the secret to delete')
    .option(
      '-f, --force',
      'Delete even if non-terminal workloads or Deployments reference the secret',
      false,
    )
    .addHelpText(
      'after',
      `
Deletion is blocked while non-terminal workloads or Deployments reference
the secret; rerun with --force to override. A container already running with
the injected values is unaffected until its VM terminates — deletion affects
future VM starts (job, resubmit, and spot-preemption recovery) and stops a
referencing Deployment from reconciling until the secret is saved again.

Examples:
  $ anycloud secrets delete hf
  $ anycloud secrets delete hf --force
`,
    )
    .action(async (name: string, options: { force?: boolean }) => {
      try {
        const client = await apiClient();
        const secrets = await client.secrets.list();

        if (!secrets.some((s) => s.name === name)) {
          printError(`Secret "${name}" not found`);
          if (secrets.length > 0) {
            printInfo('Available secrets:');
            secrets.forEach((s) => printInfo(`  - ${s.name}`));
          }
          process.exit(1);
        }

        await client.secrets.delete({
          params: { name },
          query: { force: options.force === true ? 'true' : 'false' },
        });
        printSuccess(`Secret "${name}" deleted successfully`);
      } catch (error) {
        printError(`Failed to delete secret: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}
