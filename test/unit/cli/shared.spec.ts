import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';
import { type StoredWorkload } from '../../../src/api/services/workload-record.js';
import { CloudType, type CloudCredentials } from '../../../src/shared/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';

const { spinnerWarn } = vi.hoisted(() => ({ spinnerWarn: vi.fn() }));
const api = vi.hoisted(() => ({
  listWorkloads: vi.fn(),
  listApiCredentials: vi.fn(),
  getQuotaStatus: vi.fn(),
}));

vi.mock('../../../src/cli/utils/output.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/cli/utils/output.js')>();
  return {
    ...actual,
    exitWithError: (msg: string) => {
      throw new Error(msg);
    },
    createSpinner: () => ({
      start: () => ({ stop: () => undefined, warn: spinnerWarn }),
    }),
    printInfo: vi.fn(),
    printError: vi.fn(),
    printWarning: vi.fn(),
  };
});
vi.mock('../../../src/cli/utils/workload-picker.js', () => ({
  selectWorkload: vi.fn(),
  selectWorkloads: vi.fn(),
}));

vi.mock('../../../src/cli/utils/safe-prompts.js', () => ({
  shouldAllowPrompts: vi.fn(),
  safePrompts: vi.fn(),
}));

vi.mock('../../../src/cli/services/config.js', () => ({
  buildCloudConfigFromFlags: vi.fn(),
  hasInlineCredentialEnv: vi.fn(() => false),
}));

vi.mock('../../../src/cli/services/non-interactive.js', () => ({
  getCredentialsNameFromEnv: vi.fn(() => undefined),
  getCredentialsFromEnv: vi.fn(),
}));

vi.mock('../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: (accessToken: string) => ({
    workloads: { list: api.listWorkloads },
    credentials: {
      list: () => api.listApiCredentials(accessToken),
    },
    quota: {
      status: ({ query }: { query: Record<string, string> }) =>
        api.getQuotaStatus(accessToken, {
          cloud: query.cloud,
          credentialName: query.credentialName,
          ...(query.region ? { region: query.region } : {}),
          ...(query.waitMs ? { waitMs: Number(query.waitMs) } : {}),
        }),
    },
  }),
}));

vi.mock('../../../src/shared/services/api-client/runtime.js', () => ({
  getAnycloudVersion: () => '0.0.0-test',
}));

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock(),
);

vi.mock('../../../src/cli/services/credentials.js', () => ({
  getCredentialCloudProvider: vi.fn(),
}));

vi.mock('../../../src/cli/services/target-picker.js', () => ({
  hasSpotComputeOfferings: vi.fn(),
  pickComputeTarget: vi.fn(),
}));

vi.mock('../../../src/shared/catalog/index.js', async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import('../../../src/shared/catalog/index.js')
    >();
  return {
    ...real,
    ensureCatalogsBootstrapped: vi.fn(async () => undefined),
  };
});

import {
  resolveWorkloadId,
  resolveWorkloadIds,
  resolveCloudConfig,
} from '../../../src/cli/commands/shared.js';
import {
  shouldAllowPrompts,
  safePrompts,
} from '../../../src/cli/utils/safe-prompts.js';
import {
  selectWorkload,
  selectWorkloads,
} from '../../../src/cli/utils/workload-picker.js';
import { printInfo, printWarning } from '../../../src/cli/utils/output.js';
import {
  buildCloudConfigFromFlags,
  hasInlineCredentialEnv,
} from '../../../src/cli/services/config.js';
import {
  getCredentialsNameFromEnv,
  getCredentialsFromEnv,
} from '../../../src/cli/services/non-interactive.js';
import { getCredentialCloudProvider } from '../../../src/cli/services/credentials.js';
import {
  hasSpotComputeOfferings,
  pickComputeTarget,
} from '../../../src/cli/services/target-picker.js';
import { ensureCatalogsBootstrapped } from '../../../src/shared/catalog/index.js';
import { makeStoredWorkload } from '../helpers/fixtures';
import { storageOnlyComputeMessage } from '../../../src/shared/providers.js';

const listWorkloads = api.listWorkloads;
const listApiCredentials = api.listApiCredentials;
const getQuotaStatus = api.getQuotaStatus;

