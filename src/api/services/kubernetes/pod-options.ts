import { type DockerOptions } from '../../../shared/runtime.js';
import {
  defaultGpuAccess,
  gpuCapabilityForVMType,
} from '../../../shared/cloud-config.js';
import { readCatalog } from '../../../shared/catalog/index.js';
import { InvalidAnycloudConfigError } from '../../../shared/errors.js';
import {
  parseDockerGpuRequest,
  parseDockerSize,
  validateDockerOptionsForKubernetes,
  validateDockerOptionsForResolvedTarget,
} from '../../../shared/docker-options.js';
import type { StoredNodePool } from '../cluster-store.js';
import { NVIDIA_RUNTIME_CLASS } from './nvidia-device-plugin.js';
import { USER_NAMESPACE_RUNTIME_CLASS } from './user-namespace.js';

/**
 * Memory the kernel and firmware keep from a VM's catalog size, outside
 * MemTotal: typically 60–120 MiB on a 1 GiB type such as AWS `t2.micro` or
 * Azure `Standard_B1s`, with margin. Nodes reserve no memory for the system
 * or the kubelet, so this and the eviction threshold are what allocatable
 * omits.
 */
export const KERNEL_MEMORY_MI = 256;

/** The kubelet's memory eviction threshold, which allocatable memory omits. */
export const NODE_EVICTION_MEMORY_MI = 100;

/** The least default memory limit, room for the runner and dirty page cache. */
const MEMORY_LIMIT_FLOOR_MI = 512;

/** Map supported runtime intent to the managed containerd runtime handler. */
export function resolveKubernetesRuntimeClass(
  options: DockerOptions | null | undefined,
  gpuCount: number,
): string | undefined {
  if (!Number.isSafeInteger(gpuCount) || gpuCount < 0) {
    throw new InvalidAnycloudConfigError(
      'Kubernetes GPU allocation must be a nonnegative integer.',
    );
  }
  // Admission keeps GPUs and --runtime off user-namespace pools.
  if (options?.userNamespace) return USER_NAMESPACE_RUNTIME_CLASS;
  if (options?.runtime === 'runc' && gpuCount > 0) {
    // The managed device plugin passes allocated devices through NVIDIA's
    // envvar strategy, which requires the NVIDIA container runtime.
    throw new InvalidAnycloudConfigError(
      'Kubernetes GPU access requires the NVIDIA runtime, so --runtime runc is unsupported; omit --runtime or use --runtime nvidia.',
    );
  }
  if (options?.runtime === 'nvidia' && gpuCount === 0) {
    throw new InvalidAnycloudConfigError(
      '--runtime nvidia requires a verified GPU allocation on Kubernetes.',
    );
  }
  return gpuCount > 0 ? NVIDIA_RUNTIME_CLASS : undefined;
}

/** Physical NVIDIA devices one node pool Node advertises when ready. */
export function nodePoolGpusPerNode(
  capacity: Pick<StoredNodePool, 'cloudProvider' | 'vmTypes'>,
): number {
  const capability = gpuCapabilityForVMType(
    capacity.cloudProvider,
    capacity.vmTypes[0]!,
  );
  return capability.kind === 'nvidia' ? (capability.count ?? 0) : 0;
}

/** The smallest pool VM type's catalog vCPUs and memory; undefined for an unlisted type. */
export function nodePoolNodeSize(
  capacity: Pick<StoredNodePool, 'cloudProvider' | 'vmTypes'>,
): { vCPUs: number; memoryGiB: number } | undefined {
  const catalog = readCatalog(capacity.cloudProvider);
  const sizes = capacity.vmTypes.map((vmType) => ({
    vCPUs: catalog?.vCPUsPerType[vmType.toLowerCase()],
    memoryGiB: catalog?.memoryPerType[vmType.toLowerCase()],
  }));
  if (sizes.some((size) => !size.vCPUs || !size.memoryGiB)) return undefined;
  return {
    vCPUs: Math.min(...sizes.map((size) => size.vCPUs!)),
    memoryGiB: Math.min(...sizes.map((size) => size.memoryGiB!)),
  };
}

/**
 * K9: a replica without `--cpus` or `--memory` requests its share of the
 * pool VM, 90% of it to leave the kubelet and DaemonSets room. A GPU
 * replica's share is its GPUs'; a CPU replica's is its `--cpus`, by default
 * 1 vCPU, a default VM Job's size, so replicas fill a Node's CPUs and the
 * pool scales out. Both come from the record and the catalog, never a live
 * Node, so they don't drift and restart the replica; a VM type missing from
 * the catalog gets 1 vCPU and 1 GiB, with no limit unless `--cpus` is set
 * (then 1 GiB is the limit too). The memory limit is the
 * request but at least `MEMORY_LIMIT_FLOOR_MI`: page cache counts against it
 * on cgroup v2, so a small `--cpus` share would OOM on ordinary disk writes.
 * Both are at most a Node's allocatable, so the replica fits an empty Node
 * even on a 1 GiB type, where 90% of the VM would not; below 512 MiB of
 * allocatable, the limit is the allocatable. With `--cpus`, the request is
 * the limit, floor included, so the replica is Guaranteed (C30). A runtime
 * class's Pod overhead counts against allocatable too (RFC 0049 C32), so a
 * replica sized to fill a Node still fits one. Docker's forms.
 */
