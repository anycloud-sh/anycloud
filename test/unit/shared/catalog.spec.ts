import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  openSync,
  writeSync as fsWriteSync,
  closeSync,
} from 'fs';
import { join } from 'path';
import {
  parseCatalogCSV,
  readCatalog,
  writeCatalog,
  clearCatalogCache,
  lookupPrice,
  ensureCatalogBootstrapped,
  getCatalogs,
  refreshCatalog,
  getCatalogDiskSource,
  resetCatalogRefreshCoordinatorForTest,
} from '../../../src/shared/catalog/index.js';
import { getGpuOfferings } from '../../../src/shared/catalog/queries.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { PROVIDER_DATA } from '../../../src/shared/providers.js';

const AWS_CSV = `InstanceType,AcceleratorName,AcceleratorCount,vCPUs,MemoryGiB,GpuInfo,Price,SpotPrice,Region,AvailabilityZone
t2.micro,,,1.0,1.0,,0.0116,0.0035,us-east-1,use1-az1
t2.micro,,,1.0,1.0,,0.0116,0.0035,us-west-2,usw2-az1
t2.small,,,1.0,2.0,,0.023,0.0069,us-east-1,use1-az1`;

const GCP_CSV = `InstanceType,vCPUs,MemoryGiB,AcceleratorName,AcceleratorCount,GpuInfo,Region,AvailabilityZone,Price,SpotPrice
f1-micro,1.0,0.6,,,,us-east4,us-east4-a,0.0076,0.0023
f1-micro,1.0,0.6,,,,us-east4,us-east4-b,0.0076,0.0023
n1-standard-4,4.0,15.0,,,,us-east4,us-east4-a,0.19,0.04`;

const AZURE_CSV = `InstanceType,AcceleratorName,AcceleratorCount,vCPUs,MemoryGiB,GpuInfo,Price,SpotPrice,Region,Generation
Standard_B1s,,,1.0,1.0,,0.0104,0.0031,eastus,V2
Standard_B1s,,,1.0,1.0,,0.0104,0.0031,westus,V2`;

const LAMBDA_CSV = `InstanceType,AcceleratorName,AcceleratorCount,vCPUs,MemoryGiB,GpuInfo,Price,SpotPrice,Region,AvailabilityZone
gpu_1x_a100,A100,1,30.0,200.0,,1.29,,us-east-1,us-east-1a
gpu_1x_a100,A100,1,30.0,200.0,,1.29,,us-west-1,us-west-1a
gpu_8x_a100,A100,8,240.0,1600.0,,10.32,,us-east-1,us-east-1a`;

let tempDir: string;
let originalAnycloudDir: string | undefined;

beforeAll(() => {
  tempDir = `/tmp/anycloud-test-catalog-${Date.now()}`;
  originalAnycloudDir = process.env.ANYCLOUD_DIR;
  process.env.ANYCLOUD_DIR = tempDir;
  mkdirSync(join(tempDir, 'catalogs'), { recursive: true });
  clearCatalogCache();
});

afterAll(() => {
  if (originalAnycloudDir) {
    process.env.ANYCLOUD_DIR = originalAnycloudDir;
  } else {
    delete process.env.ANYCLOUD_DIR;
  }
  rmSync(tempDir, { recursive: true, force: true });
  clearCatalogCache();
});

afterEach(() => {
  resetCatalogRefreshCoordinatorForTest();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearCatalogCache();
});

