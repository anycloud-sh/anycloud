/**
 * NVSwitch fabric readiness, shared by a VM host's wait over SSH and a pool
 * Node's boot gate. On multi-GPU NVLink hosts (HGX H100/A100, and multi-GPU
 * slices of a shared baseboard) the GPUs enumerate before NVIDIA Fabric
 * Manager has registered them into an active fabric partition; CUDA started
 * in that window fails with error 802 ("system not yet initialized").
 */

/**
 * One `nvidia-smi --query-gpu=fabric.state` value that lets CUDA start:
 * Completed, or a GPU with no fabric (Not Supported, N/A). Some drivers
 * prefix it with a `state` label. Both JavaScript and GNU `grep -E` read it.
 */
export const NVIDIA_GPU_FABRIC_READY_STATE =
  '(state\\s+)?(completed|not supported|n/a)';

// Fabric Manager normally reaches Completed within seconds; a host that never
// does is faulty, so this is generous but bounded.
export const NVIDIA_GPU_FABRIC_READY_TIMEOUT_MS = 120_000;
export const NVIDIA_GPU_FABRIC_POLL_INTERVAL_MS = 3_000;
