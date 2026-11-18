import { describe, expect, it, vi } from 'vitest';
import type { V1Job, V1Pod } from '@kubernetes/client-node';

import {
  createHostStepExecutor,
  HOST_STEP_ENTRYPOINT,
  hostStepJob,
  observeHostStep,
  type HostStepRequest,
} from '../../../../src/api/services/system-release/host-step.js';
import { CONTROL_PLANE_TAINT_KEY } from '../../../../src/shared/system-release.js';
import {
  MANAGEMENT_NODE_NAME,
  SYSTEM_RELEASE_NAMESPACE,
} from '../../../../src/shared/system-release.js';

const IMAGE = `ghcr.io/anycloud-sh/api:0.1.74@sha256:${'b'.repeat(64)}`;
const request: HostStepRequest = {
  id: 'step0001',
  image: IMAGE,
  step: {
    kind: 'kubernetes',
    publicIp: '203.0.113.5',
    issuerUrl: 'https://c-1.anycloud.sh',
  },
};

function pod(message: string | null, finishedAt = new Date(0)): V1Pod {
  return {
    status: {
      containerStatuses: [
        {
          name: 'host-step',
          image: IMAGE,
          imageID: '',
          ready: false,
          restartCount: 0,
          state:
            message === null
              ? { running: {} }
              : { terminated: { exitCode: 0, message, finishedAt } },
        },
      ],
    },
  };
}

describe('host-step Job (RFC 0049 C26 (b))', () => {
  it('runs privileged with the host PID namespace on the management Node only, with no API credential', () => {
    const job = hostStepJob(request);
    const spec = job.spec!.template.spec!;
    const [container] = spec.containers;
    expect(job.metadata).toMatchObject({
      name: 'anycloud-host-kubernetes-step0001',
      namespace: SYSTEM_RELEASE_NAMESPACE,
    });
    expect(spec).toMatchObject({
      nodeName: MANAGEMENT_NODE_NAME,
      hostPID: true,
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      tolerations: [
        {
          key: CONTROL_PLANE_TAINT_KEY,
          operator: 'Exists',
          effect: 'NoSchedule',
        },
      ],
    });
    // The user-namespace policy (C32) matches only Pods on its runtime class.
    expect(spec).not.toHaveProperty('runtimeClassName');
    expect(spec).not.toHaveProperty('hostUsers');
    expect(container).toMatchObject({
      image: IMAGE,
      command: ['node', HOST_STEP_ENTRYPOINT],
      securityContext: { privileged: true },
      terminationMessagePolicy: 'File',
      env: [
        { name: 'ANYCLOUD_HOST_STEP', value: 'kubernetes' },
        {
          name: 'ANYCLOUD_HOST_STEP_UNIT',
          value: 'anycloud-host-kubernetes-step0001',
        },
        { name: 'ANYCLOUD_MANAGEMENT_PUBLIC_IP', value: '203.0.113.5' },
        { name: 'ANYCLOUD_ISSUER_URL', value: 'https://c-1.anycloud.sh' },
      ],
    });
    expect(() => hostStepJob({ ...request, id: 'Not-Valid' })).toThrow(
      'lowercase letters or digits',
    );
  });

  it("reports a Pod's result whatever its exit, and a Job that failed without one", () => {
    const job: V1Job = {
      metadata: { labels: { 'anycloud.sh/host-step-id': 'step0001' } },
      status: { startTime: new Date('2026-11-07T10:00:00Z') },
    };
    expect(observeHostStep(job, [pod(null)])).toEqual({
      state: 'running',
      id: 'step0001',
      startedAt: '2026-11-07T10:00:00.000Z',
      waiting: null,
    });
    // A Pod that can't start says why while the Job waits for its deadline.
    const pulling = pod(null);
    pulling.status!.containerStatuses![0]!.state = {
      waiting: {
        reason: 'ImagePullBackOff',
        message: 'Back-off pulling image',
      },
    };
    expect(observeHostStep(job, [pulling])).toMatchObject({
      state: 'running',
      waiting: 'ImagePullBackOff: Back-off pulling image',
    });
    // A second Pod reported the first one's unit result.
    expect(
      observeHostStep(job, [
        pod('the host step runner exited 1: no nsenter'),
        pod('code=75\nconfiguration=changed\ntimed out\n'),
      ]),
    ).toMatchObject({
      state: 'finished',
      result: { code: 75, output: 'configuration=changed\ntimed out\n' },
    });
    const failed: V1Job = {
      ...job,
      status: {
        ...job.status,
        conditions: [
          {
            type: 'Failed',
            status: 'True',
            reason: 'BackoffLimitExceeded',
            message: 'Job has reached the specified backoff limit',
          },
        ],
      },
    };
    expect(
      observeHostStep(failed, [pod('the host step runner exited 1: denied')]),
    ).toMatchObject({
      state: 'failed',
      reason:
        'BackoffLimitExceeded: Job has reached the specified backoff limit: the host step runner exited 1: denied',
    });
    // A Pod that never started gives its wait as the reason.
    expect(observeHostStep(failed, [pulling])).toMatchObject({
      state: 'failed',
      reason:
        'BackoffLimitExceeded: Job has reached the specified backoff limit: ImagePullBackOff: Back-off pulling image',
    });
  });

  it('creates the Job once per id, and reads the newest of a kind', async () => {
    const conflict = Object.assign(new Error('exists'), { code: 409 });
    const created = hostStepJob(request);
    const batch = {
      createNamespacedJob: vi
        .fn()
        .mockResolvedValueOnce(created)
        .mockRejectedValue(conflict),
      readNamespacedJob: vi.fn().mockResolvedValue(created),
      listNamespacedJob: vi.fn().mockResolvedValue({
        items: [
          { metadata: { name: 'old', creationTimestamp: new Date(1) } },
          { metadata: { name: 'new', creationTimestamp: new Date(2) } },
        ],
      }),
    };
    const core = {
      listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
    };
    const clients: Parameters<typeof createHostStepExecutor>[0] = {
      batch,
      core,
    };
    const executor = createHostStepExecutor(clients);

    await executor.run(request);
    // A later poll finds the Job the first one created.
    await executor.run(request);
    expect(batch.readNamespacedJob).toHaveBeenCalledExactlyOnceWith({
      name: 'anycloud-host-kubernetes-step0001',
      namespace: SYSTEM_RELEASE_NAMESPACE,
    });
    expect(batch.createNamespacedJob).toHaveBeenCalledWith({
      namespace: SYSTEM_RELEASE_NAMESPACE,
      body: created,
    });
    expect(core.listNamespacedPod).toHaveBeenCalledWith({
      namespace: SYSTEM_RELEASE_NAMESPACE,
      labelSelector:
        'batch.kubernetes.io/job-name=anycloud-host-kubernetes-step0001',
    });

    // A step never started, or no longer kept, is none.
    batch.readNamespacedJob.mockRejectedValueOnce(
      Object.assign(new Error('not found'), { code: 404 }),
    );
    await expect(executor.get('kubernetes', 'step0009')).resolves.toBeNull();

    await executor.latest('kubernetes');
    expect(batch.listNamespacedJob).toHaveBeenCalledWith({
      namespace: SYSTEM_RELEASE_NAMESPACE,
      labelSelector: 'anycloud.sh/host-step=kubernetes',
    });
    expect(core.listNamespacedPod).toHaveBeenLastCalledWith({
      namespace: SYSTEM_RELEASE_NAMESPACE,
      labelSelector: 'batch.kubernetes.io/job-name=new',
    });
  });
});
