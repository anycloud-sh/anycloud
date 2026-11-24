/**
 * Which GCP machine series boot from Hyperdisk rather than Persistent Disk.
 * GCP does not expose machine-to-disk compatibility through its APIs, so this
 * keeps only the exceptions to the common Persistent Disk path.
 */
export const GCP_HYPERDISK_MEDIUM_SERIES = [
  'a3-ultragpu',
  'a4-highgpu',
  'a4x-highgpu',
  'a4x-maxgpu',
  'c4',
  'c4a',
  'c4d',
  'c4n',
  'g4-standard',
  'h4d',
  'n4',
  'n4a',
  'n4d',
] as const;
const GCP_HYPERDISK_FAST_SERIES = [
  ...GCP_HYPERDISK_MEDIUM_SERIES,
  'h3',
] as const;
export const GCP_BALANCED_PD_MEDIUM_SERIES = [
  'a3-edgegpu',
  'a3-highgpu',
  'a3-megagpu',
  'c3',
  'c3d',
  'g2-standard',
  'h3',
  'm3',
  'z3',
] as const;

export function matchesGcpSeries(
  vmType: string,
  series: readonly string[],
): boolean {
  const normalized = vmType.trim().toLowerCase();
  return series.some(
    (candidate) =>
      normalized === candidate || normalized.startsWith(`${candidate}-`),
  );
}

export function isHyperdiskOnlyMetalVariant(vmType: string): boolean {
  const normalized = vmType.trim().toLowerCase();
  return (
    normalized.endsWith('-metal') &&
    (normalized.startsWith('c3-') || normalized.startsWith('z3-'))
  );
}

/** Whether `vmType`'s high and ultra tiers, and its own IOPS, use Hyperdisk. */
export function gcpBootsFromFastHyperdisk(vmType: string): boolean {
  return (
    isHyperdiskOnlyMetalVariant(vmType) ||
    matchesGcpSeries(vmType, GCP_HYPERDISK_FAST_SERIES)
  );
}
