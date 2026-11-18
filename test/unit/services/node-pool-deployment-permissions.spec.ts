import { claimSpendBlock } from '../../../src/api/services/spend-controls.js';
import { describe, expect, it, vi } from 'vitest';
import { WorkloadState } from '../../../src/shared/workload.js';
import type { V1Pod, V1TokenReview } from '@kubernetes/client-node';
import { createDeploymentController } from '../../../src/api/services/deployment-controller.js';
import { createDeploymentWorkloadDomain } from '../../../src/api/services/deployment-workload-domain.js';
import type { StoredDeployment } from '../../../src/api/services/deployment-store.js';
import { ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE } from '../../../src/api/services/kubernetes/pool-objects.js';
import { kubernetesWorkloadResourceName } from '../../../src/api/services/kubernetes/identity.js';
import { deleteNodePoolNamespace } from '../../../src/api/services/kubernetes/node-pool-namespace.js';
import { nodePoolNamespace } from '../../../src/api/services/kubernetes/node-pool-scheduling.js';
import { CLUSTER_PERMISSIONS } from '../../../src/api/services/kubernetes/cluster-runtime.js';
import type { NodePoolKubernetesRuntime } from '../../../src/api/services/kubernetes/deployment-runtime.js';
import type { TargetedExecutionIdentity } from '../../../src/api/services/repositories/deployment-executions.js';
import {
  FakeKubernetesCluster,
  type FakeKubernetesCall,
} from '../helpers/fake-kubernetes-cluster.js';
import {
  makeContainerSpec,
  makeClusterKubernetesClientFixture,
  makeReplicaPolicyDependencies,
} from '../helpers/fixtures.js';
import {
  getPersistence,
  resetPersistence,
} from '../../../src/api/services/persistence.js';

const clusterId = 'cluster-a';
const nodePoolId = 'node-pool-aws-east';
const namespace = nodePoolNamespace(nodePoolId);
const nodePool = { clusterId, nodePoolId, nvidiaGpusPerNode: 0 };

