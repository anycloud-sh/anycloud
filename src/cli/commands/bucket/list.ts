import { Command } from 'commander';
import { apiClient } from '../../services/auth.js';
import { newTable } from '../../renderers/table.js';
import chalk from 'chalk';
import type {
  BucketEntry,
  BucketSummary,
} from '../../../shared/api-contract/bucket-metadata-schemas.js';
import {
  createSpinner,
  printError,
  printInfo,
  printWarning,
  setJsonMode,
} from '../../utils/output.js';
import { resolveOptionalNamedCredential } from '../shared.js';
import { formatBucketBytes } from './batch.js';

const DEFAULT_LIST_LIMIT = 1000;
const MAX_PAGE_SIZE = 1000;
const TRUNCATED_EXIT_CODE = 3;

interface BucketListCommandOptions {
  credentials?: string;
  region?: string;
  json?: boolean;
  limit?: string;
  all?: boolean;
  recursive?: boolean;
  cursor?: string;
}

function resolveLimit(options: BucketListCommandOptions): number | null {
  if (options.all && options.limit !== undefined) {
    throw new Error('--all cannot be combined with --limit');
  }
  if (options.all) return null;
  if (options.limit === undefined) return DEFAULT_LIST_LIMIT;
  if (!/^\d+$/.test(options.limit)) {
    throw new Error('--limit must be a positive integer');
  }
  const limit = Number(options.limit);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('--limit must be a positive integer');
  }
  return limit;
}

/**
 * Collects pages until the limit or the end of the listing. A page is never
 * requested larger than the remaining limit, so the provider's cursor is the
 * exact resume point: `nextCursor` skips and repeats nothing. A page that
 * returns more than requested is refused rather than sliced, because the
 * cursor would then skip the dropped items.
 */