describe('parseCatalogCSV', () => {
  it('should parse AWS CSV using Region as key', () => {
    const result = parseCatalogCSV(AWS_CSV, CloudType.AWS);

    expect(Object.keys(result.typesPerRegion)).toEqual([
      'us-east-1',
      'us-west-2',
    ]);
    expect(result.typesPerRegion['us-east-1']).toEqual([
      't2.micro',
      't2.small',
    ]);
    expect(result.typesPerRegion['us-west-2']).toEqual(['t2.micro']);

    expect(result.regionsPerType['t2.micro']).toEqual([
      'us-east-1',
      'us-west-2',
    ]);
    expect(result.regionsPerType['t2.small']).toEqual(['us-east-1']);
  });

  it('should parse GCP CSV using AvailabilityZone as key', () => {
    const result = parseCatalogCSV(GCP_CSV, CloudType.GCP);

    // GCP uses full zone as region key
    expect(Object.keys(result.typesPerRegion).sort()).toEqual([
      'us-east4-a',
      'us-east4-b',
    ]);
    expect(result.typesPerRegion['us-east4-a']).toEqual([
      'f1-micro',
      'n1-standard-4',
    ]);
    expect(result.typesPerRegion['us-east4-b']).toEqual(['f1-micro']);

    expect(result.regionsPerType['f1-micro']).toEqual([
      'us-east4-a',
      'us-east4-b',
    ]);
  });

  it('should parse Azure CSV using Region as key', () => {
    const result = parseCatalogCSV(AZURE_CSV, CloudType.Azure);

    expect(Object.keys(result.typesPerRegion).sort()).toEqual([
      'eastus',
      'westus',
    ]);
    expect(result.regionsPerType['standard_b1s']).toEqual(['eastus', 'westus']);
  });

  it('captures provider quota group metadata when present', () => {
    const csv = `InstanceType,AcceleratorName,AcceleratorCount,vCPUs,MemoryGiB,GpuInfo,Price,SpotPrice,Region,Generation,QuotaGroup
Standard_NC4as_T4_v3,T4,1,4,28,T4,0.526,0.15254,eastus,V2,StandardNCASv3_T4Family`;
    const result = parseCatalogCSV(csv, CloudType.Azure);

    expect(result.quotaGroupPerType['standard_nc4as_t4_v3']).toBe(
      'azure:standardncasv3_t4family',
    );
  });

  it('accepts legacy QuotaFamily catalog metadata', () => {
    const csv = `InstanceType,AcceleratorName,AcceleratorCount,vCPUs,MemoryGiB,GpuInfo,Price,SpotPrice,Region,Generation,QuotaFamily
Standard_NC4as_T4_v3,T4,1,4,28,T4,0.526,0.15254,eastus,V2,StandardNCASv3_T4Family`;
    const result = parseCatalogCSV(csv, CloudType.Azure);

    expect(result.quotaGroupPerType['standard_nc4as_t4_v3']).toBe(
      'azure:standardncasv3_t4family',
    );
  });

  it('keeps an already-canonical Azure quota resource key idempotent', () => {
    const csv = `InstanceType,Region,QuotaGroup
Standard_NC4as_T4_v3,eastus,azure:standardncasv3_t4family`;
    const result = parseCatalogCSV(csv, CloudType.Azure);

    expect(result.quotaGroupPerType['standard_nc4as_t4_v3']).toBe(
      'azure:standardncasv3_t4family',
    );
  });

  it('should parse Lambda CSV using Region as key', () => {
    const result = parseCatalogCSV(LAMBDA_CSV, CloudType.Lambda);

    expect(Object.keys(result.typesPerRegion).sort()).toEqual([
      'us-east-1',
      'us-west-1',
    ]);
    expect(result.typesPerRegion['us-east-1']).toEqual([
      'gpu_1x_a100',
      'gpu_8x_a100',
    ]);
    expect(result.typesPerRegion['us-west-1']).toEqual(['gpu_1x_a100']);

    expect(result.regionsPerType['gpu_1x_a100']).toEqual([
      'us-east-1',
      'us-west-1',
    ]);
    expect(result.regionsPerType['gpu_8x_a100']).toEqual(['us-east-1']);

    // typesPerAccelerator: sorted by GPU count asc, then price asc
    expect(result.typesPerAccelerator['A100']).toEqual([
      { instanceType: 'gpu_1x_a100', count: 1, vCPUs: 30, memoryGiB: 200 },
      { instanceType: 'gpu_8x_a100', count: 8, vCPUs: 240, memoryGiB: 1600 },
    ]);
  });

  it('should build typesPerAccelerator from AcceleratorName column', () => {
    const csv = `InstanceType,AcceleratorName,AcceleratorCount,vCPUs,MemoryGiB,Region,Price
g4dn.xlarge,T4,1.0,4.0,16.0,us-east-1,0.526
g4dn.12xlarge,T4,4.0,48.0,192.0,us-east-1,3.912
g4dn.metal,T4,8.0,96.0,384.0,us-east-1,7.824
p5.48xlarge,H100,8.0,192.0,2048.0,us-east-1,98.32`;
    const result = parseCatalogCSV(csv, CloudType.AWS);

    expect(result.typesPerAccelerator['T4']).toEqual([
      { instanceType: 'g4dn.xlarge', count: 1, vCPUs: 4, memoryGiB: 16 },
      { instanceType: 'g4dn.12xlarge', count: 4, vCPUs: 48, memoryGiB: 192 },
      { instanceType: 'g4dn.metal', count: 8, vCPUs: 96, memoryGiB: 384 },
    ]);
    expect(result.typesPerAccelerator['H100']).toEqual([
      {
        instanceType: 'p5.48xlarge',
        count: 8,
        vCPUs: 192,
        memoryGiB: 2048,
      },
    ]);
  });

  it('should not include rows with empty AcceleratorName in typesPerAccelerator', () => {
    const csv = `InstanceType,AcceleratorName,AcceleratorCount,vCPUs,MemoryGiB,Region,Price
t2.micro,,,,1.0,us-east-1,0.0116
g4dn.xlarge,T4,1.0,4.0,16.0,us-east-1,0.526`;
    const result = parseCatalogCSV(csv, CloudType.AWS);

    expect(Object.keys(result.typesPerAccelerator)).toEqual(['T4']);
    expect(result.typesPerAccelerator['T4']).toEqual([
      { instanceType: 'g4dn.xlarge', count: 1, vCPUs: 4, memoryGiB: 16 },
    ]);
  });

  it('captures memoryPerType for all rows and cpuTypes for non-accelerator rows', () => {
    const csv = `InstanceType,AcceleratorName,AcceleratorCount,vCPUs,MemoryGiB,Region,Price
t2.micro,,,1.0,1.0,us-east-1,0.0116
t2.small,,,1.0,2.0,us-east-1,0.023
g4dn.xlarge,T4,1.0,4.0,16.0,us-east-1,0.526`;
    const result = parseCatalogCSV(csv, CloudType.AWS);

    // Memory captured for CPU and GPU rows alike (not just accelerator rows)
    expect(result.memoryPerType['t2.micro']).toBe(1);
    expect(result.memoryPerType['t2.small']).toBe(2);
    expect(result.memoryPerType['g4dn.xlarge']).toBe(16);

    // cpuTypes lists non-accelerator instance types only, sorted
    expect(result.cpuTypes).toEqual(['t2.micro', 't2.small']);
  });

  it('captures local disk metadata when catalog columns are present', () => {
    const csv = `InstanceType,AcceleratorName,AcceleratorCount,vCPUs,MemoryGiB,Region,Price,LocalDiskType,LocalDiskSize,LocalDiskCount
g6e.xlarge,L40S,1,4,32,us-east-1,1.0,ssd,250,1
p5.48xlarge,H100,8,192,2048,us-east-1,98.32,ssd,3800,8
t3.large,,,2,8,us-east-1,0.0832,,,`;
    const result = parseCatalogCSV(csv, CloudType.AWS);

    expect(result.localDiskPerType['g6e.xlarge']).toEqual({
      sizeGb: 250,
      count: 1,
      totalGb: 250,
      type: 'ssd',
    });
    expect(result.localDiskPerType['p5.48xlarge']).toEqual({
      sizeGb: 3800,
      count: 8,
      totalGb: 30400,
      type: 'ssd',
    });
    expect(result.localDiskPerType['t3.large']).toBeUndefined();
  });

  it('excludes accelerator VMs from cpuTypes case-insensitively (Azure mixed casing)', () => {
    // Azure casing is inconsistent: the same GPU VM can appear with an
    // AcceleratorName as Standard_..._H100_v5 and without one as ..._h100_v5.
    // An exact-case exclusion would leak the lowercase row into cpuTypes and
    // surface a GPU as a CPU choice in the submit picker.
    const csv = `InstanceType,AcceleratorName,AcceleratorCount,vCPUs,MemoryGiB,Region,Price
Standard_NC40ads_H100_v5,H100,1,40,320,eastus,6.98
standard_nc40ads_h100_v5,,,40,320,westus3,6.98
Standard_D4s_v5,,,4,16,eastus,0.19`;
    const result = parseCatalogCSV(csv, CloudType.Azure);

    expect(result.cpuTypes).not.toContain('standard_nc40ads_h100_v5');
    expect(result.cpuTypes).not.toContain('Standard_NC40ads_H100_v5');
    expect(result.cpuTypes).toContain('Standard_D4s_v5');
  });

  it('keeps accelerator rows with no accelerator name out of cpuTypes', () => {
    // Azure ships RTX PRO 6000 and NP SKUs with an AcceleratorCount but a blank
    // AcceleratorName. Filing them as CPU-only would both offer them as CPU
    // choices and make GPU requests on them look like a definite mismatch.
    const csv = `InstanceType,AcceleratorName,AcceleratorCount,vCPUs,MemoryGiB,Region,Price
Standard_NC144ds_xl_RTXPRO6000BSE_v6,,1,144,768,eastus,9.6
Standard_D4s_v5,,,4,16,eastus,0.19`;
    const result = parseCatalogCSV(csv, CloudType.Azure);

    expect(result.cpuTypes).toEqual(['Standard_D4s_v5']);
    expect(result.unnamedAcceleratorTypes).toEqual([
      'standard_nc144ds_xl_rtxpro6000bse_v6',
    ]);
    expect(result.typesPerAccelerator).toEqual({});
  });

  it('lets a named accelerator row win over an unnamed one', () => {
    const csv = `InstanceType,AcceleratorName,AcceleratorCount,vCPUs,MemoryGiB,Region,Price
Standard_NC40ads_H100_v5,,1,40,320,westus3,6.98
Standard_NC40ads_H100_v5,H100,1,40,320,eastus,6.98`;
    const result = parseCatalogCSV(csv, CloudType.Azure);

    expect(result.unnamedAcceleratorTypes).toEqual([]);
    expect(Object.keys(result.typesPerAccelerator)).toEqual(['H100']);
  });

  it('should deduplicate entries', () => {
    const csv = `InstanceType,Region,Price
t2.micro,us-east-1,0.01
t2.micro,us-east-1,0.02`;
    const result = parseCatalogCSV(csv, CloudType.AWS);

    expect(result.typesPerRegion['us-east-1']).toEqual(['t2.micro']);
    expect(result.regionsPerType['t2.micro']).toEqual(['us-east-1']);
  });

  it('should return sorted arrays', () => {
    const csv = `InstanceType,Region,Price
z-large,b-region,0.01
a-small,a-region,0.02
a-small,b-region,0.03`;
    const result = parseCatalogCSV(csv, CloudType.AWS);

    expect(result.typesPerRegion['b-region']).toEqual(['a-small', 'z-large']);
    expect(result.regionsPerType['a-small']).toEqual(['a-region', 'b-region']);
  });

  it('should skip empty lines', () => {
    const csv = `InstanceType,Region,Price
t2.micro,us-east-1,0.01

t2.small,us-east-1,0.02
`;
    const result = parseCatalogCSV(csv, CloudType.AWS);

    expect(result.typesPerRegion['us-east-1']).toEqual([
      't2.micro',
      't2.small',
    ]);
  });

  it('should throw on header-only CSV', () => {
    expect(() => parseCatalogCSV('InstanceType,Region', CloudType.AWS)).toThrow(
      'CSV has no data rows',
    );
  });

  it('should throw on empty CSV', () => {
    expect(() => parseCatalogCSV('', CloudType.AWS)).toThrow(
      'CSV has no data rows',
    );
  });

  it('should throw on missing InstanceType column', () => {
    const csv = `Region,Price
us-east-1,0.01`;
    expect(() => parseCatalogCSV(csv, CloudType.AWS)).toThrow(
      'Missing CSV column: InstanceType',
    );
  });

  it('should throw on missing Region column', () => {
    const csv = `InstanceType,Price
t2.micro,0.01`;
    expect(() => parseCatalogCSV(csv, CloudType.AWS)).toThrow(
      'Missing CSV column: Region',
    );
  });

  it('should normalize VM type keys to lowercase in regionsPerType and price maps', () => {
    const csv = `InstanceType,AcceleratorName,AcceleratorCount,vCPUs,MemoryGiB,GpuInfo,Price,SpotPrice,Region,Generation
Standard_NC40ads_H100_v5,H100,1,40.0,320,H100,6.98,6.98,eastus,V2
Standard_NC40ads_H100_v5,H100,1,40.0,320,H100,6.98,6.98,westus3,V2`;
    const result = parseCatalogCSV(csv, CloudType.Azure);

    // regionsPerType keyed by lowercase
    expect(result.regionsPerType['standard_nc40ads_h100_v5']).toEqual([
      'eastus',
      'westus3',
    ]);
    // Original casing should not be a separate key
    expect(result.regionsPerType['Standard_NC40ads_H100_v5']).toBeUndefined();

    // Price maps keyed by lowercase
    expect(result.pricePerTypeRegion['standard_nc40ads_h100_v5']).toEqual({
      eastus: 6.98,
      westus3: 6.98,
    });
    expect(result.spotPricePerTypeRegion['standard_nc40ads_h100_v5']).toEqual({
      eastus: 6.98,
      westus3: 6.98,
    });

    // typesPerRegion values preserve original casing (for display)
    expect(result.typesPerRegion['eastus']).toContain(
      'Standard_NC40ads_H100_v5',
    );
  });
});

