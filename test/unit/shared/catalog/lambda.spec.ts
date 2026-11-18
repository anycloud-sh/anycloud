import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  LambdaCatalogFetcher,
  lambdaOsImageFamily,
} from '../../../../src/shared/catalog/lambda.js';
import { entriesToCSV } from '../../../../src/shared/catalog/fetcher.js';
import { parseCatalogCSV } from '../../../../src/shared/catalog/index.js';
import { CloudType } from '../../../../src/shared/cloud.js';

// Shapes mirror Lambda's real GET /instance-types entries.
const INSTANCE_TYPES = {
  gpu_1x_h100_pcie: {
    instance_type: {
      name: 'gpu_1x_h100_pcie',
      description: '1x H100 (80 GB PCIe)',
      gpu_description: 'H100 (80 GB PCIe)',
      price_cents_per_hour: 329,
      specs: { vcpus: 26, memory_gib: 200, gpus: 1 },
      architecture: 'x86_64',
    },
  },
  gpu_1x_h100_sxm5: {
    instance_type: {
      name: 'gpu_1x_h100_sxm5',
      gpu_description: 'H100 (80 GB SXM5)',
      price_cents_per_hour: 429,
      specs: { vcpus: 26, memory_gib: 225, gpus: 1 },
      architecture: 'x86_64',
    },
  },
  gpu_8x_a100_80gb_sxm4: {
    instance_type: {
      name: 'gpu_8x_a100_80gb_sxm4',
      gpu_description: 'A100 (80 GB SXM4)',
      price_cents_per_hour: 2232,
      specs: { vcpus: 240, memory_gib: 1800, gpus: 8 },
      architecture: 'x86_64',
    },
  },
  gpu_1x_rtx6000: {
    instance_type: {
      name: 'gpu_1x_rtx6000',
      gpu_description: 'RTX 6000 (24 GB)',
      price_cents_per_hour: 69,
      specs: { vcpus: 14, memory_gib: 46, gpus: 1 },
      architecture: 'x86_64',
    },
  },
  gpu_8x_v100: {
    instance_type: {
      name: 'gpu_8x_v100',
      gpu_description: 'Tesla V100 (16 GB)',
      price_cents_per_hour: 632,
      specs: { vcpus: 92, memory_gib: 448, gpus: 8 },
      architecture: 'x86_64',
    },
  },
  cpu_4x_general: {
    instance_type: {
      name: 'cpu_4x_general',
      gpu_description: 'N/A',
      price_cents_per_hour: 20,
      specs: { vcpus: 4, memory_gib: 16, gpus: 0 },
      architecture: 'x86_64',
    },
  },
};

const fetcher = new LambdaCatalogFetcher({ apiKey: 'test-key' });

describe('LambdaCatalogFetcher.buildEntries', () => {
  const REGIONS = ['us-east-1', 'us-southeast-1'];
  const entries = fetcher.buildEntries(INSTANCE_TYPES, REGIONS);
  const byType = (t: string) => entries.filter((e) => e.instanceType === t);

  it('emits every instance type in every offered region', () => {
    // 6 types × 2 regions.
    expect(entries).toHaveLength(12);
    expect([...new Set(entries.map((e) => e.region))].sort()).toEqual([
      'us-east-1',
      'us-southeast-1',
    ]);
    // The point of the fetcher: a region the SkyPilot snapshot lacks is present.
    expect(entries.some((e) => e.region === 'us-southeast-1')).toBe(true);
  });

  it('parses the accelerator, count, specs and price (cents→dollars)', () => {
    expect(byType('gpu_1x_h100_pcie')[0]).toMatchObject({
      acceleratorName: 'H100',
      acceleratorCount: 1,
      vCPUs: 26,
      memoryGiB: 200,
      price: 3.29,
      spotPrice: null, // Lambda has no spot
    });
  });

  it('applies the historical accelerator-name conventions', () => {
    // 80 GB A100 is a distinct family; "Tesla " and interior spaces are stripped.
    expect(byType('gpu_8x_a100_80gb_sxm4')[0]).toMatchObject({
      acceleratorName: 'A100-80GB',
      acceleratorCount: 8,
    });
    expect(byType('gpu_1x_rtx6000')[0].acceleratorName).toBe('RTX6000');
    expect(byType('gpu_8x_v100')[0].acceleratorName).toBe('V100');
  });

  it('leaves CPU-only types without an accelerator', () => {
    const cpu = byType('cpu_4x_general')[0];
    expect(cpu.acceleratorName).toBeNull();
    expect(cpu.acceleratorCount).toBeNull();
    expect(cpu.gpuInfo).toBeNull();
    expect(cpu.price).toBe(0.2);
  });

  it('reproduces the GpuInfo string (per-GPU MiB, not ×count)', () => {
    expect(byType('gpu_8x_v100')[0].gpuInfo).toBe(
      "{'Gpus': [{'Name': 'V100', 'Manufacturer': 'NVIDIA', 'Count': 8.0, 'MemoryInfo': {'SizeInMiB': 16384}}], 'TotalGpuMemoryInMiB': 16384}",
    );
  });

  it('produces a catalog that parses and resolves the H100 family', () => {
    const csv = entriesToCSV(fetcher.buildEntries(INSTANCE_TYPES, REGIONS));
    const catalog = parseCatalogCSV(csv, CloudType.Lambda);
    // H100:1 must resolve to both the pcie and sxm5 SKUs (the interchangeable
    // family), and the type must be offered in us-southeast-1.
    const h100 = catalog.typesPerAccelerator['H100'].map((e) => e.instanceType);
    expect(h100).toContain('gpu_1x_h100_pcie');
    expect(h100).toContain('gpu_1x_h100_sxm5');
    expect(catalog.regionsPerType['gpu_1x_h100_sxm5']).toContain(
      'us-southeast-1',
    );
  });
});

