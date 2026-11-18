import type { Waiter } from '../wait.js';

export type StorageTokenTarget = 'aws' | 'gcp' | 'azure';

export interface StorageTokenGrant {
  readonly bucket: string;
  readonly prefix: string;
  readonly mode: 'read' | 'readwrite';
}

/** What a mint answered: its tokens' shape, never their secrets. */
export type MintOutcome =
  | {
      readonly status: 200;
      readonly tokens: readonly {
        readonly grants: readonly number[];
        readonly expiresAt: number;
      }[];
    }
  | { readonly status: number; readonly code: string };

/** The cloud's answer to one call made with the minted tokens only. */
export type TokenAttempt =
  | { readonly allowed: true; readonly digest: string }
  | { readonly allowed: false; readonly refusal: string };

/**
 * The cloud a member runs against. Every object is written and read back
 * through the cloud's own SDK; an attempt is allowed when any minted token
 * allows it, and refused only when every one does.
 */
export interface StorageTokensPort {
  /** Two fresh buckets, seeded with the CI credential under `SEEDED`. */
  prepare(target: StorageTokenTarget): Promise<{
    readonly bucket: string;
    readonly other: string;
  }>;
  mint(
    grants: readonly StorageTokenGrant[],
    lifetimeSeconds: number,
  ): Promise<MintOutcome>;
  read(bucket: string, key: string): Promise<TokenAttempt>;
  /** `bytes` above the SDK's part size makes a multipart upload. */
  write(bucket: string, key: string, bytes: number): Promise<TokenAttempt>;
  list(bucket: string, prefix: string): Promise<TokenAttempt>;
  remove(bucket: string, key: string): Promise<TokenAttempt>;
  /** The object's digest read with the CI credential, or `absent`. */
  ownerDigest(bucket: string, key: string): Promise<string>;
  /** Deletes both buckets; true once the API reports each gone. */
  dispose(): Promise<boolean>;
  record(name: string, value: unknown): Promise<void>;
}

export interface StorageTokensContractResult {
  readonly contract: 'storage-tokens';
  readonly qualification: 'conclusive';
  readonly target: StorageTokenTarget;
  readonly satisfied: true;
}

/** The keys `prepare` seeds in the first bucket; the second holds `read-a/ref.txt`. */
export const SEEDED = [
  'read-a/ref.txt',
  'read-b/ref.txt',
  'out/ref.txt',
  'rw/ref.txt',
  // A sibling whose name extends a granted prefix's text.
  'rw-x/ref.txt',
] as const;
/** Above S3's 5 MiB part, Azure's 4 MiB block and the GCS resumable chunk. */
const MULTIPART_BYTES = 12 * 1024 * 1024;
const SKEW_MS = 60_000;
/**
 * Each target's class facts: the lifetime asked for, and the one its token
 * must report (STS's 15-minute floor, a GCP key's hour, Azure's
 * exact SAS), whether a readwrite token deletes inside its prefix (Q1), and
 * whether the run waits the token out. Azure asks for 5 minutes so its
 * refusals run well before the token expires. A GCP key's token can't be
 * shorter than its hour, so GCP's expiry is left to `role-storage-tokens`,
 * whose role token lasts its 10-minute floor.
 */
export const STORAGE_TOKEN_TARGETS = {
  aws: {
    askSeconds: 900,
    lifetimeMs: 900_000,
    readwriteDeletes: false,
    waitsExpiry: true,
  },
  gcp: {
    askSeconds: 900,
    lifetimeMs: 3_600_000,
    readwriteDeletes: true,
    waitsExpiry: false,
  },
  azure: {
    askSeconds: 300,
    lifetimeMs: 300_000,
    readwriteDeletes: false,
    waitsExpiry: true,
  },
} as const satisfies Record<
  StorageTokenTarget,
  {
    askSeconds: number;
    lifetimeMs: number;
    readwriteDeletes: boolean;
    waitsExpiry: boolean;
  }
>;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`storage-tokens: ${message}`);
}

export class StorageTokensContract {
  readonly #port: StorageTokensPort;
  readonly #wait: Pick<Waiter, 'for'>;
  readonly #clock: { now(): number };

  constructor(dependencies: {
    readonly port: StorageTokensPort;
    readonly wait: Pick<Waiter, 'for'>;
    readonly clock: { now(): number };
  }) {
    this.#port = dependencies.port;
    this.#wait = dependencies.wait;
    this.#clock = dependencies.clock;
  }

