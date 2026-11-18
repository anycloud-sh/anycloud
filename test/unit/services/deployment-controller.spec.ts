import { afterEach, describe, expect, it, vi } from 'vitest';
import type { V1NetworkPolicy, V1Pod } from '@kubernetes/client-node';

import {
  createDeploymentController,
  createDeploymentOwner,
} from '../../../src/api/services/deployment-controller.js';
import { renderDeploymentObjects } from '../../../src/api/services/deployment-objects.js';
import type { StoredDeployment } from '../../../src/api/services/deployment-store.js';
import type { TargetedExecutionIdentity } from '../../../src/api/services/repositories/deployment-executions.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import { ANYCLOUD_POD_FINALIZER } from '../../../src/api/services/kubernetes/pool-objects.js';
import { nodePoolNamespace } from '../../../src/api/services/kubernetes/node-pool-scheduling.js';
import { kubernetesWorkloadSecretName } from '../../../src/api/services/kubernetes/identity.js';
import {
  buildNodePoolEgressPolicy,
  buildNodePoolNamespace,
} from '../../../src/api/services/kubernetes/node-pool-namespace.js';
import {
  createPoolReconciler,
  type PoolReconciler,
  type PoolView,
} from '../../../src/api/services/pool-reconciler.js';
import {
  makeContainerSpec,
  makeReplicaPolicyDependencies,
} from '../helpers/fixtures.js';
import { FakeKubernetesCluster } from '../helpers/fake-kubernetes-cluster.js';
import apiConfig from '../../../src/api/config.js';

const nodePool = {
  clusterId: 'cluster-a',
  nodePoolId: 'node-pool-aws-east',
  nvidiaGpusPerNode: 0,
};
const config = { namespace: nodePoolNamespace(nodePool.nodePoolId) };
const workloadApiUrl = 'https://api.example.test';
const loops: PoolReconciler[] = [];

afterEach(async () => {
  await Promise.all(loops.splice(0).map((loop) => loop.stop()));
});

