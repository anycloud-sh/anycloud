import type { CloudType, DiskTier } from '../../shared/cloud.js';
import {
  diskTierRequiresPremiumStorage,
  getRegionsForVMType,
  gpuCapabilityForVMType,
  isImageRuntimeCompatible,
  nestedVirtualizationSupport,
} from '../../shared/cloud-config.js';
import { getPremiumStorageCapable } from '../../shared/catalog/queries.js';
import {
  DeployError,
  InvalidAnycloudConfigError,
} from '../../shared/errors.js';
import { NodePoolState } from '../../shared/node-pools.js';
import type { DockerOptions } from '../../shared/runtime.js';
import type { NodePoolRepository, StoredNodePool } from './cluster-store.js';
import { nodePoolDisk } from './kubernetes/node-pool-disk.js';
import { assertImageAccessible } from './image-manifest.js';
import type { ImageInspection } from '../../shared/image-registry.js';
import type { OwnershipScope } from './repositories/ownership-filter.js';

/** Why a named node pool can't take new work; each kind words its refusal. */
export type NodePoolRefusal =
  | { kind: 'missing' }
  | {
      kind: Exclude<NodePoolState, NodePoolState.Ready>;
      nodePool: StoredNodePool;
    };

/**
 * Resolve the node pool a caller named (id, then name) and admit only a
 * Ready one, for Deployments and Services on a node pool alike.
 */
export async function resolveReadyNodePool(
  nodePools: Pick<NodePoolRepository, 'getForScope' | 'getByNameForScope'>,
  identifier: string,
  scope: OwnershipScope,
  refuse: (refusal: NodePoolRefusal) => Error,
): Promise<StoredNodePool> {
  const nodePool =
    (await nodePools.getForScope(identifier, scope)) ??
    (await nodePools.getByNameForScope(identifier, scope));
  if (!nodePool) throw refuse({ kind: 'missing' });
  if (nodePool.state === NodePoolState.Ready) return nodePool;
  throw refuse({ kind: nodePool.state, nodePool });
}

/**
 * Refuse a VM type list whose types the catalog doesn't offer (in the pinned
 * region, if any), that differ in accelerator (every Node in a pool has the
 * same GPU kind and count), or that can't take the pool's OS disk tier, and
 * an OS disk that leaves replicas no ephemeral storage (ST2b).
 */
export function assertNodePoolVmTypes(
  cloud: CloudType,
  vmTypes: readonly string[],
  region?: string,
  osDiskTier?: DiskTier,
  osDiskSizeGb?: number,
): void {
  const disk = nodePoolDisk({
    cloudProvider: cloud,
    vmTypes: [...vmTypes],
    osDiskSizeGb: osDiskSizeGb ?? null,
  });
  if (disk.allocatableGi !== undefined && disk.allocatableGi <= 0) {
    throw new DeployError(
      `--disk-size ${osDiskSizeGb} GB leaves replicas no ephemeral storage after the ${disk.systemReservedGi + disk.kubeReservedGi} GB each Node reserves for the OS and images; use --disk-size ${disk.minimumDiskGb} or more`,
      400,
    );
  }
  const premiumless =
    diskTierRequiresPremiumStorage(osDiskTier) &&
    vmTypes.find((vmType) => getPremiumStorageCapable(cloud, vmType) === false);
  if (premiumless) {
    throw new DeployError(
      `--disk-tier ${osDiskTier} needs a Premium disk, which ${cloud} VM type "${premiumless}" does not support; use a Premium-capable VM type or --disk-tier medium`,
      400,
    );
  }
  const capability = (vmType: string) => {
    const gpu = gpuCapabilityForVMType(cloud, vmType);
    if (gpu.kind === 'nvidia')
      return `${gpu.count ?? 'an unknown number of'} NVIDIA GPUs`;
    if (gpu.kind === 'non-cuda') return `${gpu.runtime} GPUs`;
    return gpu.kind === 'cpu' ? 'no GPU' : 'unknown GPUs';
  };
  const [first, ...rest] = vmTypes as [string, ...string[]];
  for (const vmType of rest) {
    const regions = getRegionsForVMType(vmType, cloud);
    if (region ? !regions.includes(region) : regions.length === 0) {
      throw new DeployError(
        `${cloud} does not offer VM type "${vmType}"${region ? ` in ${region}` : ''}`,
        400,
      );
    }
    if (capability(vmType) !== capability(first)) {
      throw new DeployError(
        `A node pool's VM types must share one GPU kind and count: ${first} has ${capability(first)}, ${vmType} has ${capability(vmType)}`,
        400,
      );
    }
  }
}

/**
 * RFC 0049 C32: a user-namespace Pod runs under its own runtime class, and a
 * Pod has one, so GPU access (the `nvidia` class) is out.
 */
export function assertUserNamespaceVmTypes(
  cloud: CloudType,
  vmTypes: readonly string[],
): void {
  const gpu = vmTypes.find(
    (vmType) => gpuCapabilityForVMType(cloud, vmType).kind !== 'cpu',
  );
  if (gpu) {
    throw new DeployError(
      `--user-namespace-jobs needs CPU VM types; ${cloud} VM type "${gpu}" has GPUs, which need their own runtime class`,
      400,
    );
  }
}

/**
 * RFC 0049 C32: a privileged Deployment or Service would be root on a
 * user-namespace pool's Node and undo the option for its Jobs.
 */
export function refusePrivilegedOnUserNamespacePool(
  dockerOptions: DockerOptions | null | undefined,
  nodePool: Pick<StoredNodePool, 'name' | 'userNamespaceJobs'>,
  workloads: 'Deployments' | 'Services',
): void {
  if (dockerOptions?.privileged && nodePool.userNamespaceJobs) {
    throw new InvalidAnycloudConfigError(
      `Node pool "${nodePool.name}" runs user-namespace Jobs, so its ${workloads} do not accept --privileged`,
    );
  }
}

/**
 * The VM types, in order, that the catalog reports as supporting nested
 * virtualization in the pool's region or zone (anywhere when unpinned);
 * refuses a pool left with none.
 */
export function nestedVirtualizationVmTypes(
  cloud: CloudType,
  vmTypes: readonly string[],
  region?: string,
  zone?: string,
): string[] {
  const kept = vmTypes.filter(
    (vmType) =>
      nestedVirtualizationSupport(cloud, vmType, region, zone) === true,
  );
  if (kept.length === 0) {
    throw new DeployError(
      `--require-nested-virtualization: the ${cloud} catalog reports nested virtualization for none of ${vmTypes.join(', ')}${region ? ` in ${zone ?? region}` : ''}; anycloud vm-types --details shows each type's support`,
      400,
    );
  }
  return kept;
}

/** Refuse an image the registry rejects or the node pool's VMs can't run. */
export function assertNodePoolImage(
  image: string,
  inspection: ImageInspection,
  nodePool: Pick<StoredNodePool, 'cloudProvider' | 'vmTypes'>,
): void {
  assertImageAccessible(image, inspection);
  // Every type in the pool's list shares one capability.
  const [vmType] = nodePool.vmTypes as [string];
  if (
    !isImageRuntimeCompatible(
      nodePool.cloudProvider,
      vmType,
      inspection.imageRuntime,
    )
  ) {
    throw new InvalidAnycloudConfigError(
      `Image requires a ${inspection.imageRuntime.toUpperCase()} GPU runtime incompatible with node pool VM type "${vmType}".`,
    );
  }
}
