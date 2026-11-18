import { Command } from 'commander';
import { apiClient } from '../../services/auth.js';
import { printSuccess, printError } from '../../utils/output.js';
import {
  credentialUpdateFields,
  type CredentialEditOptions,
} from '../../services/credential-onboarding/index.js';

export function createEditCommand(): Command {
  return new Command('edit')
    .description(
      '✏️  Update existing credentials (only supplied flags are changed)',
    )
    .argument('<name>', 'Name of the credential set to edit')
    .option('--access-key-id <id>', 'AWS access key ID')
    .option('--secret-access-key <key>', 'AWS secret access key')
    .option('--application-id <id>', 'Azure application (client) ID')
    .option('--secret <secret>', 'Azure client secret')
    .option('--subscription-id <id>', 'Azure subscription ID')
    .option('--directory-id <id>', 'Azure directory (tenant) ID')
    .option('--project-id <id>', 'GCP project ID')
    .option('--client-email <email>', 'GCP service-account client email')
    .option('--private-key <key>', 'GCP service-account private key')
    .option('--key-file <path>', 'GCP service-account JSON key file')
    .option('--api-key <key>', 'Lambda Labs API key')
    .option('--api-token <token>', 'Cloudflare API token')
    .option('--jurisdiction <name>', 'Cloudflare R2: default, eu, or fedramp')
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud credentials edit prod-aws --secret-access-key NEW...
  $ anycloud credentials edit prod-azure --secret NEW...
  $ anycloud credentials edit prod-gcp --key-file /path/to/new-key.json

Provider cannot be changed. To switch providers, delete the credential and create a new one.
`,
    )
    .action(async (name: string, options: CredentialEditOptions) => {
      try {
        const client = await apiClient();
        await client.credentials.update({
          params: { name },
          body: await credentialUpdateFields(options),
        });

        printSuccess(`Credentials "${name}" updated successfully!`);
      } catch (error) {
        printError(`Failed to edit credentials: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}