  async #refused(
    label: string,
    attempt: Promise<TokenAttempt>,
  ): Promise<string> {
    const outcome = await attempt;
    invariant(!outcome.allowed, `${label} was allowed`);
    return outcome.refusal;
  }

  async #allowed(label: string, attempt: Promise<TokenAttempt>) {
    const outcome = await attempt;
    invariant(
      outcome.allowed,
      `${label} was refused: ${'refusal' in outcome ? outcome.refusal : ''}`,
    );
    return outcome.digest;
  }

  async run(target: StorageTokenTarget): Promise<StorageTokensContractResult> {
    const port = this.#port;
    const { bucket, other } = await port.prepare(target);
    const grants: StorageTokenGrant[] = [
      { bucket, prefix: 'read-a/', mode: 'read' },
      { bucket, prefix: 'read-b/', mode: 'read' },
      { bucket, prefix: 'rw/', mode: 'readwrite' },
    ];
    const mintedAt = this.#clock.now();
    const facts = STORAGE_TOKEN_TARGETS[target];
    const minted = await port.mint(grants, facts.askSeconds);
    invariant(minted.status === 200, `mint answered ${JSON.stringify(minted)}`);
    invariant(
      'tokens' in minted &&
        minted.tokens.length === (target === 'azure' ? 3 : 1),
      `${target} returned ${'tokens' in minted ? minted.tokens.length : 0} tokens`,
    );
    for (const { expiresAt } of minted.tokens) {
      const lifetime = expiresAt - mintedAt;
      invariant(
        Math.abs(lifetime - facts.lifetimeMs) <= SKEW_MS,
        `a ${target} token lasts ${lifetime} ms, expected about ${facts.lifetimeMs}`,
      );
    }
    const record: Record<string, unknown> = { tokens: minted.tokens };

    // In scope first: it proves the tokens work before any refusal counts.
    for (const key of ['read-a/ref.txt', 'read-b/ref.txt'])
      invariant(
        (await this.#allowed(`reading ${key}`, port.read(bucket, key))) ===
          (await port.ownerDigest(bucket, key)),
        `${key} read back different bytes`,
      );
    invariant(
      (await this.#allowed('listing read-a/', port.list(bucket, 'read-a/'))) ===
        'read-a/ref.txt',
      'listing read-a/ did not return exactly read-a/ref.txt',
    );
    for (const [key, bytes] of [
      ['rw/small.txt', 1_024],
      ['rw/large.bin', MULTIPART_BYTES],
    ] as const) {
      const written = await this.#allowed(
        `writing ${key}`,
        port.write(bucket, key, bytes),
      );
      invariant(
        (await this.#allowed(`reading ${key}`, port.read(bucket, key))) ===
          written && (await port.ownerDigest(bucket, key)) === written,
        `${key} read back different bytes`,
      );
    }

    const refusals: Record<string, string> = {};
    for (const [label, attempt] of [
      ['read out/', () => port.read(bucket, 'out/ref.txt')],
      ['read the sibling rw-x/', () => port.read(bucket, 'rw-x/ref.txt')],
      ['write the sibling rw-x/', () => port.write(bucket, 'rw-x/new.txt', 16)],
      ['read the other bucket', () => port.read(other, 'read-a/ref.txt')],
      ['write read-a/', () => port.write(bucket, 'read-a/new.txt', 16)],
      ['write out/', () => port.write(bucket, 'out/new.txt', 16)],
      ['write the other bucket', () => port.write(other, 'rw/new.txt', 16)],
      ['list out/', () => port.list(bucket, 'out/')],
      ['list the bucket root', () => port.list(bucket, '')],
    ] as const)
      refusals[label] = await this.#refused(label, attempt());
    const deletes = ['read-a/ref.txt', 'out/ref.txt', 'rw/ref.txt'];
    for (const key of deletes) {
      const before = await port.ownerDigest(bucket, key);
      invariant(before !== 'absent', `${key} was missing before its delete`);
      const outcome = await port.remove(bucket, key);
      // GCS needs delete to overwrite, so a readwrite GCP token
      // deletes inside its own readwrite prefix, and only there.
      if (facts.readwriteDeletes && key.startsWith('rw/')) {
        invariant(
          outcome.allowed,
          `GCP refused deleting ${key} in its readwrite prefix`,
        );
        record.gcpReadwriteDelete = 'allowed inside rw/, as accepted';
        continue;
      }
      invariant(!outcome.allowed, `deleting ${key} was allowed`);
      refusals[`delete ${key}`] = outcome.refusal;
      invariant(
        (await port.ownerDigest(bucket, key)) === before,
        `${key} changed after a refused delete`,
      );
    }

    // An expired token is refused too, so every refusal above must come first.
    const firstExpiry = Math.min(...minted.tokens.map((t) => t.expiresAt));
    invariant(
      this.#clock.now() < firstExpiry - SKEW_MS,
      'a token neared its expiry before the scope checks finished',
    );

    for (const [label, request] of [
      ['an escaping prefix', [{ bucket, prefix: 'a/../', mode: 'read' }]],
      [
        'eleven grants',
        Array.from({ length: 11 }, (_, i) => ({
          bucket,
          prefix: `p${i}/`,
          mode: 'read' as const,
        })),
      ],
    ] as const) {
      const refused = await port.mint(request, 60);
      invariant(refused.status === 400, `${label} answered ${refused.status}`);
    }

    // Use after expiry: every token refuses a read it allowed before.
    if (facts.waitsExpiry) {
      const expiresAt = Math.max(...minted.tokens.map((t) => t.expiresAt));
      const expired = await this.#wait.for(
        'the minted tokens refused after their expiry',
        () => port.read(bucket, 'read-a/ref.txt'),
        {
          timeoutMs: Math.max(expiresAt - this.#clock.now(), 0) + 5 * 60_000,
          intervalMs: 30_000,
          probeError: 'fail',
          unmet: (outcome) => (outcome.allowed ? 'still allowed' : undefined),
        },
      );
      invariant(
        this.#clock.now() >= expiresAt - SKEW_MS,
        'a token was refused before its expiry',
      );
      refusals['read after expiry'] = expired.allowed ? '' : expired.refusal;
    }
    invariant(await port.dispose(), 'a bucket outlived its deletion');
    await port.record('storage-tokens', { ...record, refusals });
    return {
      contract: 'storage-tokens',
      qualification: 'conclusive',
      target,
      satisfied: true,
    };
  }
}
