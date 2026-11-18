import { describe, expect, it, vi } from 'vitest';
import type { V1Pod, V1PodSpec } from '@kubernetes/client-node';

import type { StoredDeployment } from '../../../src/api/services/deployment-store.js';
import type { DockerOptions } from '../../../src/shared/runtime.js';
import { apiImageTagReference } from '../../../src/shared/system-release.js';
import packageJson from '../../../package.json' with { type: 'json' };
import {
  observeDeployment,
  ownedHere,
  renderDeploymentObjects,
} from '../../../src/api/services/deployment-objects.js';
import {
  KUBERNETES_WORKLOAD_ID_ANNOTATION,
  KUBERNETES_GENERATION_ANNOTATION,
  kubernetesWorkloadResourceName,
} from '../../../src/api/services/kubernetes/identity.js';
import {
  makeContainerSpec,
  makeClusterKubernetesClientFixture,
} from '../helpers/fixtures.js';
import {
  assertNodePoolScheduling,
  nodePoolNamespace,
} from '../../../src/api/services/kubernetes/node-pool-scheduling.js';

const cpuNodePool = {
  clusterId: 'cluster-a',
  nodePoolId: 'node-pool-a',
  nvidiaGpusPerNode: 0,
};
const gpuNodePool = { ...cpuNodePool, nvidiaGpusPerNode: 4 };

function deploymentFixture(): StoredDeployment {
  return {
    readinessProbe: null,
    gracePeriodSeconds: 30,
    id: 'target-a',
    ownerUserId: 'user-a',
    name: 'deployment',
    nodePoolId: cpuNodePool.nodePoolId,
    config: makeContainerSpec({ image: 'busybox:latest' }),
    secretNames: [],
    gpuCount: 0,
    maxConcurrentJobsPerReplica: 1,
    minReplicas: 1,
    maxReplicas: 1,
    managed: false,
    runnerRelease: null,
    generation: 2,
    deletionRequestedAt: null,
    deletedAt: null,
    createdAt: 1,
    updatedAt: 2,
  };
}

/**
 * The kubelet's QoS class, as `GetPodQOS` computes it: Guaranteed when every
 * container, init containers included, has CPU and memory limits and any
 * request equals its limit; BestEffort when none sets either; else Burstable.
 */
function qosClass(pod: V1PodSpec): 'Guaranteed' | 'Burstable' | 'BestEffort' {
  const containers = [...(pod.initContainers ?? []), ...pod.containers];
  const guaranteed = containers.every(({ resources }) =>
    ['cpu', 'memory'].every(
      (name) =>
        resources?.limits?.[name] !== undefined &&
        (resources.requests?.[name] ?? resources.limits[name]) ===
          resources.limits[name],
    ),
  );
  const any = containers.some(({ resources }) =>
    ['cpu', 'memory'].some(
      (name) => resources?.requests?.[name] ?? resources?.limits?.[name],
    ),
  );
  return guaranteed ? 'Guaranteed' : any ? 'Burstable' : 'BestEffort';
}

