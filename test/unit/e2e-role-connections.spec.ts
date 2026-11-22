import { JWT } from 'google-auth-library';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  FOREIGN_AUDIENCE,
  gcpRetireRecord,
  RoleConnectionChecks,
  unexpectedFields,
  type ExchangeOutcome,
  type RoleCheckPolicy,
  type RoleCloud,
  type RoleConnectionsPort,
  type SaveOutcome,
  type TokenSubject,
  type TrustVariant,
} from '../integration/e2e/internal/contracts/role-connections.js';
import type {
  MintOutcome,
  TokenAttempt,
} from '../integration/e2e/internal/contracts/storage-tokens.js';
import {
  clusterCloudConfiguration,
  roleCheckPolicy,
} from '../integration/e2e/internal/substrates/cloud-cluster/configuration.js';
import {
  API_SUBJECT,
  argv,
  awsTrustPolicy,
  azureFederatedCredentials,
  exchangeOutcome,
  GcpTrust,
  gcpProviderFields,
  WRONG_AUDIENCE,
  WRONG_SUBJECT,
} from '../integration/e2e/internal/substrates/cloud-cluster/role-trusts.js';
import { roleObjectName } from '../integration/e2e/internal/substrates/cloud-cluster/role-connections.js';
import {
  pendingLanes,
  saveOutcome,
} from '../integration/e2e/internal/substrates/cloud-cluster/role-pending-lanes.js';
import type { CliRunOptions } from '../integration/e2e/internal/cli.js';
import { createApiClient } from '../../src/shared/services/api-client/rpc.js';
import { CloudType } from '../../src/shared/cloud.js';
import type { CommandResult } from '../integration/e2e/internal/types.js';
import { staleIds } from '../../ci/cleanup/e2e-cluster-stale-ids.js';
import {
  WaitTimeoutError,
  type Waiter,
} from '../integration/e2e/internal/wait.js';

const listCredentials = vi.hoisted(() => vi.fn());
vi.mock('../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: vi.fn(() => ({ credentials: { list: listCredentials } })),
}));

const HOST = 'e2e-clust-1.anycloud.sh';
const PROBE = {
  subject: 'system:serviceaccount:anycloud-system:anycloud-trust-probe',
  audience: 'anycloud-trust-probe',
};
// The pinned trust R1's CloudFormation template writes.
const PINNED = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { Federated: { Ref: 'Issuer' } },
      Action: 'sts:AssumeRoleWithWebIdentity',
      Condition: {
        StringEquals: {
          [`${HOST}:aud`]: 'sts.amazonaws.com',
          [`${HOST}:sub`]: API_SUBJECT,
        },
      },
    },
  ],
};

