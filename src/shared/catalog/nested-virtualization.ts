/**
 * Reviewed per-series nested virtualization support for clouds whose machine
 * listings don't report it. A series left out stays unknown, which node
 * pools count as unsupported.
 */

// https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/overview:
// Intel series support it; E2, memory-optimized, Arm and AMD series don't,
// except AMD's N4D.
const GCP_SUPPORTED_SERIES = new Set([
  'n1',
  'n2',
  'n4',
  'n4d',
  'c2',
  'c3',
  'c4',
]);
const GCP_UNSUPPORTED_SERIES = new Set([
  ...['e2', 'm1', 'm2', 'm3', 'm4', 'x4'],
  ...['t2a', 'c4a', 'n2d', 'c2d', 't2d', 'c3d', 'c4d'],
]);

// Series whose Feature support table on learn.microsoft.com lists Nested
// Virtualization as Supported, as `<family><features>v<version>`, and that
// run the Gen2 images AnyCloud launches (Dv3 is Gen1 only).
const AZURE_SUPPORTED_SERIES = new Set([
  'dv5',
  'dsv5',
  'ddv5',
  'ddsv5',
  'dasv5',
  'esv5',
  'fsv2',
  'dsv6',
  'dasv6',
  'fasv6',
]);

// https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/enabling:
// "The minimum CPU platform for Intel VMs must be Intel Haswell". Later series
// only run on later platforms; N1 zones may still default to Sandy Bridge.
/** The minimum CPU platform a nested launch of `machineType` must request. */
export function gcpNestedMinCpuPlatform(
  machineType: string,
): string | undefined {
  return machineType.toLowerCase().startsWith('n1-')
    ? 'Intel Haswell'
    : undefined;
}

/** `n2-standard-8` → its series; bare-metal shapes stay unknown. */
export function gcpNestedVirtualization(
  machineType: string,
): boolean | undefined {
  const type = machineType.toLowerCase();
  if (type.endsWith('-metal')) return undefined;
  const series = type.split('-')[0]!;
  if (GCP_SUPPORTED_SERIES.has(series)) return true;
  return GCP_UNSUPPORTED_SERIES.has(series) ? false : undefined;
}

/** `Standard_D4ds_v5` → `ddsv5`; constrained-vCPU sizes share their series. */
export function azureNestedVirtualization(size: string): boolean | undefined {
  const match = /^standard_([a-z]+)\d+(?:-\d+)?([a-z]*)_(v\d+)$/.exec(
    size.toLowerCase(),
  );
  return match && AZURE_SUPPORTED_SERIES.has(match.slice(1).join(''))
    ? true
    : undefined;
}
