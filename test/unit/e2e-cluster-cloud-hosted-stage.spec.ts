import { readFileSync } from 'node:fs';

import chalk from 'chalk';
import { beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest';

import {
  printError,
  printInfo,
  printSuccess,
} from '../../src/cli/utils/output.js';
import { formatClusterList } from '../../src/cli/commands/cluster.js';
import { validateId } from '../../src/api/services/workload-admission-checks.js';
import { throughBucketStorage } from '../../src/api/services/bucket-storage-operation.js';
import { CloudType } from '../../src/shared/cloud.js';
import { BucketThrottledError } from '../../src/shared/errors.js';
import { WorkloadState } from '../../src/shared/workload.js';
import { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import {
  FixtureNames,
  RUN_ID_LENGTH,
} from '../integration/e2e/internal/names.js';
import {
  HOSTED_VERDICT,
  HostedApiStage,
  type HostedStageOptions,
  assertHostedStageConfiguration,
  credentialsNewArgs,
  REFUSED_RELEASE_IMAGE,
  watchRequests,
} from '../integration/e2e/internal/substrates/cloud-cluster/hosted-stage.js';
import type { ServeDnsAbsenceObservation } from '../integration/e2e/internal/targets/serve-types.js';
import { Waiter } from '../integration/e2e/internal/wait.js';
import { commandResultForTest } from './helpers/e2e.js';
import {
  makeMockCloudStorage,
  makeStatusWorkloadMetadata,
} from './helpers/fixtures.js';

// validateId's uniqueness read: no workload exists yet.
vi.mock('../../src/api/services/persistence.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getWorkloadQueryStore: () => ({ workloadExists: async () => false }),
}));

const RUN_ID = 'r'.repeat(RUN_ID_LENGTH);
const NAMES = new FixtureNames(RUN_ID);
const ID = {
  service: NAMES.workload('service'),
  parent: NAMES.workload('rec-parent'),
  child: NAMES.workload('rec-child'),
};
const HOSTED_URL = 'https://e2e-clust-1.anycloud.sh';
const A = `ghcr.io/anycloud-sh/api:0.0.3@sha256:${'a'.repeat(64)}`;
const B = `ghcr.io/anycloud-sh/api:0.0.3@sha256:${'b'.repeat(64)}`;
const OCTOCAT = { userId: '583231', username: 'octocat' };
const API_COMMAND_SOURCE = readFileSync(
  new URL('../../src/cli/commands/api.ts', import.meta.url),
  'utf8',
);

/**
 * The template literals in `src/cli/commands/api.ts` that produce the
 * plain-line hosted verdicts. The
 * fixtures below are rendered from these through the CLI's own print helpers,
 * and a test asserts the source still carries them, so the stage's matchers
 * cannot drift from the CLI silently.
 */
const API_UPGRADE_FORMATS = {
  started:
    '`Hosted API upgrade ${result.upgrade.number} started: ${releaseStatus.servedVersion} → ${result.upgrade.apiVersion}.`',
  unchanged:
    '`Hosted API ${activeTarget.url} already runs ${image}; nothing to do (unchanged).`',
  accepted:
    '`Hosted API ${activeTarget.url} accepted the upgrade to ${image}.`',
  // exitWithLifecycleError prints `${failure}: ${message}` without --json.
  refused: "'Hosted API upgrade refused',",
} as const;

/** Runs the CLI's print helpers and returns what a non-TTY run sees: no colour, stdout and stderr interleaved. */
function printed(emit: () => void): string {
  const lines: string[] = [];
  const capture = (line: unknown) => {
    lines.push(String(line));
  };
  const log = vi.spyOn(console, 'log').mockImplementation(capture);
  const error = vi.spyOn(console, 'error').mockImplementation(capture);
  const level = chalk.level;
  chalk.level = 0;
  try {
    emit();
  } finally {
    chalk.level = level;
    log.mockRestore();
    error.mockRestore();
  }
  return `${lines.join('\n')}\n`;
}

/** The local API's line, which a hosted upgrade must never print. */
const localApiLine = () =>
  printInfo(
    'Local API server already matches installed anycloud 0.0.3; no restart needed.',
  );

/** `api upgrade --image` for a hosted target: the started verdict. */
function startedOutput(upgrade: number): string {
  return printed(() => {
    printInfo('K3s step: configuration current 1s ago');
    printSuccess(
      `Hosted API upgrade ${String(upgrade)} started: 0.0.3 → 0.0.3.`,
    );
  });
}

function unchangedOutput(image: string): string {
  return printed(() => {
    printSuccess(
      `Hosted API ${HOSTED_URL} already runs ${image}; nothing to do (unchanged).`,
    );
  });
}

function acceptedOutput(image: string): string {
  return printed(() => {
    printSuccess(`Hosted API ${HOSTED_URL} accepted the upgrade to ${image}.`);
  });
}

function refusedOutput(): string {
  return printed(() => {
    printError(
      'Hosted API upgrade refused: Release refused: image must be a digest-pinned reference from the official repository (SYSTEM_RELEASE_REFUSED)',
    );
  });
}

/** `api status --json` with Upgrade `number` in `state`. */
function statusOutput(
  number: number,
  state: WorkloadState = WorkloadState.Running,
  lastError: string | null = null,
  generation = 2,
): string {
  return JSON.stringify({
    url: HOSTED_URL,
    healthy: true,
    release: {
      servedVersion: '0.0.3',
      schemaVersion: '0.0.3',
      upgrade: {
        number,
        apiVersion: '0.0.3',
        apiImage: B,
        state,
        lastError,
        createdAt: 1,
        updatedAt: 1,
      },
      rollout: {
        observedGeneration: generation,
        replicas: 1,
        updatedReplicas: 1,
        readyReplicas: 1,
        conditions: [],
      },
    },
  });
}

/**
 * The human `cluster list` through the hosted API, rendered by the CLI's own
 * table: its own cluster's record carries no creation facts.
 */
const CLUSTER_LIST_OUTPUT = formatClusterList([
  {
    id: 'e2e-clust-1',
    name: 'e2e-clust-1',
    state: WorkloadState.Running,
    releasing: false,
    cloudProvider: null,
    cloudAccount: null,
    region: null,
    zone: null,
    vmType: null,
    k3sVersion: null,
    managementVmId: null,
    networkScope: null,
    checkpointBucket: null,
    apiVersion: '0.0.3',
    apiImage: null,
    chartVersion: null,
    connected: true,
    kubernetesIdentity: 'uid-1',
    connectionRevision: 1,
    address: '203.0.113.5',
    managementApiUrl: HOSTED_URL,
    release: null,
    lastError: null,
    createdAt: Date.now() - 7_200_000,
    updatedAt: 1,
  },
]);

