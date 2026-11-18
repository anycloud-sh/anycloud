import type { Writable } from 'node:stream';
import {
  ApiException,
  type V1ContainerStatus,
  type V1Pod,
} from '@kubernetes/client-node';
import { describe, expect, it, vi } from 'vitest';
import type { StoredDeployment } from '../../../../src/api/services/deployment-store.js';
import { createNodePoolLogs } from '../../../../src/api/services/job/node-pool-logs.js';
import type { JobOperationStream } from '../../../../src/api/services/job/operations.js';
import {
  ClusterIdentityChangedError,
  ClusterPermissionError,
} from '../../../../src/api/services/kubernetes/cluster-runtime.js';
import { NodePoolRuntimeUnavailableError } from '../../../../src/api/services/kubernetes/deployment-runtime.js';
import {
  kubernetesWorkloadPodSelector,
  kubernetesWorkloadResourceName,
} from '../../../../src/api/services/kubernetes/identity.js';
import { LOGS_CONTAINER_NOT_READY } from '../../../../src/shared/api-contract/native-schemas.js';
import {
  WorkloadState,
  WorkloadType,
} from '../../../../src/shared/workload.js';
import {
  makeClusterKubernetesClientFixture,
  makeContainerSpec,
  makeStoredWorkload,
} from '../../helpers/fixtures.js';

