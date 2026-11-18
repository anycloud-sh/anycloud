/**
 * `quota status --cloud`: current quota limits read through the user's own
 * cloud CLI, with no API and no saved credential, so a caller can check
 * capacity before `cluster create`.
 */
import type { QuotaStatusEntry } from '../../shared/api-contract/quota-schemas.js';
import { QuotaProviderStatus } from '../../shared/quota.js';
import {
  AWS_QUOTA_CODES,
  awsQuotaNameFor,
  awsQuotaResourceKey,
} from '../../shared/quota-resolvers/aws.js';
import { ensureCatalogBootstrapped } from '../../shared/catalog/index.js';
import { getGPUVMTypes } from '../../shared/cloud-config.js';
import { getAzureQuotaResourceKeyForVMType } from '../../shared/quota-resolvers/azure.js';
import {
  AZURE_QUOTA_RESOURCE_KEYS,
  createAzureQuotaIdentity,
} from '../../shared/quota-resolvers/azure-identity.js';
import { discoverAccount } from './accounts.js';
import {
  CloudCliError,
  seedCloudType,
  type CloudCli,
  type SeedCloud,
} from './types.js';

/** The caller lacks the one right reading quotas needs (`CLOUD_RIGHTS_MISSING`). */
export class QuotaRightsError extends Error {
  readonly code = 'CLOUD_RIGHTS_MISSING';
}

const READ_RIGHT: Record<SeedCloud, string> = {
  aws: 'servicequotas:GetServiceQuota and servicequotas:GetAWSDefaultServiceQuota',
  gcp: 'compute.regions.get',
  azure: 'Microsoft.Compute/locations/usages/read',
};

const DENIED =
  /AccessDenied|not authorized|PERMISSION_DENIED|Required '[\w.]+' permission|HTTPError 403|AuthorizationFailed|does not have authorization/i;
const NO_SUCH_QUOTA = /NoSuchResourceException/;

/**
 * The region's GPU quota families, from Azure's catalog (downloaded on first
 * use); without it, as for the API, status keeps the vCPU totals only.
 */
async function azureGpuFamilies(region: string): Promise<string[]> {
  const azure = seedCloudType('azure');
  try {
    await ensureCatalogBootstrapped(azure);
    return getGPUVMTypes(azure, region, '*').flatMap(
      (vmType) => getAzureQuotaResourceKeyForVMType(vmType) ?? [],
    );
  } catch {
    return [];
  }
}

/** Null when Service Quotas holds no such quota. */
function orNoQuota<T>(read: Promise<T>): Promise<T | null> {
  return read.catch((error: unknown) => {
    if (error instanceof CloudCliError && NO_SUCH_QUOTA.test(error.stderr))
      return null;
    throw error;
  });
}

