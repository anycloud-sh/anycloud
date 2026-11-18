import type { V1Pod, V1PodStatus } from '@kubernetes/client-node';
import { describe, expect, it, vi } from 'vitest';
import { GPU_PROBE } from '../../../../src/api/services/host-runtime/gpu-probe.js';
import {
  checkNodeGpus,
  NODE_GPU_CHECK_IMAGE,
} from '../../../../src/api/services/kubernetes/node-gpu-check.js';
import { NVIDIA_RUNTIME_CLASS } from '../../../../src/api/services/kubernetes/nvidia-device-plugin.js';

const replica: V1Pod = {
  metadata: { name: 'replica-a', uid: 'uid-a', namespace: 'pool-ns' },
  spec: { nodeName: 'node-a', containers: [] },
};
const passed = 'GPU 0: NVIDIA H100 (UUID: GPU-1)\nCUresult 0\nexit=0';

/** A Kubernetes API whose check Pod reports `statuses` in turn, then the last. */
function api(statuses: V1PodStatus[], log = passed) {
  let read = 0;
  return {
    createNamespacedPod: vi.fn(async ({ body }: { body: V1Pod }) => body),
    readNamespacedPod: vi.fn(async () => ({
      status: statuses[Math.min(read++, statuses.length - 1)],
    })),
    readNamespacedPodLog: vi.fn(async () => log),
    deleteNamespacedPod: vi.fn(async (_target: unknown) => ({})),
  };
}

const check = (core: ReturnType<typeof api>, timeoutMs = 1_000) =>
  checkNodeGpus(core as never, replica, 'EXEC-1', { timeoutMs, pollMs: 1 });

describe('checkNodeGpus', () => {
  it("runs the VM path's probe on the replica's Node over every GPU, owned by the replica, and deletes it after", async () => {
    const core = api([{ phase: 'Pending' }, { phase: 'Succeeded' }]);
    await expect(check(core)).resolves.toEqual({ verdict: 'healthy' });
    const { namespace, body } = core.createNamespacedPod.mock.calls[0]![0] as {
      namespace: string;
      body: V1Pod;
    };
    expect(namespace).toBe('pool-ns');
    expect(body.metadata).toMatchObject({
      name: 'anycloud-gpu-check-exec-1',
      ownerReferences: [{ kind: 'Pod', name: 'replica-a', uid: 'uid-a' }],
    });
    expect(body.spec).toMatchObject({
      nodeName: 'node-a',
      tolerations: [{ operator: 'Exists' }],
      runtimeClassName: NVIDIA_RUNTIME_CLASS,
      restartPolicy: 'Never',
    });
    const [container] = body.spec!.containers;
    expect(container).toMatchObject({
      image: NODE_GPU_CHECK_IMAGE,
      command: ['/bin/sh', '-c', GPU_PROBE],
      env: expect.arrayContaining([
        { name: 'NVIDIA_VISIBLE_DEVICES', value: 'all' },
      ]),
    });
    // No GPU request: the replicas may hold every allocatable GPU.
    expect(container!.resources).toBeUndefined();
    expect(core.deleteNamespacedPod.mock.calls[0]![0]).toEqual({
      name: 'anycloud-gpu-check-exec-1',
      namespace: 'pool-ns',
    });
  });

  it('waits on the existing check when a retried report finds it created', async () => {
    const core = api([{ phase: 'Succeeded' }]);
    core.createNamespacedPod.mockRejectedValue(
      Object.assign(new Error('exists'), { code: 409 }),
    );
    await expect(check(core)).resolves.toEqual({ verdict: 'healthy' });
  });

  it.each([
    ['lists no GPU', 'No devices were found\nexit=9'],
    ['fails a CUDA context', 'GPU 0: NVIDIA H100\nCUresult 46\nexit=46'],
  ])('finds the GPUs unusable when the probe %s', async (_name, log) => {
    await expect(check(api([{ phase: 'Succeeded' }], log))).resolves.toEqual({
      verdict: 'unusable',
      detail: log,
    });
  });

  it("finds the GPUs unusable when the NVIDIA hook can't start the container", async () => {
    const message =
      'nvidia-container-cli: initialization error: nvml error: unknown error';
    const core = api([
      {
        phase: 'Pending',
        containerStatuses: [
          {
            name: 'gpu-check',
            image: '',
            imageID: '',
            ready: false,
            restartCount: 0,
            state: { waiting: { reason: 'RunContainerError', message } },
          },
        ],
      },
    ]);
    await expect(check(core)).resolves.toEqual({
      verdict: 'unusable',
      detail: message,
    });
  });

  it.each([
    [
      'its creation is refused',
      () => {
        const core = api([]);
        core.createNamespacedPod.mockRejectedValue(new Error('forbidden'));
        return core;
      },
      'forbidden',
    ],
    [
      'its Pod fails',
      () => api([{ phase: 'Failed', reason: 'DeadlineExceeded' }]),
      'DeadlineExceeded',
    ],
    [
      'its image never pulls in time',
      () =>
        api([
          {
            phase: 'Pending',
            containerStatuses: [
              {
                name: 'gpu-check',
                image: '',
                imageID: '',
                ready: false,
                restartCount: 0,
                state: { waiting: { reason: 'ImagePullBackOff' } },
              },
            ],
          },
        ]),
      'ImagePullBackOff',
    ],
    ['it never finishes', () => api([{ phase: 'Running' }]), 'no result'],
    [
      "another Job holds a GPU's memory",
      () =>
        api(
          [{ phase: 'Succeeded' }],
          'GPU 0: NVIDIA H100\nGPU 1: NVIDIA H100\nCUresult 2\nexit=2',
        ),
      'CUresult 2',
    ],
  ])('has no verdict when %s', async (_name, core, detail) => {
    const result = await check(core(), 20);
    expect(result).toMatchObject({ verdict: 'unknown' });
    expect((result as { detail: string }).detail).toContain(detail);
  });
});