describe('role-connection trusts (RFC 0047 S15 and S17)', () => {
  test('AWS: each variant changes only the condition it names', () => {
    expect(awsTrustPolicy(PINNED, HOST, 'pinned')).toEqual(PINNED);
    expect(awsTrustPolicy(PINNED, HOST, 'short-session')).toEqual(PINNED);
    const condition = (variant: TrustVariant) =>
      awsTrustPolicy(PINNED, HOST, variant).Statement[0]!.Condition;
    expect(condition('wrong-audience')).toEqual({
      StringEquals: {
        [`${HOST}:aud`]: WRONG_AUDIENCE,
        [`${HOST}:sub`]: API_SUBJECT,
      },
    });
    expect(condition('wrong-subject')).toEqual({
      StringEquals: {
        [`${HOST}:aud`]: 'sts.amazonaws.com',
        [`${HOST}:sub`]: WRONG_SUBJECT,
      },
    });
    // Unpinned subject: any ServiceAccount of the issuer, the probe's too.
    expect(condition('any-subject')).toEqual({
      StringEquals: { [`${HOST}:aud`]: 'sts.amazonaws.com' },
      StringLike: { [`${HOST}:sub`]: 'system:serviceaccount:*' },
    });
    expect(condition('any-audience')).toEqual({
      StringEquals: { [`${HOST}:sub`]: API_SUBJECT },
    });
    expect(condition('issuer-only')).toBeUndefined();
    expect(
      awsTrustPolicy(PINNED, HOST, 'issuer-only').Statement[0],
    ).toMatchObject({
      Action: 'sts:AssumeRoleWithWebIdentity',
    });
  });

  test('AWS: a trust policy of several statements is refused, not guessed at', () => {
    expect(() =>
      awsTrustPolicy(
        { ...PINNED, Statement: [...PINNED.Statement, ...PINNED.Statement] },
        HOST,
        'pinned',
      ),
    ).toThrow(/more than one statement/u);
  });

  test('GCP: the provider keeps its pinned fields except the one a variant opens', () => {
    const pinned = {
      audiences: ['https://iam.googleapis.com/projects/1/x'],
      condition: `assertion.sub == '${API_SUBJECT}'`,
    };
    expect(gcpProviderFields(pinned, 'pinned', PROBE)).toEqual(pinned);
    expect(gcpProviderFields(pinned, 'wrong-audience', PROBE)).toEqual({
      ...pinned,
      audiences: [WRONG_AUDIENCE],
    });
    expect(
      gcpProviderFields(pinned, 'wrong-subject', PROBE).condition,
    ).toContain(WRONG_SUBJECT);
    expect(gcpProviderFields(pinned, 'any-subject', PROBE)).toEqual({
      ...pinned,
      condition: '',
    });
    expect(gcpProviderFields(pinned, 'any-audience', PROBE).audiences).toEqual([
      ...pinned.audiences,
      PROBE.audience,
    ]);
  });

  test("Azure: S17's unpinned trusts are a second credential beside the API's own", () => {
    const issuer = `https://${HOST}`;
    const own = {
      issuer,
      subject: API_SUBJECT,
      audiences: ['api://AzureADTokenExchange'],
    };
    expect(
      azureFederatedCredentials(issuer, own.audiences[0]!, 'pinned', PROBE),
    ).toEqual({ 'anycloud-api': own });
    expect(
      azureFederatedCredentials(
        issuer,
        own.audiences[0]!,
        'any-subject',
        PROBE,
      ),
    ).toEqual({
      'anycloud-api': own,
      'e2e-probe': { ...own, subject: PROBE.subject },
    });
    expect(
      azureFederatedCredentials(
        issuer,
        own.audiences[0]!,
        'any-audience',
        PROBE,
      )['e2e-probe'],
    ).toEqual({
      ...own,
      audiences: [PROBE.audience],
    });
    expect(
      azureFederatedCredentials(
        issuer,
        own.audiences[0]!,
        'wrong-subject',
        PROBE,
      ),
    ).toEqual({
      'anycloud-api': { ...own, subject: WRONG_SUBJECT },
    });
  });

  test("an exchange's answer: 2xx accepts, a refusal keeps its reason, throttling and 5xx are transient", () => {
    expect(exchangeOutcome(200, '{}')).toEqual({ accepted: true });
    expect(exchangeOutcome(403, '<Code>AccessDenied</Code>')).toEqual({
      accepted: false,
      refusal: '403 <Code>AccessDenied</Code>',
    });
    expect(exchangeOutcome(400, 'AADSTS700213')).toMatchObject({
      accepted: false,
    });
    expect(() => exchangeOutcome(429, 'slow down')).toThrow(/transient/u);
    expect(() => exchangeOutcome(503, 'unavailable')).toThrow(/transient/u);
  });

  test('a command line keeps each value whole, a JSON document with spaces too', () => {
    const policy = '{"a": "b c"}';
    expect(
      argv`iam update-assume-role-policy --role-name ${'r'} --policy-document ${policy}`,
    ).toEqual([
      'iam',
      'update-assume-role-policy',
      '--role-name',
      'r',
      '--policy-document',
      policy,
    ]);
    expect(argv`cloudformation deploy --tags anycloud_e2e=${'n'}`).toEqual([
      'cloudformation',
      'deploy',
      '--tags',
      'anycloud_e2e=n',
    ]);
  });

  const result = (
    exitCode: number | null,
    stderr = '',
    timedOut = false,
    stdout = '',
  ): CommandResult => ({
    exitCode,
    combined: `${stdout}${stderr}`,
    timedOut,
    aborted: false,
    signal: null,
    stdout,
    stderr,
    executable: 'anycloud',
    args: [],
    durationMs: 1,
    outputTruncated: false,
  });

  test("a save's answer: refused with its error line, saved with its listing, anything else throws", async () => {
    const none = () => Promise.resolve(undefined);
    await expect(
      saveOutcome(
        result(
          1,
          [
            `   Deploy the template at https://${HOST}/role-setup/aws (sub, aud, federated)`,
            '   ⚠ Could not finish checking the role connection; trying again',
            '   ✗ Failed to add credentials: the trust does not pin the subject',
            '     Pin it to system:serviceaccount:x:y',
            '',
          ].join('\n'),
        ),
        none,
      ),
    ).resolves.toEqual({
      saved: false,
      message:
        'Failed to add credentials: the trust does not pin the subject\nPin it to system:serviceaccount:x:y',
    });
    await expect(
      saveOutcome(result(0), () => Promise.resolve({ name: 'r' })),
    ).resolves.toEqual({ saved: true, listed: { name: 'r' } });
    await expect(saveOutcome(result(0), none)).rejects.toThrow(/not listed/u);
    await expect(saveOutcome(result(null, '', true), none)).rejects.toThrow(
      /did not finish/u,
    );
  });

  test("a hosted save is checked against the API's record, so a stored secret fails invariant 7", async () => {
    listCredentials.mockResolvedValue([
      {
        name: 'r',
        cloudProvider: 'aws',
        kind: 'role',
        roleArn: 'arn',
        secretAccessKey: 'leaked',
      },
    ]);
    const run = vi.fn((args: readonly string[], _options: CliRunOptions) =>
      Promise.resolve(
        result(0, '', false, args[0] === 'api' ? 'acapi_t\n' : ''),
      ),
    );
    const lanes = pendingLanes({
      cli: { run },
      hostedUrl: () => `https://${HOST}`,
    });
    const outcome = await lanes.save(
      'aws',
      'r',
      { 'role-arn': 'arn' },
      'hosted',
    );
    expect(createApiClient).toHaveBeenCalledWith('acapi_t', {
      apiUrl: `https://${HOST}`,
    });
    expect(run.mock.calls[1]?.[1]).toMatchObject({
      recordArtifact: false,
      env: { API_URL: `https://${HOST}` },
    });
    expect(outcome.saved && unexpectedFields('aws', outcome.listed)).toEqual([
      'secretAccessKey',
    ]);
  });

  test('object names are unique per run and reclaimed by the stale sweep once old', () => {
    const name = roleObjectName(1_700_000_000_000);
    expect(name).toMatch(/^e2e-role-1700000000000-[0-9a-f]{4}$/u);
    // GCP pool and service account IDs: at most 32 and 30 characters.
    expect(name.length).toBeLessThanOrEqual(30);
    expect(staleIds([name], 1_700_000_000_000 + 4 * 60 * 60_000)).toEqual([
      name,
    ]);
    expect(staleIds([name], 1_700_000_000_000 + 60_000)).toEqual([]);
  });

  test('a listed role connection may hold only its identifiers and trust (invariant 7)', () => {
    expect(
      unexpectedFields('aws', {
        name: 'r',
        cloudProvider: 'aws',
        kind: 'role',
        roleArn: 'arn',
      }),
    ).toEqual([]);
    expect(
      unexpectedFields('aws', {
        name: 'r',
        roleArn: 'arn',
        secretAccessKey: 'x',
      }),
    ).toEqual(['secretAccessKey']);
    expect(
      unexpectedFields('gcp', {
        name: 'r',
        privateKey: 'k',
        serviceAccountEmail: 'e',
      }),
    ).toEqual(['privateKey']);
  });
});

