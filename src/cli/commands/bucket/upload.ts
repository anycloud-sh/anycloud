import { Command } from 'commander';
import { nativeApiBearer } from '../../services/auth.js';
import { createReadStream, statSync } from 'fs';
import { uploadBucketObject } from '../../../shared/services/api-client/native.js';
import type { NativeBucketObjectRequest } from '../../../shared/api-contract/native-schemas.js';
import { printError, printSuccess } from '../../utils/output.js';
import { withByteProgress } from '../../utils/byte-progress.js';
import { resolveOptionalNamedCredential } from '../shared.js';
import {
  BucketBatchOperationError,
  buildUploadManifest,
  formatBucketBatchResult,
  resolveBucketConcurrency,
  runBucketBatch,
  validateRecursiveProvider,
} from './batch.js';

interface BucketUploadOptions {
  credentials?: string;
  region?: string;
  recursive?: boolean;
  concurrency?: string;
}

type BucketTransferParams = NativeBucketObjectRequest['params'] &
  NativeBucketObjectRequest['query'];

function printBatchUploadError(error: BucketBatchOperationError): void {
  printError(
    `Recursive upload partially failed: ${formatBucketBatchResult(error.result)}`,
  );
  for (const failure of error.failures) {
    printError(`${failure.key}: ${failure.error.message}`);
  }
}

export function createBucketUploadCommand(): Command {
  return new Command('upload')
    .description('Upload a local file or directory to a bucket')
    .argument('<bucket-name>', 'Bucket name')
    .argument(
      '<local-path>',
      'Local file or directory to upload; - reads stdin',
    )
    .argument('<remote-path>', 'Destination object key or directory prefix')
    .option(
      '--credentials <name>',
      'Named cloud credential to use for the upload',
    )
    .option('--region <region>', 'Bucket region (required for some providers)')
    .option('-r, --recursive', 'Upload a directory recursively')
    .option(
      '--concurrency <count>',
      'Concurrent recursive uploads (default 4, maximum 32)',
    )
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud bucket upload my-bucket ./data.bin data/data.bin --credentials prod-aws
  $ anycloud bucket upload my-bucket ./model.pt models/v1.pt --credentials prod-gcp --region us-central1
  $ tar -czf - ./data | anycloud bucket upload my-bucket - data.tar.gz --credentials prod-aws
  $ anycloud bucket upload my-bucket ./models models/ --recursive --credentials prod-aws
  $ anycloud bucket upload my-bucket ./dataset '' --recursive --concurrency 8 --credentials prod-gcp
`,
    )
    .action(
      async (
        bucketName: string,
        localPath: string,
        remotePath: string,
        options: BucketUploadOptions,
      ) => {
        try {
          if (!options.recursive && options.concurrency !== undefined) {
            throw new Error('--concurrency requires --recursive');
          }
          if (options.recursive && localPath === '-') {
            throw new Error('Stdin uploads cannot use --recursive');
          }
          const concurrency = resolveBucketConcurrency(options.concurrency);
          const credential = await resolveOptionalNamedCredential({
            credentials: options.credentials,
          });
          const accessToken = await nativeApiBearer();
          const params: Omit<BucketTransferParams, 'remotePath'> = {
            bucketName,
            credentialName: credential.name,
          };
          if (options.region) params.region = options.region;

          if (options.recursive) {
            validateRecursiveProvider(credential.cloudProvider);
            const manifest = await buildUploadManifest(localPath, remotePath);
            const result = await runBucketBatch({
              operation: 'upload',
              label: `Uploading to ${bucketName}/${remotePath}`,
              items: manifest,
              concurrency,
              worker: async (item) => {
                await uploadBucketObject(
                  accessToken,
                  createReadStream(item.localPath),
                  item.sizeBytes,
                  { ...params, remotePath: item.key },
                );
              },
            });
            printSuccess(
              `Uploaded ${formatBucketBatchResult(result)} to ${bucketName}/${remotePath}`,
            );
            return;
          }

          const size = localPath === '-' ? undefined : statSync(localPath).size;
          const objectParams: BucketTransferParams = {
            ...params,
            remotePath,
          };

          const body = withByteProgress(
            localPath === '-' ? process.stdin : createReadStream(localPath),
            `Uploading ${localPath} → ${bucketName}/${remotePath}`,
            size,
          );
          await uploadBucketObject(accessToken, body, size, objectParams);

          printSuccess(
            `Uploaded ${size === undefined ? 'stdin' : `${size} bytes`} to ${bucketName}/${remotePath}`,
          );
        } catch (error) {
          if (error instanceof BucketBatchOperationError) {
            printBatchUploadError(error);
            process.exit(1);
            return;
          }
          printError(`Upload failed: ${(error as Error).message}`);
          process.exit(1);
        }
      },
    );
}
