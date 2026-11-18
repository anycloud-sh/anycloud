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
import { CloudType, DiskTier } from '../../../src/shared/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';

const mocks = vi.hoisted(() => ({
  createApiClient: vi.fn(),
  createNodePool: vi.fn(),
  deleteNodePool: vi.fn(),
  getNodePool: vi.fn(),
  listNodePools: vi.fn(),
  printError: vi.fn(),
  printInfo: vi.fn(),
  printSuccess: vi.fn(),
  apiBearer: vi.fn(),
  setJsonMode: vi.fn(),
  runWait: vi.fn(),
}));

vi.mock('../../../src/cli/commands/wait.js', () => ({
  runWait: mocks.runWait,
}));

vi.mock('../../../src/shared/services/api-client/rpc.js', async (actual) => ({
  ...(await actual<
    typeof import('../../../src/shared/services/api-client/rpc.js')
  >()),
  createApiClient: mocks.createApiClient,
}));

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock(() => mocks.apiBearer()),
);

vi.mock('../../../src/cli/commands/shared.js', () => ({}));

vi.mock('../../../src/cli/utils/output.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../src/cli/utils/output.js')
  >()),
  printError: mocks.printError,
  printInfo: mocks.printInfo,
  printSuccess: mocks.printSuccess,
  setJsonMode: mocks.setJsonMode,
}));

import { createNodePoolCommand } from '../../../src/cli/commands/node-pool.js';

const nodePool = {
  id: 'node-pool-aws-east-a1b2',
  name: 'aws-east',
  clusterId: 'cluster-production-a1b2',
  state: WorkloadState.Running,
  releasing: false,
  cloudProvider: CloudType.GCP,
  region: 'us-central1',
  zone: 'us-central1-a',
  vmTypes: ['e2-standard-2'],
  minVmCount: 1,
  maxVmCount: 1,
  osDiskSizeGb: null,
  osDiskTier: null,
  spot: false,
  userNamespaceJobs: false,
  requireNestedVirtualization: false,
  capacity: {
    readyVmCount: 1,
    startingVmCount: 0,
    drainingVmCount: 0,
    locations: [],
  },
  liveReferences: 0,
  ingressEntryIp: '203.0.113.7',
  ingress: {
    entryIp: '203.0.113.7',
    release: {
      state: 'installed',
      helmJob: { phase: 'succeeded', message: null },
      daemonSet: { desired: 1, ready: 1, entryNodeReady: true },
      lastEvent: 'Started: Started container pool-ingress',
      routes: 1,
    },
  },
  lastError: null,
  createdAt: 1,
  updatedAt: 1,
};

async function runNodePool(argv: string[]): Promise<void> {
  const command = createNodePoolCommand();
  command.exitOverride();
  command.configureOutput({ writeErr: () => undefined });
  for (const sub of command.commands) {
    sub.exitOverride();
    sub.configureOutput({ writeErr: () => undefined });
  }
  await command.parseAsync(argv, { from: 'user' });
}

