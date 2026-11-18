import { ORPCError } from '@orpc/client';
import { apiClient } from '../../services/auth.js';
import { Command } from 'commander';
import { printError, printSuccess } from '../../utils/output.js';
import { resolveOptionalNamedCredential } from '../shared.js';

export function createBucketExistsCommand(): Command {
  return new Command('exists')
    .description('Check whether a bucket exists')
    .argument('<bucket-name>', 'Bucket name')
    .option(
      '--credentials <name>',
      'Named cloud credential to use for the check',
    )
    .option('--region <region>', 'Bucket region (required for some providers)')
    .addHelpText(
      'after',
      `
Exit codes:
  0  bucket exists
  1  bucket does not exist
  2  check failed

Examples:
  $ anycloud bucket exists my-bucket --credentials prod-aws
  $ anycloud bucket exists my-bucket --credentials prod-gcp --region us-central1
`,
    )
    .action(
      async (
        bucketName: string,
        options: { credentials?: string; region?: string },
      ) => {
        let exists: boolean;
        try {
          const credential = await resolveOptionalNamedCredential({
            credentials: options.credentials,
          });
          const api = await apiClient();
          await api.bucket.exists({
            params: {
              bucketName,
              credentialName: credential.name,
            },
            query: {
              ...(options.region ? { region: options.region } : {}),
            },
          });
          exists = true;
        } catch (error) {
          if (error instanceof ORPCError && error.status === 404) {
            exists = false;
          } else {
            printError(`Exists check failed: ${(error as Error).message}`);
            process.exit(2);
            return;
          }
        }

        if (exists) {
          printSuccess(`Bucket ${bucketName} exists`);
          return;
        }
        printError(`Bucket ${bucketName} does not exist`);
        process.exit(1);
      },
    );
}
