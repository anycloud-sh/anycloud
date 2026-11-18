/**
 * The GPU probe after an in-place VM restart: a VM type with a GPU
 * must list one before the Job's command starts on it. A Job whose log reports
 * an unusable GPU runs it once more before a fresh VM replaces the VM.
 */

import { GpuRuntime } from '../../../shared/cloud.js';
import { retryUntil } from '../../../shared/utils.js';
import type { DbVM } from '../entities.js';
import { createTransport } from '../gateways/transport.js';
import type { StoredWorkload } from '../workload-record.js';

/** A restarted GPU VM lists no usable GPU, so a fresh VM replaces it. */
export class UnusableGpuError extends Error {
  constructor(ip: string, probeOutput: string) {
    super(`No usable GPU on ${ip} after restart: ${probeOutput.slice(-500)}`);
    this.name = 'UnusableGpuError';
  }
}

const GPU_PROBE_ATTEMPTS = 3;
const GPU_PROBE_INTERVAL_MS = 20_000;

// NVML can list a GPU that CUDA cannot use ("busy or unavailable", error 46),
// so create and destroy a CUDA context on each device through the driver.
const CUDA_CONTEXT_CHECK = [
  'import ctypes as c',
  'l=c.CDLL("libcuda.so.1");n=c.c_int();d=c.c_int();x=c.c_void_p()',
  'r=l.cuInit(0) or l.cuDeviceGetCount(c.byref(n))',
  'for i in range(n.value): r=r or l.cuDeviceGet(c.byref(d),i) or l.cuCtxCreate_v2(c.byref(x),0,d) or l.cuCtxDestroy_v2(x)',
  'print("CUresult",r);raise SystemExit(r)',
].join('\n');
/** Lists the GPUs, then takes a CUDA context on each; also a pool Node's check. */
const GPU_PROBE = `timeout 30 nvidia-smi -L 2>&1 && timeout 30 python3 -c '${CUDA_CONTEXT_CHECK}' 2>&1; echo "exit=$?"`;
const GPU_PROBE_TIMEOUT_MS = 75_000;

/** `GPU_PROBE`'s output when it listed a GPU and every context succeeded. */
function gpuProbePassed(output: string): boolean {
  return /^GPU \d+:/m.test(output) && output.trim().endsWith('exit=0');
}

async function runGpuProbe(vm: DbVM, sshPrivateKey: string): Promise<string> {
  const ssh = createTransport(vm.sshHost ?? vm.ip, sshPrivateKey, vm.sshPort);
  return (
    await ssh.exec(GPU_PROBE, 1, false, GPU_PROBE_TIMEOUT_MS)
  ).stdout.trim();
}

/**
 * Azure can restart a Spot VM in place without a usable GPU. On a CUDA
 * type, `nvidia-smi -L` must list a GPU and each GPU must take a CUDA context
 * on every VM within about a minute, so a driver still loading passes and a
 * lost or unavailable GPU fails before the Job's command starts. The host has
 * python3: VM initialization unpacks rclone with it. A probe that cannot run over SSH rejects as is.
 */
export async function waitForUsableGpus(
  vms: DbVM[],
  props: StoredWorkload,
  gpuRuntime: GpuRuntime | null,
): Promise<void> {
  if (gpuRuntime !== GpuRuntime.Cuda) return;
  await Promise.all(
    vms.map(async (vm) => {
      await retryUntil(
        () => runGpuProbe(vm, props.sshPrivateKey!),
        gpuProbePassed,
        `GPU probe on ${vm.ip}`,
        {
          maxAttempts: GPU_PROBE_ATTEMPTS,
          waitMs: GPU_PROBE_INTERVAL_MS,
          error: (output) => new UnusableGpuError(vm.ip, output),
        },
      );
    }),
  );
}

/**
 * One probe on a CUDA VM whose Job has exited: its driver is no longer
 * loading, so a single attempt decides. Rejects when SSH cannot run it.
 */
export async function probeUsableGpu(
  vm: DbVM,
  sshPrivateKey: string,
): Promise<{ usable: boolean; output: string }> {
  const output = await runGpuProbe(vm, sshPrivateKey);
  return { usable: gpuProbePassed(output), output };
}
