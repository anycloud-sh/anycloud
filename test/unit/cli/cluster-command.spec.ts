import { Command } from 'commander';
import { ORPCError } from '@orpc/client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { WorkloadState } from '../../../src/shared/workload.js';

const mocks = vi.hoisted(() => ({
  createApiClient: vi.fn(),
  createCluster: vi.fn(),
  getCluster: vi.fn(),
  listClusters: vi.fn(),
  printError: vi.fn(),
  printInfo: vi.fn(),
  printSuccess: vi.fn(),
  apiBearer: vi.fn(),
  resolveOptionalNamedCredential: vi.fn(),
  setJsonMode: vi.fn(),
  shouldAllowPrompts: vi.fn(),
  safePrompts: vi.fn(),
  printWarning: vi.fn(),
  bootstrapCatalogsWithUI: vi.fn(),
  pickVmTypeTarget: vi.fn(),
  pickRegion: vi.fn(),
  getRegionsForVMType: vi.fn(),
  runSeedCreate: vi.fn(),
  seedFor: vi.fn(),
  discoverAccount: vi.fn(),
  gitHubUser: vi.fn(),
}));

vi.mock('../../../src/shared/services/api-client/rpc.js', async (actual) => ({
  ...(await actual<
    typeof import('../../../src/shared/services/api-client/rpc.js')
  >()),
  createApiClient: mocks.createApiClient,
}));

vi.mock('../../../src/cli/services/auth.js', async () => ({
  ...(await import('./cli-auth-mock.js')).cliAuthMock(() => mocks.apiBearer()),
  getGitHubToken: async () => 'gh-token',
}));

vi.mock('../../../src/cli/services/oauth.js', () => ({
  gitHubUser: mocks.gitHubUser,
}));

vi.mock('../../../src/cli/seed/create.js', async (actual) => ({
  ...(await actual<typeof import('../../../src/cli/seed/create.js')>()),
  runSeedCreate: mocks.runSeedCreate,
}));

vi.mock('../../../src/cli/seed/registry.js', () => ({
  seedFor: mocks.seedFor,
}));

vi.mock('../../../src/cli/commands/shared.js', () => ({
  resolveOptionalNamedCredential: mocks.resolveOptionalNamedCredential,
}));

vi.mock('../../../src/cli/utils/safe-prompts.js', () => ({
  shouldAllowPrompts: mocks.shouldAllowPrompts,
  safePrompts: mocks.safePrompts,
}));

vi.mock('../../../src/cli/utils/catalog-bootstrap.js', () => ({
  bootstrapCatalogsWithUI: mocks.bootstrapCatalogsWithUI,
}));

vi.mock('../../../src/cli/services/target-picker.js', () => ({
  pickVmTypeTarget: mocks.pickVmTypeTarget,
  pickRegion: mocks.pickRegion,
}));

vi.mock('../../../src/shared/cloud-config.js', () => ({
  getRegionsForVMType: mocks.getRegionsForVMType,
}));

vi.mock('../../../src/cli/utils/output.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../src/cli/utils/output.js')
  >()),
  printError: mocks.printError,
  printInfo: mocks.printInfo,
  printSuccess: mocks.printSuccess,
  printWarning: mocks.printWarning,
  setJsonMode: mocks.setJsonMode,
}));

import {
  createApiCreateCommand,
  createClusterCommand,
} from '../../../src/cli/commands/cluster.js';
import { createApiDeleteCommand } from '../../../src/cli/commands/cluster-delete.js';
import { SeedCreateError } from '../../../src/cli/seed/create.js';
import { SeedUnavailableError } from '../../../src/cli/seed/types.js';

