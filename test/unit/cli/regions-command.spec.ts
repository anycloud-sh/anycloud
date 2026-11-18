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

vi.mock('../../../src/cli/services/target-picker.js', () => ({
  pickVmTypeTarget: vi.fn(),
}));

vi.mock('../../../src/shared/cloud-config.js', () => ({
  getRegions: vi.fn(),
  getRegionsForVMType: vi.fn(),
}));

import { createRegionsCommand } from '../../../src/cli/commands/regions.js';
import {
  getRegions,
  getRegionsForVMType,
} from '../../../src/shared/cloud-config.js';
import { setJsonMode } from '../../../src/cli/utils/output.js';
import { bootstrapCatalogsWithUI } from '../../../src/cli/utils/catalog-bootstrap.js';
import {
  safePrompts,
  shouldAllowPrompts,
} from '../../../src/cli/utils/safe-prompts.js';
import { pickVmTypeTarget } from '../../../src/cli/services/target-picker.js';

describe('createRegionsCommand', () => {
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
    vi.mocked(pickVmTypeTarget).mockReset();
    vi.mocked(pickVmTypeTarget).mockResolvedValue({
      kind: 'vmType',
      vmType: 'p5.48xlarge',
    });
    vi.mocked(getRegions).mockReturnValue(['us-east-1', 'us-west-2']);
    vi.mocked(getRegionsForVMType).mockReturnValue(['us-east-1', 'us-west-2']);
  });

  afterEach(() => {
    setJsonMode(false);
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('uppercases provider before reading the catalog', async () => {
    await createRegionsCommand().parseAsync(['node', 'test', 'aws']);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(getRegions).toHaveBeenCalledWith(CloudType.AWS);
    expect(getRegionsForVMType).not.toHaveBeenCalled();
  });

  it('prompts for provider in an interactive TTY', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(safePrompts).mockResolvedValueOnce({ provider: 'gcp' });

    await createRegionsCommand().parseAsync(['node', 'test']);

    expect(getRegions).toHaveBeenCalledWith(CloudType.GCP);
    expect(safePrompts).toHaveBeenCalledTimes(1);
  });

  it('missing provider exits non-zero without prompting in non-interactive mode', async () => {
    await expect(
      createRegionsCommand().parseAsync(['node', 'test']),
    ).rejects.toThrow(/process\.exit:1/);
    expect(safePrompts).not.toHaveBeenCalled();
    expect(bootstrapCatalogsWithUI).not.toHaveBeenCalled();
    expect(getRegions).not.toHaveBeenCalled();
  });

  it('mixed-case provider input still normalizes', async () => {
    await createRegionsCommand().parseAsync(['node', 'test', 'AzUrE']);
    expect(getRegions).toHaveBeenCalledWith(CloudType.Azure);
  });

  it('prints one region per line by default', async () => {
    await createRegionsCommand().parseAsync(['node', 'test', 'aws']);
    const stdout = logSpy.mock.calls.map((c) => String(c[0]));
    expect(stdout).toEqual(['us-east-1', 'us-west-2']);
  });

  it('--json prints the regions as a JSON array', async () => {
    await createRegionsCommand().parseAsync(['node', 'test', 'aws', '--json']);
    const stdout = logSpy.mock.calls.map((c) => String(c[0]));
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0])).toEqual(['us-east-1', 'us-west-2']);
  });

  it('unknown provider exits non-zero', async () => {
    await expect(
      createRegionsCommand().parseAsync(['node', 'test', 'sirius']),
    ).rejects.toThrow(/process\.exit:1/);
  });

  it('--vm-type calls getRegionsForVMType', async () => {
    await createRegionsCommand().parseAsync([
      'node',
      'test',
      'aws',
      '--vm-type',
      'p5.48xlarge',
    ]);
    expect(getRegionsForVMType).toHaveBeenCalledWith(
      'p5.48xlarge',
      CloudType.AWS,
      undefined,
    );
    expect(getRegions).not.toHaveBeenCalled();
  });

  it('--vm-type --spot forwards spot=true', async () => {
    await createRegionsCommand().parseAsync([
      'node',
      'test',
      'aws',
      '--vm-type',
      'p5.48xlarge',
      '--spot',
    ]);
    expect(getRegionsForVMType).toHaveBeenCalledWith(
      'p5.48xlarge',
      CloudType.AWS,
      true,
    );
  });

  it('--spot without --vm-type exits non-zero', async () => {
    await expect(
      createRegionsCommand().parseAsync(['node', 'test', 'aws', '--spot']),
    ).rejects.toThrow(/process\.exit:1/);
    expect(bootstrapCatalogsWithUI).not.toHaveBeenCalled();
    expect(getRegions).not.toHaveBeenCalled();
    expect(getRegionsForVMType).not.toHaveBeenCalled();
  });

  it('--spot without --vm-type prompts for a VM type in an interactive TTY', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);

    await createRegionsCommand().parseAsync(['node', 'test', 'aws', '--spot']);

    expect(pickVmTypeTarget).toHaveBeenCalledWith(CloudType.AWS);
    expect(getRegionsForVMType).toHaveBeenCalledWith(
      'p5.48xlarge',
      CloudType.AWS,
      true,
    );
  });
});
