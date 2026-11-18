import { describe, expect, it, vi } from 'vitest';
import type { V1Pod } from '@kubernetes/client-node';
import { getApiIdentity } from '../../../../src/api/services/api-identity.js';
import {
  KUBERNETES_OWNER_API_ANNOTATION,
  KUBERNETES_USER_ID_ANNOTATION,
  KUBERNETES_WORKLOAD_ID_ANNOTATION,
  kubernetesWorkloadResourceName,
  kubernetesWorkloadSecretName,
} from '../../../../src/api/services/kubernetes/identity.js';
import { KubernetesResourceOwnershipError } from '../../../../src/api/services/kubernetes/managed-resources.js';
import { ENTRY_HANDOFF_LABEL } from '../../../../src/api/services/kubernetes/node-pool-ingress.js';
import {
  assertNodePoolScheduling,
  MANAGEMENT_TAINT_KEY,
  NODE_POOL_MEMBER_LABEL,
  NODE_POOL_NODE_LABEL,
  CLUSTER_NODE_LABEL,
} from '../../../../src/api/services/kubernetes/node-pool-scheduling.js';
import {
  buildNodePoolServiceManifests,
  deleteNodePoolService,
  ensureNodePoolService,
  KUBERNETES_SERVICE_PORT,
  observeNodePoolService,
  stopNodePoolService,
  type NodePoolServiceSpec,
  serviceHostname,
  assertServiceHostnameFree,
} from '../../../../src/api/services/kubernetes/service-workload.js';
import {
  NODE_POOL_CLUSTER_PERMISSIONS,
  SERVICE_CLUSTER_PERMISSIONS,
} from '../../../../src/api/services/kubernetes/cluster-runtime.js';
import {
  FakeKubernetesCluster,
  type FakeKubernetesCall,
} from '../../helpers/fake-kubernetes-cluster.js';

function spec(
  overrides: Partial<NodePoolServiceSpec> = {},
): NodePoolServiceSpec {
  return {
    workloadId: 'svc-a',
    userId: 'alice',
    registryUsername: 'alice',
    clusterId: 'cluster-1',
    nodePoolId: 'node-pool-aws',
    capability: { nvidiaGpus: 0 },
    image: 'ghcr.io/acme/api:v1',
    imageDigest: null,
    command: null,
    env: null,
    registryToken: null,
    dockerOptions: null,
    secretsEnv: null,
    ...overrides,
  };
}

function pod(overrides: Partial<V1Pod> & { ready?: boolean } = {}): V1Pod {
  const { ready = true, ...rest } = overrides;
  return {
    metadata: {
      name: 'svc-a-pod',
      uid: 'pod-uid',
      creationTimestamp: new Date(1),
    },
    status: {
      phase: 'Running',
      conditions: [
        { type: 'PodScheduled', status: 'True' },
        { type: 'Ready', status: ready ? 'True' : 'False' },
      ],
      containerStatuses: [
        {
          name: 'workload',
          ready,
          restartCount: 0,
          image: 'ghcr.io/acme/api:v1',
          imageID: 'sha256:abc',
          state: { running: { startedAt: new Date(1) } },
        },
      ],
    },
    ...rest,
  };
}

