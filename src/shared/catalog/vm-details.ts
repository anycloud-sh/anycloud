import { CloudType } from '../cloud.js';
import {
  extractGCPRegion,
  nestedVirtualizationSupport,
} from '../cloud-config.js';
import { awsQuotaFamilyForVMType } from '../quota-resolvers/aws.js';
import { readCatalog } from './index.js';

export interface VMTypeDetails {
  vmType: string;
  region: string;
  vCPUs: number | null;
  memoryGiB: number | null;
  accelerators: { name: string; count: number }[] | null;
  quotaGroup: string | null;
  capabilities: {
    nestedVirtualization: boolean | null;
    premiumStorage: boolean | null;
  };
  regions: {
    region: string;
    onDemandPricePerHour: number | null;
    spotPricePerHour: number | null;
  }[];
}

/** Describe selected types without replacing unknown catalog data with zero. */
export function getVMTypeDetails(
  cloud: CloudType,
  region: string,
  types: readonly string[],
): VMTypeDetails[] {
  const catalog = readCatalog(cloud);
  return types.map((vmType) => {
    const key = vmType.toLowerCase();
    const accelerators = Object.entries(
      catalog?.typesPerAccelerator ?? {},
    ).flatMap(([name, entries]) =>
      entries
        .filter((entry) => entry.instanceType.toLowerCase() === key)
        .map((entry) => ({ name, count: entry.count })),
    );
    return {
      vmType,
      region,
      vCPUs: catalog?.vCPUsPerType[key] ?? null,
      memoryGiB: catalog?.memoryPerType[key] ?? null,
      accelerators:
        accelerators.length > 0
          ? accelerators
          : catalog?.cpuTypes.some((type) => type.toLowerCase() === key)
            ? []
            : null,
      quotaGroup:
        catalog?.quotaGroupPerType[key] ??
        (cloud === CloudType.AWS ? awsQuotaFamilyForVMType(vmType) : null),
      capabilities: {
        nestedVirtualization: nestedVirtualizationSupport(
          cloud,
          vmType,
          region,
        ),
        premiumStorage: catalog?.premiumStorageCapablePerType[key] ?? null,
      },
      regions: (catalog?.regionsPerType[key] ?? []).map((offeringRegion) => {
        // GCP placement uses zones; prices are indexed by their parent region.
        const priceRegion =
          cloud === CloudType.GCP
            ? extractGCPRegion(offeringRegion)
            : offeringRegion;
        return {
          region: offeringRegion,
          onDemandPricePerHour:
            catalog?.pricePerTypeRegion[key]?.[priceRegion] ?? null,
          spotPricePerHour:
            catalog?.spotPricePerTypeRegion[key]?.[priceRegion] ?? null,
        };
      }),
    };
  });
}
