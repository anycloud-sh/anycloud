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
import { getVMTypeDetails } from '../../../src/shared/catalog/vm-details.js';

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

vi.mock('../../../src/shared/cloud-config.js', async (importActual) => ({
  extractGCPRegion: (
    await importActual<typeof import('../../../src/shared/cloud-config.js')>()
  ).extractGCPRegion,
  getRegions: vi.fn(),
  getVMTypes: vi.fn(),
  getGPUVMTypes: vi.fn(),
  nestedVirtualizationSupport: vi.fn(() => null),
}));

import { createVmTypesCommand } from '../../../src/cli/commands/vm-types.js';
import {
  getRegions,
  getVMTypes,
  getGPUVMTypes,
} from '../../../src/shared/cloud-config.js';
import { setJsonMode } from '../../../src/cli/utils/output.js';
import { bootstrapCatalogsWithUI } from '../../../src/cli/utils/catalog-bootstrap.js';
import {
  safePrompts,
  shouldAllowPrompts,
} from '../../../src/cli/utils/safe-prompts.js';

describe('createVmTypesCommand', () => {
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
    vi.mocked(getRegions).mockReturnValue(['us-east-1', 'us-central1']);
    vi.mocked(getVMTypes).mockReturnValue(['t3.micro', 'p5.48xlarge']);
    vi.mocked(getGPUVMTypes).mockReturnValue(['p5.48xlarge']);
  });

  afterEach(() => {
    setJsonMode(false);
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('passes provider and region with no accelerator by default', async () => {
    await createVmTypesCommand().parseAsync([
      'node',
      'test',
      'aws',
      'us-east-1',
    ]);
    expect(getVMTypes).toHaveBeenCalledWith(CloudType.AWS, 'us-east-1');
    expect(getGPUVMTypes).not.toHaveBeenCalled();
  });

  it('prompts for provider and region in an interactive TTY', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ provider: 'gcp' })
      .mockResolvedValueOnce({ region: 'us-central1' });

    await createVmTypesCommand().parseAsync(['node', 'test']);

    expect(getVMTypes).toHaveBeenCalledWith(CloudType.GCP, 'us-central1');
    expect(safePrompts).toHaveBeenCalledTimes(2);
  });

  it('missing provider exits non-zero without prompting in non-interactive mode', async () => {
    await expect(
      createVmTypesCommand().parseAsync(['node', 'test']),
    ).rejects.toThrow(/process\.exit:1/);
    expect(safePrompts).not.toHaveBeenCalled();
    expect(bootstrapCatalogsWithUI).not.toHaveBeenCalled();
    expect(getVMTypes).not.toHaveBeenCalled();
  });

  it('missing region exits non-zero without bootstrapping in non-interactive mode', async () => {
    await expect(
      createVmTypesCommand().parseAsync(['node', 'test', 'aws']),
    ).rejects.toThrow(/process\.exit:1/);
    expect(safePrompts).not.toHaveBeenCalled();
    expect(bootstrapCatalogsWithUI).not.toHaveBeenCalled();
    expect(getVMTypes).not.toHaveBeenCalled();
  });

  it('--accelerator switches to getGPUVMTypes', async () => {
    await createVmTypesCommand().parseAsync([
      'node',
      'test',
      'gcp',
      'us-central1',
      '--accelerator',
      'H100',
    ]);
    expect(getGPUVMTypes).toHaveBeenCalledWith(
      CloudType.GCP,
      'us-central1',
      'H100',
    );
    expect(getVMTypes).not.toHaveBeenCalled();
  });

  it('--json prints types as a JSON array', async () => {
    await createVmTypesCommand().parseAsync([
      'node',
      'test',
      'aws',
      'us-east-1',
      '--json',
    ]);
    const stdout = logSpy.mock.calls.map((c) => String(c[0]));
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0])).toEqual(['t3.micro', 'p5.48xlarge']);
  });

  it('unknown provider exits non-zero', async () => {
    await expect(
      createVmTypesCommand().parseAsync([
        'node',
        'test',
        'sirius',
        'us-east-1',
      ]),
    ).rejects.toThrow(/process\.exit:1/);
  });

  it('--details --json describes the selected CPU and GPU types while retaining names-only compatibility', async () => {
    await createVmTypesCommand().parseAsync([
      'node',
      'test',
      'aws',
      'us-east-1',
      '--details',
      '--json',
    ]);
    const records = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(records).toEqual(
      getVMTypeDetails(CloudType.AWS, 'us-east-1', ['t3.micro', 'p5.48xlarge']),
    );
    expect(records[0]).toMatchObject({
      vmType: 't3.micro',
      vCPUs: 2,
      memoryGiB: 1,
      accelerators: [],
    });
    expect(records[1].accelerators).toEqual([{ name: 'H100', count: 8 }]);
    expect(records[0].regions.length).toBeGreaterThan(0);
  });

  it('keeps accelerator filtering and describes only its selected types', async () => {
    await createVmTypesCommand().parseAsync([
      'node',
      'test',
      'aws',
      'us-east-1',
      '--accelerator',
      'H100',
      '--details',
      '--json',
    ]);
    expect(getGPUVMTypes).toHaveBeenCalledWith(
      CloudType.AWS,
      'us-east-1',
      'H100',
    );
    const records = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(records.map((record: { vmType: string }) => record.vmType)).toEqual([
      'p5.48xlarge',
    ]);
    expect(records[0].region).toBe('us-east-1');
  });

  it('renders detailed human output and returns an empty JSON array for an empty selection', async () => {
    await createVmTypesCommand().parseAsync([
      'node',
      'test',
      'aws',
      'us-east-1',
      '--details',
    ]);
    expect(String(logSpy.mock.calls[0][0])).toContain('NESTED VIRTUALIZATION');
    expect(String(logSpy.mock.calls[0][0])).toContain('t3.micro');
    logSpy.mockClear();
    vi.mocked(getVMTypes).mockReturnValue([]);
    await createVmTypesCommand().parseAsync([
      'node',
      'test',
      'aws',
      'us-east-1',
      '--details',
      '--json',
    ]);
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual([]);
  });
});
