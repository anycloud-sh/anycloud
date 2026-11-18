import type { StageProgress } from '../progress.js';
import type {
  MintOutcome,
  StorageTokenGrant,
  TokenAttempt,
} from './storage-tokens.js';
import { WaitTimeoutError, type Waiter } from '../wait.js';

/**
 * RFC 0047's role-connection scenarios on the hosted journey, one
 * `live_checks` entry per lane they wait on:
 * - `role-connections`: S14 (each cloud's setup template, the save, a pool
 *   Job's output through the connection, nothing secret stored, the pinned
 *   trust refusing another subject's and another audience's token) and S15
 *   (the refused saves); needs lane R1, and R5 for GCS and Blob.
 * - `role-trust-pinning`: S17's unpinned trusts, refused at save; lane R3.
 * - `role-key-rotation`: S16, the signing key added, overlapped and retired;
 *   lane R4.
 * - `role-storage-tokens`: storage tokens minted from each role
 *   connection by a registered Deployment's own Pod-bound token.
 * One API covers all three clouds: the exchange runs from the API through its
 * public issuer, and the management VM's cloud takes no part in it.
 */
export const ROLE_CHECKS = [
  'role-connections',
  'role-trust-pinning',
  'role-key-rotation',
  'role-storage-tokens',
] as const;
export type RoleCheck = (typeof ROLE_CHECKS)[number];

export const ROLE_CLOUDS = ['aws', 'gcp', 'azure'] as const;
export type RoleCloud = (typeof ROLE_CLOUDS)[number];

/**
 * A change the harness makes to a deployed pinned trust, undone by
 * `pinned`. S15's are wrong values; S17's admit more than the API.
 */
export type TrustVariant =
  | 'pinned'
  | 'short-session'
  | 'wrong-audience'
  | 'wrong-subject'
  | 'any-subject'
  | 'any-audience'
  | 'issuer-only';

/**
 * S15 on each cloud: the variant and the text the refused save must name.
 * Only an AWS role has a session limit of its own.
 */
export const S15_REFUSALS: Readonly<
  Record<RoleCloud, readonly (readonly [TrustVariant, RegExp])[]>
> = {
  aws: [
    ['short-session', /MaxSessionDuration/u],
    ['wrong-audience', /audience|aud\b|not authorized/iu],
    ['wrong-subject', /subject|sub\b|not authorized/iu],
  ],
  gcp: [
    ['wrong-audience', /audience/iu],
    ['wrong-subject', /subject|condition|permission/iu],
  ],
  azure: [
    ['wrong-audience', /audience|AADSTS700212|federated/iu],
    ['wrong-subject', /subject|AADSTS7002(11|13)|federated/iu],
  ],
};

/**
 * A save the API is still checking (`ROLE_CONNECTION_PENDING`: IAM
 * propagation, or a probe answered by throttling, a 5xx or the network):
 * neither a refusal nor a pass, so the save is asked again.
 */
const SAVE_PENDING =
  /trying again|still waiting|waiting for (GCP|Azure)|Could not finish checking/iu;

/** Lane R3's stable refusal text for an unpinned trust. */
const UNPINNED_SUBJECT = /does not pin the subject/u;
const UNPINNED_AUDIENCE = /does not pin the audience/u;

/**
 * S17's unpinned trusts on each cloud and what the refusal names. Azure has
 * no wildcard subject or audience, so its "admits another" is a second
 * federated credential for the probe's subject or audience; it has no
 * issuer-only form at all.
 */
export const S17_REFUSALS: Readonly<
  Record<RoleCloud, readonly (readonly [TrustVariant, RegExp])[]>
> = {
  aws: [
    ['any-subject', UNPINNED_SUBJECT],
    ['any-audience', UNPINNED_AUDIENCE],
    ['issuer-only', /does not pin the (subject|audience)/u],
  ],
  gcp: [
    ['any-subject', UNPINNED_SUBJECT],
    ['any-audience', UNPINNED_AUDIENCE],
  ],
  azure: [
    ['any-subject', UNPINNED_SUBJECT],
    ['any-audience', UNPINNED_AUDIENCE],
  ],
};

