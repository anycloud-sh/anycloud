/**
 * A VM Job's own AWS gp3 root-volume performance (`--disk-iops`,
 * `--disk-throughput`), which overrides its disk tier's. Limits are AWS's
 * (https://docs.aws.amazon.com/ebs/latest/userguide/general-purpose.html):
 * 3,000–80,000 IOPS at most 500 per GiB, and 125–2,000 MiB/s at most 0.25
 * MiB/s per provisioned IOPS.
 */

import { DiskTier } from './cloud.js';

export const GP3_BASELINE_IOPS = 3_000;
const GP3_MAX_IOPS = 80_000;
const GP3_MAX_IOPS_PER_GIB = 500;
const GP3_MIN_THROUGHPUT_MIBPS = 125;
const GP3_MAX_THROUGHPUT_MIBPS = 2_000;
const GP3_THROUGHPUT_PER_IOPS = 0.25;

export interface Gp3Performance {
  diskIops?: number;
  diskThroughputMibps?: number;
}

/** A disk tier's root volume IOPS and MiB/s on AWS; Medium is gp3's baseline. */
export function gp3TierPerformance(diskTier: DiskTier | undefined): {
  Iops?: number;
  Throughput?: number;
} {
  switch (diskTier) {
    case undefined:
    case DiskTier.Medium:
      return {};
    case DiskTier.High:
      return { Iops: 8000, Throughput: 1000 };
    case DiskTier.Ultra:
      return { Iops: 16000, Throughput: 1000 };
  }
}

/**
 * The root volume's IOPS and MiB/s: the tier's, with the Job's own on top.
 * The tier's throughput comes down to 0.25 MiB/s per IOPS when the Job
 * lowers the IOPS alone, as AWS requires.
 */
export function gp3VolumePerformance(
  diskTier: DiskTier | undefined,
  own: Gp3Performance,
): { Iops?: number; Throughput?: number } {
  const tier = gp3TierPerformance(diskTier);
  const Iops = own.diskIops ?? tier.Iops;
  const Throughput =
    own.diskThroughputMibps ??
    (tier.Throughput !== undefined && Iops !== undefined
      ? Math.min(tier.Throughput, Math.floor(Iops * GP3_THROUGHPUT_PER_IOPS))
      : tier.Throughput);
  return {
    ...(Iops !== undefined && { Iops }),
    ...(Throughput !== undefined && { Throughput }),
  };
}

/** The smallest root volume that may carry `iops`. */
export function gp3MinimumSizeGb(iops: number): number {
  return Math.ceil(iops / GP3_MAX_IOPS_PER_GIB);
}

/**
 * Why the requested performance is out of AWS's range, or null. Without
 * `diskIops` the volume keeps the baseline (or the tier's) IOPS, which
 * bounds the throughput.
 */
export function gp3PerformanceError(
  { diskIops, diskThroughputMibps }: Gp3Performance,
  baseIops: number,
): string | null {
  if (diskIops !== undefined) {
    if (
      !Number.isInteger(diskIops) ||
      diskIops < GP3_BASELINE_IOPS ||
      diskIops > GP3_MAX_IOPS
    ) {
      return `--disk-iops must be a whole number from ${GP3_BASELINE_IOPS} to ${GP3_MAX_IOPS}`;
    }
  }
  if (diskThroughputMibps !== undefined) {
    if (
      !Number.isInteger(diskThroughputMibps) ||
      diskThroughputMibps < GP3_MIN_THROUGHPUT_MIBPS ||
      diskThroughputMibps > GP3_MAX_THROUGHPUT_MIBPS
    ) {
      return `--disk-throughput must be a whole number of MiB/s from ${GP3_MIN_THROUGHPUT_MIBPS} to ${GP3_MAX_THROUGHPUT_MIBPS}`;
    }
    const iops = diskIops ?? baseIops;
    if (diskThroughputMibps > iops * GP3_THROUGHPUT_PER_IOPS) {
      return `--disk-throughput ${diskThroughputMibps} MiB/s needs at least ${Math.ceil(diskThroughputMibps / GP3_THROUGHPUT_PER_IOPS)} IOPS (0.25 MiB/s per IOPS); pass --disk-iops`;
    }
  }
  return null;
}
