/**
 * Lambda Labs catalog fetcher.
 *
 * Self-sources Lambda's catalog from the provider API instead of republishing
 * SkyPilot's snapshot, which lags Lambda's real regions by weeks (e.g. it omits
 * us-southeast-1). Two reads:
 *   - GET /instance-types → instance types, specs (vCPU/mem/gpus), hourly price,
 *     and the accelerator parsed from the human `gpu_description`.
 *   - GET /images → the regions Lambda currently OFFERS, with each region's
 *     image families per architecture. This is stable, unlike /instance-types'
 *     `regions_with_capacity_available` (capacity-now), which is why we read it
 *     separately and ignore the capacity field here.
 *
 * Emits each instance type in every region that publishes its launch image
 * family for its architecture: Lambda resolves the family inside the target
 * region, so elsewhere the launch fails with "Image doesn't exist". Beyond that
 * Lambda's API does not expose per-type offered regions, so we over-list
 * (gpuhunt does the same); the runtime availability preflight + capacity
 * failover filter down to what's actually available. Lambda has no spot
 * instances, so spotPrice is always null.
 */

import { withRetry } from '../utils.js';
import type { CloudCatalogFetcher, VMCatalogEntry } from './fetcher.js';

const API_BASE = 'https://cloud.lambda.ai/api/v1';

// Select by family so Lambda resolves the newest compatible regional build
// instead of pinning Anycloud to one region- and architecture-specific image
// ID. Lambda documents Legacy 22.04 as the V100 image because those GPUs need
// the closed-source driver; current Lambda Stack 24.04 covers modern GPUs.
const LAMBDA_MODERN_OS_IMAGE_FAMILY = 'lambda-stack-24-04';
const LAMBDA_V100_OS_IMAGE_FAMILY = 'lambda-stack-legacy-22-04';

export function lambdaOsImageFamily(vmType: string): string {
  return /(?:^|[_-])v100(?:[_-]|$)/i.test(vmType)
    ? LAMBDA_V100_OS_IMAGE_FAMILY
    : LAMBDA_MODERN_OS_IMAGE_FAMILY;
}

export interface LambdaCatalogCredentials {
  apiKey: string;
}

interface LambdaSpecs {
  vcpus?: number;
  memory_gib?: number;
  gpus?: number;
}

interface LambdaInstanceTypeEntry {
  instance_type: {
    name: string;
    description?: string;
    gpu_description?: string;
    price_cents_per_hour?: number;
    specs?: LambdaSpecs;
    architecture?: string;
  };
  // regions_with_capacity_available is deliberately ignored — it's capacity-now,
  // not the offered-region set. Offered regions come from /images.
}

interface LambdaImage {
  region?: { name?: string };
  family?: string;
  architecture?: string;
}

const imageKey = (region: string, family: string, architecture?: string) =>
  JSON.stringify([region, family, architecture]);

export class LambdaCatalogFetcher implements CloudCatalogFetcher {
  constructor(private readonly creds: LambdaCatalogCredentials) {}

  private authHeader(): string {
    // HTTP Basic: API key as username, empty password.
    return `Basic ${Buffer.from(`${this.creds.apiKey}:`).toString('base64')}`;
  }

