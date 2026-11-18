import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { DeploymentSummary } from '../../src/shared/api-contract/deployments-schemas.js';
import { WorkloadState } from '../../src/shared/workload.js';
import { CloudType } from '../../src/shared/cloud.js';
import {
  describe,
  expect,
  expectTypeOf,
  onTestFinished,
  test,
  vi,
} from 'vitest';

import { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import { NodePoolCliTransport } from '../integration/e2e/internal/node-pool-mutations.js';
import {
  DeploymentMutationTransport,
  type DeploymentCreateInput,
  type DeploymentWireTransport,
} from '../integration/e2e/internal/deployment-mutations.js';
import {
  TrackedDeploymentKernel,
  type TrackedDeploymentRef,
} from '../integration/e2e/internal/deployments.js';
import {
  TrackedNodePoolKernel,
  type TrackedNodePoolRef,
} from '../integration/e2e/internal/node-pools.js';
import type { NodePoolSummary } from '../integration/e2e/internal/types.js';
import { Waiter, type WaitOptions } from '../integration/e2e/internal/wait.js';
import { CommandFailure } from '../integration/e2e/internal/read-retry.js';
import {
  pythonSdkFailureForTest,
  trackedNodePoolRefForTest,
  trackedDeploymentRefForTest,
} from './helpers/e2e.js';

function deployment(
  id: string,
  name = 'deployment-one',
  nodePoolId = 'pool-one-id',
): DeploymentSummary {
  return {
    id,
    name,
    managed: false,
    privileged: false,
    nodePoolId,
    target: { kind: 'nodePool', nodePoolId },
    image: 'fixture:latest',
    usage: null,
    command: null,
    readinessProbe: null,
    gracePeriodSeconds: 30,
    status: null,
    gpuCount: 0,
    envKeys: [],
    secretNames: [],
    minReplicas: 1,
    maxReplicas: 1,
    maxConcurrentJobsPerReplica: 1,
    generation: 1,
    deletionRequestedAt: null,
    deletedAt: null,
    createdAt: 1,
    updatedAt: 1,
    jobs: {
      queued: 0,
      running: 0,
      retrying: 0,
      terminal: 0,
      unreleased: 0,
    },
    workload: null,
  };
}

class SingleProbeWaiter {
  async for<T>(
    label: string,
    probe: (deadlineAt: number) => Promise<T>,
    options: WaitOptions<T>,
  ): Promise<T> {
    const value = await probe(Date.now() + options.timeoutMs);
    const rejection = options.reject?.(value);
    if (rejection) throw new Error(`${label}: ${rejection}`);
    const unmet = options.unmet(value);
    if (unmet === undefined) return value;
    throw new Error(`${label}: observation was not accepted (${unmet})`);
  }
}

class ParentKernel {
  readonly #active = new Map<
    string,
    { readonly ref: TrackedNodePoolRef; readonly children: Set<object> }
  >();
  readonly calls: string[] = [];

  add(name: string, id: string): TrackedNodePoolRef {
    const ref = trackedNodePoolRefForTest(name);
    this.#active.set(id, { ref, children: new Set() });
    return ref;
  }

  assertActive(ref: TrackedNodePoolRef): void {
    if (![...this.#active.values()].some((entry) => entry.ref === ref)) {
      throw new Error(
        `Node pool reference is forged, stale, or released: ${ref.name}`,
      );
    }
  }

  boundId(ref: TrackedNodePoolRef): string {
    this.assertActive(ref);
    const found = [...this.#active].find(([, entry]) => entry.ref === ref);
    if (!found) throw new Error(`Node pool ${ref.name} is unbound`);
    return found[0];
  }

  registerDeployment(ref: TrackedNodePoolRef, child: object): void {
    const entry = this.#entry(ref);
    entry.children.add(child);
    this.calls.push(`register ${String(entry.children.size)}`);
  }

  unregisterDeployment(ref: TrackedNodePoolRef, child: object): void {
    const entry = this.#entry(ref);
    if (!entry.children.delete(child)) throw new Error('unknown child');
    this.calls.push(`unregister ${String(entry.children.size)}`);
  }

  childCount(ref: TrackedNodePoolRef): number {
    return this.#entry(ref).children.size;
  }

  #entry(ref: TrackedNodePoolRef) {
    this.assertActive(ref);
    const entry = [...this.#active.values()].find(
      (candidate) => candidate.ref === ref,
    );
    if (!entry) throw new Error(`Node pool ${ref.name} is inactive`);
    return entry;
  }
}

const ABSENT = {
  workloads: 0,
  pods: 0,
  replicaSets: 0,
  secrets: 0,
  serviceAccounts: 0,
} as const;

class RecordingTransport {
  readonly calls: string[] = [];
  readonly createRequests: Parameters<
    DeploymentWireTransport['createDeployment']
  >[0][] = [];
  readonly records: Map<string, DeploymentSummary>;
  absenceResponse: unknown = ABSENT;
  createResponse: DeploymentSummary | undefined;
  deletionStaysPending = false;

  constructor(records = new Map<string, DeploymentSummary>()) {
    this.records = records;
  }

  async createDeployment(
    input: Parameters<DeploymentWireTransport['createDeployment']>[0],
  ): Promise<DeploymentSummary> {
    this.calls.push(`create ${input.name} ${input.nodePoolId}`);
    this.createRequests.push(input);
    const created = this.createResponse ?? {
      ...deployment('deployment-server-id', input.name, input.nodePoolId),
      image: input.image,
      maxConcurrentJobsPerReplica: input.maxConcurrentJobsPerReplica ?? 1,
    };
    this.records.set(created.id, created);
    return created;
  }

  async listDeployments(): Promise<readonly DeploymentSummary[]> {
    this.calls.push('list');
    return [...this.records.values()].filter(
      (record) => record.deletedAt === null,
    );
  }

  async deploymentStatus(id: string): Promise<DeploymentSummary> {
    this.calls.push(`status ${id}`);
    const value = this.records.get(id);
    if (!value) throw new Error(`Deployment ${id} not found`);
    return value;
  }

  async updateDeployment(
    id: string,
    input: { readonly image?: string; readonly env?: Record<string, string> },
  ): Promise<DeploymentSummary> {
    this.calls.push(`update ${id}`);
    const current = await this.deploymentStatus(id);
    const updated = {
      ...current,
      ...(input.image ? { image: input.image } : {}),
      generation: current.generation + 1,
    };
    this.records.set(id, updated);
    return updated;
  }

  async deleteDeployment(id: string): Promise<DeploymentSummary> {
    this.calls.push(`delete ${id}`);
    const current = await this.deploymentStatus(id);
    const deleted = {
      ...current,
      deletionRequestedAt: 2,
      deletedAt: this.deletionStaysPending ? null : 3,
    };
    this.records.set(id, deleted);
    return deleted;
  }

  async deploymentAbsent(nodePoolId: string, id: string): Promise<unknown> {
    this.calls.push(`absent ${id} ${nodePoolId}`);
    return this.absenceResponse;
  }
}

function harness(
  resultsDirectory?: string,
  cleanupWait: Pick<Waiter, 'for'> = new SingleProbeWaiter(),
) {
  const cleanup = new CleanupStack();
  const nodePools = new ParentKernel();
  const parent = nodePools.add('pool-one', 'pool-one-id');
  const records = new Map<string, DeploymentSummary>();
  const transport = new RecordingTransport(records);
  const cleanupTransport = new RecordingTransport(records);
  const wait = new SingleProbeWaiter();
  const kernel = new TrackedDeploymentKernel(
    transport,
    nodePools,
    cleanup,
    wait,
    resultsDirectory,
    { transport: cleanupTransport, wait: cleanupWait },
  );
  return {
    cleanup,
    cleanupTransport,
    nodePools,
    kernel,
    mutations: new DeploymentMutationTransport(kernel, transport),
    parent,
    transport,
  };
}

describe('tracked Deployment kernel', () => {
  test('keeps a new reservation when two Deployments release concurrently', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'e2e-deployments-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const world = harness(directory);
    const refs = await Promise.all(
      ['deployment-one', 'deployment-two'].map((name) =>
        world.kernel.reserve(world.parent, name, 1_000),
      ),
    );
    const evidence = [];
    for (const ref of refs) {
      world.transport.createResponse = deployment(`${ref.name}-id`, ref.name);
      await world.mutations.create(ref, { image: 'fixture:latest' });
      await world.mutations.delete(ref);
      evidence.push({
        deletion: await world.kernel.waitForDeletionRecorded(ref, 1_000),
        substrate: world.kernel.recordSubstrateAbsence(ref, ABSENT),
      });
    }

    await Promise.all([
      ...evidence.map((proofs) => world.kernel.release(proofs)),
      world.kernel.reserve(world.parent, 'deployment-three', 1_000),
    ]);

    expect(
      await readFile(path.join(directory, 'deployments-to-clean'), 'utf8'),
    ).toBe('deployment-three\n');
    expect(world.nodePools.childCount(world.parent)).toBe(1);
    expect(world.cleanup.observations()).toEqual([
      { label: 'deployment deployment-one', completed: true },
      { label: 'deployment deployment-two', completed: true },
      { label: 'deployment deployment-three', completed: false },
    ]);
    await world.cleanup.run();
    expect(
      await readFile(path.join(directory, 'deployments-to-clean'), 'utf8'),
    ).toBe('');
  });

  test('rejects creation without a reserved reference before touching the wire', async () => {
    const world = harness();
    const forged = trackedDeploymentRefForTest('deployment-one', world.parent);

    await expect(
      world.mutations.create(forged, { image: 'fixture:latest' }),
    ).rejects.toThrow('forged, stale, or released');
    expect(world.transport.calls).toEqual([]);
  });

  test('rolls parent registration back when reservation cannot be persisted', async () => {
    const world = harness('/directory-that-does-not-exist/results');

    await expect(
      world.kernel.reserve(world.parent, 'deployment-one', 1_000),
    ).rejects.toThrow();

    expect(world.nodePools.childCount(world.parent)).toBe(0);
    expect(world.cleanup.observations()).toEqual([
      { label: 'deployment deployment-one', completed: true },
    ]);
  });

  test('reserves parent-bound cleanup before authorizing one create', async () => {
    expectTypeOf<string>().not.toMatchTypeOf<TrackedDeploymentRef>();
    const world = harness();
    const ref = await world.kernel.reserve(
      world.parent,
      'deployment-one',
      1_000,
    );

    expect(ref.parent).toBe(world.parent);
    const sibling = world.nodePools.add('pool-two', 'pool-two-id');
    expect(Reflect.set(ref, 'parent', sibling)).toBe(false);
    expect(Reflect.set(ref, 'name', 'untracked-deployment')).toBe(false);
    expect(ref.parent).toBe(world.parent);
    expect(ref.name).toBe('deployment-one');
    expect(world.cleanup.observations()).toEqual([
      { label: 'deployment deployment-one', completed: false },
    ]);
    expect(world.nodePools.childCount(world.parent)).toBe(1);
    const maliciousInput: DeploymentCreateInput & {
      readonly action: string;
      readonly nodePoolId: string;
      readonly name: string;
    } = {
      action: 'delete_deployment',
      dockerOptions: { gpus: 'all' },
      image: 'fixture:latest',
      maxConcurrentJobsPerReplica: 2,
      nodePoolId: 'attacker-node pool',
      name: 'attacker-deployment',
    };
    let authorizedPayload: unknown;
    const authorizeCreate = world.kernel.authorizeCreate.bind(world.kernel);
    world.kernel.authorizeCreate = (candidate, payload) => {
      authorizedPayload = payload;
      authorizeCreate(candidate, payload);
    };
    await expect(
      world.mutations.create(ref, maliciousInput),
    ).resolves.toMatchObject({
      id: 'deployment-server-id',
      nodePoolId: 'pool-one-id',
      name: ref.name,
    });
    expect(world.transport.createRequests).toEqual([
      {
        nodePoolId: 'pool-one-id',
        dockerOptions: { gpus: 'all' },
        image: 'fixture:latest',
        maxConcurrentJobsPerReplica: 2,
        name: ref.name,
      },
    ]);
    expect(authorizedPayload).toBe(world.transport.createRequests[0]);
    await expect(
      world.mutations.create(ref, { image: 'fixture:latest' }),
    ).rejects.toThrow('already authorized');
    expect(
      world.transport.calls.filter((call) => call.startsWith('create')),
    ).toEqual(['create deployment-one pool-one-id']);
  });

  test('rejects cross-Node pool creation, wrong IDs, and forged refs', async () => {
    const world = harness();
    const ref = await world.kernel.reserve(
      world.parent,
      'deployment-one',
      1_000,
    );
    expect(() =>
      world.kernel.authorizeCreate(ref, {
        nodePoolId: 'other-node pool',
        name: ref.name,
      }),
    ).toThrow('cannot authorize creation');
    await world.mutations.create(ref, { image: 'fixture:latest' });
    expect(() => world.kernel.authorizeUpdate(ref, 'other-id')).toThrow(
      'cannot authorize mutation',
    );
    expect(() => world.kernel.authorizeDeletion(ref, 'other-id')).toThrow(
      'cannot authorize deletion',
    );
    const forged = trackedDeploymentRefForTest(ref.name, ref.parent);
    await expect(world.mutations.status(forged)).rejects.toThrow(
      'forged, stale, or released',
    );
  });

  test.each([
    { id: 'wrong-id' },
    { name: 'wrong-name' },
    { nodePoolId: 'wrong-node pool' },
  ])('rejects changed wire identity %j', async (change) => {
    const world = harness();
    const ref = await world.kernel.reserve(
      world.parent,
      'deployment-one',
      1_000,
    );
    await world.mutations.create(ref, { image: 'fixture:latest' });
    world.transport.records.set('deployment-server-id', {
      ...deployment('deployment-server-id'),
      ...change,
    });
    await expect(world.mutations.status(ref)).rejects.toThrow(
      /Deployment response/u,
    );
  });

  test('binds a lost create response only through one exact active record', async () => {
    const world = harness();
    const ref = await world.kernel.reserve(
      world.parent,
      'deployment-one',
      1_000,
    );
    world.kernel.authorizeCreate(ref, {
      nodePoolId: 'pool-one-id',
      name: ref.name,
    });
    await expect(world.kernel.resolveCreated(ref)).rejects.toThrow(
      'resolved to 0 active records',
    );
    world.transport.records.set(
      'deployment-server-id',
      deployment('deployment-server-id'),
    );
    await expect(world.kernel.resolveCreated(ref)).resolves.toMatchObject({
      id: 'deployment-server-id',
    });
  });

  test('requires durable deletion and independent native absence', async () => {
    const world = harness();
    const ref = await world.kernel.reserve(
      world.parent,
      'deployment-one',
      1_000,
    );
    await world.mutations.create(ref, { image: 'fixture:latest' });
    const absenceWithoutDeletion = world.kernel.recordSubstrateAbsence(
      ref,
      ABSENT,
    );
    await expect(
      world.kernel.release({
        deletion: absenceWithoutDeletion as never,
        substrate: absenceWithoutDeletion,
      }),
    ).rejects.toThrow('forged or belongs elsewhere');
    await expect(
      world.kernel.waitForDeletionRecorded(ref, 1_000),
    ).rejects.toThrow('deletion is not recorded');
    await world.mutations.delete(ref);
    await expect(world.mutations.delete(ref)).rejects.toThrow(
      'deletion was already authorized',
    );
    await expect(
      world.mutations.update(ref, { image: 'fixture:v2' }),
    ).rejects.toThrow('deletion was already authorized');
    const deletion = await world.kernel.waitForDeletionRecorded(ref, 1_000);
    expect(() =>
      world.kernel.recordSubstrateAbsence(ref, { ...ABSENT, pods: 1 }),
    ).toThrow('still has native resources');
    const substrate = world.kernel.recordSubstrateAbsence(ref, ABSENT);
    await world.kernel.release({ deletion, substrate });

    expect(world.nodePools.childCount(world.parent)).toBe(0);
    await expect(world.mutations.status(ref)).rejects.toThrow(
      'forged, stale, or released',
    );
    await expect(world.kernel.release({ deletion, substrate })).rejects.toThrow(
      'already used',
    );
  });

  test.each([
    {},
    { ...ABSENT, unexpected: 0 },
    { ...ABSENT, pods: -1 },
    { ...ABSENT, pods: 0.5 },
    { ...ABSENT, pods: Number.NaN },
  ])('rejects malformed native absence facts %#', async (facts) => {
    const world = harness();
    const ref = await world.kernel.reserve(
      world.parent,
      'deployment-one',
      1_000,
    );
    await world.mutations.create(ref, { image: 'fixture:latest' });

    expect(() =>
      world.kernel.recordSubstrateAbsence(ref, facts as never),
    ).toThrow(/native absence/u);
  });

  test('rejects mixed and stale release proofs', async () => {
    const world = harness();
    const secondParent = world.nodePools.add('pool-two', 'pool-two-id');
    const first = await world.kernel.reserve(
      world.parent,
      'deployment-one',
      1_000,
    );
    const second = await world.kernel.reserve(
      secondParent,
      'deployment-two',
      1_000,
    );
    await world.mutations.create(first, { image: 'fixture:latest' });
    world.transport.createResponse = deployment(
      'deployment-two-id',
      second.name,
      'pool-two-id',
    );
    await world.mutations.create(second, { image: 'fixture:latest' });
    const firstPreDeletionAbsence = world.kernel.recordSubstrateAbsence(
      first,
      ABSENT,
    );
    await world.mutations.delete(first);
    await world.mutations.delete(second);
    const firstDeletion = await world.kernel.waitForDeletionRecorded(
      first,
      1_000,
    );
    const secondAbsence = world.kernel.recordSubstrateAbsence(second, ABSENT);
    await expect(
      world.kernel.release({
        deletion: firstDeletion,
        substrate: secondAbsence,
      }),
    ).rejects.toThrow('different resources');

    await expect(
      world.kernel.release({
        deletion: firstDeletion,
        substrate: firstPreDeletionAbsence,
      }),
    ).rejects.toThrow('stale');
  });

  test('fallback cleanup runs child-before-parent after a lost response', async () => {
    const world = harness();
    const order: string[] = [];
    world.cleanup.defer('node pool parent', async () => {
      order.push('node pool');
    });
    const ref = await world.kernel.reserve(
      world.parent,
      'deployment-one',
      1_000,
    );
    world.kernel.authorizeCreate(ref, {
      nodePoolId: 'pool-one-id',
      name: ref.name,
    });
    world.transport.records.set(
      'deployment-server-id',
      deployment('deployment-server-id'),
    );
    const originalDelete = world.cleanupTransport.deleteDeployment.bind(
      world.cleanupTransport,
    );
    world.cleanupTransport.deleteDeployment = async (id) => {
      order.push('deployment');
      return originalDelete(id);
    };
    const originalAbsence = world.cleanupTransport.deploymentAbsent.bind(
      world.cleanupTransport,
    );
    world.cleanupTransport.deploymentAbsent = async (nodePoolId, id) => {
      order.push('absence');
      return originalAbsence(nodePoolId, id);
    };

    await world.cleanup.run();

    expect(order).toEqual(['deployment', 'absence', 'node pool']);
    expect(world.transport.calls).toEqual([]);
    expect(world.nodePools.childCount(world.parent)).toBe(0);
  });

  test('proves native absence for an already-deleted fallback record', async () => {
    const world = harness();
    const ref = await world.kernel.reserve(
      world.parent,
      'deployment-one',
      1_000,
    );
    await world.mutations.create(ref, { image: 'fixture:latest' });
    world.transport.records.set('deployment-server-id', {
      ...deployment('deployment-server-id'),
      deletionRequestedAt: 2,
      deletedAt: 3,
    });

    await world.cleanup.run();

    expect(world.cleanupTransport.calls).toEqual([
      'status deployment-server-id',
      'absent deployment-server-id pool-one-id',
    ]);
    expect(world.nodePools.childCount(world.parent)).toBe(0);
  });

  test.each([
    'missing',
    'already deleted',
    'another Node pool',
    'another name',
  ])(
    'retains an unresolved authorized create when the listed record is %s',
    async (record) => {
      const world = harness();
      const ref = await world.kernel.reserve(
        world.parent,
        'deployment-one',
        1_000,
      );
      world.kernel.authorizeCreate(ref, {
        nodePoolId: 'pool-one-id',
        name: ref.name,
      });
      if (record !== 'missing') {
        world.transport.records.set('deployment-server-id', {
          ...deployment(
            'deployment-server-id',
            record === 'another name' ? 'untracked-deployment' : ref.name,
            record === 'another Node pool'
              ? 'untracked-node pool'
              : 'pool-one-id',
          ),
          ...(record === 'already deleted'
            ? { deletionRequestedAt: 2, deletedAt: 3 }
            : {}),
        });
      }

      await expect(world.cleanup.run()).rejects.toThrow(
        'identity remains unresolved',
      );

      expect(world.cleanupTransport.calls).toEqual(['list']);
      expect(() => world.kernel.assertActive(ref)).not.toThrow();
      expect(world.nodePools.childCount(world.parent)).toBe(1);
      expect(world.cleanup.observations()).toEqual([
        { label: 'deployment deployment-one', completed: false },
      ]);
    },
  );

  test('disarms a reservation whose create was never authorized', async () => {
    const world = harness();
    await world.kernel.reserve(world.parent, 'deployment-one', 1_000);

    await world.cleanup.run();

    expect(world.cleanupTransport.calls).toEqual([]);
    expect(world.nodePools.childCount(world.parent)).toBe(0);
    expect(world.cleanup.observations()).toEqual([
      { label: 'deployment deployment-one', completed: true },
    ]);
  });

  test.each(['workloads', 'pods', 'replicaSets', 'secrets', 'serviceAccounts'])(
    'retains an already-deleted Deployment while native %s remain',
    async (resource) => {
      const world = harness();
      const ref = await world.kernel.reserve(
        world.parent,
        'deployment-one',
        1_000,
      );
      await world.mutations.create(ref, { image: 'fixture:latest' });
      world.transport.records.set('deployment-server-id', {
        ...deployment('deployment-server-id'),
        deletionRequestedAt: 2,
        deletedAt: 3,
      });
      world.cleanupTransport.absenceResponse = { ...ABSENT, [resource]: 1 };

      await expect(world.cleanup.run()).rejects.toThrow(
        'observation was not accepted',
      );

      expect(() => world.kernel.assertActive(ref)).not.toThrow();
      expect(world.nodePools.childCount(world.parent)).toBe(1);
      expect(world.cleanup.observations()).toEqual([
        { label: 'deployment deployment-one', completed: false },
      ]);
    },
  );

  test('retains cleanup after an exact native observation fails', async () => {
    const world = harness();
    const ref = await world.kernel.reserve(
      world.parent,
      'deployment-one',
      1_000,
    );
    await world.mutations.create(ref, { image: 'fixture:latest' });
    world.cleanupTransport.deploymentAbsent = async () => {
      throw new Error('Kubernetes unavailable');
    };

    await expect(world.cleanup.run()).rejects.toThrow('Kubernetes unavailable');

    expect(() => world.kernel.assertActive(ref)).not.toThrow();
    expect(world.nodePools.childCount(world.parent)).toBe(1);
    expect(world.cleanup.observations()).toEqual([
      { label: 'deployment deployment-one', completed: false },
    ]);
  });

  test('keeps cleanup armed when fallback native absence is malformed', async () => {
    const world = harness();
    const ref = await world.kernel.reserve(
      world.parent,
      'deployment-one',
      1_000,
    );
    await world.mutations.create(ref, { image: 'fixture:latest' });
    world.cleanupTransport.absenceResponse = {};

    await expect(world.cleanup.run()).rejects.toThrow('must contain exactly');

    expect(world.nodePools.childCount(world.parent)).toBe(1);
    expect(world.cleanup.observations()).toEqual([
      { label: 'deployment deployment-one', completed: false },
    ]);
  });

  test('keeps failed fallback cleanup armed and observable', async () => {
    const world = harness();
    const ref = await world.kernel.reserve(
      world.parent,
      'deployment-one',
      1_000,
    );
    await world.mutations.create(ref, { image: 'fixture:latest' });
    world.cleanupTransport.deletionStaysPending = true;

    await expect(world.cleanup.run()).rejects.toThrow(
      'deletion is not recorded',
    );

    expect(world.nodePools.childCount(world.parent)).toBe(1);
    expect(world.cleanup.observations()).toEqual([
      { label: 'deployment deployment-one', completed: false },
    ]);
  });

  test('recovers a transient cleanup identity read before deleting once and proving native absence', async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });
    const world = harness(undefined, new Waiter(new AbortController().signal));
    const ref = await world.kernel.reserve(
      world.parent,
      'deployment-one',
      5_000,
    );
    await world.mutations.create(ref, { image: 'fixture:latest' });
    const unavailable = new CommandFailure(
      'SDK status unavailable',
      pythonSdkFailureForTest(),
      { kind: 'python-sdk', action: 'get_deployment' },
    );
    const status = vi
      .spyOn(world.cleanupTransport, 'deploymentStatus')
      .mockRejectedValueOnce(unavailable);
    const deleted = vi.spyOn(world.cleanupTransport, 'deleteDeployment');
    const absent = vi.spyOn(world.cleanupTransport, 'deploymentAbsent');

    const pending = world.cleanup.run();
    const settled = Promise.allSettled([pending]);
    await vi.advanceTimersByTimeAsync(0);
    expect(deleted).not.toHaveBeenCalled();
    expect(world.nodePools.childCount(world.parent)).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await settled).toEqual([{ status: 'fulfilled', value: undefined }]);

    expect(
      status.mock.calls.every(([id]) => id === 'deployment-server-id'),
    ).toBe(true);
    expect(deleted).toHaveBeenCalledExactlyOnceWith('deployment-server-id');
    expect(absent).toHaveBeenCalledExactlyOnceWith(
      'pool-one-id',
      'deployment-server-id',
    );
    expect(world.nodePools.childCount(world.parent)).toBe(0);
    expect(world.cleanup.observations()).toEqual([
      { label: 'deployment deployment-one', completed: true },
    ]);
  });

  test.each([
    ['open SDK transport', { finalization: { transportClosed: false } }],
    ['pending SDK task', { finalization: { pendingTasks: 1 } }],
    [
      'SDK close failure',
      {
        finalization: {
          errors: [
            { phase: 'action', type: 'ServiceException' },
            { phase: 'close', type: 'RuntimeError' },
          ],
        },
      },
    ],
    [
      'authorization failure with quoted unavailable text',
      {
        status: 401,
        exception: 'UnauthorizedException',
        body: '\nThe API is temporarily unavailable (HTTP 522)\n',
      },
    ],
  ] as const)(
    'retains cleanup and parent tracking after %s even if the next read would succeed',
    async (_label, failureOptions) => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
      });
      const world = harness(
        undefined,
        new Waiter(new AbortController().signal),
      );
      const ref = await world.kernel.reserve(
        world.parent,
        'deployment-one',
        3_000,
      );
      await world.mutations.create(ref, { image: 'fixture:latest' });
      const failure = new CommandFailure(
        'SDK read did not complete safely',
        pythonSdkFailureForTest(failureOptions),
        { kind: 'python-sdk', action: 'get_deployment' },
      );
      const status = vi
        .spyOn(world.cleanupTransport, 'deploymentStatus')
        .mockRejectedValueOnce(failure);
      const deleted = vi.spyOn(world.cleanupTransport, 'deleteDeployment');
      const absent = vi.spyOn(world.cleanupTransport, 'deploymentAbsent');

      const settled = Promise.allSettled([world.cleanup.run()]);
      await vi.advanceTimersByTimeAsync(3_000);
      const [outcome] = await settled;
      expect(outcome.status).toBe('rejected');
      if (outcome.status !== 'rejected')
        throw new Error('Expected cleanup failure');
      expect(outcome.reason).toBeInstanceOf(AggregateError);
      expect(outcome.reason.errors).toHaveLength(1);
      expect(outcome.reason.errors[0].cause).toBe(failure);
      expect(status).toHaveBeenCalledExactlyOnceWith('deployment-server-id');
      expect(deleted).not.toHaveBeenCalled();
      expect(absent).not.toHaveBeenCalled();
      expect(world.nodePools.childCount(world.parent)).toBe(1);
      expect(world.cleanup.observations()).toEqual([
        { label: 'deployment deployment-one', completed: false },
      ]);
    },
  );

  test.each(['deadline', 'cancellation', 'delete response lost'] as const)(
    'retains child and parent when cleanup stops at %s',
    async (stop) => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
      });
      const controller = new AbortController();
      const world = harness(undefined, new Waiter(controller.signal));
      const ref = await world.kernel.reserve(
        world.parent,
        'deployment-one',
        3_000,
      );
      await world.mutations.create(ref, { image: 'fixture:latest' });
      const unavailable = new CommandFailure(
        'SDK response unavailable',
        pythonSdkFailureForTest({
          action:
            stop === 'delete response lost'
              ? 'delete_deployment'
              : 'get_deployment',
        }),
        {
          kind: 'python-sdk',
          action:
            stop === 'delete response lost'
              ? 'delete_deployment'
              : 'get_deployment',
        },
      );
      const status = vi.spyOn(world.cleanupTransport, 'deploymentStatus');
      const deleted = vi.spyOn(world.cleanupTransport, 'deleteDeployment');
      const absent = vi.spyOn(world.cleanupTransport, 'deploymentAbsent');
      if (stop === 'delete response lost')
        deleted.mockRejectedValue(unavailable);
      else status.mockRejectedValue(unavailable);

      const pending = world.cleanup.run();
      const rejected = expect(pending).rejects.toThrow(
        stop === 'deadline'
          ? 'timed out after 3000ms'
          : stop === 'cancellation'
            ? 'aborted'
            : 'SDK response unavailable',
      );
      await vi.advanceTimersByTimeAsync(0);
      if (stop === 'cancellation') controller.abort();
      else await vi.advanceTimersByTimeAsync(3_000);
      await rejected;

      expect(status).toHaveBeenCalledTimes(stop === 'deadline' ? 2 : 1);
      expect(deleted).toHaveBeenCalledTimes(
        stop === 'delete response lost' ? 1 : 0,
      );
      expect(absent).not.toHaveBeenCalled();
      expect(world.nodePools.childCount(world.parent)).toBe(1);
      expect(world.cleanup.observations()).toEqual([
        { label: 'deployment deployment-one', completed: false },
      ]);
    },
  );
});

