import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';

const api = vi.hoisted(() => ({
  createWorkload: vi.fn(),
  getApiCredential: vi.fn(),
  listApiCredentials: vi.fn(),
  listWorkloads: vi.fn(),
  getQuotaStatus: vi.fn(),
}));

// Regression guard for the "creds/target not prompted on submit" class of bug.
// Unlike submit-picker.spec.ts, this does NOT mock ../shared.js — it drives the
// REAL submit action through the REAL resolveCloudConfig + config.js +
// target-picker.js, mocking only the outer edges (prompts, network, catalog
// data). Against the pre-fix shared.ts (which hard-errored with no --vm-type),
// these tests fail because createWorkload is never reached.

vi.mock('../../../src/cli/utils/output.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/cli/utils/output.js')>();
  return {
    ...actual,
    exitWithError: (msg: string) => {
      throw new Error(msg);
    },
    createSpinner: () => ({
      start: () => ({
        succeed: () => undefined,
        warn: () => undefined,
        fail: () => undefined,
        stop: () => undefined,
      }),
    }),
    printInfo: vi.fn(),
    printSuccess: vi.fn(),
    printWarning: vi.fn(),
    printError: vi.fn(),
  };
});

vi.mock('../../../src/cli/utils/safe-prompts.js', () => ({
  safePrompts: vi.fn(),
  shouldAllowPrompts: vi.fn(() => true),
}));

vi.mock('../../../src/shared/services/api-client/runtime.js', () => ({
  checkApiVersion: vi.fn(async (url: string) => ({
    url,
    cliVersion: '0.0.0-test',
    apiVersion: '0.0.0-test',
    compatible: true,
  })),
  getAnycloudVersion: () => '0.0.0-test',
}));

vi.mock('../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: () => ({
    admission: { submit: api.createWorkload },
    credentials: {
      get: api.getApiCredential,
      list: api.listApiCredentials,
    },
    workloads: { list: api.listWorkloads },
    quota: { status: api.getQuotaStatus },
  }),
}));

vi.mock('../../../src/shared/services/docker.js', () => ({
  resolveImageDigest: () => undefined,
  validateImageReference: () => ({ valid: true }),
}));

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock('gh-token'),
);

vi.mock('../../../src/shared/catalog/queries.js', () => ({
  getGpuOfferings: vi.fn(() => []),
  getCpuOfferings: vi.fn(() => []),
  getDiskForVMType: vi.fn(() => undefined),
}));

vi.mock('../../../src/shared/catalog/index.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/shared/catalog/index.js')
    >();
  return {
    ...actual,
    ensureCatalogsBootstrapped: vi.fn(async () => undefined),
  };
});

vi.mock('../../../src/cli/session/detect.js', () => ({
  detectSession: () => undefined,
}));

import { createSubmitCommand } from '../../../src/cli/commands/submit.js';
import { safePrompts } from '../../../src/cli/utils/safe-prompts.js';
import {
  getGpuOfferings,
  getCpuOfferings,
} from '../../../src/shared/catalog/queries.js';
import { CloudType } from '../../../src/shared/cloud.js';

const createWorkload = api.createWorkload;
const getApiCredential = api.getApiCredential;
const listApiCredentials = api.listApiCredentials;

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
const AWS_TEST_CREDENTIAL: Awaited<ReturnType<typeof getApiCredential>> = {
  name: 'aws-test',
  cloudProvider: CloudType.AWS,
};

const ENV_KEYS = [
  'ANYCLOUD_CONFIG',
  'ANYCLOUD_CREDENTIALS_NAME',
  'ANYCLOUD_CLOUD_PROVIDER',
  'AWS_ACCESS_KEY_ID',
  'AZURE_APPLICATION_ID',
  'GCP_PROJECT_ID',
  'LAMBDA_API_KEY',
];

async function runSubmit(argv: string[]) {
  const cmd = createSubmitCommand();
  cmd.exitOverride();
  await cmd.parseAsync(argv, { from: 'user' });
}

describe('submit — full interactive chain (real resolveCloudConfig + picker)', () => {
  let exitSpy: MockInstance<typeof process.exit>;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    vi.mocked(createWorkload).mockResolvedValue({
      id: 'dep-1',
      url: undefined,
    });
    vi.mocked(getApiCredential).mockResolvedValue(AWS_TEST_CREDENTIAL);
    vi.mocked(listApiCredentials).mockResolvedValue([]);
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('TTY, selected credentials/no --vm-type → CPU pick → no spot prompt → deploys resolved vmType', async () => {
    vi.mocked(getGpuOfferings).mockReturnValue([]);
    vi.mocked(getCpuOfferings).mockReturnValue([CPU]);
    vi.mocked(safePrompts).mockResolvedValueOnce({ vmType: 't3.large' }); // compute picker

    await runSubmit(['nginx:latest', '--credentials', 'aws-test']);

    expect(createWorkload).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialName: 'aws-test',
        cloudConfig: expect.objectContaining({ vmType: 't3.large' }),
      }),
    );
    // CPU offering has no spot price → no on-demand/spot prompt fired.
    expect(safePrompts).toHaveBeenCalledTimes(1);
  });

  it('TTY, selected credentials/spot pricing → GPU pick → deploys vmType + spot=true', async () => {
    vi.mocked(getGpuOfferings).mockReturnValue([GPU]);
    vi.mocked(getCpuOfferings).mockReturnValue([]);
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ pricing: 'spot' }) // on-demand vs spot
      .mockResolvedValueOnce({ targetKind: 'vmType' }) // GPU alias vs exact VM
      .mockResolvedValueOnce({ vmType: 'p5.48xlarge' }); // spot-filtered compute picker

    await runSubmit(['nginx:latest', '--credentials', 'aws-test']);

    expect(createWorkload).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialName: 'aws-test',
        cloudConfig: expect.objectContaining({
          vmType: 'p5.48xlarge',
          spot: true,
        }),
      }),
    );
  });

  it('TTY, selected credentials/GPU alias pick → deploys gpuType without vmType', async () => {
    vi.mocked(getGpuOfferings).mockReturnValue([GPU]);
    vi.mocked(getCpuOfferings).mockReturnValue([]);
    vi.mocked(safePrompts)
      .mockResolvedValueOnce({ pricing: 'spot' }) // on-demand vs spot
      .mockResolvedValueOnce({ targetKind: 'gpuType' })
      .mockResolvedValueOnce({ gpuType: 'h100:8' });

    await runSubmit(['nginx:latest', '--credentials', 'aws-test']);

    expect(createWorkload).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialName: 'aws-test',
        gpuType: 'h100:8',
        cloudConfig: expect.objectContaining({
          vmType: undefined,
          spot: true,
        }),
      }),
    );
  });
});
