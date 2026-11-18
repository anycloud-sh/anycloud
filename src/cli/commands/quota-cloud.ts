import { createCloudCli } from '../seed/cloud-cli.js';
import { QuotaRightsError, readCloudQuotaStatus } from '../seed/quota.js';
import {
  SEED_CLOUDS,
  SeedUnavailableError,
  type SeedCloud,
} from '../seed/types.js';
import { buildStatusMatrixLines } from '../renderers/quota-status.js';
import {
  filterStatusEntriesByQuotaType,
  quotaStatusView,
} from '../use-cases/quota-status.js';
import {
  exitWithLifecycleError,
  UsageError,
} from '../utils/lifecycle-result.js';
import { createSpinner, printInfo } from '../utils/output.js';

/**
 * `--cloud`: current limits through the user's own cloud CLI, with no API
 * or saved credential. Errors follow `cluster create`'s codes.
 */
export async function cloudQuotaStatus(opts: {
  cloud: string;
  credentials?: string;
  region?: string;
  spot?: boolean;
  onDemand?: boolean;
  canceled?: boolean;
  json?: boolean;
}): Promise<void> {
  const useJson = Boolean(opts.json) || !process.stdout.isTTY;
  try {
    const cloud = opts.cloud as SeedCloud;
    if (!SEED_CLOUDS.includes(cloud))
      throw new UsageError(`--cloud must be one of ${SEED_CLOUDS.join(', ')}`);
    if (!opts.region) throw new UsageError('--cloud requires --region');
    if (opts.credentials || opts.canceled)
      throw new UsageError(
        '--cloud cannot be combined with --credentials or --canceled',
      );
    if (opts.spot && opts.onDemand)
      throw new UsageError('Choose either --spot or --on-demand, not both.');
    const spinner = useJson
      ? null
      : createSpinner(`Reading ${cloud} quotas in ${opts.region}...`).start();
    const entries = filterStatusEntriesByQuotaType(
      await readCloudQuotaStatus(
        cloud,
        opts.region,
        createCloudCli(cloud),
      ).finally(() => spinner?.stop()),
      opts.spot ? [true] : opts.onDemand ? [false] : undefined,
    );
    if (useJson) {
      process.stdout.write(JSON.stringify(entries) + '\n');
      return;
    }
    if (entries.length === 0)
      return printInfo('No current quota limits found.');
    process.stdout.write(
      buildStatusMatrixLines(quotaStatusView(entries)).join('\n') + '\n',
    );
  } catch (error) {
    exitWithLifecycleError('Quota status failed', error, useJson, (e) =>
      e instanceof SeedUnavailableError
        ? 'CLOUD_CLI_UNAVAILABLE'
        : e instanceof QuotaRightsError
          ? e.code
          : undefined,
    );
  }
}
