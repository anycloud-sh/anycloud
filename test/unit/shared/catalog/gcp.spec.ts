import { describe, expect, it, vi } from 'vitest';
import {
  GcpCatalogFetcher,
  normalizeGcpCatalogWithDiagnostics,
  resolveGcpAcceleratorName,
  type GcpMachineTypeMetadata,
} from '../../../../src/shared/catalog/gcp.js';
import { entriesToCSV } from '../../../../src/shared/catalog/fetcher.js';
import { parseCatalogCSV } from '../../../../src/shared/catalog/index.js';
import { CloudType } from '../../../../src/shared/cloud.js';

// The shipped entry point returns entries alongside its diagnostics; these
// cases assert on the entries.
const normalizeEntries = (
  ...args: Parameters<typeof normalizeGcpCatalogWithDiagnostics>
) => normalizeGcpCatalogWithDiagnostics(...args).entries;

const HEADER =
  'InstanceType,vCPUs,MemoryGiB,AcceleratorName,AcceleratorCount,GpuInfo,Region,AvailabilityZone,Price,SpotPrice';
const ZONE = 'us-central1-a';

const UPSTREAM = `${HEADER}
n2-standard-4,4,16,,,,us-central1,${ZONE},0.19,0.05
future-standard-4,4,16,,,,us-central1,${ZONE},0.2,0.06
g4-standard-24,24,90,,,,us-central1,${ZONE},1.7,0.6
g4-standard-48,48,180,,,,us-central1,${ZONE},3.4,1.2
,,,RTXPRO6000,1,rtx-info,us-central1,${ZONE},1.1,0.5
g2-standard-4,4,16,,,,us-central1,${ZONE},0.2,0.08
g2-standard-8,8,32,,,,us-central1,${ZONE},0.3,0.1
,,,L4,1,l4-info,us-central1,${ZONE},0.5,0.2
a3-highgpu-1g,26,234,,,,us-central1,${ZONE},2,0.8
,,,H100,1,h100-info,us-central1,${ZONE},4,1.5`;

function gpuMetadata(
  instanceType: string,
  guestCpus: number,
  acceleratorType: string,
  acceleratorCount: number,
  memoryMb = guestCpus * 4096,
): GcpMachineTypeMetadata {
  return {
    instanceType,
    zone: ZONE,
    guestCpus,
    memoryMb,
    acceleratorType,
    acceleratorCount,
  };
}

const MACHINE_TYPES = [
  gpuMetadata('g4-standard-24', 24, 'nvidia-rtx-pro-6000', 1),
  gpuMetadata('g4-standard-48', 48, 'nvidia-rtx-pro-6000', 1, 180 * 1024),
  gpuMetadata('g2-standard-4', 4, 'nvidia-l4', 1),
  gpuMetadata('g2-standard-8', 8, 'nvidia-l4', 1),
  gpuMetadata('a3-highgpu-1g', 26, 'nvidia-h100-80gb', 1, 234 * 1024),
];

describe('resolveGcpAcceleratorName', () => {
  it('normalizes vendor prefixes, punctuation, and optional memory suffixes', () => {
    const names = ['RTXPRO6000', 'H100', 'H100-MEGA', 'A100-80GB'];
    expect(resolveGcpAcceleratorName('nvidia-rtx-pro-6000', names)).toBe(
      'RTXPRO6000',
    );
    expect(resolveGcpAcceleratorName('nvidia-h100-80gb', names)).toBe('H100');
    expect(resolveGcpAcceleratorName('nvidia-h100-mega-80gb', names)).toBe(
      'H100-MEGA',
    );
    expect(resolveGcpAcceleratorName('nvidia-a100-80gb', names)).toBe(
      'A100-80GB',
    );
  });

  it('fails when normalization is unknown or ambiguous', () => {
    expect(() => resolveGcpAcceleratorName('nvidia-b300', ['B200'])).toThrow(
      /Unknown GCP accelerator type/,
    );
    expect(() =>
      resolveGcpAcceleratorName('nvidia-rtx-pro-6000', [
        'RTXPRO6000',
        'RTX-PRO-6000',
      ]),
    ).toThrow(/Ambiguous GCP accelerator type/);
  });
});

