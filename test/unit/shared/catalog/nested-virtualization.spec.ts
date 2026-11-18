import { describe, expect, it } from 'vitest';
import {
  azureNestedVirtualization,
  gcpNestedVirtualization,
} from '../../../../src/shared/catalog/nested-virtualization.js';
import { entriesToCSV } from '../../../../src/shared/catalog/fetcher.js';
import { normalizeGcpCatalogWithDiagnostics } from '../../../../src/shared/catalog/gcp.js';
import { parseCatalogCSV } from '../../../../src/shared/catalog/index.js';
import { CloudType } from '../../../../src/shared/cloud.js';

describe('reviewed nested virtualization series', () => {
  it.each([
    ['n2-standard-4', true],
    ['c3-highcpu-22-lssd', true],
    ['n4d-standard-8', true],
    ['e2-standard-2', false],
    ['n2d-standard-4', false],
    ['c4a-standard-4', false],
    ['m3-ultramem-32', false],
    ['c3-standard-192-metal', undefined],
    ['a3-highgpu-1g', undefined],
  ])('GCP %s → %s', (machineType, expected) => {
    expect(gcpNestedVirtualization(machineType)).toBe(expected);
  });

  it.each([
    ['Standard_D4s_v5', true],
    ['Standard_D4ds_v5', true],
    ['Standard_D2_v3', undefined],
    ['Standard_D8as_v6', true],
    ['Standard_F16s_v2', true],
    ['Standard_E64-32s_v5', true],
    ['Standard_D4ps_v6', undefined],
    ['Standard_B2s', undefined],
    ['Standard_NC24ads_A100_v4', undefined],
  ])('Azure %s → %s', (size, expected) => {
    expect(azureNestedVirtualization(size)).toBe(expected);
  });

  it('the GCP publisher records it per zone, and leaves unreviewed series unknown', () => {
    const csv =
      'InstanceType,vCPUs,MemoryGiB,AcceleratorName,AcceleratorCount,GpuInfo,Region,AvailabilityZone,Price,SpotPrice\n' +
      'n2-standard-4,4,16,,,,us-central1,us-central1-a,0.19,0.05\n' +
      'e2-standard-2,2,8,,,,us-central1,us-central1-a,0.06,0.02\n' +
      'z3-highmem-88,88,704,,,,us-central1,us-central1-a,9,3\n';
    const { entries } = normalizeGcpCatalogWithDiagnostics(csv, []);
    expect(
      parseCatalogCSV(entriesToCSV(entries), CloudType.GCP)
        .nestedVirtualizationPerTypeRegion,
    ).toEqual({
      'n2-standard-4': { 'us-central1-a': true },
      'e2-standard-2': { 'us-central1-a': false },
    });
  });
});
