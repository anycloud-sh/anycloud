import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'csv-parse/sync';
import { describe, expect, it } from 'vitest';
import { validateCatalog } from '../../../scripts/validate-catalog.js';
import { validateGeneratedCatalogs } from '../../../scripts/validate-generated-catalog.js';
import { readCatalog } from '../../../src/shared/catalog/index.js';
import {
  getZonesForVMType,
  gpuRuntimeForVMType,
  resolveVMType,
} from '../../../src/shared/cloud-config.js';
import { gcpGpuMachineCapability } from '../../../src/shared/gcp-machine-capabilities.js';
import { CloudType, GpuRuntime } from '../../../src/shared/cloud.js';
import { getAnycloudDir } from '../../../src/shared/utils.js';

function publishedGcpCsv(): string {
  return readFileSync(join(getAnycloudDir(), 'catalogs', 'gcp.csv'), 'utf8');
}

describe('published GCP catalog contract', () => {
  const csv = publishedGcpCsv();
  const catalog = readCatalog(CloudType.GCP);

  it('passes the shared producer and runtime validators', () => {
    const failures = [
      ...validateCatalog(csv, 'gcp'),
      ...validateGeneratedCatalogs(
        { [CloudType.GCP]: csv },
        { clouds: [CloudType.GCP] },
      ),
    ]
      .filter((result) => !result.passed)
      .map((result) => result.message);

    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('loads a non-empty accelerator catalog', () => {
    expect(catalog).toBeDefined();
    expect(Object.keys(catalog?.typesPerAccelerator ?? {})).not.toHaveLength(0);
  });

  it.each([1, 2, 4, 8])(
    'resolves RTXPRO6000:%i to a launch-qualified whole-GPU G4 machine',
    (count) => {
      const vmType = resolveVMType(`RTXPRO6000:${count}`, CloudType.GCP);

      expect(vmType).toBe(`g4-standard-${48 * count}`);
      expect(catalog?.cpuTypes).not.toContain(vmType);
      expect(gcpGpuMachineCapability(vmType)?.launchQualified).toBe(true);
      expect(gpuRuntimeForVMType(CloudType.GCP, vmType)).toBe(GpuRuntime.Cuda);
    },
  );

  it('preserves the published g4-standard-48 placement topology for us-central1', () => {
    const vmType = 'g4-standard-48';
    const region = 'us-central1';
    const rows = parse(csv, {
      columns: true,
      skip_empty_lines: true,
    }) as Record<string, string>[];
    const publishedZones = [
      ...new Set(
        rows
          .filter((row) => row.InstanceType === vmType && row.Region === region)
          .map((row) => row.AvailabilityZone.slice(region.length + 1)),
      ),
    ].sort();

    expect(
      publishedZones,
      `Published GCP catalog must offer ${vmType} in ${region}`,
    ).not.toHaveLength(0);
    expect(getZonesForVMType(region, vmType)).toEqual(publishedZones);
  });
});