describe('role-connection check configuration', () => {
  test.each([
    [{ E2E_CLUSTER_LIVE_CHECKS: 'role-connections' }, /run on hosted_stage/u],
  ])('%j is refused before any cloud call', (env, message) => {
    expect(() =>
      clusterCloudConfiguration(
        (name) => (env as Record<string, string>)[name] ?? '',
      ),
    ).toThrow(message);
  });

  test('all three run on an AWS hosted journey', () => {
    const env: Record<string, string> = {
      E2E_CLUSTER_HOSTED_STAGE: 'true',
      E2E_CLUSTER_LIVE_CHECKS:
        'role-connections,role-trust-pinning,role-key-rotation',
    };
    expect(
      clusterCloudConfiguration((name) => env[name] ?? '').liveChecks,
    ).toEqual(['role-connections', 'role-trust-pinning', 'role-key-rotation']);
  });

  test("GCP's retire is recorded or asserted, nothing else", () => {
    expect(roleCheckPolicy('run', 'record').gcpRetire).toBe('record');
    expect(roleCheckPolicy('run', 'assert').gcpRetire).toBe('assert');
    expect(() => roleCheckPolicy('run', 'wait')).toThrow(/record or assert/u);
  });

  test("GCP's retire record: the first refusal's delay, or none in the window", () => {
    expect(
      gcpRetireRecord(100, 1000, [
        { at: 300, accepted: true },
        { at: 600, accepted: false },
      ]),
    ).toEqual({
      windowMs: 1000,
      refusedAfterMs: 500,
      polls: 2,
    });
    expect(
      gcpRetireRecord(100, 1000, [{ at: 300, accepted: true }]),
    ).toMatchObject({ refusedAfterMs: null });
  });
});