/** `status --json` for one workload, as the hosted API answers it. */
const statusJson = (
  id: string,
  state: WorkloadState,
  cleanedAt: number | null = null,
  message?: string,
) =>
  JSON.stringify({
    workload: makeStatusWorkloadMetadata({ id, state, cleanedAt }),
    events: message
      ? [{ id: 1, workloadId: id, state, metadata: { message }, createdAt: 1 }]
      : [],
    status: '-',
  });

/**
 * `api access` as the hosted API answers it: octocat can be shared once, an
 * organization is refused, and removing an absent user fails.
 */
function accessAnswer(
  args: readonly string[],
  users: { userId: string; username: string }[],
): object | undefined {
  if (args[0] !== 'api' || args[1] !== 'access') return undefined;
  const target = args[3];
  if (args[2] === 'list') {
    return {
      stdout: JSON.stringify({
        owner: { userId: '1', username: 'runner' },
        users: users.map((user) => ({ kind: 'github', ...user })),
      }),
    };
  }
  if (args[2] === 'add') {
    if (target === 'anycloud-sh') {
      return {
        exitCode: 1,
        combined:
          'anycloud-sh is a GitHub organization, not a user account. Add its members individually.',
      };
    }
    users.push(OCTOCAT);
    return { combined: 'octocat can now use this API' };
  }
  const index = users.findIndex(
    (user) => user.username === target || user.userId === target,
  );
  if (index < 0) {
    return {
      exitCode: 1,
      combined: `GitHub user "${target}" does not have hosted API access.`,
    };
  }
  users.splice(index, 1);
  return { combined: 'no longer has hosted API access' };
}

/**
 * Probes up to `polls` times without sleeping, applying the wait's reject,
 * unmet and probe error rules, so a test can walk a rollout poll by poll.
 */
function pollsWaiter(polls: number): Pick<Waiter, 'for'> {
  return {
    for: async (label, probe, options) => {
      let unmet: string | undefined;
      for (let poll = 0; poll < polls; poll += 1) {
        let value;
        try {
          value = await probe(Date.now() + options.timeoutMs);
        } catch (error) {
          const policy = options.probeError;
          if (policy === 'fail' || !policy.retry(error)) throw error;
          continue;
        }
        const rejection = options.reject?.(value);
        if (rejection) throw new Error(`${label}: ${rejection}`);
        unmet = options.unmet(value);
        if (unmet === undefined) return value;
      }
      throw new Error(`${label}: timed out: ${unmet ?? ''}`);
    },
  };
}

/** Each authority's answer for `hostname`: an A record, or NXDOMAIN. */
function dnsAnswers(
  hostname: string,
  presences: readonly ('present' | 'absent')[] = ['present', 'present'],
): ServeDnsAbsenceObservation {
  const authorities = ['ns1.cloudflare.com', 'ns2.cloudflare.com'];
  return {
    hostname,
    authorities,
    answers: authorities.map((authority, n) => ({
      authority,
      address: `198.51.100.${n + 1}`,
      presence: presences[n]!,
      diagnostic:
        presences[n] === 'present'
          ? 'A 104.16.0.1'
          : `queryA ENOTFOUND ${hostname}`,
    })),
  };
}

/** `bucket list`: buckets include the backup bucket, which itself is refused. */
function backupBucketListing(args: readonly string[]): object {
  return args.includes('cluster-1')
    ? {
        exitCode: 1,
        combined:
          '✗ List failed: Bucket "cluster-1" is this API\'s own backup bucket and cannot be used through the bucket API.',
      }
    : {
        stdout: JSON.stringify({
          entries: [{ name: 'cluster-1' }],
          truncated: false,
          nextCursor: null,
        }),
      };
}

function stage(
  answer: (args: readonly string[]) => object,
  versionAnswers: Array<{ status: number; body?: unknown }> = [],
  wait: Pick<Waiter, 'for'> = new Waiter(new AbortController().signal),
  credential: HostedStageOptions['credential'] = {
    name: 'aws-test',
    material: {
      cloudProvider: CloudType.AWS,
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
    },
  },
  extra: Partial<HostedStageOptions> = {},
) {
  const calls: { args: string[]; apiUrl: string | undefined }[] = [];
  const slept: number[] = [];
  let backups = 3;
  const cleanup = new CleanupStack();
  const artifacts = { json: vi.fn(async () => 'artifact.json') };
  const probes: string[] = [];
  const version = () =>
    versionAnswers.shift() ?? {
      status: 200,
      body: { version: '0.0.3', schemaVersion: '0.0.3' },
    };
  const run = vi.fn<HostedStageOptions['cli']['run']>(async (args, options) => {
    calls.push({ args: [...args], apiUrl: options?.env?.API_URL });
    return commandResultForTest(answer(args));
  });
  const hosted = new HostedApiStage(
    {
      artifacts,
      cleanup,
      cli: { run },
      runner: {
        // Recorded after the stage's own calls settle, as a real probe is.
        run: async (_executable, _args, options) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          probes.push(options?.label ?? '');
          throw new Error('probe runner down');
        },
      },
      http: { get: vi.fn(async () => version()) as never },
      dns: { observe: async (hostname) => dnsAnswers(hostname) },
      sleep: async (ms) => {
        slept.push(ms);
      },
      wait,
      names: new FixtureNames(RUN_ID),
      credential,
      vm: { region: 'us-east-2', vmType: 't3.small' },
      service: { image: 'nginx:1.27', port: 80 },
      redactor: { add: vi.fn() },
      token: 'harness-token',
      timeouts: {
        workloadMs: 30_000,
        releaseMs: 30_000,
        recursionMs: 30_000,
      },
      ...extra,
    },
    {
      url: () => HOSTED_URL,
      backupVersions: async () => backups,
      bucket: () => 'cluster-1',
      upgradeRequested: () => undefined,
    },
  );
  return {
    hosted,
    calls,
    run,
    cleanup,
    slept,
    artifacts,
    probes,
    bumpBackups: () => (backups += 1),
  };
}

/**
 * A stage whose `api status --json` prints `status()`, whose `cluster list`
 * shows the API's own cluster running, and whose other calls answer
 * `onUpdate`, which can bump the backup count.
 */
function releaseStage(
  onUpdate: (args: readonly string[], bumpBackups: () => void) => object,
  options: {
    readonly status?: () => string;
    readonly polls?: number;
    readonly versions?: Array<{ status: number; body?: unknown }>;
  } = {},
) {
  const status = options.status ?? (() => statusOutput(1));
  const built: ReturnType<typeof stage> = stage(
    (args) =>
      args[0] === 'api' && args[1] === 'status'
        ? { stdout: status() }
        : args[0] === 'cluster' && args[1] === 'list'
          ? { stdout: CLUSTER_LIST_OUTPUT }
          : onUpdate(args, () => built.bumpBackups()),
    options.versions,
    options.polls ? pollsWaiter(options.polls) : undefined,
  );
  return built;
}

