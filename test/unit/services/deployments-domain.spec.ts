import { InvalidAnycloudConfigError } from '../../../src/shared/errors.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDeploymentsDomain,
  type DeploymentControl,
  type DeploymentsDomainDependencies,
} from '../../../src/api/services/deployments-domain.js';
import { DeploymentDomainError } from '../../../src/api/services/deployment-errors.js';
import type { StoredDeployment } from '../../../src/api/services/deployment-store.js';
import type { User } from '../../../src/api/services/entities.js';
import {
  getDeploymentStore,
  getPersistence,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import { KubernetesRbacPreflightError } from '../../../src/api/services/kubernetes/preflight.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { ImageRuntime, ImageVerdict } from '../../../src/shared/image.js';
import type { DockerOptions } from '../../../src/shared/runtime.js';
import { NodePoolState } from '../../../src/shared/node-pools.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import type { StoredNodePool } from '../../../src/api/services/cluster-store.js';
import type { UpdateDeploymentRequest } from '../../../src/shared/api-contract/deployments-schemas.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { makeContainerSpec } from '../helpers/fixtures.js';
import { seedReadyNodePool } from '../helpers/node-pool-seed.js';

const actor: User = {
  id: 'user-id',
  username: 'user',
  token: 'github-token',
};

const stored: StoredDeployment = {
  readinessProbe: null,
  gracePeriodSeconds: 30,
  id: 'deployment-id',
  ownerUserId: actor.id,
  name: 'deployment',
  nodePoolId: 'node-pool-id',
  config: makeContainerSpec({ image: 'example/deployment:latest' }),
  secretNames: [],
  gpuCount: 0,
  maxConcurrentJobsPerReplica: 1,
  minReplicas: 1,
  maxReplicas: 1,
  managed: false,
  apiIdentity: false,
  runnerRelease: null,
  generation: 1,
  deletionRequestedAt: null,
  deletedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

function dependencies(input?: {
  observe?: DeploymentControl['observe'];
  counts?: DeploymentsDomainDependencies['jobs']['counts'];
}): DeploymentsDomainDependencies {
  const counts =
    input?.counts ??
    vi.fn(async () => ({
      queued: 0,
      running: 0,
      retrying: 0,
      terminal: 0,
      unreleased: 0,
    }));
  const current = nodePool('t3.small');
  return {
    deployments: {
      create: vi.fn(async () => true),
      recordRunnerRelease: vi.fn(async () => undefined),
      getForScope: vi.fn(async () => stored),
      getById: vi.fn(async () => stored),
      getMetadataForScope: vi.fn(async () => stored),
      getMetadataById: vi.fn(async () => stored),
      listForScope: vi.fn(async () => [stored]),
      listForReconciliation: vi.fn(async () => [stored.id]),
      listDigestMetadataInWindow: vi.fn(async () => []),
      update: vi.fn(async () => 2),
      requestDeletion: vi.fn(async () => 'requested' as const),
      markDeleted: vi.fn(async () => true),
      advanceGeneration: vi.fn(async () => true),
      recordOccupancy: vi.fn(),
      getUsage: vi.fn(async () => ({
        replicaHours: 0,
        busyHours: 0,
        costUsd: 0,
        busyCostUsd: 0,
      })),
      countLiveForNodePool: vi.fn(async () => 0),
      countHoldingNodePool: vi.fn(async () => 0),
      listDeletingManaged: vi.fn(async () => []),
      listLiveManagedImages: vi.fn(async () => []),
      requestIdleDeletion: vi.fn(async () => false),
    },
    nodePools: {
      getForScope: vi.fn(async (id) => (id === current.id ? current : null)),
      getByNameForScope: vi.fn(async (name) =>
        name === current.name ? current : null,
      ),
    },
    observeNodePoolCapacity: vi.fn(async () => ({
      readyVmCount: 1,
      startingVmCount: 0,
      drainingVmCount: 0,
      locations: [],
    })),
    jobs: {
      counts,
      statusSnapshot: vi.fn(async (id) => ({
        counts: await counts(id),
        blockers: [],
      })),
      terminateUnassigned: vi.fn(async () => undefined),
    },
    preflightSecrets: vi.fn(async () => undefined),
    workloadApiUrl: () => 'https://api.example.com',
    runtime: {
      schedule: vi.fn(),
      validateTarget: vi.fn(async () => undefined),
      observe:
        input?.observe ??
        vi.fn(async () => ({
          workload: {
            observedGeneration: 1,
            podName: 'deployment-pod',
            podUid: 'pod-uid',
            containerId: 'containerd://container-id',
            containerReady: true,
            pendingReason: null,
          },
          appliedGeneration: 1,
          rolledOut: true,
          readyReplicas: 1,
          containerReady: true,
          containerRunning: true,
          containerFailed: false,
          podTerminating: false,
          probeConfigured: false,
          observedAt: 1,
        })),
    },
    resolveScope: vi.fn(async () => ({ kind: 'api' }) as const),
    generateId: vi.fn(() => stored.id),
    inspectImage: vi.fn(async () => {
      throw new Error('not used');
    }),
  };
}

function createInput() {
  return {
    name: 'deployment',
    image: 'example/deployment:latest',
    nodePool: 'training',
    maxConcurrentJobsPerReplica: 1,
    minReplicas: 1,
  };
}

function nodePool(
  vmType: string,
  overrides: Partial<StoredNodePool> = {},
): StoredNodePool {
  return {
    id: stored.nodePoolId,
    clusterId: 'cluster-a',
    ownerUserId: actor.id,
    name: 'training',
    state: NodePoolState.Ready,
    computeCredentialId: 'compute-credential',
    cloudProvider: CloudType.AWS,
    region: 'us-east-1',
    zone: null,
    clusterRegion: null,
    vmTypes: [vmType],
    minVmCount: 1,
    maxVmCount: 1,
    osDiskSizeGb: null,
    osDiskTier: null,
    spot: false,
    allowPrivilegedJobs: false,
    userNamespaceJobs: false,
    requireNestedVirtualization: false,
    lastError: null,
    provisioningFailures: 0,
    provisioningFailedAt: null,
    ingressEntryVmId: null,
    ingressEntryChangedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** Point both node pool lookups at one stored node pool (or none). */
function mockNodePool(
  deps: DeploymentsDomainDependencies,
  current: StoredNodePool | null,
): void {
  vi.mocked(deps.nodePools.getForScope).mockImplementation(async (id) =>
    current && id === current.id ? current : null,
  );
  vi.mocked(deps.nodePools.getByNameForScope).mockImplementation(
    async (name) => (current && name === current.name ? current : null),
  );
}

function creatingDependencies(): DeploymentsDomainDependencies {
  const result = dependencies();
  vi.mocked(result.deployments.getForScope).mockResolvedValue(null);
  return result;
}

describe('Deployments domain', () => {
  describe('atomic container option updates', () => {
    const dockerOptions: DockerOptions = {
      cpus: '4',
      memory: '8g',
      shmSize: '1g',
      gpus: 'all',
      runtime: 'nvidia',
      binds: ['/runtime', '/control'],
      privileged: true,
    };
    let deps: DeploymentsDomainDependencies;
    let before: StoredDeployment;

    beforeEach(async () => {
      resetPersistence();
      await seedReadyNodePool({
        nodePoolId: stored.nodePoolId,
        ownerUserId: actor.id,
        name: 'training',
        vmType: 'g4dn.12xlarge',
      });
      deps = dependencies();
      deps.deployments = getDeploymentStore();
      mockNodePool(deps, nodePool('g4dn.12xlarge'));
      await deps.deployments.create(
        {
          ...stored,
          gpuCount: 2,
          reservation: { maxGpus: 4 },
          config: makeContainerSpec({
            ...stored.config,
            command: ['python', 'deployment.py'],
            env: { MODEL: 'original' },
            registryUsername: 'original-user',
            registryToken: 'original-registry-token',
            dockerOptions,
          }),
        },
        { kind: 'api' },
      );
      const current = await deps.deployments.getById(stored.id);
      if (!current) throw new Error('Expected the persisted Deployment');
      before = current;
    });

    it('RA updates the replica bounds and refuses a maximum below the minimum', async () => {
      const domain = createDeploymentsDomain(deps);
      await domain.update(actor, before.id, { maxReplicas: 2 });
      await expect(deps.deployments.getById(before.id)).resolves.toMatchObject({
        minReplicas: 1,
        maxReplicas: 2,
      });
      await expect(
        domain.update(actor, before.id, { minReplicas: 3 }),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(deps.deployments.getById(before.id)).resolves.toMatchObject({
        minReplicas: 1,
        maxReplicas: 2,
        generation: 2,
      });
    });

    it('updates CPUs while retaining memory, GPU allocation, volumes, privilege and other configuration', async () => {
      const result = await createDeploymentsDomain(deps).update(
        actor,
        before.id,
        {
          dockerOptions: { cpus: '6' },
        },
      );

      expect(result.deployment.generation).toBe(2);
      expect(result.deployment.gpuCount).toBe(2);
      await expect(deps.deployments.getById(before.id)).resolves.toEqual({
        ...before,
        generation: 2,
        updatedAt: expect.any(Number),
        config: {
          ...before.config,
          dockerOptions: { ...dockerOptions, cpus: '6' },
        },
      });
      expect(deps.inspectImage).not.toHaveBeenCalled();
      expect(deps.runtime.schedule).toHaveBeenCalledExactlyOnceWith(before.id);
    });

    it('0036/S6 clears the options map and readmits GPU defaults only for whole-field null', async () => {
      await createDeploymentsDomain(deps).update(actor, before.id, {
        dockerOptions: null,
      });

      await expect(deps.deployments.getById(before.id)).resolves.toEqual({
        ...before,
        generation: 2,
        updatedAt: expect.any(Number),
        gpuCount: 4,
        config: { ...before.config, dockerOptions: null },
      });
      expect(deps.runtime.schedule).toHaveBeenCalledExactlyOnceWith(before.id);
    });

    it("RFC 0049 C32 says in its summary whether it runs privileged, for the next release's upgrade", async () => {
      const domain = createDeploymentsDomain(deps);
      await expect(domain.get(actor, before.id)).resolves.toMatchObject({
        deployment: { privileged: true },
      });
      await domain.update(actor, before.id, {
        dockerOptions: { privileged: false },
      });
      await expect(domain.get(actor, before.id)).resolves.toMatchObject({
        deployment: { privileged: false },
      });
    });

    it('RFC 0049 C32 refuses --privileged on a --user-namespace-jobs pool, on update and create', async () => {
      const userNamespacePool = nodePool('m7i.xlarge', {
        userNamespaceJobs: true,
      });
      mockNodePool(deps, userNamespacePool);
      const refusal =
        'Node pool "training" runs user-namespace Jobs, so its Deployments do not accept --privileged';
      await expect(
        createDeploymentsDomain(deps).update(actor, before.id, {
          dockerOptions: { privileged: true },
        }),
      ).rejects.toThrow(refusal);
      await expect(deps.deployments.getById(before.id)).resolves.toEqual(
        before,
      );
      const creating = creatingDependencies();
      mockNodePool(creating, userNamespacePool);
      await expect(
        createDeploymentsDomain(creating).create(actor, {
          ...createInput(),
          dockerOptions: { privileged: true },
        }),
      ).rejects.toThrow(refusal);
      expect(creating.deployments.create).not.toHaveBeenCalled();
    });

    it('removes only reset options and preserves explicit false and empty arrays', async () => {
      await createDeploymentsDomain(deps).update(actor, before.id, {
        dockerOptions: {
          memory: null,
          shmSize: null,
          binds: [],
          privileged: false,
        },
      });

      await expect(deps.deployments.getById(before.id)).resolves.toMatchObject({
        generation: 2,
        gpuCount: 2,
        config: {
          ...before.config,
          dockerOptions: {
            cpus: '4',
            gpus: 'all',
            runtime: 'nvidia',
            binds: [],
            privileged: false,
          },
        },
      });
      const updated = await deps.deployments.getById(before.id);
      expect(updated?.config.dockerOptions).not.toHaveProperty('memory');
      expect(updated?.config.dockerOptions).not.toHaveProperty('shmSize');
    });

    it('resets runtime, CPU, volumes and privilege without reallocating GPUs', async () => {
      await createDeploymentsDomain(deps).update(actor, before.id, {
        dockerOptions: {
          runtime: null,
          cpus: null,
          binds: null,
          privileged: null,
        },
      });

      const updated = await deps.deployments.getById(before.id);
      expect(updated?.config.dockerOptions).toEqual({
        gpus: 'all',
        memory: '8g',
        shmSize: '1g',
      });
      expect(updated?.gpuCount).toBe(2);
    });

    it.each([
      { gpus: '1', expected: 1 },
      { gpus: 'all', expected: 4 },
      { gpus: null, expected: 4 },
    ])(
      'readmits GPUs only when their intent is explicitly supplied: %j',
      async ({ gpus, expected }) => {
        await createDeploymentsDomain(deps).update(actor, before.id, {
          dockerOptions: { gpus },
        });

        const updated = await deps.deployments.getById(before.id);
        const expectedOptions = { ...dockerOptions };
        if (gpus === null) delete expectedOptions.gpus;
        else expectedOptions.gpus = gpus;
        expect(updated?.config).toEqual({
          ...before.config,
          dockerOptions: expectedOptions,
        });
        expect(updated?.gpuCount).toBe(expected);
      },
    );

    it.each([
      { cpus: '6', memory: '0' },
      { cpus: '6', gpus: '5' },
      { cpus: '6', runtime: 'runc' },
      { cpus: '6', binds: ['/host:/runtime'] },
      { cpus: '6', binds: ['/dev'] },
    ])(
      'rejects invalid merged options without any writes: %j',
      async (dockerOptions) => {
        await expect(
          createDeploymentsDomain(deps).update(actor, before.id, {
            dockerOptions,
            maxConcurrentJobsPerReplica: 3,
          }),
        ).rejects.toThrow();

        expect(await deps.deployments.getById(before.id)).toEqual(before);
        expect(deps.runtime.schedule).not.toHaveBeenCalled();
      },
    );

    it('rejects an unrelated CPU update when the admitted GPUs no longer fit', async () => {
      mockNodePool(deps, nodePool('g6e.xlarge'));
      await expect(
        createDeploymentsDomain(deps).update(actor, before.id, {
          dockerOptions: { cpus: '6' },
        }),
      ).rejects.toThrow('exceeds the 1 GPU');

      expect(await deps.deployments.getById(before.id)).toEqual(before);
      expect(deps.runtime.schedule).not.toHaveBeenCalled();
    });

    it('rejects a competing generation without lost settings and lets an explicit retry merge fresh state', async () => {
      let release!: () => void;
      const bothValidated = new Promise<void>((resolve) => {
        release = resolve;
      });
      let arrivals = 0;
      vi.mocked(deps.runtime.validateTarget).mockImplementation(async () => {
        if (++arrivals === 2) release();
        await bothValidated;
      });
      const update = vi.spyOn(deps.deployments, 'update');
      const domain = createDeploymentsDomain(deps);
      const requests: UpdateDeploymentRequest[] = [
        { dockerOptions: { cpus: '6' } },
        {
          dockerOptions: { memory: '16g' },
          maxConcurrentJobsPerReplica: 3,
        },
      ];
      const results = await Promise.allSettled(
        requests.map((request) => domain.update(actor, before.id, request)),
      );
      const winner = results.findIndex(
        (result) => result.status === 'fulfilled',
      );
      const loser = results.findIndex((result) => result.status === 'rejected');
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(results[loser]).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ statusCode: 409 }),
      });
      const failure = results[loser];
      if (failure?.status === 'rejected')
        expect(failure.reason).toBeInstanceOf(DeploymentDomainError);
      expect(update).toHaveBeenCalledTimes(2);
      expect(deps.runtime.schedule).toHaveBeenCalledOnce();
      const winningOptions =
        winner === 0
          ? { ...dockerOptions, cpus: '6' }
          : { ...dockerOptions, memory: '16g' };
      await expect(deps.deployments.getById(before.id)).resolves.toMatchObject({
        generation: 2,
        gpuCount: 2,
        maxConcurrentJobsPerReplica: winner === 0 ? 1 : 3,
        config: { ...before.config, dockerOptions: winningOptions },
      });

      await domain.update(actor, before.id, requests[loser]!);
      await expect(deps.deployments.getById(before.id)).resolves.toMatchObject({
        generation: 3,
        gpuCount: 2,
        maxConcurrentJobsPerReplica: 3,
        config: {
          ...before.config,
          dockerOptions: {
            ...dockerOptions,
            cpus: '6',
            memory: '16g',
          },
        },
      });
    });

    it('rolls back the entire update when writing container options fails', async () => {
      await getDB().query(`CREATE TRIGGER fail_deployment_option_update
        BEFORE UPDATE ON container_specs
        BEGIN SELECT RAISE(ABORT, 'injected option update failure'); END`);

      await expect(
        createDeploymentsDomain(deps).update(actor, before.id, {
          dockerOptions: { cpus: '6', gpus: '1' },
          env: { MODEL: 'new' },
          maxConcurrentJobsPerReplica: 3,
        }),
      ).rejects.toThrow('injected option update failure');

      expect(await deps.deployments.getById(before.id)).toEqual(before);
      expect(deps.runtime.schedule).not.toHaveBeenCalled();
    });
  });

  describe('listing by node pool', () => {
    it.each(Object.values(NodePoolState))(
      'lists Deployments for a %s node pool without runtime checks',
      async (state) => {
        const deps = dependencies();
        mockNodePool(deps, nodePool('t3.small', { state }));

        const result = await createDeploymentsDomain(deps).list(actor, {
          nodePool: stored.nodePoolId,
        });

        expect(result.deployments.map((deployment) => deployment.id)).toEqual([
          stored.id,
        ]);
        expect(result.deployments[0]?.workload).toBeNull();
        expect(result.deployments[0]?.status).toBeNull();
        expect(deps.jobs.statusSnapshot).not.toHaveBeenCalled();
        expect(deps.deployments.listForScope).toHaveBeenCalledWith(
          { kind: 'api' },
          { nodePoolId: stored.nodePoolId },
        );
        expect(deps.nodePools.getByNameForScope).not.toHaveBeenCalled();
        expect(deps.runtime.validateTarget).not.toHaveBeenCalled();
        expect(deps.runtime.observe).not.toHaveBeenCalled();
      },
    );

    it('does not resolve a node pool for unfiltered listing', async () => {
      const deps = dependencies();
      expect(
        (await createDeploymentsDomain(deps).list(actor)).deployments,
      ).toHaveLength(1);
      expect(deps.nodePools.getForScope).not.toHaveBeenCalled();
      expect(deps.nodePools.getByNameForScope).not.toHaveBeenCalled();
    });

    it('cancels before reading Deployment inventory when the node pool lookup is interrupted', async () => {
      const deps = dependencies();
      const controller = new AbortController();
      vi.mocked(deps.nodePools.getForScope).mockImplementation(async () => {
        controller.abort();
        return nodePool('t3.small');
      });
      await expect(
        createDeploymentsDomain(deps).list(
          actor,
          { nodePool: stored.nodePoolId },
          controller.signal,
        ),
      ).rejects.toThrow();
      expect(deps.deployments.listForScope).not.toHaveBeenCalled();
    });

    describe('ownership and name resolution', () => {
      beforeEach(async () => {
        resetPersistence();
        for (const [id, name, ownerUserId] of [
          [stored.nodePoolId, 'training', actor.id],
          ['node-pool-other', 'private', 'other-user'],
          ['node-pool-empty', 'empty', actor.id],
        ] as const) {
          await seedReadyNodePool({ nodePoolId: id, name, ownerUserId });
        }
        const deployments = getDeploymentStore();
        await deployments.create({ ...stored }, { kind: 'api' });
        await deployments.create(
          {
            ...stored,
            id: 'teammate-deployment',
            name: 'teammate',
            ownerUserId: 'other-user',
          },
          { kind: 'api' },
        );
        await deployments.create(
          {
            ...stored,
            id: 'private-deployment',
            name: 'private',
            nodePoolId: 'node-pool-other',
            ownerUserId: 'other-user',
          },
          { kind: 'api' },
        );
      });

      function domainForScope() {
        const deps = dependencies();
        deps.nodePools = getPersistence().nodePools;
        deps.deployments = getDeploymentStore();
        vi.mocked(deps.resolveScope).mockResolvedValue({ kind: 'api' });
        return createDeploymentsDomain(deps);
      }

      it('treats an unknown node pool as not found', async () => {
        await expect(
          domainForScope().list(actor, { nodePool: 'missing' }),
        ).rejects.toMatchObject({
          statusCode: 400,
          message: 'Node pool not found',
        });
      });

      it('includes teammates on the selected node pool', async () => {
        const result = await domainForScope().list(actor, {
          nodePool: 'training',
        });
        expect(
          result.deployments.map((deployment) => deployment.id).sort(),
        ).toEqual([stored.id, 'teammate-deployment'].sort());
        expect(
          (
            await domainForScope().list(actor, { nodePool: 'private' })
          ).deployments.map((deployment) => deployment.id),
        ).toEqual(['private-deployment']);
      });

      it('returns an empty list for an accessible node pool without Deployments', async () => {
        await expect(
          domainForScope().list(actor, { nodePool: 'empty' }),
        ).resolves.toEqual({ deployments: [] });
      });

      it('lists every Deployment without a filter', async () => {
        expect((await domainForScope().list(actor)).deployments).toHaveLength(
          3,
        );
      });
    });
  });

  it('0036/S5 keeps trigger-enforced Deployment identity collisions as a public conflict', async () => {
    const deps = creatingDependencies();
    vi.mocked(deps.inspectImage).mockResolvedValue({
      verdict: ImageVerdict.Ok,
      amd64Digest: null,
      imageRuntime: ImageRuntime.Unknown,
      compressedLayerBytes: null,
    });
    vi.mocked(deps.deployments.create).mockRejectedValue(
      new Error('Deployment identity already exists'),
    );
    await expect(
      createDeploymentsDomain(deps).create(actor, createInput()),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it('preserves desired configuration with unknown live status during Kubernetes failure', async () => {
    const observe = vi.fn().mockRejectedValue(new Error('connection refused'));
    const domain = createDeploymentsDomain(dependencies({ observe }));

    await expect(domain.get(actor, stored.id)).resolves.toMatchObject({
      deployment: {
        id: stored.id,
        generation: stored.generation,
        workload: null,
        status: {
          state: 'unknown',
          observation: 'unavailable',
          observationError: 'connection refused',
          appliedGeneration: null,
          podGeneration: null,
          podUid: null,
          containerId: null,
          containerReady: null,
          applicationReady: null,
          observedAt: null,
        },
      },
    });
    expect(observe).toHaveBeenCalledWith(stored, expect.any(AbortSignal));
    expect(observe.mock.calls[0][1].aborted).toBe(true);
  });

  it('bounds a hung Kubernetes observation and releases its signal', async () => {
    vi.useFakeTimers();
    try {
      const observe = vi.fn<DeploymentControl['observe']>(
        () => new Promise(() => {}),
      );
      const pending = createDeploymentsDomain(dependencies({ observe })).get(
        actor,
        stored.id,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toMatchObject({
        deployment: {
          status: { observation: 'unavailable', applicationReady: null },
        },
      });
      expect(observe.mock.calls[0][1]?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates caller cancellation instead of returning a successful unknown status', async () => {
    const caller = new AbortController();
    const failure = new Error('client disconnected');
    const observe = vi.fn<DeploymentControl['observe']>(
      async (_deployment, signal) => {
        caller.abort(failure);
        signal?.throwIfAborted();
        throw new Error('unreachable');
      },
    );
    await expect(
      createDeploymentsDomain(dependencies({ observe })).get(
        actor,
        stored.id,
        caller.signal,
      ),
    ).rejects.toBe(failure);
    expect(observe.mock.calls[0][1]?.aborted).toBe(true);
  });

  it('authorizes before status reads and avoids Kubernetes after deletion', async () => {
    const deps = dependencies();
    vi.mocked(deps.deployments.getForScope).mockResolvedValueOnce(null);
    await expect(
      createDeploymentsDomain(deps).get(actor, stored.id),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(deps.runtime.observe).not.toHaveBeenCalled();
    expect(deps.jobs.statusSnapshot).not.toHaveBeenCalled();
    vi.mocked(deps.deployments.getForScope).mockResolvedValueOnce({
      ...stored,
      deletedAt: 2,
    });
    await expect(
      createDeploymentsDomain(deps).get(actor, stored.id),
    ).resolves.toMatchObject({
      deployment: {
        status: {
          state: WorkloadState.Terminated,
          releasing: false,
          observation: 'not-requested',
        },
      },
    });
    expect(deps.runtime.observe).not.toHaveBeenCalled();
  });

  it('does not disguise persistence failures as runtime unavailability', async () => {
    const failure = new Error('database unavailable');
    const counts = vi.fn().mockRejectedValue(failure);
    const domain = createDeploymentsDomain(dependencies({ counts }));

    await expect(domain.get(actor, stored.id)).rejects.toBe(failure);
  });

  it('refuses a Deployment whose replicas would claim from a loopback URL', async () => {
    const deps = {
      ...creatingDependencies(),
      workloadApiUrl: () => 'http://127.0.0.1:8080',
    };

    await expect(
      createDeploymentsDomain(deps).create(actor, createInput()),
    ).rejects.toMatchObject({
      name: 'DeploymentDomainError',
      statusCode: 400,
      message:
        "Pods can't reach this API to claim Jobs: its workload URL http://127.0.0.1:8080 is loopback. Run Deployments and Jobs on node pools through the cluster's API: `anycloud api use https://<cluster-id>.anycloud.sh`.",
    });
    expect(deps.deployments.create).not.toHaveBeenCalled();
  });

  it('maps Kubernetes runtime validation failures to unavailable', async () => {
    const deps = creatingDependencies();
    vi.mocked(deps.runtime.validateTarget).mockRejectedValue(
      new Error('connection refused'),
    );
    const domain = createDeploymentsDomain(deps);

    await expect(domain.create(actor, createInput())).rejects.toMatchObject({
      name: 'DeploymentDomainError',
      statusCode: 503,
      message: 'Kubernetes Deployment validation failed: connection refused',
    });
    expect(deps.deployments.create).not.toHaveBeenCalled();
  });

  it('maps Kubernetes RBAC preflight rejections to invalid requests', async () => {
    const deps = creatingDependencies();
    const failure = new KubernetesRbacPreflightError(
      'Kubernetes Deployment RBAC preflight failed: create deployments',
    );
    vi.mocked(deps.runtime.validateTarget).mockRejectedValue(failure);
    const domain = createDeploymentsDomain(deps);

    await expect(domain.create(actor, createInput())).rejects.toMatchObject({
      name: 'DeploymentDomainError',
      statusCode: 400,
      message: failure.message,
    });
    expect(deps.deployments.create).not.toHaveBeenCalled();
  });

  it('preserves request cancellation during Kubernetes validation', async () => {
    const deps = creatingDependencies();
    const controller = new AbortController();
    const reason = new DOMException('cancelled', 'AbortError');
    vi.mocked(deps.runtime.validateTarget).mockImplementation(async () => {
      controller.abort(reason);
      throw new Error('connection refused');
    });
    const domain = createDeploymentsDomain(deps);

    await expect(
      domain.create(actor, createInput(), controller.signal),
    ).rejects.toBe(reason);
    expect(deps.deployments.create).not.toHaveBeenCalled();
  });

  it('does not create after cancellation during successful validation', async () => {
    const deps = creatingDependencies();
    const controller = new AbortController();
    const reason = new DOMException('cancelled', 'AbortError');
    vi.mocked(deps.inspectImage).mockImplementation(async () => {
      controller.abort(reason);
      return {
        verdict: ImageVerdict.Ok,
        amd64Digest: null,
        imageRuntime: ImageRuntime.Unknown,
        compressedLayerBytes: null,
      };
    });
    const domain = createDeploymentsDomain(deps);

    await expect(
      domain.create(actor, createInput(), controller.signal),
    ).rejects.toBe(reason);
    expect(deps.deployments.create).not.toHaveBeenCalled();
    expect(deps.runtime.schedule).not.toHaveBeenCalled();
  });

  it('refuses an unknown Secret before persisting a create or update', async () => {
    const deps = creatingDependencies();
    const missing = new InvalidAnycloudConfigError('Secret "db" not found');
    vi.mocked(deps.preflightSecrets).mockRejectedValue(missing);
    const domain = createDeploymentsDomain(deps);

    await expect(
      domain.create(actor, { ...createInput(), secrets: ['db'] }),
    ).rejects.toBe(missing);
    vi.mocked(deps.deployments.getForScope).mockResolvedValue({
      ...stored,
      secretNames: ['db'],
    });
    await expect(
      domain.update(actor, stored.id, { maxConcurrentJobsPerReplica: 2 }),
    ).rejects.toBe(missing);
    expect(deps.preflightSecrets).toHaveBeenCalledWith(['db']);
    expect(deps.deployments.create).not.toHaveBeenCalled();
    expect(deps.deployments.update).not.toHaveBeenCalled();
  });

  it.each([
    { secrets: undefined, expected: ['db'] },
    { secrets: ['tracking'], expected: ['tracking'] },
    { secrets: null, expected: [] },
  ])(
    'updates Secret references $secrets to $expected',
    async ({ secrets, expected }) => {
      const deps = dependencies();
      vi.mocked(deps.deployments.getForScope).mockResolvedValue({
        ...stored,
        secretNames: ['db'],
      });
      await createDeploymentsDomain(deps).update(actor, stored.id, {
        maxConcurrentJobsPerReplica: 2,
        secrets,
      });
      expect(deps.preflightSecrets).toHaveBeenCalledWith(expected);
      expect(deps.deployments.update).toHaveBeenCalledWith(
        expect.objectContaining({ secretNames: expected }),
        { kind: 'api' },
      );
    },
  );

  it('decision 29 lists a managed Deployment read-only: update and delete refuse it', async () => {
    const deps = dependencies();
    const managed = { ...stored, managed: true };
    vi.mocked(deps.deployments.getForScope).mockResolvedValue(managed);
    vi.mocked(deps.deployments.listForScope).mockResolvedValue([managed]);
    const domain = createDeploymentsDomain(deps);

    expect((await domain.list(actor)).deployments[0]?.managed).toBe(true);
    for (const attempt of [
      domain.update(actor, stored.id, { maxConcurrentJobsPerReplica: 2 }),
      domain.delete(actor, stored.id),
    ]) {
      await expect(attempt).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining(
          'runs Jobs submitted with job --node-pool',
        ),
      });
    }
    expect(deps.deployments.update).not.toHaveBeenCalled();
    expect(deps.deployments.requestDeletion).not.toHaveBeenCalled();
  });

  it('validates Kubernetes access before persisting an update', async () => {
    const deps = dependencies();
    const failure = new KubernetesRbacPreflightError(
      'Kubernetes Deployment RBAC preflight failed: create deployments',
    );
    vi.mocked(deps.runtime.validateTarget).mockRejectedValue(failure);
    const domain = createDeploymentsDomain(deps);

    await expect(
      domain.update(actor, stored.id, { maxConcurrentJobsPerReplica: 2 }),
    ).rejects.toMatchObject({
      name: 'DeploymentDomainError',
      statusCode: 400,
      message: failure.message,
    });
    expect(deps.runtime.validateTarget).toHaveBeenCalledWith(
      { kind: 'nodePool', nodePoolId: stored.nodePoolId },
      undefined,
    );
    expect(deps.deployments.update).not.toHaveBeenCalled();
  });

  it('does not update after cancellation during successful validation', async () => {
    const deps = dependencies();
    const controller = new AbortController();
    const reason = new DOMException('cancelled', 'AbortError');
    vi.mocked(deps.runtime.validateTarget).mockImplementation(async () => {
      controller.abort(reason);
    });
    const domain = createDeploymentsDomain(deps);

    await expect(
      domain.update(
        actor,
        stored.id,
        { maxConcurrentJobsPerReplica: 2 },
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(deps.deployments.update).not.toHaveBeenCalled();
    expect(deps.runtime.schedule).not.toHaveBeenCalled();
  });

  it.each<{
    name: string;
    capacity: StoredNodePool;
    options?: DockerOptions;
    expected: number;
  }>([
    {
      name: 'defaults to zero on CPU capacity',
      capacity: nodePool('t3.small'),
      expected: 0,
    },
    {
      name: 'defaults to all GPUs on one NVIDIA capacity VM',
      capacity: {
        ...nodePool('g4dn.12xlarge'),
        minVmCount: 3,
        maxVmCount: 3,
      },
      expected: 4,
    },
    {
      name: 'resolves explicit all to per-VM supply',
      capacity: nodePool('g4dn.12xlarge'),
      options: { gpus: 'all' },
      expected: 4,
    },
    {
      name: 'accepts a positive count within GPU capacity',
      capacity: nodePool('g4dn.12xlarge'),
      options: { gpus: '2' },
      expected: 2,
    },
    {
      name: 'defaults explicit NVIDIA runtime to all GPUs',
      capacity: nodePool('g4dn.12xlarge'),
      options: { runtime: 'nvidia' },
      expected: 4,
    },
    {
      name: 'accepts the default runtime on CPU capacity',
      capacity: nodePool('t3.small'),
      options: { runtime: 'runc' },
      expected: 0,
    },
  ])('0029/S18 $name', async ({ capacity, options, expected }) => {
    const deps = creatingDependencies();
    mockNodePool(deps, capacity);
    vi.mocked(deps.inspectImage).mockResolvedValue({
      verdict: ImageVerdict.Ok,
      amd64Digest: null,
      imageRuntime: ImageRuntime.Unknown,
      compressedLayerBytes: null,
    });

    await createDeploymentsDomain(deps).create(actor, {
      ...createInput(),
      dockerOptions: options,
    });

    expect(deps.deployments.create).toHaveBeenCalledWith(
      expect.objectContaining({
        gpuCount: expected,
        config: expect.objectContaining({ dockerOptions: options ?? null }),
      }),
      expect.anything(),
    );
  });

  it.each<{
    name: string;
    capacity: StoredNodePool | null;
    options?: DockerOptions;
    message: RegExp;
  }>([
    {
      name: 'rejects GPUs on CPU capacity',
      capacity: nodePool('t3.small'),
      options: { gpus: '1' },
      message: /require an NVIDIA CUDA VM/,
    },
    {
      name: 'rejects NVIDIA runtime on CPU capacity',
      capacity: nodePool('t3.small'),
      options: { runtime: 'nvidia' },
      message: /require an NVIDIA CUDA VM/,
    },
    {
      name: 'rejects a count above per-VM GPU capacity',
      capacity: nodePool('g4dn.12xlarge'),
      options: { gpus: '5' },
      message: /exceeds the 4 GPU/,
    },
    {
      name: 'rejects unsupported Neuron capacity even without GPU options',
      capacity: nodePool('trn1.2xlarge'),
      message: /require verified CPU or NVIDIA CUDA capacity/,
    },
    {
      name: 'rejects unsupported ROCm capacity even without GPU options',
      capacity: {
        ...nodePool('Standard_ND96isr_MI300X_v5'),
        cloudProvider: CloudType.Azure,
      },
      message: /require verified CPU or NVIDIA CUDA capacity/,
    },
    {
      name: 'rejects an unclassified capacity default',
      capacity: nodePool('not-in-the-catalog'),
      message: /GPU capacity cannot be verified/,
    },
    {
      name: 'rejects unverifiable GPU supply despite the VM catalog-gap escape hatch',
      capacity: {
        ...nodePool('Standard_NC144ds_xl_RTXPRO6000BSE_v6'),
        cloudProvider: CloudType.Azure,
      },
      options: { gpus: 'all' },
      message: /GPU capacity cannot be verified/,
    },
    {
      name: 'rejects a node pool that no longer exists',
      capacity: null,
      message: /[Nn]ode pool/,
    },
    {
      name: 'rejects GPU access on known non-CUDA capacity',
      capacity: nodePool('trn1.2xlarge'),
      options: { gpus: 'all' },
      message: /require an NVIDIA CUDA VM/,
    },
    {
      name: 'rejects an explicit runc runtime with automatic NVIDIA allocation',
      capacity: nodePool('g4dn.12xlarge'),
      options: { runtime: 'runc' },
      message: /runc/,
    },
  ])('0029/S18 $name', async ({ capacity, options, message }) => {
    const deps = creatingDependencies();
    mockNodePool(deps, capacity);

    await expect(
      createDeploymentsDomain(deps).create(actor, {
        ...createInput(),
        dockerOptions: options,
      }),
    ).rejects.toThrow(message);
    expect(deps.deployments.create).not.toHaveBeenCalled();
    vi.mocked(deps.deployments.getForScope).mockResolvedValue(stored);
    await expect(
      createDeploymentsDomain(deps).update(actor, stored.id, {
        dockerOptions: options,
      }),
    ).rejects.toThrow(message);
    expect(deps.deployments.update).not.toHaveBeenCalled();
    expect(deps.runtime.validateTarget).not.toHaveBeenCalled();
    expect(deps.runtime.schedule).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', '1.5', '01', 'device=0', 'ALL', '9007199254740992'])(
    '0029/S18 rejects invalid GPU request %s before persistence on create and update',
    async (gpus) => {
      const deps = creatingDependencies();
      mockNodePool(deps, nodePool('g4dn.12xlarge'));
      const domain = createDeploymentsDomain(deps);
      await expect(
        domain.create(actor, { ...createInput(), dockerOptions: { gpus } }),
      ).rejects.toThrow(/--gpus/);
      vi.mocked(deps.deployments.getForScope).mockResolvedValue(stored);
      await expect(
        domain.update(actor, stored.id, { dockerOptions: { gpus } }),
      ).rejects.toThrow(/--gpus/);
      expect(deps.deployments.create).not.toHaveBeenCalled();
      expect(deps.deployments.update).not.toHaveBeenCalled();
    },
  );

  it('0029/S18 does not infer GPU access from a CUDA image on CPU capacity', async () => {
    const deps = creatingDependencies();
    vi.mocked(deps.inspectImage).mockResolvedValue({
      verdict: ImageVerdict.Ok,
      amd64Digest: null,
      imageRuntime: ImageRuntime.Cuda,
      compressedLayerBytes: null,
    });
    await createDeploymentsDomain(deps).create(actor, createInput());
    expect(deps.deployments.create).toHaveBeenCalledWith(
      expect.objectContaining({ gpuCount: 0 }),
      expect.anything(),
    );
  });

  it.each([ImageRuntime.Cuda, ImageRuntime.Rocm, ImageRuntime.Unknown])(
    'checks image runtime %s against NVIDIA capacity on create and explicit image update',
    async (imageRuntime) => {
      const deps = creatingDependencies();
      mockNodePool(deps, nodePool('g4dn.12xlarge'));
      vi.mocked(deps.inspectImage).mockResolvedValue({
        verdict: ImageVerdict.Ok,
        amd64Digest: null,
        imageRuntime,
        compressedLayerBytes: null,
      });
      const domain = createDeploymentsDomain(deps);
      const created = domain.create(actor, createInput());
      if (imageRuntime === ImageRuntime.Rocm) {
        await expect(created).rejects.toThrow('ROCM GPU runtime incompatible');
        expect(deps.deployments.create).not.toHaveBeenCalled();
      } else {
        await created;
        expect(deps.deployments.create).toHaveBeenCalled();
      }
      vi.mocked(deps.deployments.getForScope).mockResolvedValue({
        ...stored,
        gpuCount: 2,
      });
      const updated = domain.update(actor, stored.id, {
        image: 'deployment:v2',
      });
      if (imageRuntime === ImageRuntime.Rocm) {
        await expect(updated).rejects.toThrow('ROCM GPU runtime incompatible');
        expect(deps.deployments.update).not.toHaveBeenCalled();
        expect(deps.runtime.schedule).not.toHaveBeenCalled();
      } else {
        await updated;
        expect(deps.deployments.update).toHaveBeenCalledWith(
          expect.objectContaining({ gpuCount: 2 }),
          expect.anything(),
        );
      }
    },
  );

  it.each([
    { options: null, gpuCount: 2 },
    { options: { gpus: 'all' }, gpuCount: 2 },
    { options: { gpus: '2' }, gpuCount: 2 },
  ])(
    '0036/S6 retains admitted GPU allocation after catalog supply increases: %j',
    async ({ options, gpuCount }) => {
      const current = {
        ...stored,
        config: { ...stored.config, dockerOptions: options },
        gpuCount,
      };
      const deps = dependencies();
      vi.mocked(deps.deployments.getForScope).mockResolvedValue(current);
      mockNodePool(deps, nodePool('g4dn.12xlarge'));

      await createDeploymentsDomain(deps).update(actor, current.id, {
        maxConcurrentJobsPerReplica: 2,
      });

      expect(deps.deployments.update).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedGeneration: 1,
          gpuCount,
          config: expect.objectContaining({ dockerOptions: options }),
        }),
        expect.anything(),
      );
      expect(deps.inspectImage).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['g6e.xlarge', /exceeds the 1 GPU/],
    ['t3.small', /require an NVIDIA CUDA VM/],
    ['not-in-the-catalog', /GPU capacity cannot be verified/],
    ['trn1.2xlarge', /require verified CPU or NVIDIA CUDA capacity/],
  ] as const)(
    'rejects a retained two-GPU allocation on corrected %s capacity',
    async (vmType, message) => {
      const deps = dependencies();
      const current = { ...stored, gpuCount: 2 };
      vi.mocked(deps.deployments.getForScope).mockResolvedValue(current);
      mockNodePool(deps, nodePool(vmType));
      await expect(
        createDeploymentsDomain(deps).update(actor, stored.id, {
          env: { UPDATED: 'true' },
        }),
      ).rejects.toThrow(message);
      expect(deps.deployments.update).not.toHaveBeenCalled();
      expect(deps.runtime.schedule).not.toHaveBeenCalled();
      expect(deps.runtime.validateTarget).not.toHaveBeenCalled();
      expect(current.gpuCount).toBe(2);
      expect(current.config).toEqual(stored.config);
    },
  );

  it('0036/S13 preserves inherited environment and registry identity on an unrelated update', async () => {
    const current = {
      ...stored,
      config: makeContainerSpec({
        env: {
          ANYCLOUD_CLUSTER_DEPLOYMENT_ID: 'legacy-value',
          PRIVATE: 'environment-canary',
        },
        registryUsername: 'original-registry-user',
        registryToken: 'original-token-canary',
      }),
    };
    const deps = dependencies();
    vi.mocked(deps.deployments.getForScope).mockResolvedValue(current);
    await createDeploymentsDomain(deps).update(actor, current.id, {
      maxConcurrentJobsPerReplica: 2,
    });
    expect(deps.deployments.update).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGeneration: current.generation,
        config: current.config,
      }),
      { kind: 'api' },
    );
  });

  it('0036/S18 exposes environment names but not container credentials or environment values', async () => {
    const current = {
      ...stored,
      secretNames: ['db'],
      config: makeContainerSpec({
        env: { PRIVATE: 'environment-canary' },
        registryUsername: 'registry-user-canary',
        registryToken: 'registry-token-canary',
      }),
    };
    const deps = dependencies();
    vi.mocked(deps.deployments.getForScope).mockResolvedValue(current);
    const result = await createDeploymentsDomain(deps).get(actor, current.id);
    expect(result.deployment.envKeys).toEqual(['PRIVATE']);
    expect(result.deployment.secretNames).toEqual(['db']);
    for (const canary of [
      'environment-canary',
      'registry-user-canary',
      'registry-token-canary',
    ]) {
      expect(JSON.stringify(result)).not.toContain(canary);
    }
  });

  describe('targeting a node pool', () => {
    const readyPool: StoredNodePool = {
      id: 'node-pool-aws-east',
      clusterId: 'cluster-a',
      ownerUserId: actor.id,
      name: 'aws-east',
      state: NodePoolState.Ready,
      computeCredentialId: 'compute-credential',
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      zone: null,
      clusterRegion: null,
      vmTypes: ['g4dn.12xlarge'],
      minVmCount: 2,
      maxVmCount: 2,
      osDiskSizeGb: null,
      osDiskTier: null,
      spot: false,
      allowPrivilegedJobs: false,
      userNamespaceJobs: false,
      requireNestedVirtualization: false,
      lastError: null,
      provisioningFailures: 0,
      provisioningFailedAt: null,
      ingressEntryVmId: null,
      ingressEntryChangedAt: null,
      createdAt: 1,
      updatedAt: 1,
    };

    function nodePoolDependencies(
      overrides: Partial<StoredNodePool> = {},
    ): DeploymentsDomainDependencies {
      const deps = creatingDependencies();
      const current = { ...readyPool, ...overrides };
      vi.mocked(deps.nodePools.getForScope).mockImplementation(async (id) =>
        id === current.id ? current : null,
      );
      vi.mocked(deps.nodePools.getByNameForScope).mockImplementation(
        async (name) => (name === current.name ? current : null),
      );
      vi.mocked(deps.inspectImage).mockResolvedValue({
        verdict: ImageVerdict.Ok,
        amd64Digest: 'sha256:digest',
        imageRuntime: ImageRuntime.Cuda,
        compressedLayerBytes: null,
      });
      vi.mocked(deps.deployments.getById).mockResolvedValue({
        ...stored,
        nodePoolId: current.id,
      });
      return deps;
    }

    function nodePoolInput(dockerOptions?: DockerOptions) {
      return {
        name: 'deployment',
        image: 'ghcr.io/example/cuda:latest',
        nodePool: 'aws-east',
        maxConcurrentJobsPerReplica: 1,
        minReplicas: 1,
        ...(dockerOptions ? { dockerOptions } : {}),
      };
    }

    it('admits against a Ready node pool by name, validates the node pool runtime and reserves GPU devices against its ready Nodes', async () => {
      const deps = nodePoolDependencies();
      vi.mocked(deps.observeNodePoolCapacity).mockResolvedValue({
        readyVmCount: 2,
        startingVmCount: 0,
        drainingVmCount: 0,
        locations: [],
      });
      const response = await createDeploymentsDomain(deps).create(
        actor,
        nodePoolInput({ gpus: '2' }),
      );
      expect(response.deployment).toMatchObject({
        nodePoolId: readyPool.id,
        target: { kind: 'nodePool', nodePoolId: readyPool.id },
      });
      expect(deps.runtime.validateTarget).toHaveBeenCalledWith(
        { kind: 'nodePool', nodePoolId: readyPool.id },
        undefined,
      );
      expect(deps.deployments.create).toHaveBeenCalledWith(
        expect.objectContaining({
          nodePoolId: readyPool.id,
          gpuCount: 2,
          // Two ready g4dn.12xlarge Nodes advertise 4 devices each.
          reservation: { maxGpus: 8 },
        }),
        { kind: 'api' },
      );
      expect(deps.runtime.schedule).toHaveBeenCalledWith(stored.id);
    });

    it('refuses a node pool without ready Nodes and reports a lost reservation race as a conflict', async () => {
      const deps = nodePoolDependencies();
      vi.mocked(deps.observeNodePoolCapacity).mockResolvedValue({
        readyVmCount: 0,
        startingVmCount: 1,
        drainingVmCount: 0,
        locations: [],
      });
      await expect(
        createDeploymentsDomain(deps).create(actor, nodePoolInput()),
      ).rejects.toMatchObject({
        statusCode: 409,
        message:
          'Node pool "aws-east" has no ready Nodes to run this Deployment',
      });
      expect(deps.deployments.create).not.toHaveBeenCalled();

      vi.mocked(deps.observeNodePoolCapacity).mockResolvedValue({
        readyVmCount: 1,
        startingVmCount: 0,
        drainingVmCount: 0,
        locations: [],
      });
      vi.mocked(deps.deployments.create).mockResolvedValue(false);
      await expect(
        createDeploymentsDomain(deps).create(
          actor,
          nodePoolInput({ gpus: '1' }),
        ),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining('ready GPU capacity was reserved'),
      });
      expect(deps.deployments.create).toHaveBeenCalledWith(
        expect.objectContaining({ reservation: { maxGpus: 4 }, gpuCount: 1 }),
        expect.anything(),
      );

      vi.mocked(deps.observeNodePoolCapacity).mockRejectedValue(
        new Error('cluster unreachable'),
      );
      await expect(
        createDeploymentsDomain(deps).create(actor, nodePoolInput()),
      ).rejects.toMatchObject({ statusCode: 503 });
    });

    it('refuses a handler that would allocate no devices on a GPU node pool', async () => {
      const deps = nodePoolDependencies();
      // GPU access defaults to every device on NVIDIA capacity; the only way
      // to render a device-less handler is `runc`, which is refused.
      await expect(
        createDeploymentsDomain(deps).create(
          actor,
          nodePoolInput({ runtime: 'runc' }),
        ),
      ).rejects.toThrow(
        /requires the NVIDIA runtime, so --runtime runc is unsupported/,
      );
      expect(deps.runtime.validateTarget).not.toHaveBeenCalled();
      expect(deps.deployments.create).not.toHaveBeenCalled();
      // The default allocation on a g4dn.12xlarge node pool is all four devices.
      vi.mocked(deps.observeNodePoolCapacity).mockResolvedValue({
        readyVmCount: 1,
        startingVmCount: 0,
        drainingVmCount: 0,
        locations: [],
      });
      await createDeploymentsDomain(deps).create(actor, nodePoolInput());
      expect(deps.deployments.create).toHaveBeenCalledWith(
        expect.objectContaining({ gpuCount: 4, reservation: { maxGpus: 4 } }),
        expect.anything(),
      );
    });

    it('does not reserve devices for CPU Deployments but still needs a ready Node', async () => {
      const deps = nodePoolDependencies({ vmTypes: ['t3.large'] });
      vi.mocked(deps.inspectImage).mockResolvedValue({
        verdict: ImageVerdict.Ok,
        amd64Digest: null,
        imageRuntime: ImageRuntime.Unknown,
        compressedLayerBytes: null,
      });
      await createDeploymentsDomain(deps).create(actor, {
        ...nodePoolInput(),
        image: 'example/cpu:latest',
      });
      expect(deps.deployments.create).toHaveBeenCalledWith(
        expect.objectContaining({ gpuCount: 0, reservation: undefined }),
        expect.anything(),
      );
      await expect(
        createDeploymentsDomain(deps).create(actor, {
          ...nodePoolInput({ gpus: '1' }),
          image: 'example/cpu:latest',
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    // Named by id here, so the message must echo the caller's identifier.
    it.each([
      [NodePoolState.Creating, 'is provisioning; wait until it is running'],
      [NodePoolState.Failed, 'is failed and cannot accept Deployments'],
      [NodePoolState.Deleting, 'is terminated and cannot accept Deployments'],
      [NodePoolState.Deleted, 'is terminated and cannot accept Deployments'],
    ])(
      'refuses a %s node pool before touching the runtime',
      async (state, reason) => {
        const deps = nodePoolDependencies({ state });
        await expect(
          createDeploymentsDomain(deps).create(actor, {
            ...nodePoolInput(),
            nodePool: readyPool.id,
          }),
        ).rejects.toMatchObject({
          statusCode: 409,
          message: `Node pool "${readyPool.id}" ${reason}`,
        });
        expect(deps.runtime.validateTarget).not.toHaveBeenCalled();
        expect(deps.observeNodePoolCapacity).not.toHaveBeenCalled();
      },
    );

    it('rejects unknown node pools', async () => {
      const deps = nodePoolDependencies();
      await expect(
        createDeploymentsDomain(deps).create(actor, {
          ...nodePoolInput(),
          nodePool: 'unknown',
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        message: 'Node pool "unknown" was not found',
      });
    });

    it('reserves the devices a GPU raise adds and refuses it when the node pool has no room', async () => {
      const deps = nodePoolDependencies();
      const current: StoredDeployment = {
        ...stored,
        nodePoolId: readyPool.id,
        gpuCount: 2,
      };
      vi.mocked(deps.deployments.getForScope).mockResolvedValue(current);
      vi.mocked(deps.observeNodePoolCapacity).mockResolvedValue({
        readyVmCount: 1,
        startingVmCount: 0,
        drainingVmCount: 0,
        locations: [],
      });
      vi.mocked(deps.deployments.update).mockResolvedValue('gpu-reserved');
      const domain = createDeploymentsDomain(deps);
      await expect(
        domain.update(actor, current.id, { dockerOptions: { gpus: '4' } }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message:
          'Node pool "aws-east" ready GPU capacity is reserved by its Deployments and Services; this Deployment needs 4 GPU(s)',
      });
      expect(deps.deployments.update).toHaveBeenCalledWith(
        expect.objectContaining({ gpuCount: 4, reservation: { maxGpus: 4 } }),
        expect.anything(),
      );

      // Keeping or lowering the count reserves nothing new.
      vi.mocked(deps.observeNodePoolCapacity).mockClear();
      vi.mocked(deps.deployments.update).mockResolvedValue(2);
      for (const gpus of ['2', '1']) {
        await domain.update(actor, current.id, { dockerOptions: { gpus } });
        expect(deps.deployments.update).toHaveBeenLastCalledWith(
          expect.objectContaining({
            gpuCount: Number(gpus),
            reservation: undefined,
          }),
          expect.anything(),
        );
      }
      expect(deps.observeNodePoolCapacity).not.toHaveBeenCalled();
    });

    it('updates a node pool Deployment against the node pool VM type and lists by node pool', async () => {
      const deps = nodePoolDependencies();
      const nodePoolStored: StoredDeployment = {
        ...stored,
        nodePoolId: readyPool.id,
        gpuCount: 1,
      };
      vi.mocked(deps.deployments.getForScope).mockResolvedValue(nodePoolStored);
      vi.mocked(deps.deployments.getById).mockResolvedValue(nodePoolStored);
      const domain = createDeploymentsDomain(deps);
      await domain.update(actor, nodePoolStored.id, {
        dockerOptions: { gpus: '4' },
      });
      expect(deps.runtime.validateTarget).toHaveBeenCalledWith(
        { kind: 'nodePool', nodePoolId: readyPool.id },
        undefined,
      );
      expect(deps.deployments.update).toHaveBeenCalledWith(
        expect.objectContaining({ gpuCount: 4 }),
        expect.anything(),
      );
      await expect(
        domain.update(actor, nodePoolStored.id, {
          dockerOptions: { gpus: '5' },
        }),
      ).rejects.toThrow(/exceeds the 4 GPU/);

      vi.mocked(deps.deployments.listForScope).mockResolvedValue([
        nodePoolStored,
      ]);
      const listed = await domain.list(actor, { nodePool: 'aws-east' });
      expect(listed.deployments.map((d) => d.nodePoolId)).toEqual([
        readyPool.id,
      ]);
      expect(deps.deployments.listForScope).toHaveBeenCalledWith(
        { kind: 'api' },
        { nodePoolId: readyPool.id },
      );
      await expect(
        domain.list(actor, { nodePool: 'missing' }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });
});