describe('node pool Service manifests', () => {
  it('renders one Recreate replica in its own namespace with required node pool scheduling', () => {
    const manifests = buildNodePoolServiceManifests(spec());
    const name = kubernetesWorkloadResourceName('serve', 'svc-a');
    expect(manifests.namespace).toBe(name);
    expect(manifests.name).toBe(name);
    expect(manifests.kubernetesNamespace.metadata?.labels).toMatchObject({
      [NODE_POOL_NODE_LABEL]: 'node-pool-aws',
      [CLUSTER_NODE_LABEL]: 'cluster-1',
    });
    const kubernetesDeployment = manifests.kubernetesDeployment;
    expect(kubernetesDeployment.spec?.replicas).toBe(1);
    expect(kubernetesDeployment.spec?.strategy).toEqual({ type: 'Recreate' });
    expect(kubernetesDeployment.spec?.minReadySeconds).toBe(30);
    expect(kubernetesDeployment.metadata?.annotations).toMatchObject({
      [KUBERNETES_WORKLOAD_ID_ANNOTATION]: 'svc-a',
      [KUBERNETES_USER_ID_ANNOTATION]: 'alice',
      [KUBERNETES_OWNER_API_ANNOTATION]: getApiIdentity(),
    });
    const podSpec = kubernetesDeployment.spec!.template.spec!;
    expect(() =>
      assertNodePoolScheduling(podSpec, 'cluster-1', 'node-pool-aws'),
    ).not.toThrow();
    // The replica runs on the pool's ingress entry: pool VMs have no
    // node-to-node network, and the entry's Traefik must reach it.
    expect(podSpec.nodeSelector).toEqual({
      [NODE_POOL_MEMBER_LABEL]: 'node-pool-aws',
      'anycloud.sh/ingress-entry': 'node-pool-aws',
    });
    expect(manifests.kubernetesService.spec?.internalTrafficPolicy).toBe(
      'Local',
    );
    expect(manifests.ingressRoute.spec.routes[0].services[0]).toMatchObject({
      nativeLB: true,
    });
    expect(
      podSpec.tolerations?.some((t) => t.key === MANAGEMENT_TAINT_KEY),
    ).toBe(false);
    expect(podSpec.automountServiceAccountToken).toBe(false);
    expect(podSpec.serviceAccountName).toBeUndefined();
  });

  it('requests the stored GPU count under the nvidia runtime class, and none on CPU capacity', () => {
    const gpu = buildNodePoolServiceManifests(
      spec({ capability: { nvidiaGpus: 4 }, dockerOptions: { gpus: '2' } }),
    ).kubernetesDeployment.spec!.template.spec!;
    expect(gpu.containers[0].resources?.limits?.['nvidia.com/gpu']).toBe('2');
    expect(gpu.runtimeClassName).toBe('nvidia');

    const cpu =
      buildNodePoolServiceManifests(spec()).kubernetesDeployment.spec!.template
        .spec!;
    expect(
      cpu.containers[0].resources?.limits?.['nvidia.com/gpu'],
    ).toBeUndefined();
    expect(cpu.runtimeClassName).toBeUndefined();
  });

  it.each([
    [
      { nvidiaGpus: 1 },
      null,
      'Pods on a GPU node pool must request whole devices',
    ],
    [{ nvidiaGpus: 1 }, { gpus: '2' }, 'each node pool Node advertises 1'],
    [{ nvidiaGpus: 0 }, { gpus: '1' }, 'the node pool has CPU capacity only'],
  ])(
    'is refused by the node pool validator for %j with %j, independently of admission',
    (capability, dockerOptions, message) => {
      expect(() =>
        buildNodePoolServiceManifests(spec({ capability, dockerOptions })),
      ).toThrow(message);
    },
  );

  it('applies the $PORT contract to the container, probes and stable Service', () => {
    const defaults = buildNodePoolServiceManifests(spec());
    const container =
      defaults.kubernetesDeployment.spec!.template.spec!.containers[0];
    expect(defaults.containerPort).toBe(8088);
    expect(container.env).toEqual(
      expect.arrayContaining([
        { name: 'PORT', value: '8088' },
        { name: 'WORKLOAD_ID', value: 'svc-a' },
      ]),
    );
    expect(container.ports).toEqual([{ name: 'http', containerPort: 8088 }]);
    expect(container.readinessProbe?.tcpSocket?.port).toBe(8088);
    expect(container.startupProbe?.tcpSocket?.port).toBe(8088);
    expect(container.startupProbe?.failureThreshold).toBe(120);
    expect(defaults.kubernetesService.spec).toMatchObject({
      type: 'ClusterIP',
      ports: [
        { name: 'http', port: KUBERNETES_SERVICE_PORT, targetPort: 8088 },
      ],
    });
    expect(defaults.kubernetesService.spec?.selector).toEqual(
      defaults.kubernetesDeployment.spec?.selector.matchLabels,
    );

    const custom = buildNodePoolServiceManifests(
      spec({ env: { PORT: '9000' }, command: ['node', 'server.js'] }),
    );
    expect(custom.containerPort).toBe(9000);
    expect(custom.kubernetesService.spec?.ports?.[0].targetPort).toBe(9000);
    expect(
      custom.kubernetesDeployment.spec!.template.spec!.containers[0].args,
    ).toEqual(['node', 'server.js']);
    expect(() =>
      buildNodePoolServiceManifests(spec({ env: { PORT: 'http' } })),
    ).toThrow('PORT must be an integer');
  });

  it('keeps user environment and named Secret values in a Secret, user values winning', () => {
    const manifests = buildNodePoolServiceManifests(
      spec({
        env: { MODE: 'prod', SHARED: 'from-env', GITHUB_TOKEN: 'user-copy' },
        secretsEnv: { SHARED: 'from-secret', API_KEY: 'k' },
        registryToken: 'gh-token',
      }),
    );
    const applicationEnv = manifests.secrets.find(
      (secret) =>
        secret.metadata?.name ===
        kubernetesWorkloadSecretName('serve', 'svc-a', 'application-env'),
    );
    expect(applicationEnv?.stringData).toEqual({
      MODE: 'prod',
      SHARED: 'from-env',
      GITHUB_TOKEN: 'user-copy',
      API_KEY: 'k',
    });
    const container =
      manifests.kubernetesDeployment.spec!.template.spec!.containers[0];
    expect(container.envFrom).toEqual([
      { secretRef: { name: applicationEnv?.metadata?.name } },
    ]);
    expect(container.env?.some((entry) => entry.name === 'MODE')).toBe(false);
    expect(
      container.env?.some((entry) => entry.name.startsWith('GITHUB_')),
    ).toBe(false);
    expect(
      manifests.kubernetesDeployment.spec?.template.spec?.imagePullSecrets,
    ).toEqual([
      { name: kubernetesWorkloadSecretName('serve', 'svc-a', 'registry-auth') },
    ]);
    expect(
      manifests.secrets.map((secret) => secret.metadata?.name),
    ).toHaveLength(2);
  });
});