const deployment: StoredDeployment = {
  id: 'handler-1',
  ownerUserId: 'owner',
  name: 'handler',
  nodePoolId: 'pool-a',
  config: makeContainerSpec(),
  readinessProbe: null,
  gracePeriodSeconds: 30,
  secretNames: [],
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

const service = makeStoredWorkload({
  id: 'api-1',
  workloadType: WorkloadType.Service,
  nodePoolId: 'pool-a',
});

function pod(
  name: string,
  createdAt: number,
  container: Partial<V1ContainerStatus> = { state: { running: {} } },
): V1Pod {
  return {
    metadata: { name, creationTimestamp: new Date(createdAt) },
    status: {
      containerStatuses: [
        {
          name: 'workload',
          image: 'image',
          imageID: '',
          ready: false,
          restartCount: 0,
          ...container,
        },
      ],
    },
  };
}

/** A node pool cluster whose `pods/log` returns `current`, or `previous` for the run before. */
function fakeCluster(
  pods: V1Pod[],
  logs: { current?: string; previous?: string | Error } = {},
) {
  const listNamespacedPod = vi.fn(async (..._args: unknown[]) => ({
    items: pods,
  }));
  const log = vi.fn(async (...args: unknown[]) => {
    const previous = (args[4] as { previous: boolean }).previous;
    const body = previous ? logs.previous : logs.current;
    if (body instanceof Error) throw body;
    (args[3] as Writable).end(Buffer.from(body ?? ''));
    return new AbortController();
  });
  const cluster = makeClusterKubernetesClientFixture({
    core: { listNamespacedPod },
    log: { log },
  });
  const resolve = vi.fn(async () => ({
    config: { namespace: 'anycloud-pool-a' },
    cluster,
    nodePool: { clusterId: 'c', nodePoolId: 'pool-a', nvidiaGpusPerNode: 0 },
  }));
  const nodePoolLogs = createNodePoolLogs({ runtimes: { resolve } });
  return { logs: nodePoolLogs, listNamespacedPod, log, resolve };
}

async function run(
  preparation: ReturnType<ReturnType<typeof createNodePoolLogs>['deployment']>,
) {
  const prepared = await preparation;
  if (!prepared.ok) throw new Error(prepared.clientError);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stream: JobOperationStream = {
    signal: new AbortController().signal,
    onStdout: (chunk) => void stdout.push(chunk.toString()),
    onStderr: (chunk) => void stderr.push(chunk.toString()),
  };
  return { code: await prepared.run(stream), stdout, stderr };
}

describe('node pool logs', () => {
  it("reads a Deployment's newest Pod, Ready or not, in its node pool namespace", async () => {
    const fake = fakeCluster(
      [pod('old', 1, { ready: true, state: { running: {} } }), pod('new', 2)],
      { current: 'starting\n' },
    );

    await expect(run(fake.logs.deployment(deployment, true))).resolves.toEqual({
      code: 0,
      stdout: ['starting\n'],
      stderr: ['Showing Pod new, the newest of 2.\n'],
    });
    expect(fake.resolve).toHaveBeenCalledWith({
      kind: 'nodePool',
      nodePoolId: 'pool-a',
    });
    expect(fake.listNamespacedPod).toHaveBeenCalledWith(
      {
        namespace: 'anycloud-pool-a',
        labelSelector: kubernetesWorkloadPodSelector('handler-1'),
      },
      expect.anything(),
    );
    expect(fake.log).toHaveBeenCalledWith(
      'anycloud-pool-a',
      'new',
      'workload',
      expect.anything(),
      { follow: true, previous: false },
    );
  });

  it("reads a Service's Pod in the namespace the Service owns", async () => {
    const fake = fakeCluster([pod('api', 1)], { current: 'up\n' });

    await expect(run(fake.logs.service(service, false))).resolves.toMatchObject(
      {
        stdout: ['up\n'],
        stderr: [],
      },
    );
    expect(fake.listNamespacedPod).toHaveBeenCalledWith(
      {
        namespace: kubernetesWorkloadResourceName('serve', 'api-1'),
        labelSelector: kubernetesWorkloadPodSelector('api-1'),
      },
      expect.anything(),
    );
  });

  it("shows a crash-looping container's previous run when its current one is waiting", async () => {
    const fake = fakeCluster(
      [
        pod('handler', 1, {
          restartCount: 3,
          state: { waiting: { reason: 'CrashLoopBackOff' } },
        }),
      ],
      { previous: 'Traceback: boom\n' },
    );

    await expect(run(fake.logs.deployment(deployment, true))).resolves.toEqual({
      code: 0,
      stdout: ['Traceback: boom\n'],
      stderr: ['Previous run of Pod handler (restarts: 3), last 1 MiB:\n'],
    });
    // The waiting container has no current log to follow.
    expect(fake.log).toHaveBeenCalledTimes(1);
  });

  it('says so when the previous run is gone and still streams the current one', async () => {
    const fake = fakeCluster(
      [pod('handler', 1, { restartCount: 1, state: { running: {} } })],
      {
        current: 'again\n',
        previous: new Error('previous terminated container not found'),
      },
    );

    await expect(run(fake.logs.deployment(deployment, false))).resolves.toEqual(
      {
        code: 0,
        stdout: ['again\n'],
        stderr: [
          'Previous run of Pod handler (restarts: 1), last 1 MiB is unavailable: previous terminated container not found\n',
        ],
      },
    );
  });

  it('marks a missing or unstarted Pod not ready while the record is live', async () => {
    await expect(
      fakeCluster([]).logs.deployment(deployment, true),
    ).resolves.toEqual({
      ok: false,
      status: 409,
      code: LOGS_CONTAINER_NOT_READY,
      clientError:
        'Deployment handler-1 has no Pod; check anycloud deployment status handler-1.',
      telemetryError: 'No Pod',
      probeCount: 1,
    });
    const pulling = fakeCluster([
      pod('api', 1, {
        state: {
          waiting: {
            reason: 'ImagePullBackOff',
            message: 'pull access denied',
          },
        },
      }),
    ]);
    await expect(pulling.logs.service(service, false)).resolves.toMatchObject({
      status: 409,
      code: LOGS_CONTAINER_NOT_READY,
      clientError:
        "Service api-1's Pod api has not started (ImagePullBackOff: pull access denied); check anycloud status api-1.",
    });
  });

  it('makes a missing Pod final once the record has ended', async () => {
    const ended = { ...service, state: WorkloadState.Terminated };

    const result = await fakeCluster([]).logs.service(ended, true);

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result).not.toHaveProperty('code');
  });

  it("names the record when its node pool's cluster cannot be reached", async () => {
    const unresolved = createNodePoolLogs({
      runtimes: {
        resolve: async () => {
          throw new NodePoolRuntimeUnavailableError('pool-a', 'does not exist');
        },
      },
    });
    // A cached runtime resolves, then the Pod list fails.
    const unreachable = fakeCluster([]);
    unreachable.listNamespacedPod.mockRejectedValue(
      new Error('connect ETIMEDOUT'),
    );

    await expect(
      unresolved.deployment(deployment, false),
    ).resolves.toMatchObject({
      ok: false,
      status: 503,
      clientError:
        'Could not reach the cluster of Deployment handler-1: Node pool pool-a does not exist.',
    });
    await expect(
      unreachable.logs.deployment(deployment, false),
    ).resolves.toMatchObject({
      ok: false,
      status: 503,
      clientError:
        'Could not reach the cluster of Deployment handler-1: connect ETIMEDOUT.',
      code: LOGS_CONTAINER_NOT_READY,
    });
    // A deleted node pool, or an ended record, does not keep `--follow` waiting.
    await expect(
      unresolved.deployment(deployment, true),
    ).resolves.not.toHaveProperty('code');
    await expect(
      unreachable.logs.service(
        { ...service, state: WorkloadState.Terminated },
        true,
      ),
    ).resolves.not.toHaveProperty('code');
    await expect(
      unreachable.logs.deployment(
        { ...deployment, deletionRequestedAt: 1 },
        true,
      ),
    ).resolves.not.toHaveProperty('code');
  });

  it('waits out a Kubernetes API error but not a refused identity', async () => {
    const failing = (error: Error) => {
      const cluster = fakeCluster([]);
      cluster.listNamespacedPod.mockRejectedValue(error);
      return cluster.logs.service(service, true);
    };
    const status = (code: number, auditId: string) =>
      new ApiException(
        code,
        'error',
        JSON.stringify({
          kind: 'Status',
          message: 'etcdserver: leader changed.',
        }),
        { 'audit-id': auditId },
      );

    // The same reason on every poll, so `--follow` prints it once.
    const first = await failing(status(500, 'a'));
    const second = await failing(status(500, 'b'));
    expect(first).toMatchObject({
      status: 503,
      code: LOGS_CONTAINER_NOT_READY,
      clientError:
        'Could not reach the cluster of Service api-1: HTTP 500: etcdserver: leader changed.',
    });
    expect(second).toEqual(first);
    for (const refused of [
      new ApiException(403, 'Forbidden', undefined, {}),
      new ClusterPermissionError('cluster-a', ['list pods']),
      new ClusterIdentityChangedError('cluster-a'),
    ]) {
      await expect(failing(refused)).resolves.not.toHaveProperty('code');
    }
  });
});