describe('LambdaCatalogFetcher.fetchAll', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads types from /instance-types and offered regions from /images', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/instance-types')) {
        return { ok: true, json: async () => ({ data: INSTANCE_TYPES }) };
      }
      if (url.includes('/images')) {
        return {
          ok: true,
          json: async () => ({
            data: ['us-east-1', 'us-southeast-1'].flatMap((region) =>
              ['lambda-stack-24-04', 'lambda-stack-legacy-22-04'].map(
                (family) => ({
                  region: { name: region },
                  family,
                  architecture: 'x86_64',
                }),
              ),
            ),
          }),
        };
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const entries = await fetcher.fetchAll();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const regions = [...new Set(entries.map((e) => e.region))].sort();
    expect(regions).toEqual(['us-east-1', 'us-southeast-1']);
    // 6 types × 2 regions.
    expect(entries).toHaveLength(12);
  });

  it('lists a type only in regions with its image family for its architecture', async () => {
    const image = (region: string, family: string, architecture: string) => ({
      region: { name: region },
      family,
      architecture,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => ({
          data: url.includes('/instance-types')
            ? {
                cpu_4x_general: INSTANCE_TYPES.cpu_4x_general,
                gpu_1x_gh200: {
                  instance_type: {
                    name: 'gpu_1x_gh200',
                    gpu_description: 'GH200 (96 GB)',
                    price_cents_per_hour: 229,
                    specs: { vcpus: 64, memory_gib: 432, gpus: 1 },
                    architecture: 'arm64',
                  },
                },
                gpu_8x_v100: INSTANCE_TYPES.gpu_8x_v100,
              }
            : [
                image('us-east-1', 'lambda-stack-24-04', 'x86_64'),
                image('us-east-1', 'lambda-stack-legacy-22-04', 'x86_64'),
                // us-east-3 publishes Lambda Stack only for arm64, so x86
                // launches there fail with "Image doesn't exist".
                image('us-east-3', 'lambda-stack-24-04', 'arm64'),
                image('us-east-3', 'lambda-stack-legacy-22-04', 'arm64'),
              ],
        }),
      })),
    );

    const entries = await fetcher.fetchAll();

    const regionsOf = (type: string) =>
      entries.filter((e) => e.instanceType === type).map((e) => e.region);
    expect(regionsOf('cpu_4x_general')).toEqual(['us-east-1']);
    expect(regionsOf('gpu_8x_v100')).toEqual(['us-east-1']);
    expect(regionsOf('gpu_1x_gh200')).toEqual(['us-east-3']);
  });

  it('throws when /images returns no regions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/instance-types')) {
          return { ok: true, json: async () => ({ data: INSTANCE_TYPES }) };
        }
        return { ok: true, json: async () => ({ data: [] }) };
      }),
    );
    await expect(fetcher.fetchAll()).rejects.toThrow(/no offered regions/);
  });
});

describe('lambdaOsImageFamily', () => {
  it('uses current Lambda Stack for modern GPUs', () => {
    expect(lambdaOsImageFamily('gpu_1x_a10')).toBe('lambda-stack-24-04');
    expect(lambdaOsImageFamily('gpu_8x_h100_sxm5')).toBe('lambda-stack-24-04');
  });

  it('keeps V100 instances on Lambda Stack Legacy', () => {
    expect(lambdaOsImageFamily('gpu_8x_v100')).toBe(
      'lambda-stack-legacy-22-04',
    );
    expect(lambdaOsImageFamily('GPU-1X-V100-SXM2')).toBe(
      'lambda-stack-legacy-22-04',
    );
  });
});
