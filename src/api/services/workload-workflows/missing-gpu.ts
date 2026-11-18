/**
 * Missing-GPU classification: the container log lines that suggest a GPU Job's
 * host had no usable GPU, or a faulty one. They trigger the GPU probe on a VM
 * host or a pool Node, and the Job retries on a fresh host only
 * when the probe can't clear its GPU, or once in place when it can. The retry
 * records UNUSABLE_GPU_DIAGNOSIS, which retry-recovery bounds at
 * UNUSABLE_GPU_MAX_RETRIES.
 */

import { CloudFailureDiagnosis, GpuRuntime } from '../../../shared/cloud.js';
import { WorkloadState } from '../../../shared/workload.js';
import { UNUSABLE_GPU_MAX_RETRIES } from '../../config.js';
import type { DbVM } from '../entities.js';
import { GPU_RERUN_DIAGNOSIS } from '../workload-event-metadata.js';
import { probeUsableGpu, UnusableGpuError } from '../host-runtime/gpu-probe.js';
import { classifyStepFailure } from '../provisioning-failure.js';

/** The Retrying event's diagnosis when a GPU Job's host had no usable GPU. */
export const UNUSABLE_GPU_DIAGNOSIS = 'unusable-gpu';

/** What to check when the image, not the host, couldn't use the GPU. */
export const UNUSABLE_GPU_HINT =
  'check CUDA_VISIBLE_DEVICES and that the image has a CUDA build of its framework';

/** The Failed reason once the Job's fresh VMs all showed an unusable GPU. */
export const UNUSABLE_GPU_EXHAUSTED = `GPU unusable on every fresh VM; ${UNUSABLE_GPU_HINT}`;

/** A pool Job's unusable-GPU retries share the VM path's budget. */
export const UNUSABLE_GPU_POOL_RETRY_CAP = {
  max: UNUSABLE_GPU_MAX_RETRIES,
  failed: 'GPU unusable on every Node it retried on, each found faulty',
};

