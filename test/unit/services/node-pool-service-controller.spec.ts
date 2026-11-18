import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { V1Deployment, V1Pod } from '@kubernetes/client-node';
import type { NodePoolIngressStatus } from '../../../src/api/services/node-pool-controller.js';
import { kubernetesWorkloadResourceName } from '../../../src/api/services/kubernetes/identity.js';
import type {
  ClusterRuntime,
  ClusterRuntimeResolver,
} from '../../../src/api/services/kubernetes/cluster-runtime.js';
import type {
  NodePoolRepository,
  StoredNodePool,
} from '../../../src/api/services/cluster-store.js';
import {
  getPersistence,
  resetPersistence,
  getWorkloadLifecycle,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
  getWorkloadOutcomes,
} from '../../../src/api/services/persistence.js';
import {
  createNodePoolServiceController,
  NODE_POOL_SERVICE_STARTUP_TIMEOUT_MS,
} from '../../../src/api/services/node-pool-service-controller.js';
import { createNodePoolServiceReconciler } from '../../../src/api/services/node-pool-service-reconciler.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { createNodePoolServeRuntime } from '../../../src/api/services/serve/runtime.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { NodePoolState } from '../../../src/shared/node-pools.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import { FakeKubernetesCluster } from '../helpers/fake-kubernetes-cluster.js';
import {
  requireTestWorkload,
  seedTestWorkload,
} from '../../helpers/workload-store.js';

const ROOT = {
  id: 'cluster-a',
  ownerUserId: 'owner-1',
  name: 'production',
  kubernetesIdentity: 'uid-cluster-a',
  connection: '{"apiVersion":"v1","kind":"Config","current-context":"cluster"}',
};

const NODE_POOL = {
  id: 'node-pool-aws',
  clusterId: ROOT.id,
  ownerUserId: 'owner-1',
  name: 'aws-east',
  computeCredentialId: 'compute-aws',
  region: 'us-east-1',
  zone: null,
  vmTypes: ['t3.small'],
  minVmCount: 1,
  maxVmCount: 1,
};

const SERVICE_ID = 'svc-a';
const NAMESPACE = kubernetesWorkloadResourceName('serve', SERVICE_ID);

function readyPod(): V1Pod {
  return {
    metadata: {
      name: 'svc-a-pod',
      uid: 'pod-uid-1',
      creationTimestamp: new Date(1),
    },
    status: {
      phase: 'Running',
      conditions: [
        { type: 'PodScheduled', status: 'True' },
        { type: 'Ready', status: 'True' },
      ],
      containerStatuses: [
        {
          name: 'workload',
          ready: true,
          restartCount: 0,
          image: 'i',
          imageID: 'i',
          state: { running: { startedAt: new Date(1) } },
        },
      ],
    },
  };
}

function pendingPod(): V1Pod {
  return {
    metadata: {
      name: 'svc-a-pod',
      uid: 'pod-uid-1',
      creationTimestamp: new Date(1),
    },
    status: {
      phase: 'Pending',
      conditions: [
        {
          type: 'PodScheduled',
          status: 'False',
          reason: 'Unschedulable',
          message: '0/1 nodes are available: 1 Insufficient cpu',
        },
      ],
    },
  };
}

async function seedNodePool(): Promise<void> {
  await getDB().query(
    `INSERT INTO credentials (id, encrypted_data, cloud_provider, name, created_at, last_used_at)
     VALUES ('compute-aws', 'opaque', 'AWS', 'aws-compute', 1, 1)`,
  );
  await getPersistence().clusters.recordSelf(ROOT);
  await getPersistence().nodePools.create(NODE_POOL);
  await getPersistence().nodePools.markReady(NODE_POOL.id);
}

async function seedService(
  state: WorkloadState = WorkloadState.Queued,
  overrides: Record<string, unknown> = {},
) {
  return seedTestWorkload({
    id: SERVICE_ID,
    userId: 'alice',
    ownerUserId: 'owner-1',
    workloadType: 'service',
    image: 'ghcr.io/acme/api:v1',
    dockerCommand: '',
    nodePoolId: NODE_POOL.id,
    env: { MODE: 'prod' },
    state,
    ...overrides,
  });
}

