interface GcpGpuMachineImage {
  readonly project: string;
  readonly family: string;
}

interface GcpGpuMachineCapabilityBase {
  readonly series: string;
  readonly architecture: 'x86_64' | 'arm64' | 'unknown';
  readonly networkInterfaceType: 'GVNIC' | null;
  /** Lower values win otherwise-equal accelerator resolution ties. */
  readonly selectionPriority: number;
}

interface LaunchQualifiedGcpGpuMachineCapability
  extends GcpGpuMachineCapabilityBase {
  readonly launchQualified: true;
  readonly image: GcpGpuMachineImage;
}

interface UnqualifiedGcpGpuMachineCapability
  extends GcpGpuMachineCapabilityBase {
  readonly launchQualified: false;
  readonly reason: string;
}

export type GcpGpuMachineCapability =
  | LaunchQualifiedGcpGpuMachineCapability
  | UnqualifiedGcpGpuMachineCapability;

const NVIDIA_X86_DLVM: GcpGpuMachineImage = {
  project: 'deeplearning-platform-release',
  family: 'common-cu129-ubuntu-2404-nvidia-580',
};

function qualified(
  series: string,
  options: {
    networkInterfaceType?: 'GVNIC' | null;
    selectionPriority?: number;
  } = {},
): LaunchQualifiedGcpGpuMachineCapability {
  return {
    series,
    launchQualified: true,
    architecture: 'x86_64',
    image: NVIDIA_X86_DLVM,
    networkInterfaceType: options.networkInterfaceType ?? null,
    selectionPriority: options.selectionPriority ?? 0,
  };
}

/**
 * GPU machine series that AnyCloud has explicitly qualified for its GCP launch
 * path. This is intentionally a runtime-capability registry, not a mapping from
 * GPU names to representative VM types: the catalog still discovers the actual
 * accelerator and GPU count from Compute Engine metadata.
 *
 * New machine series must remain fail-closed until their architecture, image,
 * boot disk, and networking behavior are deliberately added here and tested.
 */
const GCP_GPU_MACHINE_CAPABILITIES: Readonly<
  Record<string, GcpGpuMachineCapability>
> = {
  'a2-highgpu': qualified('a2-highgpu'),
  'a2-megagpu': qualified('a2-megagpu'),
  'a2-ultragpu': qualified('a2-ultragpu'),
  'a3-highgpu': qualified('a3-highgpu'),
  'a3-edgegpu': qualified('a3-edgegpu', { selectionPriority: 10 }),
  'a3-megagpu': qualified('a3-megagpu'),
  'a3-ultragpu': qualified('a3-ultragpu', {
    networkInterfaceType: 'GVNIC',
  }),
  'a4-highgpu': qualified('a4-highgpu', {
    networkInterfaceType: 'GVNIC',
  }),
  'g2-standard': qualified('g2-standard', {
    networkInterfaceType: 'GVNIC',
  }),
  'g4-standard': qualified('g4-standard', {
    networkInterfaceType: 'GVNIC',
  }),

  // Grace-based A4X/A4X Max require an ARM64-compatible image and a specialized
  // multi-NIC launch path. Keep them visible to discovery but unpublishable.
  'a4x-highgpu': {
    series: 'a4x-highgpu',
    launchQualified: false,
    architecture: 'arm64',
    networkInterfaceType: 'GVNIC',
    selectionPriority: 0,
    reason: 'requires an ARM64 image and A4X networking support',
  },
  'a4x-maxgpu': {
    series: 'a4x-maxgpu',
    launchQualified: false,
    architecture: 'arm64',
    networkInterfaceType: 'GVNIC',
    selectionPriority: 0,
    reason: 'requires an ARM64 bare-metal launch path and A4X Max networking',
  },
};

function gcpGpuMachineSeries(vmType: string): string {
  return vmType.trim().toLowerCase().split('-').slice(0, 2).join('-');
}

export function gcpGpuMachineCapability(
  vmType: string,
): GcpGpuMachineCapability | undefined {
  return GCP_GPU_MACHINE_CAPABILITIES[gcpGpuMachineSeries(vmType)];
}

export function gcpGpuMachineSelectionPriority(vmType: string): number {
  const capability = gcpGpuMachineCapability(vmType);
  const noLocalSsdPenalty = vmType.toLowerCase().endsWith('-nolssd') ? 1 : 0;
  return (capability?.selectionPriority ?? 100) + noLocalSsdPenalty;
}