const deployment: StoredDeployment = {
  id: 'deployment-a',
  ownerUserId: 'owner',
  name: 'handler',
  nodePoolId,
  config: makeContainerSpec({
    image: 'ghcr.io/example/handler:latest',
    registryToken: 'gh-token',
  }),
  secretNames: [],
  readinessProbe: null,
  gracePeriodSeconds: 30,
  gpuCount: 0,
  maxConcurrentJobsPerReplica: 1,
  minReplicas: 1,
  maxReplicas: 1,
  managed: false,
  runnerRelease: null,
  generation: 1,
  deletionRequestedAt: null,
  deletedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

/** The SSAR attributes a recorded fake call corresponds to. */
function permissionFor(call: FakeKubernetesCall): string {
  const resources: Record<string, { group: string; resource: string }> = {
    Namespace: { group: '', resource: 'namespaces' },
    Secret: { group: '', resource: 'secrets' },
    ServiceAccount: { group: '', resource: 'serviceaccounts' },
    Deployment: { group: 'apps', resource: 'deployments' },
    Pod: { group: '', resource: 'pods' },
    Node: { group: '', resource: 'nodes' },
    NetworkPolicy: { group: 'networking.k8s.io', resource: 'networkpolicies' },
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
  const { group, resource } = resources[call.kind];
  // A log read is the `pods/log` subresource, not `get pods`.
  return `${verbs[call.op]} ${group} ${resource}${call.op === 'log' ? '/log' : ''}`;
}

describe('node pool Deployment cluster permissions', () => {
  it('declares every verb admission, namespace, handler, next_job() authentication and cleanup exercise', async () => {
    const cluster = new FakeKubernetesCluster();
    const used = new Set<string>();
    const createTokenReview = vi.fn(async (): Promise<V1TokenReview> => {
      used.add('create authentication.k8s.io tokenreviews');
      return {
        spec: { token: 'token' },
        status: {
          authenticated: true,
          audiences: [ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE],
          user: {
            username: `system:serviceaccount:${namespace}:${kubernetesWorkloadResourceName('deployment', deployment.id)}`,
            extra: {
              'authentication.kubernetes.io/pod-uid': ['pod-a'],
              'authentication.kubernetes.io/pod-name': ['pod-a'],
            },
          },
        },
      };
    });
    const client = makeClusterKubernetesClientFixture({
      ...cluster.client(),
      authentication: { createTokenReview },
      authorization: {
        createSelfSubjectAccessReview: vi.fn(async () => ({
          status: { allowed: true },
        })),
      },
    });
    const runtime: NodePoolKubernetesRuntime = {
      config: { namespace },
      cluster: client,
      nodePool,
    };
    let stored: StoredDeployment = deployment;
    const executions: TargetedExecutionIdentity[] = [];
    const controller = createDeploymentController({
      deployments: {
        getById: async () => stored,
        listForReconciliation: async () => [deployment.id],
        advanceGeneration: async () => false,
        recordRunnerRelease: async () => undefined,
        recordOccupancy: async () => undefined,
        requestIdleDeletion: async () => false,
        markDeleted: async () => {
          stored = { ...stored, deletedAt: 2 };
          return true;
        },
      },
      replicas: makeReplicaPolicyDependencies(),
      jobs: {
        countTargetedJobs: async () => ({
          queued: 0,
          running: 0,
          retrying: 0,
          terminal: 0,
          unreleased: 0,
        }),
        listTargetedExecutions: async () => executions,
        reportTargetedJobExecution: async () => true,
        recordPodNode: async () => undefined,
        recordAttemptLogTail: async () => undefined,
        closeReplica: () => undefined,
        wasForcedStop: () => false,
        completeTargetedJobCleanup: async () => true,
        terminateUnassignedTargetedJobs: async () => undefined,
      },
      secrets: { getSecretValues: async () => null },
      runtimes: { resolve: async () => runtime },
      clusters: { resolve: async () => ({ cluster: client }) },
      workloadApiUrl: 'https://api.example.test',
    });

    // Admission: namespace ensured, then the per-target RBAC preflight.
    await controller.validateTarget({ kind: 'nodePool', nodePoolId });
    // The loop lists and watches its caches, and its first pass creates.
    await controller.start();
    await vi.waitFor(() =>
      expect(
        cluster.calls.some(
          (call) => call.op === 'create' && call.kind === 'Deployment',
        ),
      ).toBe(true),
    );
    // Out-of-band drift on the native Deployment is applied back.
    const created = [...cluster.objects.values()].find(
      (object) => object.kind === 'Deployment',
    )!;
    cluster.seed({
      ...created,
      kind: 'Deployment',
      spec: { ...(created.spec as object), replicas: 0 },
    });
    await vi.waitFor(() =>
      expect(
        cluster.calls.some(
          (call) => call.op === 'apply' && call.kind === 'Deployment',
        ),
      ).toBe(true),
    );
    // A recorded execution whose Pod the cache lacks is confirmed directly.
    executions.push({
      jobId: 'job-a',
      executionId: 'execution-a',
      deploymentId: deployment.id,
      generation: 1,
      podUid: 'pod-gone',
      containerId: 'containerd://gone',
      state: WorkloadState.Completed,
      cleanedAt: null,
      openedAt: 1,
      endedAt: null,
    });
    const template = created;
    cluster.pods = [
      {
        metadata: {
          name: 'pod-a',
          namespace,
          uid: 'pod-a',
          labels: template.metadata?.labels,
          annotations: {
            ...template.metadata?.annotations,
            'anycloud.sh/generation': '1',
          },
        },
        status: {
          phase: 'Running',
          containerStatuses: [
            {
              name: 'workload',
              ready: true,
              containerID: 'containerd://c',
              image: 'i',
              imageID: 'i',
              restartCount: 0,
            },
          ],
        },
      } satisfies V1Pod,
    ];
    await vi.waitFor(() =>
      expect(
        cluster.calls.some(
          (call) => call.op === 'list' && call.namespace === namespace,
        ),
      ).toBe(true),
    );
    await controller.observe(stored);
    // next_job() authentication through the node pool namespace.
    resetPersistence();
    const domain = createDeploymentWorkloadDomain({
      reconcile: () => undefined,
      jobChanges: getPersistence().jobChanges,
      claimSpendBlock,
      mintStorage: async () => ({}),
      deployments: {
        getMetadataById: async () => ({
          id: deployment.id,
          nodePoolId,
          managed: false,
          runnerRelease: null,
          deletionRequestedAt: null,
          deletedAt: null,
        }),
      },
      jobs: {
        discoverTargetedJob: async () => ({ kind: 'empty' as const }),
        podHasClaimed: vi.fn().mockResolvedValue(false),
        listTargetedExecutions: vi.fn().mockResolvedValue([]),
        claimTargetedJob: vi.fn(),
        getTargetedExecution: vi.fn(),
        reportTargetedJobExecution: vi.fn(),
        completeTargetedJobCleanup: vi.fn(),
        reportTargetedJobPhase: vi.fn(),
        getTargetedJobSpec: vi.fn(),
        recordAttemptLogTail: vi.fn(),
        closeReplica: vi.fn(),
      },
      runtimes: { resolve: async () => runtime },
    });
    await expect(
      domain.candidate(deployment.id, 0, 'Bearer token'),
    ).resolves.toEqual({ status: 204 });
    // Cleanup: drain and delete the handler, then the node pool namespace.
    stored = { ...stored, deletionRequestedAt: 2 };
    controller.schedule(deployment.id);
    // Foreground deletion removes the replicas, then the native Deployment.
    await vi.waitFor(() =>
      expect(
        cluster.calls.some(
          (call) => call.op === 'delete' && call.kind === 'Deployment',
        ),
      ).toBe(true),
    );
    cluster.pods = [];
    await vi.waitFor(() => expect(stored.deletedAt).toBe(2));
    await controller.stop();
    await expect(
      deleteNodePoolNamespace(client.core, { clusterId, nodePoolId }),
    ).resolves.toBe('deleted');

    for (const call of cluster.calls) used.add(permissionFor(call));
    const declared = new Set(
      CLUSTER_PERMISSIONS.filter((rule) => !rule.namespace).map(
        (rule) =>
          `${rule.verb} ${rule.group} ${rule.resource}${rule.subresource ? `/${rule.subresource}` : ''}`,
      ),
    );
    expect(used).toContain('create  namespaces');
    expect(used).toContain('delete  namespaces');
    expect(used).toContain('create  serviceaccounts');
    expect(used).toContain('patch apps deployments');
    expect(used).toContain('delete apps deployments');
    expect(used).toContain('list  pods');
    for (const resource of ['pods', 'secrets', 'serviceaccounts', 'nodes'])
      expect(used).toContain(`watch  ${resource}`);
    expect(used).toContain('watch apps deployments');
    expect(used).toContain('create authentication.k8s.io tokenreviews');
    expect([...used].filter((key) => !declared.has(key))).toEqual([]);
  });
});