const recorded = {
  id: 'install-production-1',
  name: 'production',
  state: WorkloadState.Provisioning,
  releasing: false,
  cloudProvider: 'AWS',
  region: 'us-east-1',
  zone: null,
  vmType: 't3.medium',
  k3sVersion: 'v1.35.5+k3s1',
  apiVersion: '0.1.64',
  apiImage: `ghcr.io/anycloud-sh/api:0.1.64@sha256:${'a'.repeat(64)}`,
  chartVersion: '0.1.0',
  connected: false,
  kubernetesIdentity: null,
  connectionRevision: 1,
  activeNodePoolCount: 0,
  address: null,
  managementApiUrl: null,
  release: null,
  checkpointBucket: { name: 'install-production-1', managed: true },
  lastError: null,
  createdAt: 1,
  updatedAt: 1,
};
const ready = {
  ...recorded,
  state: WorkloadState.Running,
  connected: true,
  kubernetesIdentity: 'uid-production',
  connectionRevision: 2,
  activeNodePoolCount: 2,
  address: '203.0.113.1',
  managementApiUrl: 'https://install-production-1.anycloud.sh',
  release: {
    apiVersion: '0.1.64',
    apiImage: recorded.apiImage,
    chartVersion: '0.1.0',
  },
};
/** The hosted API's own record: no creation facts, only what it knows of itself. */
const hostedRecord = {
  ...ready,
  cloudProvider: null,
  region: null,
  vmType: null,
  k3sVersion: null,
  apiVersion: '0.1.65',
  apiImage: null,
  chartVersion: null,
  address: '198.51.100.9',
  release: null,
};

/** The `status` field lines on stdout, as `Label: value`. */
function printedFields(spy: MockInstance<typeof console.log>): string[] {
  return spy.mock.calls.map((call) =>
    String(call[0])
      .trim()
      .replace(/\s{2,}/u, ': '),
  );
}

/** `create` and `delete` (with its aliases) are `api` subcommands; the rest are `cluster`'s. */
async function runCluster(argv: string[]): Promise<void> {
  const command = new Command('anycloud').exitOverride();
  for (const sub of [
    createApiCreateCommand(),
    createApiDeleteCommand(),
    ...createClusterCommand().commands,
  ])
    command.addCommand(sub.exitOverride());
  await command.parseAsync(argv, { from: 'user' });
}

const createArgs = [
  'create',
  'production',
  '--cloud',
  'aws',
  '--region',
  'us-east-1',
  '--vm-type',
  't3.medium',
];

