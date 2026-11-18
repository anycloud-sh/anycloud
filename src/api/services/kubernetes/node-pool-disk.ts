import {
  gpuRuntimeForVMType,
  supportsDiskTier,
} from '../../../shared/cloud-config.js';
import { getNvmeGibForVMType } from '../../../shared/catalog/queries.js';
import type { StoredNodePool } from '../cluster-store.js';

/** A GPU pool's OS disk when it names none, so images and scratch fit. */
export const NVIDIA_CAPACITY_DISK_SIZE_GB = 100;

/**
 * Per VM class, ephemeral storage the kubelet keeps out of allocatable: the
 * OS's footprint on its disk (`systemReserved`) and the image allowance
 * (`kubeReserved`), since images sit outside any Pod's limit (RFC 0043).
 * `usable` is the share of the disk left after ext4's overhead, the root
 * reserve on an OS disk and the 5% eviction threshold.
 */
const VM_CLASSES = {
  nvme: { systemReservedGi: 0, kubeReservedGi: 100, usable: 0.9 },
  gpu: { systemReservedGi: 25, kubeReservedGi: 30, usable: 0.85 },
  cpu: { systemReservedGi: 10, kubeReservedGi: 10, usable: 0.85 },
} as const;

export interface NodePoolDisk {
  /** The per-boot unit puts kubelet and containerd on the raw NVMe. */
  nvme: boolean;
  systemReservedGi: number;
  kubeReservedGi: number;
  /**
   * A floor on each Node's allocatable `ephemeral-storage` in GiB, which
   * managed replicas divide; undefined when the disk size is unknown.
   */
  allocatableGi?: number;
  /** The smallest OS disk that leaves any allocatable storage. */
  minimumDiskGb: number;
}

/**
 * ST2b: where a pool's kubelet scratch lives and what each Node can give
 * replicas. Every VM type must have NVMe for the pool to use it, and the
 * smallest sets the floor. Without NVMe the scratch is the OS disk (OD), of
 * unknown size on a CPU pool that names none and on a fixed disk (Lambda).
 * Such a CPU pool sets no per-replica limit, but its OS disk is at least
 * `minimumDiskGb` so the Node joins: AWS and GCP raise their default to it,
 * and Azure's Ubuntu image disk is 30 GB.
 */
export function nodePoolDisk(
  pool: Pick<StoredNodePool, 'cloudProvider' | 'vmTypes' | 'osDiskSizeGb'>,
): NodePoolDisk {
  const nvme = pool.vmTypes.map((type) =>
    getNvmeGibForVMType(pool.cloudProvider, type),
  );
  const gpu =
    gpuRuntimeForVMType(pool.cloudProvider, pool.vmTypes[0]!) === 'cuda';
  const onNvme = nvme.every((gib) => gib !== undefined);
  const { usable, ...reserved } =
    VM_CLASSES[onNvme ? 'nvme' : gpu ? 'gpu' : 'cpu'];
  const reservedGi = reserved.systemReservedGi + reserved.kubeReservedGi;
  const diskGib = onNvme
    ? Math.min(...(nvme as number[]))
    : (pool.osDiskSizeGb ??
      (gpu && supportsDiskTier(pool.cloudProvider)
        ? NVIDIA_CAPACITY_DISK_SIZE_GB
        : undefined));
  return {
    nvme: onNvme,
    ...reserved,
    ...(diskGib !== undefined && {
      allocatableGi: Math.floor(diskGib * usable) - reservedGi,
    }),
    minimumDiskGb: Math.ceil((reservedGi + 1) / usable),
  };
}
