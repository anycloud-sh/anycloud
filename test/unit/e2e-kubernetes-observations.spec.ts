import { afterEach, describe, expect, test, vi } from 'vitest';
import { KubeConfig } from '@kubernetes/client-node';

import { createKubernetesClients } from '../../src/api/services/kubernetes/client.js';
import { nodePoolNamespace } from '../../src/api/services/kubernetes/node-pool-scheduling.js';
import {
  KubernetesWorkloadObservations,
  deploymentReceiveObservation,
} from '../integration/e2e/internal/kubernetes-observations.js';

const nodePoolId = 'pool-one-id';
const namespace = nodePoolNamespace(nodePoolId);

afterEach(() => vi.restoreAllMocks());

describe('node pool Deployment replacement process evidence', () => {
  const ready = {
    availableReplicas: 1,
    containerId: 'containerd://replacement',
    workloadName: 'deployment',
    generation: 2,
    podName: 'replacement-pod',
    podUid: 'replacement-uid',
    nodeName: 'replacement-node',
    imageId: `docker-pullable://fixture@sha256:${'a'.repeat(64)}`,
    runtimeClassName: null,
    requestedGpus: 0,
  };

  function fixture() {
    const kubeConfig = new KubeConfig();
    kubeConfig.loadFromOptions({
      clusters: [{ name: 'test', server: 'https://kubernetes.example.test' }],
      users: [{ name: 'test' }],
      contexts: [{ name: 'test', cluster: 'test', user: 'test' }],
      currentContext: 'test',
    });
    const clients = createKubernetesClients(kubeConfig);
    const readLog = vi.spyOn(clients.core, 'readNamespacedPodLog');
    const listPods = vi
      .spyOn(clients.core, 'listNamespacedPod')
      .mockResolvedValue({
        items: [
          {
            metadata: { name: ready.podName, uid: ready.podUid },
            status: { conditions: [{ type: 'Ready', status: 'False' }] },
          },
        ],
      });
    const deletePod = vi
      .spyOn(clients.core, 'deleteNamespacedPod')
      .mockResolvedValue({});
    const observations = new KubernetesWorkloadObservations(
      async () => clients,
    );
    vi.spyOn(
      KubernetesWorkloadObservations.prototype,
      'deploymentReady',
    ).mockResolvedValue(ready);
    return { readLog, listPods, deletePod, observations };
  }

  test('deletes the observed Pod when readiness is lost before fault injection', async () => {
    const { deletePod, observations } = fixture();
    vi.mocked(observations.deploymentReady).mockResolvedValue(null);

    await expect(
      observations.deleteReadyPod(nodePoolId, 'deployment', ready.podUid),
    ).resolves.toBe(ready.podUid);
    expect(deletePod).toHaveBeenCalledExactlyOnceWith({
      namespace,
      name: ready.podName,
      body: { preconditions: { uid: ready.podUid } },
    });
  });

  test('does not substitute a newly Ready Pod for the observed fault target', async () => {
    const { listPods, deletePod, observations } = fixture();
    const replacement = { ...ready, podName: 'other-pod', podUid: 'other-uid' };
    vi.mocked(observations.deploymentReady).mockResolvedValue(replacement);
    listPods.mockResolvedValue({
      items: [
        {
          metadata: { name: replacement.podName, uid: replacement.podUid },
          status: { conditions: [{ type: 'Ready', status: 'True' }] },
        },
      ],
    });

    await expect(
      observations.deleteReadyPod(nodePoolId, 'deployment', ready.podUid),
    ).rejects.toThrow('no Pod at observed UID');
    expect(deletePod).not.toHaveBeenCalled();
  });

  test('0036/S6 reads exact markers from the identified container even during warmup', async () => {
    const { readLog, observations } = fixture();
    readLog.mockResolvedValue(
      'configuration:other-job:updated\nconfiguration:probe:updated-extra\n',
    );

    await expect(
      observations.deploymentLogContains(
        nodePoolId,
        'deployment',
        ready.podUid,
        'configuration:probe:updated',
      ),
    ).resolves.toBe(false);
    readLog.mockResolvedValue(
      'started:probe\r\nconfiguration:probe:updated\r\n',
    );
    await expect(
      observations.deploymentLogContains(
        nodePoolId,
        'deployment',
        ready.podUid,
        'configuration:probe:updated',
      ),
    ).resolves.toBe(true);
    expect(readLog).toHaveBeenLastCalledWith(
      {
        namespace,
        name: ready.podName,
        container: 'workload',
      },
      expect.objectContaining({ middlewareMergeStrategy: 'append' }),
    );
  });

  test('0036/S6 does not accept evidence from a different Pod identity', async () => {
    const { readLog, observations } = fixture();

    await expect(
      observations.deploymentLogContains(
        nodePoolId,
        'deployment',
        'different-pod-uid',
        'configuration:probe:updated',
      ),
    ).resolves.toBe(false);
    expect(readLog).not.toHaveBeenCalled();
  });

  test('correlates the original receive with its probe result while retaining the next idle receive', () => {
    const logs = [
      'RECEIVE_STARTED {"sequence":1,"startedAt":1000}',
      'receive-wait:20',
      'RECEIVE_FINISHED {"sequence":1,"returnedAt":2450,"jobId":"queued","probeSucceededAt":2400}',
      'RECEIVE_STARTED {"sequence":2,"startedAt":2451}',
    ].join('\n');
    expect(deploymentReceiveObservation(logs, 2500)).toEqual({
      sequence: 2,
      startedAt: 2451,
      returnedAt: null,
      jobId: null,
      probeSucceededAt: null,
      observedAt: 2500,
    });
    expect(deploymentReceiveObservation(logs, 2500, 'queued')).toEqual({
      sequence: 1,
      startedAt: 1000,
      returnedAt: 2450,
      jobId: 'queued',
      probeSucceededAt: 2400,
      observedAt: 2500,
    });
    expect(deploymentReceiveObservation(logs, 2500, 'different')).toBeNull();
  });

  test('reads bounded receive evidence during warmup and rejects a replaced Pod', async () => {
    const { readLog, observations } = fixture();
    readLog.mockResolvedValue(
      'RECEIVE_STARTED {"sequence":1,"startedAt":1000}\n',
    );
    await expect(
      observations.deploymentReceive(nodePoolId, 'deployment', ready.podUid),
    ).resolves.toMatchObject({ startedAt: 1000, returnedAt: null });
    expect(readLog).toHaveBeenCalledWith(
      {
        namespace,
        name: ready.podName,
        container: 'workload',
        tailLines: 200,
      },
      expect.objectContaining({
        middleware: expect.any(Array),
        middlewareMergeStrategy: 'append',
      }),
    );
    readLog.mockClear();
    await expect(
      observations.deploymentReceive(nodePoolId, 'deployment', 'replaced'),
    ).resolves.toBeNull();
    expect(readLog).not.toHaveBeenCalled();
  });

  test('cannot qualify a receive whose start fell outside the bounded log tail', () => {
    expect(
      deploymentReceiveObservation(
        'RECEIVE_FINISHED {"sequence":1,"returnedAt":2450,"jobId":"queued","probeSucceededAt":2400}',
        2500,
        'queued',
      ),
    ).toBeNull();
    expect(() =>
      deploymentReceiveObservation(
        'RECEIVE_STARTED {"sequence":1,"startedAt":"unknown"}',
        2500,
      ),
    ).toThrow('Invalid Deployment receive start');
  });
});