  private async get<T>(path: string, op: string): Promise<T> {
    return withRetry(
      async () => {
        const res = await fetch(`${API_BASE}${path}`, {
          headers: { Authorization: this.authHeader() },
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { data: T };
        return body.data;
      },
      op,
      { maxAttempts: 3, waitMs: 5_000 },
    );
  }

  async fetchAll(): Promise<VMCatalogEntry[]> {
    const [instanceTypes, offeredImages] = await Promise.all([
      this.get<Record<string, LambdaInstanceTypeEntry>>(
        '/instance-types',
        'Fetch Lambda instance types',
      ),
      this.get<LambdaImage[]>('/images', 'Fetch Lambda offered regions'),
    ]);
    const regions = [
      ...new Set(
        offeredImages
          .map((i) => i.region?.name)
          .filter((r): r is string => typeof r === 'string' && r.length > 0),
      ),
    ].sort();
    if (regions.length === 0) {
      throw new Error('Lambda /images returned no offered regions');
    }
    const images = new Set(
      offeredImages.map((i) =>
        imageKey(i.region?.name ?? '', i.family ?? '', i.architecture),
      ),
    );
    return this.buildEntries(instanceTypes, regions).filter(
      ({ instanceType, region }) =>
        images.has(
          imageKey(
            region,
            lambdaOsImageFamily(instanceType),
            instanceTypes[instanceType]!.instance_type.architecture,
          ),
        ),
    );
  }

  /** Exposed for tests + offline use against fixtures. */
  buildEntries(
    instanceTypes: Record<string, LambdaInstanceTypeEntry>,
    regions: string[],
  ): VMCatalogEntry[] {
    const out: VMCatalogEntry[] = [];
    for (const [name, entry] of Object.entries(instanceTypes)) {
      const it = entry.instance_type;
      const specs = it.specs ?? {};
      const gpuCount = specs.gpus ?? 0;
      const acc = gpuCount > 0 ? parseAccelerator(it.gpu_description) : null;
      const price =
        it.price_cents_per_hour != null ? it.price_cents_per_hour / 100 : null;
      const gpuInfo = acc
        ? buildGpuInfo(acc.name, gpuCount, acc.memoryMiB)
        : null;
      for (const region of regions) {
        out.push({
          instanceType: name,
          region,
          availabilityZone: null,
          price,
          spotPrice: null,
          vCPUs: specs.vcpus ?? null,
          memoryGiB: specs.memory_gib ?? null,
          acceleratorName: acc?.name ?? null,
          acceleratorCount: acc ? gpuCount : null,
          gpuInfo,
          generation: null,
        });
      }
    }
    return out;
  }
}

interface ParsedAccelerator {
  name: string;
  memoryMiB: number | null;
}

/**
 * Derive the catalog accelerator name from Lambda's `gpu_description`, matching
 * the historical (SkyPilot-derived) convention:
 *   "H100 (80 GB SXM5)"  -> H100
 *   "A100 (80 GB SXM4)"  -> A100-80GB   (80 GB variant is a distinct family)
 *   "RTX 6000 (24 GB)"   -> RTX6000     (spaces stripped)
 *   "Tesla V100 (16 GB)" -> V100        ("Tesla " prefix stripped)
 *   "N/A"                -> null        (CPU-only)
 */
function parseAccelerator(
  gpuDescription: string | undefined,
): ParsedAccelerator | null {
  if (!gpuDescription || gpuDescription === 'N/A') return null;
  const m = /^(.*?)\s*\((\d+)\s*GB/i.exec(gpuDescription);
  const rawName = (m ? m[1] : gpuDescription).trim();
  const memGB = m ? parseInt(m[2], 10) : null;
  let name = rawName.replace(/^Tesla\s+/i, '').replace(/\s+/g, '');
  if (name === 'A100' && memGB === 80) name = 'A100-80GB';
  return { name, memoryMiB: memGB != null ? memGB * 1024 : null };
}

/**
 * Reproduce the Python-repr GpuInfo string the existing catalog carries, so the
 * only diff vs the prior SkyPilot-sourced rows is the fresher region set.
 * TotalGpuMemoryInMiB mirrors the historical value: per-GPU memory, not ×count.
 * (GpuInfo is metadata — not read at runtime.)
 */
function buildGpuInfo(
  name: string,
  count: number,
  memoryMiB: number | null,
): string {
  const mib = memoryMiB ?? 0;
  return `{'Gpus': [{'Name': '${name}', 'Manufacturer': 'NVIDIA', 'Count': ${count}.0, 'MemoryInfo': {'SizeInMiB': ${mib}}}], 'TotalGpuMemoryInMiB': ${mib}}`;
}
