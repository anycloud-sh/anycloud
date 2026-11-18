import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';

vi.mock('../../../src/shared/catalog/queries.js', () => ({
  getGpuOfferings: vi.fn(),
  getCpuOfferings: vi.fn(),
  getDiskForVMType: vi.fn(),
}));

vi.mock('../../../src/cli/utils/safe-prompts.js', () => ({
  safePrompts: vi.fn(),
}));

vi.mock('../../../src/cli/utils/output.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/cli/utils/output.js')>();
  return {
    ...actual,
    exitWithError: (msg: string) => {
      throw new Error(msg);
    },
  };
});

import {
  hasSpotComputeOfferings,
  pickComputeTarget,
} from '../../../src/cli/services/target-picker.js';
import {
  getGpuOfferings,
  getCpuOfferings,
  getDiskForVMType,
} from '../../../src/shared/catalog/queries.js';
import { safePrompts } from '../../../src/cli/utils/safe-prompts.js';
import { CloudType } from '../../../src/shared/cloud.js';
import type { Choice, PromptObject } from 'prompts';

type TargetPrompt = PromptObject<string> & {
  choices: Choice[];
  suggest: NonNullable<PromptObject<string>['suggest']>;
};

/**
 * The single question the picker asked, on the given call.
 *
 * safePrompts accepts one question or a list; the picker always asks one, with
 * inline choices and a suggest callback. Anything else means the picker changed
 * shape, and the assertions below would be reading a prompt that no longer
 * exists.
 */
function promptOn(call: number): TargetPrompt {
  const [question] = vi.mocked(safePrompts).mock.calls[call];
  if (Array.isArray(question)) throw new Error('expected a single prompt');
  const { choices, suggest } = question;
  if (!Array.isArray(choices) || typeof suggest !== 'function') {
    throw new Error('expected inline choices and a suggest callback');
  }
  return { ...question, choices, suggest };
}

const GPU = {
  gpu: 'H100',
  count: 8,
  vmType: 'p5.48xlarge',
  vCPUs: 192,
  memoryGiB: 2048,
  onDemand: { region: 'us-east-1', pricePerHour: 98.32 },
  spot: { region: 'us-west-2', pricePerHour: 12.5 },
};
const CPU = {
  vmType: 't3.large',
  vCPUs: 2,
  memoryGiB: 8,
  onDemand: { region: 'us-east-1', pricePerHour: 0.0832 },
  spot: null,
};