describe('Kubernetes Deployment workload', () => {
  it('0029/S16 and RT10 project env and named Secrets through one owned Secret, env overriding', () => {
    const deployment = {
      ...deploymentFixture(),
      secretNames: ['db'],
      config: makeContainerSpec({ env: { DB_HOST: 'explicit' } }),
    };
    const render = (secretsEnv?: Record<string, string>) =>
      renderDeploymentObjects(
        deployment,
        'anycloud',
        'https://api.example.test',
        cpuNodePool,
        secretsEnv,
      );
    const manifests = render({
      DB_HOST: 'from-secret',
      DB_PASSWORD: 'secret-value',
    });
    const [applicationEnv] = manifests.secrets;
    const container =
      manifests.kubernetesDeployment.spec?.template.spec?.containers[0];

    expect(applicationEnv?.metadata?.name).toContain('application-env');
    expect(applicationEnv?.stringData).toEqual({
      DB_HOST: 'explicit',
      DB_PASSWORD: 'secret-value',
    });
    expect(container?.envFrom).toEqual([
      { secretRef: { name: applicationEnv?.metadata?.name } },
    ]);
    // No env value is in the Pod spec, only the platform's own variables.
    const template = JSON.stringify(manifests.kubernetesDeployment);
    expect(template).not.toContain('secret-value');
    expect(template).not.toContain('explicit');
    // Rotation changes the Secret only, never the Pod template.
    expect(render({ DB_PASSWORD: 'rotated' }).kubernetesDeployment).toEqual(
      manifests.kubernetesDeployment,
    );
    // Env alone takes the same path.
    expect(
      renderDeploymentObjects(
        { ...deployment, secretNames: [] },
        'anycloud',
        'https://api.example.test',
        cpuNodePool,
      ).secrets[0]?.stringData,
    ).toEqual({ DB_HOST: 'explicit' });
  });

  it('K6 and K9 harden every replica neither privileged nor in a user namespace, and keep it off BestEffort', () => {
    const render = (
      dockerOptions: DockerOptions | null,
      pool = cpuNodePool as Parameters<typeof renderDeploymentObjects>[3],
      gpuCount = 0,
    ) =>
      renderDeploymentObjects(
        {
          ...deploymentFixture(),
          gpuCount,
          config: makeContainerSpec({ dockerOptions }),
        },
        'anycloud',
        'https://api.example.test',
        pool,
      ).kubernetesDeployment.spec!.template.spec!.containers[0]!;
    const hardened = {
      allowPrivilegeEscalation: false,
      seccompProfile: { type: 'RuntimeDefault' },
    };
    // A CPU replica requests 1 vCPU, a default VM Job's size, and 90% of that
    // share of the pool VM's memory as request and limit: 1 of 16 vCPUs on
    // 64 GiB. A VM type missing from the catalog gets 1 GiB with no limit.
    const cpuPool = { ...cpuNodePool, nodeSize: { vCPUs: 16, memoryGiB: 64 } };
    expect(render(null, cpuPool)).toMatchObject({
      securityContext: hardened,
      resources: {
        requests: { cpu: '1', memory: '3686Mi' },
        limits: { memory: '3686Mi' },
      },
    });
    expect(render(null).resources).toEqual({
      requests: { cpu: '1', memory: '1Gi' },
    });
    // With --cpus, that 1 GiB is the limit too (C30).
    expect(render({ cpus: '2' }).resources).toEqual({
      requests: { cpu: '2', memory: '1Gi' },
      limits: { cpu: '2', memory: '1Gi' },
    });
    expect(render({ privileged: false }).securityContext).toEqual({
      privileged: false,
      ...hardened,
    });
    // Escalation is what privileged means; the API refuses both together.
    expect(render({ privileged: true }).securityContext).toEqual({
      privileged: true,
    });
    // What --cpus and --memory set wins over the defaults, and --cpus alone
    // takes its share of the memory: 4 of 16 vCPUs.
    expect(render({ cpus: '4' }, cpuPool).resources).toEqual({
      requests: { cpu: '4', memory: '14745Mi' },
      limits: { cpu: '4', memory: '14745Mi' },
    });
    expect(render({ memory: '2g' }, cpuPool).resources).toEqual({
      requests: { cpu: '1', memory: '2Gi' },
      limits: { memory: '2Gi' },
    });
    // A small share's limit is at least 512 MiB, as page cache counts against
    // it, and with --cpus the request is that limit, so the replica is
    // Guaranteed (C30): 0.1 of t3.small's 2 vCPUs, 2 GiB, would be 92 MiB.
    const t3Small = { ...cpuNodePool, nodeSize: { vCPUs: 2, memoryGiB: 2 } };
    expect(render({ cpus: '0.1' }, t3Small).resources).toEqual({
      requests: { cpu: '100m', memory: '512Mi' },
      limits: { cpu: '100m', memory: '512Mi' },
    });
    expect(render({ cpus: '0.1', memory: '128m' }, t3Small).resources).toEqual({
      requests: { cpu: '100m', memory: '128Mi' },
      limits: { cpu: '100m', memory: '128Mi' },
    });
    // A GPU replica takes 90% of its GPUs' share of the pool VM, with the
    // memory limit equal: 2 of 8 GPUs on 96 vCPUs and 1,152 GiB.
    const gpuPool = {
      ...gpuNodePool,
      nvidiaGpusPerNode: 8,
      nodeSize: { vCPUs: 96, memoryGiB: 1152 },
    };
    expect(render({ gpus: '2' }, gpuPool, 2).resources).toEqual({
      requests: { cpu: '21600m', memory: '265420Mi', 'nvidia.com/gpu': '2' },
      limits: { memory: '265420Mi', 'nvidia.com/gpu': '2' },
    });
  });

  it('0043 D-disk: a managed replica requests and is limited to its GPU or CPU fraction of Node ephemeral storage', () => {
    const ephemeralStorage = { allocatableGi: 100, vCPUs: 4 };
    const storage = (
      deployment: Partial<StoredDeployment>,
      dockerOptions: DockerOptions | null,
      pool: Parameters<typeof renderDeploymentObjects>[3],
    ) => {
      const { resources } = renderDeploymentObjects(
        {
          ...deploymentFixture(),
          managed: true,
          ...deployment,
          config: makeContainerSpec({ dockerOptions }),
        },
        'anycloud',
        'https://api.example.test',
        pool,
      ).kubernetesDeployment.spec!.template.spec!.containers[0]!;
      const request = resources?.requests?.['ephemeral-storage'];
      expect(resources?.limits?.['ephemeral-storage']).toBe(request);
      return request;
    };
    const gpuPool = { ...gpuNodePool, ephemeralStorage };
    // 1 of 4 GPUs takes a quarter of the Node's 100 GiB.
    expect(storage({ gpuCount: 1 }, { gpus: '1' }, gpuPool)).toBe('25600Mi');
    // On a CPU pool, --cpus 2 of 4 vCPUs takes half; the default 1 vCPU a
    // quarter.
    const cpuPool = { ...cpuNodePool, ephemeralStorage };
    expect(storage({}, { cpus: '2' }, cpuPool)).toBe('51200Mi');
    expect(storage({}, null, cpuPool)).toBe('25600Mi');
    // A user Deployment, or a pool of unknown disk size, sets none.
    expect(storage({ managed: false }, null, cpuPool)).toBeUndefined();
    expect(storage({}, null, cpuNodePool)).toBeUndefined();
    // A CPU pool whose vCPUs the catalog doesn't know sets none either.
    expect(
      storage({}, null, {
        ...cpuNodePool,
        ephemeralStorage: { allocatableGi: 100, vCPUs: 0 },
      }),
    ).toBeUndefined();
  });

  it('renders only the configured native exec probe and removes it from the next desired manifest', () => {
    const readinessProbe = {
      exec: { command: ['test', '-f', '/ready'] },
      periodSeconds: 1,
      failureThreshold: 1,
    };
    const withProbe = renderDeploymentObjects(
      { ...deploymentFixture(), readinessProbe },
      'anycloud',
      'https://api.example.test',
      cpuNodePool,
    );
    expect(
      withProbe.kubernetesDeployment.spec?.template.spec?.containers[0]
        .readinessProbe,
    ).toEqual(readinessProbe);
    const withoutProbe = renderDeploymentObjects(
      deploymentFixture(),
      'anycloud',
      'https://api.example.test',
      cpuNodePool,
    );
    expect(
      withoutProbe.kubernetesDeployment.spec?.template.spec?.containers[0]
        .readinessProbe,
    ).toBeUndefined();
  });

  it('observes a bounded Pod list and exact native object, with readiness from the selected Pod', async () => {
    const manifests = renderDeploymentObjects(
      deploymentFixture(),
      'anycloud',
      'https://api.example.test',
      cpuNodePool,
    );
    const pod: V1Pod = {
      metadata: {
        name: 'current',
        uid: 'uid',
        creationTimestamp: new Date(2),
        annotations: { [KUBERNETES_GENERATION_ANNOTATION]: '2' },
      },
      spec: {
        containers: [
          { name: 'workload', readinessProbe: { exec: { command: ['true'] } } },
        ],
      },
      status: {
        phase: 'Running',
        containerStatuses: [
          {
            name: 'workload',
            image: 'image',
            imageID: 'image-id',
            restartCount: 0,
            containerID: 'containerd://current',
            ready: true,
            state: { running: {} },
          },
        ],
      },
    };
    const list = vi.fn().mockResolvedValue({
      items: [
        pod,
        {
          ...pod,
          metadata: {
            ...pod.metadata,
            name: 'old',
            uid: 'old-uid',
            creationTimestamp: new Date(1),
          },
        },
      ],
    });
    const read = vi.fn().mockResolvedValue(manifests.kubernetesDeployment);
    const cluster = makeClusterKubernetesClientFixture({
      core: { listNamespacedPod: list },
      apps: { readNamespacedDeployment: read },
    });
    const signal = new AbortController().signal;
    const status = await observeDeployment(cluster, manifests, signal);
    expect(list).toHaveBeenCalledExactlyOnceWith(
      {
        namespace: manifests.namespace,
        labelSelector: manifests.podSelector,
        limit: 100,
      },
      expect.objectContaining({ middlewareMergeStrategy: 'append' }),
    );
    expect(read).toHaveBeenCalledExactlyOnceWith(
      {
        name: manifests.name,
        namespace: manifests.namespace,
      },
      expect.objectContaining({ middlewareMergeStrategy: 'append' }),
    );
    expect(status).toMatchObject({
      appliedGeneration: 2,
      rolledOut: false,
      containerReady: true,
      containerRunning: true,
      containerFailed: false,
      probeConfigured: true,
      workload: {
        observedGeneration: 2,
        podUid: 'uid',
        containerId: 'containerd://current',
      },
    });
    for (const [reason, containerFailed] of [
      ['ImagePullBackOff', true],
      ['CrashLoopBackOff', true],
      ['InvalidImageName', true],
      ['ErrImagePull', false],
      ['CreateContainerConfigError', false],
      ['ContainerCreating', false],
    ] as const) {
      pod.status!.containerStatuses![0]!.state = { waiting: { reason } };
      expect(await observeDeployment(cluster, manifests, signal)).toMatchObject(
        { containerRunning: false, containerFailed },
      );
    }
    pod.status!.containerStatuses![0]!.state = { running: {} };
    const progressing = (reason: string, observedGeneration: number) => ({
      ...manifests.kubernetesDeployment,
      metadata: { ...manifests.kubernetesDeployment.metadata, generation: 4 },
      status: {
        observedGeneration,
        conditions: [{ type: 'Progressing', status: 'True', reason }],
      },
    });
    for (const [native, rolledOut] of [
      [progressing('NewReplicaSetAvailable', 4), true],
      [progressing('NewReplicaSetAvailable', 3), false],
      [progressing('ReplicaSetUpdated', 4), false],
    ] as const) {
      read.mockResolvedValueOnce(native);
      expect(await observeDeployment(cluster, manifests, signal)).toMatchObject(
        { rolledOut },
      );
    }
    pod.metadata!.deletionTimestamp = new Date();
    expect(await observeDeployment(cluster, manifests, signal)).toMatchObject({
      podTerminating: true,
      containerRunning: false,
      containerReady: false,
    });
    list
      .mockResolvedValueOnce({
        items: Array.from({ length: 100 }, () => pod),
        metadata: { _continue: 'next-page' },
      })
      .mockResolvedValueOnce({
        items: [
          {
            ...pod,
            metadata: {
              ...pod.metadata,
              uid: 'newest',
              creationTimestamp: new Date(3),
            },
          },
        ],
      });
    read.mockResolvedValueOnce({
      ...manifests.kubernetesDeployment,
      status: { readyReplicas: 101 },
    });
    expect(await observeDeployment(cluster, manifests, signal)).toMatchObject({
      readyReplicas: 101,
      workload: { podUid: 'newest' },
    });
    expect(list).toHaveBeenLastCalledWith(
      {
        namespace: manifests.namespace,
        labelSelector: manifests.podSelector,
        limit: 100,
        _continue: 'next-page',
      },
      expect.objectContaining({ middlewareMergeStrategy: 'append' }),
    );
    const expired = new AbortController();
    list.mockImplementationOnce(async () => {
      expired.abort(new Error('observation deadline'));
      return { items: [pod], metadata: { _continue: 'next-page' } };
    });
    const beforeExpiry = list.mock.calls.length;
    await expect(
      observeDeployment(cluster, manifests, expired.signal),
    ).rejects.toThrow('observation deadline');
    expect(list.mock.calls.length).toBe(beforeExpiry + 1);
    list.mockResolvedValue({ items: [] });
    read.mockRejectedValue({ statusCode: 404 });
    expect(await observeDeployment(cluster, manifests, signal)).toMatchObject({
      appliedGeneration: null,
      containerReady: null,
      probeConfigured: null,
      workload: { podUid: null },
    });
    const cancelled = new AbortController();
    cancelled.abort(new Error('cancelled'));
    const requests = list.mock.calls.length;
    await expect(
      observeDeployment(cluster, manifests, cancelled.signal),
    ).rejects.toThrow('cancelled');
    expect(list).toHaveBeenCalledTimes(requests);
  });

  it("SPEND gives a replica no Node holds yet the spend cap's reason", async () => {
    const manifests = renderDeploymentObjects(
      deploymentFixture(),
      'anycloud',
      'https://api.example.test',
      cpuNodePool,
    );
    const pod: V1Pod = {
      metadata: { name: 'pending', uid: 'uid' },
      spec: { containers: [] },
      status: {
        phase: 'Pending',
        conditions: [
          {
            type: 'PodScheduled',
            status: 'False',
            reason: 'Unschedulable',
            message: '0/2 nodes are available',
          },
        ],
      },
    };
    const cluster = makeClusterKubernetesClientFixture({
      core: { listNamespacedPod: vi.fn().mockResolvedValue({ items: [pod] }) },
      apps: {
        readNamespacedDeployment: vi
          .fn()
          .mockResolvedValue(manifests.kubernetesDeployment),
      },
    });
    const capBlock = vi.fn(
      async (): Promise<string | null> => 'blocked by monthly budget',
    );
    const reason = async () =>
      (await observeDeployment(cluster, manifests, undefined, capBlock))
        .workload.pendingReason;
    expect(await reason()).toBe('blocked by monthly budget');
    expect(capBlock).toHaveBeenCalledWith(pod);
    capBlock.mockResolvedValueOnce(null);
    expect(await reason()).toBe('0/2 nodes are available');
    // A bound replica holds its Node, so caps don't hold it.
    pod.spec!.nodeName = 'node-a';
    capBlock.mockClear();
    expect(await reason()).toBe('0/2 nodes are available');
    expect(capBlock).not.toHaveBeenCalled();
  });

  it('keeps privileged nested workloads in the owning container PID namespace with Pod-owned storage', () => {
    const deployment = deploymentFixture();
    const manifests = renderDeploymentObjects(
      {
        ...deployment,
        config: {
          ...deployment.config,
          dockerOptions: {
            privileged: true,
            binds: ['/var/lib/docker', '/workspace'],
            cpus: '6',
            memory: '24g',
          },
        },
      },
      'anycloud',
      'https://api.example.test',
      cpuNodePool,
    );
    const pod = manifests.kubernetesDeployment.spec!.template.spec!;
    expect(pod.containers).toHaveLength(1);
    expect(pod.hostPID).not.toBe(true);
    expect(pod.shareProcessNamespace).not.toBe(true);
    expect(pod.initContainers).toBeUndefined();
    expect(pod.containers[0].securityContext).toEqual({ privileged: true });
    expect(pod.volumes).toEqual(
      expect.arrayContaining([
        { name: 'scratch-0', emptyDir: {} },
        { name: 'scratch-1', emptyDir: {} },
      ]),
    );
    expect(pod.volumes?.some((volume) => volume.hostPath)).toBe(false);
    expect(pod.containers[0].resources).toEqual({
      requests: { cpu: '6', memory: '24Gi' },
      limits: { cpu: '6', memory: '24Gi' },
    });
  });

  it('RFC 0049 C32 renders a user-namespace replica on its class, with its measured securityContext and Pod-owned storage', () => {
    const render = (
      dockerOptions: DockerOptions,
      pool: Parameters<typeof renderDeploymentObjects>[3],
    ) =>
      renderDeploymentObjects(
        {
          ...deploymentFixture(),
          managed: true,
          config: makeContainerSpec({
            dockerOptions,
            entrypoint: ['/entrypoint.sh'],
          }),
        },
        'anycloud',
        'https://api.example.test',
        pool,
      ).kubernetesDeployment.spec!.template.spec!;
    const t3Small = { ...cpuNodePool, nodeSize: { vCPUs: 2, memoryGiB: 2 } };
    const pod = render(
      { userNamespace: true, binds: ['/var/lib/docker'], cpus: '2' },
      { ...t3Small, kvm: true },
    );
    expect(pod.runtimeClassName).toBe('anycloud-user-namespace');
    expect(pod.hostUsers).toBe(false);
    expect(pod.hostPID).not.toBe(true);
    const [workload] = pod.containers;
    // No allowPrivilegeEscalation: false, which the API server refuses with
    // these capabilities, and no RuntimeDefault profile.
    expect(workload!.securityContext).toEqual({
      capabilities: { add: ['ALL'] },
      seccompProfile: { type: 'Unconfined' },
      appArmorProfile: { type: 'Unconfined' },
      procMount: 'Unmasked',
    });
    expect(workload!.env).toContainEqual({
      name: 'ANYCLOUD_RUNNER_USER_NAMESPACE',
      value: '1',
    });
    expect(pod.volumes).toContainEqual({ name: 'scratch-0', emptyDir: {} });
    expect(pod.volumes?.some((volume) => volume.hostPath)).toBe(false);
    // --cpus at every vCPU: t3.small's 2 GiB allocatable, less the class's
    // 32 MiB overhead, so the Pod still fits an empty Node; and /dev/kvm.
    expect(workload!.resources).toEqual({
      requests: { cpu: '2', memory: '1660Mi' },
      limits: { cpu: '2', memory: '1660Mi', 'anycloud.sh/kvm': '1' },
    });
    // Without nested virtualization there is no device to request.
    expect(
      render({ userNamespace: true, cpus: '2' }, t3Small).containers[0]!
        .resources?.limits,
    ).toEqual({ cpu: '2', memory: '1660Mi' });
  });

  it('RFC 0049 invariant 6: no render is privileged unless asked to be', () => {
    const t3Small = { ...cpuNodePool, nodeSize: { vCPUs: 2, memoryGiB: 2 } };
    const renders: [
      Partial<StoredDeployment>,
      DockerOptions | null,
      typeof t3Small | typeof gpuNodePool,
    ][] = [
      [{}, null, t3Small],
      [{ gpuCount: 1 }, { gpus: '1' }, gpuNodePool],
      [
        { managed: true },
        { userNamespace: true, binds: ['/var/lib/docker'] },
        t3Small,
      ],
      [{ managed: true }, { cpus: '1' }, t3Small],
    ];
    for (const [overrides, dockerOptions, pool] of renders) {
      const { template } = renderDeploymentObjects(
        {
          ...deploymentFixture(),
          ...overrides,
          config: makeContainerSpec({ dockerOptions, entrypoint: ['/e'] }),
        },
        'anycloud',
        'https://api.example.test',
        pool,
      ).kubernetesDeployment.spec!;
      expect(JSON.stringify(template)).not.toMatch(/"privileged":true/);
    }
  });

  it('C30: a managed replica with --cpus is Guaranteed, and without it Burstable', () => {
    const render = (
      dockerOptions: DockerOptions,
      pool: Parameters<typeof renderDeploymentObjects>[3],
      gpuCount = 0,
    ) =>
      renderDeploymentObjects(
        {
          ...deploymentFixture(),
          managed: true,
          gpuCount,
          config: makeContainerSpec({ dockerOptions }),
        },
        'anycloud',
        'https://api.example.test',
        pool,
      ).kubernetesDeployment.spec!.template.spec!;
    const ephemeralStorage = { allocatableGi: 100, vCPUs: 16 };
    const cpuPool = {
      ...cpuNodePool,
      nodeSize: { vCPUs: 16, memoryGiB: 64 },
      ephemeralStorage,
    };
    const t3Small = {
      ...cpuNodePool,
      nodeSize: { vCPUs: 2, memoryGiB: 2 },
      ephemeralStorage: { allocatableGi: 20, vCPUs: 2 },
    };
    const gpuPool = {
      ...gpuNodePool,
      nvidiaGpusPerNode: 8,
      nodeSize: { vCPUs: 96, memoryGiB: 1152 },
      ephemeralStorage,
    };
    for (const pod of [
      render({ cpus: '4' }, cpuPool),
      // The 512 MiB floor is the request too, not only the limit.
      render({ cpus: '0.1' }, t3Small),
      render({ cpus: '0.1', memory: '128m' }, t3Small),
      render({ gpus: '2', cpus: '8' }, gpuPool, 2),
      // A VM type missing from the catalog: 1 GiB, request and limit.
      render({ cpus: '2' }, cpuNodePool),
    ]) {
      expect(qosClass(pod)).toBe('Guaranteed');
      // runner-install takes the main container's resources, so the Pod's
      // effective request, the larger of an init container's and the main
      // container's, is unchanged.
      expect(pod.initContainers?.[0]?.resources).toEqual(
        pod.containers[0]!.resources,
      );
    }
    // Without --cpus a replica sets no CPU limit, so Jobs still fill a Node.
    expect(qosClass(render({}, cpuPool))).toBe('Burstable');
    expect(qosClass(render({ memory: '2g' }, cpuPool))).toBe('Burstable');
    expect(qosClass(render({ gpus: '2' }, gpuPool, 2))).toBe('Burstable');
    expect(qosClass(render({}, cpuNodePool))).toBe('Burstable');
  });

  it("runs a managed Deployment's replicas through the runner from the API's release image", () => {
    const managed = {
      ...deploymentFixture(),
      managed: true,
      gracePeriodSeconds: 120,
      config: makeContainerSpec({
        image: 'busybox:latest',
        entrypoint: ['/entrypoint.sh'],
        command: ['serve'],
      }),
    };
    const spec = renderDeploymentObjects(
      managed,
      'anycloud',
      'https://api.example.test',
      cpuNodePool,
    ).kubernetesDeployment.spec?.template.spec;
    const env = Object.fromEntries(
      (spec?.containers[0]?.env ?? []).map(({ name, value }) => [name, value]),
    );

    expect(
      spec?.initContainers?.map(({ name, image }) => [name, image]),
    ).toEqual([['runner-install', apiImageTagReference(packageJson.version)]]);
    // The runner splits the replica's grace with the final upload.
    expect(spec?.terminationGracePeriodSeconds).toBe(120);
    expect(env).toMatchObject({
      ANYCLOUD_RUNNER_ENTRYPOINT: '["/entrypoint.sh"]',
      ANYCLOUD_RUNNER_CMD: '["serve"]',
      ANYCLOUD_RUNNER_GRACE_SECONDS: '120',
    });
    // A user Deployment runs its own command, with no runner, under its grace.
    const user = renderDeploymentObjects(
      { ...deploymentFixture(), gracePeriodSeconds: 600 },
      'anycloud',
      'https://api.example.test',
      cpuNodePool,
    ).kubernetesDeployment.spec?.template.spec;
    expect(user?.initContainers).toBeUndefined();
    expect(user?.terminationGracePeriodSeconds).toBe(600);
  });

  it('renders deterministic Deployment identity and the Deployment ID environment variable', () => {
    const deployment = deploymentFixture();
    const manifests = renderDeploymentObjects(
      deployment,
      'anycloud',
      'https://api.example.test',
      cpuNodePool,
    );
    const container =
      manifests.kubernetesDeployment.spec?.template.spec?.containers[0];
    const env = Object.fromEntries(
      (container?.env ?? []).map(({ name, value }) => [name, value]),
    );

    expect(manifests.name).toBe(
      kubernetesWorkloadResourceName('deployment', deployment.id),
    );
    expect(manifests.kubernetesDeployment.metadata?.annotations).toMatchObject({
      [KUBERNETES_WORKLOAD_ID_ANNOTATION]: deployment.id,
    });
    expect(env).toMatchObject({
      ANYCLOUD_DEPLOYMENT_ID: deployment.id,
      WORKLOAD_ID: deployment.id,
      DEPLOYMENT_ID: deployment.id,
    });
    expect(env).not.toHaveProperty('ANYCLOUD_WORKER_ID');
    expect(env).not.toHaveProperty('ANYCLOUD_CLUSTER_DEPLOYMENT_ID');
  });

  it.each([
    null,
    { gpus: 'all' },
    { gpus: '2' },
    { runtime: 'nvidia' },
    { gpus: 'all', runtime: 'nvidia', shmSize: '2g' },
  ] satisfies (DockerOptions | null)[])(
    '0029/S18 renders resolved GPU resources and NVIDIA runtime for %j',
    (dockerOptions) => {
      const base = deploymentFixture();
      const deployment = {
        ...base,
        gpuCount: 2,
        config: { ...base.config, dockerOptions },
      };

      const manifests = renderDeploymentObjects(
        deployment,
        'anycloud',
        'https://api.example.test',
        gpuNodePool,
      );

      expect(
        manifests.kubernetesDeployment.spec?.template.spec?.containers[0]
          ?.resources,
      ).toEqual({
        // A pool VM missing from the catalog gets the unsized default (K9).
        requests: { cpu: '1', memory: '1Gi', 'nvidia.com/gpu': '2' },
        limits: { 'nvidia.com/gpu': '2' },
      });
      expect(
        manifests.kubernetesDeployment.spec?.template.spec?.runtimeClassName,
      ).toBe('nvidia');
      expect(
        manifests.kubernetesDeployment.spec?.template.spec?.hostIPC,
      ).toBeUndefined();
    },
  );

  it.each([null, { runtime: 'runc' }])(
    '0029/S18 keeps CPU resources on the default runtime for %j',
    (dockerOptions) => {
      const deployment = deploymentFixture();
      const manifests = renderDeploymentObjects(
        { ...deployment, config: { ...deployment.config, dockerOptions } },
        'anycloud',
        'https://api.example.test',
        cpuNodePool,
      );

      expect(
        manifests.kubernetesDeployment.spec?.template.spec?.containers[0]
          ?.resources?.requests?.['nvidia.com/gpu'],
      ).toBeUndefined();
      expect(
        manifests.kubernetesDeployment.spec?.template.spec?.runtimeClassName,
      ).toBeUndefined();
    },
  );

  it('rejects a stored runtime choice incompatible with GPU injection', () => {
    const deployment = deploymentFixture();
    expect(() =>
      renderDeploymentObjects(
        {
          ...deployment,
          gpuCount: 1,
          config: { ...deployment.config, dockerOptions: { runtime: 'runc' } },
        },
        'anycloud',
        'https://api.example.test',
        gpuNodePool,
      ),
    ).toThrow('Kubernetes GPU access requires the NVIDIA runtime');
  });

  describe('on a node pool', () => {
    const nodePool = {
      clusterId: 'cluster-a',
      nodePoolId: 'node-pool-aws-east',
      nvidiaGpusPerNode: 0,
    };
    const gpuNodePool = { ...nodePool, nvidiaGpusPerNode: 4 };
    const namespace = nodePoolNamespace(nodePool.nodePoolId);

    function nodePoolDeployment(
      overrides: Partial<StoredDeployment> = {},
    ): StoredDeployment {
      return {
        ...deploymentFixture(),
        nodePoolId: nodePool.nodePoolId,
        ...overrides,
      };
    }

    it('constrains the handler Pod to the node pool, keeps node-local DNS and passes the validator', () => {
      const manifests = renderDeploymentObjects(
        nodePoolDeployment(),
        namespace,
        'https://api.example.test',
        nodePool,
      );
      const podSpec = manifests.kubernetesDeployment.spec!.template.spec!;
      expect(manifests.namespace).toBe(namespace);
      expect(manifests.kubernetesDeployment.metadata?.namespace).toBe(
        namespace,
      );
      expect(manifests.serviceAccount.metadata?.namespace).toBe(namespace);
      expect(podSpec.nodeSelector).toEqual({
        'node-restriction.kubernetes.io/anycloud-node-pool':
          nodePool.nodePoolId,
      });
      expect(
        podSpec.affinity?.nodeAffinity
          ?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms[0]
          .matchExpressions,
      ).toEqual([
        {
          key: 'node-restriction.kubernetes.io/anycloud-node-pool',
          operator: 'In',
          values: [nodePool.nodePoolId],
        },
        { key: 'anycloud.sh/cluster', operator: 'In', values: ['cluster-a'] },
      ]);
      expect(podSpec.tolerations).toEqual([
        {
          key: 'anycloud.sh/node-pool',
          operator: 'Equal',
          value: nodePool.nodePoolId,
          effect: 'NoSchedule',
        },
      ]);
      // Jobs-only node pools are outbound-connected with node-local DNS; the
      // handler never gets a Service, ingress or cluster DNS.
      expect(podSpec.dnsPolicy).toBe('Default');
      expect(podSpec.automountServiceAccountToken).toBe(false);
      expect(podSpec.hostNetwork).toBeUndefined();
      expect(podSpec.nodeName).toBeUndefined();
      expect(() =>
        assertNodePoolScheduling(
          podSpec,
          nodePool.clusterId,
          nodePool.nodePoolId,
        ),
      ).not.toThrow();
      // The projected token the handler presents to next_job() is scoped to
      // the node pool namespace's ServiceAccount.
      expect(podSpec.serviceAccountName).toBe(manifests.name);
      expect(podSpec.volumes?.some((volume) => volume.projected)).toBe(true);
    });

    it('renders a GPU handler that requests whole devices under the nvidia runtime class', () => {
      const manifests = renderDeploymentObjects(
        nodePoolDeployment({
          gpuCount: 2,
          config: makeContainerSpec({
            image: 'ghcr.io/example/cuda:latest',
            dockerOptions: { gpus: '2' },
          }),
        }),
        namespace,
        'https://api.example.test',
        gpuNodePool,
      );
      const podSpec = manifests.kubernetesDeployment.spec!.template.spec!;
      expect(podSpec.runtimeClassName).toBe('nvidia');
      expect(podSpec.containers[0].resources?.limits?.['nvidia.com/gpu']).toBe(
        '2',
      );
      expect(podSpec.nodeSelector).toEqual({
        'node-restriction.kubernetes.io/anycloud-node-pool':
          nodePool.nodePoolId,
      });
      expect(() =>
        assertNodePoolScheduling(
          podSpec,
          nodePool.clusterId,
          nodePool.nodePoolId,
          { nvidiaGpus: 4 },
        ),
      ).not.toThrow();

      const cpu = renderDeploymentObjects(
        nodePoolDeployment(),
        namespace,
        'https://api.example.test',
        nodePool,
      ).kubernetesDeployment.spec!.template.spec!;
      expect(cpu.runtimeClassName).toBeUndefined();
      expect(cpu.containers[0].resources?.limits?.['nvidia.com/gpu']).toBe(
        undefined,
      );
    });

    it("enforces the node pool's capability rule on every rendered handler template", () => {
      const gpuSpec = (overrides: Partial<StoredDeployment>) =>
        nodePoolDeployment({
          gpuCount: 2,
          config: makeContainerSpec({
            image: 'ghcr.io/example/cuda:latest',
            dockerOptions: { gpus: '2' },
          }),
          ...overrides,
        });
      // A handler on a GPU node pool that allocates no devices is refused.
      expect(() =>
        renderDeploymentObjects(
          nodePoolDeployment(),
          namespace,
          'https://api.example.test',
          gpuNodePool,
        ),
      ).toThrow(/requests no nvidia.com\/gpu/);
      // The stored runtime choice cannot strip the NVIDIA runtime class from
      // a GPU allocation (pod-parts refuses runc with devices).
      expect(() =>
        renderDeploymentObjects(
          gpuSpec({
            config: makeContainerSpec({
              image: 'ghcr.io/example/cuda:latest',
              dockerOptions: { gpus: '2', runtime: 'runc' },
            }),
          }),
          namespace,
          'https://api.example.test',
          gpuNodePool,
        ),
      ).toThrow(/NVIDIA runtime/);
      // More devices than one node pool Node advertises can never schedule.
      expect(() =>
        renderDeploymentObjects(
          gpuSpec({}),
          namespace,
          'https://api.example.test',
          { ...nodePool, nvidiaGpusPerNode: 1 },
        ),
      ).toThrow(
        /requests 2 nvidia.com\/gpu but each node pool Node advertises 1/,
      );
      // A GPU allocation on a CPU node pool is refused.
      expect(() =>
        renderDeploymentObjects(
          gpuSpec({}),
          namespace,
          'https://api.example.test',
          nodePool,
        ),
      ).toThrow(/CPU capacity only/);
    });
  });

  it('owns a cached object only when its workload, user and owning API match', () => {
    const objects = renderDeploymentObjects(
      deploymentFixture(),
      'anycloud',
      'https://api.example.test',
      cpuNodePool,
    );
    const annotations = objects.serviceAccount.metadata!.annotations!;
    const object = (changes: Record<string, string | undefined>) => ({
      metadata: {
        annotations: Object.fromEntries(
          Object.entries({ ...annotations, ...changes }).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      },
    });
    expect(ownedHere(undefined, objects)).toBe(false);
    expect(ownedHere(object({}), objects)).toBe(true);
    // From before API ownership: no owner annotation.
    expect(
      ownedHere(object({ 'anycloud.sh/owner-api': undefined }), objects),
    ).toBe(true);
    for (const foreign of [
      { 'anycloud.sh/deployment-id': 'other' },
      { 'anycloud.sh/user-id': 'other' },
      { 'anycloud.sh/owner-api': 'other' },
    ]) {
      expect(ownedHere(object(foreign), objects)).toBe(false);
    }
  });
});