/** A runner-side exchange: the cloud's own answer, never a credential's. */
export type ExchangeOutcome =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly refusal: string };

export type SaveOutcome =
  | { readonly saved: true; readonly listed: Readonly<Record<string, unknown>> }
  | { readonly saved: false; readonly message: string };

/** Who a minted token is for: the API itself, or R3's probe ServiceAccount. */
export type TokenSubject = 'api' | 'probe';

/** What the checks read and drive; creations register their cleanup first. */
export interface RoleConnectionsPort {
  /** Deploys the cloud's setup template for this issuer once; later calls reuse it. */
  trust(cloud: RoleCloud): Promise<void>;
  /**
   * Undefined once the trust holds the variant; the cloud's refusal when it
   * can't hold one at all, which makes that misconfiguration not applicable.
   */
  applyVariant(
    cloud: RoleCloud,
    variant: TrustVariant,
  ): Promise<string | undefined>;
  /** `credentials new` for the cloud's trust under `name`, on the hosted or the installer's local API. */
  save(
    cloud: RoleCloud,
    name: string,
    api: 'hosted' | 'local',
  ): Promise<SaveOutcome>;
  /**
   * The audience the cloud's trust pins; `replacement`, the one the trust
   * `replaceTrust` deploys will pin (on GCP it names the new provider).
   */
  audience(cloud: RoleCloud, trust?: 'current' | 'replacement'): string;
  /** Revokes the trust, proves it gone and deploys it again from the template under a new name. */
  replaceTrust(cloud: RoleCloud): Promise<void>;
  mintToken(
    subject: TokenSubject,
    audience: string,
    seconds: number,
  ): Promise<string>;
  exchange(cloud: RoleCloud, token: string): Promise<ExchangeOutcome>;
  /** The `kid` of each key the public JWKS serves. */
  jwksKeyIds(): Promise<readonly string[]>;
  /**
   * Lane R4's steps through this tree's CLI: `add`; `retire` before the
   * overlap's end, which must first be refused without an explicit override
   * (the refusal's text is returned), then run with it.
   */
  rotateSigningKey(step: 'add'): Promise<void>;
  rotateSigningKey(step: 'retire'): Promise<{ readonly refusedEarly: string }>;
  /**
   * A pool Job writing `content` to `/mnt/output/probe.txt`, its output
   * bucket signed by the connection; the object read back through it.
   */
  outputThrough(
    nodePoolId: string,
    cloud: RoleCloud,
    connection: string,
    content: string,
  ): Promise<string>;
  record(name: string, value: unknown): Promise<void>;
  /**
   * A fresh bucket signed by `connection`, holding `out/ref.txt` and
   * `rw/ref.txt`, and the call that empties and deletes it (cleanup does,
   * if the check never gets there).
   */
  tokenBucket(
    cloud: RoleCloud,
    connection: string,
  ): Promise<{ bucket: string; remove(): Promise<void> }>;
  /**
   * A sleeping Deployment registered for hosted API access, and the call
   * that deletes it (cleanup does, if the check never gets there).
   */
  signer(nodePoolId: string): Promise<{ remove(): Promise<void> }>;
  /** A mint with the signer's own Pod-bound token; its tokens stay in the port. */
  mintAsSigner(
    connection: string,
    region: RoleCloud,
    grants: readonly (StorageTokenGrant & { readonly noDelete: boolean })[],
    lifetimeSeconds: number,
  ): Promise<MintOutcome>;
  /** With the last minted tokens only, through the cloud's own SDK. */
  tokenRead(bucket: string, key: string): Promise<TokenAttempt>;
  tokenWrite(bucket: string, key: string): Promise<TokenAttempt>;
  tokenRemove(bucket: string, key: string): Promise<TokenAttempt>;
}