/** The SSAR attributes a recorded fake call corresponds to. */
function permissionFor(call: FakeKubernetesCall): {
  verb: string;
  group: string;
  resource: string;
} {
  const resources: Record<string, { group: string; resource: string }> = {
    Namespace: { group: '', resource: 'namespaces' },
    Secret: { group: '', resource: 'secrets' },
    Service: { group: '', resource: 'services' },
    Deployment: { group: 'apps', resource: 'deployments' },
    IngressRoute: { group: 'traefik.io', resource: 'ingressroutes' },
    Pod: { group: '', resource: 'pods' },
  };
  const verbs: Record<FakeKubernetesCall['op'], string> = {
    create: 'create',
    read: 'get',
    apply: 'patch',
    patch: 'patch',
    log: 'get',
    delete: 'delete',
    list: 'list',
    watch: 'watch',
  };
  return { verb: verbs[call.op], ...resources[call.kind] };
}

describe('node pool Service cluster permissions', () => {
  it('declares every verb a full ensure, re-apply, observe and delete cycle exercises', async () => {
    const cluster = new FakeKubernetesCluster();
    const manifests = buildNodePoolServiceManifests(
      spec({ env: { A: '1' }, registryToken: 'gh-token' }),
    );
    await assertServiceHostnameFree(cluster.client(), manifests);
    await ensureNodePoolService(cluster.client(), manifests);
    await ensureNodePoolService(cluster.client(), manifests);
    await observeNodePoolService(cluster.client(), manifests);
    await ensureNodePoolService(
      cluster.client(),
      buildNodePoolServiceManifests(spec()),
    );
    await stopNodePoolService(cluster.client(), manifests);
    await deleteNodePoolService(cluster.client(), manifests, {
      timeoutMs: 1_000,
    });

    const declared = new Set(
      [...NODE_POOL_CLUSTER_PERMISSIONS, ...SERVICE_CLUSTER_PERMISSIONS]
        .filter((rule) => !rule.namespace)
        .map((rule) => `${rule.verb} ${rule.group} ${rule.resource}`),
    );
    const used = new Set(
      cluster.calls.map((call) => {
        const { verb, group, resource } = permissionFor(call);
        return `${verb} ${group} ${resource}`;
      }),
    );
    expect(used).toContain('patch  namespaces');
    expect(used).toContain('list  pods');
    expect(used).toContain('list traefik.io ingressroutes');
    expect([...used].filter((key) => !declared.has(key))).toEqual([]);
  });
});

