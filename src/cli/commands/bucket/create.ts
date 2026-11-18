import { Command } from 'commander';
import { apiClient } from '../../services/auth.js';
import { printError, printSuccess } from '../../utils/output.js';
import { resolveOptionalNamedCredential } from '../shared.js';

export function createBucketCreateCommand(): Command {
  return new Command('create')
    .description('Create a bucket (idempotent — no-op if it already exists)')
    .argument('<bucket-name>', 'Bucket name')
    .option(
      '--credentials <name>',
      'Named cloud credential to use for the bucket',
    )
    .option('--region <region>', 'Bucket region (required for some providers)')
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud bucket create my-bucket --credentials prod-aws
  $ anycloud bucket create my-bucket --credentials prod-gcp --region us-central1
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
          await api.bucket.create({
            params: {
              bucketName,
              credentialName: credential.name,
            },
            query: {
              ...(options.region ? { region: options.region } : {}),
            },
          });
          printSuccess(`Bucket ${bucketName} ready`);
        } catch (error) {
          printError(`Create failed: ${(error as Error).message}`);
          process.exit(1);
        }
      },
    );
}