function makeWorkload(id: string): StoredWorkload {
  return makeStoredWorkload({
    id,
    userId: 'user',
    workloadType: 'job',
    image: 'nginx:alpine',
    cloudProvider: CloudType.AWS,
    region: 'us-east-1',
    vmType: 't3.micro',
    spot: false,
    startedAt: Date.now(),
    completedAt: null,
    dockerCommand: '',
    inputBucket: null,
    outputBucket: null,
    diskSizeGb: null,
    dockerOptions: null,
    availabilityZone: null,
    env: null,
    githubToken: null,
    vmCount: 0,
    sshPrivateKey: '',
    credentialId: 'cred-1',
    gpuType: null,
    inputStorageCredentialId: null,
    inputStorageRegion: null,
    outputStorageCredentialId: null,
    outputStorageRegion: null,
    checkpointStorageCredentialId: null,
    checkpointStorageRegion: null,
    command: null,
    imageDigest: null,
    vmDurationMs: null,
    costSource: null,
    dnsRecordId: null,
    secretNames: null,
    session: null,
    agent: null,
    latestMessage: null,
    totalCost: null,
    state: WorkloadState.Running,
  });
}

describe('resolveWorkloadId', () => {
  const savedEnv = process.env.ANYCLOUD_WORKLOAD_ID;
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(() => {
    delete process.env.ANYCLOUD_WORKLOAD_ID;
    vi.clearAllMocks();
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.ANYCLOUD_WORKLOAD_ID;
    } else {
      process.env.ANYCLOUD_WORKLOAD_ID = savedEnv;
    }
    exitSpy.mockRestore();
  });

  it('returns explicit id arg without side effects', async () => {
    const id = await resolveWorkloadId('explicit-id');
    expect(id).toBe('explicit-id');
    expect(listWorkloads).not.toHaveBeenCalled();
    expect(selectWorkload).not.toHaveBeenCalled();
  });

  it('falls back to ANYCLOUD_WORKLOAD_ID env var', async () => {
    process.env.ANYCLOUD_WORKLOAD_ID = 'env-id';
    const id = await resolveWorkloadId(undefined);
    expect(id).toBe('env-id');
    expect(listWorkloads).not.toHaveBeenCalled();
  });

  it('errors in non-interactive mode with no id and no env', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(false);
    await expect(resolveWorkloadId(undefined)).rejects.toThrow(
      /Workload ID required/,
    );
  });

  it('uses picker when TTY + workloads exist', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    const dep = makeWorkload('picked-id');
    vi.mocked(listWorkloads).mockResolvedValue([dep]);
    vi.mocked(selectWorkload).mockResolvedValue(dep);
    const id = await resolveWorkloadId(undefined);
    expect(id).toBe('picked-id');
    // No -n given → the CLI sends no explicit limit; the server picks.
    const call = vi.mocked(listWorkloads).mock.calls[0]?.[0];
    expect(call?.query.limit).toBeUndefined();
  });

  it('forwards an explicit limit/sinceMs window to listWorkloads', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    const dep = makeWorkload('a');
    vi.mocked(listWorkloads).mockResolvedValue([dep]);
    vi.mocked(selectWorkload).mockResolvedValue(dep);
    await resolveWorkloadId(undefined, { limit: 500, sinceMs: 1000 });
    expect(listWorkloads).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ limit: '500', sinceMs: '1000' }),
      }),
    );
  });

  it('forwards stateClass to listWorkloads and shows what the server returns', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    const a = makeWorkload('keep-a');
    // The server already applied the stateClass filter; the CLI renders as-is.
    vi.mocked(listWorkloads).mockResolvedValue([a]);
    vi.mocked(selectWorkload).mockResolvedValue(a);
    await resolveWorkloadId(undefined, { stateClass: 'resubmittable' });
    expect(listWorkloads).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ stateClass: 'resubmittable' }),
      }),
    );
    expect(selectWorkload).toHaveBeenCalledWith([a]);
  });

  it('exits 0 when TTY but no workloads exist', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(listWorkloads).mockResolvedValue([]);
    await expect(resolveWorkloadId(undefined)).rejects.toThrow(
      'process.exit:0',
    );
    expect(selectWorkload).not.toHaveBeenCalled();
  });

  it('exits 0 when user cancels picker', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(listWorkloads).mockResolvedValue([makeWorkload('x')]);
    vi.mocked(selectWorkload).mockResolvedValue(undefined);
    await expect(resolveWorkloadId(undefined)).rejects.toThrow(
      'process.exit:0',
    );
  });
});

