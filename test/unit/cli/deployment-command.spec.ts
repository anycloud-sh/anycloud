import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createDeployment: vi.fn(),
  deleteDeployment: vi.fn(),
  getDeployment: vi.fn(),
  listDeployments: vi.fn(),
  updateDeployment: vi.fn(),
  createApiClient: vi.fn(),
  parseEnvVars: vi.fn(),
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

vi.mock('../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: mocks.createApiClient,
}));

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock(() => mocks.apiBearer()),
);

vi.mock('../../../src/cli/commands/shared.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../src/cli/commands/shared.js')
  >()),
  parseEnvVars: mocks.parseEnvVars,
}));

vi.mock('../../../src/cli/utils/output.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../src/cli/utils/output.js')
  >()),
  printError: mocks.printError,
  printInfo: mocks.printInfo,
  printSuccess: mocks.printSuccess,
  setJsonMode: mocks.setJsonMode,
}));

import { createDeploymentCommand } from '../../../src/cli/commands/deployment.js';
import { validateDockerOptionsRequest } from '../../../src/shared/docker-options.js';
import type { DockerOptions } from '../../../src/shared/runtime.js';
import type {
  DeploymentStatus,
  DeploymentSummary,
  UpdateDeploymentRequest,
} from '../../../src/shared/api-contract/deployments-schemas.js';
import { WorkloadState } from '../../../src/shared/workload.js';

async function runDeployment(argv: string[]): Promise<void> {
  const command = createDeploymentCommand();
  command.exitOverride();
  await command.parseAsync(argv, { from: 'user' });
}