describe('GCP catalog normalization', () => {
  it('discovers qualified GPU machines and sums both price components', () => {
    const entries = normalizeEntries(UPSTREAM, MACHINE_TYPES);

    expect(
      entries.find((entry) => entry.instanceType === 'g4-standard-48'),
    ).toMatchObject({
      acceleratorName: 'RTXPRO6000',
      acceleratorCount: 1,
      vCPUs: 48,
      memoryGiB: 180,
      price: 4.5,
      spotPrice: 1.7,
    });
    expect(
      entries.find((entry) => entry.instanceType === 'a3-highgpu-1g'),
    ).toMatchObject({
      acceleratorName: 'H100',
      price: 6,
      spotPrice: 2.3,
    });
  });

  it('fails closed on a known machine series that is not launch-qualified', () => {
    const csv = `${HEADER}
a4x-highgpu-4g,140,884,,,,us-central1,${ZONE},30,12
,,,GB200,4,gb200-info,us-central1,${ZONE},70,28`;

    expect(() =>
      normalizeEntries(csv, [
        gpuMetadata('a4x-highgpu-4g', 140, 'nvidia-gb200', 4, 884 * 1024),
      ]),
    ).toThrow(/not launch-qualified: a4x-highgpu-4g \(requires an ARM64/);
  });

  it('fails closed when discovery finds an unrecognized machine series', () => {
    const csv = `${HEADER}
a9-highgpu-8g,256,4096,,,,us-central1,${ZONE},30,12
,,,B300,8,b300-info,us-central1,${ZONE},70,28`;

    expect(() =>
      normalizeEntries(csv, [
        gpuMetadata('a9-highgpu-8g', 256, 'nvidia-b300', 8, 4096 * 1024),
      ]),
    ).toThrow(/not launch-qualified: a9-highgpu-8g \(unknown series\)/);
  });

  it('excludes fractional G4 shapes and retains every priced G2 shape', () => {
    const entries = normalizeEntries(UPSTREAM, MACHINE_TYPES);
    expect(
      entries.some((entry) => entry.instanceType === 'g4-standard-24'),
    ).toBe(false);
    expect(
      entries
        .filter((entry) => entry.acceleratorName === 'L4')
        .map((entry) => entry.instanceType),
    ).toEqual(['g2-standard-4', 'g2-standard-8']);
  });

  it('maps every whole G4 GPU count to its authoritative machine shape', () => {
    const counts = [1, 2, 4, 8];
    const machineRows = counts.map(
      (count) =>
        `g4-standard-${48 * count},${48 * count},${180 * count},,,,us-central1,${ZONE},${3.4 * count},${1.2 * count}`,
    );
    const acceleratorRows = counts.map(
      (count) =>
        `,,,RTXPRO6000,${count},,us-central1,${ZONE},${1.1 * count},${0.5 * count}`,
    );
    const metadata = counts.map((count) =>
      gpuMetadata(
        `g4-standard-${48 * count}`,
        48 * count,
        'nvidia-rtx-pro-6000',
        count,
        180 * count * 1024,
      ),
    );

    expect(
      normalizeEntries(
        [HEADER, ...machineRows, ...acceleratorRows].join('\n'),
        metadata,
      ).map((entry) => [entry.instanceType, entry.acceleratorCount]),
    ).toEqual([
      ['g4-standard-48', 1],
      ['g4-standard-96', 2],
      ['g4-standard-192', 4],
      ['g4-standard-384', 8],
    ]);
  });

  it('keeps CPU rows from unknown families and never indexes G4 as CPU', () => {
    const csv = entriesToCSV(normalizeEntries(UPSTREAM, MACHINE_TYPES));
    const indexes = parseCatalogCSV(csv, CloudType.GCP);

    expect(indexes.cpuTypes).toContain('n2-standard-4');
    expect(indexes.cpuTypes).toContain('future-standard-4');
    expect(indexes.cpuTypes).not.toContain('g4-standard-24');
    expect(indexes.cpuTypes).not.toContain('g4-standard-48');
    expect(indexes.typesPerAccelerator['RTXPRO6000']).toEqual([
      expect.objectContaining({ instanceType: 'g4-standard-48', count: 1 }),
    ]);
  });

  it('sets a price mode to null unless both components exist', () => {
    const csv = `${HEADER}
g4-standard-48,48,180,,,,us-central1,${ZONE},3.4,
,,,RTXPRO6000,1,,us-central1,${ZONE},1.1,0.5`;
    const [entry] = normalizeEntries(csv, [MACHINE_TYPES[1]]);
    expect(entry.price).toBe(4.5);
    expect(entry.spotPrice).toBeNull();
  });

  it('publishes only the zone intersection without dropping the GPU pair', () => {
    const otherZone = 'us-central1-b';
    const csv = `${HEADER}
g4-standard-48,48,180,,,,us-central1,${ZONE},3.4,1.2
,,,RTXPRO6000,1,,us-central1,${ZONE},1.1,0.5
g4-standard-48,48,180,,,,us-central1,${otherZone},3.4,1.2
,,,RTXPRO6000,1,,us-central1,${otherZone},1.1,0.5`;

    const normalized = normalizeGcpCatalogWithDiagnostics(csv, [
      MACHINE_TYPES[1],
    ]);
    expect(normalized.entries).toEqual([
      expect.objectContaining({ availabilityZone: ZONE }),
    ]);
    expect(normalized.diagnostics.machinePriceRowsWithoutMetadata).toEqual([
      `${otherZone}/g4-standard-48`,
    ]);
    expect(normalized.diagnostics.unusedAcceleratorPriceComponents).toContain(
      `${otherZone}|RTXPRO6000|1`,
    );
  });

  it('writes stable decimal prices without floating-point artifacts', () => {
    const csv = `${HEADER}
g4-standard-48,48,180,,,,us-central1,${ZONE},0.85107,0.30715
,,,RTXPRO6000,1,,us-central1,${ZONE},1.09565,0.4821`;
    const [entry] = normalizeEntries(csv, [MACHINE_TYPES[1]]);
    expect(entry.price).toBe(1.94672);
    expect(entry.spotPrice).toBe(0.78925);
  });

  it('skips zone mismatches but fails on unconsumed or incomplete accelerator pricing', () => {
    const wrongCount = `${HEADER}
g4-standard-48,48,180,,,,us-central1,${ZONE},3.4,1.2
,,,RTXPRO6000,2,,us-central1,${ZONE},2.2,1`;
    expect(() => normalizeEntries(wrongCount, [MACHINE_TYPES[1]])).toThrow(
      /unconsumed accelerator name\/count pairs/,
    );

    const unconsumed = `${HEADER}
n2-standard-4,4,16,,,,us-central1,${ZONE},0.19,0.05
,,,B300,8,,us-central1,${ZONE},70,28`;
    expect(() => normalizeEntries(unconsumed, [])).toThrow(
      /unconsumed accelerator name\/count pairs/,
    );

    const incomplete = `${HEADER}
g4-standard-48,48,180,,,,us-central1,${ZONE},,
,,,RTXPRO6000,1,,us-central1,${ZONE},1.1,0.5`;
    expect(() => normalizeEntries(incomplete, [MACHINE_TYPES[1]])).toThrow(
      /no complete price/,
    );
  });

  it('intentionally ignores N1-attached GPUs and TPUs', () => {
    const csv = `${HEADER}
n1-standard-4,4,15,,,,us-central1,${ZONE},0.19,0.05
,,,T4,1,,us-central1,${ZONE},0.35,0.1
,,,V100,8,,us-central1,${ZONE},20,8
,,,tpu-v5p-8,1,,us-central1,${ZONE},12,`;
    expect(normalizeEntries(csv, [])).toEqual([
      expect.objectContaining({
        instanceType: 'n1-standard-4',
        acceleratorName: null,
      }),
    ]);
  });
});

describe('GcpCatalogFetcher', () => {
  it('consumes all pages from the Machine Types API', async () => {
    const machineType = (zone: string) => ({
      name: 'g4-standard-48',
      zone: `https://compute.googleapis.com/compute/v1/projects/p/zones/${zone}`,
      guestCpus: 48,
      memoryMb: 180 * 1024,
      accelerators: [
        {
          guestAcceleratorType: 'nvidia-rtx-pro-6000',
          guestAcceleratorCount: 1,
        },
      ],
    });
    const machineTypesClient = {
      async *aggregatedListAsync() {
        yield [`zones/${ZONE}`, { machineTypes: [machineType(ZONE)] }] as const;
        yield [
          'zones/us-central1-b',
          { machineTypes: [machineType('us-central1-b')] },
        ] as const;
      },
    };
    const csv = `${HEADER}
g4-standard-48,48,180,,,,us-central1,${ZONE},3.4,1.2
,,,RTXPRO6000,1,,us-central1,${ZONE},1.1,0.5
g4-standard-48,48,180,,,,us-central1,us-central1-b,3.4,1.2
,,,RTXPRO6000,1,,us-central1,us-central1-b,1.1,0.5`;
    const fetcher = new GcpCatalogFetcher({
      projectId: 'project',
      clientEmail: 'catalog@example.com',
      privateKey: 'private-key',
      machineTypesClient: machineTypesClient as never,
      fetchImpl: vi.fn().mockResolvedValue(new Response(csv)),
    });

    const entries = await fetcher.fetchAll();
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.availabilityZone)).toEqual([
      ZONE,
      'us-central1-b',
    ]);
  });

  it('fails when the Machine Types API cannot be read', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    let attempts = 0;
    const machineTypesClient = {
      async *aggregatedListAsync() {
        attempts++;
        yield await Promise.reject(new Error('permission denied'));
      },
    };
    const fetcher = new GcpCatalogFetcher({
      projectId: 'project',
      clientEmail: 'catalog@example.com',
      privateKey: 'private-key',
      machineTypesClient: machineTypesClient as never,
      fetchImpl: vi.fn().mockResolvedValue(new Response(UPSTREAM)),
    });

    try {
      await expect(fetcher.fetchAll()).rejects.toThrow('permission denied');
      expect(attempts).toBe(3);
    } finally {
      random.mockRestore();
    }
  });
});
