import { describe, expect, it, vi } from 'vitest';
import type { V1DaemonSet, V1RuntimeClass } from '@kubernetes/client-node';
import {
  createClusterAddonController,
  ClusterAddonOwnershipError,
  ClusterAddonPendingError,
  ClusterAddonPermissionError,
} from '../../../../src/api/services/kubernetes/cluster-addon-reconciler.js';
import {
  buildClusterNvidiaDevicePlugin,
  buildClusterNvidiaRuntimeClass,
  CLUSTER_ADDON_REVISION_ANNOTATION,
  clusterAddonRevision,
  NODE_STATUS_POLICY_NAME,
  NVIDIA_CLUSTER_ADDON,
  POOL_INGRESS_CLUSTER_ADDON,
} from '../../../../src/api/services/kubernetes/cluster-addons.js';
import { poolIngressReleaseName } from '../../../../src/api/services/kubernetes/node-pool-ingress.js';
import type { ClusterRuntime } from '../../../../src/api/services/kubernetes/cluster-runtime.js';
import { createFakeKubernetesObjectApi } from '../../helpers/fake-kubernetes-object-api.js';
import { makeClusterKubernetesClientFixture } from '../../helpers/fixtures.js';

const clusterId = 'cluster-a';
// The pool-scoped add-ons; the Node status policy's own spec covers it.
const addons = [NVIDIA_CLUSTER_ADDON, POOL_INGRESS_CLUSTER_ADDON];
const scoped = { addons, sleep: async () => {} };
const RUNTIME_CLASS_KEY = 'RuntimeClass//nvidia';

function k3sRuntimeClass(): V1RuntimeClass {
  return {
    apiVersion: 'node.k8s.io/v1',
    kind: 'RuntimeClass',
    metadata: {
      name: 'nvidia',
      annotations: {
        'objectset.rio.cattle.io/owner-gvk': 'k3s.cattle.io/v1, Kind=Addon',
        'objectset.rio.cattle.io/owner-name': 'runtimes',
        'objectset.rio.cattle.io/owner-namespace': 'kube-system',
      },
    },
    handler: 'nvidia',
  };
}
const DAEMON_SET_KEY = 'DaemonSet/kube-system/anycloud-nvidia-device-plugin';

function runtimeFor(
  objects: ReturnType<typeof createFakeKubernetesObjectApi>['api'],
  id = clusterId,
): ClusterRuntime {
  return {
    clusterId: id,
    kubernetesIdentity: 'uid-cluster',
    connectionRevision: 1,
    serverVersion: { major: 1, minor: 36, gitVersion: 'v1.36.0+k3s1' },
    verifiedAt: 0,
    connection: {
      kind: 'installer',
      server: 'https://cluster.example:6443',
      certificateAuthorityData: Buffer.from('ca').toString('base64'),
      credential: { kind: 'token', token: 't' },
    },
    cluster: makeClusterKubernetesClientFixture({ objects }),
  };
}