export interface RoleCheckPolicy {
  /** A run-unique suffix for connection names and probe content. */
  readonly runId: string;
  /** How long a trust change may take to reach the cloud (Azure RBAC, GCP IAM). */
  readonly propagationMs: number;
  /** S16: AWS and Azure must refuse a retired key's token within these. */
  readonly retiredRefusalMs: Readonly<Record<'aws' | 'azure', number>>;
  /**
   * S16 on GCP, whose JWKS cache held a removed key for at least 59 minutes
   * (C26): `record` notes when, within the window, it refused the retired
   * key; `assert` fails the check unless it refused within the window.
   */
  readonly gcpRetire: 'record' | 'assert';
  readonly gcpRetireWindowMs: number;
}

export interface RoleCheckDependencies {
  readonly port: RoleConnectionsPort;
  readonly policy: RoleCheckPolicy;
  readonly wait: Pick<Waiter, 'for'>;
  readonly progress: Pick<StageProgress, 'mark'>;
  readonly clock: { now(): number };
}

/** The identifier fields a listed role connection may carry (invariant 7). */
export const ROLE_CONNECTION_FIELDS: Readonly<
  Record<RoleCloud, readonly string[]>
> = {
  aws: ['roleArn'],
  gcp: ['workloadIdentityProvider', 'serviceAccountEmail'],
  azure: ['applicationId', 'directoryId', 'subscriptionId'],
};
const LISTED_COMMON = [
  'name',
  'cloudProvider',
  'kind',
  'issuer',
  'audience',
  'subject',
];

/** Fields the listing shows beyond the connection's identifiers and trust. */
export function unexpectedFields(
  cloud: RoleCloud,
  listed: Readonly<Record<string, unknown>>,
): readonly string[] {
  const allowed = new Set([...LISTED_COMMON, ...ROLE_CONNECTION_FIELDS[cloud]]);
  return Object.keys(listed).filter(
    (key) =>
      !allowed.has(key) && listed[key] !== undefined && listed[key] !== null,
  );
}

/** A token's lifetime long enough that expiry never stands in for a refusal. */
const OLD_KEY_TOKEN_SECONDS = 3 * 60 * 60;
const POLL_MS = 15_000;
const GCP_POLL_MS = 2 * 60_000;
/** C26 (run 41957954716): every cloud took a new key on first use. */
const NEW_KEY_MS = 5 * 60_000;
/** Another audience than any trust names. */
export const FOREIGN_AUDIENCE = 'https://anycloud.sh/e2e-foreign-audience';

/** GCP's retire record: when the old key was first refused, if in the window. */
export interface GcpRetireRecord {
  readonly windowMs: number;
  readonly refusedAfterMs: number | null;
  readonly polls: number;
}