describe('pickComputeTarget', () => {
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDiskForVMType).mockReturnValue(undefined);
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('lists GPU offerings first, then labeled CPU rows', async () => {
    vi.mocked(getGpuOfferings).mockReturnValue([GPU]);
    vi.mocked(getCpuOfferings).mockReturnValue([CPU]);
    vi.mocked(safePrompts).mockResolvedValue({ vmType: 'p5.48xlarge' });

    const result = await pickComputeTarget(CloudType.AWS);

    expect(result).toEqual({
      kind: 'vmType',
      vmType: 'p5.48xlarge',
    });
    const choices = promptOn(0).choices;
    expect(choices[0].value).toBe('p5.48xlarge'); // GPU first
    const cpuChoice = choices.find((c) => c.value === 't3.large');
    expect(cpuChoice?.title).toMatch(/vCPU/);
    expect(cpuChoice?.title).toMatch(/GiB/);
    expect(cpuChoice?.title).toMatch(/\$/);
  });

  it('returns a portable GPU alias from the mixed picker', async () => {
    vi.mocked(getGpuOfferings).mockReturnValue([GPU]);
    vi.mocked(getCpuOfferings).mockReturnValue([CPU]);
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ targetKind: 'gpuType' })
      .mockResolvedValueOnce({ gpuType: 'h100:8' });

    const result = await pickComputeTarget(CloudType.AWS, {
      allowGpuTypes: true,
    });

    expect(result).toEqual({
      kind: 'gpuType',
      gpuType: 'h100:8',
    });
    expect(safePrompts).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        message: 'Pick compute target',
        choices: [
          { title: 'Pick by GPU type', value: 'gpuType' },
          { title: 'Pick exact VM type', value: 'vmType' },
        ],
      }),
    );
    const gpuPrompt = vi.mocked(safePrompts).mock.calls[1][0] as {
      choices: { title: string; value: string }[];
    };
    expect(gpuPrompt.choices.map((c) => c.value)).toEqual(['h100:8']);
    expect(gpuPrompt.choices[0].title).toContain('p5.48xlarge');
  });

  it('keeps exact VM selection available from the mixed picker', async () => {
    vi.mocked(getGpuOfferings).mockReturnValue([GPU]);
    vi.mocked(getCpuOfferings).mockReturnValue([CPU]);
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ targetKind: 'vmType' })
      .mockResolvedValueOnce({ vmType: 'p5.48xlarge' });

    const result = await pickComputeTarget(CloudType.AWS, {
      allowGpuTypes: true,
    });

    expect(result).toEqual({
      kind: 'vmType',
      vmType: 'p5.48xlarge',
    });
    const vmPrompt = vi.mocked(safePrompts).mock.calls[1][0] as {
      message: string;
      choices: { value: string }[];
    };
    expect(vmPrompt.message).toBe('Pick a VM type');
    expect(vmPrompt.choices.map((c) => c.value)).toEqual([
      'p5.48xlarge',
      't3.large',
    ]);
  });

  it('skips the target-kind prompt when no GPU offerings exist', async () => {
    vi.mocked(getGpuOfferings).mockReturnValue([]);
    vi.mocked(getCpuOfferings).mockReturnValue([CPU]);
    vi.mocked(safePrompts).mockResolvedValue({ vmType: 't3.large' });

    const result = await pickComputeTarget(CloudType.AWS, {
      allowGpuTypes: true,
    });

    expect(result).toEqual({
      kind: 'vmType',
      vmType: 't3.large',
    });
    expect(safePrompts).toHaveBeenCalledTimes(1);
    expect(vi.mocked(safePrompts).mock.calls[0][0]).toMatchObject({
      message: 'Pick a VM type',
    });
  });

  it('formats picker rows as stable columns with compact disk labels', async () => {
    vi.mocked(getGpuOfferings).mockReturnValue([GPU]);
    vi.mocked(getCpuOfferings).mockReturnValue([CPU]);
    vi.mocked(getDiskForVMType).mockImplementation((_cloud, vmType) =>
      vmType === 'p5.48xlarge'
        ? {
            kind: 'local-ssd',
            totalGb: 30400,
            sizeGb: 3800,
            count: 8,
            type: 'ssd',
          }
        : undefined,
    );
    vi.mocked(safePrompts).mockResolvedValue({ vmType: 'p5.48xlarge' });

    await pickComputeTarget(CloudType.AWS);

    const choices = promptOn(0).choices;
    expect(choices.find((c) => c.value === 'p5.48xlarge')?.title).toBe(
      'p5.48xlarge  8x H100  192 vCPU  2048 GiB  30.4 TB SSD  $98.32/hr',
    );
    expect(choices.find((c) => c.value === 't3.large')?.title).toBe(
      't3.large     CPU        2 vCPU     8 GiB               $0.0832/hr',
    );
  });

  it('adds quota hints as a trailing column and ranks hinted rows first', async () => {
    vi.mocked(getGpuOfferings).mockReturnValue([GPU]);
    vi.mocked(getCpuOfferings).mockReturnValue([CPU]);
    vi.mocked(safePrompts).mockResolvedValue({ vmType: 't3.large' });

    const result = await pickComputeTarget(CloudType.AWS, {
      quota: {
        label: 'on-demand quota limit',
        regionsForVmType: (vmType) =>
          vmType === 't3.large' ? ['us-east-1', 'us-west-2', 'us-east-2'] : [],
      },
    });

    expect(result).toEqual({
      kind: 'vmType',
      vmType: 't3.large',
    });
    const opts = promptOn(0);
    expect(opts.choices.map((c) => c.value)).toEqual([
      't3.large',
      'p5.48xlarge',
    ]);
    expect(opts.choices[0].title).toContain(
      'on-demand quota limit: us-east-1, us-west-2 +1 more',
    );

    const curated: Choice[] = await opts.suggest('', opts.choices);
    expect(curated.map((c) => c.value)).toEqual(['t3.large', 'p5.48xlarge']);
  });

  it('curated default = GPUs + common CPU sizes; fractional GPUs dropped; typing searches all', async () => {
    const FRAC = { ...GPU, gpu: 'L4', count: 0.125, vmType: 'g6.frac' };
    const CPU2 = {
      vmType: 't3.small',
      vCPUs: 2,
      memoryGiB: 2,
      onDemand: { region: 'us-east-1', pricePerHour: 0.02 },
      spot: null,
    };
    const CPU8 = {
      vmType: 'c7i.2xlarge',
      vCPUs: 8,
      memoryGiB: 16,
      onDemand: { region: 'us-east-1', pricePerHour: 0.34 },
      spot: null,
    };
    const CPU48 = {
      vmType: 'c7i.12xlarge',
      vCPUs: 48,
      memoryGiB: 96,
      onDemand: { region: 'us-east-1', pricePerHour: 2.04 },
      spot: null,
    };
    vi.mocked(getGpuOfferings).mockReturnValue([GPU, FRAC]);
    vi.mocked(getCpuOfferings).mockReturnValue([CPU2, CPU8, CPU48]);
    vi.mocked(safePrompts).mockResolvedValue({ vmType: 'p5.48xlarge' });

    await pickComputeTarget(CloudType.AWS);

    const opts = vi.mocked(safePrompts).mock.calls[0][0] as {
      choices: { value: string }[];
      limit?: number;
      suggest: (
        input: string,
        choices: unknown[],
      ) => Promise<{ value: string }[]>;
    };
    const values = opts.choices.map((c) => c.value);
    // Fractional GPU dropped from the searchable universe...
    expect(values).not.toContain('g6.frac');
    // ...but the non-tier CPU is still in the full list (reachable by typing).
    expect(values).toContain('c7i.12xlarge');
    expect(opts.limit).toBe(12);

    // Empty input → short curated view: GPU + the tier CPUs (2, 8), NOT the 48-vCPU shape.
    const curated = (await opts.suggest('', opts.choices)).map((c) => c.value);
    expect(curated).toContain('p5.48xlarge');
    expect(curated).toContain('t3.small');
    expect(curated).toContain('c7i.2xlarge');
    expect(curated).not.toContain('c7i.12xlarge');
    expect(curated.length).toBeLessThan(values.length);

    // Typing searches the full catalog — the non-tier CPU is reachable.
    const typed = (await opts.suggest('c7i.12xlarge', opts.choices)).map(
      (c) => c.value,
    );
    expect(typed).toContain('c7i.12xlarge');
  });

  it('ranks quota-capable GPU aliases first while preserving order within groups', async () => {
    const A100 = {
      ...GPU,
      gpu: 'A100',
      count: 1,
      vmType: 'p4d.24xlarge',
      spot: null,
    };
    const H200 = {
      ...GPU,
      gpu: 'H200',
      count: 8,
      vmType: 'p5e.48xlarge',
      spot: null,
    };
    vi.mocked(getGpuOfferings).mockReturnValue([GPU, A100, H200]);
    vi.mocked(getCpuOfferings).mockReturnValue([]);
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ targetKind: 'gpuType' })
      .mockResolvedValueOnce({ gpuType: 'a100:1' });

    await pickComputeTarget(CloudType.AWS, {
      allowGpuTypes: true,
      quota: {
        label: 'on-demand quota limit',
        regionsForVmType: (vmType) =>
          vmType === 'p4d.24xlarge' || vmType === 'p5e.48xlarge'
            ? ['us-east-1']
            : [],
      },
    });

    const gpuPrompt = vi.mocked(safePrompts).mock.calls[1][0] as {
      choices: { title: string; value: string }[];
    };
    expect(gpuPrompt.choices.map((c) => c.value)).toEqual([
      'a100:1',
      'h200:8',
      'h100:8',
    ]);
    expect(gpuPrompt.choices[0].title).toContain(
      'on-demand quota limit: us-east-1',
    );
    expect(gpuPrompt.choices[1].title).toContain(
      'on-demand quota limit: us-east-1',
    );
  });

  it('aligns GPU alias rows when only some offerings have disk data', async () => {
    const A10 = {
      ...GPU,
      gpu: 'A10',
      count: 1,
      vmType: 'g5.xlarge',
      vCPUs: 4,
      memoryGiB: 16,
      onDemand: { region: 'us-east-1', pricePerHour: 0.5 },
      spot: null,
    };
    vi.mocked(getGpuOfferings).mockReturnValue([GPU, A10]);
    vi.mocked(getCpuOfferings).mockReturnValue([]);
    vi.mocked(getDiskForVMType).mockImplementation((_cloud, vmType) =>
      vmType === 'p5.48xlarge'
        ? {
            kind: 'local-ssd',
            totalGb: 30400,
            sizeGb: 3800,
            count: 8,
            type: 'ssd',
          }
        : undefined,
    );
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ targetKind: 'gpuType' })
      .mockResolvedValueOnce({ gpuType: 'h100:8' });

    await pickComputeTarget(CloudType.AWS, { allowGpuTypes: true });

    const choices = (
      vi.mocked(safePrompts).mock.calls[1][0] as {
        choices: { title: string; value: string }[];
      }
    ).choices;
    expect(choices.find((c) => c.value === 'h100:8')?.title).toBe(
      'h100:8  p5.48xlarge  192 vCPU  2048 GiB  30.4 TB SSD  $98.32/hr',
    );
    expect(choices.find((c) => c.value === 'a10:1')?.title).toBe(
      'a10:1   g5.xlarge      4 vCPU    16 GiB               $0.5000/hr',
    );
  });

  it('returns the selected offering when it has no spot price', async () => {
    vi.mocked(getGpuOfferings).mockReturnValue([GPU]);
    vi.mocked(getCpuOfferings).mockReturnValue([CPU]);
    vi.mocked(safePrompts).mockResolvedValue({ vmType: 't3.large' });

    const result = await pickComputeTarget(CloudType.AWS);
    expect(result).toEqual({
      kind: 'vmType',
      vmType: 't3.large',
    });
  });

  it('filters GPU aliases to spot-capable rows and displays spot rates', async () => {
    const NO_SPOT_GPU = { ...GPU, gpu: 'A100', count: 1, spot: null };
    vi.mocked(getGpuOfferings).mockReturnValue([GPU, NO_SPOT_GPU]);
    vi.mocked(getCpuOfferings).mockReturnValue([CPU]);
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ targetKind: 'gpuType' })
      .mockResolvedValueOnce({ gpuType: 'h100:8' });

    const result = await pickComputeTarget(CloudType.AWS, {
      allowGpuTypes: true,
      spotOnly: true,
    });

    expect(result).toEqual({
      kind: 'gpuType',
      gpuType: 'h100:8',
    });
    const choices = (
      vi.mocked(safePrompts).mock.calls[1][0] as {
        choices: { title: string; value: string }[];
      }
    ).choices;
    expect(choices.map((c) => c.value)).toEqual(['h100:8']);
    expect(choices[0].title).toContain('$12.50/hr spot');
    expect(choices[0].title).not.toContain('$98.32/hr');
    expect(getGpuOfferings).toHaveBeenCalledWith(CloudType.AWS, undefined, {
      pricingMode: 'spot',
    });
  });

  it('describes the VM type an alias resolves to when spot pricing prefers a sibling', async () => {
    const RESOLVED_L40S = {
      gpu: 'L40S',
      count: 1,
      vmType: 'g6e.xlarge',
      vCPUs: 4,
      memoryGiB: 32,
      onDemand: { region: 'us-east-1', pricePerHour: 1.861 },
      spot: { region: 'eu-north-1', pricePerHour: 0.5508 },
    };
    const SPOT_CHEAP_L40S = {
      ...RESOLVED_L40S,
      vmType: 'g6e.4xlarge',
      vCPUs: 16,
      memoryGiB: 128,
      spot: { region: 'eu-south-2', pricePerHour: 0.518 },
    };
    vi.mocked(getGpuOfferings).mockImplementation(
      (_cloud, _gpuFilter, options) =>
        options?.pricingMode === 'spot' ? [SPOT_CHEAP_L40S] : [RESOLVED_L40S],
    );
    vi.mocked(getCpuOfferings).mockReturnValue([]);
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ targetKind: 'gpuType' })
      .mockResolvedValueOnce({ gpuType: 'l40s:1' });

    const result = await pickComputeTarget(CloudType.AWS, {
      allowGpuTypes: true,
      spotOnly: true,
      quota: {
        label: 'spot quota limit',
        regionsForVmType: (vmType) =>
          vmType === 'g6e.xlarge' ? ['us-east-1'] : [],
      },
    });

    expect(result).toEqual({
      kind: 'gpuType',
      gpuType: 'l40s:1',
    });
    const choices = (
      vi.mocked(safePrompts).mock.calls[1][0] as {
        choices: { title: string; value: string }[];
      }
    ).choices;
    expect(choices).toEqual([
      {
        value: 'l40s:1',
        title:
          'l40s:1  g6e.xlarge  4 vCPU  32 GiB  $0.5508/hr spot  spot quota limit: us-east-1',
      },
    ]);
  });

  it('keeps a spot-capable sibling available for exact VM selection', async () => {
    const RESOLVED_WITHOUT_SPOT = {
      ...GPU,
      gpu: 'L40S',
      count: 1,
      vmType: 'g6e.xlarge',
      vCPUs: 4,
      memoryGiB: 32,
      spot: null,
    };
    const SPOT_SIBLING = {
      ...RESOLVED_WITHOUT_SPOT,
      vmType: 'g6e.4xlarge',
      vCPUs: 16,
      memoryGiB: 128,
      spot: { region: 'eu-south-2', pricePerHour: 0.518 },
    };
    vi.mocked(getGpuOfferings).mockImplementation(
      (_cloud, _gpuFilter, options) =>
        options?.pricingMode === 'spot'
          ? [SPOT_SIBLING]
          : [RESOLVED_WITHOUT_SPOT],
    );
    vi.mocked(getCpuOfferings).mockReturnValue([]);
    vi.mocked(safePrompts).mockResolvedValue({ vmType: 'g6e.4xlarge' });

    const result = await pickComputeTarget(CloudType.AWS, {
      allowGpuTypes: true,
      spotOnly: true,
    });

    expect(result).toEqual({
      kind: 'vmType',
      vmType: 'g6e.4xlarge',
    });
    expect(safePrompts).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(safePrompts).mock.calls[0][0] as {
      message: string;
      choices: { title: string; value: string }[];
    };
    expect(prompt.message).toBe('Pick a VM type');
    expect(prompt.choices).toEqual([
      expect.objectContaining({
        value: 'g6e.4xlarge',
        title: expect.stringContaining('$0.5180/hr spot'),
      }),
    ]);
  });

  it('filters the picker to spot-capable rows when spotOnly is set', async () => {
    vi.mocked(getGpuOfferings).mockReturnValue([GPU]);
    vi.mocked(getCpuOfferings).mockReturnValue([CPU]);
    vi.mocked(safePrompts).mockResolvedValue({ vmType: 'p5.48xlarge' });

    await pickComputeTarget(CloudType.AWS, { spotOnly: true });

    const choices = promptOn(0).choices;
    expect(choices.map((c) => c.value)).toEqual(['p5.48xlarge']);
    expect(choices[0].title).toContain('$12.50/hr spot');
    expect(choices[0].title).not.toContain('$98.32/hr');
    expect(getGpuOfferings).toHaveBeenCalledWith(CloudType.AWS, undefined, {
      pricingMode: 'spot',
    });
  });

  it('orders spot-only CPU rows by spot price for the curated default', async () => {
    const ON_DEMAND_CHEAP = {
      vmType: 'm7i.large',
      vCPUs: 2,
      memoryGiB: 8,
      onDemand: { region: 'us-east-1', pricePerHour: 0.05 },
      spot: { region: 'us-east-1', pricePerHour: 0.04 },
    };
    const SPOT_CHEAP = {
      vmType: 'c7i.large',
      vCPUs: 2,
      memoryGiB: 4,
      onDemand: { region: 'us-east-1', pricePerHour: 0.09 },
      spot: { region: 'us-east-1', pricePerHour: 0.01 },
    };
    vi.mocked(getGpuOfferings).mockReturnValue([]);
    vi.mocked(getCpuOfferings).mockReturnValue([ON_DEMAND_CHEAP, SPOT_CHEAP]);
    vi.mocked(safePrompts).mockResolvedValue({ vmType: 'c7i.large' });

    await pickComputeTarget(CloudType.AWS, { spotOnly: true });

    const opts = promptOn(0);
    expect(opts.choices.map((c) => c.value)).toEqual([
      'c7i.large',
      'm7i.large',
    ]);
    expect(opts.choices[0].title).toContain('$0.0100/hr spot');

    const curated: Choice[] = await opts.suggest('', opts.choices);
    expect(curated.map((c) => c.value)).toEqual(['c7i.large']);
  });

  it('reports whether the cloud has any spot-capable picker offerings', () => {
    vi.mocked(getGpuOfferings).mockReturnValue([GPU]);
    vi.mocked(getCpuOfferings).mockReturnValue([CPU]);

    expect(hasSpotComputeOfferings(CloudType.AWS)).toBe(true);

    vi.mocked(getGpuOfferings).mockReturnValue([{ ...GPU, spot: null }]);
    vi.mocked(getCpuOfferings).mockReturnValue([CPU]);

    expect(hasSpotComputeOfferings(CloudType.AWS)).toBe(false);
  });

  it('exits with an error when no offerings exist for the cloud', async () => {
    vi.mocked(getGpuOfferings).mockReturnValue([]);
    vi.mocked(getCpuOfferings).mockReturnValue([]);

    await expect(pickComputeTarget(CloudType.Lambda)).rejects.toThrow(
      /No compute offerings/i,
    );
    expect(safePrompts).not.toHaveBeenCalled();
  });

  it('exits cleanly when the user cancels (Ctrl-C)', async () => {
    vi.mocked(getGpuOfferings).mockReturnValue([GPU]);
    vi.mocked(getCpuOfferings).mockReturnValue([]);
    vi.mocked(safePrompts).mockResolvedValue({ vmType: undefined });

    await expect(pickComputeTarget(CloudType.AWS)).rejects.toThrow(
      'process.exit:0',
    );
  });
});