/** Current limits for one region; a sign-in or rights failure throws. */
export async function readCloudQuotaStatus(
  cloud: SeedCloud,
  region: string,
  cli: CloudCli,
): Promise<QuotaStatusEntry[]> {
  // Throws SeedUnavailableError when the CLI is missing or signed out.
  const account = await discoverAccount(cloud, cli);
  const json = async <T>(args: string[]): Promise<T> => {
    try {
      return JSON.parse(await cli.run({ args })) as T;
    } catch (error) {
      if (error instanceof CloudCliError && DENIED.test(error.stderr))
        throw new QuotaRightsError(
          `${account.principal} lacks ${READ_RIGHT[cloud]} in ${cloud} account ${account.account}; grant it and retry`,
        );
      throw error;
    }
  };
  const current = (
    entry: Pick<QuotaStatusEntry, 'resourceName' | 'currentLimit'> &
      Partial<QuotaStatusEntry>,
  ): QuotaStatusEntry => ({
    kind: 'current',
    cloud: seedCloudType(cloud),
    region,
    status: QuotaProviderStatus.Current,
    ...entry,
  });
  /** A read that failed for any reason but rights: shown, so a caller can retry. */
  const unavailable = (
    resourceName: string,
    message: string,
    resourceKey?: string,
  ): QuotaStatusEntry => ({
    kind: 'unavailable',
    cloud: seedCloudType(cloud),
    region,
    resourceName,
    ...(resourceKey && { resourceKey }),
    status: 'UNAVAILABLE',
    message,
  });
  const unlessRights = (error: unknown): string => {
    if (error instanceof QuotaRightsError || !(error instanceof Error))
      throw error;
    return error.message;
  };

  switch (cloud) {
    case 'aws': {
      const read = (operation: string, quotaCode: string) =>
        json<{ Quota?: { Value?: number } }>([
          'service-quotas',
          operation,
          '--service-code',
          'ec2',
          '--quota-code',
          quotaCode,
          '--region',
          region,
          '--output',
          'json',
        ]);
      const targets = Object.entries(AWS_QUOTA_CODES).flatMap(
        ([family, codes]) =>
          [true, false].map((spot) => ({
            family,
            spot,
            quotaCode: spot ? codes.spot : codes.onDemand,
          })),
      );
      return Promise.all(
        targets.map(async ({ family, spot, quotaCode }) => {
          const resourceName = awsQuotaNameFor(family, spot);
          const resourceKey = awsQuotaResourceKey(quotaCode);
          try {
            // An account that never changed a quota has only AWS's default.
            const quota =
              (await orNoQuota(read('get-service-quota', quotaCode))) ??
              (await orNoQuota(
                read('get-aws-default-service-quota', quotaCode),
              ));
            const value = quota?.Quota?.Value;
            return typeof value === 'number'
              ? current({ resourceName, resourceKey, currentLimit: value })
              : unavailable(
                  resourceName,
                  `Service Quotas has no value for ${quotaCode} in ${region}`,
                  resourceKey,
                );
          } catch (error) {
            return unavailable(resourceName, unlessRights(error), resourceKey);
          }
        }),
      );
    }
    case 'gcp': {
      let quotas: { metric?: string; limit?: number }[];
      try {
        ({ quotas = [] } = await json<{ quotas?: typeof quotas }>([
          'compute',
          'regions',
          'describe',
          region,
          `--project=${account.account}`,
          '--format=json(quotas)',
        ]));
      } catch (error) {
        return [unavailable('Compute region quotas', unlessRights(error))];
      }
      // CPUS, the per-family `<FAMILY>_CPUS` and the GPU metrics, which gate
      // launches (committed-use ones don't); PREEMPTIBLE_ ones gate spot VMs.
      return quotas
        .filter(
          ({ metric }) =>
            metric &&
            /(^|_)(CPUS|GPUS)$/.test(metric) &&
            !metric.startsWith('COMMITTED_'),
        )
        .map(({ metric, limit }) =>
          current({
            resourceName: metric!,
            resourceKey: `gcp:${metric!.toLowerCase()}`,
            currentLimit: limit ?? 0,
            // A plain metric limits spot VMs too, unless a PREEMPTIBLE_ one
            // is granted, so it shows in both views.
            ...(metric!.startsWith('PREEMPTIBLE_') && { spot: true }),
          }),
        );
    }
    case 'azure': {
      let usages: {
        limit?: number | string;
        name?: { value?: string; localizedValue?: string };
      }[];
      try {
        usages = await json<typeof usages>([
          'vm',
          'list-usage',
          '--location',
          region,
          '--output',
          'json',
        ]);
      } catch (error) {
        return [unavailable('Compute usages', unlessRights(error))];
      }
      // As the API's status: regional and low-priority (spot) vCPUs, and
      // the region's GPU families, the launch blockers.
      const kept = new Set<string>([
        AZURE_QUOTA_RESOURCE_KEYS.cores,
        AZURE_QUOTA_RESOURCE_KEYS.lowPriorityCores,
        ...(await azureGpuFamilies(region)),
      ]);
      return usages.flatMap(({ limit, name }) => {
        if (!name?.value) return [];
        const { resourceKey } = createAzureQuotaIdentity(name.value);
        if (!kept.has(resourceKey)) return [];
        return [
          current({
            resourceName: name.localizedValue || name.value,
            resourceKey,
            currentLimit: Number(limit ?? 0),
          }),
        ];
      });
    }
  }
}
