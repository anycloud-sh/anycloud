import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type {
  V1Deployment,
  V1Namespace,
  V1Node,
  V1Pod,
  V1Secret,
} from '@kubernetes/client-node';
import { encryptCredential } from '../../../src/api/services/cloud-config.js';
import type { GatewayVM } from '../../../src/api/services/entities.js';
import {
  CandidateRegionAvailability,
  createCandidateRegionFilter,
  createCloudCompute,
  VM_PRESENT,
  VM_RELEASE_CANDIDATE,
  vmReleaseUnknown,
  type CandidateRegionFilter,
  type CloudCompute,
  type NodePoolBootInputs,
} from '../../../src/api/services/gateways/cloud.js';
import { CandidatePreflightCache } from '../../../src/api/services/candidate-preflight-cache.js';
import {
  ENTRY_HANDOFF_LABEL,
  INGRESS_ENTRY_NOT_READY_GRACE_MS,
  nodePoolNetwork,
  poolIngressReleaseName,
} from '../../../src/api/services/kubernetes/node-pool-ingress.js';
import {
  IGNORED_CLAIM_PREFIX,
  OUTDATED_REPLACEMENT_PREFIX,
} from '../../../src/api/services/cluster-store.js';
import { createClusterAddonController } from '../../../src/api/services/kubernetes/cluster-addon-reconciler.js';
import {
  buildPoolIngressHelmChart,
  buildClusterNvidiaDevicePlugin,
  NODE_STATUS_POLICY_NAME,
} from '../../../src/api/services/kubernetes/cluster-addons.js';
import {
  ClusterIdentityChangedError,
  ClusterPermissionError,
  type ClusterRuntime,
} from '../../../src/api/services/kubernetes/cluster-runtime.js';
import {
  KUBERNETES_MANAGED_BY_LABEL,
  nodePoolServicePodSelector,
} from '../../../src/api/services/kubernetes/identity.js';
import {
  INGRESS_ENTRY_NODE_LABEL,
  NODE_POOL_MEMBER_LABEL,
  nodePoolNamespace,
  nodePoolNodeLabels,
  nodePoolNodeName,
  nodePoolPodScheduling,
  UNUSABLE_GPU_NODE_LABEL,
} from '../../../src/api/services/kubernetes/node-pool-scheduling.js';
import {
  getPersistence,
  getSpendControlsStore,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import {
  createNodePoolController,
  holdPermissionFailures,
  type NodePoolControllerDeps,
  NODE_POOL_NETWORK,
  summarizeNodePoolCapacity,
  REMEDIATION_CAP,
  REMEDIATION_WINDOW_MS,
} from '../../../src/api/services/node-pool-controller.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { findReplicaCapBlock } from '../../../src/api/services/spend-controls.js';
import { FailureDisposition } from '../../../src/api/services/provisioning-failure.js';
import type { PermissionDenial } from '../../../src/shared/permission-denied.js';
import {
  getRegionsForVMType,
  nestedVirtualizationSupport,
} from '../../../src/shared/cloud-config.js';
import { resolveWorkloadPrice } from '../../../src/shared/catalog/index.js';
import { buildTargetCandidates } from '../../../src/api/services/launch-targets.js';
import {
  createFakeKubernetesObjectApi,
  type FakeKubernetesObjectApi,
} from '../helpers/fake-kubernetes-object-api.js';
import { makeClusterKubernetesClientFixture } from '../helpers/fixtures.js';
import {
  CloudFailureDiagnosis,
  CloudType,
  DiskTier,
  type CloudConfig,
  type GCPCredentials,
} from '../../../src/shared/cloud.js';
import { ClusterState } from '../../../src/shared/clusters.js';
import { NodePoolState } from '../../../src/shared/node-pools.js';
import { apiImageTagReference } from '../../../src/shared/system-release.js';

type CloudComputeProps = Parameters<typeof createCloudCompute>[0];
type NewResourceVMFn = NonNullable<
  CloudComputeProps['resourceScoped']
>['newResourceVM'];
type TerminateVMFn = NonNullable<CloudComputeProps['rawRequestVMTermination']>;

const clusterId = 'cluster-production';
const nodePoolId = 'node-pool-aws-east';
const credentialId = 'compute-aws';
const CA = Buffer.from('root-ca-pem').toString('base64');

interface FakeCloud {
  compute: CloudCompute;
  attempts: Map<string, GatewayVM>;
  live: Set<string>;
  /** Live VMs a stop-on-evict provider stopped; it can't restart them. */
  stopped: Set<string>;
  flags: { releaseUnknown: boolean };
  newResourceVM: Mock<NewResourceVMFn>;
  adoptResourceProvisioningAttempt: ReturnType<typeof vi.fn>;
  prepareResourceNetwork: ReturnType<typeof vi.fn>;
  terminateResourceNetwork: ReturnType<typeof vi.fn>;
  terminateResourceVMLeftovers: ReturnType<typeof vi.fn>;
  terminateVM: Mock<TerminateVMFn>;
}

/** A provider with none of the existing clouds' addresses or command. */
const NEW_PROVIDER_BOOT: NodePoolBootInputs = {
  hostOnlyCidrs: ['192.0.2.53/32'],
  resolvesThroughHostOnly: false,
  externalIpDiscovery: 'EXTERNAL_IP="$(new-provider-ip)"',
  resourceDiskStore: false,
};

function createFakeCloud(
  now: () => number,
  vmType = 't3.large',
  region = 'us-east-1',
  type = CloudType.AWS,
  candidateRegionFilter?: CandidateRegionFilter,
): FakeCloud {
  const attempts = new Map<string, GatewayVM>();
  const live = new Set<string>();
  const stopped = new Set<string>();
  const prepareResourceNetwork = vi
    .fn()
    .mockResolvedValue({ securityGroupId: 'scope-network' });
  const terminateResourceNetwork = vi.fn().mockResolvedValue(undefined);
  const terminateResourceVMLeftovers = vi.fn().mockResolvedValue(undefined);
  const adoptResourceProvisioningAttempt = vi.fn(
    async ({ vmId }: { vmId: string }) => attempts.get(vmId) ?? null,
  );
  const flags = { releaseUnknown: false };
  const state: Omit<FakeCloud, 'compute'> = {
    attempts,
    live,
    stopped,
    flags,
    newResourceVM: vi.fn<NewResourceVMFn>(),
    adoptResourceProvisioningAttempt,
    prepareResourceNetwork,
    terminateResourceNetwork,
    terminateResourceVMLeftovers,
    terminateVM: vi.fn<TerminateVMFn>(async (cloudId) => {
      live.delete(cloudId);
    }),
  };
  state.newResourceVM.mockImplementation(async (params) => {
    const vm: GatewayVM = {
      cloudId: `provider-${params.vmId}`,
      ip: `203.0.113.${attempts.size + 10}`,
      privateIp: `10.0.0.${attempts.size + 10}`,
      ...(region === 'us-east-1' ? { availabilityZone: 'us-east-1a' } : {}),
      createdAt: now(),
    };
    attempts.set(params.vmId, vm);
    live.add(vm.cloudId);
    return vm;
  });
  const compute = createCloudCompute({
    type,
    region,
    vmType,
    rawValidateCredentials: vi.fn().mockResolvedValue(undefined),
    rawClassifyError: (error) =>
      (error as { diagnosis?: CloudFailureDiagnosis }).diagnosis ??
      CloudFailureDiagnosis.TemporaryProviderFailure,
    permissionDenial: (error) =>
      (error as { denial?: PermissionDenial }).denial,
    rawNewVM: vi.fn(),
    rawRequestVMTermination: state.terminateVM,
    rawTerminateNetworking: vi.fn(),
    rawGetAllVMs: vi.fn().mockResolvedValue([]),
    rawUpsertFirewall: vi.fn(),
    observeVMReleaseOnce: vi.fn(async (cloudId: string) =>
      flags.releaseUnknown
        ? vmReleaseUnknown(new Error('provider observation timed out'))
        : live.has(cloudId)
          ? VM_PRESENT
          : VM_RELEASE_CANDIDATE,
    ),
    releaseConfirmWaitMs: 0,
    stoppedVmObservation: {
      observeStoppedVm: async (cloudId) => stopped.has(cloudId),
    },
    candidateRegionFilter,
    terminalAuthErrorClassifier: { isTerminalAuthError: () => true },
    resourceScoped: {
      nodePoolBoot: NEW_PROVIDER_BOOT,
      prepareResourceNetwork,
      adoptResourceProvisioningAttempt,
      newResourceVM: state.newResourceVM,
      terminateResourceNetwork,
      terminateResourceVMLeftovers,
    },
  });
  return { ...state, compute };
}

interface FakeCluster {
  runtime: ClusterRuntime;
  nodes: V1Node[];
  /** Pods bound to Nodes (`spec.nodeName`); deletions are recorded by name. */
  pods: V1Pod[];
  deletedPods: string[];
  /** Each Pod's log by name; absent reads as empty. */
  podLogs: Map<string, string>;
  secrets: V1Secret[];
  /** Cluster-scoped and kube-system objects cluster add-ons manage. */
  objects: FakeKubernetesObjectApi;
  /** Namespaces on the cluster, keyed by name. */
  namespaces: Map<string, V1Namespace>;
  deletedNamespaces: string[];
  cordoned: string[];
  deletedNodes: string[];
  /** Node patches in call order: cordons and label reconciles. */
  nodePatches: V1Node[];
  /** Service Kubernetes Deployments; patches merge into them. */
  deployments: V1Deployment[];
  /** Pods evicted through `pods/eviction`, by name. */
  evicted: string[];
  /** Pod names whose eviction a PodDisruptionBudget refuses (429). */
  refuseEviction: Set<string>;
  resolve: Mock<(clusterId: string) => Promise<ClusterRuntime>>;
  registerNode(
    vmRowId: number,
    options?: {
      ready?: boolean;
      gpus?: string;
      transitionAt?: number;
      unlabelled?: boolean;
      accelerator?: 'nvidia';
      /** Joined before the join script registered its revision. */
      outdated?: boolean;
      /** CPU, memory and ephemeral storage the kubelet advertises. */
      allocatable?: Record<string, string>;
      /** Kubernetes' `node.kubernetes.io/not-ready` taint. */
      notReadyTaint?: boolean;
    },
  ): void;
}

function createFakeCluster(): FakeCluster {
  const nodes: V1Node[] = [];
  const secrets: V1Secret[] = [];
  const objects = createFakeKubernetesObjectApi();
  const cordoned: string[] = [];
  const deletedNodes: string[] = [];
  const nodePatches: V1Node[] = [];
  const namespaces = new Map<string, V1Namespace>();
  const deletedNamespaces: string[] = [];
  let secretUid = 0;
  const pods: V1Pod[] = [];
  const deletedPods: string[] = [];
  const podLogs = new Map<string, string>();
  const deployments: V1Deployment[] = [];
  const evicted: string[] = [];
  const refuseEviction = new Set<string>();
  const labelled = (
    labels: Record<string, string> | undefined,
    selector?: string,
  ) => {
    const [key, value] = selector?.split('=') ?? [];
    return !key || labels?.[key] === value;
  };
  const core = {
    readNamespace: vi.fn(async ({ name }: { name: string }) => {
      const namespace = namespaces.get(name);
      if (!namespace) throw Object.assign(new Error('gone'), { code: 404 });
      return namespace;
    }),
    deleteNamespace: vi.fn(
      async ({
        name,
        body,
      }: {
        name: string;
        body?: { preconditions?: { uid?: string } };
      }) => {
        const namespace = namespaces.get(name);
        if (!namespace) throw Object.assign(new Error('gone'), { code: 404 });
        if (
          body?.preconditions?.uid &&
          body.preconditions.uid !== namespace.metadata?.uid
        ) {
          throw Object.assign(new Error('conflict'), { code: 409 });
        }
        namespaces.delete(name);
        deletedNamespaces.push(name);
        return {};
      },
    ),
    listNode: vi.fn(async () => ({ items: nodes })),
    // Pods bound to Nodes, by `spec.nodeName` and an optional `key=value`.
    listPodForAllNamespaces: vi.fn(
      async ({
        fieldSelector,
        labelSelector,
      }: {
        fieldSelector?: string;
        labelSelector?: string;
      }) => {
        return {
          items: pods.filter(
            (pod) =>
              `spec.nodeName=${pod.spec?.nodeName ?? ''}` === fieldSelector &&
              labelled(pod.metadata?.labels, labelSelector),
          ),
        };
      },
    ),
    createNamespacedPodEviction: vi.fn(async ({ name }: { name: string }) => {
      if (refuseEviction.has(name)) {
        throw Object.assign(new Error('budget'), { code: 429 });
      }
      evicted.push(name);
      const index = pods.findIndex((pod) => pod.metadata?.name === name);
      if (index >= 0) pods.splice(index, 1);
      return {};
    }),
    patchNamespacedPod: vi.fn(
      async ({ name, body }: { name: string; body: V1Pod }) => {
        const pod = pods.find((entry) => entry.metadata?.name === name)!;
        pod.metadata!.annotations = {
          ...pod.metadata?.annotations,
          ...body.metadata?.annotations,
        };
        return pod;
      },
    ),
    deleteNamespacedPod: vi.fn(async ({ name }: { name: string }) => {
      deletedPods.push(name);
      const index = pods.findIndex((pod) => pod.metadata?.name === name);
      if (index >= 0) pods.splice(index, 1);
      return {};
    }),
    listNamespacedPod: vi.fn(async ({ namespace }: { namespace: string }) => ({
      items: pods.filter((pod) => pod.metadata?.namespace === namespace),
    })),
    readNamespacedPodLog: vi.fn(
      async ({ name }: { name: string }) => podLogs.get(name) ?? '',
    ),
    listNamespacedEvent: vi.fn(async () => ({ items: [] })),
    patchNode: vi.fn(async ({ name, body }: { name: string; body: V1Node }) => {
      nodePatches.push({ ...body, metadata: { ...body.metadata, name } });
      const node = nodes.find((entry) => entry.metadata?.name === name);
      if (!node) throw Object.assign(new Error('gone'), { code: 404 });
      if (body.metadata?.uid && body.metadata.uid !== node.metadata?.uid) {
        throw Object.assign(new Error('uid conflict'), { code: 409 });
      }
      if (body.spec?.unschedulable) cordoned.push(name);
      if (body.spec?.unschedulable !== undefined) {
        node.spec = { ...node.spec, unschedulable: body.spec.unschedulable };
      }
      if (body.metadata?.annotations) {
        node.metadata!.annotations = Object.fromEntries(
          Object.entries({
            ...node.metadata?.annotations,
            ...body.metadata.annotations,
          }).filter(([, value]) => value !== null),
        );
      }
      if (body.metadata?.labels) {
        node.metadata!.labels = {
          ...node.metadata?.labels,
          ...body.metadata.labels,
        };
      }
      return node;
    }),
    deleteNode: vi.fn(async ({ name }: { name: string }) => {
      const index = nodes.findIndex((node) => node.metadata?.name === name);
      if (index === -1) throw Object.assign(new Error('gone'), { code: 404 });
      nodes.splice(index, 1);
      deletedNodes.push(name);
      return {};
    }),
    createNamespacedSecret: vi.fn(async ({ body }: { body: V1Secret }) => {
      const stored = {
        ...body,
        metadata: { ...body.metadata, uid: `secret-${++secretUid}` },
      };
      secrets.push(stored);
      return stored;
    }),
    listNamespacedSecret: vi.fn(
      async ({ labelSelector }: { labelSelector?: string }) => ({
        items: secrets.filter((secret) => {
          const labels = secret.metadata?.labels ?? {};
          return (labelSelector ?? '').split(',').every((pair) => {
            const [key, value] = pair.split('=');
            return labels[key] === value;
          });
        }),
      }),
    ),
    deleteNamespacedSecret: vi.fn(async ({ name }: { name: string }) => {
      const index = secrets.findIndex(
        (secret) => secret.metadata?.name === name,
      );
      if (index === -1) throw Object.assign(new Error('gone'), { code: 404 });
      secrets.splice(index, 1);
      return {};
    }),
  };
  const runtime: ClusterRuntime = {
    clusterId,
    kubernetesIdentity: 'uid-cluster',
    connectionRevision: 1,
    serverVersion: { major: 1, minor: 36, gitVersion: 'v1.36.1+k3s1' },
    verifiedAt: 0,
    connection: {
      kind: 'installer',
      server: 'https://cluster.example:6443',
      certificateAuthorityData: CA,
      credential: { kind: 'token', token: 'cluster-token' },
    },
    cluster: makeClusterKubernetesClientFixture({
      core,
      objects: objects.api,
      apps: {
        readNamespacedDaemonSet: vi.fn(async () => {
          throw Object.assign(new Error('gone'), { code: 404 });
        }),
        listDeploymentForAllNamespaces: vi.fn(
          async ({ labelSelector }: { labelSelector?: string }) => ({
            items: deployments.filter((entry) =>
              labelled(entry.metadata?.labels, labelSelector),
            ),
          }),
        ),
        patchNamespacedDeployment: vi.fn(
          async ({ name, body }: { name: string; body: V1Deployment }) => {
            const entry = deployments.find((d) => d.metadata?.name === name)!;
            entry.metadata!.labels = Object.fromEntries(
              Object.entries({
                ...entry.metadata?.labels,
                ...body.metadata?.labels,
              }).filter(([, value]) => value !== null),
            );
            entry.spec!.replicas = body.spec?.replicas ?? entry.spec!.replicas;
            return entry;
          },
        ),
      },
    }),
  };
  return {
    runtime,
    nodes,
    pods,
    deletedPods,
    podLogs,
    secrets,
    objects,
    namespaces,
    deletedNamespaces,
    cordoned,
    deletedNodes,
    nodePatches,
    deployments,
    evicted,
    refuseEviction,
    resolve: vi.fn<(clusterId: string) => Promise<ClusterRuntime>>(
      async () => runtime,
    ),
    registerNode(vmRowId, options = {}) {
      nodes.push({
        metadata: {
          name: nodePoolNodeName(nodePoolId, vmRowId),
          uid: `node-${vmRowId}`,
          ...(options.unlabelled
            ? {}
            : {
                labels: Object.fromEntries(
                  Object.entries(
                    nodePoolNodeLabels({
                      clusterId,
                      nodePoolId,
                      cloudProvider: CloudType.AWS,
                      vmRowId,
                      ...(options.accelerator
                        ? { accelerator: options.accelerator }
                        : {}),
                    }),
                  ).filter(
                    ([key]) =>
                      !options.outdated || key !== 'anycloud.sh/join-revision',
                  ),
                ),
              }),
        },
        spec: options.notReadyTaint
          ? {
              taints: [
                { key: 'node.kubernetes.io/not-ready', effect: 'NoSchedule' },
              ],
            }
          : {},
        status: {
          conditions: [
            {
              type: 'Ready',
              status: options.ready === false ? 'False' : 'True',
              ...(options.transitionAt !== undefined
                ? { lastTransitionTime: new Date(options.transitionAt) }
                : {}),
            },
          ],
          allocatable: {
            ...(options.allocatable ?? {
              cpu: '1900m',
              memory: '7Gi',
              'ephemeral-storage': '95Gi',
            }),
            ...(options.gpus !== undefined
              ? { 'nvidia.com/gpu': options.gpus }
              : {}),
          },
        },
      });
    },
  };
}

async function seed(vmType = 't3.large', vmCount = 1): Promise<void> {
  const encrypted = await encryptCredential({
    cloudProvider: CloudType.AWS,
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
  });
  await getDB().query(
    `INSERT INTO credentials (id, encrypted_data, cloud_provider)
     VALUES (?, ?, ?)`,
    [credentialId, encrypted, CloudType.AWS],
  );
  await getPersistence().clusters.recordSelf({
    id: clusterId,
    ownerUserId: 'owner-1',
    name: 'production',
    kubernetesIdentity: 'uid-cluster',
    connection: '{"stored":true}',
  });
  await getPersistence().nodePools.create({
    id: nodePoolId,
    clusterId,
    ownerUserId: 'owner-1',
    name: 'aws-east',
    computeCredentialId: credentialId,
    region: 'us-east-1',
    zone: 'us-east-1a',
    vmTypes: [vmType],
    minVmCount: vmCount,
    maxVmCount: vmCount,
  });
}

function nodePool() {
  return getPersistence().nodePools.getForScope(nodePoolId, { kind: 'api' });
}

function vms() {
  return getPersistence().nodePoolVms.listVms(nodePoolId);
}

const gcpCredentials: GCPCredentials = {
  cloudProvider: CloudType.GCP,
  projectId: 'p',
  clientEmail: 'e@p.iam.gserviceaccount.com',
  privateKey: 'k',
};

function launchFailures() {
  return getPersistence().nodePoolVms.listLaunchFailures(nodePoolId, 0);
}

function providerError(message: string, diagnosis: CloudFailureDiagnosis) {
  return Object.assign(new Error(message), { diagnosis });
}

/** EC2 refusing the credential in one region (an aws:RequestedRegion policy). */
function regionalDenial() {
  return Object.assign(
    providerError(
      'UnauthorizedOperation',
      CloudFailureDiagnosis.PermissionDenied,
    ),
    { denial: { action: 'ec2:RunInstances', regional: true } },
  );
}

/** A pool Pod kube-scheduler couldn't place, as the watch cache holds it. */
function pendingPod(
  name: string,
  requests: Record<string, string>,
  options: {
    foreign?: boolean;
    deleting?: boolean;
    nodeSelector?: Record<string, string>;
  } = {},
): V1Pod {
  return {
    metadata: {
      name,
      namespace: nodePoolNamespace(nodePoolId),
      uid: `${name}-uid`,
      labels: options.foreign
        ? {}
        : { [KUBERNETES_MANAGED_BY_LABEL]: 'anycloud' },
      ...(options.deleting ? { deletionTimestamp: new Date() } : {}),
    },
    spec: {
      nodeSelector: {
        [NODE_POOL_MEMBER_LABEL]: nodePoolId,
        ...options.nodeSelector,
      },
      containers: [{ name: 'main', resources: { requests } }],
    },
    status: {
      phase: 'Pending',
      conditions: [
        { type: 'PodScheduled', status: 'False', reason: 'Unschedulable' },
      ],
    },
  };
}

/** An anycloud Pod bound to a Node: a replica, or a DaemonSet's Pod. */
function boundPod(
  name: string,
  nodeName: string,
  options: { daemonSet?: Record<string, string>; deleting?: boolean } = {},
): V1Pod {
  return {
    metadata: {
      name,
      namespace: options.daemonSet ? 'kube-system' : 'pool',
      uid: `${name}-uid`,
      labels: { [KUBERNETES_MANAGED_BY_LABEL]: 'anycloud' },
      ...(options.daemonSet
        ? {
            ownerReferences: [
              { apiVersion: 'apps/v1', kind: 'DaemonSet', name, uid: 'ds' },
            ],
          }
        : {}),
      ...(options.deleting ? { deletionTimestamp: new Date() } : {}),
    },
    spec: {
      nodeName,
      containers: [
        { name: 'main', resources: { requests: options.daemonSet ?? {} } },
      ],
    },
  };
}

/** The pool's Traefik Pod on `nodeName`. */
function poolTraefik(nodeName: string): V1Pod {
  const pod = boundPod(`traefik-${nodeName}`, nodeName, { daemonSet: {} });
  pod.metadata!.namespace = poolIngressReleaseName(nodePoolId);
  return pod;
}

describe('node pool controller', () => {
  let cloud: FakeCloud;
  let cluster: FakeCluster;
  let clock: { now: number };
  let liveReferences: number;
  let liveServices: number;
  let poolJobsInFlight: Array<{ podUid: string }>;
  let closedReplicas: string[];
  let unfit: Mock<NodePoolControllerDeps['unfit']>;
  let entryChanges: ReturnType<
    typeof vi.fn<NonNullable<NodePoolControllerDeps['ingress']>['entryChanged']>
  >;
  /** The entry IP every published Service record reads. */
  let publishedIp: string | null;

  function controller(
    options: { clusterResolve?: FakeCluster['resolve'] } = {},
  ) {
    return createNodePoolController(controllerDeps(options));
  }

  function controllerDeps(
    options: { clusterResolve?: FakeCluster['resolve'] } = {},
  ): NodePoolControllerDeps {
    return {
      nodePools: getPersistence().nodePools,
      vms: getPersistence().nodePoolVms,
      clusterRecords: getPersistence().clusterRecords,
      references: {
        countLiveForNodePool: async () => liveReferences,
        countServicesForNodePool: async () => liveServices,
        listManagedImages: (nodePoolId) =>
          getPersistence().deployments.listLiveManagedImages(nodePoolId),
      },
      ingress: {
        entryChanged: entryChanges,
        publishedAt: async (_, ip) => publishedIp === ip,
      },
      clusterRuntime: { resolve: options.clusterResolve ?? cluster.resolve },
      pods: () => cluster.pods,
      unfit,
      poolJobs: {
        closeReplica: (podUid) => closedReplicas.push(podUid),
        inFlight: async () => poolJobsInFlight,
      },
      clusterAddons: createClusterAddonController({
        clusterRecords: getPersistence().clusterRecords,
        sleep: async () => {},
      }),
      credentials: getPersistence().credentialSecrets,
      createCompute: () => cloud.compute,
      version: 'test',
      now: () => clock.now,
    };
  }

  beforeEach(async () => {
    resetPersistence();
    clock = { now: Date.now() };
    cloud = createFakeCloud(() => clock.now);
    cluster = createFakeCluster();
    liveReferences = 0;
    liveServices = 0;
    poolJobsInFlight = [];
    closedReplicas = [];
    unfit = vi.fn<NodePoolControllerDeps['unfit']>();
    entryChanges =
      vi.fn<NonNullable<NodePoolControllerDeps['ingress']>['entryChanged']>();
    publishedIp = null;
    await seed();
  });

  it('provisions a keyless worker with a per-attempt join token and becomes ready when its Node joins', async () => {
    const control = controller();

    await control.reconcile(nodePoolId);

    const attempts = await vms();
    expect(attempts).toHaveLength(1);
    const [attempt] = attempts;
    expect(attempt).toMatchObject({
      nodePoolId,
      credentialId,
      region: 'us-east-1',
      availabilityZone: 'us-east-1a',
      vmType: 't3.large',
      ip: '203.0.113.10',
      endedAt: null,
      removalRequestedAt: null,
    });
    expect(attempt.cloudId).toMatch(/^provider-node-pool-aws-east-vm-/);
    expect(cloud.prepareResourceNetwork).toHaveBeenCalledWith(
      NODE_POOL_NETWORK,
      expect.objectContaining({
        id: nodePoolId,
        tags: expect.objectContaining({
          anycloud_user: 'owner-1',
          anycloud_cluster: clusterId,
        }),
      }),
      'test',
    );
    const request = cloud.newResourceVM.mock.calls[0][0];
    expect(request).toMatchObject({
      ingressSpec: NODE_POOL_NETWORK,
      network: { securityGroupId: 'scope-network' },
      adoptExistingAttempt: true,
    });
    // The VM boots with its provider's deny list and discovery command.
    expect(request.startupScript).toContain(
      '-s 10.42.0.0/16 -d 192.0.2.53/32 -j ANYCLOUD-METADATA',
    );
    expect(request.startupScript).not.toContain('169.254.169.254');
    expect(request.startupScript).toContain(
      '\nEXTERNAL_IP="$(new-provider-ip)"\n',
    );
    expect(cluster.secrets).toHaveLength(1);
    const token = cluster.secrets[0].stringData!;
    expect(request.startupScript).toContain(
      `K10${createHash('sha256').update(Buffer.from(CA, 'base64')).digest('hex')}::${token['token-id']}.${token['token-secret']}`,
    );
    expect(request.startupScript).toContain(
      `"node-name": "${nodePoolNodeName(nodePoolId, attempt.id)}"`,
    );
    // service-terminology-ok: the K3s config key for the join endpoint
    expect(request.startupScript).toContain(
      '"server": "https://cluster.example:6443"',
    );
    // C11: a pool with no Job yet pulls only the runner-install image.
    expect(request.startupScript).toContain(
      `\nfor image in '${apiImageTagReference('test')}'; do\n`,
    );
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Creating,
      lastError: null,
    });
    await expect(control.observeCapacity(nodePoolId)).resolves.toEqual({
      readyVmCount: 0,
      startingVmCount: 1,
      drainingVmCount: 0,
      locations: [
        {
          region: 'us-east-1',
          zone: 'us-east-1a',
          vmType: 't3.large',
          releasing: null,
        },
      ],
    });

    // The token is removed as soon as the Node object exists, before Ready.
    cluster.registerNode(attempt.id, { ready: false });
    await control.reconcile(nodePoolId);
    expect(cluster.secrets).toHaveLength(0);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Creating,
    });

    cluster.nodes[0].status!.conditions![0].status = 'True';
    await control.reconcile(nodePoolId);

    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
    });
    expect(cluster.secrets).toHaveLength(0);
    expect(cloud.newResourceVM).toHaveBeenCalledTimes(1);
    await expect(control.observeCapacity(nodePoolId)).resolves.toEqual({
      readyVmCount: 1,
      startingVmCount: 0,
      drainingVmCount: 0,
      locations: [
        {
          region: 'us-east-1',
          zone: 'us-east-1a',
          vmType: 't3.large',
          releasing: null,
        },
      ],
    });
    await expect(vms()).resolves.toHaveLength(1);
  });

  it('refuses to operate when the cluster is not ready or reports a foreign identity', async () => {
    await getDB().query(`UPDATE clusters SET state = 'failed' WHERE id = ?`, [
      clusterId,
    ]);
    const control = controller();
    await expect(control.reconcile(nodePoolId)).rejects.toThrow(/is not ready/);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Failed,
      lastError: expect.stringContaining('is not ready'),
    });
    expect(cluster.resolve).not.toHaveBeenCalled();

    await getDB().query(`UPDATE clusters SET state = 'ready' WHERE id = ?`, [
      clusterId,
    ]);
    cluster.resolve.mockRejectedValueOnce(
      new ClusterIdentityChangedError(clusterId),
    );
    await expect(control.reconcile(nodePoolId)).rejects.toThrow(
      /foreign control plane/,
    );
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Failed,
      lastError: expect.stringContaining('foreign control plane'),
    });
    expect(cloud.newResourceVM).not.toHaveBeenCalled();
    await expect(vms()).resolves.toEqual([]);

    // A later pass provisions again; the failure diagnostic stays visible
    // until the node pool actually becomes ready.
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Failed,
      lastError: expect.stringContaining('foreign control plane'),
    });
    await expect(vms()).resolves.toHaveLength(1);
  });

  it('fails closed when a Node carries the node pool label but is not an owned attempt', async () => {
    const control = controller();
    await control.reconcile(nodePoolId);
    const [attempt] = await vms();
    cluster.registerNode(attempt.id);
    cluster.registerNode(999);

    await expect(control.reconcile(nodePoolId)).rejects.toThrow(
      /refusing to count foreign capacity/,
    );
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Failed,
      lastError: expect.stringContaining(nodePoolNodeName(nodePoolId, 999)),
    });
    expect(cloud.terminateVM).not.toHaveBeenCalled();
  });

  it("reports another pool's Node that claims this pool by label alone, without failing or counting it", async () => {
    const control = controller();
    await control.reconcile(nodePoolId);
    const [attempt] = await vms();
    cluster.registerNode(attempt.id);
    // Pool B's member relabels itself into this pool, as its kubelet may.
    const intruder = nodePoolNodeName('node-pool-b', 7);
    cluster.registerNode(7);
    cluster.nodes[1].metadata = {
      name: intruder,
      uid: 'node-b-7',
      labels: {
        ...nodePoolNodeLabels({
          clusterId,
          nodePoolId: 'node-pool-b',
          cloudProvider: CloudType.AWS,
          vmRowId: 7,
        }),
        [NODE_POOL_MEMBER_LABEL]: 'node-pool-b',
        'anycloud.sh/node-pool': nodePoolId,
      },
    };

    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
      lastError: `${IGNORED_CLAIM_PREFIX}${intruder}`,
    });
    await expect(control.observeCapacity(nodePoolId)).resolves.toMatchObject({
      readyVmCount: 1,
    });
    expect(cluster.nodes[1].metadata?.labels?.[NODE_POOL_MEMBER_LABEL]).toBe(
      'node-pool-b',
    );

    cluster.nodes.splice(1, 1);
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
      lastError: null,
    });
  });

  it('replaces a VM whose Node never joins after the install window and recovers a released VM', async () => {
    const control = controller();
    await control.reconcile(nodePoolId);
    const [first] = await vms();

    clock.now += 5 * 60_000;
    await control.reconcile(nodePoolId);
    expect(cloud.terminateVM).not.toHaveBeenCalled();

    clock.now += 6 * 60_000;
    await control.reconcile(nodePoolId);
    expect(cloud.terminateVM).toHaveBeenCalledWith(first.cloudId);
    const afterReplacement = await vms();
    expect(afterReplacement).toHaveLength(2);
    expect(afterReplacement[0]).toMatchObject({ id: first.id });
    expect(afterReplacement[0].endedAt).toEqual(expect.any(Number));
    expect(afterReplacement[0].removalRequestedAt).toEqual(expect.any(Number));
    expect(afterReplacement[1]).toMatchObject({
      endedAt: null,
      ip: '203.0.113.11',
    });
    // The unused join token for the abandoned attempt is gone; the new one exists.
    expect(
      cluster.secrets.map(
        (secret) => secret.metadata?.labels?.['anycloud.sh/attempt'],
      ),
    ).toEqual([String(afterReplacement[1].id)]);

    // Provider-side loss of the live VM is observed and the row ends.
    cluster.registerNode(afterReplacement[1].id);
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
    });
    cloud.live.delete(afterReplacement[1].cloudId);
    cluster.nodes.splice(0, cluster.nodes.length);
    await control.reconcile(nodePoolId);
    const afterLoss = await vms();
    expect(afterLoss.filter((vm) => vm.endedAt === null)).toHaveLength(1);
    expect(
      afterLoss.find((vm) => vm.id === afterReplacement[1].id)?.endedAt,
    ).toEqual(expect.any(Number));
    // Each finalized VM has its leftover networking deleted: the replaced
    // one and the one lost at the provider.
    expect(cloud.terminateResourceVMLeftovers.mock.calls).toEqual([
      [first.cloudId],
      [afterReplacement[1].cloudId],
    ]);
  });

  it('replaces a VM claimed for removal with no Node, keeping the desired count', async () => {
    const control = controller();
    await control.reconcile(nodePoolId);
    const [first] = await vms();
    cluster.registerNode(first.id);
    await control.reconcile(nodePoolId);
    // A restored API adopted a new cluster: the old VM is claimed, its Node gone.
    await getDB().query(
      'UPDATE vms SET removal_requested_at = ? WHERE id = ?',
      [clock.now, first.id],
    );
    cluster.nodes.splice(0, cluster.nodes.length);
    await control.reconcile(nodePoolId);
    expect(cloud.terminateVM).toHaveBeenCalledWith(first.cloudId);
    const after = await vms();
    expect(after.filter((vm) => vm.endedAt === null)).toHaveLength(1);
    expect(after.find((vm) => vm.id === first.id)?.endedAt).toEqual(
      expect.any(Number),
    );
  });

  it('deletes the leftover networking of a VM claimed for removal that vanished at the provider', async () => {
    const control = controller();
    await control.reconcile(nodePoolId);
    const [first] = await vms();
    cluster.registerNode(first.id);
    await control.reconcile(nodePoolId);
    await getDB().query(
      'UPDATE vms SET removal_requested_at = ? WHERE id = ?',
      [clock.now, first.id],
    );
    // Evicted before the claimed removal ran: nothing for terminateVM to do.
    cloud.live.delete(first.cloudId);
    cluster.nodes.splice(0, cluster.nodes.length);
    cloud.terminateResourceVMLeftovers.mockClear();

    await control.reconcile(nodePoolId);

    expect(cloud.terminateResourceVMLeftovers).toHaveBeenCalledWith(
      first.cloudId,
    );
    expect((await vms()).find((vm) => vm.id === first.id)?.endedAt).toEqual(
      expect.any(Number),
    );
  });

  it('records a rejected terminate as the deleting pool’s last error in one pass', async () => {
    const control = controller();
    await control.reconcile(nodePoolId);
    const [attempt] = await vms();
    await getPersistence().nodePools.requestDeletion(nodePoolId, {
      kind: 'api',
    });
    cloud.terminateVM.mockRejectedValue(
      new Error('UnauthorizedOperation: not authorized to terminate'),
    );

    await control.reconcile(nodePoolId);

    await expect(vms()).resolves.toMatchObject([
      { id: attempt.id, endedAt: null, removalRequestedAt: expect.any(Number) },
    ]);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Deleting,
      lastError: `VM ${attempt.cloudId} termination not confirmed: UnauthorizedOperation: not authorized to terminate; retrying`,
    });
  });

  it('records a failed leftover-network delete during pool deletion and still terminates the other VMs', async () => {
    await getDB().query(
      'UPDATE node_pools SET min_vm_count = 2, max_vm_count = 2 WHERE id = ?',
      [nodePoolId],
    );
    const control = controller();
    await control.reconcile(nodePoolId);
    const [evicted, other] = await vms();
    cloud.live.delete(evicted!.cloudId);
    cloud.terminateResourceVMLeftovers.mockImplementation(async (cloudId) => {
      if (cloudId === evicted!.cloudId)
        throw new Error('ScopeLocked: the public IP is locked');
    });
    await getPersistence().nodePools.requestDeletion(nodePoolId, {
      kind: 'api',
    });
    const recorded = vi.spyOn(
      getPersistence().nodePools,
      'recordDeletionError',
    );

    await control.reconcile(nodePoolId);

    expect(recorded).toHaveBeenCalledWith(
      nodePoolId,
      expect.stringContaining('ScopeLocked'),
    );
    expect(cloud.terminateVM).toHaveBeenCalledWith(other!.cloudId);
    // The pool's scope sweep owns the leftover public IP.
    expect(cloud.terminateResourceNetwork).toHaveBeenCalled();
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Deleted,
    });
  });

  it('keeps a pool Deleting when its scope sweep fails after the leftover-network delete was recorded', async () => {
    const control = controller();
    await control.reconcile(nodePoolId);
    const [evicted] = await vms();
    cloud.live.delete(evicted!.cloudId);
    cloud.terminateResourceVMLeftovers.mockRejectedValue(
      new Error('ScopeLocked: the public IP is locked'),
    );
    cloud.terminateResourceNetwork.mockRejectedValue(
      new Error('ScopeLocked: the public IP is locked'),
    );
    await getPersistence().nodePools.requestDeletion(nodePoolId, {
      kind: 'api',
    });

    await expect(control.reconcile(nodePoolId)).rejects.toThrow('ScopeLocked');

    expect(cloud.terminateResourceNetwork).toHaveBeenCalled();
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Deleting,
    });
  });

  it('keeps a vanished VM open while its leftover-network delete fails outside pool deletion', async () => {
    const control = controller();
    await control.reconcile(nodePoolId);
    const [evicted] = await vms();
    cloud.live.delete(evicted!.cloudId);
    cloud.terminateResourceVMLeftovers.mockRejectedValue(
      new Error('ScopeLocked: the public IP is locked'),
    );

    await expect(control.reconcile(nodePoolId)).rejects.toThrow('ScopeLocked');

    expect((await vms()).find((vm) => vm.id === evicted!.id)?.endedAt).toBe(
      null,
    );
    // Once the delete succeeds, the next pass ends the row.
    cloud.terminateResourceVMLeftovers.mockResolvedValue(undefined);
    await control.reconcile(nodePoolId);
    expect((await vms()).find((vm) => vm.id === evicted!.id)?.endedAt).toEqual(
      expect.any(Number),
    );
  });

  it('keeps a rejected replacement terminate as the ready pool’s last error until the release confirms', async () => {
    const control = controller();
    await control.reconcile(nodePoolId);
    const [first] = await vms();
    const terminate = cloud.terminateVM.getMockImplementation()!;
    cloud.terminateVM.mockRejectedValue(
      new Error('UnauthorizedOperation: not authorized to terminate'),
    );

    // The Node never joined, so the controller releases the VM.
    clock.now += 11 * 60_000;
    await control.reconcile(nodePoolId);
    const failure = `VM ${first.cloudId} termination not confirmed: UnauthorizedOperation: not authorized to terminate; retrying`;
    await expect(nodePool()).resolves.toMatchObject({ lastError: failure });

    // The replacement joins, so the pool turns ready; the old VM still bills.
    const replacement = (await vms()).find((vm) => vm.id !== first.id)!;
    cluster.registerNode(replacement.id);
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
      lastError: failure,
    });

    cloud.terminateVM.mockImplementation(terminate);
    await control.reconcile(nodePoolId);
    expect((await vms()).find((vm) => vm.id === first.id)?.endedAt).toEqual(
      expect.any(Number),
    );
    await expect(nodePool()).resolves.toMatchObject({ lastError: null });
  });

  it('clears an unrelated last error when the pool turns ready while a replaced VM is still shutting down', async () => {
    const control = controller();
    await control.reconcile(nodePoolId);
    const [first] = await vms();
    // The terminate is accepted but the VM stays present: no release error.
    cloud.terminateVM.mockResolvedValue(undefined);
    clock.now += 11 * 60_000;
    await control.reconcile(nodePoolId);
    await getPersistence().nodePools.recordError(nodePoolId, 'capacity error');

    const replacement = (await vms()).find((vm) => vm.id !== first.id)!;
    cluster.registerNode(replacement.id);
    await control.reconcile(nodePoolId);

    expect((await vms()).find((vm) => vm.id === first.id)?.endedAt).toBeNull();
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
      lastError: null,
    });
  });

  it('deletes only its own VMs, Nodes, tokens, namespace and network, and holds the row open on an uncertain release', async () => {
    const control = controller();
    await control.reconcile(nodePoolId);
    const [attempt] = await vms();
    cluster.registerNode(attempt.id);
    await control.reconcile(nodePoolId);
    for (const id of [nodePoolId, 'node-pool-sibling']) {
      cluster.namespaces.set(nodePoolNamespace(id), {
        metadata: {
          name: nodePoolNamespace(id),
          uid: `ns-${id}`,
          labels: {
            'app.kubernetes.io/managed-by': 'anycloud',
            'anycloud.sh/cluster': clusterId,
            'anycloud.sh/node-pool': id,
          },
        },
      });
    }
    await getPersistence().nodePools.requestDeletion(nodePoolId, {
      kind: 'api',
    });

    cloud.flags.releaseUnknown = true;
    await control.reconcile(nodePoolId);
    expect(cluster.cordoned).toEqual([
      nodePoolNodeName(nodePoolId, attempt.id),
    ]);
    expect(cloud.terminateVM).toHaveBeenCalledWith(attempt.cloudId);
    await expect(vms()).resolves.toMatchObject([
      { id: attempt.id, endedAt: null, removalRequestedAt: expect.any(Number) },
    ]);
    // The failed provider read, not a generic timeout, is the last error.
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Deleting,
      lastError: `VM ${attempt.cloudId} termination not confirmed: provider observation timed out; retrying`,
    });
    expect(cloud.terminateResourceNetwork).not.toHaveBeenCalled();
    expect(cluster.deletedNodes).toEqual([]);

    cloud.flags.releaseUnknown = false;
    // A Deployment record that appeared since the deletion request keeps the
    // namespace (and the record) alive; the node pool waits in `deleting`.
    liveReferences = 1;
    await control.reconcile(nodePoolId);
    await expect(vms()).resolves.toMatchObject([
      { id: attempt.id, endedAt: expect.any(Number) },
    ]);
    expect(cluster.deletedNodes).toEqual([
      nodePoolNodeName(nodePoolId, attempt.id),
    ]);
    expect(cluster.secrets).toHaveLength(0);
    expect(cluster.deletedNamespaces).toEqual([]);
    expect(cloud.terminateResourceNetwork).not.toHaveBeenCalled();
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Deleting,
      lastError: expect.stringContaining(
        '1 Deployment or Service record(s) still reference it; the namespace is kept',
      ),
    });

    liveReferences = 0;
    // The pool's own ingress release goes with it; a foreign HelmChart stays.
    cluster.objects.seed(buildPoolIngressHelmChart(clusterId, nodePoolId));
    cluster.objects.seed({
      ...buildPoolIngressHelmChart(clusterId, 'node-pool-sibling'),
      metadata: {
        ...buildPoolIngressHelmChart(clusterId, 'node-pool-sibling').metadata,
        labels: { 'anycloud.sh/addon': 'someone-else' },
      },
    });
    await control.reconcile(nodePoolId);
    expect(
      cluster.objects.objects.has(
        `HelmChart/kube-system/${poolIngressReleaseName(nodePoolId)}`,
      ),
    ).toBe(false);
    expect(
      cluster.objects.objects.has(
        `HelmChart/kube-system/${poolIngressReleaseName('node-pool-sibling')}`,
      ),
    ).toBe(true);
    // The node pool's own namespace goes with it; a sibling's stays.
    expect(cluster.deletedNamespaces).toEqual([nodePoolNamespace(nodePoolId)]);
    expect(cluster.namespaces.has(nodePoolNamespace('node-pool-sibling'))).toBe(
      true,
    );
    expect(cloud.terminateResourceNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ id: nodePoolId }),
    );
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Deleted,
    });
    await expect(
      getPersistence().clusterRecords.getForScope(clusterId, { kind: 'api' }),
    ).resolves.toMatchObject({ state: ClusterState.Ready });
  });

  it('completes deletion even when the cluster connection is gone, recording the diagnostic', async () => {
    const control = controller();
    await control.reconcile(nodePoolId);
    await getPersistence().nodePools.requestDeletion(nodePoolId, {
      kind: 'api',
    });
    cluster.resolve.mockRejectedValue(new Error('cluster unreachable'));

    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Deleted,
    });
    expect(cloud.terminateResourceNetwork).toHaveBeenCalledTimes(1);
  });

  async function seedGpuNodePool(): Promise<void> {
    resetPersistence();
    cloud = createFakeCloud(() => clock.now, 'g6.xlarge');
    cluster = createFakeCluster();
    await seed('g6.xlarge');
  }

  const DAEMON_SET_KEY = 'DaemonSet/kube-system/anycloud-nvidia-device-plugin';

  it("boots each VM with the pool's OS disk and spot mode, or without them 100 GB on-demand on an NVIDIA pool and at least the reserved disk on a CPU pool", async () => {
    const launchConfig = async (osDisk?: string, gpu = true) => {
      if (gpu) await seedGpuNodePool();
      if (osDisk) {
        await getDB().query(`UPDATE node_pools SET ${osDisk} WHERE id = ?`, [
          nodePoolId,
        ]);
      }
      const launches: CloudConfig[] = [];
      await createNodePoolController({
        ...controllerDeps(),
        createCompute: (config, purpose) => {
          if (purpose === 'provisioning') launches.push(config);
          return cloud.compute;
        },
      }).reconcile(nodePoolId);
      return launches.at(-1);
    };

    const fallback = await launchConfig();
    expect(fallback).toMatchObject({ diskSizeGb: 100, spot: false });
    expect(fallback?.diskTier).toBeUndefined();
    expect(
      await launchConfig(
        "os_disk_size_gb = 500, os_disk_tier = 'ultra', spot = 1",
      ),
    ).toMatchObject({ diskSizeGb: 500, diskTier: DiskTier.Ultra, spot: true });
    // A spot pool's VM is priced, and so spend-capped, at the spot rate.
    const [vm] = await getPersistence().nodePoolVms.listVms(nodePoolId);
    const price = (spot: boolean) =>
      resolveWorkloadPrice(CloudType.AWS, vm!.vmType, vm!.region, spot);
    expect(vm!.pricePerHour).toBe(price(true));
    expect(price(true)).toBeLessThan(price(false)!);
    // A CPU pool with no size gets at least the disk its Node reserves.
    resetPersistence();
    cloud = createFakeCloud(() => clock.now);
    await seed();
    const cpu = await launchConfig(undefined, false);
    expect(cpu).toMatchObject({ minimumDiskSizeGb: 25 });
    expect(cpu?.diskSizeGb).toBeUndefined();
  });

  it('installs the cluster-scoped NVIDIA add-on before buying GPU VMs, labels their Nodes for it and becomes ready once devices register', async () => {
    await seedGpuNodePool();
    const control = controller();
    await control.reconcile(nodePoolId);

    // RuntimeClass and DaemonSet exist before the provider is asked for a VM.
    const firstCreate = cluster.objects.calls.findIndex(
      (call) => call.verb === 'create',
    );
    expect(firstCreate).toBeGreaterThanOrEqual(0);
    expect(cluster.objects.objects.has('RuntimeClass//nvidia')).toBe(true);
    expect(cluster.objects.objects.has(DAEMON_SET_KEY)).toBe(true);
    expect(cloud.newResourceVM).toHaveBeenCalledTimes(1);
    const request = cloud.newResourceVM.mock.calls[0][0];
    expect(request.startupScript).toContain('"anycloud.sh/accelerator=nvidia"');
    expect(request.gpuRuntime).toBe('cuda');

    // The DaemonSet selects exactly the Node this VM registers.
    const [attempt] = await vms();
    cluster.registerNode(attempt.id, { gpus: '0', accelerator: 'nvidia' });
    const selector =
      buildClusterNvidiaDevicePlugin(clusterId).spec!.template.spec!
        .nodeSelector!;
    expect(
      Object.entries(selector).every(
        ([key, value]) => cluster.nodes[0].metadata?.labels?.[key] === value,
      ),
    ).toBe(true);

    cluster.objects.calls.length = 0;
    await control.reconcile(nodePoolId);
    // Converged add-ons are read, never rewritten, on later passes: the
    // Node status policy first, then every add-on before launch.
    expect(cluster.objects.calls.map((call) => call.verb)).toEqual(
      Array(6).fill('read'),
    );
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Creating,
    });
    await expect(control.observeCapacity(nodePoolId)).resolves.toMatchObject({
      readyVmCount: 0,
      startingVmCount: 1,
    });

    clock.now += 11 * 60_000;
    await expect(control.reconcile(nodePoolId)).rejects.toThrow(
      /NVIDIA GPU registration incomplete/,
    );
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Failed,
      lastError: expect.stringMatching(
        /cluster-scoped NVIDIA add-on has not registered these devices \(RuntimeClass nvidia unchanged, DaemonSet kube-system\/anycloud-nvidia-device-plugin unchanged\)/,
      ),
    });

    cluster.nodes[0].status!.allocatable = { 'nvidia.com/gpu': '1' };
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
      lastError: null,
    });
    await expect(control.observeCapacity(nodePoolId)).resolves.toMatchObject({
      readyVmCount: 1,
      startingVmCount: 0,
    });
  });

  it('fails closed when a Node advertises a device count that disagrees with the catalog', async () => {
    await seedGpuNodePool();
    const control = controller();
    await control.reconcile(nodePoolId);
    const [attempt] = await vms();
    cluster.registerNode(attempt.id, { gpus: '2', accelerator: 'nvidia' });

    await expect(control.reconcile(nodePoolId)).rejects.toMatchObject({
      name: 'NodePoolGpuCapacityMismatchError',
    });
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Failed,
      lastError: expect.stringContaining(
        `the catalog attributes 1 nvidia.com/gpu to g6.xlarge but Node ${nodePoolNodeName(nodePoolId, attempt.id)} advertises 2`,
      ),
    });
    // Mismatched capacity is never counted as ready, nor replaced.
    await expect(control.observeCapacity(nodePoolId)).resolves.toEqual({
      readyVmCount: 0,
      startingVmCount: 1,
      drainingVmCount: 0,
      locations: [
        {
          region: 'us-east-1',
          zone: 'us-east-1a',
          vmType: 'g6.xlarge',
          releasing: null,
        },
      ],
    });
    clock.now += 20 * 60_000;
    await expect(control.reconcile(nodePoolId)).rejects.toThrow(
      /device count mismatch/,
    );
    expect(cloud.terminateVM).not.toHaveBeenCalled();
    expect(cloud.newResourceVM).toHaveBeenCalledTimes(1);

    cluster.nodes[0].status!.allocatable = { 'nvidia.com/gpu': '1' };
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
      lastError: null,
    });
  });

  it('marks a GPU node pool failed without buying VMs when the cluster add-on cannot be owned', async () => {
    await seedGpuNodePool();
    cluster.objects.seed({
      apiVersion: 'node.k8s.io/v1',
      kind: 'RuntimeClass',
      metadata: {
        name: 'nvidia',
        labels: { 'anycloud.sh/cluster': 'cluster-b' },
      },
      handler: 'nvidia',
    });
    const control = controller();
    await expect(control.reconcile(nodePoolId)).rejects.toMatchObject({
      name: 'ClusterAddonOwnershipError',
    });
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Failed,
      lastError: expect.stringContaining(
        'RuntimeClass nvidia exists but is not owned by the nvidia add-on',
      ),
    });
    expect(cloud.newResourceVM).not.toHaveBeenCalled();
    expect(cluster.objects.objects.has(DAEMON_SET_KEY)).toBe(false);
  });

  it('still releases bought GPU VMs when the add-on can no longer be owned, and buys none until it can', async () => {
    await seedGpuNodePool();
    const control = controller();
    await control.reconcile(nodePoolId);
    const [attempt] = await vms();
    cluster.registerNode(attempt.id, { gpus: '1', accelerator: 'nvidia' });
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
    });

    // An operator relabels our DaemonSet and the provider loses the VM in
    // the same window: the row still ends, then the add-on failure surfaces.
    cluster.objects.drift(DAEMON_SET_KEY, (object) => {
      object.metadata!.labels!['anycloud.sh/cluster'] = 'someone-else';
    });
    cloud.live.delete(attempt.cloudId);
    cluster.nodes.splice(0, cluster.nodes.length);
    await expect(control.reconcile(nodePoolId)).rejects.toMatchObject({
      name: 'ClusterAddonOwnershipError',
    });
    const rows = await vms();
    expect(rows.find((vm) => vm.id === attempt.id)?.endedAt).toEqual(
      expect.any(Number),
    );
    expect(rows.filter((vm) => vm.endedAt === null)).toHaveLength(0);
    expect(cloud.newResourceVM).toHaveBeenCalledTimes(1);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Failed,
      lastError: expect.stringContaining(
        'DaemonSet anycloud-nvidia-device-plugin exists but is not owned',
      ),
    });

    // Once the foreign object is gone the node pool installs and provisions.
    cluster.objects.objects.delete(DAEMON_SET_KEY);
    await control.reconcile(nodePoolId);
    expect(cloud.newResourceVM).toHaveBeenCalledTimes(2);
    expect(cluster.objects.objects.has(DAEMON_SET_KEY)).toBe(true);
  });

  it('makes a pool member, by its protected label, only a Node it matched to a live attempt', async () => {
    const control = controller();
    await control.reconcile(nodePoolId);
    const [attempt] = await vms();
    const name = nodePoolNodeName(nodePoolId, attempt.id);
    // The join registers only the labels a kubelet may set on itself.
    cluster.registerNode(attempt.id);
    expect(cluster.nodes[0].metadata?.labels).not.toHaveProperty(
      NODE_POOL_MEMBER_LABEL,
    );
    // In the same pass, a Node registers itself into the pool under another
    // name, with every label and the taint a member joins with.
    cluster.registerNode(attempt.id);
    cluster.nodes[1].metadata!.name = 'anycloud-rooted-node';
    const core = cluster.runtime.cluster.core;
    const patchNode = core.patchNode.bind(core);
    const tokensAtPatch: number[] = [];
    core.patchNode = (async (...args: Parameters<typeof patchNode>) => {
      tokensAtPatch.push(cluster.secrets.length);
      return patchNode(...args);
    }) as typeof patchNode;
    expect(cluster.secrets).toHaveLength(1);

    // The pass fails closed on the impostor, but only after its own Node
    // lost its join token and became a member.
    await expect(control.reconcile(nodePoolId)).rejects.toThrow(
      /anycloud-rooted-node claim this node pool/,
    );
    expect(tokensAtPatch).toEqual([0]);
    expect(cluster.nodePatches).toEqual([
      {
        metadata: {
          name,
          uid: `node-${attempt.id}`,
          labels: { [NODE_POOL_MEMBER_LABEL]: nodePoolId },
        },
      },
    ]);
    expect(cluster.nodes[1].metadata?.labels).not.toHaveProperty(
      NODE_POOL_MEMBER_LABEL,
    );
    // Every pool Pod selects exactly the labels the controller set.
    const { nodeSelector } = nodePoolPodScheduling(clusterId, nodePoolId);
    expect(cluster.nodes[0].metadata?.labels).toMatchObject(nodeSelector);

    // Labelled once; later passes leave the Node alone.
    cluster.nodes.splice(1, 1);
    await control.reconcile(nodePoolId);
    expect(cluster.nodePatches).toHaveLength(1);
  });

  it('RFC 0049 C32 joins a user-namespace pool with its handler, guards the class, and labels its Nodes in the membership patch', async () => {
    await getDB().query(
      'UPDATE node_pools SET user_namespace_jobs = 1 WHERE id = ?',
      [nodePoolId],
    );
    const control = controller();
    await control.reconcile(nodePoolId);
    const [{ startupScript }] = cloud.newResourceVM.mock.calls[0]!;
    expect(startupScript).toContain('60-anycloud-userns.toml');
    expect(startupScript).not.toContain('99-anycloud-kvm.rules');
    expect([...cluster.objects.objects.keys()]).toEqual(
      expect.arrayContaining([
        'ValidatingAdmissionPolicy//anycloud-user-namespace',
        'ValidatingAdmissionPolicyBinding//anycloud-user-namespace',
        'RuntimeClass//anycloud-user-namespace',
      ]),
    );
    const [attempt] = await vms();
    cluster.registerNode(attempt.id);
    await control.reconcile(nodePoolId);
    expect(cluster.nodePatches.map((patch) => patch.metadata?.labels)).toEqual([
      {
        [NODE_POOL_MEMBER_LABEL]: nodePoolId,
        'node-restriction.kubernetes.io/anycloud-user-namespace': 'true',
      },
    ]);
    // The cluster's last user-namespace pool takes the add-on with it.
    await getPersistence().nodePools.requestDeletion(nodePoolId, {
      kind: 'api',
    });
    for (let pass = 0; pass < 3; pass++) await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Deleted,
    });
    expect(
      [...cluster.objects.objects.keys()].filter((key) =>
        key.endsWith('/anycloud-user-namespace'),
      ),
    ).toEqual([]);
  });

  it('gives a ready GPU Node whose devices vanish the registration grace instead of failing at once', async () => {
    await seedGpuNodePool();
    const control = controller();
    await control.reconcile(nodePoolId);
    const [attempt] = await vms();
    cluster.registerNode(attempt.id, { gpus: '1', accelerator: 'nvidia' });
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
    });

    // The device plugin restarts: the kubelet reports 0 allocatable until it
    // re-registers. The node pool stays ready while capacity shows starting.
    clock.now += 60 * 60_000;
    cluster.nodes[0].status!.allocatable = { 'nvidia.com/gpu': '0' };
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
      lastError: null,
    });
    await expect(control.observeCapacity(nodePoolId)).resolves.toMatchObject({
      readyVmCount: 0,
      startingVmCount: 1,
    });
    clock.now += 9 * 60_000;
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
    });

    // Recovery inside the grace clears the clock; a later drop starts anew.
    cluster.nodes[0].status!.allocatable = { 'nvidia.com/gpu': '1' };
    await control.reconcile(nodePoolId);
    clock.now += 5 * 60_000;
    cluster.nodes[0].status!.allocatable = { 'nvidia.com/gpu': '0' };
    await control.reconcile(nodePoolId);
    clock.now += 9 * 60_000;
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
    });

    // Past the grace the node pool fails with the registration diagnostic.
    clock.now += 2 * 60_000;
    await expect(control.reconcile(nodePoolId)).rejects.toThrow(
      /NVIDIA GPU registration incomplete/,
    );
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Failed,
    });
    expect(cloud.terminateVM).not.toHaveBeenCalled();
    cluster.nodes[0].status!.allocatable = { 'nvidia.com/gpu': '1' };
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
      lastError: null,
    });
  });

  it('adopts add-ons left by a destroyed cluster of the same control plane when it is registered again', async () => {
    await seedGpuNodePool();
    // The previous registration of this control plane installed the stack.
    const previous = createClusterAddonController({ sleep: async () => {} });
    await previous.ensure(
      { ...cluster.runtime, clusterId: 'cluster-previous' },
      { nvidiaGpus: 1 },
    );
    await getDB().query(
      `INSERT INTO clusters (
         id, owner_user_id, name, state, step, kubernetes_identity,
         encrypted_connection, connection_revision, created_at, updated_at
       ) VALUES (?, ?, ?, 'destroyed', 'release', ?, NULL, 2, 1, 2)`,
      ['cluster-previous', 'owner-1', 'production-old', 'uid-cluster'],
    );

    const control = controller();
    await control.reconcile(nodePoolId);
    expect(cloud.newResourceVM).toHaveBeenCalledTimes(1);
    expect(
      cluster.objects.objects.get(DAEMON_SET_KEY)?.metadata?.labels?.[
        'anycloud.sh/cluster'
      ],
    ).toBe(clusterId);
    expect(
      cluster.objects.objects.get('RuntimeClass//nvidia')?.metadata?.labels?.[
        'anycloud.sh/cluster'
      ],
    ).toBe(clusterId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Creating,
      lastError: null,
    });
  });

  it.each([
    [
      'a maximum of zero',
      /VM bounds must satisfy min ≤ max and 1 ≤ max/,
      () =>
        getDB().query(
          `UPDATE node_pools SET min_vm_count = 0, max_vm_count = 0 WHERE id = ?`,
          [nodePoolId],
        ),
    ],
    [
      'unknown catalog capacity',
      /cannot verify CPU or NVIDIA GPU capacity/,
      async () => {
        resetPersistence();
        await seed('mystery.1');
      },
    ],
    [
      'missing cluster permissions',
      /lacks permissions/,
      async () => {
        cluster.resolve.mockRejectedValueOnce(
          new ClusterPermissionError(clusterId, ['create nodes']),
        );
      },
    ],
    [
      'a denied add-on write',
      /registered identity may not create/,
      async () => {
        await seedGpuNodePool();
        // Denied on every pass: the first ensure only logs it.
        vi.mocked(cluster.objects.api.create).mockRejectedValue(
          Object.assign(new Error('forbidden'), { code: 403 }),
        );
      },
    ],
  ])('marks the node pool failed on %s', async (_, message, arrange) => {
    await arrange();
    await expect(controller().reconcile(nodePoolId)).rejects.toThrow(message);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Failed,
      lastError: expect.stringMatching(message),
    });
  });

  it('records a missing permission without failing the pool while the chart repair is pending', async () => {
    cluster.resolve.mockRejectedValueOnce(
      new ClusterPermissionError(clusterId, ['get pods/log']),
    );
    holdPermissionFailures(true);
    try {
      await expect(controller().reconcile(nodePoolId)).rejects.toThrow(
        /lacks permissions/,
      );
    } finally {
      holdPermissionFailures(false);
    }
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Creating,
      lastError: expect.stringMatching(/lacks permissions/),
    });
  });

  it('classifies a network preparation failure on its attempt and names the region', async () => {
    cloud.prepareResourceNetwork.mockRejectedValueOnce(
      providerError(
        'VpcLimitExceeded',
        CloudFailureDiagnosis.QuotaExhaustedAccount,
      ),
    );
    await expect(controller().reconcile(nodePoolId)).rejects.toThrow(
      /in us-east-1\/us-east-1a failed \(quota-exhausted-account\); next launch in 60 s: VpcLimitExceeded/,
    );
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Creating,
      provisioningFailures: 1,
    });
    await expect(launchFailures()).resolves.toMatchObject([
      {
        region: 'us-east-1',
        diagnosis: CloudFailureDiagnosis.QuotaExhaustedAccount,
      },
    ]);
  });

  it('installs only the Node status policy for CPU node pools, before any VM', async () => {
    const control = controller();
    const launch = cloud.newResourceVM.getMockImplementation()!;
    let atLaunch: string[] = [];
    cloud.newResourceVM.mockImplementation(async (params) => {
      atLaunch = [...cluster.objects.objects.keys()];
      return launch(params);
    });
    await control.reconcile(nodePoolId);
    // In place before the first Node's flannel writes.
    expect(atLaunch).toEqual([
      `ValidatingAdmissionPolicy//${NODE_STATUS_POLICY_NAME}`,
      `ValidatingAdmissionPolicyBinding//${NODE_STATUS_POLICY_NAME}`,
    ]);
    const [attempt] = await vms();
    cluster.registerNode(attempt.id);
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
    });
    expect(cluster.objects.objects.size).toBe(2);
    expect(cloud.newResourceVM.mock.calls[0][0].startupScript).not.toContain(
      'anycloud.sh/accelerator',
    );
  });

  it('refuses to provision against a cluster outside the agent version-skew window', async () => {
    cluster.runtime.serverVersion = {
      major: 1,
      minor: 31,
      gitVersion: 'v1.31.2+k3s1',
    };
    const control = controller();
    await expect(control.reconcile(nodePoolId)).rejects.toThrow(
      /needs a cluster between v1.35 and v1.38/,
    );
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Failed,
      lastError: expect.stringContaining('v1.31.2+k3s1'),
    });
    expect(cloud.newResourceVM).not.toHaveBeenCalled();
    await expect(vms()).resolves.toEqual([]);
    await expect(control.assertClusterCompatible(clusterId)).rejects.toThrow(
      /v1.31.2\+k3s1/,
    );

    cluster.runtime.serverVersion = {
      major: 1,
      minor: 39,
      gitVersion: 'v1.39.0+k3s1',
    };
    await expect(control.assertClusterCompatible(clusterId)).rejects.toThrow(
      /needs a cluster between/,
    );
    cluster.runtime.serverVersion = {
      major: 1,
      minor: 38,
      gitVersion: 'v1.38.0+k3s1',
    };
    await expect(
      control.assertClusterCompatible(clusterId),
    ).resolves.toBeUndefined();
  });

  it('backs off after each failed pass with one outstanding join token and never fails on capacity', async () => {
    const control = controller();
    cloud.newResourceVM.mockRejectedValue(
      providerError(
        'InsufficientInstanceCapacity',
        CloudFailureDiagnosis.CapacityExhausted,
      ),
    );

    // A pinned AWS pool has one candidate, so every failure ends a pass.
    const schedule = [60, 120, 240, 480, 960, 1800, 1800];
    for (const [index, seconds] of schedule.entries()) {
      await expect(control.reconcile(nodePoolId)).rejects.toThrow(
        `in us-east-1/us-east-1a failed (capacity-exhausted); next launch in ${seconds} s: InsufficientInstanceCapacity`,
      );
      expect(cluster.secrets).toHaveLength(1);
      // Inside the window the failed attempt is released and nothing launches.
      clock.now += seconds * 1000 - 1;
      await control.reconcile(nodePoolId);
      expect(cloud.newResourceVM).toHaveBeenCalledTimes(index + 1);
      expect(cluster.secrets).toHaveLength(0);
      clock.now += 2;
    }
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Creating,
      provisioningFailures: schedule.length,
      lastError: expect.stringContaining('capacity-exhausted'),
    });
    expect((await nodePool())!.lastError).not.toContain('K10');
    expect((await vms()).every((vm) => vm.endedAt !== null)).toBe(true);

    cloud.newResourceVM.mockReset();
    cloud.newResourceVM.mockResolvedValue({
      cloudId: 'provider-recovered',
      ip: '203.0.113.50',
      createdAt: clock.now,
    });
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Creating,
      provisioningFailures: 0,
      lastError: null,
    });
  });

  /**
   * A second pool on a cluster in `clusterRegion`, with one fake cloud per
   * region the pool's compute asks for.
   */
  async function regionalPool(
    pool: {
      region?: string | null;
      zone?: string | null;
      vmTypes?: string[];
      cloud?: CloudType.AWS | CloudType.GCP;
      candidateRegionFilter?: CandidateRegionFilter;
      vmCount?: number;
      clusterRegion?: string | null;
      spot?: boolean;
      requireNestedVirtualization?: boolean;
    } = {},
  ) {
    const cloud = pool.cloud ?? CloudType.AWS;
    const vmTypes = pool.vmTypes ?? ['t3.large'];
    const [vmType] = vmTypes as [string];
    // The only active cluster, recorded again with a region (immutable).
    const [record] = await getDB().query<Record<string, unknown>>(
      'SELECT * FROM clusters WHERE id = ?',
      [clusterId],
    );
    await getDB().query('DELETE FROM node_pools');
    await getDB().query('DELETE FROM clusters');
    const columns = Object.keys(record!);
    await getDB().query(
      `INSERT INTO clusters (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      // An installer's cluster, on AWS, as a cluster with a region is.
      columns.map((column) =>
        column === 'region'
          ? (pool.clusterRegion ?? null)
          : column === 'compute_credential_id' && pool.clusterRegion
            ? credentialId
            : record![column],
      ),
    );
    let poolCredential = credentialId;
    if (cloud !== CloudType.AWS) {
      poolCredential = 'compute-gcp';
      await getDB().query(
        `INSERT INTO credentials (id, encrypted_data, cloud_provider) VALUES (?, ?, ?)`,
        [poolCredential, await encryptCredential(gcpCredentials), cloud],
      );
    }
    await getPersistence().nodePools.create({
      id: 'pool-r',
      clusterId,
      ownerUserId: 'owner-1',
      name: 'regional',
      computeCredentialId: poolCredential,
      region: pool.region ?? null,
      zone: pool.zone ?? null,
      vmTypes,
      minVmCount: pool.vmCount ?? 1,
      maxVmCount: pool.vmCount ?? 1,
      spot: pool.spot,
      requireNestedVirtualization: pool.requireNestedVirtualization,
    });
    const regional = new Map<string, FakeCloud>();
    const cloudIn = (region: string, type = vmType) => {
      const key = `${type} ${region}`;
      if (!regional.has(key)) {
        regional.set(
          key,
          createFakeCloud(
            () => clock.now,
            type,
            region,
            cloud,
            pool.candidateRegionFilter,
          ),
        );
      }
      return regional.get(key)!;
    };
    const zones: string[] = [];
    const launchConfigs: CloudConfig[] = [];
    const control = createNodePoolController({
      ...controllerDeps(),
      createCompute: (config, purpose) => {
        if (purpose === 'provisioning') launchConfigs.push(config);
        if (purpose === 'provisioning' && config.availabilityZone) {
          zones.push(config.availabilityZone);
        }
        return cloudIn(config.region!, config.vmType as string).compute;
      },
    });
    const rows = async () =>
      (await getPersistence().nodePoolVms.listVms('pool-r')).sort(
        (left, right) => left.id - right.id,
      );
    /** An attempt row in `region`, completed when `ip` is given. */
    const attemptIn = async (region: string, cloudId: string, ip?: string) => {
      const ref = await getPersistence().nodePoolVms.beginVmAttempt('pool-r', {
        cloudId,
        vmType,
        region,
        availabilityZone: null,
        desiredVmCount: pool.vmCount ?? 1,
      });
      if (ip) {
        await getPersistence().nodePoolVms.completeVmAttempt('pool-r', ref!, {
          cloudId: `provider-${cloudId}`,
          ip,
          createdAt: clock.now,
        });
        cloudIn(region).live.add(`provider-${cloudId}`);
      }
      return ref!;
    };
    return { control, cloudIn, rows, zones, attemptIn, launchConfigs };
  }

  it('C10: launches an unpinned nested-virtualization pool only where the catalog reports support', async () => {
    const vmTypes = ['t3.large', 'm7i.large'];
    const where = (type: string, support: boolean | null) =>
      getRegionsForVMType(type, CloudType.AWS).filter(
        (region) =>
          nestedVirtualizationSupport(CloudType.AWS, type, region) === support,
      );
    // The premise, from catalog data: t3.large is supported nowhere, and
    // m7i.large is supported in some regions and unknown in others.
    expect(where('t3.large', true)).toEqual([]);
    const supported = where('m7i.large', true);
    expect(supported.length).toBeGreaterThan(0);
    expect(where('m7i.large', null).length).toBeGreaterThan(0);
    const [clusterRegion] = getRegionsForVMType('t3.large', CloudType.AWS);
    const { control, cloudIn, rows, launchConfigs } = await regionalPool({
      clusterRegion,
      vmTypes,
      requireNestedVirtualization: true,
    });
    const capacity = providerError(
      'InsufficientInstanceCapacity',
      CloudFailureDiagnosis.CapacityExhausted,
    );
    for (const type of vmTypes) {
      for (const region of getRegionsForVMType(type, CloudType.AWS)) {
        cloudIn(region, type).newResourceVM.mockRejectedValue(capacity);
      }
    }

    // One full pass tries every candidate once, then backs off.
    for (let attempt = 0; attempt <= supported.length; attempt++) {
      await control.reconcile('pool-r').catch(() => undefined);
    }
    const tried = (await rows()).map((row) => `${row.vmType}@${row.region}`);
    expect(new Set(tried)).toEqual(
      new Set(supported.map((region) => `m7i.large@${region}`)),
    );
    expect(tried).toHaveLength(supported.length);
    expect(launchConfigs.length).toBeGreaterThan(0);
    expect(
      launchConfigs.every((config) => config.nestedVirtualization === true),
    ).toBe(true);
  });

  it('C10: launches a pinned GCP nested-virtualization pool in a zone the catalog reports, whose targets name it by suffix', async () => {
    const { control, rows, launchConfigs } = await regionalPool({
      cloud: CloudType.GCP,
      region: 'us-central1',
      vmTypes: ['n2-standard-4'],
      requireNestedVirtualization: true,
    });
    await control.reconcile('pool-r');
    expect((await rows()).map((row) => row.region)).toEqual(['us-central1']);
    expect(launchConfigs.length).toBeGreaterThan(0);
    expect(
      launchConfigs.every((config) => config.nestedVirtualization === true),
    ).toBe(true);
  });

  it('launches an unpinned pool in the cluster region first, moves on after a capacity failure, and tears down every region', async () => {
    const [cheapest, , clusterRegion] = getRegionsForVMType(
      't3.large',
      CloudType.AWS,
    );
    const { control, cloudIn, rows } = await regionalPool({ clusterRegion });
    cloudIn(clusterRegion!).newResourceVM.mockRejectedValue(
      providerError(
        'InsufficientInstanceCapacity',
        CloudFailureDiagnosis.CapacityExhausted,
      ),
    );

    await expect(control.reconcile('pool-r')).rejects.toThrow(
      new RegExp(`in ${clusterRegion} failed \\(capacity-exhausted\\): `),
    );
    // Not a full pass yet, so the next pass launches at once elsewhere.
    await control.reconcile('pool-r');
    await expect(rows()).resolves.toMatchObject([
      { region: clusterRegion, ip: null, endedAt: expect.any(Number) },
      {
        region: cheapest,
        ip: expect.any(String),
        endedAt: null,
        pricePerHour: resolveWorkloadPrice(
          CloudType.AWS,
          't3.large',
          cheapest!,
          false,
        ),
      },
    ]);
    await expect(control.observeCapacity('pool-r')).resolves.toMatchObject({
      locations: [{ region: cheapest }],
    });

    await getPersistence().nodePools.requestDeletion('pool-r', {
      kind: 'api',
    });
    await control.reconcile('pool-r');
    for (const region of [clusterRegion!, cheapest!]) {
      expect(cloudIn(region).terminateResourceNetwork).toHaveBeenCalledOnce();
    }
  });

  it('moves a spot pool past its spot capacity failure to the cheapest spot region', async () => {
    const regions = getRegionsForVMType('t3.large', CloudType.AWS);
    const spotPrice = (region: string) =>
      resolveWorkloadPrice(CloudType.AWS, 't3.large', region, true)!;
    const [clusterRegion, ...others] = regions;
    const { control, cloudIn, rows } = await regionalPool({
      clusterRegion,
      spot: true,
    });
    cloudIn(clusterRegion!).newResourceVM.mockRejectedValue(
      providerError(
        'InsufficientInstanceCapacity',
        CloudFailureDiagnosis.CapacityExhausted,
      ),
    );

    await expect(control.reconcile('pool-r')).rejects.toThrow(
      /failed \(capacity-exhausted\): /,
    );
    await control.reconcile('pool-r');
    const cheapest = others.reduce((a, b) =>
      spotPrice(b) < spotPrice(a) ? b : a,
    );
    // The premise, from catalog data: one cheapest spot region, and on-demand
    // ranking would launch elsewhere, so the test tells the two apart.
    expect(
      others.filter((region) => spotPrice(region) === spotPrice(cheapest)),
    ).toEqual([cheapest]);
    const onDemandNext = buildTargetCandidates(
      CloudType.AWS,
      ['t3.large'],
      false,
      { region: null, availabilityZone: null },
    ).find((candidate) => candidate.region !== clusterRegion)?.region;
    expect(onDemandNext).not.toBe(cheapest);
    expect((await rows()).at(-1)).toMatchObject({
      region: cheapest,
      endedAt: null,
      pricePerHour: spotPrice(cheapest),
    });
  });

  it("skips a spot pool's other types in a region whose spot quota it exhausted", async () => {
    const vmTypes = ['t3.large', 'm5.large'];
    const [clusterRegion] = getRegionsForVMType('t3.large', CloudType.AWS);
    const { control, cloudIn, rows } = await regionalPool({
      clusterRegion,
      vmTypes,
      spot: true,
    });
    for (const type of vmTypes) {
      cloudIn(clusterRegion!, type).newResourceVM.mockRejectedValue(
        providerError(
          'MaxSpotInstanceCountExceeded',
          CloudFailureDiagnosis.AccountRegionalSpotQuotaExhausted,
        ),
      );
    }

    await control.reconcile('pool-r').catch(() => undefined);
    await control.reconcile('pool-r').catch(() => undefined);
    // Both types share the region's spot quota: the second launch leaves it.
    const [first, second] = await rows();
    expect(first).toMatchObject({ region: clusterRegion });
    expect(second?.region).not.toBe(clusterRegion);
  });

  it("tries each of a pool's types in the cluster region, then each type's next region", async () => {
    const vmTypes = ['t3.large', 'm5.large'];
    const [t3, m5] = vmTypes.map((type) =>
      getRegionsForVMType(type, CloudType.AWS, true),
    ) as [string[], string[]];
    // Offered by both types, and not the first choice of each.
    const clusterRegion = t3.find(
      (region) => region !== t3[0] && region !== m5[0] && m5.includes(region),
    );
    const { control, cloudIn, rows } = await regionalPool({
      clusterRegion,
      vmTypes,
      spot: true,
    });
    const capacity = providerError(
      'InsufficientInstanceCapacity',
      CloudFailureDiagnosis.CapacityExhausted,
    );
    for (const region of t3)
      cloudIn(region).newResourceVM.mockRejectedValue(capacity);
    for (const region of m5)
      cloudIn(region, 'm5.large').newResourceVM.mockRejectedValue(capacity);

    for (let attempt = 0; attempt < 4; attempt++) {
      await control.reconcile('pool-r').catch(() => undefined);
    }
    expect((await rows()).map((row) => `${row.vmType}@${row.region}`)).toEqual([
      `t3.large@${clusterRegion}`,
      `m5.large@${clusterRegion}`,
      `t3.large@${t3[0]}`,
      `m5.large@${m5[0]}`,
    ]);
  });

  it('backs an unpinned pool off at once on a retry-same-target failure, and after a full pass on capacity', async () => {
    const regions = getRegionsForVMType('t3.large', CloudType.AWS);
    const { control, cloudIn } = await regionalPool();
    for (const region of regions) {
      cloudIn(region).newResourceVM.mockRejectedValue(
        providerError(
          'VcpuLimitExceeded',
          CloudFailureDiagnosis.TemporaryProviderFailure,
        ),
      );
    }
    await expect(control.reconcile('pool-r')).rejects.toThrow(
      /failed \(temporary-provider-failure\); next launch in 60 s/,
    );
    clock.now += 59_000;
    await control.reconcile('pool-r');
    expect(cloudIn(regions[0]!).newResourceVM).toHaveBeenCalledOnce();

    clock.now += 2_000;
    for (const region of regions) {
      cloudIn(region).newResourceVM.mockRejectedValue(
        providerError(
          'InsufficientInstanceCapacity',
          CloudFailureDiagnosis.CapacityExhausted,
        ),
      );
    }
    // Capacity rotates through every candidate, then the pass backs off.
    for (const [index, region] of regions.entries()) {
      await expect(control.reconcile('pool-r')).rejects.toThrow(
        index === regions.length - 1
          ? /failed \(capacity-exhausted\); next launch in 120 s/
          : new RegExp(`in ${region} failed \\(capacity-exhausted\\): `),
      );
    }
    await control.reconcile('pool-r');
    expect(
      regions.reduce(
        (calls, region) =>
          calls + cloudIn(region).newResourceVM.mock.calls.length,
        0,
      ),
    ).toBe(regions.length + 1);

    // Each backoff wake walks every candidate again before backing off.
    clock.now += 120_000;
    for (const [index, region] of regions.entries()) {
      await expect(control.reconcile('pool-r')).rejects.toThrow(
        index === regions.length - 1
          ? /failed \(capacity-exhausted\); next launch in 240 s/
          : new RegExp(`in ${region} failed \\(capacity-exhausted\\): `),
      );
    }
  });

  /**
   * A live capacity signal that verifies `verified` and rules out
   * `unavailable`; `runs` counts its preflights (the cache never hits).
   */
  function capacitySignal(
    verified: readonly string[],
    unavailable: readonly string[] = [],
  ) {
    const runs = vi.fn(async () => true);
    const filter = createCandidateRegionFilter({
      cache: new CandidatePreflightCache<boolean>(),
      cacheKey: () => String(runs.mock.calls.length),
      runPreflight: runs,
      assess: (_snapshot, candidate) =>
        verified.includes(candidate.region)
          ? CandidateRegionAvailability.Verified
          : unavailable.includes(candidate.region)
            ? CandidateRegionAvailability.Unavailable
            : CandidateRegionAvailability.Unknown,
      providesLiveCapacitySignal: true,
    });
    return { filter, runs };
  }

  it('launches first where the capacity preflight verified capacity, and preflights only to buy', async () => {
    const regions = getRegionsForVMType('t3.large', CloudType.AWS);
    const verified = regions.at(-1)!;
    const signal = capacitySignal([verified]);
    const { control, rows } = await regionalPool({
      clusterRegion: regions[0],
      candidateRegionFilter: signal.filter,
    });
    await control.reconcile('pool-r');
    expect((await rows()).map((row) => row.region)).toEqual([verified]);
    // A full pool buys nothing, so it asks the provider nothing.
    await control.reconcile('pool-r');
    expect(signal.runs).toHaveBeenCalledOnce();
  });

  it('backs off without buying or failing the pool when the credential has no usable target', async () => {
    const regions = getRegionsForVMType('t3.large', CloudType.AWS);
    const signal = capacitySignal([], regions);
    const { control, rows } = await regionalPool({
      candidateRegionFilter: signal.filter,
    });
    await expect(control.reconcile('pool-r')).rejects.toThrow(
      /pool-r: no target with quota or region access for the credential; next launch in 60 s: All AWS regions for "t3.large"/,
    );
    await control.reconcile('pool-r');
    expect(signal.runs).toHaveBeenCalledOnce();
    await expect(rows()).resolves.toEqual([]);
    await expect(
      getDB().query('SELECT state FROM node_pools WHERE id = ?', ['pool-r']),
    ).resolves.not.toEqual([{ state: NodePoolState.Failed }]);
  });

  it.each([
    ['capacity-exhausted', 'InsufficientInstanceCapacity'],
    ['invalid-target', 'InvalidInstanceType'],
  ] as const)(
    'fails a pinned pool over to its next VM type in the same pass on %s',
    async (diagnosis, code) => {
      const { control, cloudIn, rows } = await regionalPool({
        region: 'us-east-1',
        vmTypes: ['t3.large', 't3.xlarge'],
      });
      cloudIn('us-east-1').newResourceVM.mockRejectedValueOnce(
        providerError(code, diagnosis as CloudFailureDiagnosis),
      );
      await expect(control.reconcile('pool-r')).rejects.toThrow(
        `in us-east-1 failed (${diagnosis}): `,
      );
      await control.reconcile('pool-r');
      expect(
        (await rows()).map((row) => [row.vmType, row.ip !== null]),
      ).toEqual([
        ['t3.large', false],
        ['t3.xlarge', true],
      ]);
    },
  );

  it('fails a pinned multi-type pool in a region the credential may not use', async () => {
    const { control, cloudIn } = await regionalPool({
      region: 'us-east-1',
      vmTypes: ['t3.large', 't3.xlarge'],
    });
    for (const type of ['t3.large', 't3.xlarge']) {
      cloudIn('us-east-1', type).newResourceVM.mockRejectedValue(
        regionalDenial(),
      );
    }
    await expect(control.reconcile('pool-r')).rejects.toThrow(
      /failed \(permission-denied\); the pool stays failed/,
    );
    await expect(
      getDB().query('SELECT state FROM node_pools WHERE id = ?', ['pool-r']),
    ).resolves.toEqual([{ state: NodePoolState.Failed }]);
    // The recorded failure keeps it failed on a later pass.
    await expect(control.reconcile('pool-r')).rejects.toThrow(
      /launching in us-east-1 failed \(permission-denied\); the pool stays failed/,
    );
  });

  it('walks every candidate the preflight left on each backoff wake', async () => {
    const regions = getRegionsForVMType('t3.large', CloudType.AWS);
    const [first, second] = regions as [string, string];
    const { control, cloudIn } = await regionalPool({
      clusterRegion: first,
      candidateRegionFilter: capacitySignal([], regions.slice(2)).filter,
    });
    for (const region of [first, second]) {
      cloudIn(region).newResourceVM.mockRejectedValue(
        providerError(
          'InsufficientInstanceCapacity',
          CloudFailureDiagnosis.CapacityExhausted,
        ),
      );
    }
    for (const backoff of [60, 120]) {
      await expect(control.reconcile('pool-r')).rejects.toThrow(
        new RegExp(`in ${first} failed \\(capacity-exhausted\\): `),
      );
      await expect(control.reconcile('pool-r')).rejects.toThrow(
        `in ${second} failed (capacity-exhausted); next launch in ${backoff} s`,
      );
      clock.now += backoff * 1000 + 1000;
    }
  });

  it('tries each candidate once per pass even when earlier passes failed unevenly', async () => {
    const regions = getRegionsForVMType('t3.large', CloudType.AWS);
    const [a, b, c] = regions as [string, string, string];
    const { control, cloudIn, rows, attemptIn } = await regionalPool({
      clusterRegion: a,
      vmCount: 2,
      candidateRegionFilter: capacitySignal([], regions.slice(3)).filter,
    });
    const capacity = {
      diagnosis: CloudFailureDiagnosis.CapacityExhausted,
      regionDenied: null,
    };
    // b and c failed three times each before the last launch.
    for (const [index, region] of [b, b, b, c, c, c].entries()) {
      const ref = await attemptIn(region, `old-${index}`);
      await getPersistence().nodePoolVms.recordLaunchFailure(
        'pool-r',
        ref,
        capacity,
      );
      await getPersistence().nodePoolVms.claimVmRemoval('pool-r', ref.vmRowId);
    }
    const live = await attemptIn(c, 'live', '203.0.113.50');
    for (const region of [a, b, c]) {
      cloudIn(region).newResourceVM.mockRejectedValue(
        providerError(
          'InsufficientInstanceCapacity',
          CloudFailureDiagnosis.CapacityExhausted,
        ),
      );
    }
    for (const last of [false, false, true]) {
      await expect(control.reconcile('pool-r')).rejects.toThrow(
        last ? /next launch in 60 s/ : /failed \(capacity-exhausted\): /,
      );
    }
    const tried = (await rows())
      .filter((row) => row.id > live.vmRowId)
      .map((row) => row.region);
    expect(new Set(tried)).toEqual(new Set([a, b, c]));
  });

  it('rotates through every VM type and region in one pass and prices each VM by its own type', async () => {
    const vmTypes = ['t3.large', 't3.xlarge'];
    const { control, cloudIn, rows } = await regionalPool({ vmTypes });
    const capacity = providerError(
      'InsufficientInstanceCapacity',
      CloudFailureDiagnosis.CapacityExhausted,
    );
    const candidates = vmTypes.flatMap((type) =>
      getRegionsForVMType(type, CloudType.AWS).map((region) => ({
        type,
        region,
      })),
    );
    for (const { type, region } of candidates) {
      cloudIn(region, type).newResourceVM.mockRejectedValueOnce(capacity);
    }
    const last = candidates.at(-1)!;
    // Every candidate but the last fails once; the last launches.
    cloudIn(last.region, last.type).newResourceVM.mockReset();
    cloudIn(last.region, last.type).newResourceVM.mockImplementation(
      async (params) => ({
        cloudId: `provider-${params.vmId}`,
        ip: '203.0.113.9',
        privateIp: '10.0.0.9',
        createdAt: clock.now,
      }),
    );
    for (let index = 0; index < candidates.length - 1; index++) {
      await expect(control.reconcile('pool-r')).rejects.toThrow(
        /failed \(capacity-exhausted\): /,
      );
    }
    await control.reconcile('pool-r');
    const attempts = await rows();
    expect(
      new Set(attempts.map((row) => `${row.vmType} ${row.region}`)),
    ).toEqual(new Set(candidates.map((c) => `${c.type} ${c.region}`)));
    for (const row of attempts) {
      expect(row.pricePerHour).toBe(
        resolveWorkloadPrice(CloudType.AWS, row.vmType, row.region, false),
      );
    }
    expect(attempts.at(-1)).toMatchObject({
      vmType: last.type,
      region: last.region,
      ip: '203.0.113.9',
    });
  });

  it('backs an unpinned GCP pool off once regional quota failed in every region', async () => {
    const regions = getRegionsForVMType('a2-highgpu-1g', CloudType.GCP);
    const { control, cloudIn } = await regionalPool({
      cloud: CloudType.GCP,
      vmTypes: ['a2-highgpu-1g'],
    });
    for (const region of regions) {
      cloudIn(region).newResourceVM.mockRejectedValue(
        providerError(
          'QUOTA_EXCEEDED',
          CloudFailureDiagnosis.QuotaExhaustedRegion,
        ),
      );
    }
    // One failure covers a region's zones: a pass is one launch per region.
    for (const [index, region] of regions.entries()) {
      await expect(control.reconcile('pool-r')).rejects.toThrow(
        index === regions.length - 1
          ? /failed \(quota-exhausted-region\); next launch in 60 s/
          : new RegExp(
              `in ${region}/\\w+ failed \\(quota-exhausted-region\\): `,
            ),
      );
    }
  });

  it('counts a full pass from the last successful launch only', async () => {
    // Two candidates: europe-west4's zones a and b.
    const { control, cloudIn, zones } = await regionalPool({
      cloud: CloudType.GCP,
      region: 'europe-west4',
      vmTypes: ['a2-highgpu-1g'],
    });
    const capacity = providerError(
      'ZONE_RESOURCE_POOL_EXHAUSTED',
      CloudFailureDiagnosis.CapacityExhausted,
    );
    const region = cloudIn('europe-west4');
    region.newResourceVM.mockRejectedValueOnce(capacity);
    await expect(control.reconcile('pool-r')).rejects.toThrow(
      /in europe-west4\/a failed \(capacity-exhausted\): /,
    );
    await control.reconcile('pool-r');
    // The VM launched in b is lost, and its replacement fails there too.
    region.live.clear();
    region.newResourceVM.mockRejectedValueOnce(capacity);
    await expect(control.reconcile('pool-r')).rejects.toThrow(
      /in europe-west4\/b failed \(capacity-exhausted\): /,
    );
    // Only b failed since the launch, so the pass fails over to a.
    await control.reconcile('pool-r');
    expect(zones).toEqual(['a', 'b', 'b', 'a']);
  });

  it('rotates a GCP pool pinned to a region between its zones', async () => {
    const { control, cloudIn, zones } = await regionalPool({
      cloud: CloudType.GCP,
      region: 'us-central1',
      vmTypes: ['e2-standard-2'],
    });
    cloudIn('us-central1').newResourceVM.mockRejectedValueOnce(
      providerError(
        'ZONE_RESOURCE_POOL_EXHAUSTED',
        CloudFailureDiagnosis.CapacityExhausted,
      ),
    );
    await expect(control.reconcile('pool-r')).rejects.toThrow(
      /in us-central1\/\w+ failed \(capacity-exhausted\): /,
    );
    await control.reconcile('pool-r');
    const [first, second] = zones;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it('adopts an attempt left by a restart in its own region', async () => {
    const [, region] = getRegionsForVMType('t3.large', CloudType.AWS);
    const { control, cloudIn, rows, attemptIn } = await regionalPool();
    const ref = await attemptIn(region!, 'pool-r-vm-left');
    cloudIn(region!).attempts.set(ref.cloudId, {
      cloudId: 'provider-left',
      ip: '203.0.113.77',
      createdAt: clock.now,
    });
    await control.reconcile('pool-r');
    expect(cloudIn(region!).newResourceVM).not.toHaveBeenCalled();
    await expect(rows()).resolves.toMatchObject([
      { region, cloudId: 'provider-left', ip: '203.0.113.77' },
    ]);
  });

  it('opens the Services edge rule in every region with a live VM', async () => {
    const [first, second] = getRegionsForVMType('t3.large', CloudType.AWS);
    const { control, cloudIn, attemptIn } = await regionalPool({ vmCount: 2 });
    await attemptIn(first!, 'a', '203.0.113.60');
    await attemptIn(second!, 'b', '203.0.113.61');
    liveServices = 1;
    await control.reconcile('pool-r');
    for (const region of [first!, second!]) {
      expect(cloudIn(region).prepareResourceNetwork).toHaveBeenCalledWith(
        nodePoolNetwork({ hostsServices: true }),
        expect.objectContaining({ id: 'pool-r' }),
        'test',
      );
    }
  });

  it('0047: fails an unpinned pool over from a region denied to it', async () => {
    const [, , clusterRegion] = getRegionsForVMType('t3.large', CloudType.AWS);
    const { control, cloudIn, rows } = await regionalPool({ clusterRegion });
    cloudIn(clusterRegion!).newResourceVM.mockRejectedValue(regionalDenial());
    await expect(control.reconcile('pool-r')).rejects.toThrow(
      /failed \(permission-denied\)/,
    );
    await expect(
      getPersistence().nodePoolVms.listLaunchFailures('pool-r', 0),
    ).resolves.toMatchObject([
      {
        region: clusterRegion,
        disposition: FailureDisposition.FailoverTarget,
        regionDenied: 'ec2:RunInstances',
      },
    ]);
    await control.reconcile('pool-r');
    const live = (await rows()).filter((row) => row.endedAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]!.region).not.toBe(clusterRegion);
  });

  it('0047: fails a pinned pool whose region is denied', async () => {
    cloud.newResourceVM.mockRejectedValue(regionalDenial());
    await expect(controller().reconcile(nodePoolId)).rejects.toThrow(
      /failed \(permission-denied\); the pool stays failed until/,
    );
  });

  it('fails a pinned pool on a terminal launch outcome', async () => {
    cloud.newResourceVM.mockRejectedValue(
      providerError('InvalidInstanceType', CloudFailureDiagnosis.InvalidTarget),
    );
    await expect(controller().reconcile(nodePoolId)).rejects.toThrow(
      /failed \(invalid-target\); the pool stays failed until it is deleted and recreated/,
    );
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Failed,
    });
    // The failure is permanent: no later pass launches again.
    clock.now += 24 * 60 * 60_000;
    await expect(controller().reconcile(nodePoolId)).rejects.toThrow(
      /launching in us-east-1 failed \(invalid-target\); the pool stays failed until/,
    );
    expect(cloud.newResourceVM).toHaveBeenCalledOnce();
  });

  it('pauses launches while the credential is marked invalid, without failing the pool', async () => {
    cloud.newResourceVM.mockRejectedValueOnce(
      providerError('AuthFailure', CloudFailureDiagnosis.BadCredential),
    );
    const control = controller();
    await expect(control.reconcile(nodePoolId)).rejects.toThrow(
      /failed \(bad-credential\); next launch in 60 s/,
    );
    // The failure itself marked the credential.
    await expect(
      getPersistence().credentialSecrets.isCredentialAuthFailed(credentialId),
    ).resolves.toBe(true);
    clock.now += 24 * 60 * 60_000;
    await control.reconcile(nodePoolId);
    expect(cloud.newResourceVM).toHaveBeenCalledTimes(1);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Creating,
    });
  });

  it('keeps a ready node pool ready while its host-loss replacement backs off, then clears the error', async () => {
    const control = controller();
    await control.reconcile(nodePoolId);
    const [first] = await vms();
    cluster.registerNode(first.id);
    await control.reconcile(nodePoolId);
    cloud.live.delete(first.cloudId);
    cluster.nodes.splice(0, cluster.nodes.length);
    cloud.newResourceVM.mockRejectedValueOnce(
      providerError(
        'VcpuLimitExceeded',
        CloudFailureDiagnosis.QuotaExhaustedRegion,
      ),
    );
    await expect(control.reconcile(nodePoolId)).rejects.toThrow(
      /next launch in 60 s/,
    );
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
      lastError: expect.stringContaining('VcpuLimitExceeded'),
    });

    clock.now += 60_001;
    await control.reconcile(nodePoolId);
    // The replacement launched: no retry is pending, so the error is gone.
    await expect(nodePool()).resolves.toMatchObject({ lastError: null });
    cluster.registerNode((await vms()).at(-1)!.id);
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
      lastError: null,
      provisioningFailures: 0,
    });
  });

  it('0048/S7: buys nothing under an account cap, keeps the pool ready with the reason and its backoff, then buys once the cap lifts', async () => {
    const control = controller();
    await control.reconcile(nodePoolId);
    const [first] = await vms();
    cluster.registerNode(first.id);
    await control.reconcile(nodePoolId);
    // The provider deletes the VM; its replacement meets the throttle.
    cloud.live.delete(first.cloudId);
    cluster.nodes.splice(0, cluster.nodes.length);
    await getSpendControlsStore().setThrottle('account', 0);
    for (let pass = 0; pass < 2; pass += 1) {
      await control.reconcile(nodePoolId);
      clock.now += 60_001;
    }
    expect(cloud.newResourceVM).toHaveBeenCalledTimes(1);
    const blocked = await nodePool();
    expect(blocked).toMatchObject({
      state: NodePoolState.Ready,
      lastError: expect.stringMatching(
        /^scale-out blocked by account cap: blocked by throttle: /,
      ),
      provisioningFailures: 0,
      provisioningFailedAt: null,
    });
    // Queued pool Jobs, Pending replicas and RA's step-up read the same reason.
    await expect(findReplicaCapBlock(nodePoolId)).resolves.toBe(
      blocked!.lastError,
    );

    await getSpendControlsStore().deleteThrottle('account');
    await control.reconcile(nodePoolId);
    expect(cloud.newResourceVM).toHaveBeenCalledTimes(2);
    await expect(nodePool()).resolves.toMatchObject({ lastError: null });
    await expect(findReplicaCapBlock(nodePoolId)).resolves.toBeNull();
    cluster.registerNode((await vms()).at(-1)!.id);
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
      lastError: null,
    });
  });

  it('0048/S7: leaves a new pool creating, not failed, while an account cap blocks its first VM', async () => {
    await getSpendControlsStore().setThrottle('account', 0);
    await controller().reconcile(nodePoolId);
    expect(cloud.newResourceVM).not.toHaveBeenCalled();
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Creating,
      lastError: expect.stringMatching(/^scale-out blocked by account cap: /),
      provisioningFailures: 0,
    });
  });

  it('keeps a ready node pool ready through a transient cluster API error', async () => {
    const control = controller();
    await control.reconcile(nodePoolId);
    cluster.registerNode((await vms())[0].id);
    await control.reconcile(nodePoolId);

    cluster.resolve.mockRejectedValueOnce(new Error('read ECONNRESET'));
    await expect(control.reconcile(nodePoolId)).rejects.toThrow(/ECONNRESET/);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
      lastError: 'read ECONNRESET',
    });

    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
      lastError: null,
    });
  });

  it('pauses remediation after 3 unhealthy-Node replacements within 6 h, keeping the stuck VM and saying why, then resumes', async () => {
    const control = controller();
    await control.reconcile(nodePoolId);
    for (let replacement = 1; replacement <= REMEDIATION_CAP; replacement++) {
      clock.now += 11 * 60_000;
      await control.reconcile(nodePoolId);
    }
    expect(cloud.newResourceVM).toHaveBeenCalledTimes(REMEDIATION_CAP + 1);
    const [stuck] = (await vms()).filter((vm) => vm.endedAt === null);

    clock.now += 11 * 60_000;
    await control.reconcile(nodePoolId);
    expect(cloud.terminateVM).not.toHaveBeenCalledWith(stuck!.cloudId);
    expect(cloud.newResourceVM).toHaveBeenCalledTimes(REMEDIATION_CAP + 1);
    // Paused, not failed: the pool still takes work and recovers by itself.
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Creating,
      lastError: expect.stringMatching(
        /^Node remediation paused: 3 unhealthy Nodes were replaced within 6 h.*x86_64/,
      ),
    });

    // The window passes: the stuck VM is replaced and the pause clears.
    clock.now += REMEDIATION_WINDOW_MS;
    await control.reconcile(nodePoolId);
    expect(cloud.terminateVM).toHaveBeenCalledWith(stuck!.cloudId);
    expect(cloud.newResourceVM).toHaveBeenCalledTimes(REMEDIATION_CAP + 2);
    await expect(nodePool()).resolves.toMatchObject({ lastError: null });
  });

  it('replaces a Node that never joined, then one stuck NotReady past its grace', async () => {
    const control = controller();
    await control.reconcile(nodePoolId);
    clock.now += 11 * 60_000;
    await control.reconcile(nodePoolId);
    const [, second] = await vms();

    cluster.registerNode(second.id, { ready: true });
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
    });

    // A Node that flips NotReady waits through the grace, then is replaced.
    cluster.nodes[0].status!.conditions![0].status = 'False';
    cluster.nodes[0].status!.conditions![0].lastTransitionTime = new Date(
      clock.now,
    );
    clock.now += 10 * 60_000;
    await control.reconcile(nodePoolId);
    expect(cloud.terminateVM).toHaveBeenCalledTimes(1);
    clock.now += 6 * 60_000;
    await control.reconcile(nodePoolId);
    expect(cloud.terminateVM).toHaveBeenCalledTimes(2);
    expect(cloud.terminateVM).toHaveBeenLastCalledWith(second.cloudId);
    expect(cluster.deletedNodes).toContain(
      nodePoolNodeName(nodePoolId, second.id),
    );
  });

  it('0044/S21: deletes a stopped Spot VM without a grace, launches its replacement in the same pass and detaches its Node only once it is gone', async () => {
    await getDB().query('UPDATE node_pools SET spot = 1 WHERE id = ?', [
      nodePoolId,
    ]);
    const control = controller();
    await control.reconcile(nodePoolId);
    const [first] = await vms();
    cluster.registerNode(first.id);
    await control.reconcile(nodePoolId);
    const nodeName = nodePoolNodeName(nodePoolId, first.id);

    // The provider stops the VM; its Node goes NotReady a moment later.
    cloud.stopped.add(first.cloudId);
    cluster.nodes[0].status!.conditions![0].status = 'False';
    cluster.nodes[0].status!.conditions![0].lastTransitionTime = new Date(
      clock.now,
    );
    // The provider accepts the delete but doesn't confirm it this pass.
    cloud.terminateVM.mockImplementation(async () => {});
    await control.reconcile(nodePoolId);
    expect(cloud.terminateVM).toHaveBeenCalledWith(first.cloudId);
    expect(cluster.cordoned).toContain(nodeName);
    expect(cluster.deletedNodes).toEqual([]);
    const [claimed, replacement] = await vms();
    expect(claimed).toMatchObject({
      id: first.id,
      removalRequestedAt: expect.any(Number),
      endedAt: null,
    });
    expect(replacement).toMatchObject({
      endedAt: null,
      ip: expect.any(String),
    });
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
    });

    cloud.terminateVM.mockImplementation(async (cloudId) => {
      cloud.live.delete(cloudId);
    });
    await control.reconcile(nodePoolId);
    expect(cluster.deletedNodes).toEqual([nodeName]);
    expect(cloud.terminateResourceVMLeftovers).toHaveBeenCalledWith(
      first.cloudId,
    );
    expect((await vms())[0].endedAt).toEqual(expect.any(Number));
    expect(cloud.newResourceVM).toHaveBeenCalledTimes(2);
  });

  it('0044/S22: keeps a pool ready through four stopped VMs before any replacement joins, counting no remediation', async () => {
    const control = controller();
    await control.reconcile(nodePoolId);
    const [first] = await vms();
    cluster.registerNode(first.id);
    await control.reconcile(nodePoolId);
    cluster.nodes[0].status!.conditions![0].status = 'False';

    // Each VM stops before its replacement's Node registers, past the join
    // grace that would otherwise count it as never joined.
    for (let stop = 1; stop <= 4; stop++) {
      const [live] = (await vms()).filter((vm) => vm.endedAt === null);
      cloud.stopped.add(live.cloudId);
      clock.now += 11 * 60_000;
      await control.reconcile(nodePoolId);
      expect((await vms()).find((vm) => vm.id === live.id)?.endedAt).toEqual(
        expect.any(Number),
      );
    }
    expect(cloud.newResourceVM).toHaveBeenCalledTimes(5);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
    });
    await expect(
      getPersistence().nodePoolVms.countRemediations(nodePoolId, 0),
    ).resolves.toBe(0);
  });

  describe('0048 scale-out', () => {
    /** A t3.large replica that only an empty Node holds. */
    const WHOLE_NODE = { cpu: '1500m', memory: '1Gi' };
    const GPU_NODE = {
      cpu: '3900m',
      memory: '15Gi',
      'ephemeral-storage': '95Gi',
    };
    const GPU_REPLICA = { cpu: '2', memory: '8Gi', 'nvidia.com/gpu': '1' };

    function launched() {
      return cloud.newResourceVM.mock.calls.length;
    }

    async function liveVms() {
      return (await vms()).filter(
        (vm) => vm.endedAt === null && vm.removalRequestedAt === null,
      );
    }

    /** S1's pool: 1 ready g6.xlarge Node, and 3 of RA's 4 replicas pending. */
    async function gpuPoolWithPendingReplicas(maxVms = 4) {
      await seedGpuNodePool();
      await getDB().query(
        'UPDATE node_pools SET max_vm_count = ? WHERE id = ?',
        [maxVms, nodePoolId],
      );
      const control = controller();
      await control.reconcile(nodePoolId);
      const [first] = await vms();
      cluster.registerNode(first.id, {
        gpus: '1',
        accelerator: 'nvidia',
        allocatable: GPU_NODE,
      });
      await control.reconcile(nodePoolId);
      await expect(nodePool()).resolves.toMatchObject({
        state: NodePoolState.Ready,
      });
      cluster.pods.push(
        boundPod('replica-0', nodePoolNodeName(nodePoolId, first.id)),
        ...[1, 2, 3].map((i) => pendingPod(`replica-${i}`, GPU_REPLICA)),
      );
      return control;
    }

    it('0048/S1: buys in one pass the GPU Nodes its Pending replicas need and stays ready', async () => {
      const control = await gpuPoolWithPendingReplicas();
      // A replica asking for 2 GPUs fits no Node of this 1-GPU pool.
      cluster.pods.push(
        pendingPod('two-gpus', { ...GPU_REPLICA, 'nvidia.com/gpu': '2' }),
      );
      await control.reconcile(nodePoolId);
      expect(launched()).toBe(4);
      expect(await liveVms()).toHaveLength(4);
      await expect(nodePool()).resolves.toMatchObject({
        state: NodePoolState.Ready,
        lastError: null,
      });
      // Status shows why, the two-GPU replica included in the Pending Pods.
      await expect(control.observeCapacity(nodePoolId)).resolves.toMatchObject({
        lastScaleOut: { at: clock.now, pendingPods: 4, lostVms: 0, vms: 3 },
      });
      expect(unfit).toHaveBeenLastCalledWith(
        nodePoolId,
        'fits no Node of pool aws-east',
        new Set(['two-gpus-uid']),
      );
    });

    it('0048/S2: buys no fourth VM while the bought ones join, register their GPUs or keep the not-ready taint, across passes and a restart', async () => {
      // A higher maximum, so only the in-flight VMs hold the count.
      const control = await gpuPoolWithPendingReplicas(8);
      await control.reconcile(nodePoolId);
      expect(launched()).toBe(4);
      const bought = (await liveVms()).slice(1);

      // Still joining: no Node yet.
      await control.reconcile(nodePoolId);
      await controller().reconcile(nodePoolId);
      expect(launched()).toBe(4);

      // Ready, the device plugin not registered yet.
      for (const vm of bought) {
        cluster.registerNode(vm.id, {
          gpus: '0',
          accelerator: 'nvidia',
          allocatable: GPU_NODE,
        });
      }
      await control.reconcile(nodePoolId);
      await controller().reconcile(nodePoolId);
      expect(launched()).toBe(4);

      // Devices registered, Kubernetes' not-ready taint not removed yet.
      for (const node of cluster.nodes.slice(1)) {
        node.status!.allocatable!['nvidia.com/gpu'] = '1';
        node.spec = {
          taints: [
            { key: 'node.kubernetes.io/not-ready', effect: 'NoSchedule' },
          ],
        };
      }
      await controller().reconcile(nodePoolId);
      expect(launched()).toBe(4);

      // Usable, before kube-scheduler binds the replicas still
      // Unschedulable in the cache: the empty Nodes hold them.
      for (const node of cluster.nodes) node.spec = {};
      await control.reconcile(nodePoolId);
      expect(launched()).toBe(4);

      // The replicas schedule and nothing more is bought.
      cluster.pods.splice(1);
      cluster.pods.push(
        ...bought.map((vm, i) =>
          boundPod(`replica-${i + 1}`, nodePoolNodeName(nodePoolId, vm.id)),
        ),
      );
      await control.reconcile(nodePoolId);
      expect(launched()).toBe(4);
      await expect(nodePool()).resolves.toMatchObject({
        state: NodePoolState.Ready,
      });
    });

    it("packs Pending replicas onto the pool's Node shape after its DaemonSet reservations, up to --max-vms", async () => {
      await getDB().query(
        'UPDATE node_pools SET max_vm_count = 5 WHERE id = ?',
        [nodePoolId],
      );
      const control = controller();
      await control.reconcile(nodePoolId);
      const [first] = await vms();
      cluster.registerNode(first.id);
      await control.reconcile(nodePoolId);
      // 1900m allocatable of 2 vCPUs, less a DaemonSet's 200m, holds one
      // 900m replica per Node; the first Node runs one already.
      cluster.pods.push(
        boundPod('agent', nodePoolNodeName(nodePoolId, first.id), {
          daemonSet: { cpu: '200m' },
        }),
        boundPod('small-0', nodePoolNodeName(nodePoolId, first.id)),
        ...[1, 2, 3].map((i) => pendingPod(`small-${i}`, { cpu: '900m' })),
      );
      await control.reconcile(nodePoolId);
      expect(launched()).toBe(4);

      // Six more that each need a whole Node buy only up to the maximum.
      cluster.pods.push(
        ...[1, 2, 3, 4, 5, 6].map((i) => pendingPod(`large-${i}`, WHOLE_NODE)),
      );
      for (const vm of (await liveVms()).slice(1)) cluster.registerNode(vm.id);
      cluster.pods.splice(
        2,
        3,
        ...(await liveVms())
          .slice(1)
          .map((vm, i) =>
            boundPod(`small-${i + 1}`, nodePoolNodeName(nodePoolId, vm.id)),
          ),
      );
      await control.reconcile(nodePoolId);
      expect(launched()).toBe(5);
      expect(await liveVms()).toHaveLength(5);
    });

    it('0048/S9: buys nothing for foreign, other-pool, deleting, too-large or entry-pinned Pending Pods, nor before the pool is ready', async () => {
      await getDB().query(
        'UPDATE node_pools SET max_vm_count = 4 WHERE id = ?',
        [nodePoolId],
      );
      const control = controller();
      cluster.pods.push(pendingPod('early', WHOLE_NODE));
      await control.reconcile(nodePoolId);
      await control.reconcile(nodePoolId);
      expect(launched()).toBe(1);

      const [first] = await vms();
      cluster.registerNode(first.id);
      cluster.pods.splice(
        0,
        1,
        pendingPod('foreign', WHOLE_NODE, { foreign: true }),
        pendingPod('other-pool', WHOLE_NODE, {
          nodeSelector: { [NODE_POOL_MEMBER_LABEL]: 'node-pool-other' },
        }),
        pendingPod('deleting', WHOLE_NODE, { deleting: true }),
        pendingPod('too-large', { cpu: '1950m' }),
        // A Service replica only the busy ingress entry may hold.
        pendingPod('service', WHOLE_NODE, {
          nodeSelector: { [INGRESS_ENTRY_NODE_LABEL]: nodePoolId },
        }),
        boundPod('job', nodePoolNodeName(nodePoolId, first.id)),
      );
      await control.reconcile(nodePoolId);
      await control.reconcile(nodePoolId);
      expect(launched()).toBe(1);
      await expect(nodePool()).resolves.toMatchObject({
        state: NodePoolState.Ready,
      });
      // The too-large replica's Deployment shows why it waits.
      expect(unfit).toHaveBeenLastCalledWith(
        nodePoolId,
        'fits no Node of pool aws-east',
        new Set(['too-large-uid']),
      );
    });

    /** A spot t3.large pool above its floor: Node 1 serves, Node 2 runs a Job. */
    async function spotPoolAboveFloor() {
      await getDB().query(
        'UPDATE node_pools SET spot = 1, max_vm_count = 3 WHERE id = ?',
        [nodePoolId],
      );
      const control = controller();
      await control.reconcile(nodePoolId);
      const [first] = await vms();
      cluster.registerNode(first.id);
      await control.reconcile(nodePoolId);
      // Node 1 is busy, so it can't take the Job's or a lost Node's replica.
      cluster.pods.push(
        pendingPod('job', WHOLE_NODE),
        boundPod('serving', nodePoolNodeName(nodePoolId, first.id)),
      );
      await control.reconcile(nodePoolId);
      const [, second] = await vms();
      cluster.registerNode(second.id);
      const nodeName = nodePoolNodeName(nodePoolId, second.id);
      cluster.pods.splice(0, 1, boundPod('job', nodeName));
      await control.reconcile(nodePoolId);
      expect(launched()).toBe(2);
      const stop = () => {
        cloud.stopped.add(second.cloudId);
        cluster.nodes[1].status!.conditions![0].status = 'False';
      };
      return { control, second, nodeName, stop };
    }

    it('0048/S8: replaces a stopped busy spot Node above the floor in its claiming pass, once, when the release confirms in that pass and its replica already pends', async () => {
      const { control, second, stop } = await spotPoolAboveFloor();
      stop();
      // The release confirms at once, and the Deployment's recreated
      // replica is Unschedulable before the policy runs.
      cloud.terminateVM.mockImplementationOnce(async (cloudId) => {
        cloud.live.delete(cloudId);
        cluster.pods.push(pendingPod('job-retry', WHOLE_NODE));
      });
      await control.reconcile(nodePoolId);
      expect(cloud.terminateVM).toHaveBeenCalledWith(second.cloudId);
      expect(cluster.deletedPods).toContain('job');
      expect(launched()).toBe(3);

      // The successor joining covers the replica in later passes.
      await control.reconcile(nodePoolId);
      await control.reconcile(nodePoolId);
      expect(launched()).toBe(3);
      expect(await liveVms()).toHaveLength(2);
    });

    it('0048/S8: buys a stopped busy spot Node one successor however long its release takes', async () => {
      const { control, second, nodeName, stop } = await spotPoolAboveFloor();
      stop();
      // The provider accepts the delete but confirms it only much later.
      cloud.terminateVM.mockImplementation(async () => {});
      await control.reconcile(nodePoolId);
      expect(launched()).toBe(3);
      expect(cluster.deletedPods).toEqual([]);
      await control.reconcile(nodePoolId);
      const successor = (await liveVms()).at(-1)!;
      cluster.registerNode(successor.id);
      await control.reconcile(nodePoolId);
      expect(launched()).toBe(3);

      // The release confirms after the successor is usable: the Job's Pod
      // goes only now, and its retry takes the empty successor.
      cloud.live.delete(second.cloudId);
      await control.reconcile(nodePoolId);
      expect(cluster.deletedNodes).toContain(nodeName);
      expect(cluster.deletedPods).toContain('job');
      cluster.pods.push(
        boundPod('job-retry', nodePoolNodeName(nodePoolId, successor.id)),
      );
      await control.reconcile(nodePoolId);
      expect(launched()).toBe(3);
    });

    it('0048/S8: counts a stopped spot Node whose Pods Kubernetes already evicted only through its Pending replica', async () => {
      const { control, nodeName, stop } = await spotPoolAboveFloor();
      stop();
      cluster.pods.splice(
        0,
        1,
        boundPod('job', nodeName, { deleting: true }),
        pendingPod('job-retry', WHOLE_NODE),
      );
      await control.reconcile(nodePoolId);
      expect(launched()).toBe(3);
      await control.reconcile(nodePoolId);
      expect(launched()).toBe(3);
    });

    it('0048/S8: buys for a busy spot Node the provider deleted only once its replica pends', async () => {
      const { control, second, nodeName } = await spotPoolAboveFloor();
      cloud.live.delete(second.cloudId);
      cluster.nodes[1].status!.conditions![0].status = 'False';
      await control.reconcile(nodePoolId);
      expect(cluster.deletedNodes).toContain(nodeName);
      expect(launched()).toBe(2);

      cluster.pods.push(pendingPod('job-retry', WHOLE_NODE));
      await control.reconcile(nodePoolId);
      await control.reconcile(nodePoolId);
      expect(launched()).toBe(3);
    });

    it('0048/S8: deletes an idle stopped spot Node above the floor without replacing it', async () => {
      const { control, second, stop } = await spotPoolAboveFloor();
      cluster.pods.splice(0);
      stop();
      await control.reconcile(nodePoolId);
      expect(cloud.terminateVM).toHaveBeenCalledWith(second.cloudId);
      expect(launched()).toBe(2);
      expect(await liveVms()).toHaveLength(1);
      await expect(nodePool()).resolves.toMatchObject({
        state: NodePoolState.Ready,
      });
    });
  });

  describe('0048 scale-in', () => {
    const WINDOW_MS = 10 * 60_000;

    /** A ready pool with `--min-vms 1` and `count` usable Nodes. */
    async function poolAboveFloor(count = 3) {
      resetPersistence();
      await seed('t3.large', count);
      const control = controller();
      await control.reconcile(nodePoolId);
      for (const vm of await vms()) cluster.registerNode(vm.id);
      await control.reconcile(nodePoolId);
      await getDB().query(
        'UPDATE node_pools SET min_vm_count = 1 WHERE id = ?',
        [nodePoolId],
      );
      const rows = await vms();
      const names = rows.map((vm) => nodePoolNodeName(nodePoolId, vm.id));
      return { control, rows, names };
    }

    function node(name: string) {
      return cluster.nodes.find((entry) => entry.metadata?.name === name);
    }

    async function row(id: number) {
      return (await vms()).find((vm) => vm.id === id)!;
    }

    /** Runs `effect` once, just before the next patch of a matching body. */
    function onPatch(match: (body: V1Node) => boolean, effect: () => void) {
      const patchNode = vi.mocked(cluster.runtime.cluster.core.patchNode);
      const original = patchNode.getMockImplementation()!;
      let done = false;
      patchNode.mockImplementation(async (request) => {
        if (!done && match(request.body)) {
          done = true;
          effect();
        }
        return original(request);
      });
    }
    const stamp = (body: V1Node) =>
      typeof body.metadata?.annotations?.['anycloud.sh/scale-in'] === 'string';
    const cordon = (body: V1Node) => body.spec?.unschedulable === true;

    /** A claim and its stamp that scale-in wrote before the API stopped. */
    async function claimedByScaleIn(id: number) {
      const at = clock.now;
      node(nodePoolNodeName(nodePoolId, id))!.metadata!.annotations = {
        'anycloud.sh/scale-in': String(at),
      };
      await getPersistence().nodePoolVms.claimVmRemoval(nodePoolId, id, at);
    }

    it('0048/S3, S6: removes idle Nodes down to the minimum after one window, which a restart restarts', async () => {
      const { control, rows, names } = await poolAboveFloor();
      clock.now += 8 * 60_000;
      const restarted = controller();
      await restarted.reconcile(nodePoolId);
      clock.now += 9 * 60_000;
      await restarted.reconcile(nodePoolId);
      expect(cloud.terminateVM).not.toHaveBeenCalled();
      expect(cluster.cordoned).toEqual([]);

      clock.now += 60_000;
      await restarted.reconcile(nodePoolId);
      // The longest idle go first; ties keep the row order.
      expect(cloud.terminateVM.mock.calls.map(([id]) => id)).toEqual(
        rows.slice(0, 2).map((vm) => vm.cloudId),
      );
      expect(cluster.cordoned).toEqual(names.slice(0, 2));
      expect(cluster.deletedNodes).toEqual(names.slice(0, 2));
      await control.reconcile(nodePoolId);
      expect(
        (await vms()).filter((vm) => vm.endedAt === null).map((vm) => vm.id),
      ).toEqual([rows[2]!.id]);
      await expect(nodePool()).resolves.toMatchObject({
        state: NodePoolState.Ready,
      });
    });

    it('0049/C22: a pool with --min-vms 0 is ready with no Node, buys a burst from zero in one pass, and removes its last idle Node', async () => {
      resetPersistence();
      await seed('t3.large', 0);
      await getDB().query(
        'UPDATE node_pools SET max_vm_count = 4 WHERE id = ?',
        [nodePoolId],
      );
      const control = controller();
      await control.reconcile(nodePoolId);
      expect(cloud.newResourceVM).not.toHaveBeenCalled();
      await expect(nodePool()).resolves.toMatchObject({
        state: NodePoolState.Ready,
        lastError: null,
      });

      // Five default t3.large replicas (1 vCPU, 90% of half its 8 GiB): two
      // to a Node, so three Nodes, bought once while they join.
      cluster.pods.push(
        ...[0, 1, 2, 3, 4].map((i) =>
          pendingPod(`replica-${i}`, { cpu: '1', memory: '3686Mi' }),
        ),
      );
      await control.reconcile(nodePoolId);
      await control.reconcile(nodePoolId);
      expect(cloud.newResourceVM).toHaveBeenCalledTimes(3);

      // The replicas end; the joined Nodes idle out down to zero.
      cluster.pods.length = 0;
      const rows = await vms();
      for (const vm of rows) cluster.registerNode(vm.id);
      await control.reconcile(nodePoolId);
      clock.now += WINDOW_MS;
      await control.reconcile(nodePoolId);
      expect(cloud.terminateVM.mock.calls.map(([id]) => id)).toEqual(
        rows.map((vm) => vm.cloudId),
      );
      await control.reconcile(nodePoolId);
      expect((await vms()).filter((vm) => vm.endedAt === null)).toEqual([]);
      await expect(nodePool()).resolves.toMatchObject({
        state: NodePoolState.Ready,
      });
    });

    /** A t3.large pool with --min-vms 0 and no Node, ready. */
    async function emptyPool(maxVms = 2) {
      resetPersistence();
      await seed('t3.large', 0);
      await getDB().query(
        'UPDATE node_pools SET max_vm_count = ? WHERE id = ?',
        [maxVms, nodePoolId],
      );
      const control = controller();
      await control.reconcile(nodePoolId);
      return control;
    }

    // A t3.large's 8 GiB less the estimate's 256Mi kernel and 100Mi eviction
    // reserve leaves 7836Mi; its real Node's allocatable can differ.
    it('0049/C22: a Pod the estimate fits but the real Node rejects buys one Node once, which idles out and is never bought again', async () => {
      const control = await emptyPool();
      cluster.pods.push(pendingPod('near-top', { cpu: '1', memory: '7500Mi' }));
      await control.reconcile(nodePoolId);
      expect(cloud.newResourceVM).toHaveBeenCalledOnce();

      // The Node keeps back 1Gi, so 7Gi allocatable can't hold it.
      const [vm] = await vms();
      cluster.registerNode(vm!.id);
      await control.reconcile(nodePoolId);
      expect(unfit).toHaveBeenLastCalledWith(
        nodePoolId,
        'fits no Node of pool aws-east',
        new Set(['near-top-uid']),
      );
      clock.now += WINDOW_MS;
      await control.reconcile(nodePoolId);
      expect(cloud.terminateVM).toHaveBeenCalledExactlyOnceWith(vm!.cloudId);
      await control.reconcile(nodePoolId);
      expect((await vms()).filter((row) => row.endedAt === null)).toEqual([]);

      // Back at zero Nodes, it still fits no Node and buys nothing.
      await control.reconcile(nodePoolId);
      await control.reconcile(nodePoolId);
      expect(cloud.newResourceVM).toHaveBeenCalledOnce();
      expect(unfit).toHaveBeenLastCalledWith(
        nodePoolId,
        'fits no Node of pool aws-east',
        new Set(['near-top-uid']),
      );

      // A new Pod is judged afresh, and the gone one is forgotten.
      cluster.pods.splice(
        0,
        1,
        pendingPod('small', { cpu: '1', memory: '1Gi' }),
      );
      await control.reconcile(nodePoolId);
      expect(cloud.newResourceVM).toHaveBeenCalledTimes(2);
      expect(unfit).toHaveBeenLastCalledWith(
        nodePoolId,
        'fits no Node of pool aws-east',
        new Set(),
      );
    });

    it('0049/C22: a Pod the estimate rejects still buys one Node from zero, which holds it', async () => {
      const control = await emptyPool();
      cluster.pods.push(pendingPod('near-top', { cpu: '1', memory: '7850Mi' }));
      await control.reconcile(nodePoolId);
      await control.reconcile(nodePoolId);
      expect(cloud.newResourceVM).toHaveBeenCalledOnce();
      expect(unfit).toHaveBeenLastCalledWith(
        nodePoolId,
        'fits no Node of pool aws-east',
        new Set(),
      );

      // The Node keeps back only 292Mi, so it holds the Pod.
      const [vm] = await vms();
      cluster.registerNode(vm!.id, {
        allocatable: {
          cpu: '1900m',
          memory: '7900Mi',
          'ephemeral-storage': '95Gi',
        },
      });
      await control.reconcile(nodePoolId);
      expect(unfit).toHaveBeenLastCalledWith(
        nodePoolId,
        'fits no Node of pool aws-east',
        new Set(),
      );
      expect(cloud.newResourceVM).toHaveBeenCalledOnce();
    });

    it('0049/C22: releases the ingress entry once the pool hosts no Service, so the former entry idles out to zero', async () => {
      const control = await emptyPool(1);
      cluster.pods.push(pendingPod('replica', { cpu: '1' }));
      await control.reconcile(nodePoolId);
      const [vm] = await vms();
      cluster.registerNode(vm!.id);
      cluster.pods.length = 0;
      liveServices = 1;
      await control.reconcile(nodePoolId);
      await expect(nodePool()).resolves.toMatchObject({
        ingressEntryVmId: vm!.id,
      });
      const name = nodePoolNodeName(nodePoolId, vm!.id);
      expect(node(name)!.metadata!.labels![INGRESS_ENTRY_NODE_LABEL]).toBe(
        nodePoolId,
      );
      clock.now += WINDOW_MS;
      await control.reconcile(nodePoolId);
      expect(cloud.terminateVM).not.toHaveBeenCalled();

      liveServices = 0;
      await control.reconcile(nodePoolId);
      await expect(nodePool()).resolves.toMatchObject({
        ingressEntryVmId: null,
      });
      expect(
        node(name)!.metadata!.labels![INGRESS_ENTRY_NODE_LABEL],
      ).toBeNull();
      expect(entryChanges).toHaveBeenLastCalledWith(nodePoolId, null);
      await control.reconcile(nodePoolId);
      clock.now += WINDOW_MS;
      await control.reconcile(nodePoolId);
      expect(cloud.terminateVM).toHaveBeenCalledExactlyOnceWith(vm!.cloudId);
    });

    it('0049/C22: removes an idle outdated Node of a pool that empties instead of replacing it', async () => {
      const control = await emptyPool(1);
      cluster.pods.push(pendingPod('replica', { cpu: '1' }));
      await control.reconcile(nodePoolId);
      const [vm] = await vms();
      cluster.registerNode(vm!.id, { outdated: true });
      cluster.pods.length = 0;
      await control.reconcile(nodePoolId);
      clock.now += WINDOW_MS;
      await control.reconcile(nodePoolId);
      expect(cloud.terminateVM).toHaveBeenCalledExactlyOnceWith(vm!.cloudId);
      await control.reconcile(nodePoolId);
      expect(cloud.newResourceVM).toHaveBeenCalledOnce();
      expect((await vms()).filter((row) => row.endedAt === null)).toEqual([]);
    });

    it('removes no idle Node while Pending replicas count against the empty ones', async () => {
      const { control, rows, names } = await poolAboveFloor();
      cluster.pods.push(boundPod('job', names[2]!));
      await control.reconcile(nodePoolId);
      clock.now += WINDOW_MS;
      cluster.pods.push(pendingPod('replica', { cpu: '1500m', memory: '1Gi' }));
      await control.reconcile(nodePoolId);
      expect(cloud.terminateVM).not.toHaveBeenCalled();

      // Once bound, the other empty Node goes.
      cluster.pods.splice(1, 1, boundPod('replica', names[0]!));
      await control.reconcile(nodePoolId);
      expect(cloud.terminateVM).toHaveBeenCalledExactlyOnceWith(
        rows[1]!.cloudId,
      );
    });

    it('removes no idle Node that a stopped busy Node’s replicas will land on', async () => {
      const { control, rows, names } = await poolAboveFloor();
      cluster.pods.push(
        boundPod('job', names[0]!),
        boundPod('replica', names[0]!),
      );
      await control.reconcile(nodePoolId);
      clock.now += WINDOW_MS;
      cloud.stopped.add(rows[0]!.cloudId);
      node(names[0]!)!.status!.conditions![0]!.status = 'False';
      await control.reconcile(nodePoolId);
      expect(cloud.terminateVM).toHaveBeenCalledExactlyOnceWith(
        rows[0]!.cloudId,
      );
      expect(cluster.cordoned).toEqual([names[0]]);
      for (const vm of rows.slice(1)) {
        await expect(row(vm.id)).resolves.toMatchObject({
          removalRequestedAt: null,
        });
      }
    });

    it('0048/S4: removes only the Node with no Job, finalizer Pod or ingress, ignoring DaemonSet Pods', async () => {
      const { control, rows, names } = await poolAboveFloor(4);
      const [job, held, entry, idle] = names;
      const finalized = boundPod('finished', held!, { deleting: true });
      finalized.metadata!.labels = {};
      finalized.metadata!.finalizers = ['anycloud.sh/outcome'];
      cluster.pods.push(
        boundPod('replica', job!),
        finalized,
        boundPod('agent', idle!, { daemonSet: { cpu: '100m' } }),
      );
      node(entry!)!.metadata!.labels![INGRESS_ENTRY_NODE_LABEL] = nodePoolId;
      await getDB().query(
        'UPDATE node_pools SET ingress_entry_vm_id = ? WHERE id = ?',
        [rows[2]!.id, nodePoolId],
      );
      liveServices = 1;
      await control.reconcile(nodePoolId);
      clock.now += WINDOW_MS;
      await control.reconcile(nodePoolId);
      await control.reconcile(nodePoolId);
      expect(cloud.terminateVM).toHaveBeenCalledExactlyOnceWith(
        rows[3]!.cloudId,
      );
      expect(cluster.cordoned).toEqual([idle]);
    });

    it('0048/S5: keeps a Node a replica is scheduled onto before the cordon, uncordoned and unclaimed', async () => {
      const { control, rows, names } = await poolAboveFloor(2);
      await control.reconcile(nodePoolId);
      clock.now += WINDOW_MS;
      // Bound after the pass read the cache, so only the re-check's LIST
      // sees it.
      onPatch(stamp, () => cluster.pods.push(boundPod('replica', names[0]!)));
      await control.reconcile(nodePoolId);
      expect(cluster.cordoned).toEqual([names[0]]);
      expect(cloud.terminateVM).not.toHaveBeenCalled();
      expect(node(names[0]!)).toMatchObject({
        metadata: { annotations: {} },
        spec: { unschedulable: false },
      });
      await expect(row(rows[0]!.id)).resolves.toMatchObject({
        removalRequestedAt: null,
      });
      // Busy resets the window, so the Node stays while its Job runs.
      clock.now += WINDOW_MS;
      await control.reconcile(nodePoolId);
      expect(cloud.terminateVM).toHaveBeenCalledExactlyOnceWith(
        rows[1]!.cloudId,
      );
    });

    it('0048/S6: re-checks a scale-in claim the API stopped before cordoning, once restarted, and skips a Node it cannot stamp', async () => {
      const { control, rows, names } = await poolAboveFloor(2);
      await control.reconcile(nodePoolId);
      clock.now += WINDOW_MS;
      const patchNode = vi.mocked(cluster.runtime.cluster.core.patchNode);
      const original = patchNode.getMockImplementation()!;
      patchNode.mockImplementationOnce(async () => {
        throw new Error('conflict');
      });
      await control.reconcile(nodePoolId);
      await expect(row(rows[0]!.id)).resolves.toMatchObject({
        removalRequestedAt: null,
      });

      patchNode.mockImplementation(async (request) => {
        if (cordon(request.body)) throw new Error('API stopped');
        return original(request);
      });
      await expect(control.reconcile(nodePoolId)).rejects.toThrow(
        'API stopped',
      );
      await expect(row(rows[0]!.id)).resolves.toMatchObject({
        removalRequestedAt: clock.now,
      });
      expect(node(names[0]!)?.metadata?.annotations).toEqual({
        'anycloud.sh/scale-in': String(clock.now),
      });

      patchNode.mockImplementation(original);
      await controller().reconcile(nodePoolId);
      expect(cluster.cordoned).toEqual([names[0]]);
      expect(cloud.terminateVM).toHaveBeenCalledExactlyOnceWith(
        rows[0]!.cloudId,
      );
    });

    it('0048/S6: unclaims a busy scale-in claim on a Node an upgrade made outdated, which replaceOutdatedNode then takes', async () => {
      const { rows, names } = await poolAboveFloor(2);
      await claimedByScaleIn(rows[0]!.id);
      node(names[0]!)!.metadata!.labels!['anycloud.sh/join-revision'] = '0';
      cluster.pods.push(boundPod('replica', names[0]!));
      poolJobsInFlight = [{ podUid: 'replica-uid' }];
      const restarted = controller();
      await restarted.reconcile(nodePoolId);
      expect(cluster.cordoned).toEqual([names[0]]);
      expect(node(names[0]!)?.spec?.unschedulable).toBe(false);
      await expect(row(rows[0]!.id)).resolves.toMatchObject({
        removalRequestedAt: null,
      });
      expect(cloud.terminateVM).not.toHaveBeenCalled();

      // Once its spare is Ready, cordoned again for the drain.
      cluster.registerNode((await vms()).at(-1)!.id);
      await restarted.reconcile(nodePoolId);
      expect(cluster.cordoned).toEqual([names[0], names[0]]);
      expect(closedReplicas).toContain('replica-uid');
      expect(cloud.terminateVM).not.toHaveBeenCalled();

      // Evicted, then removed once its Pods are gone.
      poolJobsInFlight = [];
      await restarted.reconcile(nodePoolId);
      expect(cluster.evicted).toEqual(['replica']);
      expect(cloud.terminateVM).not.toHaveBeenCalled();
      await restarted.reconcile(nodePoolId);
      expect(cloud.terminateVM).toHaveBeenCalledExactlyOnceWith(
        rows[0]!.cloudId,
      );
    });

    it('0048/S6: an unclaim stopped after the uncordon is re-checked again, and one stopped after clearing the claim leaves a stale stamp that no other claim matches', async () => {
      const { rows, names } = await poolAboveFloor(2);
      await claimedByScaleIn(rows[0]!.id);
      cluster.pods.push(boundPod('replica', names[0]!));
      const unclaim = vi
        .spyOn(getPersistence().nodePoolVms, 'unclaimVmRemoval')
        .mockRejectedValueOnce(new Error('API stopped'));
      await expect(controller().reconcile(nodePoolId)).rejects.toThrow(
        'API stopped',
      );
      expect(node(names[0]!)?.spec?.unschedulable).toBe(false);

      onPatch(
        (body) => body.metadata?.annotations?.['anycloud.sh/scale-in'] === null,
        () => {
          throw new Error('API stopped');
        },
      );
      await expect(controller().reconcile(nodePoolId)).rejects.toThrow(
        'API stopped',
      );
      expect(unclaim).toHaveBeenCalledTimes(2);
      expect(cluster.cordoned).toEqual([names[0], names[0]]);
      expect(node(names[0]!)).toMatchObject({
        metadata: {
          annotations: { 'anycloud.sh/scale-in': String(clock.now) },
        },
        spec: { unschedulable: false },
      });
      await expect(row(rows[0]!.id)).resolves.toMatchObject({
        removalRequestedAt: null,
      });

      // Another path's claim on the busy Node ends in deletion.
      await getPersistence().nodePoolVms.claimVmRemoval(
        nodePoolId,
        rows[0]!.id,
      );
      await controller().reconcile(nodePoolId);
      expect(cloud.terminateVM).toHaveBeenCalledExactlyOnceWith(
        rows[0]!.cloudId,
      );
    });

    it('0048/S6: removes a claimed NotReady Node and a claimed never-joined Node that turned Ready directly, and finalizes a released VM, never unclaiming', async () => {
      const { rows, names } = await poolAboveFloor(3);
      cluster.pods.push(
        ...names.map((name, i) => boundPod(`replica-${i}`, name)),
      );
      // Scale-in's claim, its Node NotReady since.
      await claimedByScaleIn(rows[0]!.id);
      node(names[0]!)!.status!.conditions![0]!.status = 'False';
      // The never-joined path's claim, its terminate still running.
      await getPersistence().nodePoolVms.claimVmRemoval(
        nodePoolId,
        rows[1]!.id,
      );
      // Scale-in's claim on a VM the provider already released.
      await claimedByScaleIn(rows[2]!.id);
      cloud.live.delete(rows[2]!.cloudId);
      cloud.terminateVM.mockImplementation(async () => {});

      await controller().reconcile(nodePoolId);
      expect(cloud.terminateVM.mock.calls.map(([id]) => id)).toEqual([
        rows[0]!.cloudId,
        rows[1]!.cloudId,
      ]);
      expect(cluster.nodes.map((entry) => entry.spec?.unschedulable)).toEqual([
        true,
        true,
      ]);
      const after = await vms();
      expect(after.slice(0, 2)).toMatchObject([
        { removalRequestedAt: expect.any(Number), endedAt: null },
        { removalRequestedAt: expect.any(Number), endedAt: null },
      ]);
      expect(after[2]).toMatchObject({ endedAt: expect.any(Number) });
    });

    it('0048/S11: never scales in outdated Nodes or their spare; a restart after replaceOutdatedNode claims the busy one removes it without unclaiming', async () => {
      const { control, rows, names } = await poolAboveFloor(2);
      for (const name of names) {
        node(name)!.metadata!.labels!['anycloud.sh/join-revision'] = '0';
      }
      cluster.pods.push(boundPod('replica', names[0]!));
      poolJobsInFlight = [{ podUid: 'replica-uid' }];
      await control.reconcile(nodePoolId);
      const spare = (await vms()).at(-1)!;
      expect(rows.map((vm) => vm.id)).not.toContain(spare.id);
      cluster.registerNode(spare.id);
      await control.reconcile(nodePoolId);
      clock.now += WINDOW_MS;
      await control.reconcile(nodePoolId);
      expect(cloud.terminateVM).not.toHaveBeenCalled();
      expect(cluster.nodePatches.filter(stamp)).toEqual([]);

      poolJobsInFlight = [];
      cloud.terminateVM.mockImplementation(async () => {});
      await control.reconcile(nodePoolId);
      await control.reconcile(nodePoolId);
      const restarted = controller();
      await restarted.reconcile(nodePoolId);
      expect(cluster.evicted).toEqual(['replica']);
      expect(cloud.terminateVM.mock.calls.map(([id]) => id)).toEqual([
        rows[0]!.cloudId,
        rows[0]!.cloudId,
      ]);
      await expect(row(rows[0]!.id)).resolves.toMatchObject({
        removalRequestedAt: expect.any(Number),
      });

      // Released, then the idle outdated Node goes once a spare is Ready
      // beside the desired count, and the Nodes above it idle out.
      cloud.terminateVM.mockImplementation(async (cloudId) => {
        cloud.live.delete(cloudId);
      });
      cloud.live.delete(rows[0]!.cloudId);
      await restarted.reconcile(nodePoolId);
      const joined = new Set(cluster.nodes.map((entry) => entry.metadata?.uid));
      for (const vm of await vms()) {
        if (!joined.has(`node-${vm.id}`)) cluster.registerNode(vm.id);
      }
      await restarted.reconcile(nodePoolId);
      expect(cloud.terminateVM).toHaveBeenLastCalledWith(rows[1]!.cloudId);
      for (let window = 0; window < 3; window += 1) {
        await restarted.reconcile(nodePoolId);
        clock.now += WINDOW_MS;
      }
      await restarted.reconcile(nodePoolId);
      expect((await vms()).filter((vm) => vm.endedAt === null)).toHaveLength(1);
    });

    it('0048/S12: deletes a candidate the provider stops during the pass once, as scale-in or, if busy, by the next pass’s stop path', async () => {
      const { control, rows, names } = await poolAboveFloor(3);
      await control.reconcile(nodePoolId);
      clock.now += WINDOW_MS;
      onPatch(stamp, () => {
        cloud.stopped.add(rows[0]!.cloudId);
        cloud.stopped.add(rows[1]!.cloudId);
        cluster.pods.push(boundPod('replica', names[1]!));
      });
      await control.reconcile(nodePoolId);
      expect(cloud.terminateVM).toHaveBeenCalledExactlyOnceWith(
        rows[0]!.cloudId,
      );
      await expect(row(rows[1]!.id)).resolves.toMatchObject({
        removalRequestedAt: null,
      });

      node(names[1]!)!.status!.conditions![0]!.status = 'False';
      await control.reconcile(nodePoolId);
      await control.reconcile(nodePoolId);
      expect(cloud.terminateVM.mock.calls.map(([id]) => id)).toEqual([
        rows[0]!.cloudId,
        rows[1]!.cloudId,
      ]);
    });
  });

  it('replaces each Node of an older join script surge-first: a Ready spare, then cordon, pool Jobs, eviction and removal', async () => {
    resetPersistence();
    await seed('t3.large', 2);
    const control = controller();
    await control.reconcile(nodePoolId);
    const [first, second] = await vms();
    cluster.registerNode(first.id, { outdated: true });
    cluster.registerNode(second.id, { outdated: true });
    const firstName = nodePoolNodeName(nodePoolId, first.id);
    cluster.pods.push(
      boundPod('replica', firstName),
      boundPod('device-plugin', firstName, { daemonSet: {} }),
    );
    // A spare launches first; nothing is cordoned until it is Ready.
    await control.reconcile(nodePoolId);
    const spare = (await vms())[2]!;
    expect(spare).toMatchObject({ endedAt: null, ip: expect.any(String) });
    expect(cluster.cordoned).toEqual([]);
    await control.reconcile(nodePoolId);
    expect(await vms()).toHaveLength(3);
    expect(cluster.cordoned).toEqual([]);

    // A pool Job on the oldest Node holds it, cordoned, its replica closed.
    cluster.registerNode(spare.id);
    poolJobsInFlight = [{ podUid: 'replica-uid' }];
    await control.reconcile(nodePoolId);
    expect(cluster.cordoned).toEqual([firstName]);
    expect(closedReplicas).toContain('replica-uid');
    expect(cluster.evicted).toEqual([]);

    // Evicted through the Eviction API, DaemonSet Pods left; removed once
    // its Pods are gone, with the next spare launched for the second.
    poolJobsInFlight = [];
    await control.reconcile(nodePoolId);
    expect(cluster.evicted).toEqual(['replica']);
    expect(cloud.terminateVM).not.toHaveBeenCalled();
    await control.reconcile(nodePoolId);
    expect(cloud.terminateVM).toHaveBeenCalledExactlyOnceWith(first.cloudId);
    const fourth = (await vms())[3]!;
    expect(fourth).toMatchObject({ endedAt: null, ip: expect.any(String) });

    cluster.registerNode(fourth.id);
    await control.reconcile(nodePoolId);
    expect(cloud.terminateVM).toHaveBeenLastCalledWith(second.cloudId);
    // Nodes of the current script stay, with no further spare.
    await control.reconcile(nodePoolId);
    await control.reconcile(nodePoolId);
    expect(cloud.terminateVM).toHaveBeenCalledTimes(2);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
    });
    expect(
      (await vms()).filter((vm) => vm.endedAt === null).map((vm) => vm.id),
    ).toEqual([spare.id, fourth.id]);
  });

  it('replaces a Node a Job found an unusable GPU on before a Node of an older join script', async () => {
    resetPersistence();
    await seed('t3.large', 2);
    const control = controller();
    await control.reconcile(nodePoolId);
    const [first, second] = await vms();
    cluster.registerNode(first.id, { outdated: true });
    cluster.registerNode(second.id);
    cluster.nodes.find(
      (node) => node.metadata?.name === nodePoolNodeName(nodePoolId, second.id),
    )!.metadata!.labels![UNUSABLE_GPU_NODE_LABEL] = 'true';
    await control.reconcile(nodePoolId);
    expect(cloud.terminateVM).toHaveBeenCalledExactlyOnceWith(second.cloudId);
    // The breaker counts it.
    await expect(
      getPersistence().nodePoolVms.countRemediations(nodePoolId, 0),
    ).resolves.toBe(1);
  });

  it('replaces an outdated Node that failed the GPU check without a spare, then an outdated healthy one surge-first', async () => {
    resetPersistence();
    await seed('t3.large', 2);
    const control = controller();
    await control.reconcile(nodePoolId);
    const [first, second] = await vms();
    const firstName = nodePoolNodeName(nodePoolId, first.id);
    cluster.registerNode(first.id, { outdated: true });
    cluster.pods.push(boundPod('replica', firstName));
    cluster.registerNode(second.id, { outdated: true });
    cluster.nodes.find(
      (node) => node.metadata?.name === nodePoolNodeName(nodePoolId, second.id),
    )!.metadata!.labels![UNUSABLE_GPU_NODE_LABEL] = 'true';
    // Removed through remediation, before any spare is Ready.
    await control.reconcile(nodePoolId);
    expect(cloud.terminateVM).toHaveBeenCalledExactlyOnceWith(second.cloudId);
    await expect(
      getPersistence().nodePoolVms.countRemediations(nodePoolId, 0),
    ).resolves.toBe(1);
    // The healthy outdated Node waits for a Ready spare, then drains.
    const [, , replacement, spare] = await vms();
    await control.reconcile(nodePoolId);
    expect(cluster.cordoned).not.toContain(firstName);
    cluster.registerNode(replacement!.id);
    cluster.registerNode(spare!.id);
    await control.reconcile(nodePoolId);
    expect(cluster.cordoned).toContain(firstName);
    expect(cluster.evicted).toEqual(['replica']);
    expect(cloud.terminateVM).toHaveBeenCalledOnce();
    await control.reconcile(nodePoolId);
    expect(cloud.terminateVM).toHaveBeenLastCalledWith(first.cloudId);
  });

  it('while remediation is paused, keeps a Node that failed the GPU check cordoned, still replacing an outdated one', async () => {
    resetPersistence();
    await seed('t3.large', 2);
    const control = controller();
    await control.reconcile(nodePoolId);
    const [first, second] = await vms();
    cluster.registerNode(first.id, { outdated: true });
    cluster.registerNode(second.id, { outdated: true });
    cluster.nodes.find(
      (node) => node.metadata?.name === nodePoolNodeName(nodePoolId, second.id),
    )!.metadata!.labels![UNUSABLE_GPU_NODE_LABEL] = 'true';
    vi.spyOn(
      getPersistence().nodePoolVms,
      'countRemediations',
    ).mockResolvedValue(REMEDIATION_CAP);
    // The outdated Node's spare joins first; the failed one gets none.
    await control.reconcile(nodePoolId);
    expect(await vms()).toHaveLength(3);
    cluster.registerNode((await vms())[2]!.id);
    await control.reconcile(nodePoolId);
    expect(cloud.terminateVM).toHaveBeenCalledExactlyOnceWith(first.cloudId);
    // A Ready pool still shows the pause.
    await control.reconcile(nodePoolId);
    expect(await vms()).toHaveLength(3);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
      lastError: expect.stringContaining('Node remediation paused'),
    });
  });

  it("replaces most of a pool's Nodes that failed the GPU check one at a time, without pausing", async () => {
    resetPersistence();
    await seed('t3.large', 3);
    const control = controller();
    await control.reconcile(nodePoolId);
    const live = await vms();
    for (const vm of live) cluster.registerNode(vm.id);
    for (const node of cluster.nodes.slice(1)) {
      node.metadata!.labels![UNUSABLE_GPU_NODE_LABEL] = 'true';
    }
    for (let pass = 0; pass < 2; pass++) {
      await control.reconcile(nodePoolId);
      cluster.registerNode((await vms()).at(-1)!.id);
    }
    expect(cloud.terminateVM.mock.calls).toEqual([
      [live[1]!.cloudId],
      [live[2]!.cloudId],
    ]);
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
      lastError: null,
    });
  });

  it('replaces no further Node of an older join script while a replacement fails to launch', async () => {
    resetPersistence();
    await seed('t3.large', 3);
    const control = controller();
    await control.reconcile(nodePoolId);
    for (const vm of await vms()) {
      cluster.registerNode(vm.id, { outdated: true });
    }
    cloud.newResourceVM.mockRejectedValue(
      providerError(
        'InsufficientInstanceCapacity',
        CloudFailureDiagnosis.CapacityExhausted,
      ),
    );
    // Past each backoff: capacity may return, so the old Nodes stay.
    for (let pass = 0; pass < 4; pass += 1) {
      await control.reconcile(nodePoolId).catch(() => {});
      clock.now += 60 * 60_000;
    }
    expect(cloud.terminateVM).not.toHaveBeenCalled();
    expect(cluster.cordoned).toEqual([]);
    expect(
      (await vms()).filter(
        (vm) => vm.endedAt === null && vm.removalRequestedAt === null,
      ),
    ).toHaveLength(3);
  });

  it('removes an outdated Node whose eviction a PodDisruptionBudget refuses only once the drain times out, and says so on the pool until a later one drains in time', async () => {
    resetPersistence();
    await seed('t3.large', 2);
    const control = controller();
    await control.reconcile(nodePoolId);
    const [current, old] = await vms();
    cluster.registerNode(current.id);
    cluster.registerNode(old.id, { outdated: true });
    // Neither a PodDisruptionBudget nor a stopping Traefik outlasts the hour.
    cluster.pods.push(
      boundPod('guarded', nodePoolNodeName(nodePoolId, old.id)),
      poolTraefik(nodePoolNodeName(nodePoolId, old.id)),
    );
    cluster.refuseEviction.add('guarded');
    await control.reconcile(nodePoolId);
    const spare = (await vms())[2]!;
    cluster.registerNode(spare.id);
    await control.reconcile(nodePoolId);
    clock.now += 59 * 60_000;
    await control.reconcile(nodePoolId);
    expect(cloud.terminateVM).not.toHaveBeenCalled();
    clock.now += 60_000;
    await control.reconcile(nodePoolId);
    expect(cloud.terminateVM).toHaveBeenCalledExactlyOnceWith(old.cloudId);
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      lastError: `${OUTDATED_REPLACEMENT_PREFIX}: a drain timed out after an hour: Node ${nodePoolNodeName(nodePoolId, old.id)} was removed before its Pods moved`,
    });

    const spareNode = cluster.nodes.at(-1)!;
    delete spareNode.metadata!.labels!['anycloud.sh/join-revision'];
    await control.reconcile(nodePoolId);
    cluster.registerNode((await vms()).at(-1)!.id);
    await control.reconcile(nodePoolId);
    expect(cloud.terminateVM).toHaveBeenLastCalledWith(spare.cloudId);
    await expect(nodePool()).resolves.toMatchObject({ lastError: null });
  });

  it('uncordons an outdated Node whose spare is lost until another one joins', async () => {
    resetPersistence();
    await seed('t3.large', 1);
    const control = controller();
    await control.reconcile(nodePoolId);
    const [old] = await vms();
    const oldName = nodePoolNodeName(nodePoolId, old.id);
    cluster.registerNode(old.id, { outdated: true });
    cluster.pods.push(boundPod('guarded', oldName));
    cluster.refuseEviction.add('guarded');
    await control.reconcile(nodePoolId);
    const spare = (await vms())[1]!;
    cluster.registerNode(spare.id);
    await control.reconcile(nodePoolId);
    const unschedulable = () =>
      cluster.nodes.find((node) => node.metadata?.name === oldName)!.spec
        ?.unschedulable;
    expect(unschedulable()).toBe(true);

    // A spot loss ends the spare, and capacity refuses another.
    await getDB().query('UPDATE vms SET ended_at = ? WHERE id = ?', [
      clock.now,
      spare.id,
    ]);
    cluster.nodes.splice(cluster.nodes.length - 1, 1);
    cloud.newResourceVM.mockRejectedValue(
      providerError(
        'InsufficientInstanceCapacity',
        CloudFailureDiagnosis.CapacityExhausted,
      ),
    );
    await control.reconcile(nodePoolId).catch(() => {});
    expect(unschedulable()).toBe(false);
    expect(cloud.terminateVM).not.toHaveBeenCalled();
  });

  it('replaces an outdated Node in place when its spare hits quota, says so on the pool, and clears it once none is left', async () => {
    resetPersistence();
    await seed('t3.large', 1);
    liveServices = 1;
    const control = controller();
    await control.reconcile(nodePoolId);
    const [old] = await vms();
    cluster.registerNode(old.id, { outdated: true });
    // The entry's own Traefik doesn't hold its drain.
    cluster.nodes[0]!.metadata!.labels![INGRESS_ENTRY_NODE_LABEL] = nodePoolId;
    cluster.pods.push(poolTraefik(nodePoolNodeName(nodePoolId, old.id)));
    cloud.newResourceVM.mockRejectedValueOnce(
      providerError(
        'VcpuLimitExceeded',
        CloudFailureDiagnosis.QuotaExhaustedRegion,
      ),
    );
    await control.reconcile(nodePoolId).catch(() => {});
    expect(cloud.terminateVM).not.toHaveBeenCalled();

    clock.now += 60 * 60_000;
    await control.reconcile(nodePoolId);
    expect(cluster.cordoned).toContain(nodePoolNodeName(nodePoolId, old.id));
    expect(cloud.terminateVM).toHaveBeenCalledExactlyOnceWith(old.cloudId);
    const replacement = (await vms()).at(-1)!;
    expect(replacement).toMatchObject({
      endedAt: null,
      ip: expect.any(String),
    });
    await expect(nodePool()).resolves.toMatchObject({
      lastError: `${OUTDATED_REPLACEMENT_PREFIX} without a spare first: the spare VM's launch failed (quota-exhausted-region)`,
    });

    cluster.registerNode(replacement.id);
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
      lastError: null,
    });
  });

  it('hands the ingress entry over last with no Service gap: a second entry and replica, the record published, then the old entry gives up', async () => {
    resetPersistence();
    await seed('t3.large', 2);
    liveServices = 1;
    const control = controller();
    await control.reconcile(nodePoolId);
    const [entry, other] = await vms();
    cluster.registerNode(entry.id, { outdated: true });
    cluster.registerNode(other.id, { outdated: true });
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      ingressEntryVmId: entry.id,
    });
    const entryName = nodePoolNodeName(nodePoolId, entry.id);
    const [component, serve] = nodePoolServicePodSelector().split('=');
    const serviceLabels = { [component!]: serve!, app: 'web' };
    const ready = [{ type: 'Ready', status: 'True' }];
    const servicePod = (name: string, nodeName: string): V1Pod => ({
      metadata: {
        name,
        namespace: 'svc',
        uid: `${name}-uid`,
        labels: serviceLabels,
      },
      spec: { nodeName, containers: [] },
      status: { conditions: ready },
    });
    const traefik = (nodeName: string): V1Pod => ({
      ...boundPod(`traefik-${nodeName}`, nodeName, { daemonSet: {} }),
      spec: {
        nodeName,
        containers: [{ name: 'traefik', args: ['--accesslog=true'] }],
      },
      metadata: {
        name: `traefik-${nodeName}`,
        namespace: poolIngressReleaseName(nodePoolId),
        ownerReferences: [
          {
            apiVersion: 'apps/v1',
            kind: 'DaemonSet',
            name: 'pool-ingress',
            uid: 'ds',
          },
        ],
      },
      status: { conditions: ready },
    });
    cluster.pods.push(servicePod('web-old', entryName), traefik(entryName));
    cluster.deployments.push({
      metadata: {
        name: 'web',
        namespace: 'svc',
        labels: { [component!]: serve! },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'web' } },
        template: {
          spec: {
            nodeSelector: { [INGRESS_ENTRY_NODE_LABEL]: nodePoolId },
            containers: [],
          },
        },
      },
    });
    const labelledEntries = () =>
      cluster.nodes
        .filter(
          (node) =>
            node.metadata?.labels?.[INGRESS_ENTRY_NODE_LABEL] === nodePoolId,
        )
        .map((node) => node.metadata?.name);

    // The non-entry Node goes first, beside its spare.
    cluster.registerNode((await vms())[2]!.id);
    await control.reconcile(nodePoolId);
    await control.reconcile(nodePoolId);
    expect(cloud.terminateVM).toHaveBeenCalledExactlyOnceWith(other.cloudId);

    // With the entry's own spare Ready, it, not the lower current Node the
    // other Node's Pods may fill, becomes a second entry. The Service gets a
    // second replica, its old one the lowest deletion cost first; both Nodes
    // keep the label while the replica starts.
    const lost = (await vms()).at(-1)!;
    const lostName = nodePoolNodeName(nodePoolId, lost.id);
    cluster.registerNode(lost.id);
    await control.reconcile(nodePoolId);
    await control.reconcile(nodePoolId);
    expect(cluster.cordoned).toContain(entryName);
    expect(labelledEntries()).toEqual([entryName, lostName]);
    expect(cluster.deployments[0]).toMatchObject({
      metadata: { labels: { [ENTRY_HANDOFF_LABEL]: nodePoolId } },
      spec: { replicas: 2 },
    });
    const costPatch = [
      expect.objectContaining({
        name: 'web-old',
        body: {
          metadata: {
            annotations: {
              'controller.kubernetes.io/pod-deletion-cost': String(-(2 ** 31)),
            },
          },
        },
      }),
      expect.anything(),
    ];
    const { core, apps } = cluster.runtime.cluster;
    expect(vi.mocked(core.patchNamespacedPod).mock.calls).toEqual([costPatch]);
    expect(
      vi.mocked(core.patchNamespacedPod).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(apps.patchNamespacedDeployment).mock.invocationCallOrder[0]!,
    );
    await expect(nodePool()).resolves.toMatchObject({
      ingressEntryVmId: entry.id,
    });

    // A spare lost now reopens the old entry with the Service back at one
    // replica, and the next spare takes the hand-off up again.
    await getDB().query('UPDATE vms SET ended_at = ? WHERE id = ?', [
      clock.now,
      lost.id,
    ]);
    cluster.nodes.splice(
      cluster.nodes.findIndex((node) => node.metadata?.name === lostName),
      1,
    );
    cloud.newResourceVM.mockRejectedValueOnce(
      providerError(
        'InsufficientInstanceCapacity',
        CloudFailureDiagnosis.CapacityExhausted,
      ),
    );
    await control.reconcile(nodePoolId).catch(() => {});
    expect(
      cluster.nodes.find((node) => node.metadata?.name === entryName)!.spec
        ?.unschedulable,
    ).toBe(false);
    expect(cluster.deployments[0]!.metadata?.labels).not.toHaveProperty(
      ENTRY_HANDOFF_LABEL,
    );
    expect(cluster.deployments[0]!.spec?.replicas).toBe(1);
    clock.now += 60 * 60_000;
    await control.reconcile(nodePoolId);
    const spare = (await vms()).at(-1)!;
    const spareName = nodePoolNodeName(nodePoolId, spare.id);
    cluster.registerNode(spare.id);
    await control.reconcile(nodePoolId);
    expect(labelledEntries()).toEqual([entryName, spareName]);
    expect(cluster.deployments[0]!.spec?.replicas).toBe(2);
    expect(vi.mocked(core.patchNamespacedPod).mock.calls).toEqual([
      costPatch,
      costPatch,
    ]);

    // Ready there: the record moves, and the old entry serves until it
    // publishes and its Traefik goes quiet.
    cluster.pods.push(servicePod('web-new', spareName), traefik(spareName));
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      ingressEntryVmId: spare.id,
    });
    expect(entryChanges).toHaveBeenLastCalledWith(nodePoolId, {
      vmId: spare.id,
      ip: spare.ip,
    });
    // Unpublished, it holds however long that takes.
    await control.reconcile(nodePoolId);
    clock.now += 60_000;
    await control.reconcile(nodePoolId);
    expect(labelledEntries()).toEqual([entryName, spareName]);
    publishedIp = spare.ip;
    await control.reconcile(nodePoolId);
    // While the edge still sends requests to the old entry, it keeps serving.
    cluster.podLogs.set(
      `traefik-${entryName}`,
      '203.0.113.9 - - [29/Oct/2026:04:44:18 +0000] "GET / HTTP/1.1" 200 12 "-" "-" 7 "web@kubernetescrd" "http://10.42.1.5:8000" 1ms\n',
    );
    clock.now += 4 * 60_000 + 59_000;
    await control.reconcile(nodePoolId);
    expect(labelledEntries()).toEqual([entryName, spareName]);
    expect(core.readNamespacedPodLog).toHaveBeenCalledWith(
      expect.objectContaining({ name: `traefik-${entryName}` }),
      undefined,
    );
    expect(cluster.deletedPods).toEqual([]);
    expect(cluster.evicted).toEqual([]);
    expect(cluster.pods.map((pod) => pod.metadata?.name)).toContain('web-old');

    // Five minutes bound the wait: the old entry gives its label up, and
    // its Traefik stops while the old replica still serves what reaches it.
    clock.now += 1_000;
    await control.reconcile(nodePoolId);
    expect(labelledEntries()).toEqual([spareName]);
    await control.reconcile(nodePoolId);
    expect(cluster.deployments[0]).toMatchObject({
      metadata: { labels: { [ENTRY_HANDOFF_LABEL]: nodePoolId } },
      spec: { replicas: 2 },
    });
    // The cluster holds that state, so an API restart keeps it.
    const restarted = controller();
    await restarted.reconcile(nodePoolId);
    expect(cluster.deployments[0]!.spec?.replicas).toBe(2);
    expect(cluster.evicted).toEqual([]);

    // Once that Traefik is gone, the replica goes, then the Node.
    cluster.pods.splice(
      cluster.pods.findIndex(
        (pod) => pod.metadata?.name === `traefik-${entryName}`,
      ),
      1,
    );
    await control.reconcile(nodePoolId);
    expect(cluster.deployments[0]!.metadata?.labels).not.toHaveProperty(
      ENTRY_HANDOFF_LABEL,
    );
    expect(cluster.deployments[0]!.spec?.replicas).toBe(1);
    // The scale-down, not an eviction, removes the old replica first.
    expect(
      vi.mocked(apps.patchNamespacedDeployment).mock.invocationCallOrder.at(-1),
    ).toBeLessThan(
      vi.mocked(core.createNamespacedPodEviction).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(core.patchNamespacedPod).mock.calls).toHaveLength(2);
    await control.reconcile(nodePoolId);
    expect(cloud.terminateVM).toHaveBeenLastCalledWith(entry.cloudId);
  });

  it('hands the ingress entry over two minutes after the record publishes once its Traefik logs no request for the quiet window', async () => {
    liveServices = 1;
    const control = controller();
    await control.reconcile(nodePoolId);
    const [entry] = await vms();
    cluster.registerNode(entry.id, { outdated: true });
    await control.reconcile(nodePoolId);
    await control.reconcile(nodePoolId);
    const spare = (await vms()).at(-1)!;
    cluster.registerNode(spare.id);
    const entryName = nodePoolNodeName(nodePoolId, entry.id);
    const spareName = nodePoolNodeName(nodePoolId, spare.id);
    const [component, serve] = nodePoolServicePodSelector().split('=');
    const ready = { conditions: [{ type: 'Ready', status: 'True' }] };
    const pod = (name: string, namespace: string, nodeName: string): V1Pod => ({
      metadata: {
        name,
        namespace,
        uid: `${name}-uid`,
        labels: { [component!]: serve!, app: 'web' },
      },
      spec: {
        nodeName,
        containers: [{ name: 'main', args: ['--accesslog=true'] }],
      },
      status: ready,
    });
    const ingress = poolIngressReleaseName(nodePoolId);
    cluster.pods.push(
      pod('web-old', 'svc', entryName),
      pod('web-new', 'svc', spareName),
      pod('traefik-old', ingress, entryName),
      pod('traefik-new', ingress, spareName),
    );
    cluster.deployments.push({
      metadata: {
        name: 'web',
        namespace: 'svc',
        labels: { [component!]: serve! },
      },
      spec: {
        replicas: 2,
        selector: { matchLabels: { app: 'web' } },
        template: {
          spec: {
            nodeSelector: { [INGRESS_ENTRY_NODE_LABEL]: nodePoolId },
            containers: [],
          },
        },
      },
    });
    const entryLabelled = () =>
      cluster.nodes.find((node) => node.metadata?.name === entryName)!.metadata
        ?.labels?.[INGRESS_ENTRY_NODE_LABEL];
    await control.reconcile(nodePoolId);
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      ingressEntryVmId: spare.id,
    });
    publishedIp = spare.ip;
    await control.reconcile(nodePoolId);
    // A quiet entry still serves two minutes past the publish, while the edge
    // may yet resolve the old record.
    clock.now += 119_000;
    await control.reconcile(nodePoolId);
    expect(entryLabelled()).toBe(nodePoolId);
    expect(
      cluster.runtime.cluster.core.readNamespacedPodLog,
    ).not.toHaveBeenCalled();
    clock.now += 1_000;
    await control.reconcile(nodePoolId);
    expect(entryLabelled()).toBeNull();
    expect(
      cluster.runtime.cluster.core.readNamespacedPodLog,
    ).toHaveBeenCalledWith(
      { name: 'traefik-old', namespace: ingress, sinceSeconds: 20 },
      undefined,
    );
  });
  it('drains no outdated GPU Node until its spare advertises its GPUs, though the old Node lost its own', async () => {
    await seedGpuNodePool();
    const control = controller();
    await control.reconcile(nodePoolId);
    const [old] = await vms();
    cluster.registerNode(old.id, {
      gpus: '0',
      accelerator: 'nvidia',
      outdated: true,
    });
    await control.reconcile(nodePoolId);
    const spare = (await vms())[1]!;
    cluster.registerNode(spare.id, { gpus: '0', accelerator: 'nvidia' });
    await control.reconcile(nodePoolId);
    expect(cluster.cordoned).toEqual([]);
    cluster.nodes.at(-1)!.status!.allocatable!['nvidia.com/gpu'] = '1';
    await control.reconcile(nodePoolId);
    expect(cluster.cordoned).toContain(nodePoolNodeName(nodePoolId, old.id));
  });

  it('returns a Service held for a hand-off that is no longer under way to one replica', async () => {
    liveServices = 1;
    const control = controller();
    await control.reconcile(nodePoolId);
    const [entry] = await vms();
    cluster.registerNode(entry.id);
    await control.reconcile(nodePoolId);
    // The entry's own Traefik is not a former entry's, stopping.
    cluster.pods.push(poolTraefik(nodePoolNodeName(nodePoolId, entry.id)));
    cluster.deployments.push({
      metadata: {
        name: 'web',
        namespace: 'svc',
        labels: { [ENTRY_HANDOFF_LABEL]: nodePoolId },
      },
      spec: { replicas: 2, selector: {}, template: {} },
    });
    await control.reconcile(nodePoolId);
    expect(cluster.deployments[0]).toMatchObject({
      metadata: { labels: {} },
      spec: { replicas: 1 },
    });
  });

  it('replaces no Node of an older join script while another Node of the pool is not Ready', async () => {
    resetPersistence();
    await seed('t3.large', 2);
    const control = controller();
    await control.reconcile(nodePoolId);
    const [first, second] = await vms();
    cluster.registerNode(first.id, { outdated: true });
    cluster.registerNode(second.id, { ready: false });
    await control.reconcile(nodePoolId);
    expect(cloud.terminateVM).not.toHaveBeenCalled();
    expect(
      (await vms()).filter((vm) => vm.removalRequestedAt !== null),
    ).toEqual([]);
  });

  it('removes a Node left by an ended attempt instead of wedging the node pool', async () => {
    const control = controller();
    await control.reconcile(nodePoolId);
    const [first] = await vms();
    clock.now += 11 * 60_000;
    // The agent registers after the pass observed no Node, while the VM is
    // being terminated: the row ends but the Node object stays behind.
    cloud.terminateVM.mockImplementationOnce(async (cloudId) => {
      cloud.live.delete(cloudId);
      cluster.registerNode(first.id);
    });
    await control.reconcile(nodePoolId);
    const rows = await vms();
    expect(rows.find((vm) => vm.id === first.id)?.endedAt).toEqual(
      expect.any(Number),
    );
    // The late Node maps to an ended attempt: removed by UID, never foreign.
    expect(cluster.deletedNodes).toContain(
      nodePoolNodeName(nodePoolId, first.id),
    );
    expect(cluster.nodes).toHaveLength(0);
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Creating,
    });
    const [, second] = await vms();
    cluster.registerNode(second.id);
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
    });
  });

  it('treats an unlabelled Node registered under an issued bootstrap name as foreign', async () => {
    const control = controller();
    await control.reconcile(nodePoolId);
    const [attempt] = await vms();
    cluster.registerNode(attempt.id, { unlabelled: true });

    await expect(control.reconcile(nodePoolId)).rejects.toThrow(
      /refusing to count foreign capacity/,
    );
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Failed,
      lastError: expect.stringContaining(
        nodePoolNodeName(nodePoolId, attempt.id),
      ),
    });
  });

  it('pauses remediation while more than 40% of the Nodes are NotReady at once, and resumes as they recover', async () => {
    resetPersistence();
    cloud = createFakeCloud(() => clock.now);
    cluster = createFakeCluster();
    await seed('t3.large', 3);
    const control = controller();
    await control.reconcile(nodePoolId);
    const live = await vms();
    for (const vm of live) cluster.registerNode(vm.id);
    await control.reconcile(nodePoolId);
    // Two of three Nodes lose the cluster, as in a network fault.
    for (const node of cluster.nodes.slice(1)) {
      node.status!.conditions![0].status = 'False';
      node.status!.conditions![0].lastTransitionTime = new Date(clock.now);
    }
    clock.now += 16 * 60_000;
    await control.reconcile(nodePoolId);
    expect(cloud.terminateVM).not.toHaveBeenCalled();
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
      lastError: expect.stringContaining(
        'Node remediation paused: 2 of 3 Nodes are absent or NotReady at once',
      ),
    });

    // One recovers; the other alone is replaced, and the pause clears.
    cluster.nodes[1]!.status!.conditions![0].status = 'True';
    await control.reconcile(nodePoolId);
    expect(cloud.terminateVM).toHaveBeenCalledExactlyOnceWith(live[2]!.cloudId);
    await expect(nodePool()).resolves.toMatchObject({ lastError: null });
  });

  it('re-verifies the cluster for admission and keeps observation fail-closed on an oversized attempt label', async () => {
    const control = controller();
    await control.assertClusterCompatible(clusterId);
    expect(cluster.resolve).toHaveBeenLastCalledWith(clusterId, undefined, {
      maxAgeMs: 0,
    });

    await control.reconcile(nodePoolId);
    const [attempt] = await vms();
    cluster.nodes.push({
      metadata: {
        name: nodePoolNodeName(nodePoolId, attempt.id),
        uid: 'node-oversized',
        labels: {
          ...nodePoolNodeLabels({
            clusterId,
            nodePoolId,
            cloudProvider: CloudType.AWS,
            vmRowId: attempt.id,
          }),
          'anycloud.sh/attempt': '1000000000000',
        },
      },
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    });
    await expect(control.reconcile(nodePoolId)).rejects.toThrow(
      new RegExp(`${nodePoolNodeName(nodePoolId, attempt.id)}.*foreign`),
    );
    await expect(control.observeCapacity(nodePoolId)).resolves.toEqual({
      readyVmCount: 0,
      startingVmCount: 1,
      drainingVmCount: 0,
      locations: [
        {
          region: 'us-east-1',
          zone: 'us-east-1a',
          vmType: 't3.large',
          releasing: null,
        },
      ],
    });
  });

  it('degrades capacity to durable rows for status but fails closed for admission when the cluster is unreachable', async () => {
    const control = controller();
    await control.reconcile(nodePoolId);
    const [attempt] = await vms();
    cluster.registerNode(attempt.id);
    await control.reconcile(nodePoolId);
    await expect(control.observeCapacity(nodePoolId)).resolves.toMatchObject({
      readyVmCount: 1,
    });

    cluster.resolve.mockRejectedValue(new Error('cluster unreachable'));
    await expect(control.observeCapacity(nodePoolId)).resolves.toEqual({
      readyVmCount: 0,
      startingVmCount: 1,
      drainingVmCount: 0,
      locations: [
        {
          region: 'us-east-1',
          zone: 'us-east-1a',
          vmType: 't3.large',
          releasing: null,
        },
      ],
    });
    await expect(
      control.observeCapacity(nodePoolId, { requireObservation: true }),
    ).rejects.toMatchObject({
      name: 'NodePoolCapacityUnavailableError',
      message: expect.stringContaining('could not be observed on its cluster'),
    });
  });

  it('elects one Ready Node as the ingress entry once the pool hosts a Service, opens the edge rule and installs the pool Traefik', async () => {
    await getDB().query(`DELETE FROM node_pools WHERE id = ?`, [nodePoolId]);
    await getPersistence().nodePools.create({
      id: nodePoolId,
      clusterId,
      ownerUserId: 'owner-1',
      name: 'aws-east',
      computeCredentialId: credentialId,
      region: 'us-east-1',
      zone: 'us-east-1a',
      vmTypes: ['t3.large'],
      minVmCount: 2,
      maxVmCount: 2,
    });
    const control = controller();
    await control.reconcile(nodePoolId);
    const attempts = await vms();
    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) cluster.registerNode(attempt.id);
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      state: NodePoolState.Ready,
      ingressEntryVmId: null,
    });
    // A Jobs-only pool has no entry, no edge rule and no ingress release.
    expect(cloud.prepareResourceNetwork).toHaveBeenCalledWith(
      NODE_POOL_NETWORK,
      expect.anything(),
      'test',
    );
    const releaseKey = `HelmChart/kube-system/${poolIngressReleaseName(nodePoolId)}`;
    expect(cluster.objects.objects.has(releaseKey)).toBe(false);
    expect(entryChanges).not.toHaveBeenCalled();
    await expect(control.ingress(nodePoolId)).resolves.toEqual({
      entryIp: null,
      release: null,
    });

    liveServices = 1;
    cloud.prepareResourceNetwork.mockClear();
    await control.reconcile(nodePoolId);
    const [first, second] = [...attempts].sort((a, b) => a.id - b.id);
    await expect(nodePool()).resolves.toMatchObject({
      ingressEntryVmId: first.id,
    });
    expect(entryChanges).toHaveBeenCalledWith(nodePoolId, {
      vmId: first.id,
      ip: first.ip,
    });
    const labelled = cluster.nodes.filter(
      (node) =>
        node.metadata?.labels?.[INGRESS_ENTRY_NODE_LABEL] === nodePoolId,
    );
    expect(labelled.map((node) => node.metadata?.name)).toEqual([
      nodePoolNodeName(nodePoolId, first.id),
    ]);
    const network = cloud.prepareResourceNetwork.mock.calls.at(-1)![0] as {
      denyPublicIngress?: boolean;
      ingress: Array<{ port: number; sourceRanges: string[] }>;
    };
    expect(network.denyPublicIngress).toBe(true);
    expect(network.ingress.map((rule) => rule.port)).toEqual([80]);
    expect(network.ingress[0].sourceRanges).not.toContain('0.0.0.0/0');
    expect(cluster.objects.objects.has(releaseKey)).toBe(true);
    expect(
      cluster.objects.objects.get(releaseKey)?.metadata?.labels?.[
        'anycloud.sh/node-pool'
      ],
    ).toBe(nodePoolId);

    // Status reads the release through the same connection: the HelmChart
    // exists, helm-controller's Job has not appeared, no DaemonSet yet.
    await expect(control.ingress(nodePoolId)).resolves.toEqual({
      entryIp: first.ip,
      release: {
        state: 'installing',
        helmJob: { phase: 'pending', message: null },
        daemonSet: null,
        lastEvent: null,
        routes: 0,
      },
    });

    // A healthy entry is kept across passes; nothing is re-signalled.
    entryChanges.mockClear();
    await control.reconcile(nodePoolId);
    expect(entryChanges).not.toHaveBeenCalled();

    // NotReady beyond the grace hands the role to the other Ready Node.
    const entryNode = cluster.nodes.find(
      (node) => node.metadata?.name === nodePoolNodeName(nodePoolId, first.id),
    )!;
    entryNode.status!.conditions![0].status = 'False';
    entryNode.status!.conditions![0].lastTransitionTime = new Date(clock.now);
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      ingressEntryVmId: first.id,
    });
    // A Service replica and an unrelated Pod sit on the entry that is about to
    // lose the role; only the replica is evicted (its Deployment recreates it
    // on the new entry, the only Node its selector now matches).
    cluster.pods.push(
      {
        metadata: {
          name: 'serve-a-1',
          namespace: 'serve-a',
          labels: { 'app.kubernetes.io/component': 'kubernetes-serve' },
        },
        spec: {
          nodeName: nodePoolNodeName(nodePoolId, first.id),
          containers: [],
        },
      },
      {
        metadata: { name: 'job-x', namespace: 'jobs' },
        spec: {
          nodeName: nodePoolNodeName(nodePoolId, first.id),
          containers: [],
        },
      },
    );
    clock.now += INGRESS_ENTRY_NOT_READY_GRACE_MS + 1;
    await control.reconcile(nodePoolId);
    await expect(nodePool()).resolves.toMatchObject({
      ingressEntryVmId: second.id,
    });
    expect(cluster.deletedPods).toEqual(['serve-a-1']);
    expect(entryChanges).toHaveBeenCalledWith(nodePoolId, {
      vmId: second.id,
      ip: second.ip,
    });
    expect(
      cluster.nodes
        .filter(
          (node) =>
            node.metadata?.labels?.[INGRESS_ENTRY_NODE_LABEL] === nodePoolId,
        )
        .map((node) => node.metadata?.name),
    ).toEqual([nodePoolNodeName(nodePoolId, second.id)]);
  });

  it('summarizes capacity from durable rows and observed Nodes', () => {
    const base = {
      nodePoolId,
      cloudId: 'c',
      privateIp: null,
      createdAt: 1,
      region: 'us-east-1',
      availabilityZone: null,
      credentialId,
      pricePerHour: null,
      vmType: 't3.large',
    };
    const unscheduled = {
      allocatable: {
        cpu: 0,
        memory: 0,
        'nvidia.com/gpu': 0,
        'ephemeral-storage': 0,
      },
      notReadyTaint: false,
    };
    expect(
      summarizeNodePoolCapacity(
        [
          {
            ...base,
            id: 1,
            ip: '1.1.1.1',
            endedAt: null,
            removalRequestedAt: null,
          },
          {
            ...base,
            id: 2,
            ip: '1.1.1.2',
            endedAt: null,
            removalRequestedAt: 5,
          },
          { ...base, id: 3, ip: null, endedAt: null, removalRequestedAt: null },
          { ...base, id: 4, ip: '1.1.1.4', endedAt: 9, removalRequestedAt: 5 },
        ],
        [
          {
            name: 'n1',
            vmRowId: 1,
            ready: true,
            readyTransitionAt: null,
            allocatableGpus: 0,
            ...unscheduled,
            accelerator: null,
            member: true,
            ingressEntry: false,
            outdated: false,
            unusableGpu: false,
            scaleInStamp: null,
            uid: 'u1',
          },
          {
            name: 'n2',
            vmRowId: 2,
            ready: true,
            readyTransitionAt: null,
            allocatableGpus: 0,
            ...unscheduled,
            accelerator: null,
            member: true,
            ingressEntry: false,
            outdated: false,
            unusableGpu: false,
            scaleInStamp: null,
            uid: 'u2',
          },
        ],
        0,
        CloudType.AWS,
      ),
    ).toEqual({
      readyVmCount: 1,
      startingVmCount: 1,
      drainingVmCount: 1,
      // The draining VM carries its release start and AWS's one-pass bound:
      // the 180 s terminate waiter plus tagging and one describe.
      locations: [null, { since: 5, usuallyUnderSeconds: 210 }, null].map(
        (releasing) => ({
          region: 'us-east-1',
          zone: null,
          vmType: 't3.large',
          releasing,
        }),
      ),
    });
    expect(
      summarizeNodePoolCapacity(
        [
          {
            ...base,
            id: 1,
            ip: '1.1.1.1',
            endedAt: null,
            removalRequestedAt: null,
          },
        ],
        [
          {
            name: 'n1',
            vmRowId: 1,
            ready: true,
            readyTransitionAt: null,
            allocatableGpus: 0,
            ...unscheduled,
            accelerator: null,
            member: true,
            ingressEntry: false,
            outdated: false,
            unusableGpu: false,
            scaleInStamp: null,
            uid: 'u1',
          },
        ],
        null,
        CloudType.AWS,
      ),
    ).toEqual({
      readyVmCount: 0,
      startingVmCount: 1,
      drainingVmCount: 0,
      locations: [
        {
          region: 'us-east-1',
          zone: null,
          vmType: 't3.large',
          releasing: null,
        },
      ],
    });
  });
});