function harness(
  options: {
    now?: () => number;
    waitForPublication?: (hostname: string) => Promise<void>;
    connectError?: () => Error | null;
    /** Overrides what the controller reads for the node pool row. */
    nodePoolOverride?: Partial<StoredNodePool>;
    /** Share a cluster with an earlier harness. */
    cluster?: FakeKubernetesCluster;
    /** What `node-pool status` would say about the pool's ingress (default: no entry). */
    poolIngress?: () => Promise<NodePoolIngressStatus>;
    /** The DNS Worker: `publish` returns a record id or throws a Worker error. */
    publish?: (
      workloadId: string,
      ip: string,
      token: string | null,
      recordId: string | null,
    ) => Promise<string>;
  } = {},
) {
  const cluster = options.cluster ?? new FakeKubernetesCluster();
  const dns = {
    publish: vi.fn(options.publish ?? (async () => 'record-1')),
    waitForPublication: vi.fn(
      options.waitForPublication ?? (async (_hostname: string) => undefined),
    ),
    remove: vi.fn(async () => undefined),
  };
  const resolved: string[] = [];
  const clusterRuntime: ClusterRuntimeResolver = {
    async resolve(clusterId) {
      resolved.push(clusterId);
      const failure = options.connectError?.();
      if (failure) throw failure;
      // The controller reads only the connected cluster off the runtime.
      const runtime: Partial<ClusterRuntime> = {
        clusterId,
        cluster: cluster.client(),
      };
      return runtime as ClusterRuntime;
    },
  };
  const persistence = getPersistence();
  const nodePools: Pick<NodePoolRepository, 'getForScope'> = {
    async getForScope(id, scope) {
      const found = await persistence.nodePools.getForScope(id, scope);
      return found && options.nodePoolOverride
        ? { ...found, ...options.nodePoolOverride }
        : found;
    },
  };
  const controller = createNodePoolServiceController({
    workloads: persistence.workloadQueries,
    secrets: persistence.credentialSecrets,
    transitions: persistence.workloadLifecycle,
    outcomes: persistence.workloadOutcomes,
    events: persistence.workloadEvents,
    endpoints: persistence.provisioningAttempts,
    nodePools,
    clusterRuntime,
    poolIngress:
      options.poolIngress ?? (async () => ({ entryIp: null, release: null })),
    publicEndpoint: dns,
    now: options.now,
  });
  return { cluster, controller, resolved, dns };
}

async function eventsOf(id: string) {
  return (await eventLog().getWorkloadEvents(id)).map((event) => ({
    state: event.state,
    metadata: event.metadata ? JSON.parse(event.metadata) : null,
  }));
}