/**
 * A cloud as the checks see it: the trust's state decides each save and
 * exchange, and `pinnedAccepts` makes the "pinned" trust accept a token it
 * must refuse.
 */
class FakeClouds implements RoleConnectionsPort {
  readonly variants: Record<RoleCloud, TrustVariant> = {
    aws: 'pinned',
    gcp: 'pinned',
    azure: 'pinned',
  };
  keys = ['k1'];
  retired = false;
  gcpRefusesRetired = false;
  readonly records: Record<string, unknown> = {};
  readonly saves: string[] = [];
  pinnedAccepts: TokenSubject | 'foreign' | undefined;
  /** Exchanges of a retired key AWS still accepts, as its JWKS cache lags. */
  awsLag = 0;
  azureRefuses: TrustVariant | undefined;

  async trust(): Promise<void> {}
  async applyVariant(cloud: RoleCloud, variant: TrustVariant) {
    if (cloud === 'azure' && variant === this.azureRefuses)
      return 'ARM 400 audience not allowed';
    this.variants[cloud] = variant;
    return undefined;
  }
  async save(
    cloud: RoleCloud,
    name: string,
    api: 'hosted' | 'local',
  ): Promise<SaveOutcome> {
    this.saves.push(name);
    if (api === 'local')
      return {
        saved: false,
        message: 'a local API has no ServiceAccount token to exchange.',
      };
    const message = {
      pinned: undefined,
      'short-session': 'MaxSessionDuration is 1 hour',
      'wrong-audience': 'the audience was refused',
      'wrong-subject': 'the subject was refused',
      'any-subject': 'the trust does not pin the subject',
      'any-audience': 'the trust does not pin the audience',
      'issuer-only': 'the trust does not pin the subject',
    }[this.variants[cloud]];
    return message
      ? { saved: false, message }
      : { saved: true, listed: { name, cloudProvider: cloud, kind: 'role' } };
  }
  replaced: RoleCloud[] = [];
  audience(
    cloud: RoleCloud,
    trust: 'current' | 'replacement' = 'current',
  ): string {
    return trust === 'replacement' || this.replaced.includes(cloud)
      ? `aud-${cloud}-replacement`
      : `aud-${cloud}-current`;
  }
  async replaceTrust(cloud: RoleCloud): Promise<void> {
    this.replaced.push(cloud);
  }
  async mintToken(subject: TokenSubject, audience: string): Promise<string> {
    return JSON.stringify({ subject, audience, key: this.keys.at(-1) });
  }
  async exchange(cloud: RoleCloud, token: string): Promise<ExchangeOutcome> {
    const { subject, audience, key } = JSON.parse(token) as {
      subject: string;
      audience: string;
      key: string;
    };
    const foreign = audience === FOREIGN_AUDIENCE;
    if (subject === 'probe' || foreign)
      return this.pinnedAccepts === (foreign ? 'foreign' : subject)
        ? { accepted: true }
        : { accepted: false, refusal: '403' };
    const retiredKey = !this.keys.includes(key);
    // GCP's cache keeps a retired key for a provider that existed before.
    const cached =
      cloud === 'gcp' &&
      !this.gcpRefusesRetired &&
      !audience.endsWith('replacement');
    if (retiredKey && cloud === 'aws' && this.awsLag > 0) {
      this.awsLag -= 1;
      return { accepted: true };
    }
    if (retiredKey && !cached)
      return { accepted: false, refusal: 'unknown kid' };
    return { accepted: true };
  }
  async jwksKeyIds() {
    return this.keys;
  }
  rotateSigningKey(step: 'add'): Promise<void>;
  rotateSigningKey(step: 'retire'): Promise<{ readonly refusedEarly: string }>;
  async rotateSigningKey(
    step: 'add' | 'retire',
  ): Promise<void | { readonly refusedEarly: string }> {
    if (step === 'add') {
      this.keys = [...this.keys, 'k2'];
      return undefined;
    }
    this.keys = ['k2'];
    return { refusedEarly: '409: the overlap ends at 2026-11-07T20:00:00Z' };
  }
  async outputThrough(_cloud: RoleCloud, _connection: string, content: string) {
    return `${content}\n`;
  }
  async record(name: string, value: unknown) {
    this.records[name] = value;
  }
  /** The mints, and what their tokens may do. */
  mints: unknown[] = [];
  removedBuckets: string[] = [];
  deletes: Record<RoleCloud, boolean> = { aws: false, gcp: true, azure: false };
  /** A slow cloud spends the token's life on its refusals. */
  slow = false;
  /** GCP refuses its role token while the clock is still short of expiry. */
  refusesEarly = false;
  now = 0;
  #cloud: RoleCloud = 'aws';
  #reads = 0;
  async tokenBucket(cloud: RoleCloud) {
    const bucket = `bucket-${cloud}`;
    return {
      bucket,
      remove: async () => {
        this.removedBuckets.push(bucket);
      },
    };
  }
  async mint(
    _connection: string,
    cloud: RoleCloud,
    grants: readonly unknown[],
    lifetimeSeconds: number,
  ): Promise<MintOutcome> {
    this.mints.push({ cloud, grants, lifetimeSeconds });
    this.#cloud = cloud;
    this.#reads = 0;
    const lifetime = { aws: 900_000, gcp: 600_000, azure: 300_000 }[cloud];
    return {
      status: 200,
      tokens: [{ grants: [0], expiresAt: this.now + lifetime }],
    };
  }
  async tokenRead(_bucket: string, key: string): Promise<TokenAttempt> {
    // GCP's role token expires after a few polls.
    this.#reads += 1;
    if (this.#cloud === 'gcp' && this.#reads > 2) {
      if (!this.refusesEarly) this.now = 600_000;
      return { allowed: false, refusal: '401' };
    }
    return key.startsWith('rw/')
      ? { allowed: true, digest: 'd' }
      : { allowed: false, refusal: '403' };
  }
  async tokenWrite(_bucket: string, key: string): Promise<TokenAttempt> {
    if (this.slow && !key.startsWith('rw/')) this.now = 900_000;
    return key.startsWith('rw/')
      ? { allowed: true, digest: 'd' }
      : { allowed: false, refusal: '403' };
  }
  async tokenRemove(): Promise<TokenAttempt> {
    return this.deletes[this.#cloud]
      ? { allowed: true, digest: 'removed' }
      : { allowed: false, refusal: '403' };
  }
}

/** Waits running at once, and the most seen together. */
const overlap = { running: 0, most: 0 };
const wait: Pick<Waiter, 'for'> = {
  for: async (label, probe, options) => {
    overlap.running += 1;
    overlap.most = Math.max(overlap.most, overlap.running);
    try {
      return await poll(label, probe, options);
    } finally {
      overlap.running -= 1;
    }
  },
};

const poll: Pick<Waiter, 'for'>['for'] = async (label, probe, options) => {
  let unmet: string | undefined;
  for (let poll = 0; poll < 4; poll += 1) {
    await Promise.resolve();
    const value = await probe(0);
    const rejection = options.reject?.(value);
    if (rejection) throw new Error(`${label}: ${rejection}`);
    unmet = options.unmet(value);
    if (unmet === undefined) return value;
  }
  throw new WaitTimeoutError(`${label}: timed out: ${String(unmet)}`);
};

const policy = (overrides: Partial<RoleCheckPolicy> = {}): RoleCheckPolicy => ({
  ...roleCheckPolicy('run1', 'record'),
  ...overrides,
});

function checks(
  port: FakeClouds,
  overrides: Partial<RoleCheckPolicy> = {},
  clock = { now: () => 0 },
) {
  return new RoleConnectionChecks({
    port,
    policy: policy(overrides),
    wait,
    progress: { mark: () => {} },
    clock,
  });
}

describe('role-connection checks', () => {
  test('a member mints a prefix token on each role connection', async () => {
    const port = new FakeClouds();
    await checks(port, {}, { now: () => port.now }).storageTokens();
    // A noDelete rw/ grant, for five minutes so Azure's token outlives the checks.
    expect(port.mints).toEqual(
      ['aws', 'gcp', 'azure'].map((cloud) => ({
        cloud,
        grants: [
          {
            bucket: `bucket-${cloud}`,
            prefix: 'rw/',
            mode: 'readwrite',
            noDelete: true,
          },
        ],
        lifetimeSeconds: 300,
      })),
    );
    // Deleted before role-key-rotation revokes the trusts that sign them.
    expect(port.removedBuckets).toEqual([
      'bucket-aws',
      'bucket-gcp',
      'bucket-azure',
    ]);
    expect(port.records['role-storage-tokens']).toMatchObject({
      aws: { lifetime: 900_000 },
      gcp: { lifetime: 600_000 },
      azure: { lifetime: 300_000 },
    });
  });

  test('a token near its expiry before the checks finish fails the check', async () => {
    const port = new FakeClouds();
    port.slow = true;
    await expect(
      checks(port, {}, { now: () => port.now }).storageTokens(),
    ).rejects.toThrow(/aws: the minted token neared its expiry/u);
  });

  test('a GCP role token refused before its expiry fails the check', async () => {
    const port = new FakeClouds();
    port.refusesEarly = true;
    await expect(
      checks(port, {}, { now: () => port.now }).storageTokens(),
    ).rejects.toThrow(/gcp: the role token was refused before its expiry/u);
  });

  test('an AWS token that deletes inside its grant fails the check', async () => {
    const port = new FakeClouds();
    port.deletes.aws = true;
    await expect(checks(port).storageTokens()).rejects.toThrow(
      /aws: deleting inside rw\/ was allowed/u,
    );
  });

  test('S14 and S15: each cloud saves, writes through its connection and refuses every wrong trust', async () => {
    const port = new FakeClouds();
    await checks(port).roleConnections();
    const record = port.records['role-connections'] as Record<
      RoleCloud,
      { refusals: Record<string, string> }
    >;
    expect(Object.keys(record.aws.refusals)).toEqual([
      'short-session',
      'wrong-audience',
      'wrong-subject',
    ]);
    expect(Object.keys(record.gcp.refusals)).toEqual([
      'wrong-audience',
      'wrong-subject',
    ]);
    expect(port.variants).toEqual({
      aws: 'pinned',
      gcp: 'pinned',
      azure: 'pinned',
    });
  });

  test.each(['probe', 'foreign'] as const)(
    'S14 fails when the pinned trust accepts the %s token',
    async (accepted) => {
      const port = new FakeClouds();
      port.pinnedAccepts = accepted;
      await expect(checks(port).roleConnections()).rejects.toThrow(
        /pinned trust accepted/u,
      );
    },
  );

  test("S17: Azure's impossible misconfiguration is recorded as not applicable", async () => {
    const port = new FakeClouds();
    port.azureRefuses = 'any-audience';
    await checks(port).trustPinning();
    const record = port.records['role-trust-pinning'] as Record<
      RoleCloud,
      Record<string, string>
    >;
    expect(record.azure['any-audience']).toMatch(/^not applicable: ARM 400/u);
    expect(record.aws['issuer-only']).toMatch(/does not pin/u);
  });

  test("S16 records GCP's retire when it still accepts the old key", async () => {
    const port = new FakeClouds();
    await checks(port).keyRotation();
    expect(port.records['role-key-rotation']).toMatchObject({
      keys: { before: ['k1'], overlap: ['k1', 'k2'], after: ['k2'] },
      gcp: { refusedAfterMs: null },
    });
  });

  test("S16: AWS refusing late leaves Azure's bound intact; both run from the retirement", async () => {
    const port = new FakeClouds();
    port.awsLag = 2;
    let now = 0;
    overlap.most = 0;
    // Each clock read is a minute later: AWS's polls outlast Azure's 2-minute bound.
    await checks(port, {}, { now: () => (now += 60_000) }).keyRotation();
    expect(port.records['role-key-rotation']).toMatchObject({
      // Started together: Azure, refusing at once, is read first; run one after
      // the other, AWS would be.
      refusedAfterMs: { aws: 120_000, azure: 60_000 },
    });
    // The two retired-key waits ran at the same time.
    expect(overlap.most).toBe(2);
  });

  test('S16 with gcpRetire assert fails when GCP still accepts the old key, and passes once it refuses', async () => {
    const accepting = new FakeClouds();
    await expect(
      checks(accepting, { gcpRetire: 'assert' }).keyRotation(),
    ).rejects.toThrow(/GCP refusing the retired key/u);
    const refusing = new FakeClouds();
    refusing.gcpRefusesRetired = true;
    await checks(refusing, { gcpRetire: 'assert' }).keyRotation();
    expect(refusing.records['role-key-rotation']).toMatchObject({
      gcp: { refusedAfterMs: 0 },
    });
  });
});

describe('GCP role trust and IAM eventual consistency', () => {
  const NAME = 'e2e-role-1-abcd';
  const POOL = `projects/p1/locations/global/workloadIdentityPools/${NAME}`;
  const PROVIDER = `${POOL}/providers/${NAME}`;
  const EMAIL = `${NAME}@p1.iam.gserviceaccount.com`;
  const IAM = 'https://iam.googleapis.com/v1';
  const ACCOUNT = `${IAM}/projects/p1/serviceAccounts/${EMAIL}`;

  /** Each GET answers from its queue, the last answer repeating; writes are logged. */
  function iam(gets: Record<string, { status: number; data?: unknown }[]>) {
    const writes: string[] = [];
    vi.spyOn(JWT.prototype, 'request').mockImplementation((async (options: {
      method?: string;
      url: string;
      data?: unknown;
      validateStatus?: unknown;
    }) => {
      const method = options.method ?? 'GET';
      if (options.url.endsWith(':getIamPolicy'))
        return { status: 200, data: { bindings: [], etag: 'e' } };
      if (method !== 'GET') {
        writes.push(`${method} ${options.url}`);
        const resource = options.url.slice(IAM.length + 1);
        // A pool or provider reads ACTIVE once more after its DELETE.
        if (method === 'DELETE' && gets[resource])
          gets[resource] = [
            { status: 200, data: { state: 'ACTIVE' } },
            { status: 200, data: { state: 'DELETED' } },
          ];
        return { status: 200, data: {} };
      }
      const queue =
        gets[options.url] ?? gets[options.url.slice(IAM.length + 1)];
      if (!queue) throw new Error(`unexpected GET ${options.url}`);
      const answer = queue.length > 1 ? queue.shift()! : queue[0]!;
      // Like gaxios, a request without validateStatus throws on a non-2xx.
      if (!options.validateStatus && answer.status >= 300)
        throw Object.assign(new Error(`status ${answer.status}`), {
          status: answer.status,
        });
      return { status: answer.status, data: answer.data ?? {} };
    }) as unknown as JWT['request']);
    return writes;
  }

  const trust = () =>
    new GcpTrust(
      {
        name: NAME,
        issuer: 'https://issuer',
        probe: PROBE,
        wait,
        runner: {
          run: async (command: string): Promise<CommandResult> => {
            const stdout =
              command === 'bash'
                ? `workload identity provider: ${PROVIDER}\nservice account email: ${EMAIL}\n`
                : '';
            return {
              executable: command,
              args: [],
              exitCode: 0,
              signal: null,
              stdout,
              stderr: '',
              combined: stdout,
              durationMs: 0,
              timedOut: false,
              aborted: false,
              outputTruncated: false,
            };
          },
        },
      },
      {
        cloudProvider: CloudType.GCP,
        projectId: 'p1',
        clientEmail: 'ci@p1.iam.gserviceaccount.com',
        privateKey: 'unused',
      },
    );

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('deploy waits out a 404 for the provider the script just created', async () => {
    iam({
      [PROVIDER]: [
        { status: 404 },
        { status: 404 },
        {
          status: 200,
          data: {
            attributeCondition: 'c',
            oidc: { allowedAudiences: ['a'] },
          },
        },
      ],
    });
    await expect(trust().deploy('script')).resolves.toEqual({
      identifiers: {
        'workload-identity-provider': PROVIDER,
        'service-account-email': EMAIL,
      },
      audience: `https://iam.googleapis.com/${PROVIDER}`,
    });
  });

  test('deploy fails at once on any other error, and when the provider never appears', async () => {
    iam({ [PROVIDER]: [{ status: 403 }] });
    await expect(trust().deploy('script')).rejects.toThrow(/status 403/u);
    vi.restoreAllMocks();
    iam({ [PROVIDER]: [{ status: 404 }] });
    await expect(trust().deploy('script')).rejects.toThrow(
      /provider .* readable: timed out: status 404/u,
    );
  });

  test('remove waits for a deleted service account to read 404, and a deleted provider and pool to read DELETED', async () => {
    const writes = iam({
      [ACCOUNT]: [{ status: 200 }, { status: 200 }, { status: 404 }],
      [PROVIDER]: [{ status: 200, data: { state: 'ACTIVE' } }],
      [POOL]: [{ status: 200, data: { state: 'ACTIVE' } }],
    });
    await expect(trust().remove()).resolves.toEqual([
      `service account ${EMAIL} and its project binding`,
      `${PROVIDER} (DELETED)`,
      `${POOL} (DELETED)`,
    ]);
    expect(writes).toEqual([
      `DELETE ${ACCOUNT}`,
      `DELETE ${IAM}/${PROVIDER}`,
      `DELETE ${IAM}/${POOL}`,
    ]);
  });

  test('remove still deletes the provider and pool when the service account remains, then fails', async () => {
    const writes = iam({
      [ACCOUNT]: [{ status: 200 }],
      [PROVIDER]: [{ status: 200, data: { state: 'ACTIVE' } }],
      [POOL]: [{ status: 200, data: { state: 'ACTIVE' } }],
    });
    await expect(trust().remove()).rejects.toThrow(
      /service account remains \(200\)/u,
    );
    expect(writes).toEqual([
      `DELETE ${ACCOUNT}`,
      `DELETE ${IAM}/${PROVIDER}`,
      `DELETE ${IAM}/${POOL}`,
    ]);
  });

  test('remove fails at once when the service account read is refused, still deleting the provider and pool', async () => {
    const writes = iam({
      [ACCOUNT]: [{ status: 200 }, { status: 403 }],
      [PROVIDER]: [{ status: 200, data: { state: 'ACTIVE' } }],
      [POOL]: [{ status: 200, data: { state: 'ACTIVE' } }],
    });
    await expect(trust().remove()).rejects.toThrow(/deleted: status 403/u);
    expect(writes).toEqual([
      `DELETE ${ACCOUNT}`,
      `DELETE ${IAM}/${PROVIDER}`,
      `DELETE ${IAM}/${POOL}`,
    ]);
  });
});
