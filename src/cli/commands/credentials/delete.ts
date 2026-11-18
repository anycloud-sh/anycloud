import { Command } from 'commander';
import { apiClient } from '../../services/auth.js';
import type { RedactedCredential } from '../../../shared/api-contract/credentials-schemas.js';
import {
  exitWithError,
  printSuccess,
  printError,
  printInfo,
} from '../../utils/output.js';
import { suggestFilter } from '../../utils/suggest-filter.js';
import { safePrompts, shouldAllowPrompts } from '../../utils/safe-prompts.js';
import {
  deleteRoleConnection,
  type DeleteOptions,
} from '../../services/role-connection-teardown.js';

async function resolveCredentialName(
  providedName: string | undefined,
  credentials: RedactedCredential[],
): Promise<string> {
  if (providedName) return providedName;

  if (credentials.length === 0) {
    printError('No credentials configured.');
    printInfo('Use "anycloud credentials new" to add credentials.');
    process.exit(1);
  }

  if (!shouldAllowPrompts()) {
    exitWithError(
      'Missing credential name. Pass it as: anycloud credentials delete <name>',
    );
  }

  const widest = credentials.reduce((m, c) => Math.max(m, c.name.length), 0);
  const selection = await safePrompts<'credential'>({
    type: 'autocomplete',
    name: 'credential',
    message: 'Pick credentials to delete',
    hint: '⌨️  Type to filter',
    choices: credentials.map((c) => ({
      title: `${c.name.padEnd(widest)}  (${c.cloudProvider})`,
      value: c.name,
    })),
    suggest: suggestFilter,
  });

  if (!selection.credential) process.exit(0);
  return selection.credential as string;
}

export function createDeleteCommand(): Command {
  return new Command('delete')
    .description('🗑️  Delete a credential set')
    .argument('[name]', 'Name of the credential set to delete')
    .option(
      '-f, --force',
      'Delete even if non-terminal workloads reference the credential',
      false,
    )
    .option(
      '--apply',
      "For a role connection: also delete what credentials new --role --apply created, through this machine's signed-in aws, gcloud or az",
    )
    .option('--profile <name>', 'With --apply: the AWS profile to delete in')
    .option('--json', 'With --apply: print what was deleted and kept as JSON')
    .addHelpText(
      'after',
      `
Deletion is blocked while non-terminal workloads reference the credential;
rerun with --force to override. Running workloads keep resolving their
already-encrypted credentials until they reach a terminal state.

--apply also deletes a role connection's cloud side: after checking it is this
connection's, the saved connection goes (refused while workloads use it),
then the cloud side; a cloud failure is finished with the cloud's CLI.

Examples:
  $ anycloud credentials delete prod-aws
  $ anycloud creds delete staging-azure --force
  $ anycloud credentials delete prod-gcp --apply --json
`,
    )
    .action(async (name: string | undefined, options: DeleteOptions) => {
      if (options.apply) return deleteRoleConnection(name, options);
      try {
        const client = await apiClient();
        const credentials = await client.credentials.list();
        const credentialName = await resolveCredentialName(name, credentials);

        if (!credentials.some((c) => c.name === credentialName)) {
          printError(`Credential "${credentialName}" not found`);
          printInfo('Available credentials:');
          credentials.forEach((c) => {
            printInfo(`  - ${c.name}`);
          });
          process.exit(1);
        }

        await client.credentials.delete({
          params: { name: credentialName },
          query: { force: options.force === true ? 'true' : 'false' },
        });

        printSuccess(`Credential "${credentialName}" deleted successfully`);
      } catch (error) {
        printError(`Failed to delete credential: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}
