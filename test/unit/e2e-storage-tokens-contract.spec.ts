import { describe, expect, test } from 'vitest';

import {
  STORAGE_TOKEN_TARGETS,
  StorageTokensContract,
  type StorageTokenGrant,
  type StorageTokensPort,
  type StorageTokenTarget,
  type TokenAttempt,
} from '../integration/e2e/internal/contracts/storage-tokens.js';
import type { Waiter } from '../integration/e2e/internal/wait.js';

/** A cloud that enforces the minted grants, with one fault to inject. */
class FakeCloud implements StorageTokensPort {
  readonly objects = new Map<string, string>();
  grants: readonly StorageTokenGrant[] = [];
  expired = false;
  constructor(
    readonly target: StorageTokenTarget,
    readonly fault?: 'reads out/' | 'deletes rw/' | 'never expires' | 'is slow',
  ) {}
  /** Advanced by a slow cloud's refusals; the contract's clock. */
  now = 0;

  #granted(bucket: string, key: string, write: boolean): boolean {
    if (this.fault === 'reads out/' && key.startsWith('out/')) return true;
    return this.grants.some(
      (g) =>
        g.bucket === bucket &&
        key.startsWith(g.prefix) &&
        (!write || g.mode === 'readwrite'),
    );
  }
  #attempt(allowed: boolean, digest: string): TokenAttempt {
    // A slow cloud spends the token's life on its first refusals.
    if (this.fault === 'is slow' && !allowed)
      this.now = STORAGE_TOKEN_TARGETS[this.target].lifetimeMs;
    return allowed && !this.expired
      ? { allowed: true, digest }
      : { allowed: false, refusal: '403' };
  }

  async prepare() {
    for (const key of [
      'read-a/ref.txt',
      'read-b/ref.txt',
      'out/ref.txt',
      'rw/ref.txt',
    ])
      this.objects.set(`b/${key}`, key);
    this.objects.set('o/read-a/ref.txt', 'other');
    return { bucket: 'b', other: 'o' };
  }
  async mint(grants: readonly StorageTokenGrant[]) {
    if (grants.length > 10 || grants.some((g) => g.prefix.includes('..')))
      return { status: 400, code: 'BAD_REQUEST' };
    this.grants = grants;
    const { lifetimeMs } = STORAGE_TOKEN_TARGETS[this.target];
    const count = this.target === 'azure' ? grants.length : 1;
    return {
      status: 200 as const,
      tokens: Array.from({ length: count }, (_, i) => ({
        grants: [i],
        expiresAt: lifetimeMs,
      })),
    };
  }
  async read(bucket: string, key: string) {
    return this.#attempt(
      this.#granted(bucket, key, false),
      this.objects.get(`${bucket}/${key}`) ?? '',
    );
  }
  async write(bucket: string, key: string, bytes: number) {
    const allowed = this.#granted(bucket, key, true);
    if (allowed) this.objects.set(`${bucket}/${key}`, String(bytes));
    return this.#attempt(allowed, String(bytes));
  }
  async list(bucket: string, prefix: string) {
    return this.#attempt(
      prefix !== '' && this.#granted(bucket, prefix, false),
      [...this.objects.keys()]
        .filter((k) => k.startsWith(`${bucket}/${prefix}`))
        .map((k) => k.slice(bucket.length + 1))
        .join(','),
    );
  }
  async remove(bucket: string, key: string) {
    const deletes =
      STORAGE_TOKEN_TARGETS[this.target].readwriteDeletes ||
      this.fault === 'deletes rw/';
    const allowed = deletes && this.#granted(bucket, key, true);
    if (allowed) this.objects.delete(`${bucket}/${key}`);
    return this.#attempt(allowed, 'removed');
  }
  async ownerDigest(bucket: string, key: string) {
    return this.objects.get(`${bucket}/${key}`) ?? 'absent';
  }
  async dispose() {
    return true;
  }
  async record() {}
}

function contract(cloud: FakeCloud) {
  const wait: Pick<Waiter, 'for'> = {
    for: async (label, probe, options) => {
      for (let poll = 0; poll < 3; poll += 1) {
        const value = await probe(0);
        if (options.unmet(value) === undefined) return value;
        // Time passes past the expiry; the cloud refuses unless faulted.
        cloud.now = STORAGE_TOKEN_TARGETS[cloud.target].lifetimeMs;
        cloud.expired = cloud.fault !== 'never expires';
      }
      throw new Error(`${label} timed out`);
    },
  };
  return new StorageTokensContract({
    port: cloud,
    wait,
    clock: { now: () => cloud.now },
  });
}

describe('storage-tokens contract', () => {
  test.each(['aws', 'gcp', 'azure'] as const)(
    '%s satisfies it on a cloud that enforces the grants',
    async (target) => {
      const cloud = new FakeCloud(target);
      await expect(contract(cloud).run(target)).resolves.toEqual({
        contract: 'storage-tokens',
        qualification: 'conclusive',
        target,
        satisfied: true,
      });
      // GCP alone deletes inside its readwrite prefix.
      expect(cloud.objects.has('b/rw/ref.txt')).toBe(target !== 'gcp');
    },
  );

  test("gcp doesn't wait out its key token's hour", async () => {
    // A token that never expires would time the wait out.
    const cloud = new FakeCloud('gcp', 'never expires');
    await expect(contract(cloud).run('gcp')).resolves.toMatchObject({
      satisfied: true,
    });
    expect(cloud.now).toBe(0);
  });

  test.each([
    ['aws', 'reads out/', /read out\/ was allowed/u],
    ['azure', 'deletes rw/', /deleting rw\/ref.txt was allowed/u],
    ['aws', 'never expires', /timed out/u],
    ['azure', 'is slow', /neared its expiry before the scope checks/u],
  ] as const)('%s fails when the cloud %s', async (target, fault, message) => {
    await expect(
      contract(new FakeCloud(target, fault)).run(target),
    ).rejects.toThrow(message);
  });
});