export function replicaSize(
  nodeSize: { vCPUs: number; memoryGiB: number } | undefined,
  gpusPerNode: number,
  gpus: number,
  cpus: string | undefined,
  overheadMi = 0,
): { cpus: string; memory: string; memoryLimit?: string } {
  const gpuShare = gpus > 0 && gpusPerNode > 0 ? gpus / gpusPerNode : 0;
  if (!nodeSize || (gpus > 0 && !gpuShare)) {
    return {
      cpus: cpus ?? '1',
      memory: '1024m',
      ...(cpus && { memoryLimit: '1024m' }),
    };
  }
  const share = 0.9 * (gpuShare || Number(cpus ?? 1) / nodeSize.vCPUs);
  const memory = Math.floor(nodeSize.memoryGiB * share * 1024);
  const allocatable = replicaMemoryCapMi(nodeSize, overheadMi);
  const memoryLimit = `${Math.min(Math.max(memory, MEMORY_LIMIT_FLOOR_MI), allocatable)}m`;
  return {
    cpus: gpuShare
      ? String(Math.floor(nodeSize.vCPUs * share * 10) / 10)
      : (cpus ?? '1'),
    memory: cpus ? memoryLimit : `${Math.min(memory, allocatable)}m`,
    memoryLimit,
  };
}

/** The most memory a replica with this Pod overhead can have on a Node of this size. */
export function replicaMemoryCapMi(
  nodeSize: { memoryGiB: number },
  overheadMi = 0,
): number {
  return (
    Math.floor(nodeSize.memoryGiB * 1024) -
    KERNEL_MEMORY_MI -
    NODE_EVICTION_MEMORY_MI -
    overheadMi
  );
}

/**
 * Resolve the whole NVIDIA devices one node pool Pod requests: on verified
 * CUDA capacity every GPU of one pool VM unless `--gpus N` takes fewer; none
 * on CPU capacity. Unknown or non-CUDA capacity is refused.
 */
export function resolveNodePoolGpuCount(
  dockerOptions: DockerOptions | null | undefined,
  capacity: Pick<StoredNodePool, 'cloudProvider' | 'vmTypes'>,
  workloads: string,
): number {
  const target = {
    cloudProvider: capacity.cloudProvider,
    vmType: capacity.vmTypes[0]!,
  };
  validateDockerOptionsForResolvedTarget(dockerOptions, target);
  const capability = gpuCapabilityForVMType(
    capacity.cloudProvider,
    target.vmType,
  );
  if (
    capability.kind === 'unknown' ||
    (capability.kind === 'nvidia' && capability.count === undefined)
  ) {
    throw new InvalidAnycloudConfigError(
      `GPU capacity cannot be verified for ${capacity.cloudProvider} VM type "${target.vmType}". Refresh the catalog or choose a VM type with a known physical GPU count.`,
    );
  }
  if (capability.kind === 'non-cuda') {
    throw new InvalidAnycloudConfigError(
      `${workloads} require verified CPU or NVIDIA CUDA capacity; ${capacity.cloudProvider} VM type "${target.vmType}" uses ${capability.runtime}.`,
    );
  }
  const requested = defaultGpuAccess(target, dockerOptions ?? null)?.gpus;
  if (requested === undefined) {
    resolveKubernetesRuntimeClass(dockerOptions, 0);
    return 0;
  }
  if (capability.kind !== 'nvidia' || capability.count === undefined) {
    throw new InvalidAnycloudConfigError(
      'GPU access requires verified NVIDIA CUDA capacity',
    );
  }
  const count = parseDockerGpuRequest(requested);
  // `all` is the verified capacity of one VM, not free or cluster-wide GPUs.
  const gpuCount = count === 'all' ? capability.count : count;
  resolveKubernetesRuntimeClass(dockerOptions, gpuCount);
  return gpuCount;
}

/**
 * A size in the API server's canonical form, so the pool loop's cached
 * object compares equal to the rendered one and a converged Deployment is
 * not re-applied. The server keeps a quantity's format: a Docker unit
 * renders binary (`1024m` is stored as `1Gi`), and plain bytes render
 * decimal (`1000000000` is stored as `1G`, `67108864` unchanged).
 */
function canonicalSize(value: string, flag: '--memory' | '--shm-size') {
  const { bytes, unit } = parseDockerSize(value, flag);
  const [base, suffixes] = unit
    ? [1024n, ['Ki', 'Mi', 'Gi', 'Ti', 'Pi', 'Ei']]
    : [1000n, ['k', 'M', 'G', 'T', 'P', 'E']];
  for (let power = 6; power >= 1; power--) {
    const scale = base ** BigInt(power);
    if (bytes % scale === 0n) return `${bytes / scale}${suffixes[power - 1]}`;
  }
  return String(bytes);
}

/** Translate Docker's integer byte/K/M/G/T forms into a Kubernetes quantity. */
export function normalizeKubernetesShmSize(
  value: string | undefined,
): string | undefined {
  return value === undefined ? undefined : canonicalSize(value, '--shm-size');
}

/** Translate Docker's memory syntax into a Kubernetes memory quantity. */
export function normalizeKubernetesMemory(
  value: string | undefined,
): string | undefined {
  return value === undefined ? undefined : canonicalSize(value, '--memory');
}

/** Docker's `--cpus` as a canonical CPU quantity: `0.5` is stored as `500m`. */
export function normalizeKubernetesCpus(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const milli = Math.ceil(Number((Number(value) * 1000).toFixed(6)));
  return milli % 1000 === 0 ? String(milli / 1000) : `${milli}m`;
}

export function validateKubernetesDockerOptions(
  options: DockerOptions | null | undefined,
  workload = 'Kubernetes',
): void {
  validateDockerOptionsForKubernetes(options, workload);
}