describe('cluster command', () => {
  let exitSpy: MockInstance<typeof process.exit>;
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiBearer.mockResolvedValue('access-token');
    mocks.shouldAllowPrompts.mockReturnValue(true);
    mocks.resolveOptionalNamedCredential.mockResolvedValue({
      name: 'aws-compute',
      cloudProvider: 'AWS',
    });
    mocks.pickVmTypeTarget.mockResolvedValue({
      kind: 'vmType',
      vmType: 't3.large',
    });
    mocks.getRegionsForVMType.mockReturnValue(['us-east-2', 'us-west-2']);
    mocks.pickRegion.mockResolvedValue('us-west-2');
    mocks.seedFor.mockImplementation((cloud: string) => ({
      cloud,
      discoverAccount: () => mocks.discoverAccount(cloud),
    }));
    mocks.discoverAccount.mockImplementation(async (cloud: string) => {
      if (cloud !== 'aws') throw new Error(`${cloud} isn't signed in`);
      return { account: '123456789012', principal: 'ops' };
    });
    mocks.gitHubUser.mockResolvedValue({ id: '4242', username: 'owner' });
    mocks.runSeedCreate.mockResolvedValue(ready);
    mocks.createApiClient.mockReturnValue({
      clusters: {
        create: mocks.createCluster,
        get: mocks.getCluster,
        list: mocks.listClusters,
      },
    });
    mocks.createCluster.mockResolvedValue({ cluster: recorded });
    mocks.getCluster.mockResolvedValue({ cluster: ready });
    mocks.listClusters.mockResolvedValue({ clusters: [ready] });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit:${code ?? 0}`);
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('offers list and status under cluster, create and delete under api (forget is delete --skip-cloud); delete keeps terminate and rm, list keeps ls', async () => {
    const commands = createClusterCommand().commands;
    expect(
      Object.fromEntries(
        commands.map((command) => [command.name(), command.aliases()]),
      ),
    ).toEqual({ list: ['ls', 'get'], status: ['describe'] });
    expect(createApiCreateCommand().aliases()).toEqual([]);
    expect(createApiDeleteCommand().aliases()).toEqual(['terminate', 'rm']);
    for (const argv of [
      ['bootstrap', 'production'],
      ['installations'],
      ['register', 'production', '--kubeconfig', '/dev/null'],
    ]) {
      await expect(runCluster(argv)).rejects.toThrow(/unknown command/);
    }
  });

  it("creates through the cloud's own CLI and returns once the API runs, naming the next step", async () => {
    await runCluster([
      ...createArgs,
      '--zone',
      'us-east-1a',
      '--checkpoint-bucket',
      'my-api-state',
    ]);
    expect(mocks.seedFor).toHaveBeenCalledWith('aws');
    expect(mocks.runSeedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        seed: expect.objectContaining({ cloud: 'aws' }),
        name: 'production',
        region: 'us-east-1',
        zone: 'us-east-1a',
        vmType: 't3.medium',
        checkpointBucket: 'my-api-state',
        githubToken: 'gh-token',
        owner: { id: '4242', username: 'owner' },
      }),
    );
    expect(mocks.printSuccess).toHaveBeenCalledWith(
      'Cluster production is running.',
    );
    expect(mocks.printInfo).toHaveBeenCalledWith(
      'Next: anycloud api use https://install-production-1.anycloud.sh',
    );

    // Without --checkpoint-bucket the seed makes a managed one.
    await runCluster(createArgs);
    expect(mocks.runSeedCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ checkpointBucket: null, zone: null }),
    );
  });

  it('watches the cluster through its Workload states to running, then names the next step', async () => {
    mocks.getCluster
      .mockResolvedValueOnce({ cluster: recorded })
      .mockResolvedValueOnce({ cluster: ready });
    await runCluster(['status', 'production', '--watch', '--interval', '1']);
    const printed = mocks.printInfo.mock.calls.map((call) => String(call[0]));
    expect(printed.filter((line) => /^\[.+\] /u.test(line))).toEqual([
      expect.stringMatching(/\] provisioning$/u),
      expect.stringMatching(/\] running$/u),
    ]);
    expect(printedFields(logSpy)).toContain(
      'URL: https://install-production-1.anycloud.sh',
    );
    expect(printed).toContain(
      'Next: anycloud api use https://install-production-1.anycloud.sh',
    );

    mocks.getCluster.mockResolvedValue({
      cluster: {
        ...recorded,
        state: WorkloadState.Failed,
        lastError: 'Management Kubernetes did not become ready in time',
      },
    });
    logSpy.mockClear();
    await runCluster(['status', 'production', '--watch']);
    expect(printedFields(logSpy)).toContain(
      'Last error: Management Kubernetes did not become ready in time',
    );
    expect(mocks.printInfo).toHaveBeenCalledWith(
      'Resume with: anycloud api create production ..., or remove it with: anycloud api delete production',
    );

    // A failed delete is also `failed`; its error says so, and so does the hint.
    mocks.getCluster.mockResolvedValue({
      cluster: {
        ...ready,
        state: WorkloadState.Failed,
        lastError: 'Delete failed: Management VM release was not confirmed',
      },
    });
    await runCluster(['status', 'production']);
    expect(mocks.printInfo).toHaveBeenLastCalledWith(
      'Finish it with: anycloud api delete production',
    );
  });

  it('prints one JSON document per read under status --watch --json', async () => {
    mocks.getCluster
      .mockResolvedValueOnce({ cluster: recorded })
      .mockResolvedValueOnce({ cluster: ready });
    await runCluster([
      'status',
      'production',
      '--watch',
      '--interval',
      '1',
      '--json',
    ]);
    expect(logSpy.mock.calls.map((call) => call[0])).toEqual([
      JSON.stringify(recorded),
      JSON.stringify(ready),
    ]);
    expect(mocks.printInfo).not.toHaveBeenCalled();
  });

  it('asks only for what the flags leave out, in a terminal, offering the clouds whose CLI is signed in', async () => {
    // Only aws is signed in: no question.
    await runCluster(['create', 'production']);
    expect(mocks.safePrompts).not.toHaveBeenCalled();
    expect(mocks.pickVmTypeTarget).toHaveBeenCalledWith('AWS');
    expect(
      mocks.bootstrapCatalogsWithUI.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.pickVmTypeTarget.mock.invocationCallOrder[0]);
    // Only regions that offer the picked VM type are offered.
    expect(mocks.getRegionsForVMType).toHaveBeenCalledWith('t3.large', 'AWS');
    expect(mocks.pickRegion).toHaveBeenCalledWith(['us-east-2', 'us-west-2']);
    expect(mocks.runSeedCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ region: 'us-west-2', vmType: 't3.large' }),
    );

    // Several signed in: only they are offered.
    mocks.discoverAccount.mockResolvedValue({ account: 'a', principal: 'p' });
    mocks.safePrompts.mockResolvedValue({ cloud: 'gcp' });
    await runCluster(['create', 'production', '--region', 'us-central1']);
    expect(mocks.safePrompts.mock.lastCall?.[0]).toMatchObject({
      choices: [
        { title: 'aws', value: 'aws' },
        { title: 'gcp', value: 'gcp' },
        { title: 'azure', value: 'azure' },
      ],
    });
    expect(mocks.pickVmTypeTarget).toHaveBeenLastCalledWith('GCP');
    expect(mocks.seedFor).toHaveBeenLastCalledWith('gcp');

    // A cloud this build has no seed for is left out, not fatal.
    const registered = mocks.seedFor.getMockImplementation()!;
    mocks.seedFor.mockImplementation((cloud: string) => {
      if (cloud === 'azure') throw new Error("isn't available in this build");
      return registered(cloud);
    });
    await runCluster(['create', 'production', '--region', 'us-central1']);
    expect(mocks.safePrompts.mock.lastCall?.[0]).toMatchObject({
      choices: [
        { title: 'aws', value: 'aws' },
        { title: 'gcp', value: 'gcp' },
      ],
    });
    mocks.seedFor.mockImplementation(registered);

    // None signed in: refused before any pick.
    vi.clearAllMocks();
    mocks.discoverAccount.mockRejectedValue(new Error('signed out'));
    await expect(runCluster(['create', 'production'])).rejects.toThrow(
      'process.exit:1',
    );
    expect(String(mocks.printError.mock.lastCall?.[0])).toContain(
      'No aws, gcloud or az on this machine is signed in',
    );
    expect(mocks.pickVmTypeTarget).not.toHaveBeenCalled();
  });

  it('names the missing flags without a terminal or under --json, exiting 2 with nothing done', async () => {
    await expect(
      runCluster([...createArgs.slice(0, 4), '--zone', 'us-east-1a']),
    ).rejects.toThrow('process.exit:2');
    expect(mocks.printError).toHaveBeenLastCalledWith(
      'Failed to create cluster: --zone requires --region',
    );

    mocks.shouldAllowPrompts.mockReturnValue(false);
    await expect(runCluster(['create', 'production'])).rejects.toThrow(
      'process.exit:2',
    );
    expect(mocks.printError).toHaveBeenLastCalledWith(
      'Failed to create cluster: pass --cloud aws|gcp|azure, or run in a terminal to pick it',
    );
    await expect(
      runCluster([...createArgs.slice(0, 4), '--region', 'us-east-1']),
    ).rejects.toThrow('process.exit:2');
    expect(mocks.printError).toHaveBeenLastCalledWith(
      'Failed to create cluster: pass --vm-type, or run in a terminal to pick it',
    );
    await expect(
      runCluster(['create', 'production', '--cloud', 'lambda']),
    ).rejects.toThrow('process.exit:2');
    expect(mocks.printError).toHaveBeenLastCalledWith(
      'Failed to create cluster: --cloud must be aws, gcp or azure',
    );
    await expect(
      runCluster(['create', 'x'.repeat(65), '--cloud', 'aws']),
    ).rejects.toThrow('process.exit:2');

    // Under --json the usage error is the one document.
    mocks.printError.mockClear();
    logSpy.mockClear();
    await expect(
      runCluster([
        ...createArgs.slice(0, 4),
        '--region',
        'us-east-1',
        '--json',
      ]),
    ).rejects.toThrow('process.exit:2');
    expect(
      logSpy.mock.calls.map((call) => JSON.parse(String(call[0]))),
    ).toEqual([
      {
        error: {
          code: 'INVALID_ARGUMENT',
          message: 'pass --vm-type, or run in a terminal to pick it',
        },
      },
    ]);

    mocks.shouldAllowPrompts.mockReturnValue(true);
    mocks.getRegionsForVMType.mockReturnValue([]);
    await expect(runCluster(createArgs.slice(0, 4))).rejects.toThrow(
      'process.exit:2',
    );
    expect(mocks.printError).toHaveBeenLastCalledWith(
      'Failed to create cluster: no aws region in the catalog offers t3.large; pass --region',
    );
    expect(mocks.runSeedCreate).not.toHaveBeenCalled();
  });

  it('lists clusters, including the hosted API record without creation facts, and shows status', async () => {
    mocks.listClusters.mockResolvedValue({ clusters: [ready, hostedRecord] });
    await runCluster(['list']);
    expect(mocks.listClusters).toHaveBeenCalledWith();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('203.0.113.1'));
    const table = String(logSpy.mock.lastCall?.[0]);
    expect(table).toMatch(/production[^\n]*198\.51\.100\.9[^\n]*0\.1\.65/);
    expect(table).not.toContain('this API');

    await runCluster(['ls']);
    expect(mocks.listClusters).toHaveBeenCalledTimes(2);

    mocks.getCluster.mockResolvedValue({ cluster: hostedRecord });
    logSpy.mockClear();
    await runCluster(['status', 'production']);
    expect(mocks.getCluster).toHaveBeenCalledWith({
      params: { id: 'production' },
    });
    const printed = printedFields(logSpy);
    // The Workload status layout: an emoji + state header, then fields.
    expect(printed).toContain('⚡: running');
    expect(printed).toContain('Address: 198.51.100.9');
    expect(printed).toContain('API: 0.1.65');
    expect(printed).toContain('URL: https://install-production-1.anycloud.sh');
    expect(printed.some((line) => line.startsWith('Cloud:'))).toBe(false);
    // Internal bookkeeping stays out of human output.
    for (const internal of [
      'Completed step',
      'Kubernetes identity',
      'Connection revision',
      'Chart',
      'Release',
    ]) {
      expect(printed.some((line) => line.startsWith(internal))).toBe(false);
    }

    // An installer cluster's apiVersion is only planned until its release.
    logSpy.mockClear();
    mocks.listClusters.mockResolvedValue({ clusters: [recorded] });
    await runCluster(['list']);
    expect(String(logSpy.mock.lastCall?.[0])).not.toContain('0.1.64');
    logSpy.mockClear();
    mocks.getCluster.mockResolvedValue({ cluster: recorded });
    await runCluster(['status', 'production']);
    expect(printedFields(logSpy).some((line) => line.startsWith('API:'))).toBe(
      false,
    );

    // A hosted record with the cluster record (RFC 0049 C26 (a)) shows its
    // cloud, account and VM type, and still its own API version.
    logSpy.mockClear();
    mocks.getCluster.mockResolvedValue({
      cluster: {
        ...hostedRecord,
        cloudProvider: 'GCP',
        cloudAccount: 'my-project',
        region: 'us-central1',
        zone: 'us-central1-a',
        vmType: 'e2-standard-2',
      },
    });
    await runCluster(['status', 'production']);
    expect(printedFields(logSpy)).toEqual(
      expect.arrayContaining([
        'Cloud: GCP / us-central1 (zone us-central1-a)',
        'Account: my-project',
        'VM: e2-standard-2',
        'API: 0.1.65',
      ]),
    );
  });

  it('emits machine-readable JSON', async () => {
    await runCluster(['status', 'production', '--json']);
    expect(mocks.setJsonMode).toHaveBeenCalledWith(true);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(ready));
  });

  it('keeps stdout to the single JSON document under --json: progress goes to stderr from the start', async () => {
    mocks.seedFor.mockReturnValue({ cloud: 'aws' });
    mocks.gitHubUser.mockResolvedValue({ id: '4242', username: 'owner' });
    mocks.runSeedCreate.mockResolvedValue(ready);
    await runCluster([...createArgs, '--json']);
    expect(mocks.setJsonMode).toHaveBeenCalledWith(true);
    expect(logSpy.mock.calls).toEqual([[JSON.stringify(ready)]]);

    // A create the seed stopped: the error document, with its code.
    logSpy.mockClear();
    mocks.runSeedCreate.mockRejectedValue(
      new SeedCreateError('CLOUD_RIGHTS_MISSING', 'ops lacks ec2:RunInstances'),
    );
    await expect(runCluster([...createArgs, '--json'])).rejects.toThrow(
      'process.exit:1',
    );
    expect(logSpy.mock.calls).toEqual([
      [
        JSON.stringify({
          error: {
            code: 'CLOUD_RIGHTS_MISSING',
            message: 'ops lacks ec2:RunInstances',
          },
        }),
      ],
    ]);

    // The cloud CLI missing or signed out has its own code.
    logSpy.mockClear();
    mocks.runSeedCreate.mockRejectedValue(
      new SeedUnavailableError("aws isn't signed in"),
    );
    await expect(runCluster([...createArgs, '--json'])).rejects.toThrow(
      'process.exit:1',
    );
    expect(JSON.parse(String(logSpy.mock.lastCall?.[0]))).toMatchObject({
      error: { code: 'CLOUD_CLI_UNAVAILABLE' },
    });
  });

  it.each(['delete', 'terminate', 'rm'])(
    'refuses %s --delete-vms while the hosted API answers, as one JSON error document',
    async (verb) => {
      await expect(
        runCluster([verb, 'production', '--delete-vms', '--json']),
      ).rejects.toThrow('process.exit:1');
      expect(mocks.getCluster).toHaveBeenCalledWith({
        params: { id: 'production' },
      });
      expect(logSpy.mock.calls).toEqual([
        [expect.stringContaining('"code":"API_REACHABLE"')],
      ]);
    },
  );

  it('needs the cluster ID typed, or a matching --confirm, before the API is asked to delete anything', async () => {
    const selfDelete = vi.fn();
    const selfDeleteStatus = vi.fn(async () => ({
      state: 'idle',
      installation: {
        clusterId: ready.id,
        cloud: 'aws',
        region: 'us-east-1',
        bucket: { name: ready.id, managed: true },
      },
      finalBackup: null,
      backedUpAt: null,
      deleted: [],
      remaining: [],
      error: null,
    }));
    mocks.createApiClient.mockReturnValue({
      clusters: { get: mocks.getCluster },
      systemRelease: { selfDelete, selfDeleteStatus },
    });
    const codes = () =>
      logSpy.mock.calls.map(
        (call) =>
          (JSON.parse(String(call[0])) as { error: { code: string } }).error
            .code,
      );
    // Under --json: without --confirm, and with one that doesn't match.
    for (const extra of [[], ['--confirm', 'install-other-1']]) {
      await expect(
        runCluster([
          'delete',
          'production',
          '--delete-buckets',
          '--json',
          ...extra,
        ]),
      ).rejects.toThrow('process.exit:1');
    }
    expect(codes()).toEqual(['CONFIRMATION_REQUIRED', 'CONFIRMATION_REQUIRED']);
    // In a terminal, a mistyped ID confirms nothing.
    mocks.safePrompts.mockResolvedValue({ typed: 'production' });
    await expect(
      runCluster(['delete', 'production', '--delete-buckets']),
    ).rejects.toThrow('process.exit:1');
    // --yes is no confirmation: delete has no such option.
    await expect(
      runCluster(['delete', 'production', '--delete-buckets', '--yes']),
    ).rejects.toThrow();
    expect(selfDelete).not.toHaveBeenCalled();
  });

  it('retries the edge’s 5xx for about 30 s before the API counts as unreachable', async () => {
    const { answering } = await import(
      '../../../src/cli/commands/cluster-delete.js'
    );
    const waits: number[] = [];
    const wait = async (ms: number) => {
      waits.push(ms);
    };
    let calls = 0;
    await expect(
      answering(async () => {
        if (++calls < 3) throw new ORPCError('BAD_GATEWAY', { status: 520 });
        return 'ok';
      }, wait),
    ).resolves.toBe('ok');
    expect(waits).toEqual([1_000, 2_000]);
    waits.length = 0;
    await expect(
      answering(async () => {
        throw new ORPCError('BAD_GATEWAY', { status: 522 });
      }, wait),
    ).rejects.toThrow();
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(30_000);
    // A declared refusal is never retried.
    waits.length = 0;
    await expect(
      answering(async () => {
        throw new ORPCError('SELF_DELETE_REFUSED', {
          status: 409,
          defined: true,
        });
      }, wait),
    ).rejects.toThrow();
    expect(waits).toEqual([]);
  });

  const failing = (message: string, code?: string, node = false) => {
    const error = Object.assign(new Error(message), code ? { code } : {});
    // Node nests the network error as fetch's TypeError's cause.
    return node
      ? Object.assign(new TypeError('fetch failed'), { cause: error })
      : error;
  };
  it.each([
    [
      'Bun’s refused connection',
      failing(
        'Unable to connect. Is the computer able to access the url?',
        'ConnectionRefused',
      ),
    ],
    ['Bun’s failed socket', failing('Unable to connect', 'FailedToOpenSocket')],
    [
      'Bun’s message alone',
      failing('Unable to connect. Is the computer able to access the url?'),
    ],
    [
      'a refused connection',
      failing('connect ECONNREFUSED', 'ECONNREFUSED', true),
    ],
    ['a reset connection', failing('socket hang up', 'ECONNRESET', true)],
    ['a DNS failure', failing('getaddrinfo ENOTFOUND', 'ENOTFOUND', true)],
    ['a DNS retry', failing('getaddrinfo EAI_AGAIN', 'EAI_AGAIN', true)],
    [
      'an untrusted certificate',
      failing('unable to verify', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'),
    ],
    [
      'a certificate for another name',
      failing('altname', 'ERR_TLS_CERT_ALTNAME_INVALID', true),
    ],
    ['an expired certificate', failing('expired', 'CERT_HAS_EXPIRED')],
    [
      'a timeout',
      Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
    ],
    [
      'Cloudflare with no origin (521)',
      new ORPCError('UNKNOWN', { status: 521 }),
    ],
    ['Cloudflare timing out (522)', new ORPCError('UNKNOWN', { status: 522 })],
    [
      'Cloudflare unable to resolve the origin (530)',
      new ORPCError('UNKNOWN', { status: 530 }),
    ],
  ])('counts %s as no answer from the hosted API', async (_case, error) => {
    const { unreachable } = await import(
      '../../../src/cli/commands/cluster-delete.js'
    );
    expect(unreachable(error)).toBe(true);
  });

  it.each([
    [
      'a declared refusal',
      new ORPCError('SELF_DELETE_REFUSED', { status: 409, defined: true }),
    ],
    [
      'a declared 503',
      new ORPCError('API_RESTARTING', { status: 503, defined: true }),
    ],
    ['an undeclared 4xx', new ORPCError('FORBIDDEN', { status: 403 })],
    [
      'a TypeError from our own code',
      new TypeError("Cannot read properties of undefined (reading 'id')"),
    ],
  ])('counts %s as an answer', async (_case, error) => {
    const { unreachable } = await import(
      '../../../src/cli/commands/cluster-delete.js'
    );
    expect(unreachable(error)).toBe(false);
  });

  it.each([
    ['its sign-in exchange', 'exchange'],
    ['the cluster lookup', 'lookup'],
  ])(
    'takes the dead path when a hosted API that never came up fails %s',
    async (_case, where) => {
      const id = 'production-1781234567890-abcd';
      const refused = () =>
        failing(
          'Unable to connect. Is the computer able to access the url?',
          'ConnectionRefused',
        );
      if (where === 'exchange') mocks.apiBearer.mockRejectedValue(refused());
      else mocks.getCluster.mockRejectedValue(refused());
      const health = vi.spyOn(globalThis, 'fetch').mockRejectedValue(refused());
      let asked: unknown[][] = [];
      try {
        await runCluster([
          'delete',
          id,
          '--skip-cloud',
          '--confirm',
          id,
          '--json',
        ]);
      } finally {
        asked = [...health.mock.calls];
        health.mockRestore();
      }
      expect(asked).toEqual([
        [`https://${id}.anycloud.sh/health`, expect.anything()],
      ]);
      expect(JSON.parse(String(logSpy.mock.lastCall?.[0]))).toMatchObject({
        outcome: 'abandoned',
        clusterId: id,
      });
    },
  );

  it('runs the live run’s bucket delete against the seed when the hosted API never came up', async () => {
    const id = 'production-1781234567890-abcd';
    const refused = failing(
      'Unable to connect. Is the computer able to access the url?',
      'ConnectionRefused',
    );
    mocks.apiBearer.mockRejectedValue(refused);
    const afterSelfDelete = vi.fn(async () => ({
      deleted: [{ kind: 'firewall' as const, id: `anycloud-${id}-api` }],
      remaining: [],
    }));
    mocks.seedFor.mockImplementation((cloud: string) => ({
      cloud,
      discoverAccount: async () => ({ account: 'ci-project', principal: 'ci' }),
      status: async () => ({ kind: 'absent' }),
      readObject: async () => null,
      afterSelfDelete,
    }));
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(refused);
    try {
      await runCluster([
        'delete',
        '--json',
        '--cloud',
        'gcp',
        '--region',
        'us-central1',
        '--delete-buckets',
        '--confirm',
        id,
        id,
      ]);
    } finally {
      network.mockRestore();
    }
    expect(afterSelfDelete).toHaveBeenCalledWith(id, 'us-central1', {
      deleteBuckets: true,
    });
    expect(JSON.parse(String(logSpy.mock.lastCall?.[0]))).toMatchObject({
      outcome: 'destroyed',
      clusterId: id,
      deleted: [expect.objectContaining({ type: 'firewall' })],
    });
  });

  it('with the hosted API gone, needs the cluster ID, --cloud and --region before anything runs', async () => {
    mocks.getCluster.mockRejectedValue(
      new ORPCError('CLUSTER_NOT_FOUND', { status: 404, defined: true }),
    );
    await expect(runCluster(['delete', 'production'])).rejects.toThrow(
      'process.exit:2',
    );
    await expect(
      runCluster(['delete', 'production-1781234567890-abcd']),
    ).rejects.toThrow('process.exit:2');
    expect(mocks.printError).toHaveBeenLastCalledWith(
      expect.stringContaining('pass --cloud and --region'),
    );
  });

  it('reports API failures through the command error path', async () => {
    mocks.getCluster.mockRejectedValue(new Error('cluster not found'));
    await expect(runCluster(['status', 'missing'])).rejects.toThrow(
      'process.exit:1',
    );
    expect(mocks.printError).toHaveBeenCalledWith(
      'Failed to get cluster: cluster not found',
    );
  });
});