describe('node pool Service controller', () => {
  beforeEach(async () => {
    resetPersistence();
    await seedNodePool();
  });

  it('claims provisioning, applies the native objects, waits for readiness, then runs', async () => {
    await seedService();
    const { cluster, controller, resolved } = harness();

    await controller.reconcile(SERVICE_ID);
    let workload = await requireTestWorkload(SERVICE_ID);
    expect(workload.state).toBe(WorkloadState.Provisioning);
    expect(resolved).toEqual([ROOT.id]);
    expect(cluster.get('Namespace', '', NAMESPACE)).toBeDefined();
    expect(cluster.get('Deployment', NAMESPACE, NAMESPACE)).toBeDefined();
    expect(cluster.get('Service', NAMESPACE, NAMESPACE)).toBeDefined();
    const events = await eventsOf(SERVICE_ID);
    expect(events[0]).toMatchObject({
      state: WorkloadState.Provisioning,
      metadata: {
        nodePoolId: NODE_POOL.id,
        clusterId: ROOT.id,
        namespace: NAMESPACE,
      },
    });
    expect(events.at(-1)).toMatchObject({
      state: WorkloadState.Provisioning,
      metadata: {
        message: expect.stringContaining('Waiting for node pool capacity'),
      },
    });

    cluster.pods = [pendingPod()];
    await controller.reconcile(SERVICE_ID);
    await controller.reconcile(SERVICE_ID);
    const blocked = await eventsOf(SERVICE_ID);
    expect(blocked.at(-1)?.metadata.message).toContain('Insufficient cpu');
    expect(
      blocked.filter((event) =>
        event.metadata?.message?.includes('Insufficient cpu'),
      ),
    ).toHaveLength(1);

    cluster.pods = [readyPod()];
    cluster.get('Deployment', NAMESPACE, NAMESPACE)!.status = {
      availableReplicas: 1,
    };
    await controller.reconcile(SERVICE_ID);
    workload = await requireTestWorkload(SERVICE_ID);
    expect(workload.state).toBe(WorkloadState.Running);
    expect((await eventsOf(SERVICE_ID)).at(-1)).toMatchObject({
      state: WorkloadState.Running,
      metadata: {
        namespace: NAMESPACE,
        podUid: 'pod-uid-1',
        containerPort: 8088,
      },
    });

    // Running is steady state: another pass only observes.
    cluster.calls.length = 0;
    await controller.reconcile(SERVICE_ID);
    expect((await requireTestWorkload(SERVICE_ID)).state).toBe(
      WorkloadState.Running,
    );
    expect(cluster.calls.map((call) => `${call.op} ${call.kind}`)).toEqual([
      'read Deployment',
      'list Pod',
    ]);

    // A native Deployment removed behind Anycloud's back is re-applied.
    cluster.objects.delete(cluster.key('Deployment', NAMESPACE, NAMESPACE));
    cluster.calls.length = 0;
    await controller.reconcile(SERVICE_ID);
    expect(cluster.get('Deployment', NAMESPACE, NAMESPACE)).toBeDefined();
    expect(cluster.calls.some((call) => call.op === 'create')).toBe(true);
  });

  it('resumes an interrupted provisioning pass after restart without duplicate objects', async () => {
    await seedService(WorkloadState.Provisioning);
    const { cluster, controller } = harness();
    await controller.reconcile(SERVICE_ID);
    const uids = [...cluster.objects.values()].map((o) => o.metadata?.uid);
    expect(uids).toHaveLength(5);
    await controller.reconcile(SERVICE_ID);
    expect([...cluster.objects.values()].map((o) => o.metadata?.uid)).toEqual(
      uids,
    );
    expect((await requireTestWorkload(SERVICE_ID)).state).toBe(
      WorkloadState.Provisioning,
    );
  });

  it('keeps a queued Service waiting while its node pool is not ready and touches nothing native', async () => {
    await seedService();
    // A ready node pool can fail after admission (join loss); the Service waits.
    expect(
      await getPersistence().nodePools.markFailed(
        NODE_POOL.id,
        'join preconditions',
      ),
    ).toBe(true);
    const { cluster, controller, resolved } = harness();
    await controller.reconcile(SERVICE_ID);
    await controller.reconcile(SERVICE_ID);
    expect((await requireTestWorkload(SERVICE_ID)).state).toBe(
      WorkloadState.Queued,
    );
    expect(resolved).toEqual([]);
    expect(cluster.calls).toEqual([]);
    const events = await eventsOf(SERVICE_ID);
    expect(events.at(-1)).toMatchObject({
      state: WorkloadState.Queued,
      metadata: { message: 'Node pool aws-east is failed: join preconditions' },
    });
    expect(
      events.filter((event) =>
        event.metadata?.message?.startsWith('Node pool'),
      ),
    ).toHaveLength(1);
  });

  it('refuses a deleting node pool: a queued Service becomes invalid, a provisioning one fails', async () => {
    // Admission, the deletion trigger and the resubmission guard keep this
    // state unreachable through the store; the controller still fails closed
    // if it ever observes it.
    await seedService();
    const deleting = { state: NodePoolState.Deleting };
    const { controller, cluster } = harness({ nodePoolOverride: deleting });
    await controller.reconcile(SERVICE_ID);
    expect((await requireTestWorkload(SERVICE_ID)).state).toBe(
      WorkloadState.Invalid,
    );
    expect(cluster.calls).toEqual([]);

    resetPersistence();
    await seedNodePool();
    await seedService(WorkloadState.Provisioning);
    const second = harness({ nodePoolOverride: deleting });
    await second.controller.reconcile(SERVICE_ID);
    const failed = await requireTestWorkload(SERVICE_ID);
    expect(failed.state).toBe(WorkloadState.Failed);
    expect((await eventsOf(SERVICE_ID)).at(-1)).toMatchObject({
      state: WorkloadState.Failed,
      metadata: { reason: 'Node pool aws-east is terminated' },
    });
  });

  it('fails a Service whose Pod never becomes ready within the startup allowance', async () => {
    await seedService();
    const clock = { now: Date.now() };
    const { cluster, controller } = harness({ now: () => clock.now });
    await controller.reconcile(SERVICE_ID);
    cluster.pods = [pendingPod()];
    // The claim event is stamped with the real clock a few milliseconds after
    // `clock.now` was sampled, so leave a margin beyond the allowance.
    clock.now += NODE_POOL_SERVICE_STARTUP_TIMEOUT_MS + 60_000;
    await controller.reconcile(SERVICE_ID);
    const workload = await requireTestWorkload(SERVICE_ID);
    expect(workload.state).toBe(WorkloadState.Failed);
    expect(workload.completedAt).not.toBeNull();
    expect(workload.cleanedAt).toBeNull();
    expect((await eventsOf(SERVICE_ID)).at(-1)?.metadata).toMatchObject({
      reason: expect.stringContaining('did not become ready within 10 minutes'),
      phase: 'scheduling',
    });
  });

  it('records a persistent cluster error as the block reason and fails when the allowance expires', async () => {
    await seedService();
    const clock = { now: Date.now() };
    const { controller, resolved, cluster } = harness({
      now: () => clock.now,
      connectError: () =>
        new Error(
          'cluster cluster-a: the registered identity lacks permissions node pools and Services need: patch namespaces',
        ),
    });
    await controller.reconcile(SERVICE_ID);
    await controller.reconcile(SERVICE_ID);
    expect(resolved).toEqual([ROOT.id, ROOT.id]);
    expect(cluster.calls).toEqual([]);
    let workload = await requireTestWorkload(SERVICE_ID);
    expect(workload.state).toBe(WorkloadState.Provisioning);
    const events = await eventsOf(SERVICE_ID);
    const clusterErrors = events.filter((event) =>
      event.metadata?.message?.startsWith('cluster error'),
    );
    expect(clusterErrors).toHaveLength(1);
    expect(clusterErrors[0].metadata.message).toContain('patch namespaces');

    // The claim event is stamped with the real clock a few milliseconds after
    // `clock.now` was sampled, so leave a margin beyond the allowance.
    clock.now += NODE_POOL_SERVICE_STARTUP_TIMEOUT_MS + 60_000;
    await controller.reconcile(SERVICE_ID);
    workload = await requireTestWorkload(SERVICE_ID);
    expect(workload.state).toBe(WorkloadState.Failed);
    expect((await eventsOf(SERVICE_ID)).at(-1)?.metadata).toMatchObject({
      cause: 'cluster-error',
      reason: expect.stringContaining('patch namespaces'),
    });
  });

  it('fails at once when a same-name namespace belongs to someone else, creating nothing inside it', async () => {
    await seedService();
    const { controller, cluster } = harness();
    cluster.seed({
      kind: 'Namespace',
      metadata: {
        name: NAMESPACE,
        annotations: { 'anycloud.sh/deployment-id': 'someone-else' },
      },
    });
    await controller.reconcile(SERVICE_ID);
    const workload = await requireTestWorkload(SERVICE_ID);
    expect(workload.state).toBe(WorkloadState.Failed);
    expect((await eventsOf(SERVICE_ID)).at(-1)?.metadata).toMatchObject({
      cause: 'native-ownership',
      reason: 'Kubernetes Namespace is owned by another workload',
    });
    expect(cluster.get('Deployment', NAMESPACE, NAMESPACE)).toBeUndefined();
    expect(cluster.objects.size).toBe(1);
  });

  it('fails a Service whose hostname another pool-labelled route already serves, before creating anything', async () => {
    await seedService();
    const { controller, cluster } = harness();
    // Another installer (or the hosted API) targeting the same cluster
    // published a Service under this id: ids are unique per database only.
    cluster.seed({
      kind: 'IngressRoute',
      metadata: {
        name: 'other',
        namespace: 'serve-other',
        labels: { 'anycloud.sh/ingress-pool': 'some-pool' },
      },
      spec: {
        routes: [
          { kind: 'Rule', match: `Host(\`${SERVICE_ID}.anycloud.sh\`)` },
        ],
      },
    });
    await controller.reconcile(SERVICE_ID);
    const workload = await requireTestWorkload(SERVICE_ID);
    expect(workload.state).toBe(WorkloadState.Failed);
    expect((await eventsOf(SERVICE_ID)).at(-1)?.metadata).toMatchObject({
      cause: 'hostname-taken',
      reason: `hostname ${SERVICE_ID}.anycloud.sh is already served by IngressRoute serve-other/other`,
    });
    expect(cluster.objects.size).toBe(1);
  });

  it('keeps a Running Service running through a transient cluster error', async () => {
    await seedService();
    let failing = false;
    const { controller, cluster } = harness({
      connectError: () => (failing ? new Error('cluster unreachable') : null),
    });
    await controller.reconcile(SERVICE_ID);
    cluster.pods = [readyPod()];
    cluster.get('Deployment', NAMESPACE, NAMESPACE)!.status = {
      availableReplicas: 1,
    };
    await controller.reconcile(SERVICE_ID);
    expect((await requireTestWorkload(SERVICE_ID)).state).toBe(
      WorkloadState.Running,
    );
    failing = true;
    await expect(controller.reconcile(SERVICE_ID)).rejects.toThrow(
      'cluster unreachable',
    );
    expect((await requireTestWorkload(SERVICE_ID)).state).toBe(
      WorkloadState.Running,
    );
  });

  it('retains the DNS identity and defers published status until both authorities are ready', async () => {
    await seedService(WorkloadState.Running, { githubToken: 'gh-owner' });
    let ready = false;
    const { controller, dns } = harness({
      poolIngress: async () => ({
        entryIp: '203.0.113.10',
        release: {
          state: 'installed',
          helmJob: { phase: 'succeeded', message: null },
          daemonSet: { desired: 1, ready: 1, entryNodeReady: true },
          lastEvent: null,
          routes: 1,
        },
      }),
      waitForPublication: async () => {
        expect((await requireTestWorkload(SERVICE_ID)).dnsRecordId).toBe(
          'record-1',
        );
        if (!ready) throw new Error('authoritative publication timed out');
      },
    });
    await controller.reconcile(SERVICE_ID);
    const deferred = await requireTestWorkload(SERVICE_ID);
    expect(deferred.dnsRecordId).toBe('record-1');
    expect(deferred.publicEndpoint).toMatchObject({ state: 'repointing' });
    expect(dns.waitForPublication).toHaveBeenCalledWith(
      `${SERVICE_ID}.anycloud.sh`,
    );
    ready = true;
    await controller.reconcile(SERVICE_ID);
    expect(dns.publish).toHaveBeenLastCalledWith(
      SERVICE_ID,
      '203.0.113.10',
      'gh-owner',
      'record-1',
    );
    expect((await requireTestWorkload(SERVICE_ID)).publicEndpoint?.state).toBe(
      'published',
    );
  });

  it('publishes the public record once the pool ingress serves, re-points it when the entry moves, marks a refused Worker verdict stale and removes it with the Service', async () => {
    await seedService(WorkloadState.Queued, { githubToken: 'gh-owner' });
    const ingress: NodePoolIngressStatus = { entryIp: null, release: null };
    const verdicts: Array<string | Error> = ['record-1', 'record-1'];
    const { controller, cluster, dns } = harness({
      poolIngress: async () => ingress,
      publish: async () => {
        const next = verdicts.shift() ?? 'record-x';
        if (next instanceof Error) throw next;
        return next;
      },
    });
    await controller.reconcile(SERVICE_ID);
    cluster.pods = [readyPod()];
    cluster.get('Deployment', NAMESPACE, NAMESPACE)!.status = {
      availableReplicas: 1,
    };
    await controller.reconcile(SERVICE_ID);
    expect((await requireTestWorkload(SERVICE_ID)).state).toBe(
      WorkloadState.Running,
    );

    // Running with no entry yet: nothing is published, the state says why.
    await controller.reconcile(SERVICE_ID);
    expect(dns.publish).not.toHaveBeenCalled();
    expect((await requireTestWorkload(SERVICE_ID)).publicEndpoint).toEqual({
      ip: null,
      state: 'repointing',
      error: 'pool ingress entry lost',
    });

    // Entry elected but Traefik not serving: still no record at a dead port.
    Object.assign(ingress, {
      entryIp: '203.0.113.10',
      release: {
        state: 'installed',
        helmJob: { phase: 'succeeded', message: null },
        daemonSet: { desired: 1, ready: 0, entryNodeReady: true },
        lastEvent: null,
      },
    });
    await controller.reconcile(SERVICE_ID);
    expect(dns.publish).not.toHaveBeenCalled();
    expect((await requireTestWorkload(SERVICE_ID)).publicEndpoint?.error).toBe(
      'pool ingress is not serving yet',
    );

    // Serving: published with the creator's token; steady passes stay quiet.
    ingress.release!.daemonSet!.ready = 1;
    await controller.reconcile(SERVICE_ID);
    await controller.reconcile(SERVICE_ID);
    expect(dns.publish).toHaveBeenCalledTimes(1);
    expect(dns.publish).toHaveBeenCalledWith(
      SERVICE_ID,
      '203.0.113.10',
      'gh-owner',
      null,
    );
    let workload = await requireTestWorkload(SERVICE_ID);
    expect(workload.dnsRecordId).toBe('record-1');
    expect(workload.publicEndpoint).toEqual({
      ip: '203.0.113.10',
      state: 'published',
      error: null,
    });

    // The entry moved (2a re-election): re-pointed in place with the held id.
    ingress.entryIp = '203.0.113.11';
    await controller.reconcile(SERVICE_ID);
    expect(dns.publish).toHaveBeenLastCalledWith(
      SERVICE_ID,
      '203.0.113.11',
      'gh-owner',
      'record-1',
    );
    expect((await requireTestWorkload(SERVICE_ID)).publicEndpoint).toEqual({
      ip: '203.0.113.11',
      state: 'published',
      error: null,
    });

    // A refused verdict is stale (no retry will change it); a transient one
    // stays re-pointing and is retried on the next pass.
    ingress.entryIp = '203.0.113.12';
    verdicts.push(new Error('DNS record publish failed (403): not the owner'));
    await controller.reconcile(SERVICE_ID);
    workload = await requireTestWorkload(SERVICE_ID);
    expect(workload.publicEndpoint).toMatchObject({
      ip: '203.0.113.11',
      state: 'stale',
    });
    verdicts.push(new Error('fetch failed'), 'record-1');
    await controller.reconcile(SERVICE_ID);
    expect((await requireTestWorkload(SERVICE_ID)).publicEndpoint?.state).toBe(
      'repointing',
    );
    await controller.reconcile(SERVICE_ID);
    expect(
      (await requireTestWorkload(SERVICE_ID)).publicEndpoint,
    ).toMatchObject({ ip: '203.0.113.12', state: 'published' });

    // Entry lost with a live record: stale until 2a elects a replacement.
    ingress.entryIp = null;
    await controller.reconcile(SERVICE_ID);
    expect((await requireTestWorkload(SERVICE_ID)).publicEndpoint).toEqual({
      ip: '203.0.113.12',
      state: 'stale',
      error: 'pool ingress entry lost',
    });

    // Removal deletes the record after the objects and clears both fields.
    await controller.remove(await requireTestWorkload(SERVICE_ID));
    expect(dns.remove).toHaveBeenCalledWith('record-1', 'gh-owner');
    workload = await requireTestWorkload(SERVICE_ID);
    expect(workload.dnsRecordId).toBeNull();
    expect(workload.publicEndpoint).toBeNull();
    // Pods are the fake kubelet's; the namespace deletion takes them.
    expect(cluster.pods.length).toBe(cluster.objects.size);
  });

  it('completes an interrupted failure found in retrying instead of re-applying', async () => {
    await seedService(WorkloadState.Provisioning);
    expect(
      await getWorkloadLifecycle().updateState(
        SERVICE_ID,
        WorkloadState.Retrying,
        {
          metadata: { reason: 'Node pool aws-east is terminated' },
        },
      ),
    ).toBe(true);
    const { controller, cluster, resolved } = harness();
    await controller.reconcile(SERVICE_ID);
    expect((await requireTestWorkload(SERVICE_ID)).state).toBe(
      WorkloadState.Failed,
    );
    expect(resolved).toEqual([]);
    expect(cluster.calls).toEqual([]);
  });

  it('refuses to render a Pod template for a node pool whose VM type turned into GPU capacity', async () => {
    await seedService();
    const { controller, cluster } = harness({
      nodePoolOverride: { vmTypes: ['g6e.xlarge'] },
    });
    await expect(controller.reconcile(SERVICE_ID)).rejects.toThrow(
      'Pods on a GPU node pool must request whole devices',
    );
    expect(cluster.calls).toEqual([]);
    expect((await requireTestWorkload(SERVICE_ID)).state).toBe(
      WorkloadState.Queued,
    );
  });

  it('renders a GPU Service with its stored devices and removes it without re-checking them', async () => {
    await seedService(WorkloadState.Queued, { dockerOptions: { gpus: '1' } });
    const { controller, cluster } = harness({
      nodePoolOverride: { vmTypes: ['g6e.xlarge'] },
    });
    await controller.reconcile(SERVICE_ID);
    const podSpec = (
      cluster.get('Deployment', NAMESPACE, NAMESPACE) as V1Deployment
    ).spec!.template.spec!;
    expect(podSpec.containers[0].resources?.limits?.['nvidia.com/gpu']).toBe(
      '1',
    );
    expect(podSpec.runtimeClassName).toBe('nvidia');

    await controller.remove(await requireTestWorkload(SERVICE_ID));
    expect(cluster.objects.size).toBe(0);
  });

  it('marks a Service invalid when a named Secret disappeared before it ran', async () => {
    await getDB().query(
      `INSERT INTO secrets (name, encrypted_values, created_at, updated_at) VALUES ('missing', 'x', 1, 1)`,
    );
    await seedService(WorkloadState.Queued, { secretNames: ['missing'] });
    await getDB().query(`DELETE FROM secrets WHERE name = 'missing'`);
    const { controller, cluster } = harness();
    await controller.reconcile(SERVICE_ID);
    expect((await requireTestWorkload(SERVICE_ID)).state).toBe(
      WorkloadState.Invalid,
    );
    expect(cluster.calls).toEqual([]);
  });

  it('removes native objects through the Serve runtime and leaves the node pool and cluster intact', async () => {
    await seedService();
    const { cluster, controller } = harness();
    await controller.reconcile(SERVICE_ID);
    cluster.seed({
      kind: 'Namespace',
      metadata: { name: 'anycloud-node-pool-other', labels: {} },
    });
    await getWorkloadOutcomes().requestTermination(SERVICE_ID, {
      kind: 'api',
    });
    const terminated = await requireTestWorkload(SERVICE_ID);
    expect(terminated.state).toBe(WorkloadState.Terminated);

    const runtime = createNodePoolServeRuntime(controller);
    await runtime.cleanup({
      workload: terminated,
      placement: { cloudConfig: { cloudProvider: CloudType.AWS } },
    });
    expect(
      cluster.get('Namespace', '', 'anycloud-node-pool-other'),
    ).toBeDefined();
    expect(cluster.objects.size).toBe(1);
    expect(
      cluster.calls.filter((call) => call.op === 'delete').map((c) => c.kind),
    ).toEqual(['IngressRoute', 'Deployment', 'Service', 'Secret', 'Namespace']);
    await expect(
      getPersistence().nodePools.getForScope(NODE_POOL.id, { kind: 'api' }),
    ).resolves.toMatchObject({ state: 'ready' });
    await expect(
      getPersistence().clusterRecords.getForScope(ROOT.id, { kind: 'api' }),
    ).resolves.toMatchObject({ state: 'ready' });
  });

  it('still removes native objects once the node pool is deleting, but not without a node pool row', async () => {
    await seedService();
    const started = harness();
    await started.controller.reconcile(SERVICE_ID);
    const { cluster } = started;
    await getWorkloadOutcomes().requestTermination(SERVICE_ID, {
      kind: 'api',
    });
    const workload = await requireTestWorkload(SERVICE_ID);
    expect(cluster.objects.size).toBe(5);
    // Cleanup runs against the same fake cluster while the node pool reads
    // as deleting; the row's existence is what matters, not its state.
    const { controller } = harness({
      cluster,
      nodePoolOverride: { state: NodePoolState.Deleting },
    });
    await controller.remove(workload);
    expect(cluster.objects.size).toBe(0);
    await expect(
      controller.remove({ ...workload, nodePoolId: 'gone' }),
    ).rejects.toThrow('no longer exists');
  });

  it('refuses upgrades and stops only the application through the Serve runtime', async () => {
    await seedService();
    const { cluster, controller } = harness();
    await controller.reconcile(SERVICE_ID);
    const workload = await requireTestWorkload(SERVICE_ID);
    const runtime = createNodePoolServeRuntime(controller);
    expect(() => runtime.update({ workload, update: null as never })).toThrow(
      'upgrades are not available yet',
    );
    await runtime.teardown({
      workload,
      placement: { cloudConfig: { cloudProvider: CloudType.AWS } },
    });
    expect(cluster.get('Deployment', NAMESPACE, NAMESPACE)).toBeUndefined();
    expect(cluster.get('Service', NAMESPACE, NAMESPACE)).toBeDefined();
  });

  it('discovers every non-terminal node pool Service and coalesces reruns', async () => {
    await seedService();
    await seedTestWorkload({
      id: 'vm-job',
      userId: 'alice',
      state: WorkloadState.Queued,
    });
    const reconciled: string[] = [];
    const reconciler = createNodePoolServiceReconciler({
      workloads: getPersistence().nodePoolServices,
      controller: {
        reconcile: async (id) => {
          reconciled.push(id);
        },
      },
    });
    await reconciler.reconcileAll();
    expect(reconciled).toEqual([SERVICE_ID]);
    await getWorkloadOutcomes().requestTermination(SERVICE_ID, {
      kind: 'api',
    });
    await reconciler.reconcileAll();
    expect(reconciled).toEqual([SERVICE_ID]);
    await reconciler.stop();
  });
});