describe('tracked node pool kernel', () => {
  const deleted = (name: string): NodePoolSummary => ({
    id: `${name}-id`,
    name,
    clusterId: 'cluster-one-id',
    state: WorkloadState.Terminated,
    releasing: false,
    cloudProvider: CloudType.Local,
    region: 'local',
    zone: null,
    vmTypes: ['local'],
    minVmCount: 1,
    maxVmCount: 1,
    osDiskSizeGb: null,
    osDiskTier: null,
    spot: false,
    allowPrivilegedJobs: false,
    userNamespaceJobs: false,
    requireNestedVirtualization: false,
    capacity: {
      readyVmCount: 0,
      startingVmCount: 0,
      drainingVmCount: 0,
      locations: [],
    },
    liveReferences: 0,
    ingressEntryIp: null,
    ingress: { entryIp: null, release: null },
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
  });
  test('prevents parent release while a tracked Deployment child is live', async () => {
    const api = {
      deleteDeployment: () => Promise.reject(new Error('unexpected delete')),
      deleteNodePool: () => Promise.reject(new Error('unexpected delete')),
      listDeployments: () => Promise.resolve([]),
      listNodePools: () => Promise.resolve([]),
      lookupNodePool: (id: string) =>
        Promise.resolve({
          kind: 'found' as const,
          nodePool: deleted(id.replace(/-id$/u, '')),
        }),
    };
    const cleanup = new CleanupStack();
    const wait = new SingleProbeWaiter();
    const kernel = new TrackedNodePoolKernel(api, cleanup, wait, undefined, {
      api,
      wait,
    });
    const created = async (name: string) => {
      const ref = await kernel.reserve(name, 1_000);
      kernel.authorizeCreate(ref, name);
      kernel.bindCreated(ref, deleted(name));
      return ref;
    };
    const parent = await created('pool-parent');
    const child = Object.freeze({ kind: 'tracked-deployment' });
    kernel.registerDeployment(parent, child);

    const blocked = await kernel.waitForDeletionRecorded(parent, 1_000);
    await expect(kernel.release(blocked)).rejects.toThrow(
      'still has 1 tracked Deployment children',
    );
    kernel.unregisterDeployment(parent, child);
    await kernel.release(await kernel.waitForDeletionRecorded(parent, 1_000));

    // The cleanup backstop refuses to disarm a parent with a live child too.
    const orphaned = await created('pool-orphaned');
    kernel.registerDeployment(orphaned, child);
    await expect(cleanup.run()).rejects.toThrow(
      'Node pool pool-orphaned still has 1 tracked Deployment children',
    );
    expect(() => kernel.assertActive(orphaned)).not.toThrow();
  });

  test('creates a pool through the CLI with --spot only when the request asks', async () => {
    const api = {
      deleteDeployment: () => Promise.reject(new Error('unexpected delete')),
      deleteNodePool: () => Promise.reject(new Error('unexpected delete')),
      listDeployments: () => Promise.resolve([]),
      listNodePools: () => Promise.resolve([]),
      lookupNodePool: () => Promise.resolve({ kind: 'absent' as const }),
    };
    const wait = new SingleProbeWaiter();
    const kernel = new TrackedNodePoolKernel(
      api,
      new CleanupStack(),
      wait,
      undefined,
      { api, wait },
    );
    const runs: (readonly string[])[] = [];
    const cli = {
      run: async (args: readonly string[]) => {
        runs.push(args);
        const name = String(args.at(-1));
        return {
          executable: 'anycloud',
          args,
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify(deleted(name)),
          stderr: '',
          combined: '',
          durationMs: 1,
          timedOut: false,
          aborted: false,
          outputTruncated: false,
        };
      },
    };
    const transport = new NodePoolCliTransport(kernel, cli);
    for (const spot of [true, undefined]) {
      const name = spot ? 'spot-pool' : 'on-demand-pool';
      await transport.create(await kernel.reserve(name, 1_000), {
        name,
        credentialName: 'aws-test',
        vmTypes: ['t3.small'],
        minVmCount: 1,
        maxVmCount: 1,
        ...(spot ? { spot } : {}),
      });
    }
    expect(runs.map((args) => args.includes('--spot'))).toEqual([true, false]);
  });

  test("fallback cleanup leaves a managed Deployment to its node pool's deletion", async () => {
    const records = new Map<string, DeploymentSummary>([
      ['user-id', deployment('user-id', 'user', 'pool-jobs-id')],
      [
        'managed-id',
        {
          ...deployment('managed-id', 'managed', 'pool-jobs-id'),
          managed: true,
        },
      ],
    ]);
    const deployments = new RecordingTransport(records);
    let pool: NodePoolSummary = {
      ...deleted('pool-jobs'),
      state: WorkloadState.Running,
    };
    const api = {
      deleteDeployment: (id: string) =>
        id === 'managed-id'
          ? Promise.reject(new Error("managed Deployments can't be deleted"))
          : deployments.deleteDeployment(id),
      listDeployments: () => deployments.listDeployments(),
      deleteNodePool: () => {
        pool = deleted('pool-jobs');
        return Promise.resolve(pool);
      },
      listNodePools: () => Promise.resolve([]),
      lookupNodePool: () =>
        Promise.resolve({ kind: 'found' as const, nodePool: pool }),
    };
    const cleanup = new CleanupStack();
    const wait = new SingleProbeWaiter();
    const kernel = new TrackedNodePoolKernel(api, cleanup, wait, undefined, {
      api,
      wait,
    });
    const ref = await kernel.reserve('pool-jobs', 1_000);
    kernel.authorizeCreate(ref, 'pool-jobs');
    kernel.bindCreated(ref, pool);
    await cleanup.run();
    expect(deployments.calls).toContain('delete user-id');
    expect(deployments.calls).not.toContain('delete managed-id');
    expect(pool.state).toBe(WorkloadState.Terminated);
  });
});
