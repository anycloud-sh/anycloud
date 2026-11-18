import { Command } from 'commander';
import { apiClient } from '../../services/auth.js';
import { printError, printSuccess } from '../../utils/output.js';
import { resolveOptionalNamedCredential } from '../shared.js';

export function createBucketDeleteCommand(): Command {
  return new Command('delete')
    .description(
      'Delete a bucket and all its contents (idempotent — no-op if missing)',
    )
    .argument('<bucket-name>', 'Bucket name')
    .option(
      '--credentials <name>',
      'Named cloud credential to use for the delete',
    )
    .option('--region <region>', 'Bucket region (required for some providers)')
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud bucket delete my-bucket --credentials prod-aws
  $ anycloud bucket delete my-bucket --credentials prod-gcp --region us-central1
`,
    )
    .action(
      async (
        bucketName: string,
        options: { credentials?: string; region?: string },
      ) => {
        try {
          const credential = await resolveOptionalNamedCredential({
            credentials: options.credentials,
          });
          const api = await apiClient();
          await api.bucket.delete({
            params: {
              bucketName,
              credentialName: credential.name,
            },
            query: {
              ...(options.region ? { region: options.region } : {}),
            },
          });
          printSuccess(`Bucket ${bucketName} deleted`);
        } catch (error) {
          printError(`Delete failed: ${(error as Error).message}`);
          process.exit(1);
        }
      },
    );
}