export function gcpRetireRecord(
  retiredAt: number,
  windowMs: number,
  polls: readonly { readonly at: number; readonly accepted: boolean }[],
): GcpRetireRecord {
  const refused = polls.find((poll) => !poll.accepted);
  return {
    windowMs,
    refusedAfterMs: refused ? refused.at - retiredAt : null,
    polls: polls.length,
  };
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Role connection check: ${message}`);
}

export class RoleConnectionChecks {
  readonly #d: RoleCheckDependencies;

  constructor(dependencies: RoleCheckDependencies) {
    this.#d = dependencies;
  }

  #name(cloud: RoleCloud, label: string): string {
    return `role-${cloud}-${label}-${this.#d.policy.runId}`;
  }

  /** Polls the save until it answers as `want`, within the propagation budget. */
  async #saveUntil(
    cloud: RoleCloud,
    name: string,
    want: 'saved' | RegExp,
  ): Promise<SaveOutcome> {
    const { port, policy, wait } = this.#d;
    let attempt = 0;
    return wait.for(
      `${cloud} role connection ${name} ${want === 'saved' ? 'saved' : `refused (${want.source})`}`,
      // A refusal wait saves under a fresh name each time: a save that beat
      // the trust change to the cloud must not make every later try "exists".
      () =>
        port.save(
          cloud,
          want === 'saved' ? name : `${name}-${String((attempt += 1))}`,
          'hosted',
        ),
      {
        timeoutMs: policy.propagationMs,
        intervalMs: POLL_MS,
        probeError: 'fail',
        unmet: (outcome) =>
          !outcome.saved && SAVE_PENDING.test(outcome.message)
            ? `pending: ${outcome.message}`
            : want === 'saved'
              ? outcome.saved
                ? undefined
                : `refused: ${outcome.message}`
              : !outcome.saved && want.test(outcome.message)
                ? undefined
                : outcome.saved
                  ? 'saved'
                  : `refused naming something else: ${outcome.message}`,
      },
    );
  }

  async #exchangeUntil(
    cloud: RoleCloud,
    token: string,
    accepted: boolean,
    timeoutMs: number,
    label: string,
  ): Promise<ExchangeOutcome> {
    const { port, wait } = this.#d;
    return wait.for(
      `${cloud} ${label} ${accepted ? 'accepted' : 'refused'}`,
      () => port.exchange(cloud, token),
      {
        timeoutMs,
        intervalMs: POLL_MS,
        probeError: 'fail',
        unmet: (outcome) =>
          outcome.accepted === accepted
            ? undefined
            : outcome.accepted
              ? 'accepted'
              : `refused: ${outcome.refusal}`,
      },
    );
  }

  /**
   * The pinned trust (S14, and S17's cloud side): the API's token for the
   * trust's audience exchanges; the probe ServiceAccount's token and the
   * API's token for another audience are refused by the cloud itself.
   */
  async #pinned(cloud: RoleCloud): Promise<void> {
    const { port, policy } = this.#d;
    const audience = port.audience(cloud);
    await this.#exchangeUntil(
      cloud,
      await port.mintToken('api', audience, 600),
      true,
      policy.propagationMs,
      'API token',
    );
    for (const [subject, aud, label] of [
      ['probe', audience, 'probe ServiceAccount token'],
      ['api', FOREIGN_AUDIENCE, 'API token for another audience'],
    ] as const) {
      const outcome = await port.exchange(
        cloud,
        await port.mintToken(subject, aud, 600),
      );
      invariant(
        !outcome.accepted,
        `${cloud}'s pinned trust accepted the ${label}`,
      );
    }
  }

  /** `role-connections`: S15 on the local API, then S14 and S15 per cloud. */
  async roleConnections(nodePoolId: string): Promise<void> {
    const { port, policy, progress } = this.#d;
    const record: Record<string, unknown> = {};
    for (const cloud of ROLE_CLOUDS) {
      // S15: the installer's local API has no ServiceAccount token. No trust is needed.
      const local = await port.save(cloud, this.#name(cloud, 'local'), 'local');
      invariant(
        !local.saved &&
          /ServiceAccount token|self-hosted/iu.test(local.message),
        `the local API ${local.saved ? 'saved' : `refused with "${local.message}" instead of naming the missing ServiceAccount token for`} a ${cloud} role connection`,
      );
    }
    for (const cloud of ROLE_CLOUDS) {
      await port.trust(cloud);
      const name = this.#name(cloud, 'pinned');
      const saved = await this.#saveUntil(cloud, name, 'saved');
      invariant(saved.saved, `${cloud} role connection not saved`);
      const extra = unexpectedFields(cloud, saved.listed);
      invariant(
        extra.length === 0,
        `${cloud} role connection lists ${extra.join(', ')} beyond its identifiers`,
      );
      await this.#pinned(cloud);
      const content = `${cloud}-${policy.runId}`;
      const read = await port.outputThrough(nodePoolId, cloud, name, content);
      invariant(
        read.trim() === content,
        `${cloud} output read back "${read.trim()}", expected "${content}"`,
      );
      progress.mark(
        `role connection ${cloud}: saved, pinned, output through it`,
      );
      const refusals: Record<string, string> = {};
      for (const [variant, names] of S15_REFUSALS[cloud]) {
        await port.applyVariant(cloud, variant);
        const refused = await this.#saveUntil(
          cloud,
          this.#name(cloud, variant),
          names,
        );
        refusals[variant] = refused.saved ? '' : refused.message;
        await port.applyVariant(cloud, 'pinned');
      }
      record[cloud] = { listed: saved.listed, refusals };
    }
    await port.record('role-connections', record);
  }

  /**
   * `role-storage-tokens`: a registered Deployment, a peer like any
   * member, mints `rw/` of a bucket on each cloud's role connection with its
   * own Pod-bound token. AWS mints through AssumeRoleWithWebIdentity, and a
   * GCP role's token honors the 10-minute floor. The tokens write and read
   * inside `rw/`, never reach `out/`, and delete only on GCP.
   */
  async storageTokens(nodePoolId: string): Promise<void> {
    const { port, clock, wait } = this.#d;
    const buckets: Partial<
      Record<RoleCloud, { bucket: string; remove(): Promise<void> }>
    > = {};
    for (const cloud of ROLE_CLOUDS) {
      await port.trust(cloud);
      const connection = this.#name(cloud, 'pinned');
      await this.#saveUntil(cloud, connection, 'saved');
      buckets[cloud] = await port.tokenBucket(cloud, connection);
    }
    const signer = await port.signer(nodePoolId);
    const record: Record<string, unknown> = {};
    for (const cloud of ROLE_CLOUDS) {
      const connection = this.#name(cloud, 'pinned');
      const { bucket } = buckets[cloud]!;
      const grant = { bucket, prefix: 'rw/', mode: 'readwrite' } as const;
      const mintedAt = clock.now();
      // Five minutes, so Azure's exact token outlives the checks below.
      const minted = await port.mintAsSigner(
        connection,
        cloud,
        [{ ...grant, noDelete: true }],
        300,
      );
      invariant(
        'tokens' in minted,
        `${cloud}: the signer's mint answered ${JSON.stringify(minted)}`,
      );
      const lifetime =
        Math.max(...minted.tokens.map((t) => t.expiresAt)) - mintedAt;
      // STS's 15-minute floor; GCP's 10-minute floor; Azure's exact 5 minutes.
      const [least, most] = {
        aws: [840_000, 960_000],
        gcp: [540_000, 900_000],
        azure: [240_000, 360_000],
      }[cloud];
      invariant(
        lifetime >= least && lifetime <= most,
        `${cloud}: a role connection's token lasts ${lifetime} ms`,
      );
      const written = await port.tokenWrite(bucket, 'rw/signer.txt');
      const read = await port.tokenRead(bucket, 'rw/signer.txt');
      invariant(
        written.allowed && read.allowed && read.digest === written.digest,
        `${cloud}: the signer's token could not write and read rw/`,
      );
      for (const [label, attempt] of [
        ['read out/', () => port.tokenRead(bucket, 'out/ref.txt')],
        ['write out/', () => port.tokenWrite(bucket, 'out/new.txt')],
      ] as const)
        invariant(
          !(await attempt()).allowed,
          `${cloud}: the signer's token could ${label}`,
        );
      const removed = await port.tokenRemove(bucket, 'rw/ref.txt');
      invariant(
        removed.allowed === (cloud === 'gcp'),
        `${cloud}: deleting inside rw/ was ${removed.allowed ? 'allowed' : 'refused'}`,
      );
      // An expired token is refused too, so the refusals above must come first.
      invariant(
        clock.now() <
          Math.min(...minted.tokens.map((t) => t.expiresAt)) - 60_000,
        `${cloud}: the signer's token neared its expiry before the checks finished`,
      );
      record[cloud] = { lifetime, tokens: minted.tokens.length };
      if (cloud !== 'gcp') continue;
      // GCP's role token, unlike a key's, ends with its impersonation.
      await wait.for(
        'the GCP role token refused once it expires',
        () => port.tokenRead(bucket, 'rw/signer.txt'),
        {
          timeoutMs: 15 * 60_000,
          intervalMs: 30_000,
          probeError: 'fail',
          unmet: (outcome) => (outcome.allowed ? 'still allowed' : undefined),
        },
      );
      invariant(
        clock.now() >=
          Math.max(...minted.tokens.map((t) => t.expiresAt)) - 60_000,
        'gcp: the role token was refused before its expiry',
      );
      record.gcpRefusedAfterMs = clock.now() - mintedAt;
    }
    // Deleted now: role-key-rotation later revokes the trusts that sign them,
    // and the journey deletes the signer's node pool.
    for (const cloud of ROLE_CLOUDS) await buckets[cloud]!.remove();
    await signer.remove();
    await port.record('role-storage-tokens', record);
  }

  /** `role-trust-pinning`: S17's unpinned trusts are refused at save, naming what is unpinned. */
  async trustPinning(): Promise<void> {
    const { port } = this.#d;
    const record: Record<string, Record<string, string>> = {};
    for (const cloud of ROLE_CLOUDS) {
      await port.trust(cloud);
      record[cloud] = {};
      for (const [variant, names] of S17_REFUSALS[cloud]) {
        const impossible = await port.applyVariant(cloud, variant);
        if (impossible) {
          record[cloud][variant] = `not applicable: ${impossible}`;
        } else {
          const refused = await this.#saveUntil(
            cloud,
            this.#name(cloud, variant),
            names,
          );
          record[cloud][variant] = refused.saved ? '' : refused.message;
        }
        await port.applyVariant(cloud, 'pinned');
      }
      // Restored: the pinned trust saves again and still refuses the probe.
      // Its identifiers are saved as `pinned`, and a second name is refused.
      await this.#saveUntil(cloud, this.#name(cloud, 'pinned'), 'saved');
      await this.#pinned(cloud);
    }
    await port.record('role-trust-pinning', record);
  }

  /**
   * `role-key-rotation` (S16, both arms): an old-key token exchanges on all three
   * clouds through the overlap, then AWS and Azure refuse it once the key is
   * retired; GCP's refusal is recorded or asserted (`gcpRetire`: its cache
   * held a removed key for at least 59 minutes in C26, run 41957954716). New-key
   * tokens and the saved connections keep working throughout.
   */
  async keyRotation(): Promise<void> {
    const { port, policy, clock, progress } = this.#d;
    const before = await port.jwksKeyIds();
    invariant(
      before.length === 1,
      `the JWKS serves ${before.length} keys before rotation, expected 1`,
    );
    const oldTokens: Partial<Record<RoleCloud, string>> = {};
    // For the compromise arm's recreated trusts, signed while the old key still signs.
    const oldForReplacement: Partial<Record<RoleCloud, string>> = {};
    for (const cloud of ROLE_CLOUDS) {
      await port.trust(cloud);
      oldForReplacement[cloud] = await port.mintToken(
        'api',
        port.audience(cloud, 'replacement'),
        OLD_KEY_TOKEN_SECONDS,
      );
      oldTokens[cloud] = await port.mintToken(
        'api',
        port.audience(cloud),
        OLD_KEY_TOKEN_SECONDS,
      );
      await this.#exchangeUntil(
        cloud,
        oldTokens[cloud],
        true,
        policy.propagationMs,
        'old-key token',
      );
    }
    await port.rotateSigningKey('add');
    const overlap = await port.jwksKeyIds();
    invariant(
      overlap.length === 2 && overlap.includes(before[0]),
      `the JWKS serves ${overlap.join(', ')} during the overlap, expected ${before[0]} and a new key`,
    );
    const newKey = overlap.find((kid) => kid !== before[0])!;
    const newTokens: Partial<Record<RoleCloud, string>> = {};
    for (const cloud of ROLE_CLOUDS) {
      newTokens[cloud] = await port.mintToken(
        'api',
        port.audience(cloud),
        3600,
      );
      await this.#exchangeUntil(
        cloud,
        newTokens[cloud],
        true,
        NEW_KEY_MS,
        'new-key token',
      );
      await this.#exchangeUntil(
        cloud,
        oldTokens[cloud]!,
        true,
        POLL_MS,
        'old-key token during the overlap',
      );
      await this.#saveUntil(cloud, this.#name(cloud, 'pinned'), 'saved');
    }
    progress.mark(
      'role-key-rotation: both keys exchange on AWS, GCP and Azure',
    );
    const { refusedEarly } = await port.rotateSigningKey('retire');
    invariant(
      /409|overlap/iu.test(refusedEarly),
      `retire before the overlap's end without an override answered "${refusedEarly}", expected a refusal naming the overlap`,
    );
    const retiredAt = clock.now();
    const after = await port.jwksKeyIds();
    invariant(
      after.length === 1 && after[0] === newKey,
      `the JWKS serves ${after.join(', ')} after retirement, expected only ${newKey}`,
    );
    // Both bounds run from the retirement: the two waits start together.
    const refusedAfterMs: Partial<Record<'aws' | 'azure', number>> = {};
    await Promise.all(
      (['aws', 'azure'] as const).map(async (cloud) => {
        await this.#exchangeUntil(
          cloud,
          oldTokens[cloud]!,
          false,
          policy.retiredRefusalMs[cloud],
          'retired-key token',
        );
        refusedAfterMs[cloud] = clock.now() - retiredAt;
      }),
    );
    // The API restarted with a new-key token and still reaches Kubernetes:
    // each save mints its token there (TokenRequest).
    for (const cloud of ROLE_CLOUDS)
      await this.#saveUntil(cloud, this.#name(cloud, 'pinned'), 'saved');
    const polls: { at: number; accepted: boolean }[] = [];
    await this.#d.wait
      .for(
        'GCP refusing the retired key',
        async () => {
          const outcome = await port.exchange('gcp', oldTokens.gcp!);
          polls.push({ at: clock.now(), accepted: outcome.accepted });
          return outcome;
        },
        {
          timeoutMs: policy.gcpRetireWindowMs,
          intervalMs: GCP_POLL_MS,
          probeError: 'fail',
          unmet: (outcome) => (outcome.accepted ? 'accepted' : undefined),
        },
      )
      .catch((error: unknown) => {
        if (
          policy.gcpRetire === 'assert' ||
          !(error instanceof WaitTimeoutError)
        )
          throw error;
      });
    for (const cloud of ROLE_CLOUDS) {
      await this.#exchangeUntil(
        cloud,
        newTokens[cloud]!,
        true,
        POLL_MS,
        'new-key token after retirement',
      );
    }
    // The compromise arm: each trust revoked and recreated from its template,
    // GCP on a new provider ID so no JWKS cache carries over, then saved
    // again. The new key exchanges, and the recreated trust refuses a token
    // the retired key signed for it, on GCP too.
    const recreated: Partial<Record<RoleCloud, string>> = {};
    for (const cloud of ROLE_CLOUDS) {
      await port.replaceTrust(cloud);
      await this.#saveUntil(cloud, this.#name(cloud, 'recreated'), 'saved');
      await this.#exchangeUntil(
        cloud,
        await port.mintToken('api', port.audience(cloud), 600),
        true,
        policy.propagationMs,
        'new-key token on the recreated trust',
      );
      const outcome = await port.exchange(cloud, oldForReplacement[cloud]!);
      invariant(
        !outcome.accepted,
        `${cloud}'s recreated trust accepted a token the retired key signed`,
      );
      recreated[cloud] = outcome.refusal;
    }
    await port.record('role-key-rotation', {
      refusedEarly,
      keys: { before, overlap, after },
      refusedAfterMs,
      gcp: gcpRetireRecord(retiredAt, policy.gcpRetireWindowMs, polls),
      recreated,
    });
  }
}
