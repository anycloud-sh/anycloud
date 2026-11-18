/**
 * A pool Node's GPU check, independent of any Job's image: a Pod
 * pinned to the Node runs the VM path's probe, so a Job that couldn't
 * use its GPU leads to a Node replacement only when the Node's own GPUs fail.
 */

import type { CoreV1Api, V1Pod } from '@kubernetes/client-node';
import { sleep } from '../../../shared/utils.js';
import { errorMessage } from '../../../shared/log-diagnostics.js';
import { GPU_PROBE, gpuProbePassed } from '../host-runtime/gpu-probe.js';
import { isKubernetesConflictError } from './managed-resources.js';
import { NVIDIA_RUNTIME_CLASS } from './nvidia-device-plugin.js';
import { kubernetesRequestOptions } from './request-options.js';

/**
 * The probe needs python3 and a shell, which neither the API's image nor the
 * device plugin's carries; the NVIDIA toolkit injects nvidia-smi and libcuda.
 * Docker's official multi-arch image through Google's mirror, as the API
 * image's Node base. https://hub.docker.com/_/python
 */
export const NODE_GPU_CHECK_IMAGE =
  'mirror.gcr.io/library/python:3.12.13-slim@sha256:229a2c5bfa27522db7815ea81f9bed70af17ccb9de9fc7ad142b1877b5830d36';

/** How long a Job's report waits for the check, from the Pod's creation. */
const NODE_GPU_CHECK_TIMEOUT_MS = 60_000;
const POLL_MS = 2_000;

export type NodeGpuCheck =
  | { verdict: 'healthy' }
  | { verdict: 'unusable'; detail: string }
  | { verdict: 'unknown'; detail: string };

type CheckApi = Pick<
  CoreV1Api,
  | 'createNamespacedPod'
  | 'readNamespacedPod'
  | 'readNamespacedPodLog'
  | 'deleteNamespacedPod'
>;

/**
 * Run the check on `replica`'s Node over every GPU there, without a GPU
 * request, as the device plugin reaches them, so it never waits for an
 * allocatable GPU. The replica owns the Pod, so a Pod an interrupted check
 * leaves is collected with it; one name per execution lets a retried report
 * wait on the same check.
 */
export async function checkNodeGpus(
  core: CheckApi,
  replica: V1Pod,
  executionId: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<NodeGpuCheck> {
  const namespace = replica.metadata!.namespace!;
  const name = `anycloud-gpu-check-${executionId.toLowerCase()}`;
  const timeoutMs = options.timeoutMs ?? NODE_GPU_CHECK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  try {
    await core
      .createNamespacedPod(
        { namespace, body: checkPod(name, replica) },
        kubernetesRequestOptions(),
      )
      .catch((error: unknown) => {
        if (!isKubernetesConflictError(error)) throw error;
      });
    for (;;) {
      const pod = await core.readNamespacedPod(
        { name, namespace },
        kubernetesRequestOptions(),
      );
      const container = pod.status?.containerStatuses?.[0]?.state;
      const failure = [
        container?.waiting?.message,
        container?.terminated?.message,
      ].find((message) => message?.includes('nvidia-container-cli'));
      // The NVIDIA hook fails to start the container when the driver
      // can't reach the GPUs.
      if (failure) return { verdict: 'unusable', detail: failure };
      if (pod.status?.phase === 'Succeeded') {
        const output = await core.readNamespacedPodLog(
          { name, namespace },
          kubernetesRequestOptions(),
        );
        const detail = output.trim().slice(-500);
        if (gpuProbePassed(output)) return { verdict: 'healthy' };
        // CUDA_ERROR_OUT_OF_MEMORY: another replica's Job can hold nearly all
        // of a sound GPU's memory, leaving none for the check's context.
        return /^CUresult 2$/m.test(output)
          ? { verdict: 'unknown', detail }
          : { verdict: 'unusable', detail };
      }
      if (pod.status?.phase === 'Failed' || Date.now() >= deadline) {
        const stuck = container?.waiting ?? container?.terminated ?? pod.status;
        return {
          verdict: 'unknown',
          detail: stuck?.reason
            ? `${stuck.reason}${stuck.message ? `: ${stuck.message}` : ''}`
            : `no result within ${timeoutMs / 1000} s`,
        };
      }
      await sleep(options.pollMs ?? POLL_MS);
    }
  } catch (error) {
    return { verdict: 'unknown', detail: errorMessage(error) };
  } finally {
    await core
      .deleteNamespacedPod({ name, namespace }, kubernetesRequestOptions())
      .catch(() => undefined);
  }
}

function checkPod(name: string, replica: V1Pod): V1Pod {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      ownerReferences: [
        {
          apiVersion: 'v1',
          kind: 'Pod',
          name: replica.metadata!.name!,
          uid: replica.metadata!.uid!,
        },
      ],
    },
    spec: {
      nodeName: replica.spec!.nodeName,
      // The Node may already be cordoned or tainted for removal.
      tolerations: [{ operator: 'Exists' }],
      runtimeClassName: NVIDIA_RUNTIME_CLASS,
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      activeDeadlineSeconds: NODE_GPU_CHECK_TIMEOUT_MS / 1000,
      containers: [
        {
          name: 'gpu-check',
          image: NODE_GPU_CHECK_IMAGE,
          command: ['/bin/sh', '-c', GPU_PROBE],
          env: [
            { name: 'NVIDIA_VISIBLE_DEVICES', value: 'all' },
            { name: 'NVIDIA_DRIVER_CAPABILITIES', value: 'compute,utility' },
          ],
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
          },
        },
      ],
    },
  };
}