async function collectPages<T>(options: {
  limit: number | null;
  cursor: string | undefined;
  fetchPage: (
    pageSize: number,
    cursor?: string,
  ) => Promise<{
    items: T[];
    nextCursor: string | null;
  }>;
}): Promise<{ items: T[]; nextCursor: string | null }> {
  const items: T[] = [];
  let cursor = options.cursor;
  const seenCursors = new Set(cursor ? [cursor] : []);

  for (;;) {
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      options.limit === null ? MAX_PAGE_SIZE : options.limit - items.length,
    );
    const page = await options.fetchPage(pageSize, cursor);
    if (page.items.length > pageSize) {
      throw new Error(
        `Bucket listing returned ${page.items.length} items for a page of ${pageSize}`,
      );
    }
    items.push(...page.items);
    // Azure reports an exhausted listing with an empty continuation token.
    const nextCursor = page.nextCursor || null;
    if (nextCursor === null || items.length === options.limit) {
      return { items, nextCursor };
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error('Bucket listing returned a repeated pagination cursor');
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

function formatTimestamp(timestamp: number | null): string {
  if (timestamp === null) return '-';
  // Truncate to whole seconds: GCS and Azure report sub-second precision, and
  // a mixed-precision column is harder to scan than a uniform one.
  const iso = new Date(timestamp).toISOString();
  return `${iso.slice(0, 19).replace('T', ' ')} UTC`;
}

function formatBytes(bytes: number | null): string {
  // A missing size reads as '-' in a table column, not batch.ts's prose
  // 'unknown size'; the byte formatting itself is shared.
  return bytes === null ? '-' : formatBucketBytes(bytes);
}

function renderBuckets(buckets: BucketSummary[]): void {
  if (buckets.length === 0) {
    printInfo('No buckets found.');
    return;
  }
  printInfo(`Buckets (${buckets.length}):`);
  console.log('');
  const table = newTable({
    head: ['Name', 'Region', 'Created'].map((heading) => chalk.cyan(heading)),
    style: { head: [], border: ['dim'] },
  });
  for (const bucket of buckets) {
    table.push([
      bucket.name,
      bucket.region ?? '-',
      formatTimestamp(bucket.createdAt),
    ]);
  }
  console.log(table.toString());
}

function renderEntries(bucketName: string, entries: BucketEntry[]): void {
  if (entries.length === 0) {
    printInfo(`No files found in ${bucketName}.`);
    return;
  }
  printInfo(`Contents of ${bucketName} (${entries.length}):`);
  console.log('');
  const table = newTable({
    head: ['Type', 'Key', 'Size', 'Last modified'].map((heading) =>
      chalk.cyan(heading),
    ),
    style: { head: [], border: ['dim'] },
    wordWrap: true,
  });
  for (const entry of entries) {
    table.push(
      entry.kind === 'prefix'
        ? ['DIR', entry.key, '-', '-']
        : [
            'FILE',
            entry.key,
            formatBytes(entry.sizeBytes),
            formatTimestamp(entry.lastModifiedAt),
          ],
    );
  }
  console.log(table.toString());
}

export function createBucketListCommand(): Command {
  return new Command('list')
    .description('List buckets, or files and folders inside one bucket')
    .argument('[bucket-name]', 'Bucket whose contents to list')
    .argument('[prefix]', 'Literal object prefix to browse')
    .option(
      '--credentials <name>',
      'Named cloud credential to use for the listing',
    )
    .option('--region <region>', 'Bucket region (required for some providers)')
    .option(
      '-n, --limit <count>',
      `Maximum items to return (default ${DEFAULT_LIST_LIMIT})`,
    )
    .option('--all', 'Fetch every page of results')
    .option(
      '--cursor <token>',
      'Resume from a previous nextCursor; repeat the same bucket, prefix and --recursive',
    )
    .option(
      '-r, --recursive',
      'List all objects recursively (requires a bucket)',
    )
    .option(
      '--json',
      'Emit compact JSON: {"entries": [...], "truncated": bool, "nextCursor": string|null}',
    )
    .addHelpText(
      'after',
      `
Exit codes:
  0  listing is complete
  1  listing failed
  ${TRUNCATED_EXIT_CODE}  listing stopped at the limit; pass --all, or --cursor with nextCursor

Examples:
  $ anycloud bucket list --credentials prod-aws
  $ anycloud bucket list --credentials prod-gcp --json
  $ anycloud bucket list my-bucket --credentials prod-aws
  $ anycloud bucket list my-bucket checkpoints/ --recursive --credentials prod-aws
  $ anycloud bucket list my-bucket checkpoints/ --recursive --json --cursor <nextCursor>
`,
    )
    .action(
      async (
        bucketName: string | undefined,
        prefix: string | undefined,
        options: BucketListCommandOptions,
      ) => {
        try {
          if (options.json) setJsonMode(true);
          if (options.recursive && !bucketName) {
            throw new Error('--recursive requires a bucket name');
          }
          const limit = resolveLimit(options);
          const credential = await resolveOptionalNamedCredential({
            credentials: options.credentials,
            ...(options.json ? { allowPrompt: false } : {}),
          });
          const client = await apiClient();
          const baseQuery = {
            ...(options.region ? { region: options.region } : {}),
          };

          const spinner = createSpinner(
            bucketName
              ? `Listing ${bucketName}...`
              : 'Listing cloud buckets...',
          ).start();
          let result: {
            items: BucketSummary[] | BucketEntry[];
            nextCursor: string | null;
          };
          try {
            if (bucketName) {
              result = await collectPages<BucketEntry>({
                limit,
                cursor: options.cursor,
                fetchPage: async (pageSize, cursor) => {
                  const page = await client.bucket.objects({
                    params: {
                      credentialName: credential.name,
                      bucketName,
                    },
                    query: {
                      ...baseQuery,
                      pageSize: String(pageSize),
                      recursive: options.recursive === true ? 'true' : 'false',
                      ...(prefix !== undefined ? { prefix } : {}),
                      ...(cursor ? { cursor } : {}),
                    },
                  });
                  return { items: page.entries, nextCursor: page.nextCursor };
                },
              });
              result.items.sort((a, b) =>
                (a as BucketEntry).key.localeCompare((b as BucketEntry).key),
              );
            } else {
              result = await collectPages<BucketSummary>({
                limit,
                cursor: options.cursor,
                fetchPage: async (pageSize, cursor) => {
                  const page = await client.bucket.list({
                    params: { credentialName: credential.name },
                    query: {
                      ...baseQuery,
                      pageSize: String(pageSize),
                      ...(cursor ? { cursor } : {}),
                    },
                  });
                  return { items: page.buckets, nextCursor: page.nextCursor };
                },
              });
              result.items.sort((a, b) =>
                (a as BucketSummary).name.localeCompare(
                  (b as BucketSummary).name,
                ),
              );
            }
          } finally {
            spinner.stop();
          }

          const truncated = result.nextCursor !== null;
          if (truncated) {
            printWarning(
              `Showing the first ${result.items.length} items; use --all to fetch everything, or continue with --cursor '${result.nextCursor}'.`,
              true,
            );
          }
          if (options.json) {
            console.log(
              JSON.stringify({
                entries: result.items,
                truncated,
                nextCursor: result.nextCursor,
              }),
            );
          } else if (bucketName) {
            renderEntries(bucketName, result.items as BucketEntry[]);
          } else {
            renderBuckets(result.items as BucketSummary[]);
          }
          // Set exitCode and return, like the other commands.
          if (truncated) process.exitCode = TRUNCATED_EXIT_CODE;
        } catch (error) {
          printError(`List failed: ${(error as Error).message}`);
          process.exit(1);
        }
      },
    );
}