describe('node pool command', () => {
  let exitSpy: MockInstance<typeof process.exit>;
  let logSpy: MockInstance<typeof console.log>;
  const printed = () => logSpy.mock.calls.map((call) => String(call[0]).trim());

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiBearer.mockResolvedValue('access-token');
    mocks.createApiClient.mockReturnValue({
      nodePools: {
        create: mocks.createNodePool,
        delete: mocks.deleteNodePool,
        get: mocks.getNodePool,
        list: mocks.listNodePools,
      },
    });
    mocks.createNodePool.mockResolvedValue({ nodePool });
    mocks.getNodePool.mockResolvedValue({ nodePool });
    mocks.listNodePools.mockResolvedValue({ nodePools: [nodePool] });
    mocks.deleteNodePool.mockResolvedValue({
      nodePool: {
        ...nodePool,
        state: WorkloadState.Terminated,
        releasing: true,
      },
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit:${code ?? 0}`);
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('waits for a created node pool to be ready with --wait', async () => {
    mocks.runWait.mockResolvedValue(0);
    await runNodePool([
      'create',
      'aws-east',
      '--credentials',
      'aws-compute',
      '--region',
      'us-east-1',
      '--vm-type',
      't3.small',
      '--min-vms',
      '1',
      '--max-vms',
      '1',
      '--wait',
    ]);
    const created = mocks.createNodePool.mock.results[0]?.value as Promise<{
      nodePool: { id: string };
    }>;
    expect(mocks.runWait).toHaveBeenCalledWith(
      [{ kind: 'node-pool', id: (await created).nodePool.id }],
      { json: undefined },
    );
    process.exitCode = undefined;
  });

  it('passes the node pool target, optional cluster and zone to creation', async () => {
    await runNodePool([
      'create',
      'aws-east',
      '--credentials',
      'aws-compute',
      '--region',
      'us-east-1',
      '--vm-type',
      't3.small',
      '--vm-type',
      't3.medium',
      '--min-vms',
      '1',
      '--max-vms',
      '1',
    ]);
    expect(mocks.createApiClient).toHaveBeenCalledWith('access-token', {
      missingExitCode: 2,
    });
    // A repeated --vm-type is the pool's ordered type list.
    expect(mocks.createNodePool).toHaveBeenCalledWith({
      name: 'aws-east',
      credentialName: 'aws-compute',
      region: 'us-east-1',
      vmTypes: ['t3.small', 't3.medium'],
      minVmCount: 1,
      maxVmCount: 1,
    });
    expect(mocks.printSuccess).toHaveBeenCalledWith(
      'Node pool aws-east creation started.',
    );
    // Status prints the location as one field, zone included.
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('GCP / us-central1 (zone us-central1-a)'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('default size, default tier'),
    );

    await runNodePool([
      'create',
      'gcp-central',
      '--cluster',
      'production',
      '--credentials',
      'gcp-compute',
      '--region',
      'us-central1',
      '--zone',
      'us-central1-a',
      '--vm-type',
      'e2-standard-2',
      '--min-vms',
      '1',
      '--max-vms',
      '1',
      '--disk-size',
      '200',
      '--disk-tier',
      'ultra',
      '--spot',
      '--user-namespace-jobs',
      '--require-nested-virtualization',
    ]);
    expect(mocks.createNodePool).toHaveBeenLastCalledWith({
      name: 'gcp-central',
      cluster: 'production',
      credentialName: 'gcp-compute',
      region: 'us-central1',
      zone: 'us-central1-a',
      vmTypes: ['e2-standard-2'],
      minVmCount: 1,
      maxVmCount: 1,
      osDiskSizeGb: 200,
      osDiskTier: 'ultra',
      spot: true,
      userNamespaceJobs: true,
      requireNestedVirtualization: true,
    });
  });

  it('creates an unpinned node pool and shows where its VMs run', async () => {
    mocks.createNodePool.mockResolvedValueOnce({
      nodePool: {
        ...nodePool,
        region: null,
        zone: null,
        osDiskSizeGb: 500,
        osDiskTier: DiskTier.High,
        capacity: {
          ...nodePool.capacity,
          locations: [
            { region: 'us-east1', zone: 'b', vmType: 'e2-standard-2' },
            { region: 'us-west1', zone: null, vmType: 'e2-standard-2' },
            { region: 'us-east1', zone: 'b', vmType: 'e2-standard-2' },
          ],
        },
      },
    });
    await runNodePool([
      'create',
      'anywhere',
      '--credentials',
      'gcp-compute',
      '--vm-type',
      'e2-standard-2',
      '--min-vms',
      '2',
      '--max-vms',
      '2',
    ]);
    expect(mocks.createNodePool).toHaveBeenCalledWith({
      name: 'anywhere',
      credentialName: 'gcp-compute',
      vmTypes: ['e2-standard-2'],
      minVmCount: 2,
      maxVmCount: 2,
    });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('GCP / any region'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('500 GB, high tier'),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('on-demand'));
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'e2-standard-2 in us-east1 (zone b), e2-standard-2 in us-west1, e2-standard-2 in us-east1 (zone b)',
      ),
    );
  });

  it('rejects non-integer VM counts and invalid OS disks before calling the API', async () => {
    for (const disk of [
      ['--disk-size', '0'],
      ['--disk-size', '1.5'],
      ['--disk-tier', 'fast'],
    ]) {
      await expect(
        runNodePool([
          'create',
          'aws-east',
          '--credentials',
          'aws-compute',
          '--vm-type',
          't3.small',
          '--min-vms',
          '1',
          '--max-vms',
          '1',
          ...disk,
        ]),
      ).rejects.toThrow();
    }
    await expect(
      runNodePool([
        'create',
        'aws-east',
        '--credentials',
        'aws-compute',
        '--region',
        'us-east-1',
        '--vm-type',
        't3.small',
        '--min-vms',
        '1.5',
        '--max-vms',
        '1',
      ]),
    ).rejects.toThrow();
    expect(mocks.createNodePool).not.toHaveBeenCalled();
  });

  it('lists node pools, optionally filtered by cluster, and forwards identifiers', async () => {
    const commands = createNodePoolCommand().commands;
    const aliases = (name: string) =>
      commands.find((sub) => sub.name() === name)?.aliases();
    // Kubernetes verbs as aliases.
    expect(aliases('list')).toEqual(['ls', 'get']);
    expect(aliases('status')).toEqual(['describe']);

    await runNodePool(['list']);
    expect(mocks.listNodePools).toHaveBeenCalledWith(undefined);
    // The list shows cloud and region; the zone is in status.
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('GCP / us-central1'),
    );

    await runNodePool(['list', '--cluster', 'production']);
    expect(mocks.listNodePools).toHaveBeenLastCalledWith({
      query: { cluster: 'production' },
    });

    await runNodePool(['status', 'aws-east']);
    expect(mocks.getNodePool).toHaveBeenCalledWith({
      params: { id: 'aws-east' },
    });
    expect(printed()).toEqual(
      expect.arrayContaining(['⚡  running', '✓ ingress  203.0.113.7']),
    );
  });

  it('shows Workload states and one ingress line in status', async () => {
    const release = nodePool.ingress.release;
    const status = async (overrides: object) => {
      logSpy.mockClear();
      mocks.getNodePool.mockResolvedValueOnce({
        nodePool: { ...nodePool, ...overrides },
      });
      await runNodePool(['status', 'aws-east']);
      return printed();
    };
    expect(
      await status({
        state: WorkloadState.Provisioning,
        ingress: {
          entryIp: null,
          release: { ...release, state: 'installing', helmJob: null },
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        '🏗️  provisioning',
        '◌ ingress  waiting for an entry VM',
      ]),
    );
    const ingressLine = async (patch: object) =>
      (
        await status({
          ingress: {
            entryIp: '203.0.113.7',
            release: { ...release, ...patch },
          },
        })
      ).find((line) => line.includes('ingress'));
    expect(await ingressLine({ state: 'absent', lastEvent: null })).toBe(
      '◌ ingress  203.0.113.7 · pending',
    );
    // A cluster read failure is reported as absent with the reason.
    expect(
      await ingressLine({
        state: 'absent',
        lastEvent: 'cluster unavailable: connect ECONNREFUSED',
      }),
    ).toBe(
      '◌ ingress  203.0.113.7 · cluster unavailable: connect ECONNREFUSED',
    );
    expect(await ingressLine({ state: 'installing' })).toBe(
      '◌ ingress  203.0.113.7 · installing',
    );
    // Installed is not enough: the entry VM and every replica must be ready.
    expect(
      await ingressLine({
        daemonSet: { desired: 1, ready: 0, entryNodeReady: false },
      }),
    ).toBe('◌ ingress  203.0.113.7 · entry VM not ready');
    expect(
      await ingressLine({
        daemonSet: { desired: 2, ready: 1, entryNodeReady: true },
      }),
    ).toBe('◌ ingress  203.0.113.7 · starting');
    expect(await ingressLine({ daemonSet: null })).toBe(
      '◌ ingress  203.0.113.7 · starting',
    );
    expect(
      await status({
        state: WorkloadState.Failed,
        ingress: {
          entryIp: '203.0.113.7',
          release: {
            ...release,
            state: 'failed',
            helmJob: { phase: 'failed', message: 'exit 1: chart not found' },
          },
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        '❌  failed',
        '✗ ingress  failed: exit 1: chart not found',
      ]),
    );
    const releasing = await status({
      state: WorkloadState.Terminated,
      releasing: true,
      capacity: {
        ...nodePool.capacity,
        drainingVmCount: 1,
        locations: [
          {
            region: 'us-east-2',
            zone: 'c',
            vmType: 'g6e.xlarge',
            releasing: {
              // A VM whose terminate waiter ran to its 180 s cap.
              since: Date.now() - 190_000,
              usuallyUnderSeconds: 210,
            },
          },
        ],
      },
      ingress: { entryIp: null, release: null },
    });
    expect(releasing).toContain(
      '🪦  terminated · releasing VM (still billing)',
    );
    expect(releasing).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /Releasing\s+g6e\.xlarge for 3m; usually under 4m$/,
        ),
      ]),
    );
    expect(releasing.join('\n')).not.toContain('ingress');
    // Every VM row has ended; only the pool's network is still being removed.
    const network = await status({
      state: WorkloadState.Terminated,
      releasing: true,
      ingress: { entryIp: null, release: null },
    });
    expect(network).toContain('🪦  terminated · releasing network resources');
    expect(network.join('\n')).not.toMatch(/still billing|Releasing/);
  });

  it('shows the last scale-out with its reason', async () => {
    const status = async (overrides: object) => {
      logSpy.mockClear();
      mocks.getNodePool.mockResolvedValueOnce({
        nodePool: { ...nodePool, ...overrides },
      });
      await runNodePool(['status', 'aws-east']);
      return printed();
    };
    const scaled = await status({
      capacity: {
        ...nodePool.capacity,
        lastScaleOut: {
          at: Date.now() - 120_000,
          pendingPods: 3,
          lostVms: 1,
          vms: 4,
        },
      },
    });
    expect(scaled).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /Scale-out\s+4 VMs for 3 Pending Pods and 1 lost VM, 2m ago$/,
        ),
      ]),
    );
    expect((await status({})).join('\n')).not.toContain('Scale-out');
  });

  it('C10 shows nested virtualization only on a pool that requires it', async () => {
    const status = async (requireNestedVirtualization: boolean) => {
      logSpy.mockClear();
      mocks.getNodePool.mockResolvedValueOnce({
        nodePool: { ...nodePool, requireNestedVirtualization },
      });
      await runNodePool(['status', 'aws-east']);
      return printed().join('\n');
    };
    expect(await status(true)).toMatch(/Nested virtualization\s+on \(KVM\)/);
    expect(await status(false)).not.toContain('Nested virtualization');
  });

  it('says a pool whose VMs are released is terminated', async () => {
    mocks.deleteNodePool.mockResolvedValueOnce({
      nodePool: { ...nodePool, state: WorkloadState.Terminated },
    });
    await runNodePool(['delete', 'aws-east']);
    expect(mocks.printSuccess).toHaveBeenCalledWith(
      'Node pool aws-east is terminated.',
    );
  });

  it.each(['delete', 'terminate', 'rm'])(
    'deletes node pools through %s and forwards identifiers unchanged',
    async (command) => {
      await runNodePool([command, 'node-pool-aws-east-a1b2']);
      expect(mocks.deleteNodePool).toHaveBeenCalledWith({
        params: { id: 'node-pool-aws-east-a1b2' },
      });
      expect(mocks.printSuccess).toHaveBeenCalledWith(
        'Node pool aws-east deletion started.',
      );
    },
  );

  it('emits machine-readable JSON', async () => {
    await runNodePool(['status', 'aws-east', '--json']);
    expect(mocks.setJsonMode).toHaveBeenCalledWith(true);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(nodePool));
  });

  it('reports API failures through the command error path', async () => {
    mocks.createNodePool.mockRejectedValue(
      new Error('Node pools are unavailable'),
    );
    await expect(
      runNodePool([
        'create',
        'aws-east',
        '--credentials',
        'aws-compute',
        '--region',
        'us-east-1',
        '--vm-type',
        't3.small',
        '--min-vms',
        '1',
        '--max-vms',
        '1',
      ]),
    ).rejects.toThrow('process.exit:1');
    expect(mocks.printError).toHaveBeenCalledWith(
      'Failed to create node pool: Node pools are unavailable',
    );
  });

  it("prints the API's code as the one --json document of a refused create or delete", async () => {
    mocks.createNodePool.mockRejectedValue(
      new ORPCError('NODE_POOL_ALREADY_EXISTS', {
        defined: true,
        status: 409,
        message: 'Node pool "aws-east" already exists with other settings',
      }),
    );
    await expect(
      runNodePool([
        'create',
        'aws-east',
        '--credentials',
        'aws-compute',
        '--vm-type',
        't3.small',
        '--min-vms',
        '1',
        '--max-vms',
        '1',
        '--json',
      ]),
    ).rejects.toThrow('process.exit:1');
    mocks.deleteNodePool.mockRejectedValue(
      new ORPCError('NODE_POOL_REFERENCED', {
        defined: true,
        status: 409,
        message: 'Node pool still has live references',
      }),
    );
    await expect(runNodePool(['delete', 'aws-east', '--json'])).rejects.toThrow(
      'process.exit:1',
    );
    expect(printed().map((line) => JSON.parse(line) as unknown)).toEqual([
      {
        error: {
          code: 'NODE_POOL_ALREADY_EXISTS',
          message: 'Node pool "aws-east" already exists with other settings',
        },
      },
      {
        error: {
          code: 'NODE_POOL_REFERENCED',
          message: 'Node pool still has live references',
        },
      },
    ]);
    expect(mocks.printError).not.toHaveBeenCalled();
  });
});