describe('node pool Service native objects', () => {
  it('creates namespace, Secrets, Deployment and Service in order and re-applies idempotently', async () => {
    const cluster = new FakeKubernetesCluster();
    const manifests = buildNodePoolServiceManifests(spec({ env: { A: '1' } }));
    await ensureNodePoolService(cluster.client(), manifests);
    expect(
      cluster.calls
        .filter((call) => call.op === 'create')
        .map((call) => call.kind),
    ).toEqual(['Namespace', 'Secret', 'Deployment', 'Service', 'IngressRoute']);
    expect(cluster.get('Namespace', '', manifests.namespace)).toBeDefined();

    cluster.calls.length = 0;
    await ensureNodePoolService(cluster.client(), manifests);
    expect(cluster.calls.map((call) => call.op)).toEqual(
      expect.arrayContaining(['apply']),
    );
    expect(cluster.calls.filter((call) => call.op === 'delete')).toEqual([]);
    expect(
      cluster.get('Deployment', manifests.namespace, manifests.name),
    ).toBeDefined();
  });

  it('leaves a Deployment an entry hand-off holds unapplied, and applies the rest', async () => {
    const cluster = new FakeKubernetesCluster();
    const manifests = buildNodePoolServiceManifests(spec());
    await ensureNodePoolService(cluster.client(), manifests);
    cluster.get(
      'Deployment',
      manifests.namespace,
      manifests.name,
    )!.metadata!.labels![ENTRY_HANDOFF_LABEL] = 'pool-a';
    cluster.calls.length = 0;
    await ensureNodePoolService(cluster.client(), manifests);
    const applied = cluster.calls
      .filter((call) => call.op === 'apply')
      .map((call) => call.kind);
    expect(applied).toContain('Service');
    expect(applied).not.toContain('Deployment');
  });

  it('writes every native object under the node pool Service field manager', async () => {
    const client = new FakeKubernetesCluster().client();
    const secret = vi.spyOn(client.core, 'createNamespacedSecret');
    const deployment = vi.spyOn(client.apps, 'createNamespacedDeployment');
    const patch = vi.spyOn(client.objects, 'patch');
    const manifests = buildNodePoolServiceManifests(spec({ env: { A: '1' } }));
    await ensureNodePoolService(client, manifests);
    await ensureNodePoolService(client, manifests);
    expect(patch).toHaveBeenCalled();
    expect(
      new Set([
        ...[...secret.mock.calls, ...deployment.mock.calls].map(
          ([r]) => r.fieldManager,
        ),
        ...patch.mock.calls.map((call) => call[3]),
      ]),
    ).toEqual(new Set(['anycloud-node-pool-service']));
  });

  it('removes a Secret the desired revision no longer renders', async () => {
    const cluster = new FakeKubernetesCluster();
    await ensureNodePoolService(
      cluster.client(),
      buildNodePoolServiceManifests(spec({ env: { A: '1' } })),
    );
    const manifests = buildNodePoolServiceManifests(spec());
    await ensureNodePoolService(cluster.client(), manifests);
    expect(
      cluster.get(
        'Secret',
        manifests.namespace,
        kubernetesWorkloadSecretName('serve', 'svc-a', 'application-env'),
      ),
    ).toBeUndefined();
  });

  it('refuses a same-name namespace owned by someone else and creates nothing inside it', async () => {
    const cluster = new FakeKubernetesCluster();
    const manifests = buildNodePoolServiceManifests(spec());
    cluster.seed({
      kind: 'Namespace',
      metadata: {
        name: manifests.namespace,
        annotations: { [KUBERNETES_WORKLOAD_ID_ANNOTATION]: 'someone-else' },
      },
    });
    await expect(
      ensureNodePoolService(cluster.client(), manifests),
    ).rejects.toBeInstanceOf(KubernetesResourceOwnershipError);
    expect(
      cluster.calls.filter((call) => call.op === 'create').map((c) => c.kind),
    ).toEqual(['Namespace']);
    expect(
      cluster.get('Deployment', manifests.namespace, manifests.name),
    ).toBeUndefined();
  });

  it('routes the public hostname to the native Service on the pool Traefik entrypoint', () => {
    const manifests = buildNodePoolServiceManifests(spec());
    expect(manifests.ingressRoute).toMatchObject({
      apiVersion: 'traefik.io/v1alpha1',
      kind: 'IngressRoute',
      metadata: {
        name: manifests.name,
        namespace: manifests.namespace,
        labels: { 'anycloud.sh/ingress-pool': spec().nodePoolId },
      },
      spec: {
        entryPoints: ['web'],
        routes: [
          {
            match: `Host(\`${spec().workloadId}.anycloud.sh\`)`,
            services: [{ name: manifests.name, port: 80 }],
          },
        ],
      },
    });
    expect(serviceHostname('svc-1')).toBe('svc-1.anycloud.sh');
  });

  it('fences the hostname against other pool-labelled routes but not its own', async () => {
    const cluster = new FakeKubernetesCluster();
    const manifests = buildNodePoolServiceManifests(spec());
    await ensureNodePoolService(cluster.client(), manifests);
    await expect(
      assertServiceHostnameFree(cluster.client(), manifests),
    ).resolves.toBeUndefined();
    cluster.seed({
      kind: 'IngressRoute',
      metadata: {
        name: 'x',
        namespace: 'elsewhere',
        labels: { 'anycloud.sh/ingress-pool': 'other-pool' },
      },
      spec: {
        routes: [{ match: manifests.ingressRoute.spec.routes[0].match }],
      },
    });
    await expect(
      assertServiceHostnameFree(cluster.client(), manifests),
    ).rejects.toThrow(
      `hostname ${manifests.hostname} is already served by IngressRoute elsewhere/x`,
    );
  });

  it('deletes the route first, then Deployment, Service, Secrets and the namespace, each by exact UID', async () => {
    const cluster = new FakeKubernetesCluster();
    const manifests = buildNodePoolServiceManifests(spec({ env: { A: '1' } }));
    await ensureNodePoolService(cluster.client(), manifests);
    const uidOf = (kind: string) =>
      cluster.get(kind, manifests.namespace, manifests.name)?.metadata?.uid;
    const routeUid = uidOf('IngressRoute');
    const deploymentUid = uidOf('Deployment');
    cluster.calls.length = 0;

    await deleteNodePoolService(cluster.client(), manifests, {
      timeoutMs: 1_000,
    });
    const deletes = cluster.calls.filter((call) => call.op === 'delete');
    // The public host stops routing before anything behind it goes.
    expect(deletes.map((call) => call.kind)).toEqual([
      'IngressRoute',
      'Deployment',
      'Service',
      'Secret',
      'Namespace',
    ]);
    expect(deletes[0]).toMatchObject({ uidPrecondition: routeUid });
    expect(deletes[1]).toMatchObject({
      uidPrecondition: deploymentUid,
      propagationPolicy: 'Foreground',
    });
    expect(cluster.objects.size).toBe(0);
  });

  it('leaves a foreign Deployment and namespace untouched during deletion', async () => {
    const cluster = new FakeKubernetesCluster();
    const manifests = buildNodePoolServiceManifests(spec());
    cluster.seed({
      kind: 'Namespace',
      metadata: {
        name: manifests.namespace,
        labels: manifests.kubernetesNamespace.metadata?.labels,
        annotations: {
          ...manifests.kubernetesNamespace.metadata?.annotations,
          [KUBERNETES_WORKLOAD_ID_ANNOTATION]: 'other-service',
        },
      },
    });
    cluster.seed({
      kind: 'Deployment',
      metadata: {
        name: manifests.name,
        namespace: manifests.namespace,
        labels: manifests.kubernetesDeployment.metadata?.labels,
        annotations: {
          ...manifests.kubernetesDeployment.metadata?.annotations,
          [KUBERNETES_USER_ID_ANNOTATION]: 'mallory',
        },
      },
    });
    await deleteNodePoolService(cluster.client(), manifests, {
      timeoutMs: 1_000,
    });
    expect(cluster.calls.filter((call) => call.op === 'delete')).toEqual([]);
    expect(cluster.objects.size).toBe(2);
  });

  it('keeps cleanup open while the namespace is still terminating', async () => {
    const cluster = new FakeKubernetesCluster();
    const manifests = buildNodePoolServiceManifests(spec());
    await ensureNodePoolService(cluster.client(), manifests);
    cluster.holdDeletion('Namespace', '', manifests.namespace);
    await expect(
      deleteNodePoolService(cluster.client(), manifests, { timeoutMs: 20 }),
    ).rejects.toThrow('Timed out deleting Namespace');
    cluster.releaseDeletion('Namespace', '', manifests.namespace);
    await deleteNodePoolService(cluster.client(), manifests, {
      timeoutMs: 1_000,
    });
    expect(cluster.objects.size).toBe(0);
  });

  it('stops only the native Deployment, keeping Service, Secrets and namespace', async () => {
    const cluster = new FakeKubernetesCluster();
    const manifests = buildNodePoolServiceManifests(spec({ env: { A: '1' } }));
    await ensureNodePoolService(cluster.client(), manifests);
    await stopNodePoolService(cluster.client(), manifests);
    expect(
      cluster.get('Deployment', manifests.namespace, manifests.name),
    ).toBeUndefined();
    expect(
      cluster.get('Service', manifests.namespace, manifests.name),
    ).toBeDefined();
    expect(cluster.get('Namespace', '', manifests.namespace)).toBeDefined();
  });

  it('observes absence, scheduling, starting, crashes and serving from native status', async () => {
    const cluster = new FakeKubernetesCluster();
    const manifests = buildNodePoolServiceManifests(spec());
    await expect(
      observeNodePoolService(cluster.client(), manifests),
    ).resolves.toMatchObject({ phase: 'absent' });

    await ensureNodePoolService(cluster.client(), manifests);
    await expect(
      observeNodePoolService(cluster.client(), manifests),
    ).resolves.toMatchObject({ phase: 'scheduling', podName: null });

    cluster.pods = [
      pod({
        ready: false,
        status: {
          conditions: [
            {
              type: 'PodScheduled',
              status: 'False',
              reason: 'Unschedulable',
              message: '0/3 nodes are available',
            },
          ],
        },
      }),
    ];
    await expect(
      observeNodePoolService(cluster.client(), manifests),
    ).resolves.toMatchObject({
      phase: 'scheduling',
      reason: '0/3 nodes are available',
    });

    cluster.pods = [
      pod({
        ready: false,
        status: {
          conditions: [{ type: 'PodScheduled', status: 'True' }],
          containerStatuses: [
            {
              name: 'workload',
              ready: false,
              restartCount: 0,
              image: 'i',
              imageID: 'i',
              state: {
                waiting: { reason: 'ImagePullBackOff', message: 'denied' },
              },
            },
          ],
        },
      }),
    ];
    await expect(
      observeNodePoolService(cluster.client(), manifests),
    ).resolves.toMatchObject({
      phase: 'starting',
      reason: 'ImagePullBackOff: denied',
    });

    cluster.pods = [
      pod({
        ready: false,
        status: {
          conditions: [{ type: 'PodScheduled', status: 'True' }],
          containerStatuses: [
            {
              name: 'workload',
              ready: false,
              restartCount: 3,
              image: 'i',
              imageID: 'i',
              state: { waiting: { reason: 'CrashLoopBackOff' } },
              lastState: { terminated: { exitCode: 1, reason: 'Error' } },
            },
          ],
        },
      }),
    ];
    await expect(
      observeNodePoolService(cluster.client(), manifests),
    ).resolves.toMatchObject({
      phase: 'crashed',
      reason: 'container exited with code 1 (Error)',
      restartCount: 3,
    });

    cluster.pods = [pod()];
    await expect(
      observeNodePoolService(cluster.client(), manifests),
    ).resolves.toMatchObject({
      phase: 'starting',
      reason: 'waiting for the readiness dwell',
    });
    const stored = cluster.get(
      'Deployment',
      manifests.namespace,
      manifests.name,
    )!;
    stored.status = { availableReplicas: 1 };
    await expect(
      observeNodePoolService(cluster.client(), manifests),
    ).resolves.toMatchObject({
      phase: 'serving',
      podName: 'svc-a-pod',
      podUid: 'pod-uid',
    });
  });
});
