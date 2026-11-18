import { claimSpendBlock } from '../../../src/api/services/spend-controls.js';
import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkloadExecution } from '../../../src/shared/api-contract/deployment-workload-schemas.js';
import { BucketNameTakenError } from '../../../src/shared/errors.js';
import type { V1Pod, V1TokenReview } from '@kubernetes/client-node';
import { createDeploymentController } from '../../../src/api/services/deployment-controller.js';
import { createDeploymentWorkloadDomain } from '../../../src/api/services/deployment-workload-domain.js';
import {
  ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE,
  KUBERNETES_DEPLOYMENT_CONTAINER,
} from '../../../src/api/services/kubernetes/pool-objects.js';
import { renderDeploymentObjects } from '../../../src/api/services/deployment-objects.js';
import {
  kubernetesWorkloadPodSelector,
  kubernetesWorkloadResourceName,
} from '../../../src/api/services/kubernetes/identity.js';
import {
  nodePoolNamespace,
  UNUSABLE_GPU_NODE_LABEL,
} from '../../../src/api/services/kubernetes/node-pool-scheduling.js';
import { UNUSABLE_GPU_HINT } from '../../../src/api/services/workload-workflows/missing-gpu.js';
import {
  UNUSABLE_GPU_POOL_RERUN,
  UNUSABLE_GPU_POOL_RETRY,
} from '../../../src/api/services/job-outcome.js';
import { NODE_GPU_CHECK_IMAGE } from '../../../src/api/services/kubernetes/node-gpu-check.js';
import type { NodePoolKubernetesRuntime } from '../../../src/api/services/kubernetes/deployment-runtime.js';
import {
  getDeploymentStore,
  getPersistence,
  getDeploymentExecutionStore,
  resetPersistence,
  getWorkloadLifecycle,
  getWorkloadOutcomes,
  getSpendControlsStore,
} from '../../../src/api/services/persistence.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { getWorkloadAdmissionWriter } from '../../../src/api/services/workload-admission-writer.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import {
  makeContainerSpec,
  makeClusterKubernetesClientFixture,
  makeReplicaPolicyDependencies,
} from '../helpers/fixtures.js';
import { buildNodePoolEgressPolicy } from '../../../src/api/services/kubernetes/node-pool-namespace.js';
import { FakeKubernetesCluster } from '../helpers/fake-kubernetes-cluster.js';
import config from '../../../src/api/config.js';
import { encodeContainerSpec } from '../../../src/api/services/container-spec.js';

/** The native objects a Deployment's last apply left on the cluster. */
function seedApplied(
  cluster: FakeKubernetesCluster,
  manifests: ReturnType<typeof renderDeploymentObjects>,
): void {
  for (const object of [
    manifests.serviceAccount,
    ...manifests.secrets,
    manifests.kubernetesDeployment,
  ]) {
    cluster.seed({
      ...object,
      kind: object.kind!,
      metadata: { ...object.metadata, uid: `uid-${object.metadata!.name}` },
    });
  }
}

function seedNamespace(cluster: FakeKubernetesCluster): void {
  cluster.seed({
    kind: 'Namespace',
    metadata: {
      name: namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'anycloud',
        'anycloud.sh/cluster': clusterId,
        'anycloud.sh/node-pool': nodePoolId,
      },
    },
  });
  // A node pool namespace carries its egress policy (K5).
  cluster.seed({
    ...buildNodePoolEgressPolicy({ clusterId, nodePoolId }),
    kind: 'NetworkPolicy',
  });
}

const clusterId = 'cluster-a';
const nodePoolId = 'node-pool-aws-east';
const deploymentId = 'deployment-a';
const namespace = nodePoolNamespace(nodePoolId);
const scope = { kind: 'api' } as const;

function handlerPod(uid: string, containerId: string): V1Pod {
  return {
    metadata: {
      name: uid,
      uid,
      namespace,
      labels: Object.fromEntries([
        kubernetesWorkloadPodSelector(deploymentId).split('='),
      ]) as Record<string, string>,
      annotations: { 'anycloud.sh/generation': '1' },
    },
    status: {
      phase: 'Running',
      containerStatuses: [
        {
          name: 'workload',
          ready: true,
          containerID: `containerd://${containerId}`,
          image: 'img',
          imageID: 'img@sha256:x',
          restartCount: 0,
        },
      ],
    },
  };
}

async function seedNodePoolDeployment(): Promise<void> {
  const persistence = getPersistence();
  await getDB().query(
    `INSERT INTO credentials (id, encrypted_data, cloud_provider) VALUES ('cred-a', 'x', ?)`,
    [CloudType.AWS],
  );
  await persistence.clusters.recordSelf({
    id: clusterId,
    ownerUserId: 'owner',
    name: 'production',
    kubernetesIdentity: 'uid-cluster',
    connection: '{"stored":true}',
  });
  await persistence.nodePools.create({
    id: nodePoolId,
    clusterId,
    ownerUserId: 'owner',
    name: 'aws-east',
    computeCredentialId: 'cred-a',
    region: 'us-east-1',
    zone: null,
    vmTypes: ['t3.large'],
    minVmCount: 1,
    maxVmCount: 1,
  });
  await persistence.nodePools.markReady(nodePoolId);
  expect(
    await getDeploymentStore().create(
      {
        id: deploymentId,
        ownerUserId: 'owner',
        name: 'handler',
        nodePoolId,
        config: makeContainerSpec({ image: 'ghcr.io/example/handler:latest' }),
        gpuCount: 0,
        maxConcurrentJobsPerReplica: 2,
      },
      scope,
    ),
  ).toBe(true);
}

/** The GPU check Pod's log, or its creation's refusal. */
type GpuCheckFake = ({ log: string } | { refused: Error }) & {
  /** Runs while the check's Pod is created. */
  during?: () => Promise<unknown>;
};

function nodePoolRuntime(
  pods: V1Pod[],
  liveUids: () => Set<string>,
  output = 'job output',
  gpuCheck: GpuCheckFake = { refused: new Error('no GPU check expected') },
) {
  const createTokenReview = vi.fn(
    async ({
      body,
    }: {
      body: { spec: { token: string } };
    }): Promise<V1TokenReview> => {
      const podUid = body.spec.token.replace(/^pod:/, '');
      const spec = { token: body.spec.token };
      if (!liveUids().has(podUid)) {
        return { spec, status: { authenticated: false } };
      }
      return {
        spec,
        status: {
          authenticated: true,
          audiences: [ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE],
          user: {
            username: `system:serviceaccount:${namespace}:${kubernetesWorkloadResourceName('deployment', deploymentId)}`,
            extra: {
              'authentication.kubernetes.io/pod-uid': [podUid],
              'authentication.kubernetes.io/pod-name': [podUid],
            },
          },
        },
      };
    },
  );
  const listNamespacedPod = vi.fn();
  // kubelet's pull of each replica's workload container.
  const listNamespacedEvent = vi.fn(async () => ({
    items: [
      {
        reason: 'Pulled',
        message:
          'Successfully pulled image "img" in 1m2.345s (1m3s including waiting). Image size: 9 bytes.',
        involvedObject: {
          fieldPath: `spec.containers{${KUBERNETES_DEPLOYMENT_CONTAINER}}`,
        },
        metadata: {},
      },
    ],
  }));
  const patchNode = vi.fn(async () => ({}));
  const createNamespacedPod = vi.fn(async ({ body }: { body: V1Pod }) => {
    await gpuCheck.during?.();
    if ('refused' in gpuCheck) throw gpuCheck.refused;
    return body;
  });
  const readNamespacedPodLog = vi.fn(async () =>
    'log' in gpuCheck ? gpuCheck.log : '',
  );
  const deleteNamespacedPod = vi.fn(async () => ({}));
  const readNamespacedPod = vi.fn(async ({ name }: { name: string }) => {
    const succeeded: V1Pod = { status: { phase: 'Succeeded' } };
    if (name.startsWith('anycloud-gpu-check-')) return succeeded;
    const pod = pods.find(
      (candidate) =>
        candidate.metadata!.name === name &&
        liveUids().has(candidate.metadata!.uid!),
    );
    if (!pod) throw Object.assign(new Error('not found'), { code: 404 });
    return pod;
  });
  // The replica's log: a line before any claim, then one stamped now.
  const log = vi.fn(async (...args: unknown[]) => {
    (args[3] as Writable).end(
      Buffer.from(
        `2000-01-01T00:00:00.000000000Z earlier\n${new Date().toISOString()} ${output}\n`,
      ),
    );
    return new AbortController();
  });
  const cluster = makeClusterKubernetesClientFixture({
    authentication: { createTokenReview },
    core: {
      listNamespacedEvent,
      listNamespacedPod,
      readNamespacedPod,
      patchNode,
      createNamespacedPod,
      readNamespacedPodLog,
      deleteNamespacedPod,
    },
    log: { log },
  });
  const runtime: NodePoolKubernetesRuntime = {
    config: { namespace },
    cluster,
    nodePool: { clusterId, nodePoolId, nvidiaGpusPerNode: 0 },
  };
  return {
    runtime,
    createTokenReview,
    listNamespacedEvent,
    listNamespacedPod,
    readNamespacedPod,
    patchNode,
    createNamespacedPod,
    cluster,
  };
}

