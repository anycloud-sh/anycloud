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

/** A GPU that Compute Engine attaches to a general-purpose machine at launch. */
export interface GcpAttachedGpu {
  readonly machineType: string;
  /** Compute Engine accelerator type, for `guestAccelerators`. */
  readonly acceleratorType: string;
  /** SkyPilot's accelerator name, which prices the attached GPU. */
  readonly acceleratorName: string;
  readonly acceleratorCount: number;
}

function t4(machineType: string): GcpAttachedGpu {
  return {
    machineType,
    acceleratorType: 'nvidia-tesla-t4',
    acceleratorName: 'T4',
    acceleratorCount: 1,
  };
}

/**
 * N1 machines with an attached GPU. Each is published under its own catalog
 * name so the GPU shape never shares the bare N1 machine's CPU classification
 * or prices. N1's V100, P100, P4 and K80 remain unqualified.
 */
export const GCP_ATTACHED_GPU_SHAPES: Readonly<Record<string, GcpAttachedGpu>> =
  {
    'n1-standard-4-t4': t4('n1-standard-4'),
    'n1-highmem-4-t4': t4('n1-highmem-4'),
  };

export function gcpAttachedGpu(vmType: string): GcpAttachedGpu | undefined {
  return GCP_ATTACHED_GPU_SHAPES[vmType.trim().toLowerCase()];
}

/** The Compute Engine machine type that a catalog VM type launches. */
export function gcpMachineType(vmType: string): string {
  return gcpAttachedGpu(vmType)?.machineType ?? vmType;
}

function gcpGpuMachineSeries(vmType: string): string {
  return vmType.trim().toLowerCase().split('-').slice(0, 2).join('-');
}

export function gcpGpuMachineCapability(
  vmType: string,
): GcpGpuMachineCapability | undefined {
  const series = gcpGpuMachineSeries(vmType);
  return gcpAttachedGpu(vmType)
    ? qualified(series)
    : GCP_GPU_MACHINE_CAPABILITIES[series];
}

export function gcpGpuMachineSelectionPriority(vmType: string): number {
  const capability = gcpGpuMachineCapability(vmType);
  const noLocalSsdPenalty = vmType.toLowerCase().endsWith('-nolssd') ? 1 : 0;
  return (capability?.selectionPriority ?? 100) + noLocalSsdPenalty;
}
