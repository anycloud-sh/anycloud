import { createHash } from 'node:crypto';

/**
 * Hosted replacements retain one workload id while their VM and restored
 * checkpoint files change. Hashing gives every provider one short, label-safe
 * identity value without exposing product naming constraints downstream.
 */
export function hostedApiIdentity(workloadId: string): string {
  const normalized = workloadId.trim();
  if (!normalized) {
    throw new Error('Hosted API identity requires WORKLOAD_ID');
  }
  return createHash('sha256')
    .update('anycloud-hosted-api\0')
    .update(normalized)
    .digest('hex')
    .slice(0, 32);
}