describe('getGpuOfferings', () => {
  it('selects a spot-capable representative in spot pricing mode', () => {
    const csv = `InstanceType,AcceleratorName,AcceleratorCount,vCPUs,MemoryGiB,Region,Price,SpotPrice
g6e.xlarge,L40S,1,4,32,us-east-1,0.75,
g6.xlarge,L40S,1,4,32,us-east-1,0.90,0.21`;
    writeCatalog(CloudType.AWS, csv);

    expect(getGpuOfferings(CloudType.AWS)).toMatchObject([
      {
        gpu: 'L40S',
        count: 1,
        vmType: 'g6e.xlarge',
        onDemand: { pricePerHour: 0.75 },
        spot: null,
      },
    ]);
    expect(
      getGpuOfferings(CloudType.AWS, undefined, { pricingMode: 'spot' }),
    ).toMatchObject([
      {
        gpu: 'L40S',
        count: 1,
        vmType: 'g6.xlarge',
        onDemand: { pricePerHour: 0.9 },
        spot: { pricePerHour: 0.21 },
      },
    ]);
  });
});

describe('writeCatalog + readCatalog', () => {
  it('exposes a new disk revision after atomic catalog replacement', () => {
    writeCatalog(CloudType.Azure, AZURE_CSV);
    const first = getCatalogDiskSource(CloudType.Azure);

    writeCatalog(
      CloudType.Azure,
      `${AZURE_CSV}\nStandard_B2s,,,2.0,4.0,,0.0416,0.0124,eastus,V2\n`,
    );
    const second = getCatalogDiskSource(CloudType.Azure);

    expect(first?.path).toBe(second?.path);
    expect(first?.revision).not.toBe(second?.revision);
    expect(getCatalogDiskSource(CloudType.Local)).toBeUndefined();
  });

  it('should write CSV to disk and read it back', () => {
    writeCatalog(CloudType.AWS, AWS_CSV);

    const csvPath = join(tempDir, 'catalogs', 'aws.csv');
    expect(existsSync(csvPath)).toBe(true);
    expect(readFileSync(csvPath, 'utf-8')).toBe(AWS_CSV);

    const result = readCatalog(CloudType.AWS);
    expect(result).toBeDefined();
    expect(result!.typesPerRegion['us-east-1']).toContain('t2.micro');
  });

  it('should invalidate cache on write', () => {
    writeCatalog(CloudType.Azure, AZURE_CSV);
    const first = readCatalog(CloudType.Azure);

    const updatedCSV = `InstanceType,Region,Price
Standard_D2s,northeurope,0.10`;
    writeCatalog(CloudType.Azure, updatedCSV);
    const second = readCatalog(CloudType.Azure);

    expect(first!.typesPerRegion).toHaveProperty('eastus');
    expect(second!.typesPerRegion).not.toHaveProperty('eastus');
    expect(second!.typesPerRegion).toHaveProperty('northeurope');
  });

  it('should return undefined for missing catalog file', () => {
    clearCatalogCache();
    const result = readCatalog(CloudType.Local);

    expect(result).toBeUndefined();
  });

  it('should return cached result on second read', () => {
    writeCatalog(CloudType.GCP, GCP_CSV);
    clearCatalogCache();

    const first = readCatalog(CloudType.GCP);
    const second = readCatalog(CloudType.GCP);

    expect(first).toBe(second); // Same reference
  });
});

