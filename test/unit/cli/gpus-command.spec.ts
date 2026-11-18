import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';
import { CloudType } from '../../../src/shared/cloud.js';

vi.mock('../../../src/cli/utils/output.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/cli/utils/output.js')>();
  return {
    ...actual,
    createSpinner: () => ({ start: () => ({ stop: () => undefined }) }),
    printInfo: vi.fn(),
    printError: vi.fn(),
  };
});

vi.mock('../../../src/cli/utils/catalog-bootstrap.js', () => ({
  bootstrapCatalogsWithUI: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/cli/utils/safe-prompts.js', () => ({
  safePrompts: vi.fn(),
  shouldAllowPrompts: vi.fn(() => false),
}));

vi.mock('../../../src/shared/catalog/queries.js', () => ({
  getGpuOfferings: vi.fn(),
}));

vi.mock('../../../src/shared/cloud-config.js', () => ({
  getAvailableGPUs: vi.fn(),
}));

import { createGpusCommand } from '../../../src/cli/commands/gpus.js';
import { getGpuOfferings } from '../../../src/shared/catalog/queries.js';
import { getAvailableGPUs } from '../../../src/shared/cloud-config.js';
import { setJsonMode } from '../../../src/cli/utils/output.js';
import {
  safePrompts,
  shouldAllowPrompts,
} from '../../../src/cli/utils/safe-prompts.js';

const AWS_H100_8 = {
  gpu: 'H100',
  count: 8,
  vmType: 'p5.48xlarge',
  vCPUs: 192,
  memoryGiB: 2048,
  onDemand: { region: 'us-east-1', pricePerHour: 55.04 },
  spot: { region: 'us-west-2', pricePerHour: 9.37 },
};
const GCP_H100_8 = {
  gpu: 'H100',
  count: 8,
  vmType: 'a3-highgpu-8g',
  vCPUs: 208,
  memoryGiB: 1872,
  onDemand: { region: 'asia-northeast1', pricePerHour: 33.61 },
  spot: { region: 'europe-north1', pricePerHour: 7.84 },
};
const AZURE_H100_8 = {
  gpu: 'H100',
  count: 8,
  vmType: 'Standard_ND96isr_H100_v5',
  vCPUs: 96,
  memoryGiB: 1900,
  onDemand: { region: 'eastus', pricePerHour: 98.32 },
  spot: { region: 'eastus', pricePerHour: 18.17 },
};
const LAMBDA_H100_8 = {
  gpu: 'H100',
  count: 8,
  vmType: 'gpu_8x_h100_sxm5',
  vCPUs: 208,
  memoryGiB: 1800,
  onDemand: { region: 'europe-central-1', pricePerHour: 31.92 },
  spot: null,
};