describe('node pool Service persistence', () => {
  beforeEach(async () => {
    resetPersistence();
    await seedNodePool();
  });

  it('is excluded from the VM-host scheduler and controller but not from cleanup discovery', async () => {
    await seedService();
    await seedTestWorkload({
      id: 'vm-job',
      userId: 'alice',
      state: WorkloadState.Queued,
    });
    const store = getPersistence().nodePoolServices;
    expect((await queries().listQueued(10)).map((row) => row.id)).toEqual([
      'vm-job',
    ]);
    await getWorkloadLifecycle().claimStep(
      SERVICE_ID,
      WorkloadState.Provisioning,
    );
    expect(await queries().countDeploying()).toBe(0);
    expect(
      (await queries().listWorkloadReconcileCandidates()).map((c) => c.id),
    ).toEqual([]);
    expect(
      await queries().getWorkloadReconcileCandidate(SERVICE_ID),
    ).toBeNull();
    expect(
      (await store.listNodePoolServiceCandidates()).map((c) => c.id),
    ).toEqual([SERVICE_ID]);

    await getWorkloadOutcomes().requestTermination(SERVICE_ID, {
      kind: 'api',
    });
    expect(
      (await queries().listWorkloadReconcileCandidates()).map((c) => c.id),
    ).toEqual([SERVICE_ID]);
    expect(await store.listNodePoolServiceCandidates()).toEqual([]);
    const hydrated = await requireTestWorkload(SERVICE_ID);
    expect(hydrated.nodePoolId).toBe(NODE_POOL.id);
    expect(hydrated.nodePoolName).toBe(NODE_POOL.name);
    // The Service runs on the node pool's VMs: its cloud is the node pool's.
    expect(hydrated.cloudProvider).toBe(CloudType.AWS);
    expect(hydrated.credentialId).toBeNull();
  });

  it('refuses admission into a node pool that is not ready and refuses non-Service targets', async () => {
    await getDB().query(
      `UPDATE node_pools SET state = 'creating' WHERE id = ?`,
      [NODE_POOL.id],
    );
    await expect(seedService()).rejects.toThrow(
      'node pool does not accept Services',
    );
    await getDB().query(`UPDATE node_pools SET state = 'ready' WHERE id = ?`, [
      NODE_POOL.id,
    ]);
    await expect(
      seedService(WorkloadState.Queued, { workloadType: 'job' }),
    ).rejects.toThrow('only a Service Workload');
    await expect(
      seedService(WorkloadState.Queued, { nodePoolId: 'nope' }),
    ).rejects.toThrow();
  });

  it('refuses resubmission while the node pool is not ready and allows it once it is', async () => {
    await seedService();
    await getWorkloadOutcomes().requestTermination(SERVICE_ID, {
      kind: 'api',
    });
    await getWorkloadOutcomes().recordCleanupAttempt(SERVICE_ID);
    expect(
      await getWorkloadOutcomes().markCleanupComplete(SERVICE_ID, {}),
    ).toBe(true);
    await expect(
      getPersistence().nodePools.requestDeletion(NODE_POOL.id, {
        kind: 'api',
      }),
    ).resolves.toBe('requested');
    expect(await getWorkloadOutcomes().resubmitWorkload(SERVICE_ID)).toBe(
      false,
    );
    expect((await requireTestWorkload(SERVICE_ID)).cleanedAt).not.toBeNull();

    await getDB().query(`UPDATE node_pools SET state = 'ready' WHERE id = ?`, [
      NODE_POOL.id,
    ]);
    expect(await getWorkloadOutcomes().resubmitWorkload(SERVICE_ID)).toBe(true);
    expect((await requireTestWorkload(SERVICE_ID)).state).toBe(
      WorkloadState.Queued,
    );
  });

  it('keeps the node pool target immutable and blocks node pool deletion until cleanup', async () => {
    await seedService();
    await expect(
      getDB().query(`UPDATE workloads SET node_pool_id = NULL WHERE id = ?`, [
        SERVICE_ID,
      ]),
    ).rejects.toThrow('immutable');
    const nodePools = getPersistence().nodePools;
    const workloads = getPersistence().nodePoolServices;
    await expect(
      workloads.hasLiveNodePoolReferences(NODE_POOL.id),
    ).resolves.toBe(true);
    // The request's own reference predicate answers before the 0116 trigger
    // (`node pool still has Services`) would fire; the trigger stays as the
    // durable backstop for any other writer.
    await expect(
      nodePools.requestDeletion(NODE_POOL.id, { kind: 'api' }),
    ).resolves.toBe('referenced');
    await expect(
      getDB().query(`UPDATE node_pools SET state = 'deleting' WHERE id = ?`, [
        NODE_POOL.id,
      ]),
    ).rejects.toThrow('node pool still has Services');

    await getWorkloadOutcomes().requestTermination(SERVICE_ID, {
      kind: 'api',
    });
    await expect(
      workloads.hasLiveNodePoolReferences(NODE_POOL.id),
    ).resolves.toBe(true);
    await getWorkloadOutcomes().recordCleanupAttempt(SERVICE_ID);
    expect(
      await getWorkloadOutcomes().markCleanupComplete(SERVICE_ID, {}),
    ).toBe(true);
    await expect(
      workloads.hasLiveNodePoolReferences(NODE_POOL.id),
    ).resolves.toBe(false);
    await expect(
      nodePools.requestDeletion(NODE_POOL.id, { kind: 'api' }),
    ).resolves.toBe('requested');
  });
});
