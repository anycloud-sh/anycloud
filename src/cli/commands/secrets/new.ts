import { Command } from 'commander';
import { apiClient } from '../../services/auth.js';
import { printSuccess, printError } from '../../utils/output.js';

export function createNewCommand(): Command {
  return new Command('new')
    .description('➕ Create or update a secret')
    .argument(
      '<name>',
      'Name of the secret (letters, numbers, _ and -; a leading _ hides it)',
    )
    .argument(
      '<entries...>',
      'KEY=VALUE pairs (env vars to inject into the container)',
    )
    .addHelpText(
      'after',
      `
Values are stored encrypted at rest and never returned by the API. To inject
the values as env vars inside a Job, pass the name via --secret. On a VM Job,
Service or VM, each key is also the file /run/anycloud-secrets/<name>/<KEY>,
which a later save updates in place. A name starting with _ is hidden from
"secrets list" unless --all is passed.

Examples:
  $ anycloud secrets new hf HF_TOKEN=hf_...
  $ anycloud secrets new wandb WANDB_API_KEY=... WANDB_ENTITY=myteam
  $ anycloud job nginx --secret hf --secret wandb
`,
    )
    .action(async (name: string, entries: string[]) => {
      try {
        if (entries.length === 0) {
          printError('At least one KEY=VALUE pair is required');
          process.exit(1);
        }

        const values: Record<string, string> = {};
        for (const entry of entries) {
          const eq = entry.indexOf('=');
          if (eq <= 0) {
            printError(
              `Invalid entry "${entry}" — must be KEY=VALUE with a non-empty key`,
            );
            process.exit(1);
          }
          const key = entry.slice(0, eq);
          const value = entry.slice(eq + 1);
          values[key] = value;
        }

        const api = await apiClient();
        await api.secrets.save({
          params: { name },
          body: { values },
        });
        printSuccess(
          `Secret "${name}" saved with ${Object.keys(values).length} key${
            Object.keys(values).length === 1 ? '' : 's'
          }`,
        );
      } catch (error) {
        printError(`Failed to save secret: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}
