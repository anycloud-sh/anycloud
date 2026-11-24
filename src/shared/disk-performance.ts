/**
 * A VM Job's own root-disk performance (`--disk-iops`, `--disk-throughput`),
 * which overrides its disk tier's: AWS gp3
 * (https://docs.aws.amazon.com/ebs/latest/userguide/general-purpose.html) or
 * GCP Hyperdisk Balanced
 * (https://cloud.google.com/compute/docs/disks/hd-types/hyperdisk-balanced).
 * Both allow 500 IOPS per GiB and at most 0.25 MiB/s per IOPS.
 */

import { DiskTier } from './cloud.js';
import { gcpBootsFromFastHyperdisk } from './gcp-boot-disks.js';

const MAX_IOPS_PER_GIB = 500;
const MAX_THROUGHPUT_PER_IOPS = 0.25;

export interface DiskPerformance {
  diskIops?: number;
  diskThroughputMibps?: number;
}

export interface DiskPerformanceLimits {
  readonly volume: string;
  readonly minIops: number;
  readonly maxIops: number;
  readonly minThroughputMibps: number;
  readonly maxThroughputMibps: number;
  /** The fewest MiB/s each IOPS needs; 0 where there is no floor. */
  readonly minThroughputPerIops: number;
  /**
   * Whether a VM type boots from this volume, where some don't; the others
   * keep their tier's disk.
   */
  readonly bootsVmType?: (vmType: string) => boolean;
  /** A Job's root size without --disk-size, where the cloud fixes one. */
  readonly defaultSizeGb?: number;
  /** A disk tier's IOPS and MiB/s; absent where the volume keeps its own. */
  readonly tiers: Record<DiskTier, { Iops?: number; Throughput?: number }>;
}

export const GP3_LIMITS: DiskPerformanceLimits = {
  volume: 'AWS gp3',
  minIops: 3_000,
  maxIops: 80_000,
  minThroughputMibps: 125,
  maxThroughputMibps: 2_000,
  minThroughputPerIops: 0,
  tiers: {
    // Medium is gp3's baseline.
    [DiskTier.Medium]: {},
    [DiskTier.High]: { Iops: 8_000, Throughput: 1_000 },
    [DiskTier.Ultra]: { Iops: 16_000, Throughput: 1_000 },
  },
};

export const HYPERDISK_BALANCED_LIMITS: DiskPerformanceLimits = {
  volume: 'GCP Hyperdisk Balanced',
  minIops: 3_000,
  maxIops: 160_000,
  minThroughputMibps: 140,
  maxThroughputMibps: 2_400,
  minThroughputPerIops: 1 / 256,
  bootsVmType: gcpBootsFromFastHyperdisk,
  // The Hyperdisk tiers' size.
  defaultSizeGb: 100,
  tiers: {
    // Medium is Hyperdisk Balanced's own default, at least these.
    [DiskTier.Medium]: { Iops: 3_000, Throughput: 140 },
    [DiskTier.High]: { Iops: 8_000, Throughput: 1_000 },
    [DiskTier.Ultra]: { Iops: 16_000, Throughput: 1_000 },
  },
};

/**
 * The volume's IOPS and MiB/s: the tier's, with the Job's own on top. The
 * tier's throughput comes into the volume's range for the IOPS when the Job
 * changes the IOPS alone.
 */
export function diskVolumePerformance(
  limits: DiskPerformanceLimits,
  diskTier: DiskTier | undefined,
  own: DiskPerformance,
): { Iops?: number; Throughput?: number } {
  const tier = limits.tiers[diskTier ?? DiskTier.Medium];
  const Iops = own.diskIops ?? tier.Iops;
  const Throughput =
    own.diskThroughputMibps ??
    (tier.Throughput !== undefined && Iops !== undefined
      ? Math.max(
          Math.min(tier.Throughput, Math.floor(Iops * MAX_THROUGHPUT_PER_IOPS)),
          Math.ceil(Iops * limits.minThroughputPerIops),
        )
      : tier.Throughput);
  return {
    ...(Iops !== undefined && { Iops }),
    ...(Throughput !== undefined && { Throughput }),
  };
}

/** The smallest volume that may carry `iops`. */
export function diskMinimumSizeGb(iops: number): number {
  return Math.ceil(iops / MAX_IOPS_PER_GIB);
}

/**
 * Why the requested performance is out of the volume's range, or null.
 * Without `diskIops` the volume keeps the tier's (or the baseline) IOPS,
 * which bound the throughput.
 */
export function diskPerformanceError(
  limits: DiskPerformanceLimits,
  { diskIops, diskThroughputMibps }: DiskPerformance,
  diskTier: DiskTier,
): string | null {
  if (diskIops !== undefined) {
    if (
      !Number.isInteger(diskIops) ||
      diskIops < limits.minIops ||
      diskIops > limits.maxIops
    ) {
      return `--disk-iops must be a whole number from ${limits.minIops} to ${limits.maxIops} on ${limits.volume}`;
    }
  }
  if (diskThroughputMibps !== undefined) {
    if (
      !Number.isInteger(diskThroughputMibps) ||
      diskThroughputMibps < limits.minThroughputMibps ||
      diskThroughputMibps > limits.maxThroughputMibps
    ) {
      return `--disk-throughput must be a whole number of MiB/s from ${limits.minThroughputMibps} to ${limits.maxThroughputMibps} on ${limits.volume}`;
    }
    const iops = diskIops ?? limits.tiers[diskTier].Iops ?? limits.minIops;
    if (diskThroughputMibps > iops * MAX_THROUGHPUT_PER_IOPS) {
      return `--disk-throughput ${diskThroughputMibps} MiB/s needs at least ${Math.ceil(diskThroughputMibps / MAX_THROUGHPUT_PER_IOPS)} IOPS (0.25 MiB/s per IOPS); pass --disk-iops`;
    }
    if (diskThroughputMibps < iops * limits.minThroughputPerIops) {
      return `${iops} IOPS need at least ${Math.ceil(iops * limits.minThroughputPerIops)} MiB/s on ${limits.volume}; pass a higher --disk-throughput`;
    }
  }
  return null;
}