function makeDeployment(
  overrides: Partial<StoredDeployment> = {},
): StoredDeployment {
  return {
    readinessProbe: null,
    gracePeriodSeconds: 30,
    id: 'deployment-a',
    ownerUserId: 'owner-a',
    name: 'deployment',
    nodePoolId: nodePool.nodePoolId,
    config: makeContainerSpec(),
    secretNames: [],
    gpuCount: 0,
    generation: 2,
    maxConcurrentJobsPerReplica: 1,
    minReplicas: 1,
    maxReplicas: 1,
    managed: false,
    runnerRelease: null,
    deletionRequestedAt: null,
    deletedAt: null,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function execution(
  overrides: Partial<TargetedExecutionIdentity> = {},
): TargetedExecutionIdentity {
  return {
    jobId: 'job-a',
    executionId: 'execution-a',
    deploymentId: 'deployment-a',
    generation: 1,
    podUid: 'pod-a',
    containerId: 'containerd://container-a',
    state: WorkloadState.Running,
    cleanedAt: null,
    openedAt: 1,
    endedAt: null,
    ...overrides,
  };
}

const manifests = (deployment = makeDeployment()) =>
  renderDeploymentObjects(
    deployment,
    config.namespace,
    workloadApiUrl,
    nodePool,
  );

/** A replica as the native Deployment's ReplicaSet labels it. */
function runningPod(uid: string, container: string, generation: number): V1Pod {
  const template = manifests().kubernetesDeployment.spec!.template;
  return {
    metadata: {
      ...template.metadata,
      name: uid,
      namespace: config.namespace,
      uid,
      // Newer than any ServiceAccount the test creates, ordered by generation.
      creationTimestamp: new Date(Date.now() + 60_000 + generation),
      annotations: {
        ...template.metadata!.annotations,
        'anycloud.sh/generation': String(generation),
      },
    },
    spec: { containers: [], nodeName: 'node-a' },
    status: {
      phase: 'Running',
      containerStatuses: [
        {
          name: 'workload',
          ready: true,
          image: 'old:image',
          imageID: 'old@sha256:image',
          restartCount: 0,
          containerID: `containerd://${container}`,
          state: { running: { startedAt: new Date(generation) } },
        },
      ],
    },
  };
}

function harness(
  deployment: StoredDeployment,
  options: {
    secretValues?: Record<string, Record<string, string>>;
    namespace?: 'owned' | 'missing' | 'foreign';
  } = {},
) {
  const cluster = new FakeKubernetesCluster();
  const namespace = buildNodePoolNamespace(nodePool);
  if (options.namespace !== 'missing') {
    cluster.seed({
      ...namespace,
      kind: 'Namespace',
      metadata:
        options.namespace === 'foreign'
          ? { name: config.namespace, labels: { team: 'x' } }
          : namespace.metadata,
    });
  }
  // An owned namespace carries its egress policy (K5).
  if (!options.namespace || options.namespace === 'owned') {
    cluster.seed({
      ...buildNodePoolEgressPolicy(nodePool),
      kind: 'NetworkPolicy',
    });
  }
  const client = cluster.client();
  const deployments = {
    getById: vi.fn(
      async (_id: string): Promise<StoredDeployment | null> => deployment,
    ),
    listForReconciliation: vi.fn(async (): Promise<string[]> => []),
    markDeleted: vi.fn(),
    advanceGeneration: vi.fn(async () => true),
    recordRunnerRelease: vi.fn(async () => undefined),
    recordOccupancy: vi.fn(async () => undefined),
    requestIdleDeletion: vi.fn(async () => false),
  };
  const jobs = {
    countTargetedJobs: vi.fn(async () => ({
      queued: 0,
      running: 1,
      retrying: 0,
      terminal: 0,
      unreleased: 1,
    })),
    listTargetedExecutions: vi.fn(
      async (): Promise<TargetedExecutionIdentity[]> => [],
    ),
    reportTargetedJobExecution: vi.fn().mockResolvedValue(true),
    recordPodNode: vi.fn(),
    recordAttemptLogTail: vi.fn(),
    closeReplica: vi.fn(),
    wasForcedStop: vi.fn(() => false),
    completeTargetedJobCleanup: vi.fn(),
    terminateUnassignedTargetedJobs: vi.fn(),
  };
  const replicas = makeReplicaPolicyDependencies();
  const input = {
    deployments,
    jobs,
    replicas,
    secrets: {
      getSecretValues: async (name: string) =>
        options.secretValues?.[name] ?? null,
    },
    runtimes: {
      resolve: vi.fn().mockResolvedValue({ config, cluster: client, nodePool }),
    },
    workloadApiUrl,
    now: vi.fn(() => Date.now()),
  };
  const owner = createDeploymentOwner(input);
  // A cache only, behind an owner of nothing, so no event or orphan strip
  // reaches the Deployment owner under test.
  const view = createPoolReconciler({
    owner: { component: '', discover: async () => [], reconcile: vi.fn() },
    cluster: async () => client,
  });
  loops.push(view);
  const idle = () =>
    jobs.countTargetedJobs.mockResolvedValue({
      queued: 0,
      running: 0,
      retrying: 0,
      terminal: 0,
      unreleased: 0,
    });
  return {
    cluster,
    client,
    input,
    deployments,
    jobs,
    replicas,
    idle,
    /** One reconcile against the synced cache; returns its API calls. */
    async pass(through: PoolView = view) {
      await vi.waitFor(() => view.cache(nodePool.clusterId));
      cluster.calls.length = 0;
      await owner.reconcile(deployment.id, through);
      return cluster.calls.map((call) => `${call.op} ${call.kind}`);
    },
    view,
  };
}

const lost = {
  state: WorkloadState.Retrying,
  reason: 'replica lost: its Pod was gone before its status was read',
  cause: {
    kind: 'lost',
    detail: 'its Pod was gone before its status was read',
  },
};

describe('Deployment owner', () => {
  /** The native Deployment as applied, with `edit` applied to a copy. */
  function seedApplied(
    f: ReturnType<typeof harness>,
    edit: (
      existing: ReturnType<typeof manifests>['kubernetesDeployment'],
    ) => void,
  ) {
    const existing = structuredClone(manifests().kubernetesDeployment);
    existing.metadata!.uid = 'workload-a';
    edit(existing);
    f.cluster.seed({ ...existing, kind: 'Deployment' });
  }

  it('0036/S15 repairs drift made in the cluster during active work', async () => {
    const f = harness(makeDeployment());
    seedApplied(f, (existing) => {
      existing.spec!.template.spec!.containers[0]!.image = 'old:image';
    });
    f.cluster.pods = [runningPod('pod-a', 'container-a', 2)];
    f.jobs.listTargetedExecutions.mockResolvedValue([
      execution({ generation: 2 }),
    ]);
    const calls = await f.pass();
    expect(f.jobs.reportTargetedJobExecution).not.toHaveBeenCalled();
    expect(calls).not.toContain('delete Deployment');
    expect(calls).toContain('apply Deployment');
    expect(
      f.cluster.get('Deployment', config.namespace, manifests().name),
    ).toMatchObject({
      spec: {
        template: { spec: { containers: [{ image: 'example/image:latest' }] } },
      },
    });
    // Repair may replace a process that still owns work. Recover that lost
    // execution on the next observation, once one direct read confirms the
    // Pod is gone (RFC 0044 invariant 7).
    f.cluster.pods = [runningPod('replacement-pod', 'container-b', 2)];
    expect(await f.pass()).toEqual(['list Pod']);
    expect(f.jobs.reportTargetedJobExecution).toHaveBeenCalledWith(
      'job-a',
      'execution-a',
      lost,
    );
  });

  it('SPEND holds a bound replica at its share of its Node, from the Node VM row', async () => {
    const f = harness(makeDeployment());
    f.idle();
    f.cluster.seed({
      kind: 'Node',
      metadata: { name: 'node-a', labels: { 'anycloud.sh/attempt': '7' } },
      status: { allocatable: { cpu: '2', memory: '32Gi' } },
    });
    const bound = runningPod('pod-a', 'container-a', 2);
    bound.spec!.containers = [
      {
        name: 'workload',
        resources: { requests: { cpu: '290m', memory: '128Mi' } },
      },
    ];
    const pending = runningPod('pod-b', 'container-b', 2);
    delete pending.spec!.nodeName;
    const done = runningPod('pod-c', 'container-c', 2);
    done.status!.phase = 'Succeeded';
    f.cluster.pods = [bound, pending, done];
    await f.pass();
    expect(f.deployments.recordOccupancy).toHaveBeenCalledExactlyOnceWith(
      'deployment-a',
      [{ podUid: 'pod-a', vmId: 7, share: expect.closeTo(0.145), gpus: 0 }],
      ['pod-a', 'pod-b'],
    );
  });

  it('0044 RT10 rolls a newly rendered Pod template out as the next generation: the claimed replica stays until its Job is released, then is replaced once', async () => {
    // An upgrade renders a new template for the same generation: K1, K6, K9
    // and the finalizer arrive in this one restart.
    const f = harness(makeDeployment());
    const deletes: string[] = [];
    const pass = async () => {
      const calls = await f.pass();
      deletes.push(...calls.filter((call) => call.startsWith('delete')));
      return calls;
    };
    seedApplied(f, (existing) => {
      existing.metadata!.annotations!['anycloud.sh/template-hash'] = 'before';
      delete existing.spec!.template.metadata!.finalizers;
    });
    f.cluster.pods = [runningPod('pod-a', 'container-a', 2)];
    f.jobs.listTargetedExecutions.mockResolvedValue([
      execution({ generation: 2 }),
    ]);
    const calls = await pass();
    expect(calls.filter((call) => call.endsWith('Deployment'))).toEqual([]);
    // Older replicas stop claiming once the record moves on, so the
    // generation drain and replace below do the rollout.
    expect(f.deployments.advanceGeneration).toHaveBeenCalledExactlyOnceWith(
      'deployment-a',
      2,
    );
    f.deployments.getById.mockResolvedValue(makeDeployment({ generation: 3 }));
    // The claimed Job is unreleased: nothing is replaced or deleted.
    expect(await pass()).toEqual([]);
    expect(await pass()).toEqual([]);
    expect(f.cluster.pods.map((pod) => pod.metadata?.uid)).toEqual(['pod-a']);
    // Released: replaced once, through the native Deployment.
    f.idle();
    f.jobs.listTargetedExecutions.mockResolvedValue([]);
    expect(await pass()).toEqual(['delete Deployment']);
    expect(await pass()).toContain('create Deployment');
    expect(await pass()).toEqual([]);
    expect(deletes).toEqual(['delete Deployment']);
    expect(
      f.cluster.get(
        'Deployment',
        config.namespace,
        manifests(makeDeployment({ generation: 3 })).name,
      ),
    ).toMatchObject({
      spec: {
        revisionHistoryLimit: 1,
        template: { metadata: { finalizers: [ANYCLOUD_POD_FINALIZER] } },
      },
    });
    expect(f.deployments.advanceGeneration).toHaveBeenCalledOnce();
  });

  describe('RFC 0049 C27: a managed runner through an API upgrade', () => {
    /** A managed native Deployment an older release applied. */
    function upgraded(runnerRelease: string | null) {
      const deployment = makeDeployment({ managed: true, runnerRelease });
      const f = harness(deployment);
      const existing = structuredClone(
        manifests(deployment).kubernetesDeployment,
      );
      existing.metadata!.uid = 'workload-a';
      existing.metadata!.annotations!['anycloud.sh/template-hash'] = 'before';
      existing.spec!.template.spec!.containers[0]!.image = 'old:runner';
      existing.spec!.replicas = 0;
      f.cluster.seed({ ...existing, kind: 'Deployment' });
      f.cluster.pods = [runningPod('pod-a', 'container-a', 2)];
      f.jobs.listTargetedExecutions.mockResolvedValue([
        execution({ generation: 2 }),
      ]);
      return f;
    }
    const applied = (f: ReturnType<typeof harness>) =>
      f.cluster.get('Deployment', config.namespace, manifests().name);

    it.each([apiConfig.previousVersion, apiConfig.currVersion])(
      'keeps the replicas of a %s runner and changes only their count',
      async (release) => {
        const f = upgraded(release);
        const calls = await f.pass();
        expect(f.deployments.advanceGeneration).not.toHaveBeenCalled();
        expect(calls).toContain('patch Deployment');
        expect(calls).not.toContain('apply Deployment');
        expect(calls).not.toContain('delete Deployment');
        expect(applied(f)).toMatchObject({
          metadata: { annotations: { 'anycloud.sh/template-hash': 'before' } },
          spec: {
            replicas: 1,
            template: { spec: { containers: [{ image: 'old:runner' }] } },
          },
        });
        expect(f.deployments.recordRunnerRelease).not.toHaveBeenCalled();
        // The count matches now: nothing further is written.
        expect(await f.pass()).not.toContain('patch Deployment');
      },
    );

    it.each([['0.0.1'], [null]])(
      'rolls a runner from before the window (%s) as the next generation',
      async (release) => {
        const f = upgraded(release);
        await f.pass();
        expect(f.deployments.advanceGeneration).toHaveBeenCalledExactlyOnceWith(
          'deployment-a',
          2,
        );
      },
    );

    it('still rolls a replica whose ServiceAccount was recreated (RFC 0044 S16)', async () => {
      const f = upgraded(apiConfig.previousVersion);
      // The ServiceAccount is newer than the replica.
      f.cluster.pods[0]!.metadata!.creationTimestamp = new Date(0);
      f.cluster.seed({
        kind: 'ServiceAccount',
        ...manifests(makeDeployment({ managed: true })).serviceAccount,
        metadata: {
          ...manifests(makeDeployment({ managed: true })).serviceAccount
            .metadata,
          creationTimestamp: new Date(),
        },
      });
      await f.pass();
      expect(f.deployments.advanceGeneration).toHaveBeenCalledOnce();
    });

    it("creates a missing native Deployment from this release's render and records it", async () => {
      const f = harness(
        makeDeployment({
          managed: true,
          runnerRelease: apiConfig.previousVersion,
        }),
      );
      f.idle();
      expect(await f.pass()).toContain('create Deployment');
      expect(f.deployments.recordRunnerRelease).toHaveBeenCalledExactlyOnceWith(
        'deployment-a',
        apiConfig.currVersion,
      );
    });
  });

  it('repairs the egress policy on a pass that drains, and never blocks a deletion past a foreign namespace', async () => {
    const f = harness(makeDeployment());
    seedApplied(f, (existing) => {
      existing.metadata!.annotations!['anycloud.sh/generation'] = '1';
    });
    f.cluster.pods = [runningPod('pod-a', 'container-a', 1)];
    f.jobs.listTargetedExecutions.mockResolvedValue([execution()]);
    // An older generation still drains: the pass returns before any apply.
    expect(await f.pass()).toEqual([]);
    const policy = buildNodePoolEgressPolicy(nodePool);
    await f.client.objects.delete(policy);
    await vi.waitFor(() =>
      expect(
        f.view
          .cache(nodePool.clusterId)
          .get('NetworkPolicy', config.namespace, policy.metadata!.name!),
      ).toBeUndefined(),
    );
    expect(await f.pass()).toEqual(['read Namespace', 'apply NetworkPolicy']);

    // A deletion that still has its native Deployment repairs the policy
    // before it deletes; one past it never touches a foreign namespace.
    const draining = harness(makeDeployment({ deletionRequestedAt: 1 }));
    seedApplied(draining, () => undefined);
    draining.idle();
    await draining.client.objects.delete(policy);
    await vi.waitFor(() =>
      expect(
        draining.view
          .cache(nodePool.clusterId)
          .get('NetworkPolicy', config.namespace, policy.metadata!.name!),
      ).toBeUndefined(),
    );
    expect(await draining.pass()).toEqual([
      'read Namespace',
      'apply NetworkPolicy',
      'delete Deployment',
    ]);

    // Pods that outlive their native Deployment still get the policy.
    const orphaned = harness(makeDeployment({ deletionRequestedAt: 1 }));
    orphaned.idle();
    orphaned.cluster.pods = [runningPod('pod-a', 'container-a', 1)];
    await orphaned.client.objects.delete(policy);
    await vi.waitFor(() =>
      expect(
        orphaned.view
          .cache(nodePool.clusterId)
          .get('NetworkPolicy', config.namespace, policy.metadata!.name!),
      ).toBeUndefined(),
    );
    expect(await orphaned.pass()).toEqual([
      'read Namespace',
      'apply NetworkPolicy',
    ]);
    expect(orphaned.deployments.markDeleted).not.toHaveBeenCalled();

    // A foreign namespace never blocks a deletion: the ensure's refusal is
    // ignored and nothing is written into it.
    const deleting = harness(makeDeployment({ deletionRequestedAt: 1 }), {
      namespace: 'foreign',
    });
    seedApplied(deleting, () => undefined);
    deleting.idle();
    expect(await deleting.pass()).toEqual([
      'read Namespace',
      'delete Deployment',
    ]);
    // Past its native Deployment the namespace isn't touched at all.
    await vi.waitFor(() =>
      expect(
        deleting.view
          .cache(nodePool.clusterId)
          .get('Deployment', config.namespace, manifests().name),
      ).toBeUndefined(),
    );
    const last = await deleting.pass();
    expect(last.filter((call) => /Namespace|NetworkPolicy/.test(call))).toEqual(
      [],
    );
    expect(deleting.deployments.markDeleted).toHaveBeenCalled();
  });

  it('0036/S17 drains before replacing an older generation, deleting it by its cached UID only', async () => {
    const f = harness(makeDeployment({ minReplicas: 2, maxReplicas: 2 }));
    seedApplied(f, (existing) => {
      existing.metadata!.annotations!['anycloud.sh/generation'] = '1';
    });
    f.cluster.pods = [
      runningPod('pod-a', 'container-a', 1),
      runningPod('pod-b', 'container-b', 1),
    ];
    const second = execution({
      jobId: 'job-b',
      executionId: 'execution-b',
      podUid: 'pod-b',
      containerId: 'containerd://container-b',
    });
    f.jobs.listTargetedExecutions.mockResolvedValue([execution(), second]);
    expect(await f.pass()).toEqual([]);
    // Releasing the first replica does not replace either Pod.
    f.jobs.listTargetedExecutions.mockResolvedValue([second]);
    expect(await f.pass()).toEqual([]);
    f.idle();
    f.jobs.listTargetedExecutions.mockResolvedValue([]);
    await f.pass();
    expect(f.cluster.calls).toEqual([
      expect.objectContaining({
        op: 'delete',
        kind: 'Deployment',
        uidPrecondition: 'workload-a',
        propagationPolicy: 'Foreground',
      }),
    ]);
    // The watch's DELETED event runs the next pass, which creates.
    expect(await f.pass()).toContain('create Deployment');
    const replacement = f.cluster.get(
      'Deployment',
      config.namespace,
      manifests().name,
    )!;
    expect(replacement).toMatchObject({ spec: { replicas: 2 } });
    expect(await f.pass()).toEqual([]);
    // A rerun whose cache still shows the old Deployment deletes
    // nothing it didn't see.
    const synced = f.view.cache(nodePool.clusterId);
    const stale = structuredClone(replacement);
    stale.metadata!.uid = 'workload-a';
    stale.metadata!.annotations!['anycloud.sh/generation'] = '1';
    await f.pass({
      cache: () => ({
        ...synced,
        get: (kind, namespace, name) =>
          (kind === 'Deployment'
            ? stale
            : synced.get(kind, namespace, name)) as never,
      }),
    });
    expect(f.cluster.calls).toEqual([
      expect.objectContaining({ op: 'delete', uidPrecondition: 'workload-a' }),
    ]);
    expect(
      f.cluster.get('Deployment', config.namespace, manifests().name)?.metadata
        ?.uid,
    ).toBe(replacement.metadata!.uid);
  });

  it('0044/I7 writes nothing while the cache matches; 0044/S16 repairs a natively deleted Secret with no restart and restarts the replica for a recreated ServiceAccount', async () => {
    // An empty value, a fractional CPU and decimal bytes: the server stores
    // each its own way.
    const deployment = makeDeployment({
      secretNames: ['db'],
      config: makeContainerSpec({
        env: { EMPTY: '', MODE: 'prod' },
        dockerOptions: { cpus: '0.29', memory: '64000000' },
      }),
    });
    const f = harness(deployment, { secretValues: { db: { DB_URL: 'x' } } });
    f.idle();
    // Every object the cache lacks is created, and nothing is read.
    expect(await f.pass()).toEqual([
      'read Namespace',
      'apply NetworkPolicy',
      'create ServiceAccount',
      'create Secret',
      'create Deployment',
    ]);
    expect(await f.pass()).toEqual([]);
    // A 410 relists every compacted kind; list items carry no kind or
    // apiVersion, and the relisted cache still matches.
    f.cluster.seed({ kind: 'Node', metadata: { name: 'node-a' } });
    f.cluster.compactedBelow = f.cluster.resourceVersion;
    const lists = () =>
      f.cluster.calls.filter(
        (call) => call.op === 'list' && call.kind === 'Deployment',
      ).length;
    f.cluster.calls.length = 0;
    f.cluster.endWatches();
    await vi.waitFor(() => expect(lists()).toBe(1));
    expect(await f.pass()).toEqual([]);
    // A replica newer than its ServiceAccount is converged: zero calls.
    const replica = runningPod('replica', 'container-a', 2);
    replica.metadata!.creationTimestamp = new Date();
    f.cluster.pods = [replica];
    expect(await f.pass()).toEqual([]);
    const envSecret = manifests(deployment).secrets[0]!.metadata!.name!;
    await f.client.core.deleteNamespacedSecret({
      namespace: config.namespace,
      name: envSecret,
    });
    const repair = await f.pass();
    expect(repair).toContain('create Secret');
    expect(repair.filter((call) => call.startsWith('delete'))).toEqual([]);
    expect(f.cluster.get('Secret', config.namespace, envSecret)).toMatchObject({
      data: { DB_URL: Buffer.from('x').toString('base64') },
    });
    expect(await f.pass()).toEqual([]);
    // A rotated value differs from the cache, so it is applied.
    f.input.secrets.getSecretValues = async () => ({ DB_URL: 'y' });
    expect(await f.pass()).toContain('apply Secret');
    // A recreated ServiceAccount has a new UID that the replica's bound
    // token doesn't carry. The pass that recreates it restarts nothing.
    expect(f.deployments.advanceGeneration).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await f.client.core.deleteNamespacedServiceAccount({
      namespace: config.namespace,
      name: manifests(deployment).name,
    });
    expect(await f.pass()).toEqual([
      'read Namespace',
      'apply NetworkPolicy',
      'create ServiceAccount',
    ]);
    // Not once kubelet has had the token's hour to refresh it.
    f.input.now.mockReturnValueOnce(Date.now() + 3_600_000);
    expect(await f.pass()).toEqual([]);
    expect(f.deployments.advanceGeneration).not.toHaveBeenCalled();
    // Within the hour the restart is the next generation, so a replica in
    // mid-session is neither deleted nor replaced until its Job's release.
    f.jobs.listTargetedExecutions.mockResolvedValue([
      execution({ podUid: 'replica', generation: 2 }),
    ]);
    f.jobs.countTargetedJobs.mockResolvedValue({
      queued: 0,
      running: 1,
      retrying: 0,
      terminal: 0,
      unreleased: 1,
    });
    expect(await f.pass()).toEqual([]);
    expect(f.deployments.advanceGeneration).toHaveBeenCalledWith(
      deployment.id,
      2,
    );
    f.deployments.getById.mockResolvedValue({ ...deployment, generation: 3 });
    expect(await f.pass()).toEqual([]);
    expect(f.jobs.reportTargetedJobExecution).not.toHaveBeenCalled();
    expect(f.cluster.pods.map((pod) => pod.metadata?.uid)).toEqual(['replica']);
    // Released: replaced through the native Deployment, never a Pod delete.
    f.idle();
    f.jobs.listTargetedExecutions.mockResolvedValue([]);
    expect(await f.pass()).toEqual(['delete Deployment']);
    // Foreground deletion took the old replica with it; the replacement is
    // newer than the ServiceAccount, so nothing restarts again.
    f.cluster.pods = [];
    expect(await f.pass()).toContain('create Deployment');
    const replacement = runningPod('replacement', 'container-r', 3);
    replacement.metadata!.creationTimestamp = new Date();
    f.cluster.pods = [replacement];
    expect(await f.pass()).toEqual([]);
    expect(f.deployments.advanceGeneration).toHaveBeenCalledOnce();
  });

  it('resolves named Secrets before any write and still deletes without them', async () => {
    const deployment = makeDeployment({ secretNames: ['db', 'tracking'] });
    const missing = harness(deployment, {
      secretValues: { db: { DB_URL: 'old' } },
    });
    missing.idle();
    await expect(missing.pass()).rejects.toThrow('Secret "tracking" not found');
    expect(missing.cluster.calls).toEqual([]);

    const f = harness(deployment, {
      secretValues: {
        db: { DB_URL: 'old', SHARED: 'db' },
        tracking: { SHARED: 'tracking' },
      },
    });
    f.idle();
    await f.pass();
    const envSecret = manifests(deployment).secrets[0]!.metadata!.name!;
    expect(f.cluster.get('Secret', config.namespace, envSecret)).toMatchObject({
      data: {
        DB_URL: Buffer.from('old').toString('base64'),
        SHARED: Buffer.from('tracking').toString('base64'),
      },
    });
    f.deployments.getById.mockResolvedValue({
      ...deployment,
      deletionRequestedAt: 3,
    });
    f.input.secrets.getSecretValues = async () => null;
    // The native Deployment goes first, by its cached UID; each later step
    // runs on the watch event that shows the previous one done.
    expect(await f.pass()).toEqual(['delete Deployment']);
    expect(f.deployments.markDeleted).not.toHaveBeenCalled();
    await f.pass();
    expect(f.deployments.markDeleted).toHaveBeenCalledWith(deployment.id);
    // Only the node pool's own objects remain: its namespace and egress policy.
    expect(
      [...f.cluster.objects.values()].map((object) => object.kind).sort(),
    ).toEqual(['Namespace', 'NetworkPolicy']);
  });

  it('replaces an env Secret that lost a key and deletes an owned Secret no longer rendered, each by its cached UID', async () => {
    const deployment = makeDeployment({
      config: makeContainerSpec({ env: { KEEP: '1', DROP: '2' } }),
    });
    const f = harness(deployment);
    f.idle();
    await f.pass();
    const [envSecret] = manifests(deployment).secrets;
    const name = envSecret!.metadata!.name!;
    const first = f.cluster.get('Secret', config.namespace, name)!;
    const stale = kubernetesWorkloadSecretName(
      'deployment',
      deployment.id,
      'registry-auth',
    );
    f.cluster.seed({
      kind: 'Secret',
      metadata: {
        name: stale,
        namespace: config.namespace,
        uid: 'stale-uid',
        labels: envSecret!.metadata!.labels,
        annotations: envSecret!.metadata!.annotations,
      },
    });
    f.deployments.getById.mockResolvedValue(
      makeDeployment({ config: makeContainerSpec({ env: { KEEP: '1' } }) }),
    );
    await f.pass();
    expect(f.cluster.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: 'delete',
          name,
          uidPrecondition: first.metadata!.uid,
        }),
        expect.objectContaining({ op: 'create', kind: 'Secret', name }),
        expect.objectContaining({
          op: 'delete',
          name: stale,
          uidPrecondition: 'stale-uid',
        }),
      ]),
    );
    expect(f.cluster.get('Secret', config.namespace, name)).toMatchObject({
      data: { KEEP: Buffer.from('1').toString('base64') },
    });
    expect(
      Object.keys(
        (f.cluster.get('Secret', config.namespace, name)!.data as object) ?? {},
      ),
    ).toEqual(['KEEP']);
    expect(f.cluster.get('Secret', config.namespace, stale)).toBeUndefined();
  });

  it('deletes a record only once its work is resolved and its replicas are gone', async () => {
    const f = harness(makeDeployment({ deletionRequestedAt: 3 }));
    f.idle();
    seedApplied(f, () => undefined);
    for (const blocking of ['queued', 'retrying', 'unreleased'] as const) {
      f.jobs.countTargetedJobs.mockResolvedValueOnce({
        queued: 0,
        running: 0,
        retrying: 0,
        terminal: 0,
        unreleased: 0,
      });
      f.jobs.countTargetedJobs.mockResolvedValueOnce({
        queued: 0,
        running: 0,
        retrying: 0,
        terminal: 0,
        unreleased: 0,
        [blocking]: 1,
      });
      expect(await f.pass()).toEqual([]);
    }
    expect(await f.pass()).toEqual(['delete Deployment']);
    // The replica outlives its native Deployment until GC removes it.
    f.cluster.pods = [runningPod('pod-a', 'container-a', 2)];
    await f.pass();
    expect(f.deployments.markDeleted).not.toHaveBeenCalled();
    f.cluster.pods = [];
    await f.pass();
    expect(f.deployments.markDeleted).toHaveBeenCalledWith('deployment-a');
  });

  it('confirms a Pod missing from the cache with one direct read before recording it lost', async () => {
    const f = harness(makeDeployment());
    // Claimed by a Pod the watch hasn't delivered yet.
    const claimed = runningPod('new-pod', 'new-container', 2);
    vi.spyOn(f.client.core, 'listNamespacedPod').mockResolvedValue({
      items: [claimed],
    });
    f.jobs.listTargetedExecutions.mockResolvedValue([
      execution({
        generation: 2,
        podUid: 'new-pod',
        containerId: 'containerd://new-container',
      }),
    ]);
    await f.pass();
    expect(f.client.core.listNamespacedPod).toHaveBeenCalledOnce();
    expect(f.jobs.reportTargetedJobExecution).not.toHaveBeenCalled();
  });

  it('does not retry work owned by an older Pod while its replacement overlaps', async () => {
    const f = harness(makeDeployment());
    f.cluster.pods = [
      runningPod('old-pod', 'old-container', 1),
      runningPod('new-pod', 'new-container', 2),
    ];
    f.jobs.listTargetedExecutions.mockResolvedValue([
      execution({
        podUid: 'old-pod',
        containerId: 'containerd://old-container',
      }),
    ]);
    const calls = await f.pass();
    expect(calls.filter((call) => call.endsWith('Deployment'))).toEqual([]);
    expect(f.jobs.reportTargetedJobExecution).not.toHaveBeenCalled();
  });

  it.each(
    [
      {
        name: '0044/S17 a restarted replica whose claimed container was OOMKilled',
        status: {
          restartCount: 1,
          state: { running: { startedAt: new Date(2) } },
          lastState: {
            terminated: {
              exitCode: 137,
              reason: 'OOMKilled',
              containerID: 'containerd://container-a',
            },
          },
        },
        reason: 'replica OOMKilled (exit 137)',
        cause: { kind: 'exit', code: 137, oom: true },
        // The Job's command OOMed: on a managed Deployment it ends errored.
        managedEnd: {
          state: WorkloadState.Errored,
          reason: 'OOMKilled (exit 137)',
        },
      },
      {
        name: 'a replica whose claimed container exited and was restarted',
        status: {
          restartCount: 1,
          containerID: 'containerd://container-b',
          state: { running: { startedAt: new Date(3) } },
          lastState: {
            terminated: {
              exitCode: 1,
              reason: 'Error',
              containerID: 'containerd://container-a',
            },
          },
        },
        reason: 'replica exited with code 1',
        cause: { kind: 'exit', code: 1, oom: false },
        managedEnd: {
          state: WorkloadState.Retrying,
          reason: 'runner exited with code 1',
        },
      },
      // On a managed Deployment the runner didn't report: a plain exit
      // (killed mid-upload) retries, and an OOM was the Job's.
    ].flatMap((row) => [false, true].map((managed) => ({ ...row, managed }))),
  )(
    'retries $name (managed: $managed) with its cause and keeps its log tail',
    async ({ status, reason, cause, managed, managedEnd }) => {
      const pod = runningPod('pod-a', 'container-c', 2);
      Object.assign(pod.status!.containerStatuses![0]!, status);
      const f = harness(makeDeployment({ managed }));
      f.cluster.pods = [pod];
      // The claimed instance's log is the previous run's once kubelet has
      // restarted the container, or its own while it still shows.
      const restarted =
        pod.status!.containerStatuses![0]!.containerID !==
        'containerd://container-a';
      // A runner replica's log is read stamped, and keeps only the Job's span.
      f.cluster.logs.set(
        `pod-a/workload${restarted ? '/previous' : ''}`,
        `${managed ? '2026-10-14T10:00:00.000000000Z ' : ''}started:job-a\n`,
      );
      f.jobs.listTargetedExecutions.mockResolvedValue([execution()]);
      await f.pass();
      expect(f.jobs.recordAttemptLogTail).toHaveBeenCalledExactlyOnceWith(
        'execution-a',
        { state: 'captured', text: 'started:job-a\n' },
      );
      // Stored before the outcome, so a crash between them can't lose it.
      expect(
        f.jobs.recordAttemptLogTail.mock.invocationCallOrder[0],
      ).toBeLessThan(
        f.jobs.reportTargetedJobExecution.mock.invocationCallOrder[0]!,
      );
      expect(f.jobs.reportTargetedJobExecution).toHaveBeenCalledExactlyOnceWith(
        'job-a',
        'execution-a',
        managed
          ? { ...managedEnd, cause }
          : { state: WorkloadState.Retrying, reason, cause },
      );
      expect(f.jobs.recordPodNode).toHaveBeenCalledExactlyOnceWith(
        'execution-a',
        'node-a',
      );
    },
  );

  it('leaves a forced stop open while its runner still runs, so the upload can finish', async () => {
    const f = harness(makeDeployment({ managed: true }));
    f.cluster.pods = [runningPod('pod-a', 'container-a', 2)];
    f.jobs.listTargetedExecutions.mockResolvedValue([execution()]);
    f.jobs.wasForcedStop.mockReturnValue(true);
    await f.pass();
    expect(f.jobs.reportTargetedJobExecution).not.toHaveBeenCalled();
  });

  it('decision 30 retries a Job whose replica a forced upgrade stopped before its runner reported', async () => {
    const pod = runningPod('pod-a', 'container-a', 2);
    pod.status!.containerStatuses![0]!.state = {
      terminated: { exitCode: 143, containerID: 'containerd://container-a' },
    };
    const f = harness(makeDeployment({ managed: true }));
    f.cluster.pods = [pod];
    f.jobs.listTargetedExecutions.mockResolvedValue([execution()]);
    f.jobs.wasForcedStop.mockReturnValue(true);
    await f.pass();
    expect(f.jobs.reportTargetedJobExecution).toHaveBeenCalledExactlyOnceWith(
      'job-a',
      'execution-a',
      {
        state: WorkloadState.Retrying,
        reason:
          'forced upgrade: the replica stopped before its runner reported',
        cause: {
          kind: 'disrupted',
          detail:
            'forced upgrade: the replica stopped before its runner reported',
        },
      },
    );
  });

  it.each([
    [
      'every queued Job when the runner cannot execute in the image',
      {
        restartCount: 3,
        state: { waiting: { reason: 'CrashLoopBackOff' } },
        lastState: { terminated: { exitCode: 127, message: 'exec failed' } },
      },
      "The runner can't execute in the image (exit 127): exec failed",
      0,
    ],
    [
      'every queued Job, at the first restart, when a user-namespace runner cannot delegate its cgroup (RFC 0049 C32)',
      {
        restartCount: 1,
        state: { waiting: { reason: 'CrashLoopBackOff' } },
        lastState: {
          terminated: { exitCode: 78, message: 'needs passwordless sudo' },
        },
      },
      'needs passwordless sudo',
      0,
    ],
    [
      'the queued Jobs whose pull token kubelet has tried when the registry refuses the image',
      {
        state: {
          waiting: {
            reason: 'ImagePullBackOff',
            message: 'manifest unknown: not found',
          },
        },
      },
      "The image can't be pulled: manifest unknown: not found",
      600_000,
    ],
  ])('fails as invalid %s', async (_name, status, message, backOff) => {
    const pod = runningPod('pod-a', 'container-a', 2);
    Object.assign(pod.status!.containerStatuses![0]!, status);
    const f = harness(makeDeployment({ managed: true }));
    f.input.now.mockReturnValue(10_000_000);
    f.cluster.pods = [pod];
    await f.pass();
    expect(
      f.jobs.terminateUnassignedTargetedJobs,
    ).toHaveBeenCalledExactlyOnceWith('deployment-a', {
      message,
      before: 10_000_000 - backOff,
    });
  });

  it('leaves a crash-looping runner that has not failed three times, and a user Deployment, running', async () => {
    for (const [managed, restartCount] of [
      [true, 2],
      [false, 3],
    ] as const) {
      const pod = runningPod('pod-a', 'container-a', 2);
      Object.assign(pod.status!.containerStatuses![0]!, {
        restartCount,
        lastState: { terminated: { exitCode: 127 } },
      });
      const f = harness(makeDeployment({ managed }));
      f.cluster.pods = [pod];
      await f.pass();
      expect(f.jobs.terminateUnassignedTargetedJobs).not.toHaveBeenCalled();
    }
  });

  it('asks to delete an idle managed Deployment after 24 h with no Job, and stops the pass once it is marked', async () => {
    const f = harness(makeDeployment({ managed: true }));
    f.idle();
    f.input.now.mockReturnValue(100 * 3_600_000);
    f.deployments.requestIdleDeletion.mockResolvedValue(true);
    expect(await f.pass()).toEqual([]);
    expect(f.deployments.requestIdleDeletion).toHaveBeenCalledExactlyOnceWith(
      'deployment-a',
      76 * 3_600_000,
    );
    const user = harness(makeDeployment());
    user.idle();
    await user.pass();
    expect(user.deployments.requestIdleDeletion).not.toHaveBeenCalled();
  });

  it("retries a deleted managed replica's Job as a stop, since the runner reports nothing on SIGTERM", async () => {
    const f = harness(makeDeployment({ managed: true }));
    const pod = runningPod('pod-a', 'container-a', 2);
    pod.metadata!.deletionTimestamp = new Date();
    pod.status!.containerStatuses![0]!.state = {
      terminated: {
        exitCode: 0,
        reason: 'Completed',
        containerID: 'containerd://container-a',
      },
    };
    f.cluster.pods = [pod];
    f.jobs.listTargetedExecutions.mockResolvedValue([execution()]);
    await f.pass();
    expect(f.jobs.reportTargetedJobExecution).toHaveBeenCalledWith(
      'job-a',
      'execution-a',
      expect.objectContaining({
        state: WorkloadState.Retrying,
        reason: 'replica stopped: its Pod was deleted',
      }),
    );
  });

  // The kubelet gives a limit eviction 2 s, so the runner exits 143 or is
  // killed with 137 before the Pod shows why.
  it.each([143, 137])(
    "waits for the kubelet to say why a managed replica's runner exited %i, so an eviction at the limit ends the Job invalid (0043/S12)",
    async (exitCode) => {
      const f = harness(makeDeployment({ managed: true }));
      const pod = runningPod('pod-a', 'container-a', 2);
      pod.status!.containerStatuses![0]!.state = {
        terminated: {
          exitCode,
          reason: 'Error',
          containerID: 'containerd://container-a',
        },
      };
      f.cluster.pods = [pod];
      f.jobs.listTargetedExecutions.mockResolvedValue([execution()]);
      await f.pass();
      expect(f.jobs.reportTargetedJobExecution).not.toHaveBeenCalled();
      const limit =
        'Pod ephemeral local storage usage exceeds the total limit of containers 716Mi.';
      Object.assign(pod.status!, {
        phase: 'Failed',
        reason: 'Evicted',
        message: limit,
      });
      f.cluster.pods = [pod];
      await f.pass();
      expect(f.jobs.reportTargetedJobExecution).toHaveBeenCalledWith(
        'job-a',
        'execution-a',
        expect.objectContaining({
          state: WorkloadState.Invalid,
          reason: `Evicted: ${limit}`,
        }),
      );
    },
  );

  // Run 38980416737: a Pod being torn down shows the claimed instance in
  // lastState, the container waiting and no new one started, before the
  // kubelet writes why. The managed Job waits for a new instance or the
  // Pod's end.
  it("waits on a managed replica's exited runner the kubelet hasn't started again", async () => {
    const f = harness(makeDeployment({ managed: true }));
    const pod = runningPod('pod-a', 'container-a', 2);
    Object.assign(pod.status!.containerStatuses![0]!, {
      containerID: 'containerd://container-a',
      state: { waiting: { reason: 'CrashLoopBackOff' } },
      lastState: {
        terminated: {
          exitCode: 0,
          reason: 'Completed',
          containerID: 'containerd://container-a',
        },
      },
    });
    f.cluster.pods = [pod];
    f.jobs.listTargetedExecutions.mockResolvedValue([execution()]);
    await f.pass();
    expect(f.jobs.reportTargetedJobExecution).not.toHaveBeenCalled();
  });

  it.each(['ImagePullBackOff', 'CreateContainerConfigError'])(
    "retries a managed replica's Job when the restart of its exited runner can't start (%s)",
    async (reason) => {
      const f = harness(makeDeployment({ managed: true }));
      const pod = runningPod('pod-a', 'container-a', 2);
      Object.assign(pod.status!.containerStatuses![0]!, {
        containerID: 'containerd://container-a',
        state: { waiting: { reason } },
        lastState: {
          terminated: {
            exitCode: 0,
            reason: 'Completed',
            containerID: 'containerd://container-a',
          },
        },
      });
      f.cluster.pods = [pod];
      f.jobs.listTargetedExecutions.mockResolvedValue([execution()]);
      await f.pass();
      expect(f.jobs.reportTargetedJobExecution).toHaveBeenCalledWith(
        'job-a',
        'execution-a',
        expect.objectContaining({
          state: WorkloadState.Retrying,
          reason: 'runner exited with code 0',
        }),
      );
    },
  );

  it("retries a managed replica's Job when its Node shuts down (RT9's spot pools)", async () => {
    const f = harness(makeDeployment({ managed: true }));
    const pod = runningPod('pod-a', 'container-a', 2);
    const shutdown =
      'Pod was terminated in response to imminent node shutdown.';
    pod.status!.containerStatuses![0]!.state = {
      terminated: {
        exitCode: 143,
        reason: 'Error',
        containerID: 'containerd://container-a',
      },
    };
    Object.assign(pod.status!, {
      phase: 'Failed',
      reason: 'Terminated',
      message: shutdown,
      conditions: [
        {
          type: 'DisruptionTarget',
          status: 'True',
          reason: 'TerminationByKubelet',
          message: shutdown,
        },
      ],
    });
    f.cluster.pods = [pod];
    f.jobs.listTargetedExecutions.mockResolvedValue([execution()]);
    await f.pass();
    expect(f.jobs.reportTargetedJobExecution).toHaveBeenCalledWith(
      'job-a',
      'execution-a',
      expect.objectContaining({
        state: WorkloadState.Retrying,
        reason: `TerminationByKubelet: ${shutdown}`,
      }),
    );
  });

  it("retries a managed replica's Job once the kubelet restarts its exited runner in place", async () => {
    const f = harness(makeDeployment({ managed: true }));
    const pod = runningPod('pod-a', 'container-b', 2);
    Object.assign(pod.status!.containerStatuses![0]!, {
      restartCount: 1,
      lastState: {
        terminated: {
          exitCode: 0,
          reason: 'Completed',
          containerID: 'containerd://container-a',
        },
      },
    });
    f.cluster.pods = [pod];
    f.jobs.listTargetedExecutions.mockResolvedValue([execution()]);
    await f.pass();
    expect(f.jobs.reportTargetedJobExecution).toHaveBeenCalledWith(
      'job-a',
      'execution-a',
      expect.objectContaining({
        state: WorkloadState.Retrying,
        reason: 'runner exited with code 0',
      }),
    );
  });

  it('0044/S18 holds a deleted replica until its container stops and its open execution is recorded, and releases a drained one then', async () => {
    const f = harness(makeDeployment());
    const podCalls = async () =>
      (await f.pass()).filter((call) => call.endsWith(' Pod'));
    const terminating = (uid: string, container: string) => {
      const pod = runningPod(uid, container, 2);
      pod.metadata!.deletionTimestamp = new Date();
      expect(pod.metadata!.finalizers).toEqual([ANYCLOUD_POD_FINALIZER]);
      return pod;
    };
    const stopped = (pod: V1Pod, exitCode: number) => {
      pod.status!.containerStatuses![0]!.state = {
        terminated: {
          exitCode,
          reason: 'Error',
          containerID: pod.status!.containerStatuses![0]!.containerID,
        },
      };
      f.cluster.pods = [pod];
    };
    // A live replica keeps its finalizer even while its container is down.
    const crashing = runningPod('crashing', 'container-x', 2);
    crashing.status!.containerStatuses![0]!.state = {
      waiting: { reason: 'CrashLoopBackOff' },
    };
    f.cluster.pods = [crashing];
    expect(await podCalls()).toEqual([]);
    // A rollout after the drain: nothing names the replica, so it goes as
    // soon as its container stops; a claim committed while it still ran
    // would still find it held.
    const drained = terminating('drained', 'container-d');
    f.cluster.pods = [drained];
    expect(await podCalls()).toEqual([]);
    stopped(drained, 0);
    expect(await podCalls()).toEqual(['patch Pod']);
    expect(f.cluster.pods).toEqual([]);

    // Deleted mid-session: held while the claimed container runs on.
    const held = terminating('pod-a', 'container-a');
    f.cluster.pods = [held];
    f.jobs.listTargetedExecutions.mockResolvedValue([execution()]);
    expect(await podCalls()).toEqual([]);
    // Its container ends: tail, outcome, then the release. A failed write
    // keeps the replica held until a later pass records both.
    stopped(held, 143);
    f.cluster.logs.set('pod-a/workload', 'last words\n');
    f.jobs.reportTargetedJobExecution.mockRejectedValueOnce(
      new Error('database busy'),
    );
    await expect(f.pass()).rejects.toThrow('database busy');
    expect(f.cluster.calls.filter((call) => call.op === 'patch')).toEqual([]);
    expect(f.cluster.pods).toHaveLength(1);
    expect(await podCalls()).toEqual(['log Pod', 'patch Pod']);
    expect(f.jobs.recordAttemptLogTail).toHaveBeenCalledWith('execution-a', {
      state: 'captured',
      text: 'last words\n',
    });
    expect(f.jobs.reportTargetedJobExecution).toHaveBeenCalledWith(
      'job-a',
      'execution-a',
      expect.objectContaining({ reason: 'replica exited with code 143' }),
    );
    expect(f.cluster.pods).toEqual([]);
  });

  it('keeps the tail of a Job claimed on a replica after the owner listed its executions, before releasing it', async () => {
    const f = harness(makeDeployment());
    // The replica is deleting and its container has stopped: releasable.
    const pod = runningPod('pod-a', 'container-a', 2);
    pod.metadata!.deletionTimestamp = new Date();
    pod.status!.containerStatuses![0]!.state = {
      terminated: {
        exitCode: 143,
        reason: 'Error',
        containerID: 'containerd://container-a',
      },
    };
    f.cluster.logs.set('pod-a/workload', 'started:job-a\n');
    // A claim on a live replica in the same gap belongs to the next pass.
    const live = runningPod('pod-b', 'container-b', 2);
    f.cluster.pods = [pod, live];
    // The race: the owner's first read finds no execution, then a claim on
    // the stopped replica commits before the owner closes it to claims.
    const late = execution();
    const elsewhere = execution({
      jobId: 'job-b',
      executionId: 'execution-b',
      podUid: 'pod-b',
      containerId: 'containerd://container-b',
    });
    const order: string[] = [];
    let lists = 0;
    f.jobs.listTargetedExecutions.mockImplementation(async () => {
      order.push('list');
      return lists++ === 0 ? [] : [late, elsewhere];
    });
    f.jobs.closeReplica.mockImplementation(() => order.push('close'));
    f.jobs.recordAttemptLogTail.mockImplementation(async () => {
      order.push('tail');
    });
    f.jobs.reportTargetedJobExecution.mockImplementation(async () => {
      order.push('outcome');
      return true;
    });
    const patch = f.client.core.patchNamespacedPod.bind(f.client.core);
    vi.spyOn(f.client.core, 'patchNamespacedPod').mockImplementation(
      (...args: Parameters<typeof patch>) => {
        order.push('release');
        return patch(...args);
      },
    );
    await f.pass();
    expect(f.jobs.closeReplica).toHaveBeenCalledExactlyOnceWith('pod-a');
    expect(f.jobs.recordAttemptLogTail).toHaveBeenCalledExactlyOnceWith(
      'execution-a',
      { state: 'captured', text: 'started:job-a\n' },
    );
    expect(f.jobs.reportTargetedJobExecution).toHaveBeenCalledExactlyOnceWith(
      'job-a',
      'execution-a',
      expect.objectContaining({ reason: 'replica exited with code 143' }),
    );
    expect(f.cluster.pods.map((item) => item.metadata?.uid)).toEqual(['pod-b']);
    // Closed to claims before the second read, and settled before release.
    expect(order).toEqual([
      'list',
      'close',
      'list',
      'tail',
      'outcome',
      'release',
    ]);
  });

  it('releases no replica when settling a late claim fails, however many are releasable', async () => {
    const f = harness(makeDeployment());
    const stopped = (uid: string) => {
      const pod = runningPod(uid, `container-${uid}`, 2);
      pod.metadata!.deletionTimestamp = new Date();
      pod.status!.containerStatuses![0]!.state = {
        terminated: {
          exitCode: 143,
          reason: 'Error',
          containerID: `containerd://container-${uid}`,
        },
      };
      return pod;
    };
    f.cluster.pods = [stopped('pod-a'), stopped('pod-b')];
    f.jobs.listTargetedExecutions
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        execution({
          podUid: 'pod-b',
          containerId: 'containerd://container-pod-b',
        }),
      ]);
    f.jobs.recordAttemptLogTail.mockRejectedValueOnce(
      new Error('database busy'),
    );
    await expect(f.pass()).rejects.toThrow('database busy');
    expect(f.jobs.closeReplica.mock.calls).toEqual([['pod-a'], ['pod-b']]);
    expect(f.cluster.calls.filter((call) => call.op === 'patch')).toEqual([]);
    expect(f.cluster.pods).toHaveLength(2);
  });

  it('0044 ends an execution whose replica lost its Node, though no kubelet stops its container', async () => {
    const f = harness(makeDeployment({ minReplicas: 2, maxReplicas: 2 }));
    // deleteNodePoolNode force-deletes the Pod; the finalizer keeps it, and
    // Pod GC fails it with DisruptionTarget while its container shows running.
    const pod = runningPod('pod-a', 'container-a', 2);
    pod.metadata!.deletionTimestamp = new Date();
    pod.status!.phase = 'Failed';
    pod.status!.conditions = [
      {
        type: 'DisruptionTarget',
        status: 'True',
        reason: 'DeletionByPodGC',
        message: 'PodGC: node no longer exists',
      },
    ];
    const survivor = runningPod('pod-b', 'container-b', 2);
    f.cluster.pods = [pod, survivor];
    f.jobs.listTargetedExecutions.mockResolvedValue([
      execution({ generation: 2 }),
      execution({
        jobId: 'job-b',
        executionId: 'execution-b',
        podUid: 'pod-b',
        containerId: 'containerd://container-b',
        generation: 2,
      }),
    ]);
    await f.pass();
    expect(f.jobs.reportTargetedJobExecution).toHaveBeenCalledWith(
      'job-a',
      'execution-a',
      expect.objectContaining({
        reason: 'replica DeletionByPodGC: PodGC: node no longer exists',
        cause: expect.objectContaining({ kind: 'disrupted' }),
      }),
    );
    expect(f.jobs.recordAttemptLogTail).toHaveBeenCalledWith(
      'execution-a',
      expect.objectContaining({ state: 'unavailable' }),
    );
    expect(f.jobs.reportTargetedJobExecution).toHaveBeenCalledTimes(1);
    expect(f.cluster.pods).toMatchObject([survivor]);
  });

  it("reads a lost Node's tails at once, so an unreachable kubelet delays its retries by one timeout", async () => {
    const f = harness(makeDeployment({ minReplicas: 3, maxReplicas: 3 }));
    const ids = ['a', 'b', 'c'];
    f.cluster.pods = ids.map((id) => {
      const pod = runningPod(`pod-${id}`, `container-${id}`, 2);
      pod.metadata!.deletionTimestamp = new Date();
      pod.status!.phase = 'Failed';
      pod.status!.conditions = [
        {
          type: 'DisruptionTarget',
          status: 'True',
          reason: 'DeletionByPodGC',
          message: 'PodGC: node no longer exists',
        },
      ];
      return pod;
    });
    f.jobs.listTargetedExecutions.mockResolvedValue(
      ids.map((id) =>
        execution({
          jobId: `job-${id}`,
          executionId: `execution-${id}`,
          podUid: `pod-${id}`,
          containerId: `containerd://container-${id}`,
          generation: 2,
        }),
      ),
    );
    // The kubelet's port is unreachable: each read hangs until it times out.
    const pending: NodeJS.WritableStream[] = [];
    vi.spyOn(f.client.log, 'log').mockImplementation(
      async (_namespace, _pod, _container, sink) => {
        pending.push(sink);
        return new AbortController();
      },
    );
    const pass = f.pass();
    await vi.waitFor(() => expect(pending).toHaveLength(ids.length));
    expect(f.jobs.reportTargetedJobExecution).not.toHaveBeenCalled();
    for (const sink of pending) {
      sink.emit('error', new Error('dial tcp 10.0.0.9:10250: i/o timeout'));
    }
    await pass;
    for (const id of ids) {
      expect(f.jobs.recordAttemptLogTail).toHaveBeenCalledWith(
        `execution-${id}`,
        {
          state: 'unavailable',
          text: 'Its log could not be read: dial tcp 10.0.0.9:10250: i/o timeout.',
        },
      );
      expect(f.jobs.reportTargetedJobExecution).toHaveBeenCalledWith(
        `job-${id}`,
        `execution-${id}`,
        expect.objectContaining({
          cause: expect.objectContaining({ kind: 'disrupted' }),
        }),
      );
    }
  });

  it("0044 keeps an evicted replica's execution and finalizer until its container stops", async () => {
    const f = harness(makeDeployment());
    // The Eviction API sets DisruptionTarget while main runs its grace.
    const pod = runningPod('pod-a', 'container-a', 2);
    pod.metadata!.deletionTimestamp = new Date();
    pod.status!.conditions = [
      {
        type: 'DisruptionTarget',
        status: 'True',
        reason: 'EvictionByEvictionAPI',
        message: 'Eviction API: evicting',
      },
    ];
    f.cluster.pods = [pod];
    f.jobs.listTargetedExecutions.mockResolvedValue([execution()]);
    await f.pass();
    expect(f.jobs.reportTargetedJobExecution).not.toHaveBeenCalled();
    expect(f.cluster.pods).toHaveLength(1);
    pod.status!.containerStatuses![0]!.state = {
      terminated: {
        exitCode: 143,
        reason: 'Error',
        containerID: 'containerd://container-a',
      },
    };
    f.cluster.pods = [pod];
    await f.pass();
    expect(f.jobs.reportTargetedJobExecution).toHaveBeenCalledWith(
      'job-a',
      'execution-a',
      expect.objectContaining({
        reason: 'replica EvictionByEvictionAPI: Eviction API: evicting',
      }),
    );
    expect(f.cluster.pods).toEqual([]);
  });

  it("refuses to replace a same-named native Deployment that isn't the record's, and deletes the record past it", async () => {
    const f = harness(makeDeployment());
    const foreign = structuredClone(manifests().kubernetesDeployment);
    foreign.metadata!.annotations = {
      ...foreign.metadata!.annotations,
      'anycloud.sh/deployment-id': 'someone-else',
      'anycloud.sh/generation': '1',
    };
    f.cluster.seed({ ...foreign, kind: 'Deployment' });
    f.idle();
    await expect(f.pass()).rejects.toThrow('owned by another workload');
    expect(f.cluster.calls.filter((call) => call.op === 'delete')).toEqual([]);
    f.deployments.getById.mockResolvedValue(
      makeDeployment({ deletionRequestedAt: 3 }),
    );
    await f.pass();
    expect(f.deployments.markDeleted).toHaveBeenCalledWith('deployment-a');
    expect(
      f.cluster.get('Deployment', config.namespace, manifests().name),
    ).toBeDefined();
  });

  describe('namespace lifecycle on the node pool', () => {
    it('creates the node pool namespace before the handler objects and writes only into it', async () => {
      const f = harness(makeDeployment(), { namespace: 'missing' });
      f.idle();
      const calls = await f.pass();
      expect(calls.filter((call) => call.startsWith('create'))).toEqual([
        'create Namespace',
        'create ServiceAccount',
        'create Deployment',
      ]);
      expect(
        f.cluster.get('Namespace', '', config.namespace)?.metadata?.labels,
      ).toEqual({
        'app.kubernetes.io/managed-by': 'anycloud',
        'anycloud.sh/cluster': nodePool.clusterId,
        'anycloud.sh/node-pool': nodePool.nodePoolId,
      });
      expect(
        f.cluster.calls.every(
          (call) =>
            call.kind === 'Namespace' || call.namespace === config.namespace,
        ),
      ).toBe(true);
    });

    it('fails closed on a foreign namespace and writes nothing into it', async () => {
      const f = harness(makeDeployment(), { namespace: 'foreign' });
      f.idle();
      await expect(f.pass()).rejects.toThrow();
      expect(f.cluster.calls).toEqual([
        expect.objectContaining({ op: 'read', kind: 'Namespace' }),
      ]);
    });

    it('reconstructs in-flight executions from the ledger after a restart and retries work whose handler Pod is gone', async () => {
      const f = harness(makeDeployment());
      f.cluster.pods = [runningPod('pod-live', 'container-live', 2)];
      // A new process knows nothing but the ledger: one execution still bound
      // to a live Pod, one bound to a Pod that vanished, one already terminal.
      f.jobs.listTargetedExecutions.mockResolvedValue([
        execution({
          jobId: 'job-live',
          executionId: 'exec-live',
          podUid: 'pod-live',
          containerId: 'containerd://container-live',
          generation: 2,
        }),
        execution({
          jobId: 'job-lost',
          executionId: 'exec-lost',
          podUid: 'pod-lost',
          containerId: 'containerd://container-lost',
          generation: 2,
        }),
        execution({
          jobId: 'job-done',
          executionId: 'exec-done',
          podUid: 'pod-lost',
          containerId: 'containerd://container-lost',
          generation: 2,
          state: WorkloadState.Completed,
        }),
      ]);
      await f.pass();
      expect(f.jobs.reportTargetedJobExecution).toHaveBeenCalledExactlyOnceWith(
        'job-lost',
        'exec-lost',
        lost,
      );
      expect(f.jobs.completeTargetedJobCleanup).toHaveBeenCalledExactlyOnceWith(
        'job-done',
        'exec-done',
      );
      expect(f.jobs.recordAttemptLogTail).toHaveBeenCalledExactlyOnceWith(
        'exec-lost',
        {
          state: 'unavailable',
          text: 'Its Pod was gone before its log was read.',
        },
      );
    });
  });
});

