import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudType } from '../../../../src/shared/cloud.js';
import {
  clearCatalogCache,
  parseCatalogCSV,
  writeCatalog,
} from '../../../../src/shared/catalog/index.js';
import { getVMTypeDetails } from '../../../../src/shared/catalog/vm-details.js';
import {
  nestedVirtualizationSupport,
  vmArchitecture,
} from '../../../../src/shared/cloud-config.js';

const dirs: string[] = [];
function install(csv: string, cloud = CloudType.AWS) {
  const dir = mkdtempSync(join(tmpdir(), 'vm-details-'));
  dirs.push(dir);
  vi.stubEnv('ANYCLOUD_DIR', dir);
  clearCatalogCache();
  writeCatalog(cloud, csv);
}
afterEach(() => {
  vi.unstubAllEnvs();
  clearCatalogCache();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('VM catalog details', () => {
  it('returns CPU and GPU hardware, all regional prices, and region-specific capabilities', () => {
    install(
      'InstanceType,Region,vCPUs,MemoryGiB,Price,SpotPrice,AcceleratorName,AcceleratorCount,NestedVirtualizationSupported\n' +
        'r7i.4xlarge,us-east-1,16,128,1.0584,0.3,,,true\n' +
        'r7i.4xlarge,us-west-2,16,128,1.1,,,,false\n' +
        'g5.xlarge,us-east-1,4,16,1,,A10G,1,false\n',
    );
    const [cpu, gpu] = getVMTypeDetails(CloudType.AWS, 'us-east-1', [
      'r7i.4xlarge',
      'g5.xlarge',
    ]);
    expect(cpu).toMatchObject({
      vmType: 'r7i.4xlarge',
      vCPUs: 16,
      memoryGiB: 128,
      accelerators: [],
      quotaGroup: 'Standard',
      capabilities: { nestedVirtualization: true, premiumStorage: null },
    });
    expect(cpu.regions).toEqual([
      {
        region: 'us-east-1',
        onDemandPricePerHour: 1.0584,
        spotPricePerHour: 0.3,
      },
      {
        region: 'us-west-2',
        onDemandPricePerHour: 1.1,
        spotPricePerHour: null,
      },
    ]);
    expect(gpu).toMatchObject({
      accelerators: [{ name: 'A10G', count: 1 }],
      quotaGroup: 'G and VT',
    });
    expect(
      getVMTypeDetails(CloudType.AWS, 'us-west-2', ['R7I.4XLARGE'])[0]
        .capabilities.nestedVirtualization,
    ).toBe(false);
  });

  it('reads older catalogs and keeps missing hardware/capabilities explicitly unknown', () => {
    const csv =
      'InstanceType,Region,AcceleratorCount\nfuture.large,us-east-1,1\n';
    install(csv);
    expect(
      parseCatalogCSV(csv, CloudType.AWS).nestedVirtualizationPerTypeRegion,
    ).toEqual({});
    expect(
      getVMTypeDetails(CloudType.AWS, 'us-east-1', ['future.large'])[0],
    ).toEqual({
      vmType: 'future.large',
      region: 'us-east-1',
      vCPUs: null,
      memoryGiB: null,
      accelerators: null,
      // AWS quota families follow from the type name, not catalog data.
      quotaGroup: 'Standard',
      capabilities: { nestedVirtualization: null, premiumStorage: null },
      regions: [
        {
          region: 'us-east-1',
          onDemandPricePerHour: null,
          spotPricePerHour: null,
        },
      ],
    });
  });

  it('C10: reads GCP support per zone, by zone, region or anywhere', () => {
    install(
      'InstanceType,Region,AvailabilityZone,NestedVirtualizationSupported\n' +
        'n2-standard-4,us-central1,us-central1-a,true\n' +
        'n2-standard-4,us-central1,us-central1-b,\n' +
        'e2-standard-2,us-central1,us-central1-a,false\n',
      CloudType.GCP,
    );
    const support = (vmType: string, region?: string, zone?: string) =>
      nestedVirtualizationSupport(CloudType.GCP, vmType, region, zone);
    expect(support('n2-standard-4', 'us-central1')).toBe(true);
    expect(support('n2-standard-4', 'us-central1-a')).toBe(true);
    expect(support('n2-standard-4', 'us-central1', 'us-central1-b')).toBe(null);
    // Launch targets name a zone by its suffix, as the pool controller
    // filters them.
    expect(support('n2-standard-4', 'us-central1', 'a')).toBe(true);
    // Admission passes a user's --zone in full.
    expect(support('n2-standard-4', 'us-central1', 'us-central1-a')).toBe(true);
    expect(support('n2-standard-4', 'us-central1', 'b')).toBe(null);
    expect(support('n2-standard-4', 'europe-west1')).toBe(null);
    expect(support('n2-standard-4')).toBe(true);
    expect(support('e2-standard-2', 'us-central1')).toBe(false);
    expect(
      getVMTypeDetails(CloudType.GCP, 'us-central1', ['n2-standard-4'])[0]
        .capabilities.nestedVirtualization,
    ).toBe(true);
  });

  it('uses parent-region prices for GCP placement zones', () => {
    install(
      'InstanceType,Region,AvailabilityZone,vCPUs,MemoryGiB,Price,PremiumStorageCapable\nn2-standard-4,us-central1,us-central1-a,4,16,0.19,true\n',
      CloudType.GCP,
    );
    expect(
      getVMTypeDetails(CloudType.GCP, 'us-central1-a', ['n2-standard-4'])[0],
    ).toMatchObject({
      capabilities: { nestedVirtualization: null, premiumStorage: true },
      regions: [
        {
          region: 'us-central1-a',
          onDemandPricePerHour: 0.19,
          spotPricePerHour: null,
        },
      ],
    });
  });

  it("reads each type's architecture from the catalog's Arch column", () => {
    install(
      'InstanceType,Region,vCPUs,MemoryGiB,Price,SpotPrice,Arch\n' +
        'm8g.xlarge,us-east-1,4,16,0.17952,0.0737,arm64\n' +
        'm8a.xlarge,us-east-1,4,16,0.24,0.1,x86_64\n',
    );
    expect(vmArchitecture(CloudType.AWS, 'm8g.xlarge')).toBe('arm64');
    expect(vmArchitecture(CloudType.AWS, 'M8G.XLARGE')).toBe('arm64');
    expect(vmArchitecture(CloudType.AWS, 'm8a.xlarge')).toBe('amd64');
    // No Arch column, or a type it doesn't list: amd64, as before.
    expect(vmArchitecture(CloudType.AWS, 'unlisted.large')).toBe('amd64');
    install(
      'InstanceType,Region,vCPUs,MemoryGiB,Price\nn2-standard-4,us-central1,4,16,0.19\n',
      CloudType.GCP,
    );
    expect(vmArchitecture(CloudType.GCP, 'n2-standard-4')).toBe('amd64');
  });
});
