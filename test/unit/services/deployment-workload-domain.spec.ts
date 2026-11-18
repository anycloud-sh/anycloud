import { claimSpendBlock } from '../../../src/api/services/spend-controls.js';
import { getPersistence } from '../../../src/api/services/persistence.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { V1Pod } from '@kubernetes/client-node';

import { createDeploymentWorkloadDomain } from '../../../src/api/services/deployment-workload-domain.js';
import type { StoredDeployment } from '../../../src/api/services/deployment-store.js';
import {
  getDeploymentStore,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import * as secretCrypto from '../../../src/api/services/secret-crypto.js';
import { ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE } from '../../../src/api/services/kubernetes/pool-objects.js';
import { renderDeploymentObjects } from '../../../src/api/services/deployment-objects.js';
import {
  kubernetesWorkloadPodSelector,
  kubernetesWorkloadResourceName,
} from '../../../src/api/services/kubernetes/identity.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import {
  makeContainerSpec,
  makeClusterKubernetesClientFixture,
} from '../helpers/fixtures.js';
import { seedReadyNodePool } from '../helpers/node-pool-seed.js';

const candidate = { submissionRevision: 0, previousExecutionId: null };
/** The labels `kubernetesWorkloadPodSelector` selects. */
const podLabels = (deploymentId: string): Record<string, string> =>
  Object.fromEntries([kubernetesWorkloadPodSelector(deploymentId).split('=')]);
/** A projected token's TokenReview extras for its bound Pod. */
const boundTo = (pod: V1Pod) => ({
  'authentication.kubernetes.io/pod-uid': [pod.metadata!.uid!],
  'authentication.kubernetes.io/pod-name': [pod.metadata!.name!],
});
const nodePool = {
  clusterId: 'cluster-a',
  nodePoolId: 'node-pool-a',
  nvidiaGpusPerNode: 0,
};