describe('Deployment controller on the pool loop', () => {
  it('0036/S26 reads updates and skips Deployments removed after ID discovery', async () => {
    const deployment = makeDeployment();
    const f = harness(deployment);
    f.idle();
    const stored = new Map([
      [deployment.id, deployment],
      ['deleted-deployment', makeDeployment({ id: 'deleted-deployment' })],
    ]);
    f.deployments.getById.mockImplementation(
      async (id) => stored.get(id) ?? null,
    );
    f.deployments.listForReconciliation.mockImplementation(async () => {
      const discoveredIds = [...stored.keys()];
      // Commits after discovery captured IDs but before reconciliation reads.
      stored.set(
        deployment.id,
        makeDeployment({
          generation: 3,
          updatedAt: 3,
          config: makeContainerSpec({ image: 'updated:image' }),
        }),
      );
      stored.delete('deleted-deployment');
      return discoveredIds;
    });
    const changed = vi.fn();
    const controller = createDeploymentController({
      ...f.input,
      clusters: { resolve: async () => ({ cluster: f.client }) },
      changed,
    });
    await controller.start();
    await vi.waitFor(() =>
      expect(
        f.cluster.get('Deployment', config.namespace, manifests().name),
      ).toMatchObject({
        metadata: { annotations: { 'anycloud.sh/generation': '3' } },
        spec: {
          template: { spec: { containers: [{ image: 'updated:image' }] } },
        },
      }),
    );
    // The watch reports the controller's own writes to the claim queue.
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(deployment.id));
    await controller.stop();
    expect(f.deployments.listForReconciliation).toHaveBeenCalledOnce();
    expect(f.deployments.getById).toHaveBeenCalledWith('deleted-deployment');
  });

  it('0048/S9: shows "fits no Node of pool P" on a Pending replica the node pool reported unfit', async () => {
    const deployment = makeDeployment();
    const f = harness(deployment);
    const controller = createDeploymentController({
      ...f.input,
      clusters: { resolve: async () => ({ cluster: f.client }) },
      changed: vi.fn(),
    });
    f.cluster.seed({
      ...manifests(deployment).kubernetesDeployment,
      kind: 'Deployment',
    });
    f.cluster.seed({
      ...runningPod('replica-uid', 'c', 1),
      kind: 'Pod',
      spec: { containers: [] },
      status: { phase: 'Pending' },
    });
    const reason = async () =>
      (await controller.observe(deployment)).workload.pendingReason;
    const message = 'fits no Node of pool gpu';
    controller.unfit(deployment.nodePoolId, message, new Set(['replica-uid']));
    expect(await reason()).toBe(message);
    controller.unfit(deployment.nodePoolId, message, new Set());
    expect(await reason()).toBeFalsy();
  });

  it('re-applies a deleted or edited pool egress NetworkPolicy exactly once per namespace', async () => {
    const deployment = makeDeployment();
    const sibling = makeDeployment({ id: 'deployment-b', name: 'sibling' });
    const f = harness(deployment);
    f.idle();
    const records = new Map([deployment, sibling].map((d) => [d.id, d]));
    f.deployments.getById.mockImplementation(
      async (id) => records.get(id) ?? null,
    );
    f.deployments.listForReconciliation.mockResolvedValue([...records.keys()]);
    const controller = createDeploymentController({
      ...f.input,
      clusters: { resolve: async () => ({ cluster: f.client }) },
      changed: vi.fn(),
    });
    await controller.start();
    const policy = buildNodePoolEgressPolicy(nodePool);
    const stored = () =>
      f.cluster.get('NetworkPolicy', config.namespace, policy.metadata!.name!);
    await vi.waitFor(() =>
      expect(
        f.cluster.calls.filter(
          (call) => call.op === 'create' && call.kind === 'Deployment',
        ),
      ).toHaveLength(2),
    );
    const writes = (from: number) =>
      f.cluster.calls
        .slice(from)
        .filter((call) => ['create', 'apply', 'delete'].includes(call.op))
        .map((call) => `${call.op} ${call.kind}`);
    // Each drift, the harness's own write, is followed by exactly one
    // re-apply for the namespace, and nothing else.
    const repaired = async (drift: () => Promise<unknown>) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const from = f.cluster.calls.length;
      await drift();
      await vi.waitFor(() => expect(stored()?.spec).toEqual(policy.spec));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(writes(from).slice(1)).toEqual(['apply NetworkPolicy']);
      // Converged again: once the harness's cache sees the repair, a pass
      // writes nothing.
      await vi.waitFor(() =>
        expect(
          f.view
            .cache(nodePool.clusterId)
            .get<V1NetworkPolicy>(
              'NetworkPolicy',
              config.namespace,
              policy.metadata!.name!,
            )?.spec,
        ).toEqual(policy.spec),
      );
      expect(await f.pass()).toEqual([]);
    };
    await repaired(() => f.client.objects.delete(policy));
    // An edit that drops a rule, and one that only widens egress.
    const [dns, pool, internet] = policy.spec!.egress!;
    await repaired(() =>
      f.client.objects.patch({
        ...policy,
        spec: { ...policy.spec, egress: [dns!, internet!] },
      }),
    );
    await repaired(() =>
      f.client.objects.patch({
        ...policy,
        spec: {
          ...policy.spec,
          egress: [
            dns!,
            { to: [{ ...pool!.to![0], namespaceSelector: {} }] },
            internet!,
          ],
        },
      }),
    );
    await controller.stop();
  });
});