describe('resolveWorkloadIds', () => {
  const savedEnv = process.env.ANYCLOUD_WORKLOAD_ID;
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(() => {
    delete process.env.ANYCLOUD_WORKLOAD_ID;
    vi.clearAllMocks();
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.ANYCLOUD_WORKLOAD_ID;
    } else {
      process.env.ANYCLOUD_WORKLOAD_ID = savedEnv;
    }
    exitSpy.mockRestore();
  });

  it('returns explicit ids without side effects', async () => {
    const ids = await resolveWorkloadIds(['a', 'b']);
    expect(ids).toEqual(['a', 'b']);
    expect(listWorkloads).not.toHaveBeenCalled();
    expect(selectWorkloads).not.toHaveBeenCalled();
  });

  it('parses comma-separated ANYCLOUD_WORKLOAD_ID env var', async () => {
    process.env.ANYCLOUD_WORKLOAD_ID = ' a , b ,c ';
    const ids = await resolveWorkloadIds(undefined);
    expect(ids).toEqual(['a', 'b', 'c']);
    expect(listWorkloads).not.toHaveBeenCalled();
  });

  it('errors in non-interactive mode with no ids and no env', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(false);
    await expect(resolveWorkloadIds(undefined)).rejects.toThrow(
      /Workload ID required/,
    );
  });

  it('uses multi-select picker when TTY + workloads exist', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(listWorkloads).mockResolvedValue([makeWorkload('x')]);
    vi.mocked(selectWorkloads).mockResolvedValue(['x', 'y']);
    const ids = await resolveWorkloadIds(undefined);
    expect(ids).toEqual(['x', 'y']);
    // No -n → no explicit limit; the server picks (cap for a stateClass query).
    const call = vi.mocked(listWorkloads).mock.calls[0]?.[0];
    expect(call?.limit).toBeUndefined();
  });

  it('uses the custom noneMessage when the server returns an empty set', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(listWorkloads).mockResolvedValue([]);
    await expect(
      resolveWorkloadIds(undefined, {
        stateClass: 'terminatable',
        noneMessage: 'No workloads to terminate.',
      }),
    ).rejects.toThrow('process.exit:0');
    expect(printInfo).toHaveBeenCalledWith('No workloads to terminate.');
    expect(selectWorkloads).not.toHaveBeenCalled();
  });

  it('exits 0 when user cancels (empty selection)', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(listWorkloads).mockResolvedValue([makeWorkload('x')]);
    vi.mocked(selectWorkloads).mockResolvedValue(undefined);
    await expect(resolveWorkloadIds(undefined)).rejects.toThrow(
      'process.exit:0',
    );
  });

  it('prints cancelMessage when picker is cancelled', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(listWorkloads).mockResolvedValue([makeWorkload('x')]);
    vi.mocked(selectWorkloads).mockResolvedValue([]);
    await expect(
      resolveWorkloadIds(undefined, { cancelMessage: 'bye' }),
    ).rejects.toThrow('process.exit:0');
    expect(printInfo).toHaveBeenCalledWith('bye');
  });
});

