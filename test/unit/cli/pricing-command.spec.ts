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

vi.mock('../../../src/shared/catalog/queries.js', () => ({
  getPricing: vi.fn(),
}));

import { createPricingCommand } from '../../../src/cli/commands/pricing.js';
import { getPricing } from '../../../src/shared/catalog/queries.js';
import { setJsonMode, printInfo } from '../../../src/cli/utils/output.js';
import { bootstrapCatalogsWithUI } from '../../../src/cli/utils/catalog-bootstrap.js';
import {
  safePrompts,
  shouldAllowPrompts,
} from '../../../src/cli/utils/safe-prompts.js';
import { pickVmTypeTarget } from '../../../src/cli/services/target-picker.js';

describe('createPricingCommand', () => {
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
  });

  afterEach(() => {
    setJsonMode(false);
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('all-region lookup forwards spot=false when --spot not passed', async () => {
    vi.mocked(getPricing).mockReturnValue({
      vmType: 'p5.48xlarge',
      spot: false,
      regions: [{ region: 'us-east-1', pricePerHour: 12.34 }],
    });
    await createPricingCommand().parseAsync([
      'node',
      'test',
      'aws',
      'p5.48xlarge',
    ]);
    expect(getPricing).toHaveBeenCalledWith(
      CloudType.AWS,
      'p5.48xlarge',
      undefined,
      false,
    );
  });

  it('prompts for provider and VM type in an interactive TTY', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(safePrompts).mockResolvedValueOnce({ provider: 'aws' });
    vi.mocked(getPricing).mockReturnValue({
      vmType: 'p5.48xlarge',
      spot: false,
      regions: [{ region: 'us-east-1', pricePerHour: 12.34 }],
    });

    await createPricingCommand().parseAsync(['node', 'test']);

    expect(pickVmTypeTarget).toHaveBeenCalledWith(CloudType.AWS);
    expect(getPricing).toHaveBeenCalledWith(
      CloudType.AWS,
      'p5.48xlarge',
      undefined,
      false,
    );
  });

  it('missing provider exits non-zero without prompting in non-interactive mode', async () => {
    await expect(
      createPricingCommand().parseAsync(['node', 'test']),
    ).rejects.toThrow(/process\.exit:1/);
    expect(safePrompts).not.toHaveBeenCalled();
    expect(pickVmTypeTarget).not.toHaveBeenCalled();
    expect(bootstrapCatalogsWithUI).not.toHaveBeenCalled();
    expect(getPricing).not.toHaveBeenCalled();
  });

  it('missing VM type exits non-zero without prompting in non-interactive mode', async () => {
    await expect(
      createPricingCommand().parseAsync(['node', 'test', 'aws']),
    ).rejects.toThrow(/process\.exit:1/);
    expect(pickVmTypeTarget).not.toHaveBeenCalled();
    expect(bootstrapCatalogsWithUI).not.toHaveBeenCalled();
    expect(getPricing).not.toHaveBeenCalled();
  });

  it('--region and --spot are forwarded', async () => {
    vi.mocked(getPricing).mockReturnValue({
      vmType: 'p5.48xlarge',
      region: 'us-east-1',
      spot: true,
      pricePerHour: 5.67,
    });
    await createPricingCommand().parseAsync([
      'node',
      'test',
      'aws',
      'p5.48xlarge',
      '--region',
      'us-east-1',
      '--spot',
    ]);
    expect(getPricing).toHaveBeenCalledWith(
      CloudType.AWS,
      'p5.48xlarge',
      'us-east-1',
      true,
    );
  });

  it('--json prints the pricing object as-is', async () => {
    const payload = {
      vmType: 'p5.48xlarge',
      spot: false,
      regions: [{ region: 'us-east-1', pricePerHour: 12.34 }],
    };
    vi.mocked(getPricing).mockReturnValue(payload);
    await createPricingCommand().parseAsync([
      'node',
      'test',
      'aws',
      'p5.48xlarge',
      '--json',
    ]);
    const stdout = logSpy.mock.calls.map((c) => String(c[0]));
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0])).toEqual(payload);
  });

  it('--json with no pricing data emits null', async () => {
    vi.mocked(getPricing).mockReturnValue(undefined);
    await createPricingCommand().parseAsync([
      'node',
      'test',
      'aws',
      'unknown.vm',
      '--json',
    ]);
    const stdout = logSpy.mock.calls.map((c) => String(c[0]));
    expect(stdout).toEqual(['null']);
  });

  it('non-json no-pricing path calls printInfo (not printError)', async () => {
    vi.mocked(getPricing).mockReturnValue(undefined);
    await createPricingCommand().parseAsync([
      'node',
      'test',
      'aws',
      'unknown.vm',
    ]);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(vi.mocked(printInfo)).toHaveBeenCalledWith(
      expect.stringContaining('unknown.vm'),
    );
  });

  it('unknown provider exits non-zero', async () => {
    await expect(
      createPricingCommand().parseAsync([
        'node',
        'test',
        'sirius',
        'p5.48xlarge',
      ]),
    ).rejects.toThrow(/process\.exit:1/);
  });
});