describe('deployment command', () => {
  const deployment = {
    id: 'deployment-test',
    name: 'deployment',
  };
  const readyStatus: DeploymentStatus = {
    state: WorkloadState.Running,
    releasing: false,
    ready: true,
    upgrade: { number: 1, state: WorkloadState.Running },
    reason: 'The readiness probe passes; new Jobs can start.',
    requestedGeneration: 2,
    appliedGeneration: 2,
    podGeneration: 2,
    podName: 'observed-pod',
    podUid: 'pod-uid',
    containerId: 'containerd://container-id',
    containerReady: true,
    readyReplicas: 1,
    applicationReady: true,
    probeConfigured: true,
    observation: 'observed',
    observedAt: 1000,
    observationError: null,
    blockingJobs: { total: 0, jobs: [] },
  };
  const readyDeployment: DeploymentSummary = {
    ...deployment,
    managed: false,
    privileged: false,
    nodePoolId: 'node-pool-a',
    target: { kind: 'nodePool', nodePoolId: 'node-pool-a' },
    image: 'example/image',
    command: null,
    readinessProbe: { exec: { command: ['/app/check-ready'] } },
    gracePeriodSeconds: 30,
    gpuCount: 0,
    envKeys: [],
    secretNames: [],
    maxConcurrentJobsPerReplica: 2,
    minReplicas: 1,
    maxReplicas: 1,
    generation: 2,
    deletionRequestedAt: null,
    deletedAt: null,
    createdAt: 1,
    updatedAt: 2,
    usage: null,
    jobs: { running: 0, queued: 1, retrying: 0, terminal: 0, unreleased: 0 },
    workload: {
      observedGeneration: 2,
      podName: 'observed-pod',
      podUid: 'pod-uid',
      containerId: 'containerd://container-id',
      containerReady: true,
      pendingReason: null,
    },
    status: readyStatus,
  };
  function observe(
    status: Partial<DeploymentStatus>,
    fields: Partial<DeploymentSummary> = {},
  ): DeploymentSummary {
    return {
      ...readyDeployment,
      ...fields,
      status: { ...readyStatus, ...status },
    };
  }
  function printed(): string {
    return [...logSpy.mock.calls, ...mocks.printInfo.mock.calls]
      .map(([line]) => stripVTControlCharacters(String(line)))
      .join('\n');
  }
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiBearer.mockResolvedValue('access-token');
    mocks.parseEnvVars.mockReturnValue({ EXAMPLE: 'value' });
    mocks.createDeployment.mockResolvedValue({ deployment });
    mocks.deleteDeployment.mockResolvedValue({ deployment });
    mocks.updateDeployment.mockResolvedValue({ deployment });
    mocks.createApiClient.mockReturnValue({
      deployments: {
        create: mocks.createDeployment,
        delete: mocks.deleteDeployment,
        get: mocks.getDeployment,
        list: mocks.listDeployments,
        update: mocks.updateDeployment,
      },
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('waits for a created Deployment and for an upgrade to its own revision', async () => {
    mocks.runWait.mockResolvedValue(1);
    await runDeployment([
      'create',
      'deployment',
      'example/image',
      '--node-pool',
      'node-pool-a',
      '--wait',
      '--json',
    ]);
    expect(mocks.runWait).toHaveBeenLastCalledWith(
      [{ kind: 'deployment', id: 'deployment-test' }],
      { json: true },
    );
    // With --json, the created Deployment is the first line, before the
    // wait records, so its ID is at hand.
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      id: 'deployment-test',
    });
    expect(process.exitCode).toBe(1);
    mocks.updateDeployment.mockResolvedValue({
      deployment: { ...deployment, generation: 3 },
    });
    mocks.runWait.mockResolvedValue(0);
    await runDeployment([
      'upgrade',
      'deployment',
      '--cpus',
      '2',
      '--wait',
      '--json',
    ]);
    expect(mocks.runWait).toHaveBeenLastCalledWith(
      [{ kind: 'deployment', id: 'deployment-test' }],
      { json: true },
    );
    expect(process.exitCode).toBe(0);
    process.exitCode = undefined;
  });

  it('uses Deployment as the only command name', () => {
    const command = createDeploymentCommand();

    expect(command.name()).toBe('deployment');
    expect(command.aliases()).not.toContain('workload');
    const aliases = (name: string) =>
      command.commands.find((sub) => sub.name() === name)?.aliases();
    // Kubernetes verbs as aliases.
    expect(aliases('list')).toEqual(['ls', 'get']);
    expect(aliases('status')).toEqual(['describe']);
  });

  it.each(['node-pool-a', 'training'])(
    'filters Deployment JSON by node pool %s',
    async (nodePool) => {
      mocks.listDeployments.mockResolvedValue({ deployments: [deployment] });
      await runDeployment(['list', '--node-pool', nodePool, '--json']);
      expect(mocks.listDeployments).toHaveBeenCalledWith({
        query: { nodePool },
      });
      expect(logSpy).toHaveBeenCalledWith(JSON.stringify([deployment]));
      expect(mocks.createDeployment).not.toHaveBeenCalled();
    },
  );

  it('preserves the unfiltered ls alias', async () => {
    mocks.listDeployments.mockResolvedValue({ deployments: [deployment] });
    await runDeployment(['ls', '--json']);
    expect(mocks.listDeployments).toHaveBeenCalledWith(undefined);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify([deployment]));
    expect(mocks.getDeployment).not.toHaveBeenCalled();
  });

  it('passes native exec probe JSON on create and preserves explicit clearing on update', async () => {
    const readinessProbe = {
      exec: { command: ['test', '-f', '/ready'] },
      periodSeconds: 1,
    };
    await runDeployment([
      'create',
      'worker',
      '--node-pool',
      'training',
      '--json',
      '--readiness-probe',
      JSON.stringify(readinessProbe),
      'image:latest',
    ]);
    expect(mocks.createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ readinessProbe }),
    );
    await runDeployment([
      'update',
      'worker',
      '--json',
      '--readiness-probe',
      'null',
    ]);
    expect(mocks.updateDeployment).toHaveBeenCalledWith({
      params: { id: 'worker' },
      body: { readinessProbe: null },
    });
    await runDeployment([
      'update',
      'worker',
      '--json',
      '--image',
      'next:latest',
    ]);
    expect(mocks.updateDeployment).toHaveBeenLastCalledWith({
      params: { id: 'worker' },
      body: { image: 'next:latest' },
    });
  });

  it.each(['not-json', '{"httpGet":{"port":8080}}', '{"exec":{"command":[]}}'])(
    'rejects invalid probe JSON before calling the API: %s',
    async (value) => {
      await expect(
        runDeployment(['update', 'worker', '--readiness-probe', value]),
      ).rejects.toThrow();
      expect(mocks.updateDeployment).not.toHaveBeenCalled();
    },
  );

  it('passes --grace-period as seconds on create and update', async () => {
    await runDeployment([
      'create',
      'worker',
      '--node-pool',
      'training',
      '--json',
      '--grace-period',
      '10m',
      'image:latest',
    ]);
    expect(mocks.createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ gracePeriodSeconds: 600 }),
    );
    await runDeployment(['update', 'worker', '--json', '--grace-period', '0s']);
    expect(mocks.updateDeployment).toHaveBeenCalledWith({
      params: { id: 'worker' },
      body: { gracePeriodSeconds: 0 },
    });
  });

  it.each(['90', '1500ms', '2d'])(
    'rejects --grace-period %s before calling the API',
    async (value) => {
      await expect(
        runDeployment(['update', 'worker', '--grace-period', value]),
      ).rejects.toThrow();
      expect(mocks.updateDeployment).not.toHaveBeenCalled();
    },
  );

  it('enables JSON mode before parsing environment flags', async () => {
    await runDeployment([
      'create',
      'deployment',
      '--node-pool',
      'node-pool-a',
      '--json',
      '--env',
      'EXAMPLE=value',
      'busybox:latest',
    ]);

    expect(mocks.setJsonMode).toHaveBeenCalledWith(true);
    expect(mocks.setJsonMode.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.parseEnvVars.mock.invocationCallOrder[0]!,
    );
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(deployment));
    expect(mocks.createDeployment).toHaveBeenCalledWith(
      expect.not.objectContaining({ secrets: expect.anything() }),
    );
  });

  it('sends named Secrets on create, replaces or removes them on upgrade', async () => {
    await runDeployment([
      'create',
      'deployment',
      '--node-pool',
      'node-pool-a',
      '--secret',
      'db',
      '--secret',
      'tracking',
      '--json',
      'busybox:latest',
    ]);
    await runDeployment(['upgrade', 'deployment', '--secret', 'db', '--json']);
    await runDeployment(['upgrade', 'deployment', '--no-secret', '--json']);

    expect(mocks.createDeployment.mock.calls[0]?.[0].secrets).toEqual([
      'db',
      'tracking',
    ]);
    expect(
      mocks.updateDeployment.mock.calls.map(([request]) => request.body),
    ).toEqual([{ secrets: ['db'] }, { secrets: null }]);
  });

  it.each(['all', '2'])(
    'sends GPU access %s and runtime as container options',
    async (gpus) => {
      await runDeployment([
        'create',
        'deployment',
        '--node-pool',
        'node-pool-a',
        '--gpus',
        gpus,
        '--runtime',
        'nvidia',
        '--json',
        'busybox:latest',
      ]);

      expect(mocks.createDeployment).toHaveBeenCalledWith(
        expect.objectContaining({
          dockerOptions: expect.objectContaining({ gpus, runtime: 'nvidia' }),
        }),
      );
      expect(mocks.createDeployment.mock.calls[0]?.[0]).not.toHaveProperty(
        'gpuCount',
      );
    },
  );

  it('sends only the supplied container option fields on update', async () => {
    await runDeployment([
      'update',
      'deployment',
      '--gpus',
      'all',
      '--runtime',
      'nvidia',
      '--shm-size',
      '8g',
      '--memory',
      '16g',
      '--cpus',
      '4',
      '--json',
    ]);

    expect(
      JSON.parse(JSON.stringify(mocks.updateDeployment.mock.calls[0]?.[0])),
    ).toEqual({
      params: { id: 'deployment' },
      body: {
        dockerOptions: {
          gpus: 'all',
          runtime: 'nvidia',
          shmSize: '8g',
          memory: '16g',
          cpus: '4',
        },
      },
    });
  });

  it('updates CPUs without reading or replacing other Deployment settings', async () => {
    await runDeployment(['upgrade', 'runner', '--cpus', '6', '--json']);

    expect(
      JSON.parse(JSON.stringify(mocks.updateDeployment.mock.calls[0]?.[0])),
    ).toEqual({
      params: { id: 'runner' },
      body: { dockerOptions: { cpus: '6' } },
    });
    expect(mocks.getDeployment).not.toHaveBeenCalled();
    expect(mocks.updateDeployment).toHaveBeenCalledOnce();
  });

  it('sends repeated binds as the complete replacement volume list on update', async () => {
    await runDeployment([
      'update',
      'runner',
      '--bind',
      '/runtime',
      '--bind',
      '/control',
      '--json',
    ]);

    expect(
      JSON.parse(JSON.stringify(mocks.updateDeployment.mock.calls[0]?.[0])),
    ).toEqual({
      params: { id: 'runner' },
      body: {
        dockerOptions: { binds: ['/runtime', '/control'] },
      },
    });
    expect(mocks.getDeployment).not.toHaveBeenCalled();
  });

  it('sends --replicas N as min = max = N, and refuses it beside the bounds', async () => {
    await runDeployment(['update', 'runner', '--replicas', '2', '--json']);
    await runDeployment([
      'update',
      'runner',
      '--min-replicas',
      '1',
      '--max-replicas',
      '3',
      '--json',
    ]);
    expect(
      mocks.updateDeployment.mock.calls.map(([request]) => request.body),
    ).toEqual([
      { minReplicas: 2, maxReplicas: 2 },
      { minReplicas: 1, maxReplicas: 3 },
    ]);
    const command = createDeploymentCommand();
    const update = command.commands.find((child) => child.name() === 'upgrade');
    if (!update) throw new Error('Expected Deployment upgrade command');
    update.exitOverride().configureOutput({ writeErr: () => undefined });
    await expect(
      command.parseAsync(
        ['update', 'runner', '--replicas', '2', '--max-replicas', '3'],
        { from: 'user' },
      ),
    ).rejects.toMatchObject({ code: 'commander.conflictingOption' });
    expect(mocks.updateDeployment).toHaveBeenCalledTimes(2);
  });

  it('rejects an update with no changes', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('CLI exited');
    });
    try {
      await expect(
        runDeployment(['update', 'runner', '--json']),
      ).rejects.toThrow('CLI exited');
      expect(mocks.printError).toHaveBeenCalledWith(
        expect.stringContaining('Pass at least one field to upgrade'),
      );
      expect(mocks.updateDeployment).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  it('rejects --reset as an unknown Deployment option before authentication', async () => {
    const command = createDeploymentCommand();
    // `upgrade` is the verb; `update` is its alias.
    const update = command.commands.find((child) => child.name() === 'upgrade');
    if (!update) throw new Error('Expected Deployment upgrade command');
    update.exitOverride().configureOutput({ writeErr: () => undefined });
    await expect(
      command.parseAsync(['update', 'runner', '--reset', 'memory'], {
        from: 'user',
      }),
    ).rejects.toMatchObject({ code: 'commander.unknownOption' });
    expect(mocks.apiBearer).not.toHaveBeenCalled();
    expect(mocks.createApiClient).not.toHaveBeenCalled();
    expect(mocks.updateDeployment).not.toHaveBeenCalled();
  });

  it('sends privileged access and both disposable volume paths', async () => {
    await runDeployment([
      'create',
      'runner',
      'runner:spike',
      '--node-pool',
      'node-pool-a',
      '--privileged',
      '--bind',
      '/runtime',
      '--bind',
      '/control',
      '--json',
    ]);
    expect(mocks.createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        dockerOptions: { privileged: true, binds: ['/runtime', '/control'] },
      }),
    );
  });

  it('preserves explicit false when disabling privileged access', async () => {
    await runDeployment(['update', 'runner', '--no-privileged', '--json']);
    expect(mocks.updateDeployment).toHaveBeenCalledWith({
      params: { id: 'runner' },
      body: expect.objectContaining({
        dockerOptions: { privileged: false },
      }),
    });
  });

  it('targets a node pool on create, list and status, and requires the target', async () => {
    const onNodePool = readyDeployment;
    mocks.createDeployment.mockResolvedValue({ deployment: onNodePool });
    await runDeployment([
      'create',
      'deployment',
      '--node-pool',
      'aws-east',
      '--gpus',
      '1',
      '--json',
      'ghcr.io/example/model:latest',
    ]);
    expect(mocks.printError).not.toHaveBeenCalled();
    expect(mocks.createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        nodePool: 'aws-east',
        dockerOptions: expect.objectContaining({ gpus: '1' }),
      }),
    );
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(onNodePool));

    mocks.getDeployment.mockResolvedValue({ deployment: onNodePool });
    await runDeployment(['status', 'deployment-test', '--verbose']);
    expect(printed()).toMatch(/Node pool\s+node-pool-a/);
    logSpy.mockClear();
    mocks.getDeployment.mockResolvedValue({
      deployment: { ...onNodePool, status: null },
    });
    await runDeployment(['status', 'deployment-test']);
    expect(printed()).toMatch(/Node pool\s+node-pool-a/);

    mocks.listDeployments.mockResolvedValue({ deployments: [onNodePool] });
    await runDeployment(['list', '--node-pool', 'aws-east', '--json']);
    expect(mocks.listDeployments).toHaveBeenLastCalledWith({
      query: { nodePool: 'aws-east' },
    });

    // Commander refuses a create without its node pool before the action runs.
    const command = createDeploymentCommand();
    const create = command.commands.find((child) => child.name() === 'create');
    if (!create) throw new Error('Expected Deployment create command');
    create.exitOverride().configureOutput({ writeErr: () => undefined });
    mocks.createDeployment.mockClear();
    await expect(
      command.parseAsync(['create', 'deployment', 'busybox:latest'], {
        from: 'user',
      }),
    ).rejects.toMatchObject({ code: 'commander.missingMandatoryOptionValue' });
    expect(mocks.createDeployment).not.toHaveBeenCalled();
  });

  it('leaves GPU defaults to the selected capacity when flags are omitted', async () => {
    await runDeployment([
      'create',
      'deployment',
      '--node-pool',
      'node-pool-a',
      '--json',
      'busybox:latest',
    ]);

    const request = JSON.parse(
      JSON.stringify(mocks.createDeployment.mock.calls[0]?.[0]),
    );
    expect(request).not.toHaveProperty('dockerOptions');
    expect(request).not.toHaveProperty('gpuCount');
  });

  it('accepts the explicit CPU runtime without adding a GPU request', async () => {
    await runDeployment([
      'update',
      'deployment',
      '--runtime',
      'runc',
      '--json',
    ]);

    expect(
      JSON.parse(JSON.stringify(mocks.updateDeployment.mock.calls[0]?.[0])),
    ).toEqual({
      params: { id: 'deployment' },
      body: { dockerOptions: { runtime: 'runc' } },
    });
  });

  it.each(['delete', 'terminate', 'rm'])(
    'deletes a Deployment by ID or name through %s',
    async (command) => {
      await runDeployment([command, 'deployment', '--json']);

      expect(mocks.deleteDeployment).toHaveBeenCalledWith({
        params: { id: 'deployment' },
      });
      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(deployment));
    },
  );

  it.each([
    ['create', '--gpus', '', /gpus must be a non-empty string/],
    ['update', '--gpus', '', /gpus must be a non-empty string/],
    ['create', '--runtime', '', /runtime must be a non-empty string/],
    ['update', '--runtime', '', /runtime must be a non-empty string/],
    ['create', '--shm-size', '', /shmSize must be a non-empty string/],
    ['update', '--shm-size', '', /shmSize must be a non-empty string/],
    ['create', '--memory', '', /memory must be a non-empty string/],
    ['update', '--memory', '', /memory must be a non-empty string/],
    ['create', '--cpus', '', /cpus must be a non-empty string/],
    ['update', '--cpus', '', /cpus must be a non-empty string/],
    [
      'create',
      '--runtime',
      '',
      /runtime must be a non-empty string/,
      ['--memory', '1g'],
    ],
    [
      'update',
      '--runtime',
      '',
      /runtime must be a non-empty string/,
      ['--memory', '1g'],
    ],
    [
      'update',
      '--gpus',
      '',
      /gpus must be a non-empty string/,
      ['--image', 'deployment:v2'],
    ],
    ['create', '--gpus', '0', /positive GPU count/],
    ['update', '--gpus', '0', /positive GPU count/],
    ['create', '--gpus', '1e1', /positive GPU count/],
    ['update', '--gpus', '-1', /positive GPU count/],
    ['create', '--runtime', 'custom', /support runc and nvidia/],
    ['update', '--runtime', 'custom', /support runc and nvidia/],
  ] as const)(
    'reports shared API validation for %s %s %s',
    async (
      operation,
      flag,
      value,
      message,
      extraArgs: readonly string[] = [],
    ) => {
      const validateWire = (request: { dockerOptions?: DockerOptions }) => {
        const wire = JSON.parse(JSON.stringify(request)) as typeof request;
        validateDockerOptionsRequest(wire.dockerOptions);
        return Promise.resolve({ deployment });
      };
      mocks.createDeployment.mockImplementation(validateWire);
      mocks.updateDeployment.mockImplementation(
        (input: { body: UpdateDeploymentRequest }) => {
          const wire = JSON.parse(JSON.stringify(input.body));
          validateDockerOptionsRequest(wire.dockerOptions);
          return Promise.resolve({ deployment });
        },
      );
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('CLI exited');
      });
      try {
        const args =
          operation === 'create'
            ? [
                'create',
                'deployment',
                '--node-pool',
                'node-pool-a',
                flag,
                value,
                ...extraArgs,
                '--json',
                'busybox:latest',
              ]
            : ['update', 'deployment', flag, value, '--json', ...extraArgs];
        await expect(runDeployment(args)).rejects.toThrow('CLI exited');
        expect(mocks.printError).toHaveBeenCalledWith(
          expect.stringMatching(message),
        );
        expect(exit).toHaveBeenCalledWith(1);
      } finally {
        exit.mockRestore();
      }
    },
  );

  it('preserves flag-like command arguments after -- when updating', async () => {
    await runDeployment([
      'update',
      'deployment',
      '--image',
      'example/deployment:v2',
      '--json',
      '--',
      'python',
      '-m',
      'deployment',
      '--port',
      '8000',
      '--reset',
      'memory',
    ]);

    expect(mocks.updateDeployment).toHaveBeenCalledWith({
      params: { id: 'deployment' },
      body: {
        image: 'example/deployment:v2',
        command: [
          'python',
          '-m',
          'deployment',
          '--port',
          '8000',
          '--reset',
          'memory',
        ],
      },
    });
  });

  const oldJob = {
    id: 'old-job',
    executionId: 'old-execution',
    generation: 1,
    state: WorkloadState.Running,
  };
  it.each([
    {
      name: 'a ready Deployment and its finished upgrade',
      status: {},
      fields: {},
      shown: [
        '⚡  running',
        '✓ ready  The readiness probe passes; new Jobs can start.',
        'Upgrade 1 · example/image',
        '✓ pod  running',
      ],
      hidden: ['◌', 'Waiting on', 'Reason', 'Secrets'],
    },
    {
      name: 'a readiness loss after the upgrade rolled out',
      status: {
        ready: false,
        containerReady: false,
        applicationReady: false,
        reason: 'Waiting for the readiness probe to pass; new Jobs wait.',
      },
      fields: {},
      shown: [
        '⚡  running',
        '✗ ready  Waiting for the readiness probe to pass; new Jobs wait.',
        '✓ pod  running',
      ],
      hidden: ['◌', 'Reason'],
    },
    {
      name: 'a ready Deployment without a probe',
      status: {
        upgrade: null,
        probeConfigured: false,
        applicationReady: null,
        reason: 'The container is ready; no readiness probe is set.',
      },
      fields: {
        generation: 1,
        readinessProbe: null,
        secretNames: ['db', 'tracking'],
        usage: { replicaHours: 5, busyHours: 2, costUsd: 50, busyCostUsd: 20 },
      },
      shown: [
        '⚡  running',
        'Secrets          db, tracking',
        'Readiness probe  not set',
        'Replica time     5.0 h ($50.00) · 2.0 h busy ($20.00) · 3.0 h idle ($30.00)',
        '✓ ready  The container is ready; no readiness probe is set.',
      ],
      hidden: ['Upgrade', 'Reason'],
    },
    {
      name: 'an upgrade waiting on Jobs from the previous revision',
      status: {
        upgrade: { number: 1, state: WorkloadState.Starting },
        appliedGeneration: 1,
        podGeneration: 1,
        reason: 'Waiting for Jobs on the previous revision to finish.',
        blockingJobs: { total: 1, jobs: [oldJob] },
      },
      fields: {
        jobs: { ...readyDeployment.jobs, running: 1, unreleased: 1 },
      },
      shown: [
        '⚡  running',
        'Jobs             1/2 · 1 queued',
        'Waiting on       old-job (running)',
        '◌ pod  starting: Waiting for Jobs on the previous revision to finish.',
      ],
      hidden: ['Reason', 'old-execution', 'requested', 'Replica time'],
    },
    {
      name: 'a first revision waiting for its probe',
      status: {
        state: WorkloadState.Starting,
        upgrade: null,
        applicationReady: false,
        reason: 'Waiting for the readiness probe to pass; new Jobs wait.',
      },
      fields: { generation: 1 },
      shown: ['🚀  starting', 'Reason'],
      hidden: ['Upgrade'],
    },
    {
      name: 'a failed upgrade',
      status: {
        state: WorkloadState.Failed,
        upgrade: { number: 1, state: WorkloadState.Failed },
        reason: 'CrashLoopBackOff: back-off restarting failed container',
      },
      fields: {},
      shown: [
        'failed',
        '✗ pod  failed: CrashLoopBackOff: back-off restarting failed container',
      ],
      hidden: ['◌', 'Reason'],
    },
    {
      name: 'a deletion waiting on Jobs',
      status: {
        state: WorkloadState.Terminated,
        releasing: true,
        upgrade: null,
        reason:
          'Deleting once its Jobs finish and are cleaned up; new Jobs are refused.',
        blockingJobs: {
          total: 1,
          jobs: [{ ...oldJob, state: WorkloadState.Completed }],
        },
      },
      fields: { deletionRequestedAt: 1 },
      shown: [
        'terminated · releasing',
        'Waiting on       old-job (completed, cleaning up)',
      ],
      hidden: ['Upgrade', 'VM'],
    },
    {
      name: 'an unreadable Kubernetes',
      status: {
        state: 'unknown',
        upgrade: null,
        observation: 'unavailable',
        observationError: 'Kubernetes request timed out',
        containerReady: null,
        applicationReady: null,
        probeConfigured: null,
        appliedGeneration: null,
        podGeneration: null,
      },
      fields: {},
      shown: ['❓  unknown', 'Last error       Kubernetes request timed out'],
      hidden: ['Upgrade'],
    },
  ] satisfies Array<{
    name: string;
    status: Partial<DeploymentStatus>;
    fields: Partial<DeploymentSummary>;
    shown: string[];
    hidden: string[];
  }>)(
    'shows $name and adds revisions and Pod identity under --verbose',
    async ({ status, fields, shown, hidden }) => {
      mocks.getDeployment.mockResolvedValue({
        deployment: observe(status, fields),
      });
      await runDeployment(['status', deployment.id]);
      const concise = printed();
      for (const text of shown) expect(concise).toContain(text);
      for (const text of hidden) expect(concise).not.toContain(text);
      expect(concise).not.toMatch(/generation|slot|warming|draining/iu);
      expect(concise).not.toContain('observed-pod');

      logSpy.mockClear();
      await runDeployment(['status', deployment.id, '--verbose']);
      const detailed = printed();
      const { appliedGeneration, podGeneration } = {
        ...readyStatus,
        ...status,
      };
      expect(detailed).toContain(
        `Revision         2 requested · ${appliedGeneration ?? 'unknown'} applied · ${podGeneration ?? 'unknown'} in Pod`,
      );
      expect(detailed).toMatch(/Pod UID\s+pod-uid/u);
      expect(mocks.getDeployment).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps a Pod failure that differs from the reason, once', async () => {
    const pendingReason = 'CrashLoopBackOff: back-off restarting';
    mocks.getDeployment.mockResolvedValue({
      deployment: observe(
        {
          upgrade: { number: 1, state: WorkloadState.Starting },
          reason: 'Replacing the Pod with revision 2; new Jobs wait.',
        },
        { workload: { ...readyDeployment.workload!, pendingReason } },
      ),
    });
    await runDeployment(['status', deployment.id]);
    expect(printed().split(pendingReason)).toHaveLength(2);
    expect(printed()).toContain(`Pending          ${pendingReason}`);
  });

  it.each([
    { total: 1, verbose: false, shown: 1, more: '' },
    { total: 12, verbose: false, shown: 3, more: ' · 9 more' },
    { total: 12, verbose: true, shown: 10, more: ' · 2 more' },
  ])(
    'lists $shown of $total blocking Jobs (verbose=$verbose)',
    async ({ total, verbose, shown, more }) => {
      mocks.getDeployment.mockResolvedValue({
        deployment: observe({
          upgrade: { number: 1, state: WorkloadState.Starting },
          blockingJobs: {
            total,
            jobs: Array.from({ length: Math.min(total, 10) }, (_, index) => ({
              id: `blocker-${String(index).padStart(2, '0')}`,
              executionId: `execution-${index}`,
              generation: 1,
              state: WorkloadState.Terminated,
            })),
          },
        }),
      });
      await runDeployment([
        'status',
        deployment.id,
        ...(verbose ? ['--verbose'] : []),
      ]);
      const output = printed();
      const facts = verbose
        ? 'terminated, cleaning up, revision 1'
        : 'terminated, cleaning up';
      expect(output).toContain(`blocker-00 (${facts})`);
      expect(output).toContain(
        `blocker-${String(shown - 1).padStart(2, '0')} (${facts})${more}`,
      );
      expect(output).not.toContain(`blocker-${String(shown).padStart(2, '0')}`);
      expect(output).not.toContain('execution-');
    },
  );

  it.each([['--json'], ['--json', '--verbose'], ['--verbose', '--json']])(
    'preserves complete numeric JSON with flags %j',
    async (...flags) => {
      mocks.getDeployment.mockResolvedValue({ deployment: readyDeployment });
      await runDeployment(['status', deployment.id, ...flags]);
      expect(logSpy).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify(readyDeployment),
      );
      expect(
        JSON.parse(logSpy.mock.calls[0]![0]).status.requestedGeneration,
      ).toBe(2);
      expect(mocks.printInfo).not.toHaveBeenCalled();
      expect(mocks.setJsonMode).toHaveBeenCalledWith(true);
      expect(mocks.getDeployment).toHaveBeenCalledExactlyOnceWith({
        params: { id: deployment.id },
      });
    },
  );

  it.each([
    ['create', 'deployment', 'example/image', '--node-pool', 'node-pool-a'],
    ['update', deployment.id, '--image', 'example/image'],
    ['delete', deployment.id],
  ])(
    'prints the fields alone for %s responses without runtime reads',
    async (...args) => {
      const inventory = { ...readyDeployment, status: null, workload: null };
      mocks.createDeployment.mockResolvedValue({ deployment: inventory });
      mocks.updateDeployment.mockResolvedValue({ deployment: inventory });
      mocks.deleteDeployment.mockResolvedValue({ deployment: inventory });
      await runDeployment(args);
      expect(printed()).toMatch(/Revision\s+2/u);
      expect(printed()).not.toMatch(/running|Upgrade|Reason/u);
      expect(mocks.getDeployment).not.toHaveBeenCalled();
    },
  );

  it('lists Deployments with REVISION, JOBS and the state stored facts settle', async () => {
    const listed = (fields: Partial<DeploymentSummary>) => ({
      ...readyDeployment,
      status: null,
      jobs: { ...readyDeployment.jobs, running: 1, unreleased: 1 },
      createdAt: Date.now() - 120_000,
      ...fields,
    });
    mocks.listDeployments.mockResolvedValue({
      deployments: [
        listed({}),
        listed({ id: 'deleting', deletionRequestedAt: 1 }),
        listed({ id: 'deleted', deletionRequestedAt: 1, deletedAt: 2 }),
      ],
    });

    await runDeployment(['list']);

    expect(logSpy).toHaveBeenCalledOnce();
    const [head, ...rows] = printed()
      .split('\n')
      .map((line) => line.trimEnd().split(/\s{2,}/u));
    expect(head).toEqual([
      'NAME',
      'ID',
      'NODE POOL',
      'REVISION',
      'REPLICAS',
      'JOBS',
      'AGE',
      'STATE',
    ]);
    expect(rows).toEqual([
      ['deployment', 'deployment-test', 'node-pool-a', '2', '-/1', '1/2', '2m'],
      [
        'deployment',
        'deleting',
        'node-pool-a',
        '2',
        '-/1',
        '1/2',
        '2m',
        'terminated · releasing',
      ],
      [
        'deployment',
        'deleted',
        'node-pool-a',
        '2',
        '-/1',
        '1/2',
        '2m',
        'terminated',
      ],
    ]);
    expect(mocks.getDeployment).not.toHaveBeenCalled();
  });
});