describe('Deployment workload domain', () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([
    {
      name: 'current generation with external drift',
      generation: 2,
      result: {
        kind: 'selected',
        jobId: 'job-a',
        executionId: 'new-execution',
      },
    },
    {
      name: 'previous generation during drain',
      generation: 1,
      result: { kind: 'conflict' },
    },
  ])(
    '0036/S15 0036/S17 authenticates without configuration and forwards selection/replay results: $name',
    async ({ generation, result }) => {
      resetPersistence();
      const deployments = getDeploymentStore();
      const deployment = {
        id: 'deployment-a',
        ownerUserId: 'owner-a',
        name: 'deployment',
        nodePoolId: nodePool.nodePoolId,
        config: makeContainerSpec({
          env: { PRIVATE: 'environment-canary' },
          registryUsername: 'registry-user',
          registryToken: 'registry-canary',
        }),
        gpuCount: 0,
        maxConcurrentJobsPerReplica: 1,
      };
      await seedReadyNodePool({
        nodePoolId: nodePool.nodePoolId,
        ownerUserId: deployment.ownerUserId,
      });
      await deployments.create(deployment, { kind: 'api' });
      await deployments.update(
        { ...deployment, secretNames: [], expectedGeneration: 1 },
        { kind: 'api' },
      );
      const decrypt = vi
        .spyOn(secretCrypto, 'decryptSecret')
        .mockRejectedValue(
          new Error(
            'Deployment configuration must not be decrypted for authentication',
          ),
        );
      const query = vi.spyOn(getDB(), 'query');
      const config = { namespace: 'anycloud' };
      const pod: V1Pod = {
        metadata: {
          name: 'replica-a',
          uid: 'pod-a',
          labels: podLabels(deployment.id),
          annotations: { 'anycloud.sh/generation': String(generation) },
        },
        spec: {
          containers: [{ name: 'workload', image: 'externally-altered:image' }],
        },
        status: {
          phase: 'Running',
          containerStatuses: [
            {
              name: 'workload',
              ready: true,
              containerID: 'containerd://container-a',
              image: 'externally-altered:image',
              imageID: 'image-id',
              restartCount: 0,
            },
          ],
        },
      };
      const replayId = 'existing-execution';
      const claimTargetedJob = vi
        .fn()
        .mockResolvedValueOnce(result)
        .mockResolvedValueOnce({
          kind: 'selected',
          jobId: 'job-a',
          executionId: replayId,
        });
      const createTokenReview = vi.fn().mockResolvedValue({
        status: {
          authenticated: true,
          audiences: [ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE],
          user: {
            username: `system:serviceaccount:anycloud:${kubernetesWorkloadResourceName('deployment', deployment.id)}`,
            extra: boundTo(pod),
          },
        },
      });
      const listNamespacedPod = vi.fn();
      const readNamespacedPod = vi.fn().mockResolvedValue(pod);
      const readNamespacedDeployment = vi.fn();
      const cluster = makeClusterKubernetesClientFixture({
        authentication: { createTokenReview },
        core: { listNamespacedPod, readNamespacedPod },
        apps: { readNamespacedDeployment },
      });
      const domain = createDeploymentWorkloadDomain({
        reconcile: () => undefined,
        jobChanges: getPersistence().jobChanges,
        claimSpendBlock,
        mintStorage: async () => ({}),
        deployments,
        jobs: {
          discoverTargetedJob: vi.fn(),
          podHasClaimed: vi.fn().mockResolvedValue(false),
          listTargetedExecutions: vi.fn().mockResolvedValue([]),
          claimTargetedJob,
          getTargetedExecution: vi.fn(),
          reportTargetedJobExecution: vi.fn(),
          completeTargetedJobCleanup: vi.fn(),
          reportTargetedJobPhase: vi.fn(),
          getTargetedJobSpec: vi.fn(),
          recordAttemptLogTail: vi.fn(),
          closeReplica: vi.fn(),
        },
        runtimes: {
          resolve: vi.fn().mockResolvedValue({ config, cluster, nodePool }),
        },
      });
      if (result.kind === 'selected') {
        await expect(
          domain.claim(
            deployment.id,
            'job-a',
            'new-execution',
            candidate,
            'Bearer token',
          ),
        ).resolves.toEqual({ jobId: 'job-a', executionId: 'new-execution' });
      } else {
        await expect(
          domain.claim(
            deployment.id,
            'job-a',
            'new-execution',
            candidate,
            'Bearer token',
          ),
        ).rejects.toMatchObject({ statusCode: 409 });
      }
      expect(claimTargetedJob).toHaveBeenLastCalledWith({
        deploymentId: deployment.id,
        jobId: 'job-a',
        executionId: 'new-execution',
        ...candidate,
        generation,
        podUid: 'pod-a',
        containerId: 'containerd://container-a',
        ready: true,
        signal: undefined,
      });
      await expect(
        domain.claim(
          deployment.id,
          'job-a',
          replayId,
          candidate,
          'Bearer token',
        ),
      ).resolves.toEqual({ jobId: 'job-a', executionId: replayId });
      expect(claimTargetedJob).toHaveBeenLastCalledWith(
        expect.objectContaining({ executionId: replayId }),
      );
      expect(createTokenReview).toHaveBeenCalledWith(
        {
          body: {
            apiVersion: 'authentication.k8s.io/v1',
            kind: 'TokenReview',
            spec: {
              token: 'token',
              audiences: [ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE],
            },
          },
        },
        undefined,
      );
      // S12: each call reads only the bound Pod, never a LIST of replicas.
      expect(listNamespacedPod).not.toHaveBeenCalled();
      expect(readNamespacedPod).toHaveBeenCalledTimes(2);
      expect(readNamespacedPod).toHaveBeenCalledWith(
        { name: 'replica-a', namespace: 'anycloud' },
        undefined,
      );
      expect(readNamespacedDeployment).not.toHaveBeenCalled();
      expect(decrypt).not.toHaveBeenCalled();
      const deploymentReads = query.mock.calls.filter(([sql]) =>
        sql.includes('FROM deployments w'),
      );
      expect(deploymentReads).toHaveLength(2);
      for (const [sql] of deploymentReads) {
        expect(sql).not.toMatch(
          /\*|\b(?:image|command|docker_options|env|registry_username|registry_token)\b/,
        );
      }
    },
  );
  it('0029/S16 emits only Anycloud-owned Secrets, env in its own, without named Secrets', () => {
    const deployment: StoredDeployment = {
      readinessProbe: null,
      gracePeriodSeconds: 30,
      secretNames: [],
      id: 'target-a',
      ownerUserId: 'user-a',
      name: 'deployment',
      nodePoolId: nodePool.nodePoolId,
      config: makeContainerSpec({
        image: 'ghcr.io/user-a/deployment:latest',
        env: { MODEL: 'example' },
        registryUsername: 'user-a',
        registryToken: 'registry-token',
      }),
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

    const manifests = renderDeploymentObjects(
      deployment,
      'anycloud',
      'https://api.example.test',
      nodePool,
    );
    const container =
      manifests.kubernetesDeployment.spec?.template.spec?.containers[0];

    // Env travels in the application-env Secret; the registry token only
    // pulls the image and never reaches the container.
    const [registry, applicationEnv] = manifests.secrets;
    expect(container?.envFrom).toEqual([
      { secretRef: { name: applicationEnv?.metadata?.name } },
    ]);
    expect(applicationEnv?.stringData).toEqual({ MODEL: 'example' });
    expect(
      container?.env?.some((entry) => entry.name.startsWith('GITHUB_')),
    ).toBe(false);
    expect(manifests.secrets.map((secret) => secret.type)).toEqual([
      'kubernetes.io/dockerconfigjson',
      'Opaque',
    ]);
    expect(registry?.metadata?.name).toContain('registry-auth');
    expect(
      manifests.kubernetesDeployment.spec?.template.spec?.volumes?.some(
        (volume) =>
          volume.projected?.sources?.some(
            (source) =>
              source.serviceAccountToken?.audience ===
              ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE,
          ),
      ),
    ).toBe(true);
  });

  it('allows lifecycle calls but rejects new work from terminating or non-running Pods', async () => {
    const deployment: StoredDeployment = {
      readinessProbe: null,
      gracePeriodSeconds: 30,
      secretNames: [],
      id: 'target-a',
      ownerUserId: 'user-a',
      name: 'deployment',
      nodePoolId: nodePool.nodePoolId,
      config: makeContainerSpec({ image: 'busybox:latest' }),
      gpuCount: 0,
      maxConcurrentJobsPerReplica: 1,
      minReplicas: 1,
      maxReplicas: 1,
      managed: false,
      apiIdentity: false,
      runnerRelease: null,
      generation: 2,
      deletionRequestedAt: 3,
      deletedAt: null,
      createdAt: 1,
      updatedAt: 2,
    };
    const config = { namespace: 'anycloud' };
    const manifests = renderDeploymentObjects(
      deployment,
      config.namespace,
      'https://api.example.test',
      nodePool,
    );
    const executionId = '550e8400-e29b-41d4-a716-446655440000';
    const getTargetedExecution = vi.fn().mockResolvedValue({
      jobId: 'job-a',
      executionId,
      deploymentId: deployment.id,
      generation: 1,
      podUid: 'old-pod',
      containerId: 'containerd://old-container',
      state: WorkloadState.Running,
      cleanedAt: null,
    });
    const reportTargetedJobExecution = vi.fn().mockResolvedValue(true);
    const claimTargetedJob = vi.fn().mockResolvedValue({ kind: 'conflict' });
    const pod: V1Pod = {
      metadata: {
        name: 'old-replica',
        uid: 'old-pod',
        labels: podLabels(deployment.id),
        annotations: { 'anycloud.sh/generation': '1' },
        deletionTimestamp: new Date('2026-01-01T00:00:00Z'),
      },
      status: {
        phase: 'Running',
        containerStatuses: [
          {
            name: 'workload',
            ready: true,
            containerID: 'containerd://old-container',
            image: 'busybox:latest',
            imageID: 'busybox@sha256:test',
            restartCount: 0,
          },
        ],
      },
    };
    const domain = createDeploymentWorkloadDomain({
      reconcile: () => undefined,
      jobChanges: getPersistence().jobChanges,
      claimSpendBlock,
      mintStorage: async () => ({}),
      deployments: {
        getMetadataById: vi.fn().mockResolvedValue(deployment),
      },
      jobs: {
        getTargetedExecution,
        reportTargetedJobExecution,
        discoverTargetedJob: vi.fn(),
        podHasClaimed: vi.fn().mockResolvedValue(false),
        listTargetedExecutions: vi.fn().mockResolvedValue([]),
        claimTargetedJob,
        completeTargetedJobCleanup: vi.fn(),
        reportTargetedJobPhase: vi.fn(),
        getTargetedJobSpec: vi.fn(),
        recordAttemptLogTail: vi.fn(),
        closeReplica: vi.fn(),
      },
      runtimes: {
        resolve: vi.fn().mockResolvedValue({
          config,
          nodePool,
          cluster: {
            authentication: {
              createTokenReview: vi.fn().mockResolvedValue({
                status: {
                  authenticated: true,
                  audiences: [ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE],
                  user: {
                    username: `system:serviceaccount:${config.namespace}:${manifests.name}`,
                    extra: boundTo(pod),
                  },
                },
              }),
            },
            core: { readNamespacedPod: vi.fn().mockResolvedValue(pod) },
          },
        }),
      },
    });

    const reportOutcome = () =>
      domain.outcome(
        deployment.id,
        'job-a',
        {
          executionId,
          outcome: 'errored',
          message: 'application failed',
        },
        'Bearer workload-token',
      );

    await expect(reportOutcome()).resolves.toBeUndefined();
    await expect(
      domain.claim(
        deployment.id,
        'job-a',
        '9d6a8176-dfae-4c68-a18f-f28472727cb0',
        candidate,
        'Bearer workload-token',
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    pod.metadata = { ...pod.metadata, deletionTimestamp: undefined };
    pod.status = { ...pod.status, phase: 'Pending' };

    await expect(reportOutcome()).resolves.toBeUndefined();
    await expect(
      domain.claim(
        deployment.id,
        'job-a',
        'b50c4a67-ec1d-4c0a-9cf5-49d30198a850',
        candidate,
        'Bearer workload-token',
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(claimTargetedJob).toHaveBeenCalledTimes(2);
    expect(claimTargetedJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: false }),
    );
    expect(reportTargetedJobExecution).toHaveBeenCalledTimes(2);
    expect(reportTargetedJobExecution).toHaveBeenCalledWith(
      'job-a',
      executionId,
      {
        state: WorkloadState.Errored,
        reason: 'application failed',
      },
    );
  });

  it.each([
    {
      name: "another Deployment's ServiceAccount token",
      username: 'system:serviceaccount:anycloud:another-deployment',
      status: 403,
    },
    {
      // RFC 0049 invariant 2: a registered client's API token is never a
      // replica's.
      name: 'a token for the anycloud-api audience',
      audiences: ['anycloud-api'],
      status: 401,
    },
    {
      name: 'a Pod name reused by another Pod',
      read: (pod: V1Pod) => ({
        ...pod,
        metadata: { ...pod.metadata, uid: 'pod-b' },
      }),
      status: 409,
    },
    {
      name: "another workload's Pod",
      read: (pod: V1Pod) => ({
        ...pod,
        metadata: { ...pod.metadata, labels: podLabels('target-b') },
      }),
      status: 409,
    },
    {
      name: 'a deleted Pod',
      read: () => {
        throw Object.assign(new Error('pods "replica-a" not found'), {
          code: 404,
        });
      },
      status: 409,
    },
    {
      name: 'a token without a Pod name',
      extra: { 'authentication.kubernetes.io/pod-uid': ['pod-a'] },
      status: 401,
    },
    {
      name: 'a failed Pod read',
      read: () => {
        throw new Error('connection refused');
      },
      status: 503,
    },
    {
      // A runner's first call can beat kubelet's status update: it waits
      // unready, as a refusal would end it (S12 run 39881670340).
      name: 'a container kubelet has not reported yet',
      read: (pod: V1Pod) => ({
        ...pod,
        status: { phase: 'Pending', containerStatuses: [] },
      }),
      status: 204,
    },
  ])(
    'S12 reads only the bound Pod and answers $name with $status',
    async ({ username, audiences, read, extra, status }) => {
      const deployment: StoredDeployment = {
        readinessProbe: null,
        gracePeriodSeconds: 30,
        secretNames: [],
        id: 'target-a',
        ownerUserId: 'user-a',
        name: 'deployment',
        nodePoolId: nodePool.nodePoolId,
        config: makeContainerSpec({ image: 'busybox:latest' }),
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
      const pod: V1Pod = {
        metadata: {
          name: 'replica-a',
          uid: 'pod-a',
          labels: podLabels(deployment.id),
          annotations: { 'anycloud.sh/generation': '1' },
        },
        status: {
          phase: 'Running',
          containerStatuses: [
            {
              name: 'workload',
              ready: true,
              containerID: 'containerd://container-a',
              image: 'busybox:latest',
              imageID: 'image-id',
              restartCount: 0,
            },
          ],
        },
      };
      const discoverTargetedJob = vi.fn().mockResolvedValue({ kind: 'empty' });
      const readNamespacedPod = vi.fn(async () => (read ?? (() => pod))(pod));
      const domain = createDeploymentWorkloadDomain({
        reconcile: () => undefined,
        jobChanges: getPersistence().jobChanges,
        claimSpendBlock,
        mintStorage: async () => ({}),
        deployments: {
          getMetadataById: vi.fn().mockResolvedValue(deployment),
        },
        jobs: {
          getTargetedExecution: vi.fn(),
          reportTargetedJobExecution: vi.fn(),
          discoverTargetedJob,
          podHasClaimed: vi.fn().mockResolvedValue(false),
          listTargetedExecutions: vi.fn().mockResolvedValue([]),
          claimTargetedJob: vi.fn(),
          completeTargetedJobCleanup: vi.fn(),
          reportTargetedJobPhase: vi.fn(),
          getTargetedJobSpec: vi.fn(),
          recordAttemptLogTail: vi.fn(),
          closeReplica: vi.fn(),
        },
        runtimes: {
          resolve: vi.fn().mockResolvedValue({
            config: { namespace: 'anycloud' },
            nodePool,
            cluster: makeClusterKubernetesClientFixture({
              authentication: {
                createTokenReview: vi.fn().mockResolvedValue({
                  status: {
                    authenticated: true,
                    audiences: audiences ?? [ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE],
                    user: {
                      username:
                        username ??
                        `system:serviceaccount:anycloud:${kubernetesWorkloadResourceName('deployment', deployment.id)}`,
                      extra: extra ?? boundTo(pod),
                    },
                  },
                }),
              },
              core: { readNamespacedPod },
            }),
          }),
        },
      });

      const candidate = domain.candidate(
        deployment.id,
        0,
        'Bearer workload-token',
      );
      if (status === 204) {
        await expect(candidate).resolves.toEqual({ status });
        expect(discoverTargetedJob).toHaveBeenCalledWith(
          expect.objectContaining({ ready: false }),
        );
        return;
      }
      await expect(candidate).rejects.toMatchObject({ statusCode: status });
      expect(discoverTargetedJob).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: 'runtime resolution',
      resolve: vi.fn().mockRejectedValue(new Error('connection unavailable')),
    },
    {
      name: 'TokenReview',
      resolve: vi.fn().mockResolvedValue({
        config: { namespace: 'anycloud' },
        cluster: {
          authentication: {
            createTokenReview: vi
              .fn()
              .mockRejectedValue(new Error('review unavailable')),
          },
          core: { listNamespacedPod: vi.fn() },
        },
      }),
    },
  ])('maps $name failures to workload-unavailable', async ({ resolve }) => {
    const deployment: StoredDeployment = {
      readinessProbe: null,
      gracePeriodSeconds: 30,
      secretNames: [],
      id: 'target-a',
      ownerUserId: 'user-a',
      name: 'deployment',
      nodePoolId: nodePool.nodePoolId,
      config: makeContainerSpec({ image: 'busybox:latest' }),
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
    const domain = createDeploymentWorkloadDomain({
      reconcile: () => undefined,
      jobChanges: getPersistence().jobChanges,
      claimSpendBlock,
      mintStorage: async () => ({}),
      deployments: { getMetadataById: vi.fn().mockResolvedValue(deployment) },
      jobs: {
        getTargetedExecution: vi.fn(),
        reportTargetedJobExecution: vi.fn(),
        discoverTargetedJob: vi.fn(),
        podHasClaimed: vi.fn().mockResolvedValue(false),
        listTargetedExecutions: vi.fn().mockResolvedValue([]),
        claimTargetedJob: vi.fn(),
        completeTargetedJobCleanup: vi.fn(),
        reportTargetedJobPhase: vi.fn(),
        getTargetedJobSpec: vi.fn(),
        recordAttemptLogTail: vi.fn(),
        closeReplica: vi.fn(),
      },
      runtimes: { resolve },
    });

    await expect(
      domain.claim(
        deployment.id,
        'job-a',
        '9d6a8176-dfae-4c68-a18f-f28472727cb0',
        candidate,
        'Bearer workload-token',
      ),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});