describe('cluster add-ons reconciler', () => {
  it('installs the NVIDIA stack once, then reads without writing while converged', async () => {
    const fake = createFakeKubernetesObjectApi();
    const control = createClusterAddonController(scoped);
    const runtime = runtimeFor(fake.api);

    const first = await control.ensure(runtime, { nvidiaGpus: 1 });
    expect(first.resources.map((entry) => entry.outcome)).toEqual([
      'created',
      'created',
    ]);
    expect(first.summary).toBe(
      'RuntimeClass nvidia created, DaemonSet kube-system/anycloud-nvidia-device-plugin created',
    );
    const runtimeClass = fake.objects.get(RUNTIME_CLASS_KEY) as V1RuntimeClass;
    const daemonSet = fake.objects.get(DAEMON_SET_KEY) as V1DaemonSet;
    expect(runtimeClass.handler).toBe('nvidia');
    expect(runtimeClass.metadata?.annotations).toEqual({
      [CLUSTER_ADDON_REVISION_ANNOTATION]: clusterAddonRevision(
        buildClusterNvidiaRuntimeClass(clusterId),
      ),
    });
    expect(daemonSet.metadata?.labels).toMatchObject({
      'app.kubernetes.io/managed-by': 'anycloud',
      'anycloud.sh/cluster': clusterId,
      'anycloud.sh/addon': 'nvidia',
    });
    expect(
      daemonSet.metadata?.annotations?.[CLUSTER_ADDON_REVISION_ANNOTATION],
    ).toBe(clusterAddonRevision(buildClusterNvidiaDevicePlugin(clusterId)));

    fake.calls.length = 0;
    const second = await control.ensure(runtime, { nvidiaGpus: 4 });
    expect(second.resources.map((entry) => entry.outcome)).toEqual([
      'unchanged',
      'unchanged',
    ]);
    expect(fake.calls.map((call) => call.verb)).toEqual(['read', 'read']);
    expect(fake.objects.get(DAEMON_SET_KEY)?.metadata?.generation).toBe(1);
  });

  it('RFC 0049 C32 creates the policy before the class and removes it after', async () => {
    const fake = createFakeKubernetesObjectApi();
    const control = createClusterAddonController({ sleep: async () => {} });
    const runtime = runtimeFor(fake.api);
    const need = { nvidiaGpus: 0, userNamespace: true };
    const created = await control.ensure(runtime, need);
    expect(
      created.resources
        .filter(({ addon }) => addon === 'user-namespace')
        .map(({ kind }) => kind),
    ).toEqual([
      'ValidatingAdmissionPolicy',
      'ValidatingAdmissionPolicyBinding',
      'RuntimeClass',
    ]);
    fake.calls.length = 0;
    expect(await control.remove(runtime, need)).toEqual(
      [
        'anycloud-user-namespace',
        'anycloud-user-namespace',
        'anycloud-user-namespace',
      ].map((name) => ({ name, outcome: 'deleted' })),
    );
    expect(
      fake.calls
        .filter((call) => call.verb === 'delete')
        .map((call) => call.key),
    ).toEqual([
      'RuntimeClass//anycloud-user-namespace',
      'ValidatingAdmissionPolicyBinding//anycloud-user-namespace',
      'ValidatingAdmissionPolicy//anycloud-user-namespace',
    ]);
  });

  it('does nothing for a CPU need and coalesces concurrent passes for one cluster', async () => {
    const fake = createFakeKubernetesObjectApi();
    const control = createClusterAddonController(scoped);
    const runtime = runtimeFor(fake.api);

    const cpu = await control.ensure(runtime, { nvidiaGpus: 0 });
    expect(cpu).toEqual({
      clusterId,
      resources: [],
      summary: 'no add-ons required',
    });
    expect(fake.calls).toEqual([]);

    const [a, b] = await Promise.all([
      control.ensure(runtime, { nvidiaGpus: 1 }),
      control.ensure(runtime, { nvidiaGpus: 1 }),
    ]);
    expect(a).toBe(b);
    expect(fake.calls.filter((call) => call.verb === 'create')).toHaveLength(2);
  });

  it('re-converges drift by another writer and replaces after a process restart', async () => {
    const fake = createFakeKubernetesObjectApi();
    const control = createClusterAddonController(scoped);
    const runtime = runtimeFor(fake.api);
    await control.ensure(runtime, { nvidiaGpus: 1 });

    fake.drift(DAEMON_SET_KEY, (object) => {
      const daemonSet = object as V1DaemonSet;
      daemonSet.spec!.template.spec!.containers[0].image = 'evil:latest';
    });
    const converged = await control.ensure(runtime, { nvidiaGpus: 1 });
    expect(converged.resources[1].outcome).toBe('replaced');
    const daemonSet = fake.objects.get(DAEMON_SET_KEY) as V1DaemonSet;
    expect(daemonSet.spec!.template.spec!.containers[0].image).toBe(
      buildClusterNvidiaDevicePlugin(clusterId).spec!.template.spec!
        .containers[0].image,
    );
    expect(daemonSet.metadata?.uid).toBe('uid-2');

    // A new process has no memory of what it wrote: the DaemonSet gets one
    // fenced replace (its generation stays put since nothing changes); the
    // RuntimeClass, immutable outside metadata, is adopted without a write.
    const restarted = createClusterAddonController(scoped);
    const generation = daemonSet.metadata?.generation;
    fake.calls.length = 0;
    const afterRestart = await restarted.ensure(runtime, { nvidiaGpus: 1 });
    expect(afterRestart.resources.map((entry) => entry.outcome)).toEqual([
      'unchanged',
      'replaced',
    ]);
    expect(fake.calls.filter((call) => call.key === RUNTIME_CLASS_KEY)).toEqual(
      [{ verb: 'read', key: RUNTIME_CLASS_KEY }],
    );
    expect(fake.objects.get(DAEMON_SET_KEY)?.metadata?.generation).toBe(
      generation,
    );
    const steady = await restarted.ensure(runtime, { nvidiaGpus: 1 });
    expect(steady.resources.map((entry) => entry.outcome)).toEqual([
      'unchanged',
      'unchanged',
    ]);

    // Metadata drift on the immutable object still converges by replace, and
    // an immutable-field change still recreates: the revision gate only
    // skips the write when the annotation matches.
    fake.drift(RUNTIME_CLASS_KEY, (object) => {
      object.metadata!.annotations![CLUSTER_ADDON_REVISION_ANNOTATION] =
        'stale';
    });
    const relabelled = await restarted.ensure(runtime, { nvidiaGpus: 1 });
    expect(relabelled.resources[0].outcome).toBe('replaced');
    fake.drift(RUNTIME_CLASS_KEY, (object) => {
      (object as V1RuntimeClass).handler = 'runc';
    });
    const rehandled = await restarted.ensure(runtime, { nvidiaGpus: 1 });
    expect(rehandled.resources[0].outcome).toBe('recreated');
  });

  it('names the missing permission when the cluster denies a write instead of retrying blind', async () => {
    const fake = createFakeKubernetesObjectApi();
    fake.seed({
      ...buildClusterNvidiaRuntimeClass(clusterId),
      metadata: {
        ...buildClusterNvidiaRuntimeClass(clusterId).metadata,
        annotations: { [CLUSTER_ADDON_REVISION_ANNOTATION]: 'stale' },
      },
    });
    const original = fake.api.replace;
    fake.api.replace = (async (body: Parameters<typeof original>[0]) => {
      if (body.kind === 'RuntimeClass') {
        throw Object.assign(
          new Error('runtimeclasses.node.k8s.io "nvidia" is forbidden'),
          { code: 403 },
        );
      }
      return original(body);
    }) as typeof original;
    const control = createClusterAddonController(scoped);

    let caught: unknown;
    try {
      await control.ensure(runtimeFor(fake.api), { nvidiaGpus: 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ClusterAddonPermissionError);
    expect((caught as Error).message).toBe(
      'cluster cluster-a: the registered identity may not update RuntimeClass nvidia (runtimeclasses.node.k8s.io "nvidia" is forbidden); grant it update on runtimeclasses and the node pool retries',
    );
    // Nothing past the denied object was written, and the next pass gives
    // the same diagnostic rather than a different state.
    expect(fake.objects.has(DAEMON_SET_KEY)).toBe(false);
    await expect(
      control.ensure(runtimeFor(fake.api), { nvidiaGpus: 1 }),
    ).rejects.toBeInstanceOf(ClusterAddonPermissionError);
    expect(fake.calls).toEqual([
      { verb: 'read', key: RUNTIME_CLASS_KEY },
      { verb: 'read', key: RUNTIME_CLASS_KEY },
    ]);
    expect(
      (fake.objects.get(RUNTIME_CLASS_KEY) as V1RuntimeClass).metadata
        ?.annotations,
    ).toEqual({ [CLUSTER_ADDON_REVISION_ANNOTATION]: 'stale' });
  });

  it('adopts add-ons installed by a destroyed cluster of the same control plane and converges them onto this cluster', async () => {
    const fake = createFakeKubernetesObjectApi();
    const previous = createClusterAddonController(scoped);
    await previous.ensure(runtimeFor(fake.api, 'cluster-old'), {
      nvidiaGpus: 1,
    });
    const oldDaemonSetUid = fake.objects.get(DAEMON_SET_KEY)?.metadata?.uid;

    const listDestroyedClusterIds = vi.fn(async (identity: string) =>
      identity === 'uid-cluster' ? ['cluster-old'] : [],
    );
    const control = createClusterAddonController({
      addons,
      clusterRecords: { listDestroyedClusterIds },
      sleep: async () => {},
    });
    const report = await control.ensure(runtimeFor(fake.api), {
      nvidiaGpus: 1,
    });
    // Labels are mutable on the RuntimeClass; the DaemonSet's Pod selector
    // carries the cluster label and is not, so it is recreated by exact UID.
    expect(report.resources.map((entry) => entry.outcome)).toEqual([
      'replaced',
      'recreated',
    ]);
    expect(listDestroyedClusterIds).toHaveBeenCalledWith('uid-cluster');
    const runtimeClass = fake.objects.get(RUNTIME_CLASS_KEY) as V1RuntimeClass;
    const daemonSet = fake.objects.get(DAEMON_SET_KEY) as V1DaemonSet;
    expect(runtimeClass.metadata?.labels?.['anycloud.sh/cluster']).toBe(
      clusterId,
    );
    expect(daemonSet.metadata?.labels?.['anycloud.sh/cluster']).toBe(clusterId);
    expect(daemonSet.spec?.template.spec?.nodeSelector).toMatchObject({
      'anycloud.sh/cluster': clusterId,
    });
    expect(daemonSet.metadata?.uid).not.toBe(oldDaemonSetUid);
    const steady = await control.ensure(runtimeFor(fake.api), {
      nvidiaGpus: 1,
    });
    expect(steady.resources.map((entry) => entry.outcome)).toEqual([
      'unchanged',
      'unchanged',
    ]);

    // A cluster id the record store does not know as a destroyed cluster of this
    // control plane is still foreign, with the object and remedy named.
    const stranger = createFakeKubernetesObjectApi();
    stranger.seed(buildClusterNvidiaRuntimeClass('cluster-elsewhere'));
    await expect(
      control.ensure(runtimeFor(stranger.api), { nvidiaGpus: 1 }),
    ).rejects.toThrow(
      'cluster cluster-a: RuntimeClass nvidia exists but is not owned by the nvidia add-on of this cluster (it is labelled anycloud.sh/cluster=cluster-elsewhere, which is neither this cluster nor a destroyed cluster of this control plane); refusing to adopt or replace a foreign object. Remove it if it is stale (kubectl delete runtimeclass nvidia) and the node pool retries',
    );
    expect(stranger.calls.filter((call) => call.verb !== 'read')).toEqual([]);
  });

  it('accepts the RuntimeClass K3s installs itself and never writes to it', async () => {
    const fake = createFakeKubernetesObjectApi();
    fake.seed(k3sRuntimeClass());
    const control = createClusterAddonController(scoped);
    const report = await control.ensure(runtimeFor(fake.api), {
      nvidiaGpus: 1,
    });
    expect(report.resources[0]).toMatchObject({
      kind: 'RuntimeClass',
      outcome: 'accepted',
    });
    expect(
      fake.calls.filter(
        (call) => call.key === RUNTIME_CLASS_KEY && call.verb !== 'read',
      ),
    ).toEqual([]);
    expect(report.resources[1].outcome).toBe('created');
  });

  it('fails closed on objects it does not own, including a K3s class with overrides or another cluster', async () => {
    const fake = createFakeKubernetesObjectApi();
    fake.seed({
      ...k3sRuntimeClass(),
      scheduling: { nodeSelector: { wrong: 'node' } },
    });
    const control = createClusterAddonController(scoped);
    await expect(
      control.ensure(runtimeFor(fake.api), { nvidiaGpus: 1 }),
    ).rejects.toBeInstanceOf(ClusterAddonOwnershipError);
    expect(fake.objects.has(DAEMON_SET_KEY)).toBe(false);

    const other = createFakeKubernetesObjectApi();
    other.seed(buildClusterNvidiaRuntimeClass('cluster-b'));
    other.seed({
      ...buildClusterNvidiaDevicePlugin(clusterId),
      metadata: {
        ...buildClusterNvidiaDevicePlugin(clusterId).metadata,
        ownerReferences: [
          { apiVersion: 'v1', kind: 'Foo', name: 'x', uid: 'u' },
        ],
      },
    });
    await expect(
      control.ensure(runtimeFor(other.api), { nvidiaGpus: 1 }),
    ).rejects.toThrow(/RuntimeClass nvidia exists but is not owned/);
    const objectsBefore = new Map(other.objects);
    const onlyDaemonSet = createFakeKubernetesObjectApi();
    onlyDaemonSet.seed(buildClusterNvidiaRuntimeClass(clusterId));
    onlyDaemonSet.seed(other.objects.get(DAEMON_SET_KEY)!);
    await expect(
      control.ensure(runtimeFor(onlyDaemonSet.api), { nvidiaGpus: 1 }),
    ).rejects.toThrow(
      /DaemonSet anycloud-nvidia-device-plugin exists but is not owned/,
    );
    expect(other.objects).toEqual(objectsBefore);
  });

  it('recreates when an immutable field differs, fencing the delete by UID and resourceVersion', async () => {
    const fake = createFakeKubernetesObjectApi();
    const stale = buildClusterNvidiaRuntimeClass(clusterId);
    fake.seed({ ...stale, handler: 'runc' });
    const control = createClusterAddonController(scoped);
    const report = await control.ensure(runtimeFor(fake.api), {
      nvidiaGpus: 1,
    });
    expect(report.resources[0].outcome).toBe('recreated');
    expect(
      fake.calls
        .filter((call) => call.key === RUNTIME_CLASS_KEY)
        .map((call) => call.verb),
    ).toEqual(['read', 'delete', 'read', 'create']);
    expect(
      (fake.objects.get(RUNTIME_CLASS_KEY) as V1RuntimeClass).handler,
    ).toBe('nvidia');

    const selectorChanged = createFakeKubernetesObjectApi();
    selectorChanged.seed(buildClusterNvidiaRuntimeClass(clusterId));
    const desired = buildClusterNvidiaDevicePlugin(clusterId);
    selectorChanged.seed({
      ...desired,
      spec: { ...desired.spec!, selector: { matchLabels: { old: 'x' } } },
    });
    const daemonSetReport = await control.ensure(
      runtimeFor(selectorChanged.api),
      { nvidiaGpus: 1 },
    );
    expect(daemonSetReport.resources[1].outcome).toBe('recreated');
  });

  it('waits for a terminating object and reports it as pending instead of adopting', async () => {
    const fake = createFakeKubernetesObjectApi();
    fake.seed({
      ...buildClusterNvidiaRuntimeClass(clusterId),
      handler: 'runc',
    });
    fake.holdDeletes = true;
    const sleep = vi.fn(async () => {});
    const control = createClusterAddonController({ addons, sleep });
    await expect(
      control.ensure(runtimeFor(fake.api), { nvidiaGpus: 1 }),
    ).rejects.toBeInstanceOf(ClusterAddonPendingError);
    expect(sleep).toHaveBeenCalledTimes(20);

    // Still terminating on the next pass: pending again, no adoption.
    await expect(
      control.ensure(runtimeFor(fake.api), { nvidiaGpus: 1 }),
    ).rejects.toThrow(/is being deleted; retrying/);
    fake.releaseHeldDeletes();
    fake.holdDeletes = false;
    const report = await control.ensure(runtimeFor(fake.api), {
      nvidiaGpus: 1,
    });
    expect(report.resources.map((entry) => entry.outcome)).toEqual([
      'created',
      'created',
    ]);
  });

  it('validates the winner of a create race instead of failing', async () => {
    const fake = createFakeKubernetesObjectApi();
    const control = createClusterAddonController(scoped);
    const original = fake.api.create;
    let raced = false;
    fake.api.create = (async (body: Parameters<typeof original>[0]) => {
      if (!raced && body.kind === 'RuntimeClass') {
        raced = true;
        fake.seed(buildClusterNvidiaRuntimeClass(clusterId));
      }
      return original(body);
    }) as typeof original;
    const report = await control.ensure(runtimeFor(fake.api), {
      nvidiaGpus: 1,
    });
    expect(report.resources[0].outcome).toBe('replaced');
  });

  it("removes a deleted pool's ingress release but keeps the Node status policy every pool needs", async () => {
    const fake = createFakeKubernetesObjectApi();
    const control = createClusterAddonController({ sleep: async () => {} });
    const runtime = runtimeFor(fake.api);
    const need = { nvidiaGpus: 0, ingressNodePoolId: 'pool-a' };
    await control.ensure(runtime, need);
    const policy = `ValidatingAdmissionPolicy//${NODE_STATUS_POLICY_NAME}`;
    const binding = `ValidatingAdmissionPolicyBinding//${NODE_STATUS_POLICY_NAME}`;
    expect(fake.objects.has(policy)).toBe(true);

    const removed = await control.remove(runtime, need);
    expect(removed.map((entry) => entry.name)).toEqual([
      `kube-system/${poolIngressReleaseName('pool-a')}`,
    ]);
    expect(fake.objects.has(policy)).toBe(true);
    expect(fake.objects.has(binding)).toBe(true);
  });
});