describe('createGpusCommand', () => {
  let exitSpy: MockInstance<typeof process.exit>;
  let logSpy: MockInstance<typeof console.log>;
  let errSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    vi.clearAllMocks();
    setJsonMode(false);
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(shouldAllowPrompts).mockReturnValue(false);
    vi.mocked(safePrompts).mockReset();
    vi.mocked(getAvailableGPUs).mockReturnValue(['H100', 'H200']);
    // Default: per-cloud queries return one row each for H100:8.
    vi.mocked(getGpuOfferings).mockImplementation((cloud) => {
      switch (cloud) {
        case CloudType.AWS:
          return [AWS_H100_8];
        case CloudType.GCP:
          return [GCP_H100_8];
        case CloudType.Azure:
          return [AZURE_H100_8];
        case CloudType.Lambda:
          return [LAMBDA_H100_8];
        default:
          return [];
      }
    });
  });

  afterEach(() => {
    setJsonMode(false);
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('with a provider, queries GPU offerings for that cloud', async () => {
    await createGpusCommand().parseAsync(['node', 'test', 'aws']);
    expect(getGpuOfferings).toHaveBeenCalledWith(CloudType.AWS, undefined);
  });

  it('with --type forwards the gpu filter', async () => {
    await createGpusCommand().parseAsync([
      'node',
      'test',
      'aws',
      '--type',
      'H100',
    ]);
    expect(getGpuOfferings).toHaveBeenCalledWith(CloudType.AWS, 'H100');
  });

  it('--json with a provider prints the offerings array as-is', async () => {
    await createGpusCommand().parseAsync(['node', 'test', 'aws', '--json']);
    const stdout = logSpy.mock.calls.map((c) => String(c[0]));
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0])).toEqual([AWS_H100_8]);
  });

  it('unknown provider exits non-zero', async () => {
    await expect(
      createGpusCommand().parseAsync(['node', 'test', 'sirius']),
    ).rejects.toThrow(/process\.exit:1/);
  });

  it('no provider without --type exits non-zero', async () => {
    await expect(
      createGpusCommand().parseAsync(['node', 'test']),
    ).rejects.toThrow(/process\.exit:1/);
    expect(getGpuOfferings).not.toHaveBeenCalled();
  });

  it('bare interactive command prompts for a provider target', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(safePrompts).mockResolvedValueOnce({ target: 'aws' });

    await createGpusCommand().parseAsync(['node', 'test']);

    expect(getGpuOfferings).toHaveBeenCalledWith(CloudType.AWS, undefined);
    expect(safePrompts).toHaveBeenCalledTimes(1);
  });

  it('bare interactive command can prompt for cross-cloud GPU type', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ target: 'all' })
      .mockResolvedValueOnce({ gpuType: 'H100' });

    await createGpusCommand().parseAsync(['node', 'test']);

    const callClouds = vi.mocked(getGpuOfferings).mock.calls.map((c) => c[0]);
    expect(callClouds.sort()).toEqual(
      [CloudType.AWS, CloudType.GCP, CloudType.Azure, CloudType.Lambda].sort(),
    );
    expect(
      vi.mocked(getGpuOfferings).mock.calls.every((c) => c[1] === 'H100'),
    ).toBe(true);
  });

  it('no provider with --type fans out across the rollup clouds', async () => {
    await createGpusCommand().parseAsync([
      'node',
      'test',
      '--type',
      'H100',
      '--count',
      '8',
      '--spot',
    ]);
    const callClouds = vi.mocked(getGpuOfferings).mock.calls.map((c) => c[0]);
    expect(callClouds.sort()).toEqual(
      [CloudType.AWS, CloudType.GCP, CloudType.Azure, CloudType.Lambda].sort(),
    );
  });

  it('cross-cloud --json sorts by spot price ascending', async () => {
    await createGpusCommand().parseAsync([
      'node',
      'test',
      '--type',
      'H100',
      '--count',
      '8',
      '--spot',
      '--json',
    ]);
    const stdout = logSpy.mock.calls.map((c) => String(c[0]));
    expect(stdout).toHaveLength(1);
    const rows = JSON.parse(stdout[0]);
    // GCP $7.84 < AWS $9.37 < Azure $18.17 < Lambda (on-demand fallback $31.92)
    expect(rows.map((r: { cloud: string }) => r.cloud)).toEqual([
      CloudType.GCP,
      CloudType.AWS,
      CloudType.Azure,
      CloudType.Lambda,
    ]);
    expect(rows[0]).toMatchObject({
      cloud: CloudType.GCP,
      vmType: 'a3-highgpu-8g',
      region: 'europe-north1',
      pricePerHour: 7.84,
      spot: true,
    });
    // Lambda has no spot data — falls back to on-demand, flagged spot=false.
    expect(rows[3]).toMatchObject({
      cloud: CloudType.Lambda,
      pricePerHour: 31.92,
      spot: false,
    });
  });

  it('cross-cloud without --spot sorts by on-demand price', async () => {
    await createGpusCommand().parseAsync([
      'node',
      'test',
      '--type',
      'H100',
      '--count',
      '8',
      '--json',
    ]);
    const stdout = logSpy.mock.calls.map((c) => String(c[0]));
    const rows = JSON.parse(stdout[0]);
    // Lambda $31.92 < GCP $33.61 < AWS $55.04 < Azure $98.32
    expect(rows.map((r: { cloud: string }) => r.cloud)).toEqual([
      CloudType.Lambda,
      CloudType.GCP,
      CloudType.AWS,
      CloudType.Azure,
    ]);
    expect(rows.every((r: { spot: boolean }) => r.spot === false)).toBe(true);
  });

  it('cross-cloud with --count filters out non-matching offerings', async () => {
    vi.mocked(getGpuOfferings).mockReturnValue([
      { ...AWS_H100_8, count: 1 },
      { ...AWS_H100_8, count: 4 },
    ]);
    await createGpusCommand().parseAsync([
      'node',
      'test',
      '--type',
      'H100',
      '--count',
      '8',
      '--json',
    ]);
    const stdout = logSpy.mock.calls.map((c) => String(c[0]));
    expect(JSON.parse(stdout[0])).toEqual([]);
  });

  it('invalid --count exits non-zero', async () => {
    await expect(
      createGpusCommand().parseAsync([
        'node',
        'test',
        '--type',
        'H100',
        '--count',
        'eight',
      ]),
    ).rejects.toThrow(/process\.exit:1/);
  });
});