// A non-zero container exit whose logs contain CUDA_ERROR_NO_DEVICE can mean
// the host booted without visible GPUs (driver missing, MIG mis-provisioned,
// etc.). Treat it as retryable only when the container actually requested GPU
// access; otherwise it is just the user's process probing CUDA in a CPU job.
//
// A second, distinct host-side fault is the same shape: on NVSwitch/NVLink hosts
// (HGX H100/A100, and any multi-GPU slice of a shared baseboard) the GPUs
// enumerate but CUDA init fails with error 802 "system not yet initialized"
// (CUDA_ERROR_SYSTEM_NOT_READY) when Fabric Manager hasn't registered them into
// an active fabric partition. That is a control-plane fault on the host, not the
// container — a fresh node almost always clears it — so it is retryable too.
//
// CUDA patterns are runtime-agnostic (they only matter because classifyJobExit
// gates on gpuTarget). ROCm/HIP patterns fire ONLY when the RESOLVED runtime is
// 'rocm' so a ROCm-looking line in a CUDA job is never misread as a missing GPU.
export function looksLikeMissingGPU(
  logs: string | undefined,
  runtime?: GpuRuntime | null,
): boolean {
  if (!logs) return false;
  if (
    /CUDA_ERROR_NO_DEVICE|cuInit\(0\) failed|No devices were found/i.test(logs)
  )
    return true;
  if (
    /system not yet initialized|CUDA_ERROR_SYSTEM_NOT_READY|cudaErrorSystemNotReady|fabric manager/i.test(
      logs,
    )
  )
    return true;
  // The GPU is gone or unusable on this host, as after some in-place Spot
  // restarts: CUDA errors 46 and 100, NVML, and PyTorch's wording.
  if (
    /CUDA-capable device\(s\) is\/are busy or unavailable|no CUDA-capable device is detected|Failed to initialize NVML|No CUDA GPUs are available|torch\.cuda\.is_available\(\) is False/i.test(
      logs,
    )
  )
    return true;
  if (looksLikeGpuNumericFault(logs)) return true;
  if (
    runtime === GpuRuntime.Rocm &&
    /hipErrorNoDevice|no ROCm-capable device|HSA_STATUS_ERROR|\/dev\/kfd/i.test(
      logs,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * A faulty GPU fails XLA's autotuning self-checks: no cuBLAS config runs, or
 * the redzone check's host and device results differ (seen on T4 Spot Jobs).
 * Each needs both phrases, so an ordinary autotuning error doesn't match. A
 * GPU that computes wrong results still takes a CUDA context, so the GPU probe
 * can't clear it on a VM or a pool Node.
 */
export function looksLikeGpuNumericFault(logs: string): boolean {
  return (
    /Autotuning failed[\s\S]*No valid config found/.test(logs) ||
    /redzone_allocator[\s\S]*Mismatched results with host and device comparison/.test(
      logs,
    )
  );
}

/** A failed GPU probe's step failure, counted toward UNUSABLE_GPU_MAX_RETRIES. */
export function classifyUnusableGpu(error: unknown) {
  if (!(error instanceof UnusableGpuError)) return undefined;
  // The step's cloud diagnosis is typed; the event metadata's keys override it.
  return classifyStepFailure(
    CloudFailureDiagnosis.TemporaryProviderFailure,
    undefined,
    { diagnosis: UNUSABLE_GPU_DIAGNOSIS, errorKind: UNUSABLE_GPU_DIAGNOSIS },
  );
}

/** The Errored message when the GPU passed its probe after an in-place rerun too. */
export const GPU_PASSED_PROBE = `The Job's log reported an unusable GPU, but the GPU passed a CUDA check on its VM twice, so the image or its CUDA setup is the likely cause; ${UNUSABLE_GPU_HINT}`;

/**
 * A missing-GPU log only triggers the host's GPU probe: the Job retries
 * on a fresh VM when the probe fails or can't run. When the GPU passes, the Job
 * reruns once in a new container on the same VM, since a running container can
 * lose a healthy host's GPU (NVML "Unknown Error" after a systemd reload), and
 * ends Errored if it passes again. A probe that can't run retries, because the
 * hardware is unconfirmed and UNUSABLE_GPU_MAX_RETRIES bounds the cost. A
 * numeric fault retries unprobed: a CUDA context can't disprove it.
 */
export async function confirmUnusableGpu(
  vm: DbVM,
  sshPrivateKey: string,
  runtime: GpuRuntime | null,
  logs: string | undefined,
  reranInPlace: boolean,
): Promise<{
  state: WorkloadState;
  diagnosis?: string;
  gpuProbe?: string;
  message?: string;
}> {
  if (logs && looksLikeGpuNumericFault(logs)) {
    return { state: WorkloadState.Retrying };
  }
  if (runtime !== GpuRuntime.Cuda) {
    return {
      state: WorkloadState.Retrying,
      message: `GPU check could not run on a ${runtime ?? 'non-CUDA'} VM; retrying on a fresh VM`,
    };
  }
  try {
    const { usable, output } = await probeUsableGpu(vm, sshPrivateKey);
    if (!usable) {
      return {
        state: WorkloadState.Retrying,
        gpuProbe: output,
        message: 'GPU failed a CUDA check on its VM; retrying on a fresh VM',
      };
    }
    return reranInPlace
      ? {
          state: WorkloadState.Errored,
          gpuProbe: output,
          message: GPU_PASSED_PROBE,
        }
      : {
          state: WorkloadState.Retrying,
          diagnosis: GPU_RERUN_DIAGNOSIS,
          gpuProbe: output,
          message:
            'GPU passed a CUDA check on its VM; rerunning the Job once in a new container on the same VM',
        };
  } catch (error) {
    return {
      state: WorkloadState.Retrying,
      gpuProbe: String(error),
      message: 'GPU check could not run on its VM; retrying on a fresh VM',
    };
  }
}