describe('targeted Jobs on a node pool', () => {
  beforeEach(async () => {
    resetPersistence();
    await seedNodePoolDeployment();
  });

  it('runs the next_job() protocol through the node pool namespace: pickup order, claim fence, completion, cancellation and cleanup', async () => {
    const live = new Set(['pod-a']);
    const pods = [handlerPod('pod-a', 'container-a')];
    const fake = nodePoolRuntime(pods, () => live);
    const workloads = getDeploymentExecutionStore();
    const domain = createDeploymentWorkloadDomain({
      reconcile: () => undefined,
      jobChanges: getPersistence().jobChanges,
      claimSpendBlock,
      mintStorage: async () => ({}),
      deployments: getDeploymentStore(),
      jobs: workloads,
      runtimes: { resolve: vi.fn().mockResolvedValue(fake.runtime) },
    });
    for (const id of ['job-1', 'job-2', 'job-3']) {
      expect(
        await getWorkloadAdmissionWriter().createTargetedWorkload({
          id,
          userId: 'owner',
          ownerUserId: 'owner',
          deploymentId,
        }),
      ).toBe(true);
    }
    const authorization = 'Bearer pod:pod-a';

    // Pickup follows submission order and authenticates against the
    // node pool namespace's ServiceAccount, reading only its bound Pod.
    const first = await domain.candidate(deploymentId, 0, authorization);
    expect(first).toMatchObject({ status: 200, body: { jobId: 'job-1' } });
    expect(fake.createTokenReview).toHaveBeenCalled();
    expect(fake.readNamespacedPod).toHaveBeenCalledWith(
      { name: 'pod-a', namespace },
      undefined,
    );
    expect(fake.listNamespacedPod).not.toHaveBeenCalled();
    if (first.status !== 200) throw new Error('expected a candidate');
    const claimed = await domain.claim(
      deploymentId,
      'job-1',
      'exec-1',
      {
        submissionRevision: first.body.submissionRevision,
        previousExecutionId: first.body.previousExecutionId,
      },
      authorization,
    );
    expect(claimed).toEqual({ jobId: 'job-1', executionId: 'exec-1' });
    // The claim's event keeps the replica's pull, read from its Pod's events.
    expect(fake.listNamespacedEvent).toHaveBeenCalledWith(
      { namespace, fieldSelector: 'involvedObject.uid=pod-a,reason=Pulled' },
      expect.anything(),
    );
    const [claimEvent] = await getDB().query<{ metadata: string }>(
      `SELECT metadata FROM workload_events WHERE workload_id = 'job-1'
       AND state = ?`,
      [WorkloadState.Running],
    );
    expect(JSON.parse(claimEvent!.metadata).imagePull).toMatchObject({
      method: 'kubelet',
      elapsedMs: 62_345,
    });
    await expect(
      workloads.getTargetedExecution('job-1'),
    ).resolves.toMatchObject({
      state: WorkloadState.Running,
      executionId: 'exec-1',
      podUid: 'pod-a',
      containerId: 'containerd://container-a',
    });
    // A stale candidate cannot claim the same Job twice.
    await expect(
      domain.claim(
        deploymentId,
        'job-1',
        'exec-dup',
        { submissionRevision: 0, previousExecutionId: null },
        authorization,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    // Concurrency 2: the second slot picks job-2; the third stays queued.
    const second = await domain.candidate(deploymentId, 0, authorization);
    expect(second).toMatchObject({ status: 200, body: { jobId: 'job-2' } });
    if (second.status !== 200) throw new Error('expected a candidate');
    await domain.claim(
      deploymentId,
      'job-2',
      'exec-2',
      {
        submissionRevision: second.body.submissionRevision,
        previousExecutionId: second.body.previousExecutionId,
      },
      authorization,
    );
    await expect(
      domain.candidate(deploymentId, 0, authorization),
    ).resolves.toEqual({ status: 204 });
    // Only the replica's first Job waited for its pull, so later claims,
    // including the refused one, read no events.
    expect(fake.listNamespacedEvent).toHaveBeenCalledTimes(1);

    // Completion, then cleanup releases the slot for job-3.
    await domain.outcome(
      deploymentId,
      'job-1',
      { executionId: 'exec-1', outcome: 'completed' },
      authorization,
    );
    await expect(
      workloads.getTargetedExecution('job-1'),
    ).resolves.toMatchObject({ state: WorkloadState.Completed });
    // A published outcome releases the slot; cleanup only acknowledges the
    // in-Pod teardown and fences the execution.
    const third = await domain.candidate(deploymentId, 0, authorization);
    expect(third).toMatchObject({ status: 200, body: { jobId: 'job-3' } });
    await domain.cleanup(deploymentId, 'job-1', 'exec-1', authorization);
    // Cleanup acknowledgements replay idempotently.
    await expect(
      domain.cleanup(deploymentId, 'job-1', 'exec-1', authorization),
    ).resolves.toBeUndefined();

    // Cancellation requested by the owner is observed by the handler.
    await getWorkloadOutcomes().requestTermination('job-2', scope);
    await expect(
      domain.cancellation(deploymentId, 'job-2', 'exec-2', authorization),
    ).resolves.toEqual({ cancelled: true });
    await domain.cleanup(deploymentId, 'job-2', 'exec-2', authorization);

    // A token from a Pod that is not a current handler is refused.
    await expect(
      domain.candidate(deploymentId, 0, 'Bearer pod:pod-impostor'),
    ).rejects.toMatchObject({ statusCode: 401 });
    // On a shared cluster a VALID token from a sibling node pool's namespace
    // authenticates but belongs to another subject: forbidden, not unknown.
    fake.createTokenReview.mockResolvedValueOnce({
      spec: { token: 'sibling' },
      status: {
        authenticated: true,
        audiences: [ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE],
        user: {
          username: `system:serviceaccount:${nodePoolNamespace('node-pool-sibling')}:${kubernetesWorkloadResourceName('deployment', deploymentId)}`,
          extra: {
            'authentication.kubernetes.io/pod-uid': ['pod-sibling'],
            'authentication.kubernetes.io/pod-name': ['pod-sibling'],
          },
        },
      },
    });
    await expect(
      domain.candidate(deploymentId, 0, 'Bearer sibling'),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining('belongs to another Deployment'),
    });

    await expect(workloads.countTargetedJobs(deploymentId)).resolves.toEqual({
      queued: 1,
      running: 0,
      retrying: 0,
      terminal: 2,
      unreleased: 0,
    });
    await expect(
      getDB().query<{ id: string; state: string }>(
        `SELECT id, state FROM workloads WHERE deployment_id = ? ORDER BY id`,
        [deploymentId],
      ),
    ).resolves.toEqual([
      { id: 'job-1', state: WorkloadState.Completed },
      { id: 'job-2', state: WorkloadState.Terminated },
      { id: 'job-3', state: WorkloadState.Queued },
    ]);
    // Targeted Jobs own no VM attempt: the ledger holds only node pool VMs.
    await expect(
      getDB().query<{ count: number }>(
        `SELECT COUNT(*) AS count FROM vms WHERE workload_id IN ('job-1', 'job-2', 'job-3')`,
      ),
    ).resolves.toEqual([{ count: 0 }]);
  });

  it('retries a running Job whose handler Pod disappeared and leaves the node pool, cluster and sibling handlers intact after a restart', async () => {
    const live = new Set(['pod-a']);
    const pods = [handlerPod('pod-a', 'container-a')];
    const fake = nodePoolRuntime(pods, () => live);
    const workloads = getDeploymentExecutionStore();
    const domain = createDeploymentWorkloadDomain({
      reconcile: () => undefined,
      jobChanges: getPersistence().jobChanges,
      claimSpendBlock,
      mintStorage: async () => ({}),
      deployments: getDeploymentStore(),
      jobs: workloads,
      runtimes: { resolve: vi.fn().mockResolvedValue(fake.runtime) },
    });
    await getWorkloadAdmissionWriter().createTargetedWorkload({
      id: 'job-1',
      userId: 'owner',
      ownerUserId: 'owner',
      deploymentId,
    });
    const authorization = 'Bearer pod:pod-a';
    const candidate = await domain.candidate(deploymentId, 0, authorization);
    if (candidate.status !== 200) throw new Error('expected a candidate');
    await domain.claim(
      deploymentId,
      'job-1',
      'exec-1',
      {
        submissionRevision: candidate.body.submissionRevision,
        previousExecutionId: candidate.body.previousExecutionId,
      },
      authorization,
    );

    // The handler Pod vanishes; a freshly started controller reconstructs
    // in-flight work from the ledger alone and retries it.
    live.delete('pod-a');
    const deployment = (await getDeploymentStore().getById(deploymentId))!;
    const manifests = renderDeploymentObjects(
      deployment,
      namespace,
      'https://api.example.test',
      { clusterId, nodePoolId, nvidiaGpusPerNode: 0 },
    );
    const cluster = new FakeKubernetesCluster();
    seedNamespace(cluster);
    seedApplied(cluster, manifests);
    const client = cluster.client();
    const controller = createDeploymentController({
      deployments: getDeploymentStore(),
      jobs: workloads,
      replicas: makeReplicaPolicyDependencies(),
      secrets: { getSecretValues: async () => null },
      runtimes: {
        resolve: vi.fn().mockResolvedValue({
          config: { namespace },
          cluster: client,
          nodePool: { clusterId, nodePoolId, nvidiaGpusPerNode: 0 },
        }),
      },
      clusters: { resolve: async () => ({ cluster: client }) },
      workloadApiUrl: 'https://api.example.test',
    });
    cluster.calls.length = 0;
    await controller.start();
    await vi.waitFor(() =>
      expect(workloads.getTargetedExecution('job-1')).resolves.toMatchObject({
        state: WorkloadState.Retrying,
      }),
    );
    await controller.stop();
    await expect(
      workloads.countTargetedJobs(deploymentId),
    ).resolves.toMatchObject({ retrying: 1, running: 0 });
    // The monitor's retry step requeues it (no VM to prepare for a targeted
    // Job); a live handler is then offered the same Job with its previous
    // execution as the replay fence.
    const latestEvent = await getDB().query<{ id: number }>(
      `SELECT id FROM workload_events WHERE workload_id = 'job-1' ORDER BY id DESC LIMIT 1`,
    );
    await expect(
      getWorkloadLifecycle().queueRetryCandidate('job-1', latestEvent[0].id),
    ).resolves.toBe('queued');
    live.add('pod-b');
    pods.push(handlerPod('pod-b', 'container-b'));
    const again = await domain.candidate(deploymentId, 0, 'Bearer pod:pod-b');
    expect(again).toMatchObject({
      status: 200,
      body: { jobId: 'job-1', previousExecutionId: 'exec-1' },
    });

    // The cache matched every applied object, so the restart wrote nothing;
    // its only per-object read confirmed the claimed Pod was gone.
    expect(
      cluster.calls.filter((call) => call.op !== 'list' && call.op !== 'watch'),
    ).toEqual([]);
    expect(
      cluster.calls.filter((call) => call.namespace === namespace),
    ).toEqual([expect.objectContaining({ op: 'list', kind: 'Pod' })]);
    await expect(
      getPersistence().nodePools.getForScope(nodePoolId, scope),
    ).resolves.toMatchObject({ state: 'ready' });
    await expect(
      getPersistence().clusterRecords.getForScope(clusterId, scope),
    ).resolves.toMatchObject({ state: 'ready' });
  });

  it('drains and removes a node pool Deployment without touching the node pool, its namespace or a sibling', async () => {
    const workloads = getDeploymentExecutionStore();
    await getDeploymentStore().create(
      {
        id: 'deployment-sibling',
        ownerUserId: 'owner',
        name: 'sibling',
        nodePoolId,
        config: makeContainerSpec({ image: 'ghcr.io/example/sibling:latest' }),
        gpuCount: 0,
        maxConcurrentJobsPerReplica: 1,
      },
      scope,
    );
    await getWorkloadAdmissionWriter().createTargetedWorkload({
      id: 'job-queued',
      userId: 'owner',
      ownerUserId: 'owner',
      deploymentId,
    });
    expect(
      await getDeploymentStore().requestDeletion(deploymentId, scope),
    ).toBe('requested');
    const cluster = new FakeKubernetesCluster();
    seedNamespace(cluster);
    for (const id of [deploymentId, 'deployment-sibling']) {
      seedApplied(
        cluster,
        renderDeploymentObjects(
          (await getDeploymentStore().getById(id))!,
          namespace,
          'https://api.example.test',
          { clusterId, nodePoolId, nvidiaGpusPerNode: 0 },
        ),
      );
    }
    const client = cluster.client();
    const controller = createDeploymentController({
      deployments: getDeploymentStore(),
      jobs: workloads,
      replicas: makeReplicaPolicyDependencies(),
      secrets: { getSecretValues: async () => null },
      runtimes: {
        resolve: vi.fn().mockResolvedValue({
          config: { namespace },
          cluster: client,
          nodePool: { clusterId, nodePoolId, nvidiaGpusPerNode: 0 },
        }),
      },
      clusters: { resolve: async () => ({ cluster: client }) },
      workloadApiUrl: 'https://api.example.test',
    });
    await controller.start();
    await vi.waitFor(() =>
      expect(getDeploymentStore().getById(deploymentId)).resolves.toMatchObject(
        { deletedAt: expect.any(Number) },
      ),
    );
    await controller.stop();
    const deleted = cluster.calls
      .filter((call) => call.op === 'delete')
      .map((call) => `${call.kind} ${call.name}`);

    // Unassigned work is terminated, the handler's own objects are deleted by
    // exact UID, and the record ends; the sibling and the namespace remain.
    await expect(
      getDB().query<{ state: string }>(
        `SELECT state FROM workloads WHERE id = 'job-queued'`,
      ),
    ).resolves.toEqual([{ state: WorkloadState.Terminated }]);
    const name = kubernetesWorkloadResourceName('deployment', deploymentId);
    expect(deleted).toEqual([`Deployment ${name}`, `ServiceAccount ${name}`]);
    expect(cluster.get('Namespace', '', namespace)).toBeDefined();
    await expect(
      getDeploymentStore().getById(deploymentId),
    ).resolves.toMatchObject({ deletedAt: expect.any(Number) });
    await expect(
      getDeploymentStore().getById('deployment-sibling'),
    ).resolves.toMatchObject({ deletedAt: null });
    await expect(
      getDeploymentStore().countLiveForNodePool(nodePoolId),
    ).resolves.toBe(1);
    await expect(
      getPersistence().nodePools.getForScope(nodePoolId, scope),
    ).resolves.toMatchObject({ state: 'ready' });
  });
});

// Each replica holds 1/8 of an $80/h Node, so each slot costs $5/h.
async function bind(...podUids: string[]): Promise<void> {
  const vm = await getPersistence().nodePoolVms.beginVmAttempt(nodePoolId, {
    cloudId: 'node-a',
    region: 'us-east-1',
    availabilityZone: null,
    vmType: 't3.large',
    pricePerHour: 80,
    desiredVmCount: 1,
  });
  await getDeploymentStore().recordOccupancy(
    deploymentId,
    podUids.map((podUid) => ({
      podUid,
      vmId: vm!.vmRowId,
      share: 0.125,
      gpus: 0,
    })),
    podUids,
  );
}

describe('the claim on a managed Deployment (SLOT)', () => {
  beforeEach(async () => {
    resetPersistence();
    await seedNodePoolDeployment();
  });

  it('0044/S4 and 0044/S5: skips a session at its throttle, keeps it queued with the reason, and skips account throttles', async () => {
    const fake = nodePoolRuntime(
      [handlerPod('pod-a', 'container-a')],
      () => new Set(['pod-a']),
    );
    const domain = createDeploymentWorkloadDomain({
      reconcile: () => undefined,
      jobChanges: getPersistence().jobChanges,
      claimSpendBlock,
      mintStorage: async () => ({}),
      deployments: getDeploymentStore(),
      jobs: getDeploymentExecutionStore(),
      runtimes: { resolve: vi.fn().mockResolvedValue(fake.runtime) },
    });
    const vm = await getPersistence().nodePoolVms.beginVmAttempt(nodePoolId, {
      cloudId: 'node-a',
      region: 'us-east-1',
      availabilityZone: null,
      vmType: 't3.large',
      pricePerHour: 80,
      desiredVmCount: 1,
    });
    // The replica holds 1/8 of an $80/h Node, $10/h, so each of its two
    // slots costs $5/h.
    await getDeploymentStore().recordOccupancy(
      deploymentId,
      [{ podUid: 'pod-a', vmId: vm!.vmRowId, share: 0.125, gpus: 0 }],
      ['pod-a'],
    );
    await getDB().query('UPDATE deployments SET managed = 1 WHERE id = ?', [
      deploymentId,
    ]);
    for (const [id, session] of [
      ['held', 's1'],
      ['capped', 's1'],
      ['next', 's2'],
    ]) {
      await getWorkloadAdmissionWriter().createTargetedWorkload({
        id,
        userId: 'owner',
        ownerUserId: 'owner',
        deploymentId,
        session,
      });
    }
    const authorization = 'Bearer pod:pod-a';
    // A managed Deployment's runner sends the API's exact release.
    await domain.claim(
      deploymentId,
      'held',
      'exec-held',
      { submissionRevision: 0, previousExecutionId: null },
      authorization,
      undefined,
      config.currVersion,
    );
    // s1 burns $5/h from its held slot, and another would make $10/h.
    await getSpendControlsStore().setThrottle('agent-session', 8);
    await getSpendControlsStore().setThrottle('account', 1);

    await expect(
      domain.candidate(
        deploymentId,
        0,
        authorization,
        undefined,
        config.currVersion,
      ),
    ).resolves.toMatchObject({ status: 200, body: { jobId: 'next' } });
    const capped =
      await getDeploymentExecutionStore().getTargetedExecution('capped');
    expect(capped).toBeNull();
    const [event] = await getDB().query<{ state: string; metadata: string }>(
      `SELECT state, metadata FROM workload_events WHERE workload_id = 'capped'
       ORDER BY id DESC LIMIT 1`,
    );
    expect(event.state).toBe(WorkloadState.Queued);
    expect(JSON.parse(event.metadata).message).toBe(
      "blocked by throttle (agent-session 's1'): projected rate $10.00/hr ≥ cap $8/hr",
    );
  });

  async function managedDomain(...podUids: string[]) {
    const fake = nodePoolRuntime(
      podUids.map((uid) => handlerPod(uid, `container-${uid}`)),
      () => new Set(podUids),
    );
    await getDB().query('UPDATE deployments SET managed = 1 WHERE id = ?', [
      deploymentId,
    ]);
    const domain = createDeploymentWorkloadDomain({
      reconcile: () => undefined,
      jobChanges: getPersistence().jobChanges,
      claimSpendBlock,
      mintStorage: async () => ({}),
      deployments: getDeploymentStore(),
      jobs: getDeploymentExecutionStore(),
      runtimes: { resolve: vi.fn().mockResolvedValue(fake.runtime) },
    });
    const claim = (pod: string, jobId: string) =>
      domain.claim(
        deploymentId,
        jobId,
        `exec-${jobId}`,
        { submissionRevision: 0, previousExecutionId: null },
        `Bearer pod:${pod}`,
        undefined,
        config.currVersion,
      );
    return { domain, claim };
  }

  async function submit(session: string | undefined, ...ids: string[]) {
    for (const id of ids) {
      await getWorkloadAdmissionWriter().createTargetedWorkload({
        id,
        userId: 'owner',
        ownerUserId: 'owner',
        deploymentId,
        session,
      });
    }
  }

  it('keeps concurrent claims on two replicas within a session throttle', async () => {
    const { claim } = await managedDomain('pod-a', 'pod-b');
    await bind('pod-a', 'pod-b');
    await submit('s1', 'first', 'second');
    // Each claim alone is $5/h, under the $8/h cap; both make $10/h.
    await getSpendControlsStore().setThrottle('agent-session', 8);
    const claims = await Promise.allSettled([
      claim('pod-a', 'first'),
      claim('pod-b', 'second'),
    ]);
    expect(claims.map((claim) => claim.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(claims.find((claim) => claim.status === 'rejected')).toMatchObject({
      reason: { statusCode: 409 },
    });
  });

  it('refuses a replica whose occupancy is not recorded yet, and wakes it once recorded', async () => {
    const discover = vi.spyOn(
      getDeploymentExecutionStore(),
      'discoverTargetedJob',
    );
    const { domain, claim } = await managedDomain('pod-a');
    await submit('s1', 'job');
    await expect(claim('pod-a', 'job')).rejects.toMatchObject({
      statusCode: 409,
    });
    const waiting = domain.candidate(
      deploymentId,
      20_000,
      'Bearer pod:pod-a',
      undefined,
      config.currVersion,
    );
    // Recorded only after discovery found the replica unbound.
    await vi.waitFor(async () =>
      expect(await discover.mock.results[0]?.value).toEqual({ kind: 'full' }),
    );
    await bind('pod-a');
    await expect(waiting).resolves.toMatchObject({
      status: 200,
      body: { jobId: 'job' },
    });
  });

  it('claims a Job with no session past an agent-session throttle, as discovery offers it', async () => {
    const { claim } = await managedDomain('pod-a');
    await bind('pod-a');
    await submit(undefined, 'sessionless');
    // The $5/h slot alone meets the cap, which binds only sessions.
    await getSpendControlsStore().setThrottle('agent-session', 4);
    await expect(claim('pod-a', 'sessionless')).resolves.toMatchObject({
      jobId: 'sessionless',
    });
  });
});

describe('pool Jobs through the runner on a managed Deployment', () => {
  const release = config.currVersion;
  const authorization = 'Bearer pod:pod-a';

  beforeEach(async () => {
    resetPersistence();
    await seedNodePoolDeployment();
    await getDB().query(
      `UPDATE deployments SET managed = 1, max_concurrent_jobs_per_replica = 1 WHERE id = ?`,
      [deploymentId],
    );
  });

  async function runner(
    jobIds: string[],
    mintStorage: (
      jobId: string,
    ) => Promise<WorkloadExecution['storage']> = async () => ({}),
    output?: string,
    gpuCheck?: GpuCheckFake,
    replicas = ['pod-a'],
  ) {
    const live = new Set(replicas);
    const pods = replicas.map((uid) => handlerPod(uid, `container-${uid}`));
    const fake = nodePoolRuntime(pods, () => live, output, gpuCheck);
    await bind(...replicas);
    // A restarted API builds a new domain over the same stores.
    const restart = () =>
      createDeploymentWorkloadDomain({
        reconcile: () => undefined,
        jobChanges: getPersistence().jobChanges,
        claimSpendBlock,
        mintStorage,
        deployments: getDeploymentStore(),
        jobs: getDeploymentExecutionStore(),
        runtimes: { resolve: vi.fn().mockResolvedValue(fake.runtime) },
      });
    const domain = restart();
    for (const id of jobIds) {
      await getWorkloadAdmissionWriter().createTargetedWorkload({
        id,
        userId: 'owner',
        ownerUserId: 'owner',
        deploymentId,
      });
    }
    const claim = async (executionId: string, replica = 'pod-a') => {
      const authorization = `Bearer pod:${replica}`;
      const candidate = await domain.candidate(
        deploymentId,
        0,
        authorization,
        undefined,
        release,
      );
      if (candidate.status !== 200) return null;
      const { jobId, ...body } = candidate.body;
      await domain.claim(
        deploymentId,
        jobId,
        executionId,
        body,
        authorization,
        undefined,
        release,
      );
      return jobId;
    };
    const state = async (jobId: string) =>
      (await getDeploymentExecutionStore().getTargetedExecution(jobId))?.state;
    return { domain, restart, claim, state, live, pods, fake };
  }

  it('stages, runs and finalizes one Job per replica, and records the exit code through the batch policy', async () => {
    // Every read mints afresh; RFC 0043 invariant 4 refuses one after the end.
    let minted = 0;
    const mintStorage = vi.fn(async (jobId: string) => ({
      output: {
        remote: `azureblob:results/${jobId}/`,
        env: {},
        expiresAt: ++minted,
      },
    }));
    const { domain, claim, state, fake } = await runner(
      ['job-1', 'job-2'],
      mintStorage,
    );
    const spec = await encodeContainerSpec(
      makeContainerSpec({
        command: ['python', 'train.py'],
        env: { SEED: '1' },
      }),
    );
    // RT8's pool Job admission writes this spec; until then the trigger
    // refuses one on a targeted Job.
    await getDB().query('DROP TRIGGER container_specs_workload_owner');
    await getDB().query(
      `INSERT INTO container_specs (workload_id, image, image_digest, command, docker_options, env, registry_username, registry_token)
       VALUES ('job-1', ?, ?, ?, ?, ?, ?, ?)`,
      [
        spec.image,
        spec.image_digest,
        spec.command,
        spec.docker_options,
        spec.env,
        spec.registry_username,
        spec.registry_token,
      ],
    );

    expect(await claim('11111111-1111-4111-8111-111111111111')).toBe('job-1');
    const exec = '11111111-1111-4111-8111-111111111111';
    expect(await state('job-1')).toBe(WorkloadState.Syncing);
    await expect(
      domain.execution(deploymentId, 'job-1', exec, authorization, release),
    ).resolves.toEqual({
      command: ['python', 'train.py'],
      env: { SEED: '1' },
      timeLimitSeconds: null,
      storage: {
        output: { remote: 'azureblob:results/job-1/', env: {}, expiresAt: 1 },
      },
    });
    // The replica holds its one slot through every live state.
    for (const phase of ['running', 'finalizing'] as const) {
      await domain.report(
        deploymentId,
        'job-1',
        { executionId: exec, phase },
        authorization,
        release,
      );
      expect(await state('job-1')).toBe(phase);
      await expect(
        getDeploymentExecutionStore().discoverTargetedJob({
          deploymentId,
          generation: 1,
          podUid: 'pod-a',
          containerId: 'container-pod-a',
        }),
      ).resolves.toEqual({ kind: 'full' });
    }
    // The renewal: the same read, while the Job uploads.
    await expect(
      domain.execution(deploymentId, 'job-1', exec, authorization, release),
    ).resolves.toMatchObject({ storage: { output: { expiresAt: 2 } } });
    const end = {
      executionId: exec,
      cause: { kind: 'exit' as const, code: 3, oom: false },
    };
    await domain.report(deploymentId, 'job-1', end, authorization, release);
    // A replay of the recorded end is accepted.
    await domain.report(deploymentId, 'job-1', end, authorization, release);
    // The report keeps the Job's span of the replica's log as its tail.
    await expect(
      getDB().query(
        `SELECT w.state, a.cause, a.exit_code AS exitCode, a.reason,
                a.log_tail_state AS tailState, a.log_tail AS tail
         FROM workloads w JOIN workload_attempts a ON a.workload_id = w.id
         WHERE w.id = 'job-1'`,
      ),
    ).resolves.toEqual([
      {
        state: WorkloadState.Errored,
        cause: 'exit',
        exitCode: 3,
        reason: 'Exited with code 3',
        tailState: 'captured',
        tail: 'job output\n',
      },
    ]);
    await expect(
      domain.execution(deploymentId, 'job-1', exec, authorization, release),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(mintStorage).toHaveBeenCalledTimes(2);
    // The runner polls only after its report, so the poll ends nothing.
    expect(await claim('22222222-2222-4222-8222-222222222222')).toBe('job-2');
    expect(fake.cluster.core.deleteNamespacedPod).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a staging failure',
      { kind: 'unrecoverable' as const, detail: 'no input bucket' },
      [],
      WorkloadState.Invalid,
    ],
    [
      'a final upload that gave up',
      { kind: 'transfer' as const, detail: 'container not found' },
      ['running', 'finalizing'] as const,
      WorkloadState.Failed,
    ],
    [
      'credentials that expired before renewal',
      {
        kind: 'disrupted' as const,
        detail: 'storage credentials expired before they could be renewed',
      },
      ['running', 'finalizing'] as const,
      WorkloadState.Retrying,
    ],
  ])('maps %s', async (_name, cause, phases, expected) => {
    const { domain, claim, state } = await runner(['job-1']);
    const exec = '11111111-1111-4111-8111-111111111111';
    await claim(exec);
    for (const phase of phases) {
      await domain.report(
        deploymentId,
        'job-1',
        { executionId: exec, phase },
        authorization,
        release,
      );
    }
    await domain.report(
      deploymentId,
      'job-1',
      { executionId: exec, cause },
      authorization,
      release,
    );
    expect(await state('job-1')).toBe(expected);
  });

  describe('a GPU Job whose log shows an unusable GPU', () => {
    const gpuSpec = (gpus: number): V1Pod['spec'] => ({
      nodeName: 'node-a',
      containers: [
        {
          name: 'workload',
          resources: { limits: { 'nvidia.com/gpu': String(gpus) } },
        },
      ],
    });
    const passed = 'GPU 0: NVIDIA A10 (UUID: GPU-1)\nCUresult 0\nexit=0';
    const cordoned = [
      [
        {
          name: 'node-a',
          body: {
            metadata: { labels: { [UNUSABLE_GPU_NODE_LABEL]: 'true' } },
            spec: { unschedulable: true },
          },
        },
        expect.anything(),
      ],
    ];

    async function failOnce(
      gpus: number,
      output: string,
      gpuCheck?: GpuCheckFake,
    ) {
      const { domain, claim, state, pods, fake } = await runner(
        ['job-1'],
        undefined,
        output,
        gpuCheck,
      );
      pods[0]!.spec = gpuSpec(gpus);
      const exec = '11111111-1111-4111-8111-111111111111';
      await claim(exec);
      const closeReplica = vi.spyOn(
        getDeploymentExecutionStore(),
        'closeReplica',
      );
      await domain.report(
        deploymentId,
        'job-1',
        { executionId: exec, cause: { kind: 'exit', code: 1, oom: false } },
        authorization,
        release,
      );
      const [attempt] = await getDB().query<{ reason: string }>(
        `SELECT reason FROM workload_attempts WHERE workload_id = 'job-1'`,
      );
      return {
        state: await state('job-1'),
        reason: attempt!.reason,
        fake,
        closeReplica,
      };
    }

    it('retries on another Node and replaces that Node when its GPUs fail the check', async () => {
      const { state, reason, fake, closeReplica } = await failOnce(
        1,
        'CUDA_ERROR_NO_DEVICE',
        { log: 'No devices were found\nexit=9' },
      );
      expect(state).toBe(WorkloadState.Retrying);
      expect(reason).toBe(UNUSABLE_GPU_POOL_RETRY);
      // The check ran on the replica's Node, apart from its image.
      expect(fake.createNamespacedPod.mock.calls[0]![0]).toMatchObject({
        namespace,
        body: {
          spec: {
            nodeName: 'node-a',
            containers: [{ image: NODE_GPU_CHECK_IMAGE }],
          },
        },
      });
      expect(fake.patchNode.mock.calls).toEqual(cordoned);
      // The replica on that Node takes no more Jobs.
      expect(closeReplica.mock.calls).toEqual([['pod-a']]);
    });

    it("retries and replaces the Node without the check for a numeric fault, which the check can't clear", async () => {
      const { state, reason, fake } = await failOnce(
        1,
        'Autotuning failed for HLO: ... No valid config found!',
      );
      expect(state).toBe(WorkloadState.Retrying);
      expect(reason).toBe(UNUSABLE_GPU_POOL_RETRY);
      expect(fake.createNamespacedPod).not.toHaveBeenCalled();
      expect(fake.patchNode.mock.calls).toEqual(cordoned);
    });

    const forbidden: GpuCheckFake = {
      refused: Object.assign(new Error('forbidden'), { code: 403 }),
    };

    /**
     * A Job that fails with a missing-GPU log on pod-a, then reruns on
     * pod-b, the new Pod the Deployment starts, through a restarted API.
     */
    async function rerun(gpuCheck: GpuCheckFake, rerunCode: number) {
      const { domain, restart, claim, state, pods, fake } = await runner(
        ['job-1'],
        undefined,
        'CUDA_ERROR_NO_DEVICE',
        gpuCheck,
        ['pod-a', 'pod-b'],
      );
      for (const pod of pods) pod.spec = gpuSpec(1);
      const report = async (
        api: typeof domain,
        replica: string,
        code: number,
      ) => {
        const exec = randomUUID();
        expect(await claim(exec, replica)).toBe('job-1');
        await api.report(
          deploymentId,
          'job-1',
          { executionId: exec, cause: { kind: 'exit', code, oom: false } },
          `Bearer pod:${replica}`,
          release,
        );
        return state('job-1');
      };
      expect(await report(domain, 'pod-a', 1)).toBe(WorkloadState.Retrying);
      // pod-a is closed and deleted, so its Deployment starts a new Pod.
      expect(
        vi
          .mocked(fake.cluster.core.deleteNamespacedPod)
          .mock.calls.map(([request]) => request),
      ).toContainEqual({
        namespace,
        name: 'pod-a',
        body: { preconditions: { uid: 'pod-a' } },
      });
      const [event] = await getDB().query<{ id: number }>(
        `SELECT MAX(id) AS id FROM workload_events WHERE workload_id = 'job-1'`,
      );
      await getWorkloadLifecycle().queueRetryCandidate('job-1', event!.id);
      const final = await report(restart(), 'pod-b', rerunCode);
      const attempts = await getDB().query<{ reason: string | null }>(
        `SELECT reason FROM workload_attempts WHERE workload_id = 'job-1'
         ORDER BY attempt`,
      );
      const [ended] = await getDB().query<{ metadata: string }>(
        `SELECT metadata FROM workload_events WHERE workload_id = 'job-1'
         ORDER BY id DESC LIMIT 1`,
      );
      return { final, attempts, message: JSON.parse(ended!.metadata), fake };
    }

    it.each([
      ['its GPUs pass the check', { log: passed }],
      ["the check can't run", forbidden],
    ])(
      'reruns the Job once in a new Pod, leaving the Node, when %s',
      async (_name, gpuCheck) => {
        const { final, attempts, fake } = await rerun(gpuCheck, 0);
        expect(final).toBe(WorkloadState.Completed);
        expect(attempts[0]!.reason).toBe(UNUSABLE_GPU_POOL_RERUN);
        expect(fake.patchNode).not.toHaveBeenCalled();
      },
    );

    it.each([
      [
        'its GPUs pass the check twice',
        { log: passed },
        'the Job failed the same way in a new Pod, and the GPUs on Node node-a passed a CUDA check, so the image or its CUDA setup is the likely cause',
      ],
      [
        "the check can't run twice",
        forbidden,
        "the Job failed the same way in a new Pod, and the GPUs on Node node-a couldn't be checked: forbidden",
      ],
    ])(
      'reruns only once, across an API restart, and ends the Job Errored when %s',
      async (_name, gpuCheck, verdict) => {
        const { final, message, fake } = await rerun(gpuCheck, 1);
        expect(final).toBe(WorkloadState.Errored);
        expect(message.message).toBe(
          `Exited with code 1; ${verdict}${
            'log' in gpuCheck ? `; ${UNUSABLE_GPU_HINT}` : ''
          }`,
        );
        expect(fake.patchNode).not.toHaveBeenCalled();
      },
    );

    it('leaves the replica open for the next Job when its Job ends elsewhere during the check', async () => {
      const exec = randomUUID();
      const { domain, claim, pods } = await runner(
        ['job-1', 'job-2'],
        undefined,
        'CUDA_ERROR_NO_DEVICE',
        {
          log: passed,
          // As recovery settles an execution through the same fenced writer.
          during: () =>
            getDeploymentExecutionStore().reportTargetedJobExecution(
              'job-1',
              exec,
              { state: WorkloadState.Errored, reason: 'settled elsewhere' },
            ),
        },
      );
      pods[0]!.spec = gpuSpec(1);
      await claim(exec);
      await expect(
        domain.report(
          deploymentId,
          'job-1',
          { executionId: exec, cause: { kind: 'exit', code: 1, oom: false } },
          authorization,
          release,
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await claim(randomUUID())).toBe('job-2');
    });

    it.each([
      ['a GPU Job that failed otherwise', 1, 'ValueError: bad input'],
      ['a CPU Job probing CUDA', 0, 'CUDA_ERROR_NO_DEVICE'],
    ])('runs no check for %s', async (_name, gpus, output) => {
      const { state, fake } = await failOnce(gpus, output);
      expect(state).toBe(WorkloadState.Errored);
      expect(fake.createNamespacedPod).not.toHaveBeenCalled();
      expect(fake.patchNode).not.toHaveBeenCalled();
    });

    it('replaces no Node for an image that fails on every GPU replica', async () => {
      const replicas = ['pod-a', 'pod-b', 'pod-c'];
      const { domain, claim, state, pods, fake } = await runner(
        replicas,
        undefined,
        'CUDA_ERROR_NO_DEVICE',
        { log: passed },
        replicas,
      );
      for (const pod of pods) pod.spec = gpuSpec(1);
      const executions = replicas.map(() => randomUUID());
      for (const [i, replica] of replicas.entries()) {
        expect(await claim(executions[i]!, replica)).toBe(replica);
      }
      for (const [i, replica] of replicas.entries()) {
        await domain.report(
          deploymentId,
          replica,
          {
            executionId: executions[i]!,
            cause: { kind: 'exit', code: 1, oom: false },
          },
          `Bearer pod:${replica}`,
          release,
        );
        // Each reruns in a new Pod; none touches its Node.
        expect(await state(replica)).toBe(WorkloadState.Retrying);
      }
      expect(fake.createNamespacedPod).toHaveBeenCalledTimes(replicas.length);
      expect(fake.patchNode).not.toHaveBeenCalled();
    });
  });

  it('0043 invariant 4: mints no credential once the attempt has ended, though a managed checkpoint bucket keeps the Job uncleaned', async () => {
    const mintStorage = vi.fn(async () => ({}));
    const { domain, claim } = await runner(['job-1'], mintStorage);
    // D-managed: its ending leaves cleaned_at NULL until cleanup deletes the bucket.
    await getDB().query(
      `UPDATE workloads SET checkpoint_storage_credential_id = 'cred-a' WHERE id = 'job-1'`,
    );
    const exec = '11111111-1111-4111-8111-111111111111';
    await claim(exec);
    await domain.execution(deploymentId, 'job-1', exec, authorization, release);
    await domain.report(
      deploymentId,
      'job-1',
      { executionId: exec, cause: { kind: 'exit', code: 0, oom: false } },
      authorization,
      release,
    );
    expect(
      await getDeploymentExecutionStore().getTargetedExecution('job-1'),
    ).toMatchObject({ cleanedAt: null, endedAt: expect.any(Number) });
    await expect(
      domain.execution(deploymentId, 'job-1', exec, authorization, release),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(mintStorage).toHaveBeenCalledTimes(1);
  });

  it('0043/S22 ends a Job invalid when its managed bucket name was taken after admission, and fences its runner', async () => {
    const taken = new BucketNameTakenError('job-1', null);
    taken.message = 'Pass --checkpoint-bucket or choose a different --id.';
    const { domain, claim, state } = await runner(['job-1'], async () => {
      throw taken;
    });
    const exec = '11111111-1111-4111-8111-111111111111';
    await claim(exec);
    await expect(
      domain.execution(deploymentId, 'job-1', exec, authorization, release),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await state('job-1')).toBe(WorkloadState.Invalid);
    expect(
      await getDB().query(
        `SELECT reason FROM workload_attempts WHERE workload_id = 'job-1'`,
      ),
    ).toEqual([{ reason: expect.stringContaining('--checkpoint-bucket') }]);
  });

  it('lets a runner finish uploading a Job terminated while it runs, then release the slot', async () => {
    const { domain, claim, state } = await runner(['job-1', 'job-2']);
    const exec = '11111111-1111-4111-8111-111111111111';
    await claim(exec);
    await getWorkloadOutcomes().requestTermination('job-1', scope);
    // The runner hasn't seen the termination yet.
    await domain.report(
      deploymentId,
      'job-1',
      { executionId: exec, phase: 'running' },
      authorization,
      release,
    );
    await expect(
      domain.cancellation(
        deploymentId,
        'job-1',
        exec,
        authorization,
        0,
        undefined,
        release,
      ),
    ).resolves.toEqual({ cancelled: true });
    expect(await claim('22222222-2222-4222-8222-222222222222')).toBeNull();
    await domain.cleanup(deploymentId, 'job-1', exec, authorization, release);
    expect(await state('job-1')).toBe(WorkloadState.Terminated);
    // A terminated Job's runner cleans up instead of reporting; its tail is
    // still kept, so `logs` serves it.
    await expect(
      getDB().query(
        `SELECT log_tail_state AS tailState, log_tail AS tail
         FROM workload_attempts WHERE workload_id = 'job-1'`,
      ),
    ).resolves.toEqual([{ tailState: 'captured', tail: 'job output\n' }]);
    expect(await claim('22222222-2222-4222-8222-222222222222')).toBe('job-2');
  });

  it("accepts the previous release's runner (RFC 0049 C27), refuses an older one, and the runner's routes on a user Deployment", async () => {
    const { domain } = await runner(['job-1']);
    await expect(
      domain.candidate(
        deploymentId,
        0,
        authorization,
        undefined,
        config.previousVersion,
      ),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      domain.candidate(deploymentId, 0, authorization, undefined, '0.0.1'),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'CLIENT_VERSION_MISMATCH',
    });
    await getDB().query(`UPDATE deployments SET managed = 0 WHERE id = ?`, [
      deploymentId,
    ]);
    const candidate = await domain.candidate(deploymentId, 0, authorization);
    if (candidate.status !== 200) throw new Error('expected a candidate');
    const exec = '11111111-1111-4111-8111-111111111111';
    await domain.claim(
      deploymentId,
      'job-1',
      exec,
      { submissionRevision: 0, previousExecutionId: null },
      authorization,
    );
    await expect(
      getDeploymentExecutionStore().getTargetedExecution('job-1'),
    ).resolves.toMatchObject({ state: WorkloadState.Running });
    await expect(
      domain.execution(deploymentId, 'job-1', exec, authorization, undefined),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses an SDK handler's outcome on a managed Deployment", async () => {
    const { domain, claim } = await runner(['job-1']);
    const exec = '11111111-1111-4111-8111-111111111111';
    expect(await claim(exec)).toBe('job-1');
    await expect(
      domain.outcome(
        deploymentId,
        'job-1',
        { executionId: exec, outcome: 'completed' },
        authorization,
        release,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  /** A controller over this Deployment's applied objects and these Pods. */
  async function poolController(pods: V1Pod[] = []) {
    const deployment = (await getDeploymentStore().getById(deploymentId))!;
    const cluster = new FakeKubernetesCluster();
    seedNamespace(cluster);
    seedApplied(
      cluster,
      renderDeploymentObjects(
        deployment,
        namespace,
        'https://api.example.test',
        {
          clusterId,
          nodePoolId,
          nvidiaGpusPerNode: 0,
        },
      ),
    );
    const client = cluster.client();
    const controller = createDeploymentController({
      deployments: getDeploymentStore(),
      jobs: getDeploymentExecutionStore(),
      replicas: makeReplicaPolicyDependencies(),
      secrets: { getSecretValues: async () => null },
      runtimes: {
        resolve: vi.fn().mockResolvedValue({
          config: { namespace },
          cluster: client,
          nodePool: { clusterId, nodePoolId, nvidiaGpusPerNode: 0 },
        }),
      },
      clusters: { resolve: async () => ({ cluster: client }) },
      workloadApiUrl: 'https://api.example.test',
    });
    cluster.pods = pods;
    return { controller, cluster };
  }

  it('fails a Job whose replica vanished with nothing observable, where a user Deployment retries', async () => {
    const { claim, live } = await runner(['job-1']);
    await claim('11111111-1111-4111-8111-111111111111');
    live.delete('pod-a');
    const { controller } = await poolController();
    await controller.start();
    await vi.waitFor(() =>
      expect(
        getDeploymentExecutionStore().getTargetedExecution('job-1'),
      ).resolves.toMatchObject({ state: WorkloadState.Failed }),
    );
    await controller.stop();
  });

  /** A later millisecond than any claim so far: a poll opened after it. */
  const later = () => new Promise((resolve) => setTimeout(resolve, 2));

  /** The Job's one attempt failed as lost, and pod-a was replaced. */
  async function endedLost({ fake }: Awaited<ReturnType<typeof runner>>) {
    await expect(
      getDB().query(
        `SELECT w.state, a.reason FROM workloads w
         JOIN workload_attempts a ON a.workload_id = w.id
         WHERE w.id = 'job-1'`,
      ),
    ).resolves.toEqual([
      {
        state: WorkloadState.Failed,
        reason: 'Job outcome lost: its runner no longer runs it',
      },
    ]);
    expect(
      vi
        .mocked(fake.cluster.core.deleteNamespacedPod)
        .mock.calls.map(([request]) => request),
    ).toEqual([
      {
        namespace,
        name: 'pod-a',
        body: { preconditions: { uid: 'pod-a' } },
      },
    ]);
  }

  describe('after restoring the backup an upgrade took (RFC 0049 C27 Rollback)', () => {
    // The backup holds job-1 running on pod-a; what the new API recorded
    // since, including job-2's claim on it, is gone.
    const restored = '11111111-1111-4111-8111-111111111111';
    const onNewApi = '22222222-2222-4222-8222-222222222222';

    it('fails a Job whose replica is gone as lost, with no rerun', async () => {
      const { claim, live } = await runner(['job-1']);
      await claim(restored);
      live.delete('pod-a');
      const { controller } = await poolController();
      await controller.start();
      await vi.waitFor(() =>
        expect(
          getDeploymentExecutionStore().getTargetedExecution('job-1'),
        ).resolves.toMatchObject({ state: WorkloadState.Failed }),
      );
      await controller.stop();
      await expect(
        getDB().query(
          `SELECT metadata FROM workload_events
           WHERE workload_id = 'job-1' AND state = 'failed'`,
        ),
      ).resolves.toEqual([
        { metadata: expect.stringContaining('Job outcome lost') },
      ]);
      // Not from its checkpoint, as the RFC inferred: nothing requeues it.
      await expect(
        getDB().query(
          `SELECT COUNT(*) AS attempts FROM workload_attempts
           WHERE workload_id = 'job-1'`,
        ),
      ).resolves.toEqual([{ attempts: 1 }]);
    });

    it('fails a Job whose replica lives but whose runner was fenced as lost, and replaces the replica', async () => {
      const setup = await runner(['job-1', 'job-2']);
      const { domain, claim } = setup;
      await claim(restored);
      // The runner moved on to job-2 on the new API: the restored API fences
      // that execution, and the runner polls for its next Job.
      await expect(
        domain.execution(
          deploymentId,
          'job-2',
          onNewApi,
          authorization,
          release,
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
      await later();
      expect(await claim(onNewApi)).toBeNull();
      await endedLost(setup);
      // A later `job terminate` keeps the outcome.
      await expect(
        getWorkloadOutcomes().requestTermination('job-1', scope),
      ).resolves.toMatchObject({ previousState: WorkloadState.Failed });
      await expect(
        getDeploymentExecutionStore().getTargetedExecution('job-1'),
      ).resolves.toMatchObject({ state: WorkloadState.Failed });
    });
  });

  it("retries a Job whose runner's container restarted mid-Job and polls again, through the controller", async () => {
    const { claim, pods, fake } = await runner(['job-1']);
    await claim('11111111-1111-4111-8111-111111111111');
    // The kubelet restarted the runner's container after it exited 1.
    const [status] = pods[0]!.status!.containerStatuses!;
    Object.assign(status!, {
      containerID: 'containerd://container-pod-a-2',
      restartCount: 1,
      state: { running: { startedAt: new Date() } },
      lastState: {
        terminated: {
          containerID: 'containerd://container-pod-a',
          exitCode: 1,
        },
      },
    });
    await later();
    // The new container's poll leaves the old one's Job to the controller.
    expect(await claim('22222222-2222-4222-8222-222222222222')).toBeNull();
    expect(fake.cluster.core.deleteNamespacedPod).not.toHaveBeenCalled();
    const { controller } = await poolController(pods);
    await controller.start();
    await vi.waitFor(() =>
      expect(
        getDB().query(
          `SELECT reason FROM workload_attempts WHERE workload_id = 'job-1'`,
        ),
      ).resolves.toEqual([{ reason: 'runner exited with code 1' }]),
    );
    await controller.stop();
    expect(fake.cluster.core.deleteNamespacedPod).not.toHaveBeenCalled();
  });

  it('leaves a claim made after a poll began to its runner, though that poll finds the replica full', async () => {
    const { domain, claim, state, fake } = await runner(['job-1']);
    // A poll that began a second ago, delayed until after the claim.
    const startedAt = performance.now() - 1000;
    await claim('11111111-1111-4111-8111-111111111111');
    await expect(
      domain.candidate(
        deploymentId,
        0,
        authorization,
        {
          signal: new AbortController().signal,
          startedAt,
          deadlineAt: startedAt + 60_000,
        },
        release,
      ),
    ).resolves.toEqual({ status: 204 });
    expect(await state('job-1')).toBe(WorkloadState.Syncing);
    expect(fake.cluster.core.deleteNamespacedPod).not.toHaveBeenCalled();
  });

  it("keeps the runner's report and the replica when it lands before the poll ends the Job as lost", async () => {
    const { domain, claim, state, fake } = await runner(['job-1']);
    const exec = '11111111-1111-4111-8111-111111111111';
    await claim(exec);
    await later();
    const store = getDeploymentExecutionStore();
    const report = store.reportTargetedJobExecution.bind(store);
    vi.spyOn(store, 'reportTargetedJobExecution').mockImplementationOnce(
      async (...args) => {
        await domain.report(
          deploymentId,
          'job-1',
          { executionId: exec, cause: { kind: 'exit', code: 0, oom: false } },
          authorization,
          release,
        );
        return report(...args);
      },
    );
    expect(await claim('22222222-2222-4222-8222-222222222222')).toBeNull();
    expect(await state('job-1')).toBe(WorkloadState.Completed);
    expect(fake.cluster.core.deleteNamespacedPod).not.toHaveBeenCalled();
  });
});