describe('node pool Service Pod readiness time', () => {
  test('reads the earliest Ready=True transition of the Service Pods, or null', async () => {
    const kubeConfig = new KubeConfig();
    kubeConfig.loadFromOptions({
      clusters: [{ name: 'test', server: 'https://kubernetes.example.test' }],
      users: [{ name: 'test' }],
      contexts: [{ name: 'test', cluster: 'test', user: 'test' }],
      currentContext: 'test',
    });
    const clients = createKubernetesClients(kubeConfig);
    const observations = new KubernetesWorkloadObservations(
      async () => clients,
    );
    const ready = (at: number) => ({
      status: {
        conditions: [
          { type: 'Ready', status: 'False' },
          { type: 'Ready', status: 'True', lastTransitionTime: new Date(at) },
        ],
      },
    });
    const listPods = vi
      .spyOn(clients.core, 'listNamespacedPod')
      .mockResolvedValueOnce({ items: [ready(20_000), ready(10_000)] })
      .mockResolvedValueOnce({ items: [] });
    expect(await observations.servicePodReadyAt(nodePoolId, 'd-svc')).toBe(
      10_000,
    );
    expect(
      await observations.servicePodReadyAt(nodePoolId, 'd-svc'),
    ).toBeNull();
    expect(listPods.mock.calls[0]?.[0]).toMatchObject({
      namespace: expect.stringContaining('serve'),
    });
  });
});