describe('resolveCloudConfig', () => {
  beforeEach(() => {
    // Reset implementations, not just call history: mockResolvedValue /
    // mockRejectedValue set in one test (e.g. the spot-pricing prompt or a
    // rejected credential lookup) must not leak into later tests.
    vi.resetAllMocks();
    delete process.env.ANYCLOUD_CONFIG;
    vi.mocked(shouldAllowPrompts).mockReturnValue(false);
    vi.mocked(listApiCredentials).mockResolvedValue([]);
    vi.mocked(getQuotaStatus).mockResolvedValue({ entries: [] });
    vi.mocked(getCredentialsNameFromEnv).mockReturnValue(undefined);
    vi.mocked(hasInlineCredentialEnv).mockReturnValue(false);
    vi.mocked(pickComputeTarget).mockResolvedValue({
      kind: 'vmType',
      vmType: 't3.micro',
    });
    vi.mocked(hasSpotComputeOfferings).mockReturnValue(false);
    vi.mocked(buildCloudConfigFromFlags).mockResolvedValue({
      cloudConfig: {
        cloudProvider: CloudType.AWS,
        vmType: 't3.micro',
      },
      credentialName: 'my-aws',
    });
  });

  afterEach(() => {
    delete process.env.ANYCLOUD_CONFIG;
  });

  it('builds cloud config from inline flags', async () => {
    const resolved = await resolveCloudConfig({
      credentials: 'my-aws',
      vmType: ['t3.micro'],
    });
    expect(resolved.credentialName).toBe('my-aws');
    expect(getCredentialCloudProvider).toHaveBeenCalledWith('my-aws');
    expect(buildCloudConfigFromFlags).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: 'my-aws',
        vmType: 't3.micro',
      }),
    );
  });

  it('allows ANYCLOUD_CREDENTIALS_NAME with target flags', async () => {
    vi.mocked(getCredentialsNameFromEnv).mockReturnValue('cred-from-env');
    await resolveCloudConfig({ vmType: ['t3.micro'] });
    expect(getCredentialCloudProvider).toHaveBeenCalledWith('cred-from-env');
    expect(buildCloudConfigFromFlags).toHaveBeenCalledWith(
      expect.objectContaining({ vmType: 't3.micro' }),
    );
  });

  it('rejects removed ANYCLOUD_CONFIG', async () => {
    process.env.ANYCLOUD_CONFIG = 'prod';
    await expect(resolveCloudConfig({ vmType: ['t3.micro'] })).rejects.toThrow(
      /ANYCLOUD_CONFIG.*removed/i,
    );
    expect(buildCloudConfigFromFlags).not.toHaveBeenCalled();
  });

  it('lets a placementless request reach the API when no credential is configured', async () => {
    vi.mocked(buildCloudConfigFromFlags).mockResolvedValue({ cloudConfig: {} });

    await expect(resolveCloudConfig({})).resolves.toEqual({ cloudConfig: {} });

    expect(listApiCredentials).toHaveBeenCalledOnce();
    expect(pickComputeTarget).not.toHaveBeenCalled();
    expect(buildCloudConfigFromFlags).toHaveBeenCalledOnce();
    expect(
      vi.mocked(buildCloudConfigFromFlags).mock.calls[0]?.[0].credentials,
    ).toBeUndefined();
  });

  it('prompts for a credential on a TTY even when target flags are provided', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(listApiCredentials).mockResolvedValue([
      { name: 'aws-a', cloudProvider: CloudType.AWS },
      { name: 'aws-b', cloudProvider: CloudType.AWS },
    ] as Awaited<ReturnType<typeof listApiCredentials>>);
    vi.mocked(safePrompts).mockResolvedValue({ credential: 'aws-b' });

    await resolveCloudConfig({ vmType: ['t3.micro'] });

    expect(safePrompts).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Pick credentials' }),
    );
    expect(buildCloudConfigFromFlags).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: 'aws-b',
        vmType: 't3.micro',
      }),
    );
  });

  it('auto-selects the sole credential when target flags are provided', async () => {
    vi.mocked(listApiCredentials).mockResolvedValue([
      { name: 'aws-only', cloudProvider: CloudType.AWS },
    ] as Awaited<ReturnType<typeof listApiCredentials>>);

    await resolveCloudConfig({ vmType: ['t3.micro'] });

    expect(safePrompts).not.toHaveBeenCalled();
    expect(buildCloudConfigFromFlags).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: 'aws-only',
        vmType: 't3.micro',
      }),
    );
  });

  it('rejects ambiguous credentials in non-interactive use', async () => {
    vi.mocked(listApiCredentials).mockResolvedValue([
      { name: 'aws-a', cloudProvider: CloudType.AWS },
      { name: 'aws-b', cloudProvider: CloudType.AWS },
    ] as Awaited<ReturnType<typeof listApiCredentials>>);

    await expect(resolveCloudConfig({ vmType: ['t3.micro'] })).rejects.toThrow(
      /Pass --credentials/i,
    );

    expect(safePrompts).not.toHaveBeenCalled();
    expect(buildCloudConfigFromFlags).not.toHaveBeenCalled();
  });

  it('does not auto-select a saved storage-only Cloudflare credential as compute', async () => {
    vi.mocked(listApiCredentials).mockResolvedValue([
      {
        name: 'r2',
        cloudProvider: CloudType.Cloudflare,
        accountId: 'cf-account',
      },
    ]);
    vi.mocked(buildCloudConfigFromFlags).mockResolvedValue({ cloudConfig: {} });

    await expect(resolveCloudConfig({})).resolves.toEqual({ cloudConfig: {} });
    expect(getCredentialCloudProvider).not.toHaveBeenCalled();
  });

  it('refuses a named Cloudflare credential for compute', async () => {
    vi.mocked(getCredentialCloudProvider).mockResolvedValue(
      CloudType.Cloudflare,
    );
    await expect(
      resolveCloudConfig({ credentials: 'r2', vmType: ['t3.micro'] }),
    ).rejects.toThrow(storageOnlyComputeMessage(CloudType.Cloudflare));
    expect(buildCloudConfigFromFlags).not.toHaveBeenCalled();
  });

  it('requires vmType or gpuType for submit paths', async () => {
    vi.mocked(buildCloudConfigFromFlags).mockResolvedValue({
      cloudConfig: {
        cloudProvider: CloudType.AWS,
      },
      credentialName: 'my-aws',
    });
    await expect(resolveCloudConfig({ credentials: 'my-aws' })).rejects.toThrow(
      /vm-type.*gpu-type/i,
    );
  });

  it('allows missing target when build opts out', async () => {
    vi.mocked(buildCloudConfigFromFlags).mockResolvedValue({
      cloudConfig: {
        cloudProvider: CloudType.AWS,
      },
      credentialName: 'my-aws',
    });
    await expect(
      resolveCloudConfig({ credentials: 'my-aws' }, { requireTarget: false }),
    ).resolves.toMatchObject({ credentialName: 'my-aws' });
  });

  it('warns when a named credential pins region', async () => {
    vi.mocked(getCredentialCloudProvider).mockResolvedValue(CloudType.Azure);
    vi.mocked(buildCloudConfigFromFlags).mockResolvedValue({
      cloudConfig: {
        region: 'switzerlandnorth',
        vmType: 'Standard_NC96ads_A100_v4',
      },
      credentialName: 'my-azure',
    });
    await resolveCloudConfig({
      credentials: 'my-azure',
      region: 'switzerlandnorth',
      vmType: ['Standard_NC96ads_A100_v4'],
    });
    expect(printWarning).toHaveBeenCalledWith(
      expect.stringMatching(/Pinned region.*fail.*over/i),
    );
  });

  it('warns when the resolved config pins a failover-capable provider', async () => {
    vi.mocked(buildCloudConfigFromFlags).mockResolvedValue({
      cloudConfig: {
        cloudProvider: CloudType.AWS,
        region: 'us-east-1',
        vmType: 't3.micro',
      },
    });

    await resolveCloudConfig({
      region: 'us-east-1',
      vmType: ['t3.micro'],
    });

    expect(getCredentialCloudProvider).not.toHaveBeenCalled();
    expect(printWarning).toHaveBeenCalledWith(
      expect.stringMatching(/Pinned region.*fail.*over/i),
    );
  });

  it('does not warn when the provider cannot fail over across regions', async () => {
    vi.mocked(buildCloudConfigFromFlags).mockResolvedValue({
      cloudConfig: {
        cloudProvider: CloudType.Local,
        region: 'local',
        vmType: 'local',
      },
    });

    await resolveCloudConfig({ region: 'local', vmType: ['local'] });

    expect(printWarning).not.toHaveBeenCalled();
  });

  it('prompts for a compute target on a TTY when no vm/gpu type (named cred)', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(getCredentialCloudProvider).mockResolvedValue(CloudType.AWS);
    vi.mocked(pickComputeTarget).mockResolvedValue({
      kind: 'vmType',
      vmType: 'g6e.xlarge',
    });

    await resolveCloudConfig({ credentials: 'my-aws' });

    expect(pickComputeTarget).toHaveBeenCalledWith(
      CloudType.AWS,
      expect.objectContaining({ allowGpuTypes: true }),
    );
    expect(buildCloudConfigFromFlags).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: 'my-aws', vmType: 'g6e.xlarge' }),
    );
  });

  it('passes an interactive GPU alias selection without setting vmType', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(getCredentialCloudProvider).mockResolvedValue(CloudType.AWS);
    vi.mocked(pickComputeTarget).mockResolvedValue({
      kind: 'gpuType',
      gpuType: 'h100:8',
    });

    await resolveCloudConfig({ credentials: 'my-aws' });

    expect(pickComputeTarget).toHaveBeenCalledWith(
      CloudType.AWS,
      expect.objectContaining({ allowGpuTypes: true }),
    );
    expect(buildCloudConfigFromFlags).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: 'my-aws',
        gpuType: 'h100:8',
        vmType: undefined,
      }),
    );
  });

  it('loads quick quota hints for the interactive target picker with saved credentials', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(getCredentialCloudProvider).mockResolvedValue(CloudType.AWS);
    vi.mocked(getQuotaStatus).mockResolvedValue({
      entries: [
        {
          kind: 'current',
          cloud: CloudType.AWS,
          region: 'us-east-1',
          resourceName: 'Running On-Demand Standard instances',
          status: 'CURRENT',
          currentLimit: 2,
        },
      ],
    });
    vi.mocked(pickComputeTarget).mockResolvedValue({
      kind: 'vmType',
      vmType: 't3.large',
    });

    await resolveCloudConfig({ credentials: 'my-aws' });

    expect(getQuotaStatus).toHaveBeenCalledWith('test-token', {
      cloud: CloudType.AWS,
      credentialName: 'my-aws',
      waitMs: 3000,
    });
    expect(pickComputeTarget).toHaveBeenCalledWith(
      CloudType.AWS,
      expect.objectContaining({
        quota: expect.objectContaining({ label: 'on-demand quota limit' }),
      }),
    );
  });

  it('limits quick quota hints to the pinned compute region', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(getCredentialCloudProvider).mockResolvedValue(CloudType.AWS);
    vi.mocked(getQuotaStatus).mockResolvedValue({
      entries: [
        {
          kind: 'current',
          cloud: CloudType.AWS,
          region: 'us-east-1',
          resourceName: 'Running On-Demand Standard instances',
          status: 'CURRENT',
          currentLimit: 2,
        },
      ],
    });
    vi.mocked(pickComputeTarget).mockResolvedValue({
      kind: 'vmType',
      vmType: 't3.large',
    });

    await resolveCloudConfig({
      credentials: 'my-aws',
      region: 'us-west-2',
    });

    const pickerOptions = vi.mocked(pickComputeTarget).mock.calls[0]?.[1] as
      | {
          quota?: {
            regionsForVmType: (vmType: string) => string[];
          };
        }
      | undefined;
    expect(pickerOptions?.quota?.regionsForVmType('t3.large')).toEqual([]);
  });

  it('warns and falls back to the normal target picker when quick quota lookup fails', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(getCredentialCloudProvider).mockResolvedValue(CloudType.AWS);
    vi.mocked(getQuotaStatus).mockRejectedValue(new Error('offline'));
    vi.mocked(pickComputeTarget).mockResolvedValue({
      kind: 'vmType',
      vmType: 't3.large',
    });

    await resolveCloudConfig({ credentials: 'my-aws' });

    expect(spinnerWarn).toHaveBeenCalledWith(expect.stringContaining('quota'));
    expect(pickComputeTarget).toHaveBeenCalledWith(
      CloudType.AWS,
      expect.objectContaining({ allowGpuTypes: true }),
    );
  });

  it('warns and falls back when the quota status read times out (empty entries)', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(getCredentialCloudProvider).mockResolvedValue(CloudType.AWS);
    // The server fail-opens to an empty list when the provider read doesn't
    // finish in time; a healthy read always returns per-region limits.
    vi.mocked(getQuotaStatus).mockResolvedValue({ entries: [] });
    vi.mocked(pickComputeTarget).mockResolvedValue({
      kind: 'vmType',
      vmType: 't3.large',
    });

    await resolveCloudConfig({ credentials: 'my-aws' });

    expect(spinnerWarn).toHaveBeenCalledWith(expect.stringContaining('quota'));
    expect(pickComputeTarget).toHaveBeenCalledWith(
      CloudType.AWS,
      expect.objectContaining({ allowGpuTypes: true }),
    );
  });

  it('prompts for credentials and target on a bare interactive config', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(listApiCredentials).mockResolvedValue([
      { name: 'aws-a', cloudProvider: CloudType.AWS },
      { name: 'aws-b', cloudProvider: CloudType.AWS },
    ] as Awaited<ReturnType<typeof listApiCredentials>>);
    vi.mocked(safePrompts).mockResolvedValue({ credential: 'aws-b' });
    vi.mocked(pickComputeTarget).mockResolvedValue({
      kind: 'vmType',
      vmType: 'g6e.xlarge',
    });

    await resolveCloudConfig({});

    expect(safePrompts).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Pick credentials' }),
    );
    expect(pickComputeTarget).toHaveBeenCalledWith(
      CloudType.AWS,
      expect.objectContaining({ allowGpuTypes: true }),
    );
    expect(buildCloudConfigFromFlags).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: 'aws-b',
        vmType: 'g6e.xlarge',
      }),
    );
  });

  it('auto-selects the sole saved credential before the bare interactive target picker', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(listApiCredentials).mockResolvedValue([
      { name: 'aws-only', cloudProvider: CloudType.AWS },
    ] as Awaited<ReturnType<typeof listApiCredentials>>);
    vi.mocked(pickComputeTarget).mockResolvedValue({
      kind: 'vmType',
      vmType: 'g6e.xlarge',
    });

    await resolveCloudConfig({});

    expect(safePrompts).not.toHaveBeenCalled();
    expect(pickComputeTarget).toHaveBeenCalledWith(
      CloudType.AWS,
      expect.objectContaining({ allowGpuTypes: true }),
    );
    expect(buildCloudConfigFromFlags).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: 'aws-only',
        vmType: 'g6e.xlarge',
      }),
    );
  });

  it('does not invent a credential or target on a bare interactive config with no saved credentials', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(buildCloudConfigFromFlags).mockResolvedValue({ cloudConfig: {} });

    await expect(resolveCloudConfig({})).resolves.toEqual({ cloudConfig: {} });

    expect(listApiCredentials).toHaveBeenCalledOnce();
    expect(safePrompts).not.toHaveBeenCalled();
    expect(pickComputeTarget).not.toHaveBeenCalled();
    expect(buildCloudConfigFromFlags).toHaveBeenCalledOnce();
  });

  it('resolves cloud from inline provider env for the target picker', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(hasInlineCredentialEnv).mockReturnValue(true);
    const envCreds: CloudCredentials = {
      cloudProvider: CloudType.AWS,
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
    };
    vi.mocked(getCredentialsFromEnv).mockReturnValue(envCreds);
    vi.mocked(pickComputeTarget).mockResolvedValue({
      kind: 'vmType',
      vmType: 't3.large',
    });

    await resolveCloudConfig({});

    expect(pickComputeTarget).toHaveBeenCalledWith(
      CloudType.AWS,
      expect.objectContaining({ allowGpuTypes: true }),
    );
    expect(getQuotaStatus).not.toHaveBeenCalled();
  });

  it('prompts on-demand vs spot when spot is available', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(getCredentialCloudProvider).mockResolvedValue(CloudType.AWS);
    vi.mocked(hasSpotComputeOfferings).mockReturnValue(true);
    vi.mocked(pickComputeTarget).mockResolvedValue({
      kind: 'vmType',
      vmType: 'p5.48xlarge',
    });
    vi.mocked(safePrompts).mockResolvedValue({ pricing: 'spot' });

    await resolveCloudConfig({ credentials: 'my-aws' });

    expect(safePrompts).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Pricing model' }),
    );
    expect(buildCloudConfigFromFlags).toHaveBeenCalledWith(
      expect.objectContaining({ spot: true }),
    );
    expect(pickComputeTarget).toHaveBeenCalledWith(
      CloudType.AWS,
      expect.objectContaining({ spotOnly: true }),
    );
  });

  it('uses spot quota hints when spot pricing is selected before the target picker', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(getCredentialCloudProvider).mockResolvedValue(CloudType.AWS);
    vi.mocked(hasSpotComputeOfferings).mockReturnValue(true);
    vi.mocked(safePrompts).mockResolvedValue({ pricing: 'spot' });
    vi.mocked(getQuotaStatus).mockResolvedValue({
      entries: [
        {
          kind: 'current',
          cloud: CloudType.AWS,
          region: 'us-east-1',
          resourceName: 'All Standard Spot Instance Requests',
          status: 'CURRENT',
          currentLimit: 2,
        },
      ],
    });
    vi.mocked(pickComputeTarget).mockResolvedValue({
      kind: 'vmType',
      vmType: 't3.large',
    });

    await resolveCloudConfig({ credentials: 'my-aws' });

    expect(pickComputeTarget).toHaveBeenCalledWith(
      CloudType.AWS,
      expect.objectContaining({
        spotOnly: true,
        quota: expect.objectContaining({ label: 'spot quota limit' }),
      }),
    );
  });

  it('skips the spot prompt when spot prompting is disabled', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(getCredentialCloudProvider).mockResolvedValue(CloudType.AWS);
    vi.mocked(pickComputeTarget).mockResolvedValue({
      kind: 'vmType',
      vmType: 'p5.48xlarge',
    });

    await resolveCloudConfig(
      { credentials: 'my-aws' },
      { allowSpotPrompt: false },
    );

    expect(pickComputeTarget).toHaveBeenCalledWith(
      CloudType.AWS,
      expect.objectContaining({ allowGpuTypes: true }),
    );
    expect(safePrompts).not.toHaveBeenCalled();
    expect(buildCloudConfigFromFlags).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: 'my-aws',
        vmType: 'p5.48xlarge',
      }),
    );
    expect(vi.mocked(buildCloudConfigFromFlags).mock.calls[0][0].spot).toBe(
      undefined,
    );
  });

  it('skips the spot prompt for a bare interactive target when spot prompting is disabled', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(listApiCredentials).mockResolvedValue([
      { name: 'my-aws', cloudProvider: CloudType.AWS },
    ] as Awaited<ReturnType<typeof listApiCredentials>>);
    vi.mocked(pickComputeTarget).mockResolvedValue({
      kind: 'vmType',
      vmType: 'p5.48xlarge',
    });

    await resolveCloudConfig({}, { allowSpotPrompt: false });

    expect(pickComputeTarget).toHaveBeenCalledWith(
      CloudType.AWS,
      expect.objectContaining({ allowGpuTypes: true }),
    );
    expect(safePrompts).not.toHaveBeenCalled();
    expect(buildCloudConfigFromFlags).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: 'my-aws',
        vmType: 'p5.48xlarge',
      }),
    );
    expect(vi.mocked(buildCloudConfigFromFlags).mock.calls[0][0].spot).toBe(
      undefined,
    );
  });

  it('skips the Lambda spot prompt without checkpoint storage flags', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(getCredentialCloudProvider).mockResolvedValue(CloudType.Lambda);
    vi.mocked(pickComputeTarget).mockResolvedValue({
      kind: 'vmType',
      vmType: 'gpu_1x_a100',
    });

    await resolveCloudConfig({ credentials: 'my-lambda' });

    expect(safePrompts).not.toHaveBeenCalled();
    expect(buildCloudConfigFromFlags).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: 'my-lambda',
        vmType: 'gpu_1x_a100',
      }),
    );
    expect(vi.mocked(buildCloudConfigFromFlags).mock.calls[0][0].spot).toBe(
      undefined,
    );
  });

  it('prompts for Lambda spot when checkpoint storage flags are present', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(getCredentialCloudProvider).mockResolvedValue(CloudType.Lambda);
    vi.mocked(hasSpotComputeOfferings).mockReturnValue(true);
    vi.mocked(pickComputeTarget).mockResolvedValue({
      kind: 'vmType',
      vmType: 'gpu_1x_a100',
    });
    vi.mocked(safePrompts).mockResolvedValue({ pricing: 'spot' });

    await resolveCloudConfig({
      credentials: 'my-lambda',
      checkpointStorageCredentials: 'ckpt-aws',
      checkpointStorageRegion: 'us-east-1',
    });

    expect(safePrompts).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Pricing model' }),
    );
    expect(buildCloudConfigFromFlags).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointStorageCredentials: 'ckpt-aws',
        checkpointStorageRegion: 'us-east-1',
        spot: true,
      }),
    );
  });

  it('does not prompt for spot when --spot is already passed', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(getCredentialCloudProvider).mockResolvedValue(CloudType.AWS);
    vi.mocked(pickComputeTarget).mockResolvedValue({
      kind: 'vmType',
      vmType: 'p5.48xlarge',
    });

    await resolveCloudConfig({ credentials: 'my-aws', spot: true });

    expect(safePrompts).not.toHaveBeenCalled();
    expect(pickComputeTarget).toHaveBeenCalledWith(
      CloudType.AWS,
      expect.objectContaining({ spotOnly: true }),
    );
  });

  it('does not run the compute picker when --gpu-type is passed', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);

    await resolveCloudConfig({ credentials: 'my-aws', gpuType: ['h100'] });

    expect(pickComputeTarget).not.toHaveBeenCalled();
  });

  it('errors cleanly (no picker) on a TTY when --credentials names an unknown cred', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(getCredentialCloudProvider).mockRejectedValue(
      new Error('Credential "bogus" not found.'),
    );
    await expect(resolveCloudConfig({ credentials: 'bogus' })).rejects.toThrow(
      /Credential "bogus" not found/i,
    );
    expect(pickComputeTarget).not.toHaveBeenCalled();
  });

  it('errors cleanly (no picker) on a TTY when catalog bootstrap fails', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(getCredentialCloudProvider).mockResolvedValue(CloudType.AWS);
    vi.mocked(ensureCatalogsBootstrapped).mockRejectedValueOnce(
      new Error('offline'),
    );
    await expect(resolveCloudConfig({ credentials: 'my-aws' })).rejects.toThrow(
      /vm-type.*gpu-type/i,
    );
    expect(pickComputeTarget).not.toHaveBeenCalled();
  });

  it('preserves ordered target choices after auto-selecting a credential', async () => {
    vi.mocked(listApiCredentials).mockResolvedValue([
      { name: 'aws-only', cloudProvider: CloudType.AWS },
    ] as Awaited<ReturnType<typeof listApiCredentials>>);

    await resolveCloudConfig({
      vmType: ['t3.small', 'e2-standard-2'],
    });

    expect(pickComputeTarget).not.toHaveBeenCalled();
    expect(buildCloudConfigFromFlags).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: 'aws-only',
        vmType: ['t3.small', 'e2-standard-2'],
      }),
    );
  });

  it('uses the selected credential cloud for the target picker', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(getCredentialCloudProvider).mockResolvedValue(CloudType.AWS);
    vi.mocked(pickComputeTarget).mockResolvedValue({
      kind: 'vmType',
      vmType: 't3.large',
    });

    await resolveCloudConfig({ credentials: 'aws-1' });

    expect(pickComputeTarget).toHaveBeenCalledWith(
      CloudType.AWS,
      expect.objectContaining({ allowGpuTypes: true }),
    );
  });
});
