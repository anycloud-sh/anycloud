import { describe, expect, it } from 'vitest';
import {
  validateGeneratedCatalogs,
  type GeneratedCatalogs,
} from '../../../scripts/validate-generated-catalog.js';
import { CloudType } from '../../../src/shared/cloud.js';

const COLUMNS = [
  'InstanceType',
  'AcceleratorName',
  'AcceleratorCount',
  'vCPUs',
  'MemoryGiB',
  'GpuInfo',
  'Price',
  'SpotPrice',
  'Region',
  'AvailabilityZone',
  'NestedVirtualizationSupported',
] as const;

type FixtureRow = Partial<Record<(typeof COLUMNS)[number], string | number>>;
type MutableGeneratedCatalogs = Partial<Record<CloudType, string>>;

function escapeCsv(value: string | number | undefined): string {
  const text = value === undefined ? '' : String(value);
  return /[,"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function catalog(rows: readonly FixtureRow[]): string {
  return [
    COLUMNS.join(','),
    ...rows.map((row) =>
      COLUMNS.map((column) => escapeCsv(row[column])).join(','),
    ),
  ].join('\n');
}

function gpuRow(
  instanceType: string,
  gpu: string,
  count: number,
  options: {
    vCPUs?: number;
    memoryGiB?: number;
    region?: string;
    zone?: string;
    price?: string;
    spotPrice?: string;
  } = {},
): FixtureRow {
  return {
    InstanceType: instanceType,
    AcceleratorName: gpu,
    AcceleratorCount: count,
    vCPUs: options.vCPUs ?? 16,
    MemoryGiB: options.memoryGiB ?? 128,
    Price: options.price ?? '4',
    SpotPrice: options.spotPrice ?? '2',
    Region: options.region ?? 'us-east-1',
    AvailabilityZone: options.zone ?? '',
  };
}

function fixtureCatalogs(unpricedCloud?: CloudType): MutableGeneratedCatalogs {
  const prices = (cloud: CloudType) =>
    cloud === unpricedCloud ? { price: '', spotPrice: '' } : {};
  const gcpRows = [1, 2, 4, 8].map((count) =>
    gpuRow(`g4-standard-${48 * count}`, 'RTXPRO6000', count, {
      vCPUs: 48 * count,
      memoryGiB: 180 * count,
      region: 'us-central1',
      zone: 'us-central1-a',
      ...prices(CloudType.GCP),
    }),
  );

  return {
    [CloudType.AWS]: catalog([
      gpuRow('p5.4xlarge', 'H100', 1, prices(CloudType.AWS)),
      gpuRow('g6f.4xlarge', 'L4', 0.5, prices(CloudType.AWS)),
    ]),
    [CloudType.GCP]: catalog(gcpRows),
    [CloudType.Azure]: catalog([
      gpuRow('Standard_NC40ads_H100_v5', 'H100', 1, prices(CloudType.Azure)),
      gpuRow('Standard_NV18ads_A10_v5', 'A10', 0.5, prices(CloudType.Azure)),
    ]),
    [CloudType.Lambda]: catalog([
      gpuRow('gpu_1x_h100_pcie', 'H100', 1, prices(CloudType.Lambda)),
      gpuRow('gpu_1x_a100', 'A100', 1, prices(CloudType.Lambda)),
    ]),
  };
}

function failures(catalogs: GeneratedCatalogs) {
  return validateGeneratedCatalogs(catalogs).filter((result) => !result.passed);
}

describe('validateGeneratedCatalogs', () => {
  it('validates capability booleans and accepts missing metadata', () => {
    const catalogs = fixtureCatalogs();
    expect(failures(catalogs)).toEqual([]);
    catalogs[CloudType.AWS] = catalog([
      {
        ...gpuRow('p5.4xlarge', 'H100', 1),
        NestedVirtualizationSupported: 'true',
      },
      {
        ...gpuRow('g6f.4xlarge', 'L4', 0.5),
        NestedVirtualizationSupported: 'false',
      },
    ]);
    expect(failures(catalogs)).toEqual([]);
    catalogs[CloudType.AWS] = catalog([
      {
        ...gpuRow('p5.4xlarge', 'H100', 1),
        NestedVirtualizationSupported: 'maybe',
      },
    ]);
    expect(failures(catalogs)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cloud: CloudType.AWS,
          message: expect.stringContaining(
            'invalid NestedVirtualizationSupported',
          ),
        }),
      ]),
    );
  });

  it('exercises all catalog-backed providers through runtime queries', () => {
    expect(failures(fixtureCatalogs())).toEqual([]);
  });

  it.each([CloudType.AWS, CloudType.Azure, CloudType.GCP, CloudType.Lambda])(
    'fails %s when a GPU machine has no usable pricing mode',
    (cloud) => {
      const validationFailures = failures(fixtureCatalogs(cloud));

      expect(validationFailures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            cloud,
            message: expect.stringContaining(
              'no positive on-demand or spot price',
            ),
          }),
        ]),
      );
    },
  );

  it('reports every missing provider artifact in one validation run', () => {
    const validationFailures = failures({});

    expect(validationFailures.map((result) => result.cloud)).toEqual([
      CloudType.AWS,
      CloudType.GCP,
      CloudType.Azure,
      CloudType.Lambda,
    ]);
    expect(
      validationFailures.every((result) => /missing/.test(result.message)),
    ).toBe(true);
  });

  it.each([
    [CloudType.AWS, 'p5.4xlarge', 'H100:1'],
    [CloudType.Azure, 'Standard_NC40ads_H100_v5', 'H100:1'],
    [CloudType.GCP, 'g4-standard-96', 'RTXPRO6000:2'],
    [CloudType.Lambda, 'gpu_1x_h100_pcie', 'H100:1'],
  ] as const)(
    'fails %s when a previously published GPU/count pair disappears',
    (cloud, instanceType, gpuPair) => {
      const previousCatalogs = fixtureCatalogs();
      const currentCatalogs = { ...previousCatalogs };
      currentCatalogs[cloud] = currentCatalogs[cloud]
        ?.split('\n')
        .filter((line) => !line.startsWith(`${instanceType},`))
        .join('\n');

      expect(
        validateGeneratedCatalogs(currentCatalogs, {
          previousCatalogs,
        }).filter((validation) => !validation.passed),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            cloud,
            message: expect.stringContaining(`${gpuPair} disappeared`),
          }),
        ]),
      );
    },
  );

  it('keeps GPU/count regression protection when a shape changes its GPU count', () => {
    const previousCatalogs = {
      [CloudType.Lambda]: catalog([
        gpuRow('gpu_4x_h100', 'H100', 4, { region: 'US' }),
      ]),
    };
    const currentCatalogs = {
      [CloudType.Lambda]: catalog([
        gpuRow('gpu_4x_h100', 'H100', 1, { region: 'US' }),
      ]),
    };
    expect(
      validateGeneratedCatalogs(currentCatalogs, {
        clouds: [CloudType.Lambda],
        previousCatalogs,
      }).filter((validation) => !validation.passed),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('H100:4 disappeared'),
        }),
      ]),
    );
  });

  it('rejects G4 rows outside the whole-GPU invariant', () => {
    const catalogs = fixtureCatalogs();
    catalogs[CloudType.GCP] = catalog([
      gpuRow('g4-standard-48', 'RTXPRO6000', 1, {
        vCPUs: 48,
        region: 'us-central1',
        zone: 'us-central1-a',
      }),
      gpuRow('g4-standard-24', 'RTXPRO6000', 0.5, {
        vCPUs: 24,
        region: 'us-central1',
        zone: 'us-central1-a',
      }),
      ...[4, 8].map((count) =>
        gpuRow(`g4-standard-${48 * count}`, 'RTXPRO6000', count, {
          vCPUs: 48 * count,
          region: 'us-central1',
          zone: 'us-central1-a',
        }),
      ),
    ]);

    expect(failures(catalogs)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cloud: CloudType.GCP,
          message: expect.stringContaining(
            'is not a whole-GPU RTXPRO6000 G4 shape',
          ),
        }),
      ]),
    );
  });

  it('rejects RTXPRO6000 rows outside G4', () => {
    const catalogs = fixtureCatalogs();
    catalogs[CloudType.GCP] += `\n${COLUMNS.map((column) =>
      escapeCsv(
        gpuRow('g2-standard-4', 'RTXPRO6000', 1, {
          vCPUs: 4,
          region: 'us-central1',
          zone: 'us-central1-a',
        })[column],
      ),
    ).join(',')}`;

    expect(failures(catalogs)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cloud: CloudType.GCP,
          message: expect.stringContaining(
            'g2-standard-4@us-central1-a is not a whole-GPU RTXPRO6000 G4 shape',
          ),
        }),
      ]),
    );
  });

  it('fails closed on an unqualified GCP GPU machine series', () => {
    const catalogs = fixtureCatalogs();
    catalogs[CloudType.GCP] += `\n${COLUMNS.map((column) =>
      escapeCsv(
        gpuRow('a9-highgpu-8g', 'H100', 8, {
          vCPUs: 208,
          memoryGiB: 1872,
          region: 'us-central1',
          zone: 'us-central1-a',
        })[column],
      ),
    ).join(',')}`;

    expect(failures(catalogs)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cloud: CloudType.GCP,
          message: expect.stringContaining('a9-highgpu-8g has no capability'),
        }),
      ]),
    );
  });
});