describe('e2e-cluster-cloud hosted-API stage', () => {
  // Each release polls the hosted API's `/health`.
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok')),
    );
    return () => vi.unstubAllGlobals();
  });

  test('every workload ID the stage creates passes the product validation', async () => {
    for (const id of Object.values(ID)) {
      await expect(validateId(id)).resolves.toBe(id);
    }
  });

  test('drives the operator walk against the hosted API; only api use runs on the installer target', async () => {
    const users: (typeof OCTOCAT)[] = [];
    const { hosted, calls } = stage(
      (args) => accessAnswer(args, users) ?? { combined: 'Saved to api-url' },
    );
    await hosted.operatorWalk();
    expect(
      calls.map((call) => [...call.args.slice(0, 3), call.apiUrl]),
    ).toEqual([
      ['api', 'use', HOSTED_URL, undefined],
      ['credentials', 'new', '--provider', HOSTED_URL],
      ['api', 'access', 'add', HOSTED_URL],
      ['api', 'access', 'list', HOSTED_URL],
      ['api', 'access', 'add', HOSTED_URL],
      ['api', 'access', 'remove', HOSTED_URL],
      ['api', 'access', 'list', HOSTED_URL],
    ]);
    expect(calls[4].args).toEqual(['api', 'access', 'add', 'anycloud-sh']);
    expect(users).toEqual([]);
    expect(calls[0].args).toEqual(['api', 'use', HOSTED_URL]);
  });

  test('runs a VM Service through the hosted API on the cluster credential, region and VM type', async () => {
    const { hosted, calls } = stage((args) =>
      args[0] === 'status'
        ? { stdout: statusJson(ID.service, WorkloadState.Running) }
        : { combined: `ID: ${ID.service}` },
    );
    await expect(hosted.runService()).resolves.toBe(ID.service);
    expect(calls[0]).toEqual({
      args: expect.arrayContaining([
        'service',
        '--credentials',
        'aws-test',
        '--region',
        'us-east-2',
        '--vm-type',
        't3.small',
        '--id',
        ID.service,
        '--env',
        'PORT=80',
        'nginx:1.27',
      ]),
      apiUrl: HOSTED_URL,
    });
    expect(calls[0]!.args).not.toContain('--node-pool');
  });

  test('saves an Azure credential into the hosted API with its Azure fields', async () => {
    const users: (typeof OCTOCAT)[] = [];
    const { hosted, calls } = stage(
      (args) => accessAnswer(args, users) ?? { combined: 'Saved' },
      [],
      undefined,
      {
        name: 'azure-test',
        material: {
          cloudProvider: CloudType.Azure,
          applicationId: 'app',
          secret: 'shh',
          subscriptionId: 'sub',
          directoryId: 'tenant',
        },
      },
    );
    await hosted.operatorWalk();
    const saved = calls.find((call) => call.args[0] === 'credentials')!.args;
    expect(saved[saved.length - 1]).toBe('azure-test');
    for (const pair of [
      ['--provider', 'azure'],
      ['--application-id', 'app'],
      ['--secret', 'shh'],
      ['--subscription-id', 'sub'],
      ['--directory-id', 'tenant'],
    ])
      expect(saved.join(' ')).toContain(pair.join(' '));
  });

  test('from a release, api use and credentials new run on its CLI, then this CLI upgrades the hosted API and the credential still decrypts', async () => {
    const users: (typeof OCTOCAT)[] = [];
    const released: string[][] = [];
    const run = vi.fn(async (args: readonly string[]) => {
      released.push([...args]);
      return commandResultForTest({});
    });
    const built: ReturnType<typeof stage> = stage(
      (args) =>
        accessAnswer(args, users) ??
        (args[1] === 'status'
          ? { stdout: statusOutput(1) }
          : args[1] === 'list'
            ? args[0] === 'cluster'
              ? { stdout: CLUSTER_LIST_OUTPUT }
              : backupBucketListing(args)
            : args[1] === 'upgrade'
              ? (built.bumpBackups(), { combined: startedOutput(1) })
              : {}),
      [],
      undefined,
      undefined,
      { fromRelease: { cli: { run } } },
    );
    await expect(built.hosted.operatorWalk()).resolves.toMatchObject({
      image: B,
      upgrade: 1,
    });
    expect(released.map((args) => args.slice(0, 2))).toEqual([
      ['api', 'use'],
      ['credentials', 'new'],
    ]);
    expect(built.calls.map((call) => call.args.slice(0, 3))).toEqual([
      ['api', 'upgrade'],
      ['api', 'status', '--json'],
      ['cluster', 'list'],
      // Three minutes of reads from the running status, then settled.
      ...Array.from({ length: 18 }, () => ['api', 'access', 'list']),
      ['api', 'status', '--json'],
      ['bucket', 'list', '--credentials'],
      ['bucket', 'list', '--credentials'],
      ['api', 'access', 'add'],
      ['api', 'access', 'list'],
      ['api', 'access', 'add'],
      ['api', 'access', 'remove'],
      ['api', 'access', 'list'],
    ]);
  });

  /** A from_release upgrade whose `api status` and `api access list` answer as given. */
  const fromRelease = (
    status: () => string,
    access: (args: readonly string[]) => object | undefined = () => undefined,
  ) => {
    const users: (typeof OCTOCAT)[] = [];
    const built: ReturnType<typeof stage> = stage(
      (args) =>
        access(args) ??
        accessAnswer(args, users) ??
        (args[1] === 'status'
          ? { stdout: status() }
          : args[1] === 'list'
            ? args[0] === 'cluster'
              ? { stdout: CLUSTER_LIST_OUTPUT }
              : backupBucketListing(args)
            : args[1] === 'upgrade'
              ? (built.bumpBackups(), { combined: startedOutput(1) })
              : {}),
      [],
      undefined,
      undefined,
      {
        fromRelease: {
          cli: { run: vi.fn(async () => commandResultForTest({})) },
        },
      },
    );
    return built;
  };

  test('from a release, the chart repair may roll the upgraded API once after it runs', async () => {
    // Running at 2, then settled at 3 after the repair's Helm run: run
    // 37725984914 failed on exactly this.
    const generations = [2, 3];
    const built = fromRelease(() =>
      statusOutput(1, undefined, null, generations.shift()),
    );
    await expect(built.hosted.release()).resolves.toMatchObject({
      upgrade: 1,
    });
    expect(generations).toEqual([]);
    expect(built.slept.filter((ms) => ms === 10_000)).toHaveLength(18);
  });

  test('from a release, the stage fails when the upgraded API rolls more than once, to another release, or a read fails', async () => {
    const generations = [2, 4];
    await expect(
      fromRelease(() =>
        statusOutput(1, undefined, null, generations.shift()),
      ).hosted.release(),
    ).rejects.toThrow(
      'the hosted API rolled again after the upgrade: generation 2 → 4',
    );
    const images = [B, `${B}0`];
    await expect(
      fromRelease(() =>
        statusOutput(1, undefined, null, 3).replace(B, images.shift()!),
      ).hosted.release(),
    ).rejects.toThrow('the hosted API rolled to another release');
    await expect(
      fromRelease(
        () => statusOutput(1),
        (args) =>
          args[2] === 'list'
            ? {
                exitCode: 1,
                combined: 'API still unavailable after 26 retries.',
              }
            : undefined,
      ).hosted.release(),
    ).rejects.toThrow('api-access-list');
  });

  test.each([
    [
      'an API older than Upgrade N starts it',
      '0.1.65',
      { image: B, upgrade: 1 },
    ],
    ['an API already on this version is not upgraded', '0.0.3', undefined],
    ['a 0.1.66 API must print the started verdict', '0.1.66', undefined],
  ])(
    'from a release, an accepted verdict: %s',
    async (_name, servedBefore, record) => {
      const built: ReturnType<typeof stage> = stage(
        (args) =>
          accessAnswer(args, []) ??
          (args[1] === 'status'
            ? { stdout: statusOutput(1) }
            : args[1] === 'list'
              ? args[0] === 'cluster'
                ? { stdout: CLUSTER_LIST_OUTPUT }
                : backupBucketListing(args)
              : args[1] === 'upgrade'
                ? (built.bumpBackups(),
                  {
                    combined: acceptedOutput('ghcr.io/anycloud-sh/api:0.0.3'),
                  })
                : {}),
        // Before the request, then once more while the old API still serves.
        [servedBefore, servedBefore].map((version) => ({
          status: 200,
          body: { version, schemaVersion: version },
        })),
        undefined,
        undefined,
        {
          fromRelease: {
            cli: { run: vi.fn(async () => commandResultForTest({})) },
          },
        },
      );
      const release = built.hosted.release();
      await (record
        ? expect(release).resolves.toMatchObject(record)
        : expect(release).rejects.toThrow(
            'api upgrade did not report a started hosted upgrade',
          ));
    },
  );

  test('the access walk fails on a wrong GitHub ID or an accepted organization', async () => {
    const walk = (answer: (args: readonly string[]) => object | undefined) => {
      const users: (typeof OCTOCAT)[] = [];
      return stage(
        (args) => answer(args) ?? accessAnswer(args, users) ?? {},
      ).hosted.operatorWalk();
    };
    await expect(
      walk((args) =>
        args[2] === 'list'
          ? {
              stdout: JSON.stringify({
                owner: OCTOCAT,
                users: [{ kind: 'github', ...OCTOCAT, userId: '9' }],
              }),
            }
          : undefined,
      ),
    ).rejects.toThrow('expected GitHub ID 583231');
    await expect(
      walk((args) =>
        args[3] === 'anycloud-sh' ? { combined: 'shared' } : undefined,
      ),
    ).rejects.toThrow('Command unexpectedly succeeded');
  });

  test("after a release the pool Service must still run under its id, the saved credential must still decrypt, and the API's backup bucket stays refused", async () => {
    const refusal =
      'Bucket "cluster-1" is this API\'s own backup bucket and cannot be used through the bucket API.';
    let buckets: object[] = [{ name: 'cluster-1' }, { name: 'other' }];
    let refused = true;
    let service = WorkloadState.Running;
    const answer = (args: readonly string[]) => {
      if (args[0] === 'status')
        return { stdout: statusJson(ID.service, service) };
      if (args.includes('cluster-1'))
        return refused
          ? { exitCode: 1, combined: `✗ List failed: ${refusal}` }
          : {
              stdout: JSON.stringify({
                entries: [{ key: 'anycloud-api/database.sqlite' }],
                truncated: false,
                nextCursor: null,
              }),
            };
      return {
        stdout: JSON.stringify({
          entries: buckets,
          truncated: false,
          nextCursor: null,
        }),
      };
    };
    const { hosted, calls } = stage(answer);
    await hosted.stateSurvives(ID.service);
    const list = [
      'bucket',
      'list',
      '--credentials',
      'aws-test',
      '--region',
      'us-east-2',
      '--all',
      '--json',
    ];
    expect(calls).toEqual([
      { args: ['status', '--json', ID.service], apiUrl: HOSTED_URL },
      // Listing buckets resolves the credential inside the API, so it decrypts.
      { args: list, apiUrl: HOSTED_URL },
      { args: [...list, 'cluster-1', 'anycloud-api/'], apiUrl: HOSTED_URL },
    ]);
    buckets = [{ name: 'other' }];
    await expect(hosted.stateSurvives(ID.service)).rejects.toThrow(
      'does not list the API backup bucket cluster-1',
    );
    buckets = [{ name: 'cluster-1' }];
    refused = false;
    await expect(hosted.stateSurvives(ID.service)).rejects.toThrow(
      'Command unexpectedly succeeded',
    );
    refused = true;
    service = WorkloadState.Failed;
    await expect(hosted.stateSurvives(ID.service)).rejects.toThrow(
      `Service ${ID.service} ended failed`,
    );
    // A brief reconcile after the API restart is waited out.
    const reads = [WorkloadState.Queued, WorkloadState.Running];
    service = WorkloadState.Running;
    const reconciling = stage(
      (args) =>
        args[0] === 'status'
          ? { stdout: statusJson(ID.service, reads.shift()!) }
          : answer(args),
      [],
      pollsWaiter(3),
    );
    await reconciling.hosted.stateSurvives(ID.service);
    expect(reads).toEqual([]);
  });

  test('the matchers follow the format strings in src/cli/commands/api.ts', () => {
    for (const [name, format] of Object.entries(API_UPGRADE_FORMATS)) {
      expect(API_COMMAND_SOURCE, name).toContain(format);
    }
    expect(HOSTED_VERDICT.started.exec(startedOutput(1))?.groups).toEqual({
      number: '1',
      version: '0.0.3',
    });
    expect(HOSTED_VERDICT.unchanged.exec(unchangedOutput(A))?.groups).toEqual({
      image: A,
    });
    expect(HOSTED_VERDICT.accepted.exec(acceptedOutput(A))?.groups).toEqual({
      image: A,
    });
    expect(
      HOSTED_VERDICT.refused.exec(refusedOutput())?.groups?.reason,
    ).toMatch(/SYSTEM_RELEASE_REFUSED/u);
    expect(HOSTED_VERDICT.localApi.test(startedOutput(1))).toBe(false);
    expect(HOSTED_VERDICT.localApi.test(printed(localApiLine))).toBe(true);
    // A stopped local API's start reads `Starting local API server ...`.
    expect(
      HOSTED_VERDICT.localApi.test(
        'Starting local API server to match installed anycloud 0.0.3',
      ),
    ).toBe(true);
    expect(HOSTED_VERDICT.kubernetes.test(startedOutput(1))).toBe(true);
    expect(API_COMMAND_SOURCE).toContain('`K3s step: ${kubernetesStepSummary');
  });

  test('an upgrade is read from the plain started verdict, confirmed by api status, a new backup version and a running cluster list row; the no-ops need their verdict line and an unchanged status', async () => {
    let updates = 0;
    const { hosted } = releaseStage((args, bumpBackups) => {
      if (args.includes(REFUSED_RELEASE_IMAGE)) {
        return { exitCode: 1, combined: refusedOutput() };
      }
      updates += 1;
      if (updates > 1) return { combined: unchangedOutput(A) };
      bumpBackups();
      return { combined: startedOutput(1) };
    });
    await expect(hosted.release(B)).resolves.toMatchObject({
      upgrade: 1,
      backupVersionsBefore: 3,
      backupVersionsAfter: 4,
      servedAfter: { version: '0.0.3', schemaVersion: '0.0.3' },
    });
    await hosted.releaseUnchanged(A);
    await hosted.releaseRefused();
    // A refusal is never retried as transient.
    expect(updates).toBe(2);
  });

  test('an upgrade waits until the ready check Job succeeds', async () => {
    // Applied is recorded right after the HelmChart patch, before the Helm
    // controller updates the native Kubernetes Deployment; the API reports
    // the upgrade `starting` until the ready check Job succeeds.
    let statusReads = 0;
    const { hosted } = releaseStage(
      (_args, bumpBackups) => {
        bumpBackups();
        return { combined: startedOutput(2) };
      },
      {
        status: () =>
          statusOutput(
            2,
            ++statusReads < 3 ? WorkloadState.Starting : WorkloadState.Running,
          ),
        polls: 4,
      },
    );
    await expect(hosted.release(A)).resolves.toMatchObject({ upgrade: 2 });
    expect(statusReads).toBe(3);
  });

  test.each([
    [
      statusOutput(2, WorkloadState.Starting),
      'timed out: status does not yet show Upgrade 2 running: starting',
    ],
    [
      statusOutput(
        2,
        WorkloadState.Starting,
        'could not read the ready check, so this upgrade is not confirmed running',
      ),
      'Upgrade 2 running: starting: could not read the ready check',
    ],
    // Upgrade 1 running is not the upgrade this request started.
    [statusOutput(1), 'Upgrade 2 running: no such upgrade'],
    // A failed ready check fails at once rather than waiting out the budget.
    [
      statusOutput(
        2,
        WorkloadState.Failed,
        'the ready check failed: BackoffLimitExceeded',
      ),
      'the upgrade failed: the ready check failed: BackoffLimitExceeded',
    ],
  ])('an upgrade reported %s is not accepted', async (status, error) => {
    const { hosted } = releaseStage(() => ({ combined: startedOutput(2) }), {
      status: () => status,
      polls: 3,
    });
    await expect(hosted.release(B)).rejects.toThrow(error);
  });

  test('an upgrade whose cluster list row is not running on the new version is not accepted', async () => {
    const built: ReturnType<typeof stage> = stage((args) => {
      if (args[1] === 'status') return { stdout: statusOutput(1) };
      if (args[1] === 'list') {
        return { stdout: CLUSTER_LIST_OUTPUT.replace('running', 'failed') };
      }
      built.bumpBackups();
      return { combined: startedOutput(1) };
    });
    await expect(built.hosted.release(B)).rejects.toThrow(
      'cluster list does not show e2e-clust-1 running on 0.0.3',
    );
  });

  test('a hosted api upgrade is a failure when it touches the local API, or without its verdict line or the policy refusal', async () => {
    const answering = (combined: string, exitCode = 0) =>
      releaseStage(() => ({ exitCode, combined })).hosted;
    await expect(
      answering(printed(localApiLine) + startedOutput(1)).release(B),
    ).rejects.toThrow('api upgrade of a hosted API reconciled the local API');
    await expect(
      answering(startedOutput(1).replace(/^.*K3s step.*$/mu, '')).release(B),
    ).rejects.toThrow('did not report a finished K3s step');
    const spinnerOnly = answering(printed(() => printInfo('Requesting...')));
    await expect(spinnerOnly.release(B)).rejects.toThrow(
      'did not report a started hosted upgrade',
    );
    await expect(spinnerOnly.releaseUnchanged(A)).rejects.toThrow(
      `did not report ${A} unchanged`,
    );
    await expect(
      answering(unchangedOutput(B)).releaseUnchanged(A),
    ).rejects.toThrow(`did not report ${A} unchanged`);
    await expect(
      answering(
        printed(() => {
          printError('Failed to reach the API');
        }),
        1,
      ).releaseRefused(),
    ).rejects.toThrow('failed without the refusal verdict');
    await expect(
      answering(
        refusedOutput().replace(
          'image must be a digest-pinned reference from the official repository',
          'HTTP 500 internal error',
        ),
        1,
      ).releaseRefused(),
    ).rejects.toThrow('official image-policy refusal');
  });

  test('a no-op upgrade that still moved the latest upgrade or backed up is a failure', async () => {
    let statusReads = 0;
    const { hosted } = releaseStage(
      () => ({ exitCode: 1, combined: refusedOutput() }),
      {
        status: () => {
          statusReads += 1;
          return statusOutput(statusReads);
        },
      },
    );
    await expect(hosted.releaseRefused()).rejects.toThrow(
      `started an upgrade: latest moved from Upgrade 1 (${B}) to Upgrade 2 (${B})`,
    );
    const backedUp = releaseStage((_args, bumpBackups) => {
      bumpBackups();
      return { combined: unchangedOutput(B) };
    });
    await expect(backedUp.hosted.releaseUnchanged(B)).rejects.toThrow(
      'still backed the database up',
    );
  });

  test('a fetch failed still fails the step with its own error, and its probes are recorded before the diagnostics', async () => {
    const { hosted, probes } = stage(() => ({
      exitCode: 1,
      combined: '✗ fetch failed',
    }));
    await expect(hosted.runService()).rejects.toThrow('fetch failed');
    await hosted.captureDiagnostics();
    expect(probes).toEqual(
      [
        'getent',
        'doh',
        'edge',
        'dig-vpc-A',
        'dig-public-A',
        'dig-vpc-AAAA',
        'dig-public-AAAA',
      ].map((probe) => `hosted-fetch-failed-1-${probe}`),
    );
  });

  test("the request loop keeps each failure's kind and, at the first, the runner's resolver against the authoritative answer (run 41028695286)", async () => {
    const nxdomain = () =>
      Promise.reject(
        new TypeError('fetch failed', {
          cause: Object.assign(
            new Error('getaddrinfo ENOTFOUND svc-1.anycloud.sh'),
            { code: 'ENOTFOUND' },
          ),
        }),
      );
    const answers: (() => Promise<Response>)[] = [
      async () => new Response('ok'),
      nxdomain,
      async () =>
        new Response('blocked', {
          status: 403,
          headers: { server: 'cloudflare', 'cf-ray': '8f00-ORD' },
        }),
      nxdomain,
    ];
    let drained!: () => void;
    const done = new Promise<void>((resolve) => (drained = resolve));
    const lookups: string[] = [];
    const stop = watchRequests(new URL('https://svc-1.anycloud.sh/'), {
      fetch: async () => {
        const answer = answers.shift();
        if (answers.length === 0) drained();
        return (answer ?? (async () => new Response('ok')))();
      },
      lookup: async (hostname) => {
        lookups.push(hostname);
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
          code: 'ENOTFOUND',
        });
      },
      dns: { observe: async (hostname) => dnsAnswers(hostname) },
    });
    await done;
    const record = await stop();
    expect(record).toMatchObject({
      failed: 3,
      failures: {
        ENOTFOUND: {
          count: 2,
          detail: 'fetch failed (ENOTFOUND)',
        },
        'HTTP 403 cloudflare': { count: 1, detail: 'cf-ray 8f00-ORD' },
      },
      dns: {
        resolver: 'getaddrinfo ENOTFOUND svc-1.anycloud.sh (ENOTFOUND)',
        authoritative: [
          'ns1.cloudflare.com: A 104.16.0.1',
          'ns2.cloudflare.com: A 104.16.0.1',
        ],
      },
    });
    expect(
      record.failures.ENOTFOUND.lastAt > record.failures.ENOTFOUND.firstAt,
    ).toBe(true);
    // One probe for the outage, not one per failure.
    expect(lookups).toEqual(['svc-1.anycloud.sh']);
  });

  test('before the upgrade, diagnostics read the released API with the released CLI (run 40815323572)', async () => {
    const released = vi.fn(async () =>
      commandResultForTest({ combined: 'diagnostic output' }),
    );
    const { hosted, calls } = stage(() => ({}), [], undefined, undefined, {
      fromRelease: { cli: { run: released } },
    });
    await hosted.captureDiagnostics();
    expect(released).toHaveBeenCalledWith(
      ['api', 'status', '--json'],
      expect.anything(),
    );
    expect(calls).toEqual([]);
  });

  describe("a bucket call outlasts the CLI's own give-up after about 182 s (run 40934357557)", () => {
    const cliTimeout = (verb: string) => ({
      exitCode: 1,
      combined: `✗ ${verb} failed: The operation was aborted due to timeout`,
    });
    const rerunNow = new Waiter(new AbortController().signal, async () => {});
    const verbs = (calls: { args: string[] }[]) =>
      calls.filter((c) => c.args[0] === 'bucket').map((c) => c.args[1]);
    const seed = (hosted: HostedApiStage) =>
      hosted.seedBucket('e2e-bucket', ['out/ref.txt'], {
        credentials: 'aws-test',
        region: 'us-east-2',
      });

    test('a create the API finished during a timed-out run succeeds when rerun, as does a delete', async () => {
      // The API's create and delete are idempotent: the rerun finds the bucket made, then gone.
      const answers: Record<string, object[]> = {
        create: [cliTimeout('Create'), cliTimeout('Create')],
        delete: [cliTimeout('Delete')],
      };
      const { hosted, cleanup, calls } = stage(
        (args) => (args[0] === 'bucket' && answers[args[1]!]?.shift()) || {},
        [],
        rerunNow,
      );
      await seed(hosted);
      await cleanup.run();
      expect(verbs(calls)).toEqual([
        'create',
        'create',
        'create',
        'upload',
        'rm',
        'delete',
        'delete',
      ]);
      expect(cleanup.observations()).toEqual([
        { label: 'token bucket e2e-bucket', completed: true },
      ]);
    });

    test('a list the harness timed out, the API answered throttled, or the network dropped is rerun', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      onTestFinished(() => warn.mockRestore());
      const throttled = await throughBucketStorage(
        makeMockCloudStorage({
          type: CloudType.Azure,
          classifyStorageFailure: async () => ({
            kind: 'throttled',
            code: 'HTTP 429',
          }),
        }),
        { credentialName: 'e2e', action: 'list buckets' },
        undefined,
        async () => Promise.reject(new Error('429')),
      ).catch((error: unknown) => error as Error);
      expect(throttled).toBeInstanceOf(BucketThrottledError);
      const answers: object[] = [
        { exitCode: null, timedOut: true },
        { exitCode: 1, combined: `✗ List failed: ${throttled.message}` },
        { exitCode: 1, combined: '✗ List failed: fetch failed' },
      ];
      const { hosted, calls } = stage(
        (args) =>
          args[0] === 'status'
            ? { stdout: statusJson(ID.service, WorkloadState.Running) }
            : args.includes('cluster-1')
              ? backupBucketListing(args)
              : (answers.shift() ?? backupBucketListing(args)),
        [],
        rerunNow,
      );
      await hosted.stateSurvives(ID.service);
      expect(answers).toEqual([]);
      expect(verbs(calls)).toEqual(['list', 'list', 'list', 'list', 'list']);
    });

    test('any other failure fails at once', async () => {
      const { hosted, calls } = stage(
        (args) =>
          args[1] === 'create'
            ? {
                exitCode: 1,
                combined:
                  '✗ Create failed: The cloud provider denied this credential the bucket action',
              }
            : {},
        [],
        rerunNow,
      );
      await expect(seed(hosted)).rejects.toThrow('denied this credential');
      expect(verbs(calls)).toEqual(['create']);
    });

    test('reruns within the 900 s bound and then fails with the last run', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const bounds: number[] = [];
      const run = vi.fn<HostedStageOptions['cli']['run']>(
        async (_args, options) => {
          bounds.push(options!.timeoutMs!);
          vi.setSystemTime(Date.now() + 182_000);
          return commandResultForTest(cliTimeout('Create'));
        },
      );
      const { hosted } = stage(
        () => ({}),
        [],
        new Waiter(new AbortController().signal, async (ms) => {
          vi.setSystemTime(Date.now() + ms);
        }),
        undefined,
        { cli: { run } },
      );
      try {
        await expect(seed(hosted)).rejects.toThrow('aborted due to timeout');
      } finally {
        vi.useRealTimers();
      }
      // Each run gets the time left; a 10 s pause separates them.
      expect(bounds).toEqual([900_000, 708_000, 516_000, 324_000, 132_000]);
    });
  });

  /** A VM Service the hosted API runs until terminated, then cleans up. */
  const serviceAnswer =
    (state: { terminated: boolean }) => (args: readonly string[]) => {
      if (args[0] === 'terminate') {
        state.terminated = true;
        return { combined: 'Termination scheduled' };
      }
      if (args[0] === 'status')
        return {
          stdout: state.terminated
            ? statusJson(ID.service, WorkloadState.Terminated, 3)
            : statusJson(ID.service, WorkloadState.Running),
        };
      return { combined: `ID: ${ID.service}` };
    };

  test('after the journey tore its objects down, the deferred cleanups are complete and never call the (gone) hosted API', async () => {
    let torn = false;
    const answer = serviceAnswer({ terminated: false });
    const { hosted, cleanup, calls } = stage((args) =>
      // Run 17: the cluster is destroyed by then; the hosted API is gone.
      torn ? { exitCode: 1, combined: '✗ fetch failed' } : answer(args),
    );
    await hosted.terminate(await hosted.runService(), 'Service');
    expect(cleanup.observations()).toEqual([
      { label: `hosted Service ${ID.service}`, completed: true },
    ]);
    torn = true;
    const before = calls.length;
    await cleanup.run();
    expect(calls.length).toBe(before);
  });

  test('every hosted-API cleanup still owed runs before the cluster is deleted, so none reaches the gone API (run 40934349682)', async () => {
    let torn = false;
    const answer = serviceAnswer({ terminated: false });
    const { hosted, cleanup, calls } = stage((args) =>
      torn ? { exitCode: 1, combined: 'HTTP 530' } : answer(args),
    );
    // Torn down by the journey, then a bucket the journey leaves.
    await hosted.terminate(await hosted.runService(), 'Service');
    await hosted.seedBucket('e2e-bucket', ['out/ref.txt'], {
      credentials: 'aws-test',
      region: 'us-east-2',
    });
    const before = calls.length;
    await hosted.settleCleanups();
    expect(calls.slice(before).map(({ args }) => args.slice(0, 2))).toEqual([
      ['bucket', 'rm'],
      ['bucket', 'delete'],
    ]);
    expect(cleanup.observations()).toEqual([
      { label: `hosted Service ${ID.service}`, completed: true },
      { label: 'token bucket e2e-bucket', completed: true },
    ]);
    torn = true;
    await cleanup.run();
    expect(calls).toHaveLength(before + 2);
  });

  test.each([
    [
      'rolls before it runs',
      [2, 2],
      'did not roll the hosted API exactly once before it ran: generation 2 → 2',
    ],
    ['rolls twice before it runs', [1, 3], 'generation 1 → 3'],
    [
      'rolls again after it runs',
      [1, 2, 3],
      'generation 2 → 3, though the upgrade set its chart',
    ],
  ])(
    'an upgrade between images naming their charts fails when the API %s',
    async (_name, generations, failure) => {
      const { hosted } = releaseStage(
        (args, bumpBackups) => {
          if (args[1] === 'upgrade') {
            bumpBackups();
            return { combined: startedOutput(1) };
          }
          return accessAnswer(args, []) ?? {};
        },
        {
          status: () =>
            statusOutput(
              1,
              undefined,
              null,
              generations.length > 1 ? generations.shift() : generations[0],
            ),
        },
      );
      await expect(hosted.release(B, true)).rejects.toThrow(failure);
    },
  );

  test('sends a hosted call once, leaving restarts to the CLI, and waits for the served version to settle after a release', async () => {
    let updates = 0;
    const { hosted, slept, calls } = releaseStage(
      (args, bumpBackups) => {
        if (args[0] === 'terminate') {
          return { exitCode: 1, combined: 'HTTP 503 temporarily unavailable' };
        }
        updates += 1;
        bumpBackups();
        return { combined: startedOutput(2) };
      },
      {
        status: () => statusOutput(2),
        versions: [
          { status: 503 },
          { status: 200, body: { version: '0.0.3', schemaVersion: '0.0.3' } },
          { status: 200, body: { version: '0.0.3', schemaVersion: '0.0.3' } },
        ],
      },
    );
    await expect(hosted.terminate(ID.service, 'Service')).rejects.toThrow(
      'HTTP 503',
    );
    expect(calls).toHaveLength(1);
    const release = await hosted.release(B);
    expect(release.servedAfter).toEqual({
      version: '0.0.3',
      schemaVersion: '0.0.3',
    });
    expect(release.health).toMatchObject({ failed: 0 });
    expect(release.health.requests).toBeGreaterThan(0);
    // 503, then two consecutive good answers five seconds apart.
    expect(slept.filter((ms) => ms === 5_000)).toHaveLength(2);
    expect(updates).toBe(1);
  });

  test('the recursive parent runs the CLI from the API image to submit the child through the same API; both must complete and tear down child → parent', async () => {
    const workloads = new Map<string, string>();
    const order: string[] = [];
    const { hosted, calls, cleanup } = stage((args) => {
      if (args[0] === 'job') {
        const id = args[args.indexOf('--id') + 1];
        // The parent's container would submit the child; the fake stands in
        // for both VMs and lets them complete at once.
        workloads.set(ID.child, statusJson(ID.child, WorkloadState.Completed));
        workloads.set(id, statusJson(id, WorkloadState.Completed));
        return { combined: `   ID: ${id}` };
      }
      if (args[0] === 'terminate') {
        order.push(args[1]);
        workloads.set(
          args[1],
          statusJson(args[1], WorkloadState.Terminated, 1),
        );
        return { combined: 'Termination scheduled' };
      }
      if (args[0] === 'status') {
        const stdout = workloads.get(args[args.length - 1]);
        return stdout
          ? { stdout }
          : { exitCode: 1, combined: 'Workload not found' };
      }
      return {};
    });
    const SECRET = NAMES.secret('recursion');
    await expect(hosted.recursion(A)).resolves.toEqual({
      parentId: ID.parent,
      childId: ID.child,
    });
    expect(order).toEqual([ID.child, ID.parent]);
    const parent = calls.find((call) => call.args[0] === 'job')!;
    expect(parent.apiUrl).toBe(HOSTED_URL);
    expect(parent.args).toEqual(
      expect.arrayContaining([
        '--id',
        ID.parent,
        '--credentials',
        'aws-test',
        '--env',
        `API_URL=${HOSTED_URL}`,
        A,
        '--',
        'sh',
        '-c',
      ]),
    );
    // The token reaches the parent only through a Secret, never as workload
    // env returned by `status`.
    expect(calls[0].args).toEqual([
      'secrets',
      'new',
      SECRET,
      'GITHUB_TOKEN=harness-token',
    ]);
    expect(parent.args).toEqual(expect.arrayContaining(['--secret', SECRET]));
    expect(parent.args.join(' ')).not.toContain('GITHUB_TOKEN');
    const script = parent.args.at(-1)!;
    // The child is submitted and polled by the CLI inside the parent's container.
    expect(script).toContain(
      `node /app/dist/cli/index.js 'job' '--credentials' 'aws-test' '--region' 'us-east-2' '--vm-type' 't3.small' '--id' '${ID.child}' 'mirror.gcr.io/library/alpine:3.20' '--' 'sh' '-c' 'echo child-done'`,
    );
    expect(script).toContain(
      `node /app/dist/cli/index.js 'status' '--json' '${ID.child}'`,
    );
    expect(script).toContain('completed) exit 0');
    expect(script).toContain('|| state=unreachable');
    // Both Jobs were torn down by the journey: the stack has nothing left for them.
    expect(calls.at(-1)!.args).toEqual(['secrets', 'delete', SECRET]);
    expect(cleanup.observations()).toEqual([
      { label: `hosted Secret ${SECRET}`, completed: true },
      { label: `hosted Job ${ID.child}`, completed: true },
      { label: `hosted Job ${ID.parent}`, completed: true },
    ]);
  });

  test('a parent that ends errored or a child that did not complete fails the recursion step', async () => {
    const errored = stage((args) =>
      args[0] === 'status'
        ? { stdout: statusJson(args[2], WorkloadState.Errored) }
        : { combined: 'ID: x' },
    );
    await expect(errored.hosted.recursion(A)).rejects.toThrow(
      'parent ended errored',
    );
    const childGone = stage((args) =>
      args[0] === 'status'
        ? args[2] === ID.parent
          ? { stdout: statusJson(args[2], WorkloadState.Completed) }
          : { exitCode: 1, combined: 'Workload not found' }
        : { combined: 'ID: x' },
    );
    await expect(childGone.hosted.recursion(A)).rejects.toThrow(
      `the child Job ${ID.child} is absent, not completed`,
    );
  });
  test.each([
    '404 page not found',
    'Credential "aws-test" not found',
    'HTTP 403 forbidden',
  ])('cleanup fails closed on %s', async (combined) => {
    const { hosted } = stage(() => ({ exitCode: 1, combined }));
    await expect(hosted.terminate('service-1', 'Service')).rejects.toThrow(
      combined,
    );
  });

  test('permanent status failures abort with their original reason', async () => {
    const { hosted, calls } = stage((args) =>
      args[0] === 'status'
        ? { exitCode: 1, combined: 'HTTP 403 forbidden' }
        : { combined: `ID: ${ID.service}` },
    );
    await expect(hosted.runService()).rejects.toThrow('HTTP 403 forbidden');
    expect(calls.filter((call) => call.args[0] === 'status')).toHaveLength(1);
  });

  test('failure diagnostics read every workload from the hosted target independently', async () => {
    const fixture = stage((args) => {
      if (args[0] === 'job') {
        return { exitCode: 1, combined: 'HTTP 500 admission failed' };
      }
      if (args[0] === 'status') throw new Error('status unavailable');
      return { combined: 'diagnostic output' };
    });
    await expect(fixture.hosted.recursion(A)).rejects.toThrow(
      'HTTP 500 admission failed',
    );
    await fixture.hosted.captureDiagnostics();
    for (const id of [ID.parent, ID.child]) {
      expect(fixture.calls).toContainEqual({
        args: ['status', '--json', id],
        apiUrl: HOSTED_URL,
      });
      expect(fixture.calls).toContainEqual({
        args: ['logs', id],
        apiUrl: HOSTED_URL,
      });
    }
    expect(fixture.artifacts.json).toHaveBeenCalledWith(
      'hosted-stage-diagnostics',
      expect.objectContaining({
        workloads: expect.arrayContaining([
          expect.objectContaining({ id: ID.child }),
        ]),
      }),
    );
    fixture.artifacts.json.mockRejectedValueOnce(
      new Error('artifact unavailable'),
    );
    await expect(fixture.hosted.captureDiagnostics()).resolves.toBeUndefined();
  });
  test('resolves the journey from the flags', () => {
    // Without the hosted stage: the default journey, through the hosted API too.
    expect(
      assertHostedStageConfiguration({
        hostedStage: false,
        alternateImage: undefined,
      }),
    ).toEqual({ operator: true });
    expect(
      assertHostedStageConfiguration({ hostedStage: true, alternateImage: B }),
    ).toEqual({ alternateImage: B });
    expect(() =>
      assertHostedStageConfiguration({
        hostedStage: true,
        alternateImage: undefined,
      }),
    ).toThrow('needs E2E_CLUSTER_ALTERNATE_IMAGE');
  });

  test('saves a GCP or Lambda credential into the hosted API', () => {
    expect(
      credentialsNewArgs('pool-gcp', {
        cloudProvider: CloudType.GCP,
        projectId: 'p-1',
        clientEmail: 'sa@p-1.iam.gserviceaccount.com',
        privateKey: 'KEY',
      }),
    ).toEqual([
      'credentials',
      'new',
      '--provider',
      'gcp',
      '--project-id',
      'p-1',
      '--client-email',
      'sa@p-1.iam.gserviceaccount.com',
      '--private-key',
      'KEY',
      'pool-gcp',
    ]);
    expect(
      credentialsNewArgs('pool-lambda', {
        cloudProvider: CloudType.Lambda,
        apiKey: 'LKEY',
      }),
    ).toEqual([
      'credentials',
      'new',
      '--provider',
      'lambda',
      '--api-key',
      'LKEY',
      'pool-lambda',
    ]);
  });

  test('failure cleanup stops the parent before checking the child it can still submit', async () => {
    let childExists = false;
    let parentStopped = false;
    const terminated: string[] = [];
    const { hosted, cleanup } = stage((args) => {
      if (args[0] === 'job')
        return { exitCode: 1, combined: 'HTTP 500 lost response' };
      const id = args.at(-1)!;
      if (args[0] === 'terminate') {
        terminated.push(id);
        if (id === ID.parent) {
          // Parent submits the child before its VM actually finishes stopping.
          childExists = true;
          parentStopped = true;
        } else if (childExists) childExists = false;
        else return { combined: 'Workload not found' };
        return { combined: 'Termination scheduled' };
      }
      if (args[0] === 'status')
        return {
          stdout: statusJson(
            id,
            WorkloadState.Terminated,
            parentStopped ? 1 : null,
          ),
        };
      return {};
    });
    await expect(hosted.recursion(A)).rejects.toThrow('HTTP 500 lost response');
    await cleanup.run();
    expect(terminated).toEqual([ID.parent, ID.child]);
    expect(childExists).toBe(false);
  });

  test.each([
    ['Service create', (h: HostedApiStage) => h.runService()],
    ['release request', (h: HostedApiStage) => h.release(B)],
    ['recursive parent create', (h: HostedApiStage) => h.recursion(A)],
  ])(
    'a %s that fails transiently is sent once: a lost response may already be admitted',
    async (_name, step) => {
      const { hosted, slept, calls } = stage((args) =>
        args[0] === 'status' || args.includes('--status')
          ? { exitCode: 1, combined: 'Workload not found' }
          : { exitCode: 1, combined: 'HTTP 503 temporarily unavailable' },
      );
      await expect(step(hosted)).rejects.toThrow('HTTP 503');
      expect(slept).toEqual([]);
      expect(calls).toHaveLength(1);
    },
  );

  test('diagnostic edge errors are captured once without delaying cleanup for retries', async () => {
    const { hosted, slept, calls } = stage(() => ({
      exitCode: 1,
      combined: 'HTTP 503 temporarily unavailable',
    }));
    await hosted.captureDiagnostics();
    expect(calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });
});
