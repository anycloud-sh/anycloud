import { Command } from 'commander';
import { apiClient } from '../../services/auth.js';
import { printError, printSuccess } from '../../utils/output.js';
import { resolveOptionalNamedCredential } from '../shared.js';
import { safePrompts, shouldAllowPrompts } from '../../utils/safe-prompts.js';
import {
  BucketBatchOperationError,
  formatBucketBatchResult,
  formatBucketBytes,
  listAllBucketObjects,
  resolveBucketConcurrency,
  runBucketBatch,
  validateDirectoryPrefix,
  validateRecursiveProvider,
} from './batch.js';

interface BucketRmOptions {
  credentials?: string;
  region?: string;
  recursive?: boolean;
  concurrency?: string;
  yes?: boolean;
}

function printBatchDeleteError(error: BucketBatchOperationError): void {
  printError(
    `Recursive delete partially failed: ${formatBucketBatchResult(error.result)}`,
  );
  for (const failure of error.failures) {
    printError(`${failure.key}: ${failure.error.message}`);
  }
}

export function createBucketRmCommand(): Command {
  return new Command('rm')
    .description('Delete one object or a directory prefix from a bucket')
    .argument('<bucket-name>', 'Bucket name')
    .argument('<remote-path>', 'Object key inside the bucket')
    .option(
      '--credentials <name>',
      'Named cloud credential to use for the delete',
    )
    .option('--region <region>', 'Bucket region (required for some providers)')
    .option('-r, --recursive', 'Delete every object under a directory prefix')
    .option(
      '--concurrency <count>',
      'Concurrent recursive deletes (default 4, maximum 32)',
    )
    .option('-y, --yes', 'Skip recursive deletion confirmation')
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud bucket rm my-bucket data/data.bin --credentials prod-aws
  $ anycloud bucket rm my-bucket models/v1.pt --credentials prod-gcp --region us-central1
  $ anycloud bucket rm my-bucket old-checkpoints/ --recursive --credentials prod-aws
  $ anycloud bucket rm my-bucket old-checkpoints/ --recursive --yes --concurrency 8 --credentials prod-gcp
`,
    )
    .action(
      async (
        bucketName: string,
        remotePath: string,
        options: BucketRmOptions,
      ) => {
        try {
          if (!options.recursive && options.concurrency !== undefined) {
            throw new Error('--concurrency requires --recursive');
          }
          if (!options.recursive && options.yes) {
            throw new Error('--yes requires --recursive');
          }
          const concurrency = resolveBucketConcurrency(options.concurrency);
          const credential = await resolveOptionalNamedCredential({
            credentials: options.credentials,
          });
          const client = await apiClient();
          const params = {
            bucketName,
            credentialName: credential.name,
          };
          const baseQuery = {
            ...(options.region ? { region: options.region } : {}),
          };

          if (options.recursive) {
            validateRecursiveProvider(credential.cloudProvider);
            validateDirectoryPrefix(remotePath, { allowEmpty: false });
            const objects = await listAllBucketObjects({
              client,
              bucketName,
              prefix: remotePath,
              credentialName: credential.name,
              ...(options.region ? { region: options.region } : {}),
            });
            if (objects.length === 0) {
              printSuccess(
                `No objects found under ${bucketName}/${remotePath}`,
              );
              return;
            }
            const totalBytes = objects.some(
              (object) => object.sizeBytes === null,
            )
              ? null
              : objects.reduce(
                  (sum, object) => sum + (object.sizeBytes ?? 0),
                  0,
                );
            if (!options.yes) {
              if (!shouldAllowPrompts()) {
                throw new Error(
                  'Recursive deletion requires --yes in non-interactive mode',
                );
              }
              const answer = await safePrompts<'confirmed'>({
                type: 'confirm',
                name: 'confirmed',
                message: `Delete ${objects.length} object(s) (${formatBucketBytes(totalBytes)}) under ${bucketName}/${remotePath}?`,
                initial: false,
              });
              if (!answer.confirmed) {
                printSuccess('Recursive deletion cancelled');
                return;
              }
            }
            const result = await runBucketBatch({
              operation: 'delete',
              label: `Deleting ${bucketName}/${remotePath}`,
              items: objects,
              concurrency,
              worker: async (object) => {
                await client.bucket.deleteObject({
                  params,
                  query: {
                    ...baseQuery,
                    remotePath: object.key,
                  },
                });
              },
            });
            printSuccess(
              `Deleted ${formatBucketBatchResult(result)} from ${bucketName}/${remotePath}`,
            );
            return;
          }

          await client.bucket.deleteObject({
            params,
            query: { ...baseQuery, remotePath },
          });
          printSuccess(`Deleted ${bucketName}/${remotePath}`);
        } catch (error) {
          if (error instanceof BucketBatchOperationError) {
            printBatchDeleteError(error);
            process.exit(1);
            return;
          }
          printError(`Object delete failed: ${(error as Error).message}`);
          process.exit(1);
        }
      },
    );
}
