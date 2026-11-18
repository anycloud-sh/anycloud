import { randomBytes } from 'node:crypto';

// Budget for `${prefix}-${13-digit Date.now()}-${RAND_LEN-char random}` within
// validateId's 28-char cap: 9 + 1 + 13 + 1 + 4 = 28.
const MAX_PREFIX_LEN = 9;

// Random base36 suffix: 4 chars = 36^4 (~1.7M) combinations per millisecond.
// Uniqueness comes from the per-millisecond dedupe below, not from the suffix.
const RAND_LEN = 4;
// Largest multiple of 36 that fits in a byte; higher bytes would bias `% 36`.
const UNBIASED_BYTE_LIMIT = 252;

/** Generate a lowercase base36 (0-9a-z) suffix, matching validateId's charset. */
function randomSuffix(): string {
  let out = '';
  while (out.length < RAND_LEN) {
    for (const byte of randomBytes(RAND_LEN - out.length)) {
      if (byte < UNBIASED_BYTE_LIMIT) out += (byte % 36).toString(36);
    }
  }
  return out;
}

// One API process owns the database, so only IDs issued by this process in
// the same millisecond can collide. Tracking this millisecond's suffixes
// (across prefixes, which is simpler and costs nothing) and redrawing on a
// repeat is what keeps concurrent submissions off the workloads.id UNIQUE
// constraint. A backwards clock step can reopen a past millisecond.
let issuedMs = -1;
const issuedSuffixes = new Set<string>();

/**
 * Extract a short name from a Docker image reference
 * Example: "ghcr.io/user/myapp:latest" -> "myapp"
 */
function extractImageName(image: string): string {
  // Get the last path segment first (handles registry ports like :5000)
  const lastSegment = image.split('/').pop() || 'job';
  // Remove tag/digest from the last segment
  const name = lastSegment.split(/[:@]/)[0];
  // Collapse hyphen runs: Azure container names forbid them.
  return name
    .replace(/[^a-zA-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .slice(0, MAX_PREFIX_LEN)
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function generateTimestampedId(prefix: string): string {
  const now = Date.now();
  if (now !== issuedMs) {
    issuedMs = now;
    issuedSuffixes.clear();
  }
  let suffix = randomSuffix();
  while (issuedSuffixes.has(suffix)) suffix = randomSuffix();
  issuedSuffixes.add(suffix);
  return `${prefix}-${now}-${suffix}`;
}

/**
 * Generate a unique job ID using image name, timestamp, and a random suffix.
 * Example: "myapp-1732019234567-a3f9"
 *
 * The per-millisecond suffix dedupe keeps IDs unique when many jobs are
 * submitted concurrently within the same millisecond.
 */
export function generateJobId(image?: string): string {
  const prefix = image ? extractImageName(image) : 'job';
  return generateTimestampedId(prefix);
}

/** Generate a durable identity for one cluster from its display name. */
export function generateClusterId(name: string): string {
  return generateTimestampedId(extractImageName(name) || 'install');
}