describe('ensureCatalogBootstrapped', () => {
  it('downloads a missing provider catalog and writes it to disk', async () => {
    const csvPath = join(tempDir, 'catalogs', 'lambda.csv');
    rmSync(csvPath, { force: true });
    clearCatalogCache();
    const fetchMock = vi.fn(async () => new Response(LAMBDA_CSV));
    vi.stubGlobal('fetch', fetchMock);

    await ensureCatalogBootstrapped(CloudType.Lambda);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/lambda/vms.csv'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(readFileSync(csvPath, 'utf-8')).toBe(LAMBDA_CSV);
    expect(
      readCatalog(CloudType.Lambda)?.typesPerRegion['us-east-1'],
    ).toContain('gpu_1x_a100');
  });

  it('falls back to the authenticated GitHub API source when raw fetch is rate-limited', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'test-token');
    const csvPath = join(tempDir, 'catalogs', 'lambda.csv');
    rmSync(csvPath, { force: true });
    clearCatalogCache();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('raw.githubusercontent.com')) {
        return new Response('rate limited', { status: 429 });
      }
      if (url.includes('api.github.com')) {
        expect(init?.headers).toEqual(
          expect.objectContaining({
            Accept: 'application/vnd.github.raw',
            Authorization: 'Bearer test-token',
          }),
        );
        return new Response(LAMBDA_CSV);
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await ensureCatalogBootstrapped(CloudType.Lambda);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('raw.githubusercontent.com'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('api.github.com/repos/anycloud-sh/catalog'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(readFileSync(csvPath, 'utf-8')).toBe(LAMBDA_CSV);
  });

  it('refetches a corrupt existing catalog instead of treating it as ready', async () => {
    const csvPath = join(tempDir, 'catalogs', 'aws.csv');
    writeFileSync(csvPath, 'not,a,catalog\n', 'utf-8');
    clearCatalogCache();
    const fetchMock = vi.fn(async () => new Response(AWS_CSV));
    vi.stubGlobal('fetch', fetchMock);

    await ensureCatalogBootstrapped(CloudType.AWS);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(readFileSync(csvPath, 'utf-8')).toBe(AWS_CSV);
    expect(readCatalog(CloudType.AWS)?.typesPerRegion['us-east-1']).toContain(
      't2.micro',
    );
  });

  it('rejects an invalid fetched catalog without writing it', async () => {
    const csvPath = join(tempDir, 'catalogs', 'gcp.csv');
    rmSync(csvPath, { force: true });
    clearCatalogCache();
    const badCSV = 'InstanceType,Region\n';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(badCSV)),
    );

    await expect(ensureCatalogBootstrapped(CloudType.GCP)).rejects.toThrow(
      'CSV has no data rows',
    );

    expect(existsSync(csvPath)).toBe(false);
  });
});

