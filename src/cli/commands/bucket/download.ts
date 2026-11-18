import { Command } from 'commander';
import { apiClient, nativeApiBearer } from '../../services/auth.js';
import { downloadBucketObject } from '../../../shared/services/api-client/native.js';
import type { NativeBucketObjectRequest } from '../../../shared/api-contract/native-schemas.js';
import { withRetry } from '../../../shared/utils.js';
import { printError, printSuccess } from '../../utils/output.js';
import { withByteProgress } from '../../utils/byte-progress.js';
import { resolveOptionalNamedCredential } from '../shared.js';
import {
  BucketBatchOperationError,
  DownloadDestinationError,
  DownloadIntegrityError,
  buildDownloadManifest,
  formatBucketBatchResult,
  listAllBucketObjects,
  materializeDownloadDirectory,
  resolveBucketConcurrency,
  runBucketBatch,
  validateDirectoryPrefix,
  validateRecursiveProvider,
  writeStreamAtomically,
} from './batch.js';

const DOWNLOAD_MAX_ATTEMPTS = 3;
const DOWNLOAD_RETRY_BASE_DELAY_MS = 250;
const NON_RETRYABLE_DOWNLOAD_ERROR_CODES = new Set([
  'EACCES',
  'EDQUOT',
  'EFBIG',
  'EIO',
  'EISDIR',
  'EMFILE',
  'ENAMETOOLONG',
  'ENFILE',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'EPERM',
  'EROFS',
]);

interface BucketDownloadOptions {
  credentials?: string;
  region?: string;
  recursive?: boolean;
  concurrency?: string;
}

type BucketTransferParams = NativeBucketObjectRequest['params'] &
  NativeBucketObjectRequest['query'];

function printBatchDownloadError(error: BucketBatchOperationError): void {
  printError(
    `Recursive download partially failed: ${formatBucketBatchResult(error.result)}`,
  );
  for (const failure of error.failures) {
    printError(`${failure.key}: ${failure.error.message}`);
  }
}

function downloadErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

async function downloadObjectAtomically(options: {
  accessToken: string;
  params: BucketTransferParams;
  localPath: string;
  fallbackContentLength?: number;
  progressLabel?: string;
}): Promise<number> {
  let responseStarted = false;
  const attempt = async (): Promise<number> => {
    responseStarted = false;
    let activeStream: NodeJS.ReadableStream | undefined;
    try {
      const { stream, contentLength } = await downloadBucketObject(
        options.accessToken,
        options.params,
      );
      responseStarted = true;
      activeStream = stream;
      const expectedBytes = contentLength ?? options.fallbackContentLength;
      if (expectedBytes === undefined) {
        if ('destroy' in stream && typeof stream.destroy === 'function') {
          stream.destroy();
        }
        throw new DownloadIntegrityError(null, null);
      }
      const source = options.progressLabel
        ? withByteProgress(stream, options.progressLabel, expectedBytes)
        : stream;
      return await writeStreamAtomically(
        source,
        options.localPath,
        expectedBytes,
      );
    } catch (error) {
      if (
        activeStream &&
        'destroy' in activeStream &&
        typeof activeStream.destroy === 'function'
      ) {
        activeStream.destroy();
      }
      throw error;
    }
  };

  return withRetry(attempt, 'Download the bucket object', {
    maxAttempts: DOWNLOAD_MAX_ATTEMPTS,
    waitMs: DOWNLOAD_RETRY_BASE_DELAY_MS,
    // A completed GET is safe to refetch after a short/incomplete stream.
    // Errors before response headers (for example 403/404) retain the
    // existing single-attempt behavior instead of retrying terminal input.
    shouldRetry: (error) =>
      responseStarted &&
      !(error instanceof DownloadDestinationError) &&
      !NON_RETRYABLE_DOWNLOAD_ERROR_CODES.has(downloadErrorCode(error) ?? '') &&
      !(
        error instanceof DownloadIntegrityError && error.expectedBytes === null
      ),
  });
}

export function createBucketDownloadCommand(): Command {
  return new Command('download')
    .description('Download an object or directory from a bucket')
    .argument('<bucket-name>', 'Bucket name')
    .argument('<remote-path>', 'Source object key or directory prefix')
    .argument('<local-path>', 'Destination file or directory path')
    .option(
      '--credentials <name>',
      'Named cloud credential to use for the download',
    )
    .option('--region <region>', 'Bucket region (required for some providers)')
    .option('-r, --recursive', 'Download a directory recursively')
    .option(
      '--concurrency <count>',
      'Concurrent recursive downloads (default 4, maximum 32)',
    )
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud bucket download my-bucket data/data.bin ./data.bin --credentials prod-aws
  $ anycloud bucket download my-bucket models/v1.pt ./model.pt --credentials prod-gcp --region us-central1
  $ anycloud bucket download my-bucket models/ ./models --recursive --credentials prod-aws
  $ anycloud bucket download my-bucket '' ./bucket-copy --recursive --concurrency 8 --credentials prod-gcp
`,
    )
    .action(
      async (
        bucketName: string,
        remotePath: string,
        localPath: string,
        options: BucketDownloadOptions,
      ) => {
        try {
          if (!options.recursive && options.concurrency !== undefined) {
            throw new Error('--concurrency requires --recursive');
          }
          const concurrency = resolveBucketConcurrency(options.concurrency);
          const credential = await resolveOptionalNamedCredential({
            credentials: options.credentials,
          });
          const accessToken = await nativeApiBearer();
          const baseParams: Omit<BucketTransferParams, 'remotePath'> = {
            bucketName,
            credentialName: credential.name,
          };
          if (options.region) baseParams.region = options.region;

          if (options.recursive) {
            validateRecursiveProvider(credential.cloudProvider);
            validateDirectoryPrefix(remotePath, { allowEmpty: true });
            const objects = await listAllBucketObjects({
              client: await apiClient(),
              bucketName,
              prefix: remotePath,
              credentialName: credential.name,
              ...(options.region ? { region: options.region } : {}),
            });
            const manifest = await buildDownloadManifest(
              objects,
              remotePath,
              localPath,
            );
            const result = await runBucketBatch({
              operation: 'download',
              label: `Downloading ${bucketName}/${remotePath}`,
              items: manifest,
              concurrency,
              worker: async (item) => {
                if (item.kind === 'directory') {
                  await materializeDownloadDirectory(item.localPath);
                  return;
                }
                await downloadObjectAtomically({
                  accessToken,
                  params: { ...baseParams, remotePath: item.key },
                  localPath: item.localPath,
                  ...(item.sizeBytes === null
                    ? {}
                    : { fallbackContentLength: item.sizeBytes }),
                });
              },
            });
            printSuccess(
              `Downloaded ${formatBucketBatchResult(result)} to ${localPath}`,
            );
            return;
          }

          const params: BucketTransferParams = {
            ...baseParams,
            remotePath,
          };

          const progressLabel = `Downloading ${bucketName}/${remotePath} → ${localPath}`;
          const bytes = await downloadObjectAtomically({
            accessToken,
            params,
            localPath,
            progressLabel,
          });
          printSuccess(`Downloaded ${bytes} bytes to ${localPath}`);
        } catch (error) {
          if (error instanceof BucketBatchOperationError) {
            printBatchDownloadError(error);
            process.exit(1);
            return;
          }
          printError(`Download failed: ${(error as Error).message}`);
          process.exit(1);
        }
      },
    );
}