describe('refreshCatalog coordination', () => {
  beforeEach(() => {
    // Retry coordination is independent of source fallback. Keep these tests
    // deterministic when CI injects a GitHub token and adds the API source.
    vi.stubEnv('GITHUB_TOKEN', '');
    vi.stubEnv('GH_TOKEN', '');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces concurrent callers into one download per cloud', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = refreshCatalog(CloudType.GCP);
    const second = refreshCatalog(CloudType.GCP);

    expect(fetchMock).toHaveBeenCalledOnce();
    resolveFetch(new Response(GCP_CSV));
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  it('cancels one caller without aborting another caller shared download', async () => {
    let resolveFetch!: (response: Response) => void;
    let sharedSignal!: AbortSignal;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        sharedSignal = init?.signal as AbortSignal;
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        });
      }),
    );
    const firstController = new AbortController();

    const first = refreshCatalog(CloudType.GCP, {
      signal: firstController.signal,
    });
    const second = refreshCatalog(CloudType.GCP);
    const cancellation = new DOMException('caller stopped', 'AbortError');
    firstController.abort(cancellation);

    await expect(first).rejects.toBe(cancellation);
    expect(sharedSignal.aborted).toBe(false);
    resolveFetch(new Response(GCP_CSV));
    await expect(second).resolves.toBeUndefined();
  });

  it('applies each caller deadline without aborting another caller', async () => {
    vi.useFakeTimers();
    let resolveFetch!: (response: Response) => void;
    let sharedSignal!: AbortSignal;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        sharedSignal = init?.signal as AbortSignal;
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        });
      }),
    );

    const deadlineBound = refreshCatalog(CloudType.GCP, {
      deadlineAt: Date.now() + 100,
    });
    const unbounded = refreshCatalog(CloudType.GCP);
    await vi.advanceTimersByTimeAsync(101);

    await expect(deadlineBound).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(sharedSignal.aborted).toBe(false);
    resolveFetch(new Response(GCP_CSV));
    await expect(unbounded).resolves.toBeUndefined();
  });

  it('aborts an abandoned download and lets a later caller start fresh', async () => {
    let abandonedSignal!: AbortSignal;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url: string, init?: RequestInit) => {
        abandonedSignal = init?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          abandonedSignal.addEventListener(
            'abort',
            () => reject(abandonedSignal.reason),
            { once: true },
          );
        });
      })
      .mockResolvedValueOnce(new Response(GCP_CSV));
    vi.stubGlobal('fetch', fetchMock);
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = refreshCatalog(CloudType.GCP, {
      signal: firstController.signal,
    });
    const second = refreshCatalog(CloudType.GCP, {
      signal: secondController.signal,
    });
    firstController.abort(new DOMException('first stopped', 'AbortError'));
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(abandonedSignal.aborted).toBe(false);

    secondController.abort(new DOMException('second stopped', 'AbortError'));
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(abandonedSignal.aborted).toBe(true);

    await expect(refreshCatalog(CloudType.GCP)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops retries and backoff when the final caller cancels', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const refresh = refreshCatalog(CloudType.GCP, {
      signal: controller.signal,
    });
    const cancellationAssertion = expect(refresh).rejects.toMatchObject({
      name: 'AbortError',
    });
    await vi.advanceTimersByTimeAsync(1);

    controller.abort(new DOMException('caller stopped', 'AbortError'));
    await cancellationAssertion;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('preserves the three-attempt refresh policy', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const refresh = refreshCatalog(CloudType.GCP);
    const assertion = expect(refresh).rejects.toThrow('network down');
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('writeCatalog atomicity', () => {
  /**
   * Demonstrates the vulnerability from an E2E run:
   * writeFileSync opens the file with O_TRUNC, which zeroes it BEFORE
   * writing new data. Any other process that reads between the truncation
   * and the completed write sees an empty or partial file.
   *
   * This test uses low-level fd operations to prove the window exists:
   * open(O_TRUNC) → file is 0 bytes → read returns empty → then write.
   */
  it('documents the O_TRUNC race that motivated the atomic-write fix', () => {
    const csvPath = join(tempDir, 'catalogs', 'race-test.csv');
    const data = 'InstanceType,Region,Price\nt3.large,us-east-1,0.08\n';

    // Seed the file with valid content
    writeFileSync(csvPath, data, 'utf-8');
    expect(readFileSync(csvPath, 'utf-8')).toBe(data);

    // Simulate what writeFileSync does internally:
    // 1. open with O_TRUNC — file is now 0 bytes
    const fd = openSync(csvPath, 'w');

    // 2. At this point, another process reading the file sees 0 bytes
    const contentDuringWrite = readFileSync(csvPath, 'utf-8');

    // 3. Write the new data and close
    fsWriteSync(fd, data);
    closeSync(fd);

    // The file was empty between open(O_TRUNC) and write()
    // This is exactly what a concurrent reader in another process would see
    expect(contentDuringWrite).toBe('');
  });

  it('writeCatalog uses atomic rename so readers never see partial data', () => {
    // Write initial catalog
    writeCatalog(CloudType.AWS, AWS_CSV);
    clearCatalogCache();

    const csvPath = join(tempDir, 'catalogs', 'aws.csv');

    // The file should contain the full CSV — no .tmp files left behind
    const content = readFileSync(csvPath, 'utf-8');
    expect(content).toBe(AWS_CSV);

    // No temp files should remain
    const tmpFiles = readdirSync(join(tempDir, 'catalogs')).filter((f) =>
      f.includes('.tmp.'),
    );
    expect(tmpFiles).toHaveLength(0);
  });
});

describe('clearCatalogCache', () => {
  it('should force re-read from disk', () => {
    writeCatalog(CloudType.AWS, AWS_CSV);
    readCatalog(CloudType.AWS); // populate cache

    // Write different data directly to disk (bypassing writeCatalog to keep cache stale)
    const csvPath = join(tempDir, 'catalogs', 'aws.csv');
    writeFileSync(
      csvPath,
      `InstanceType,Region,Price\nnew-type,new-region,0.01`,
    );

    // Cache still returns old data
    const cached = readCatalog(CloudType.AWS);
    expect(cached!.typesPerRegion).toHaveProperty('us-east-1');

    // After clearing, reads new data from disk
    clearCatalogCache();
    const fresh = readCatalog(CloudType.AWS);
    expect(fresh!.typesPerRegion).toHaveProperty('new-region');
    expect(fresh!.typesPerRegion).not.toHaveProperty('us-east-1');
  });
});

describe('lookupPrice', () => {
  it('should return on-demand price for known vm/region', () => {
    writeCatalog(CloudType.AWS, AWS_CSV);
    clearCatalogCache();
    expect(lookupPrice(CloudType.AWS, 't2.micro', 'us-east-1', false)).toBe(
      0.0116,
    );
  });

  it('should return spot price when spot=true', () => {
    writeCatalog(CloudType.AWS, AWS_CSV);
    clearCatalogCache();
    expect(lookupPrice(CloudType.AWS, 't2.micro', 'us-east-1', true)).toBe(
      0.0035,
    );
  });

  it('should return undefined for unknown VM type', () => {
    writeCatalog(CloudType.AWS, AWS_CSV);
    clearCatalogCache();
    expect(
      lookupPrice(CloudType.AWS, 'x99.nonexistent', 'us-east-1', false),
    ).toBeUndefined();
  });

  it('should return undefined for unknown region', () => {
    writeCatalog(CloudType.AWS, AWS_CSV);
    clearCatalogCache();
    expect(
      lookupPrice(CloudType.AWS, 't2.micro', 'ap-nowhere-1', false),
    ).toBeUndefined();
  });

  it('should return undefined for cloud with no catalog', () => {
    clearCatalogCache();
    expect(
      lookupPrice(CloudType.Local, 't2.micro', 'us-east-1', false),
    ).toBeUndefined();
  });

  it('should match VM type case-insensitively', () => {
    const csv = `InstanceType,AcceleratorName,AcceleratorCount,vCPUs,MemoryGiB,GpuInfo,Price,SpotPrice,Region,Generation
Standard_NC40ads_H100_v5,H100,1,40.0,320,H100,6.98,5.50,eastus,V2`;
    writeCatalog(CloudType.Azure, csv);
    clearCatalogCache();

    // Lookup with different casing than catalog
    expect(
      lookupPrice(CloudType.Azure, 'Standard_NC40ads_h100_v5', 'eastus', false),
    ).toBe(6.98);
    expect(
      lookupPrice(CloudType.Azure, 'standard_nc40ads_h100_v5', 'eastus', true),
    ).toBe(5.5);
  });
});

describe('getCatalogs failure handling', () => {
  const catalogsDir = () => join(tempDir, 'catalogs');
  const catalogClouds = Object.values(CloudType).filter(
    (cloud) => PROVIDER_DATA[cloud].compute?.catalogFile != null,
  );

  // Fake timers skip withRetry's exponential backoff (fetchCSV retries 3x with
  // ~5s/10s waits), so a failing-fetch case resolves instantly instead of ~15s.
  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws when a download fails and no cached catalog exists', async () => {
    for (const file of readdirSync(catalogsDir())) {
      rmSync(join(catalogsDir(), file), { force: true });
    }
    clearCatalogCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    vi.useFakeTimers();

    const reason = getCatalogs().catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );
    await vi.runAllTimersAsync();
    const message = await reason;

    expect(message).toMatch(/no cached catalog is available/i);
    // The reason names the failure, not the shape it was thrown in.
    // Interpolating the Error itself prefixes each cloud's reason with
    // "Error: ", and a rejection that is not an Error reads "[object Object]".
    expect(message).toContain('All catalog sources failed');
    expect(message).not.toMatch(/: Error: /);
  });

  it('returns soft errors instead of throwing when stale catalogs exist on disk', async () => {
    const minimalCsv = 'InstanceType,Region\nt2.micro,us-east-1\n';
    for (const cloud of catalogClouds) {
      writeCatalog(cloud, minimalCsv);
    }
    clearCatalogCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    vi.useFakeTimers();

    const promise = getCatalogs();
    await vi.runAllTimersAsync();
    const errors = await promise;

    // Every cloud failed to download but had a cached catalog, so each is a
    // soft error and the call resolves (keep-stale) rather than throwing.
    expect(Object.keys(errors).sort()).toEqual([...catalogClouds].sort());
    for (const cloud of catalogClouds) {
      expect(errors[cloud]).toMatch(/network down/);
    }
  });

  it('throws naming only the cloud without a fallback, even when others can keep stale data', async () => {
    // One cloud has no cached catalog; the rest do. All downloads fail. The
    // call must still fail hard (the absent cloud has nothing to fall back to),
    // and the message must scope to that cloud — not the keep-stale ones.
    const minimalCsv = 'InstanceType,Region\nt2.micro,us-east-1\n';
    const [absent, ...withFallback] = catalogClouds;
    for (const file of readdirSync(catalogsDir())) {
      rmSync(join(catalogsDir(), file), { force: true });
    }
    for (const cloud of withFallback) {
      writeCatalog(cloud, minimalCsv);
    }
    clearCatalogCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    vi.useFakeTimers();

    let message = '';
    const promise = getCatalogs();
    const assertion = promise.catch((error) => {
      message = error instanceof Error ? error.message : String(error);
    });
    await vi.runAllTimersAsync();
    await assertion;

    expect(message).toContain(absent);
    for (const cloud of withFallback) {
      expect(message).not.toContain(cloud);
    }
  });
});
