import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

import { describe, expect, onTestFinished, test, vi } from 'vitest';

import { hostedApiIdentity } from '../../src/shared/hosted-api-identity.js';
import { CloudType } from '../../src/shared/cloud.js';
import { generateClusterId } from '../../src/shared/id-generator.js';
import { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import { CliDatabase } from '../integration/e2e/internal/database.js';
import {
  CloudClusterEnvironment,
  type CloudClusterEnvironmentOptions,
} from '../integration/e2e/internal/substrates/cloud-cluster/environment.js';
import { AzurePoolInventory } from '../integration/e2e/internal/substrates/cloud-cluster/azure-pool.js';
import { resolveDnsRecord } from '../integration/e2e/internal/substrates/cloud-cluster/dns-records.js';
import {
  E2E_CLUSTER_ID_PREFIX,
  E2E_CLUSTER_NAME_PREFIX,
} from '../integration/e2e/internal/substrates/cloud-cluster/names.js';
import { isRecord } from '../integration/e2e/internal/types.js';
import { Waiter, WaitTimeoutError } from '../integration/e2e/internal/wait.js';
import { commandResultForTest } from './helpers/e2e.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInstallerToken } from '../integration/e2e/internal/context.js';

type CliAnswer = (args: readonly string[]) => unknown;

const awsProfile = {
  slug: 'aws',
  provider: CloudType.AWS,
  credentialName: 'aws-test',
  credential: {
    cloudProvider: CloudType.AWS,
    accessKeyId: 'AKIA-test',
    secretAccessKey: 'secret-test',
  },
  vmTypes: ['t3.small'],
} as const;

const gcpProfile = {
  slug: 'gcp',
  provider: CloudType.GCP,
  credentialName: 'gcp-test',
  credential: {
    cloudProvider: CloudType.GCP,
    projectId: 'proj-test',
    privateKey: 'private-test',
    clientEmail: 'sa@proj-test.iam.gserviceaccount.com',
  },
  vmTypes: ['e2-standard-2'],
} as const;

const azureProfile = {
  slug: 'azure',
  provider: CloudType.Azure,
  credentialName: 'azure-test',
  credential: {
    cloudProvider: CloudType.Azure,
    applicationId: 'app-test',
    secret: 'secret-test',
    directoryId: 'tenant-test',
    subscriptionId: 'sub-test',
  },
  vmTypes: ['Standard_D2s_v5'],
} as const;

/** The kubeconfig the startup script leaves in the checkpoint bucket. */
const ACCESS_KUBECONFIG = `apiVersion: v1
kind: Config
clusters: [{ name: e2e, cluster: { server: 'https://203.0.113.10:6443' } }]
users: [{ name: e2e, user: { token: e2e-token } }]
contexts: [{ name: e2e, context: { cluster: e2e, user: e2e } }]
current-context: e2e
`;

/**
 * The seed's reads through the runner's cloud CLIs (seed.ts): signed in, the
 * installation gone after delete, nothing tagged, and the access kubeconfig
 * in the bucket. Everything else is the test's own answers.
 */
let seedLeft = false;
/** Reads of the stack that still find it deleting, before it is gone. */
let seedDeleting = 0;

async function seedAnswer(
  executable: string,
  args: readonly string[],
): Promise<ReturnType<typeof commandResultForTest> | undefined> {
  const line = [executable, ...args].join(' ');
  if (
    seedDeleting > 0 &&
    line.startsWith('aws cloudformation describe-stacks')
  ) {
    seedDeleting -= 1;
    return commandResultForTest({
      stdout: JSON.stringify({
        Stacks: [{ StackStatus: 'DELETE_IN_PROGRESS' }],
      }),
      executable,
    });
  }
  if (seedLeft && line.startsWith('aws cloudformation describe-stacks'))
    return commandResultForTest({
      stdout: JSON.stringify({
        Stacks: [{ StackStatus: 'ROLLBACK_COMPLETE' }],
      }),
      executable,
    });
  if (seedLeft && line.startsWith('aws resourcegroupstaggingapi'))
    return commandResultForTest({
      stdout: JSON.stringify({
        ResourceTagMappingList: [
          { ResourceARN: 'arn:aws:ec2:us-east-2:1:volume/vol-9' },
        ],
      }),
      executable,
    });
  const ok = (stdout = '') => commandResultForTest({ stdout, executable });
  const missing = (stderr: string) =>
    commandResultForTest({ exitCode: 1, stderr, executable });
  if (
    /^(gcloud auth activate-service-account|az login|az account set)/.test(line)
  )
    return ok();
  if (line.includes('e2e/access-kubeconfig')) {
    const file = args[args.indexOf('--file') + 1];
    if (executable === 'az' && file) {
      writeFileSync(file, ACCESS_KUBECONFIG);
      return ok();
    }
    return ok(ACCESS_KUBECONFIG);
  }
  if (line.startsWith('aws cloudformation describe-stacks'))
    return missing(
      'An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id x does not exist',
    );
  if (line.startsWith('aws resourcegroupstaggingapi'))
    return ok(JSON.stringify({ ResourceTagMappingList: [] }));
  if (
    line.startsWith('aws ec2 describe-instances') &&
    line.includes('Name=tag:Name,Values=anycloud-cluster-')
  )
    return ok('i-mgmt\n');
  if (line.startsWith('aws ec2 stop-instances')) return ok('{}');
  if (line.startsWith('aws ec2 get-console-output')) return ok('boot log\n');
  if (line.startsWith('aws ec2 wait instance-stopped')) return ok();
  if (line.startsWith('aws iam get-role'))
    return missing(
      'An error occurred (NoSuchEntity) when calling the GetRole operation',
    );
  if (line.startsWith('gcloud projects get-iam-policy'))
    return ok(JSON.stringify({ bindings: [] }));
  if (line.startsWith('az group show'))
    return missing(
      "(ResourceGroupNotFound) Resource group 'x' could not be found.",
    );
  if (line.startsWith('az resource list')) return ok('[]');
  if (executable === 'gcloud' && args.includes('list')) return ok('[]');
  return undefined;
}

function environment(
  answers: CliAnswer,
  cliAnswers: CliAnswer = () => ({ rows: [], rowCount: 0, truncated: false }),
  /** DNS Worker answer per `DELETE …?subdomain=`: HTTP status by subdomain (default 404). */
  dnsStatus: (subdomain: string) => number = () => 404,
  /** Where the management VM runs, and its test seams. */
  management: Partial<
    Pick<
      CloudClusterEnvironmentOptions,
      | 'profile'
      | 'region'
      | 'clusterInventory'
      | 'clusterStorage'
      | 'clusterBucketDeleter'
      | 'fromRelease'
      | 'wait'
      | 'http'
    >
  > & {
    /** The runner's IPv4 lookup; answers at once by default. */
    readonly lookup4?: (hostname: string) => Promise<unknown>;
  } = {},
) {
  const { lookup4 = async () => '203.0.113.5', ...seams } = management;
  const dnsDeletes: string[] = [];
  const dnsFetch = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const subdomain =
        new URL(String(url)).searchParams.get('subdomain') ?? '';
      const auth = (init?.headers as Record<string, string>).Authorization;
      dnsDeletes.push(`${init?.method} ${subdomain} ${auth}`);
      const status = dnsStatus(subdomain);
      return new Response(status >= 500 ? 'worker down' : null, { status });
    },
  );
  const runs: string[][] = [];
  const cliRuns: {
    args: string[];
    timeoutMs: number | undefined;
    env?: Readonly<Record<string, string | undefined>>;
  }[] = [];
  const cli = {
    run: vi.fn(
      async (
        args: readonly string[],
        options?: {
          timeoutMs?: number;
          env?: Readonly<Record<string, string | undefined>>;
        },
      ) => {
        cliRuns.push({
          args: [...args],
          timeoutMs: options?.timeoutMs,
          env: options?.env,
        });
        const answer = cliAnswers(args);
        // A whole result: `{ result: <CommandResult> }`.
        if (isRecord(answer) && isRecord(answer.result)) {
          return answer.result as unknown as ReturnType<
            typeof commandResultForTest
          >;
        }
        // A failed command: `{ failed: <combined output> }`.
        if (isRecord(answer) && typeof answer.failed === 'string') {
          return commandResultForTest({
            exitCode: 1,
            combined: answer.failed,
            executable: 'anycloud',
          });
        }
        // `cluster list --json` prints an array; bootstrap polls it.
        const listed =
          args[0] === 'cluster' && args[1] === 'list' && !Array.isArray(answer)
            ? [answer]
            : answer;
        const stdout = JSON.stringify(listed);
        return commandResultForTest({
          stdout,
          combined: stdout,
          executable: 'anycloud',
        });
      },
    ),
  };
  const envs: Record<string, string | undefined>[] = [];
  const seedRuns: string[] = [];
  const runner = {
    run: vi.fn(
      async (
        executable: string,
        args: readonly string[],
        options?: {
          readonly env?: Record<string, string | undefined>;
          readonly timeoutMs?: number;
        },
      ) => {
        const seed = await seedAnswer(executable, args);
        if (seed) {
          seedRuns.push([executable, ...args].join(' '));
          return seed;
        }
        envs.push(options?.env ?? {});
        runs.push([...args]);
        return commandResultForTest({
          stdout: JSON.stringify(answers(args)),
          executable: 'aws',
        });
      },
    ),
  };
  const artifacts = { json: vi.fn(async () => 'artifact.json') };
  const cleanup = new CleanupStack();
  const aws = new CloudClusterEnvironment({
    artifacts,
    cleanup,
    cli,
    database: new CliDatabase(cli),
    http: { get: vi.fn() },
    profile: awsProfile,
    region: 'us-east-2',
    managementVmType: 't3.medium',
    runId: 'abcdef0123',
    runner,
    wait: new Waiter(new AbortController().signal),
    ...seams,
    dns: {
      lookup4,
      token: 'gh-token',
      fetch: dnsFetch as unknown as typeof fetch,
      resolve: async (hostname) => {
        throw Object.assign(new Error(hostname), { code: 'ENOTFOUND' });
      },
      timeoutMs: 0,
      sleep: async () => undefined,
    },
  });
  return {
    aws,
    cleanup,
    runs,
    seedRuns,
    cliRuns,
    envs,
    runner,
    artifacts,
    dnsDeletes,
  };
}

/** Applies a wait's unmet and reject rules up to ten times, without sleeping. */
function pollsOnly(): CloudClusterEnvironmentOptions['wait'] {
  return {
    for: async (label, probe, options) => {
      let unmet: string | undefined;
      for (let poll = 0; poll < 10; poll += 1) {
        const value = await probe(Date.now() + options.timeoutMs);
        const rejection = options.reject?.(value);
        if (rejection) throw new Error(`${label}: ${rejection}`);
        unmet = options.unmet(value);
        if (unmet === undefined) return value;
      }
      throw new WaitTimeoutError(`${label}: timed out: ${unmet ?? ''}`);
    },
  };
}

/** A Waiter on a fake `Date`: each pause moves the clock, and is recorded. */
function onFakeClock(pauses: number[] = []): Waiter {
  return new Waiter(new AbortController().signal, async (ms) => {
    pauses.push(ms);
    vi.setSystemTime(Date.now() + ms);
  });
}

const cluster = (state: string) => ({
  id: 'e2e-clust-1790000000000-e5f6',
  name: 'e2e-cluster-abcdef0123',
  state,
  releasing: false,
  cloudProvider: 'AWS',
  cloudAccount: null,
  region: 'us-east-2',
  zone: null,
  vmType: 't3.medium',
  k3sVersion: 'v1.36.1+k3s1',
  managementVmId: 'i-0123456789abcdef0',
  networkScope: 'anycloud-cluster-e2e-clust-1790000000000-e5f6',
  checkpointBucket: { name: 'e2e-clust-1790000000000-e5f6', managed: true },
  apiVersion: '0.1.65',
  apiImage: 'ghcr.io/anycloud/api@sha256:abc',
  chartVersion: '0.4.0',
  connected: true,
  kubernetesIdentity: 'uid-cluster',
  connectionRevision: 1,
  address: '203.0.113.5',
  managementApiUrl: 'https://e2e-clust-1790000000000-e5f6.anycloud.sh',
  release: {
    apiVersion: '0.1.65',
    apiImage: 'ghcr.io/anycloud/api@sha256:abc',
    chartVersion: '0.4.0',
  },
  lastError: null,
  createdAt: 1,
  updatedAt: 1,
});

/** `api delete --json`: the cluster gone, its bucket kept after a final backup. */
const deleteResult = (deleteBuckets = false) => {
  const gone = cluster('terminated');
  const bucket = gone.checkpointBucket.name;
  return {
    outcome: 'destroyed',
    clusterId: gone.id,
    finalBackup: 'taken',
    deleted: [
      { kind: 'managementVm', id: gone.managementVmId },
      { kind: 'dnsRecord', name: `${gone.id}.anycloud.sh` },
      ...(deleteBuckets
        ? [
            {
              kind: 'cloudResource',
              type: 'bucket',
              id: bucket,
              location: 'us-east-2',
            },
          ]
        : []),
    ],
    remaining: deleteBuckets
      ? []
      : [
          {
            kind: 'checkpointBucket',
            name: bucket,
            managed: true,
            reason: 'kept',
            restoreCommand: `anycloud api create ${gone.name} --cloud aws --region us-east-2 --vm-type t3.medium --checkpoint-bucket ${bucket}`,
            deleteCommand: `anycloud api delete ${gone.id} --delete-buckets`,
          },
        ],
  };
};

describe('AWS cluster substrate', () => {
  test('sweeps by the installation id prefix the product derives from the cluster name', () => {
    // The managed checkpoint bucket and the DNS record are named after the
    // installation id, not the cluster name; the workflow-level sweep pins the
    // same literal because it cannot import the constant.
    const id = generateClusterId(`${E2E_CLUSTER_NAME_PREFIX}-abcdef0123`);
    expect(id.startsWith(`${E2E_CLUSTER_ID_PREFIX}-`)).toBe(true);
    expect(id.startsWith(`${E2E_CLUSTER_NAME_PREFIX}-`)).toBe(false);
    const workflow = readFileSync(
      '.github/workflows/e2e-cluster-cloud.yml',
      'utf8',
    );
    const queries = workflow.match(/starts_with\(Name, '([^']+)'\)/g) ?? [];
    expect(queries.length).toBeGreaterThanOrEqual(2);
    expect(new Set(queries)).toEqual(
      new Set([`starts_with(Name, '${E2E_CLUSTER_ID_PREFIX}-')`]),
    );
  });

  test('runs concurrently: tags unique to the run, and only stale ids swept without a record', () => {
    const workflow = readFileSync(
      '.github/workflows/e2e-cluster-cloud.yml',
      'utf8',
    );
    expect(workflow).not.toMatch(/^concurrency:/mu);
    expect(workflow).not.toContain('0.0.3');
    // A release version (`api upgrade` refuses a prerelease) the run owns.
    expect(workflow).toContain('export VERSION="${version%.*}.$GITHUB_RUN_ID"');
    expect(workflow).toContain('ANYCLOUD_ALTERNATE_API_IMAGE_TAG=$VERSION-b');
    for (const step of [
      'Sweep AWS resources tagged for this run',
      'Sweep DNS records of the run',
      'Sweep GCP cluster resources',
      'Sweep Azure cluster resources',
    ]) {
      const body = workflow.slice(workflow.indexOf(`- name: ${step}`));
      expect(body.slice(0, body.indexOf('- name:', 8)), step).toContain(
        'npx tsx ci/cleanup/e2e-cluster-stale-ids.ts',
      );
    }
  });

  test('keeps the bucket on delete and deletes it with --delete-buckets --cloud --region once the API is gone, or proves --delete-buckets deleted it', async () => {
    const removed: string[] = [];
    const bucket = cluster('running').checkpointBucket.name;
    for (const deleteBuckets of [false, true]) {
      const { aws, cliRuns } = environment(
        (args) => (args.includes('list-buckets') ? [bucket] : []),
        (args) =>
          args[1] === 'delete'
            ? deleteResult(args.includes('--delete-buckets'))
            : cluster('running'),
        undefined,
        {
          clusterBucketDeleter: {
            deleteBucket: async (name) => void removed.push(name),
          },
        },
      );
      await aws.bootstrap(60_000);
      await aws.destroy(120_000, deleteBuckets);
      await expect(
        deleteBuckets ? aws.bucketDeleted() : aws.keptBucket(),
      ).resolves.toEqual(
        deleteBuckets
          ? { name: bucket, kept: false }
          : { name: bucket, kept: true, finalBackup: 'taken' },
      );
      if (!deleteBuckets) {
        const kept = cliRuns.filter(
          ({ args }) =>
            args[1] === 'delete' && args.includes('--delete-buckets'),
        );
        expect(kept).toHaveLength(1);
        expect(kept[0]!.args).toEqual([
          'api',
          'delete',
          '--delete-buckets',
          '--confirm',
          bucket,
          '--cloud',
          'aws',
          '--region',
          'us-east-2',
          '--json',
          bucket,
        ]);
        expect(kept[0]!.env).toMatchObject({
          API_URL: cluster('running').managementApiUrl,
        });
      }
    }
    // The gateway is only cleanup's backstop.
    expect(removed).toEqual([]);
  });

  test("a failed run's cleanup deletes the cluster with its bucket, which nothing else removes", async () => {
    const { aws, cleanup, cliRuns } = environment(
      () => [],
      (args) =>
        args[1] === 'delete' ? deleteResult(true) : cluster('running'),
    );
    await aws.bootstrap(60_000);
    // The journey fails before its own delete: cleanup's delete runs.
    await cleanup.run();
    const deletes = cliRuns.filter(({ args }) => args[1] === 'delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.args).toEqual(
      expect.arrayContaining(['--delete-buckets', '--confirm']),
    );
  });

  test('refuses a delete that did not keep the bucket after a final backup, or a kept one that is gone', async () => {
    const bucket = cluster('running').checkpointBucket.name;
    const noBackup = { ...deleteResult(), finalBackup: 'failed' };
    for (const [result, listed, message] of [
      [noBackup, [bucket], 'did not keep the managed bucket'],
      [deleteResult(), [], 'deleted the kept bucket'],
    ] as const) {
      const { aws } = environment(
        (args) => (args.includes('list-buckets') ? [...listed] : []),
        (args) => (args[1] === 'delete' ? result : cluster('running')),
        undefined,
        { clusterBucketDeleter: { deleteBucket: async () => {} } },
      );
      await aws.bootstrap(60_000);
      await aws.destroy(120_000);
      await expect(aws.keptBucket()).rejects.toThrow(message);
    }
  });

  test.each(['settles', 'remains', 'read fails'] as const)(
    'bounds post-destroy bucket listing when it %s',
    async (outcome) => {
      vi.useFakeTimers();
      try {
        let bucketReads = 0;
        let state = 'running';
        const bucket = 'e2e-clust-1790000000000-e5f6';
        const { aws, artifacts, runner } = environment(
          (args) => {
            if (!args.includes('list-buckets')) return [];
            bucketReads++;
            if (outcome === 'read fails' && bucketReads > 1)
              throw new Error('bucket inventory forbidden');
            return outcome === 'settles' && bucketReads >= 3 ? [] : [bucket];
          },
          (args) =>
            args[1] === 'delete' ? deleteResult(true) : cluster(state),
        );
        await aws.bootstrap(60_000);
        state = 'terminated';
        await aws.destroy(120_000, true);
        const sweep = aws.sweep();
        const assertion =
          outcome === 'read fails'
            ? expect(sweep).rejects.toThrow('bucket inventory forbidden')
            : expect(sweep).resolves.toMatchObject({
                buckets: outcome === 'settles' ? [] : [bucket],
              });
        await vi.advanceTimersByTimeAsync(60_000);
        await assertion;
        if (outcome === 'settles') expect(bucketReads).toBe(3);
        if (outcome === 'read fails') expect(bucketReads).toBe(2);
        if (outcome === 'remains') {
          expect(bucketReads).toBeGreaterThan(2);
          expect(artifacts.json).toHaveBeenCalledWith(
            'cluster-native-sweep',
            expect.objectContaining({ buckets: [bucket] }),
          );
        }
        const reads = runner.run.mock.calls.filter((call) =>
          call[1].includes('list-buckets'),
        );
        for (const call of reads.slice(1)) {
          expect(call[2]).toEqual(
            expect.objectContaining({ timeoutMs: expect.any(Number) }),
          );
          const options = call[2];
          expect(options?.timeoutMs).toBeGreaterThan(0);
          expect(options?.timeoutMs).toBeLessThanOrEqual(60_000);
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test('derives the checkpoint bucket from the installation', () => {
    const { aws } = environment(() => []);
    // The product manages a bucket named after the installation id; there is
    // no run-scoped bucket to create or pass before bootstrap.
    expect(() => aws.bucket).toThrow('Cluster is not created');
  });

  test("from a release, its CLI saves the credential and creates the cluster, then this CLI's api upgrade must restart the installer over the same data", async () => {
    const released: { args: string[]; timeoutMs?: number }[] = [];
    let restarted = 'Local API server is on 0.1.65; restarting it';
    const { aws, cliRuns } = environment(
      () => [],
      (args) => (args[0] === 'api' ? restarted : cluster('running')),
      undefined,
      {
        fromRelease: {
          version: '0.1.65',
          installerDirectory: '/tmp/installer',
          cli: {
            run: vi.fn(async (args, options) => {
              released.push({ args: [...args], timeoutMs: options?.timeoutMs });
              // From 0.1.66 create returns at once; the list shows it running.
              return commandResultForTest({
                stdout: JSON.stringify(
                  args[1] === 'list'
                    ? [{ name: 'e2e-cluster-abcdef0123', state: 'running' }]
                    : { id: cluster('running').id, state: 'provisioning' },
                ),
              });
            }),
          },
        },
        wait: onFakeClock(),
      },
    );
    await aws.prepare();
    // A fake clock: the released create gets the whole budget only when no
    // time passes between bootstrap's deadline and its first remaining() read.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await aws.bootstrap(60_000);
    } finally {
      vi.useRealTimers();
    }
    expect(released.map(({ args }) => args.slice(0, 2))).toEqual([
      ['credentials', 'new'],
      ['cluster', 'create'],
      ['cluster', 'list'],
    ]);
    expect(released[1].timeoutMs).toBe(60_000);
    expect(cliRuns[0]).toMatchObject({
      args: ['api', 'upgrade'],
      env: { ANYCLOUD_DIR: '/tmp/installer' },
    });
    expect(cliRuns[1].args.slice(0, 2)).toEqual(['cluster', 'list']);
    restarted = 'Local API matches anycloud 0.0.3.';
    const again = environment(
      () => [],
      () => restarted,
      undefined,
      {
        fromRelease: {
          version: '0.1.65',
          installerDirectory: '/tmp/installer',
          cli: {
            run: vi.fn(async (args: readonly string[]) =>
              commandResultForTest({
                stdout: JSON.stringify(
                  args[1] === 'list'
                    ? [{ name: 'e2e-cluster-abcdef0123', state: 'ready' }]
                    : { id: 'c-1' },
                ),
              }),
            ),
          },
        },
      },
    );
    await expect(again.aws.bootstrap(60_000)).rejects.toThrow(
      'api upgrade did not restart the 0.1.65 installer',
    );
  });

  test('the installer is not upgraded while the released creation runs, and a failed creation stops the bootstrap before it', async () => {
    const states = ['provisioning', 'provisioning', 'failed'];
    const { aws, cliRuns } = environment(() => [], undefined, undefined, {
      fromRelease: {
        version: '0.1.66',
        installerDirectory: '/tmp/installer',
        cli: {
          run: vi.fn(async (args: readonly string[]) =>
            commandResultForTest({
              stdout: JSON.stringify(
                args[1] === 'list'
                  ? [
                      {
                        name: 'e2e-cluster-abcdef0123',
                        state: states.shift() ?? 'failed',
                        lastError: 'no capacity',
                      },
                    ]
                  : { id: 'c-1', state: 'provisioning' },
              ),
            }),
          ),
        },
      },
      wait: pollsOnly(),
    });
    await expect(aws.bootstrap(60_000)).rejects.toThrow(
      "the 0.1.66 installer's cluster is failed: no capacity",
    );
    expect(cliRuns).toEqual([]);
  });

  test('before the installer upgrade, the released CLI deletes the cluster it created once its creation settles; this CLI is refused by that installer', async () => {
    const released: string[][] = [];
    // Delete is refused while creation runs, so cleanup waits for it.
    const states = ['bootstrapping', 'ready'];
    const { aws, cleanup, cliRuns } = environment(
      () => [],
      undefined,
      undefined,
      {
        fromRelease: {
          version: '0.1.65',
          installerDirectory: '/tmp/installer',
          cli: {
            run: vi.fn(async (args: readonly string[]) => {
              released.push([...args]);
              if (args[1] === 'create') {
                return commandResultForTest({ exitCode: null, timedOut: true });
              }
              return commandResultForTest({
                stdout: JSON.stringify(
                  args[1] === 'list'
                    ? [
                        {
                          name: 'e2e-cluster-abcdef0123',
                          state: states.shift() ?? 'ready',
                        },
                      ]
                    : { state: 'destroyed' },
                ),
              });
            }),
          },
        },
        wait: pollsOnly(),
      },
    );
    await expect(aws.bootstrap(60_000)).rejects.toThrow(
      'cluster create (released)',
    );
    await cleanup.run();
    expect(released.map((args) => args.slice(0, 2))).toEqual([
      ['cluster', 'create'],
      ['cluster', 'list'],
      ['cluster', 'list'],
      ['cluster', 'delete'],
    ]);
    expect(released[3]).toContain('e2e-cluster-abcdef0123');
    expect(cliRuns).toEqual([]);
    expect(cleanup.observations()).toEqual([
      { label: 'cluster e2e-cluster-abcdef0123', completed: true },
    ]);
  });

  test('a creation stuck past the bootstrap budget is not waited for again: cleanup reads it once and leaves it to the sweep', async () => {
    const released: string[][] = [];
    const { aws, cleanup } = environment(() => [], undefined, undefined, {
      fromRelease: {
        version: '0.1.66',
        installerDirectory: '/tmp/installer',
        cli: {
          run: vi.fn(async (args: readonly string[]) => {
            released.push([...args]);
            return commandResultForTest({
              stdout: JSON.stringify(
                args[1] === 'list'
                  ? [
                      {
                        name: 'e2e-cluster-abcdef0123',
                        state: 'provisioning',
                      },
                    ]
                  : { id: 'c-1', state: 'provisioning' },
              ),
            });
          }),
        },
      },
      wait: pollsOnly(),
    });
    await expect(aws.bootstrap(60_000, 900_000)).rejects.toThrow(
      'cluster is provisioning',
    );
    const listedByBootstrap = released.length - 1;
    await expect(cleanup.run()).rejects.toThrow(
      'is still provisioning; delete is refused while its creation runs',
    );
    expect(released.length - 1 - listedByBootstrap).toBe(1);
    expect(released.some((args) => args[1] === 'delete')).toBe(false);
  });

  test.each([
    ['fails', { exitCode: 1 }, true],
    ['runs out of time', { exitCode: null, timedOut: true }, false],
  ] as const)(
    "this tree's create that %s records the id it printed, and cleanup deletes the cluster from the runner's ledger",
    async (_case, outcome, printsCluster) => {
      const id = cluster('failed').id;
      const { aws, cleanup, cliRuns, artifacts } = environment(
        () => [],
        (args) =>
          args[1] === 'delete'
            ? deleteResult()
            : {
                result: commandResultForTest({
                  ...outcome,
                  stdout: printsCluster
                    ? JSON.stringify({
                        ...cluster('failed'),
                        lastError: 'no capacity',
                      })
                    : '',
                  combined: `Creating cluster e2e-cluster-abcdef0123 (ID: ${id})`,
                  executable: 'anycloud',
                }),
              },
      );
      await expect(aws.bootstrap(60_000, 900_000)).rejects.toThrow(
        printsCluster
          ? 'api create failed (exit 1, timeout false): failed: no capacity'
          : 'api create failed (exit null, timeout true)',
      );
      expect(artifacts.json).toHaveBeenCalledWith(
        'e2e-cluster-cloud-resources',
        expect.objectContaining({ installationId: id }),
      );
      await cleanup.run();
      const deletes = cliRuns.filter(({ args }) => args[1] === 'delete');
      expect(deletes.map(({ args }) => args)).toEqual([
        [
          'api',
          'delete',
          '--json',
          '--cloud',
          'aws',
          '--region',
          'us-east-2',
          '--delete-buckets',
          '--confirm',
          id,
          id,
        ],
      ]);
      // The failed create's boot log, for the artifacts.
      expect(artifacts.json).toHaveBeenCalledWith(
        'management-vm-console',
        expect.objectContaining({ clusterId: id, output: 'boot log\n' }),
      );
      // The delete reads the cloud session too, and the installation's hostname
      // (its API may answer though create's output didn't say so).
      expect(deletes[0]!.env).toMatchObject({
        AWS_ACCESS_KEY_ID: 'AKIA-test',
        AWS_SECRET_ACCESS_KEY: 'secret-test',
      });
      expect(deletes[0]!.env).toMatchObject({
        API_URL: `https://${id}.anycloud.sh`,
      });
    },
  );

  test('a create that failed before its ledger leaves cleanup nothing to delete', async () => {
    const { aws, cleanup, cliRuns } = environment(
      () => [],
      (args) =>
        args[1] === 'delete'
          ? {
              failed:
                "Failed to delete cluster: Neither this machine's create ledgers nor the active API know cluster e2e-cluster-abcdef0123. If it still runs, select its hosted API with anycloud api use https://<cluster-id>.anycloud.sh and retry. If it was deleted and kept its checkpoint bucket, that bucket is named for the cluster ID: delete it in your cloud console",
            }
          : {
              failed:
                'Failed to create cluster: No AWS session on this machine',
            },
    );
    await expect(aws.bootstrap(60_000, 900_000)).rejects.toThrow(
      'No AWS session on this machine',
    );
    await cleanup.run();
    expect(cleanup.observations()).toEqual([
      { label: 'cluster e2e-cluster-abcdef0123', completed: true },
      { label: 'e2e access kubeconfig', completed: true },
    ]);
    expect(cliRuns.filter(({ args }) => args[1] === 'delete')).toHaveLength(1);
  });

  test.each([
    [
      'AWS',
      awsProfile,
      {
        AWS_ACCESS_KEY_ID: 'AKIA-test',
        AWS_SECRET_ACCESS_KEY: 'secret-test',
        AWS_REGION: 'us-east-2',
      },
      [],
    ],
    [
      'Azure',
      azureProfile,
      { AZURE_CONFIG_DIR: expect.stringContaining('e2e-cloud-session-') },
      [
        'az login --service-principal --username app-test --password secret-test --tenant tenant-test --output none',
        'az account set --subscription sub-test',
      ],
    ],
    [
      'GCP',
      gcpProfile,
      {
        CLOUDSDK_CONFIG: expect.stringContaining('e2e-cloud-session-'),
        CLOUDSDK_CORE_PROJECT: 'proj-test',
      },
      [
        expect.stringMatching(
          /^gcloud auth activate-service-account sa@proj-test\.iam\.gserviceaccount\.com --key-file=\S+key\.json --quiet$/,
        ),
      ],
    ],
  ] as const)(
    "creates through the runner's %s CLI signed in as the cluster credential, then reads the cluster at the hosted API",
    async (_cloud, profile, sessionEnv, signIn) => {
      const sessionAtDelete: boolean[] = [];
      const session: { dir?: string } = {};
      const { aws, cleanup, cliRuns, seedRuns, runner } = environment(
        () => [],
        (args) => {
          if (args[1] !== 'delete') return cluster('running');
          if (session.dir) sessionAtDelete.push(existsSync(session.dir));
          return deleteResult();
        },
        undefined,
        {
          profile,
          ...(profile.provider === CloudType.AWS
            ? {}
            : {
                clusterInventory: {
                  liveInstances: async () => [],
                  networkLeftovers: async () => [],
                },
              }),
        },
      );
      await aws.prepare();
      const created = await aws.bootstrap(60_000);
      expect(created.id).toBe(cluster('running').id);
      const create = cliRuns.find(({ args }) => args[1] === 'create')!;
      expect(create.args).toEqual([
        'api',
        'create',
        '--cloud',
        profile.slug,
        '--region',
        'us-east-2',
        '--vm-type',
        't3.medium',
        '--json',
        'e2e-cluster-abcdef0123',
      ]);
      expect(create.timeoutMs).toBeGreaterThan(50_000);
      expect(create.env).toMatchObject(sessionEnv);
      // Signed in once, before create, with no artifact of the secret.
      expect(
        seedRuns.filter((run) => !run.includes('access-kubeconfig')),
      ).toEqual(signIn);
      expect(create.env).toMatchObject({ ANYCLOUD_E2E_ACCESS: '1' });
      for (const [executable, args, options] of runner.run.mock.calls) {
        if (signIn.length > 0 && /^(login|auth|account)$/.test(args[0]!))
          expect({ executable, options }).toMatchObject({
            options: { recordArtifact: false },
          });
      }
      await aws.clusters();
      expect(cliRuns.at(-1)).toMatchObject({
        args: ['cluster', 'list', '--json'],
        env: { API_URL: cluster('running').managementApiUrl },
      });
      session.dir = create.env?.CLOUDSDK_CONFIG ?? create.env?.AZURE_CONFIG_DIR;
      await cleanup.run();
      // Cleanup's delete runs on the session; the session goes after it.
      if (session.dir) {
        expect(sessionAtDelete).toEqual([true]);
        expect(existsSync(session.dir)).toBe(false);
      }
    },
  );

  test("reads the cluster with the access kubeconfig create's startup script left in the checkpoint bucket, never through the installer's database, and removes it at cleanup", async () => {
    const { aws, cleanup, cliRuns, runner } = environment(
      () => [],
      (args) => (args[1] === 'delete' ? deleteResult() : cluster('running')),
    );
    await aws.prepare();
    await aws.bootstrap(60_000);
    const read = runner.run.mock.calls.find(([, args]) =>
      args.includes(
        's3://' +
          cluster('running').checkpointBucket!.name +
          '/e2e/access-kubeconfig',
      ),
    );
    expect(read?.[2]).toMatchObject({ recordArtifact: false });
    const before = cliRuns.length;
    const config = await aws.hostedKubeConfig();
    expect(config.getCurrentCluster()?.server).toBe(
      'https://203.0.113.10:6443',
    );
    expect(config.getCurrentUser()?.token).toBe('e2e-token');
    expect(cliRuns).toHaveLength(before);
    await cleanup.run();
    await expect(aws.hostedKubeConfig()).rejects.toThrow();
  });

  test('a failed read before the delete leaves the cluster to the settled read', async () => {
    let failList = false;
    const { aws, cleanup, cliRuns } = environment(
      () => [],
      (args) => {
        if (args[1] === 'delete') return deleteResult();
        if (args[1] === 'list' && failList) {
          failList = false;
          return { failed: 'Failed to list clusters: fetch failed' };
        }
        return cluster('running');
      },
      undefined,
      { wait: pollsOnly() },
    );
    await aws.bootstrap(60_000, 900_000);
    failList = true;
    await cleanup.run();
    expect(cliRuns.filter(({ args }) => args[1] === 'delete')).toHaveLength(1);
  });

  test.each([true, false])(
    'a delete the older hosted API refuses waits for its upgrade only when one was requested (upgrade requested: %s)',
    async (requested) => {
      let deletes = 0;
      const served = ['0.1.65', '0.1.999'];
      const get = vi.fn(async () => ({
        status: 200,
        body: { version: served.shift() ?? '0.1.999' },
      }));
      const { aws, cleanup, cliRuns } = environment(
        () => [],
        (args) => {
          if (args[1] !== 'delete') return cluster('running');
          deletes += 1;
          return deletes === 1
            ? {
                failed:
                  "Failed to delete cluster: The hosted API at https://e2e-clust-1790000000000-e5f6.anycloud.sh refused this CLI's version: the hosted API (0.1.65) is older than this CLI (0.1.999); upgrade it",
              }
            : deleteResult();
        },
        undefined,
        { wait: pollsOnly(), http: { get } },
      );
      await aws.bootstrap(60_000, 900_000);
      if (!requested) {
        // Run 40815323572 waited 300 s for an upgrade nobody asked for.
        await expect(cleanup.run()).rejects.toThrow(
          'no hosted api upgrade was requested',
        );
        expect(deletes).toBe(1);
        expect(get).not.toHaveBeenCalled();
        return;
      }
      aws.noteHostedUpgrade();
      await cleanup.run();
      expect(deletes).toBe(2);
      expect(get).toHaveBeenCalledTimes(2);
      expect(String(get.mock.calls[0])).toContain(
        'https://e2e-clust-1790000000000-e5f6.anycloud.sh/v1/version',
      );
      expect(cliRuns.at(-1)?.args.slice(0, 2)).toEqual(['api', 'delete']);
    },
  );

  test('reads the hosted API version until a 200, and names every other answer when none comes', async () => {
    const answers = [500, 503, 200];
    const get = vi.fn(async () => {
      const status = answers.shift() ?? 500;
      return { status, body: status === 200 ? { version: '0.1.999' } : null };
    });
    const { aws } = environment(
      () => [],
      () => cluster('running'),
      undefined,
      { wait: pollsOnly(), http: { get } },
    );
    await aws.bootstrap(60_000, 900_000);
    await expect(aws.hostedVersion()).resolves.toBe('0.1.999');
    expect(get).toHaveBeenCalledTimes(3);
    answers.push(...Array<number>(10).fill(500));
    await expect(aws.hostedVersion()).rejects.toThrow(
      'hosted API version read: timed out: hosted API version read returned 500',
    );
  });

  test('reads the ServiceAccount issuer, then its JWKS at the advertised URI, and fails on a challenge page', async () => {
    const issuer = 'https://e2e-clust-1790000000000-e5f6.anycloud.sh';
    const answers: { status: number; body: unknown }[] = [
      {
        status: 200,
        body: { issuer, jwks_uri: `${issuer}/openid/v1/jwks` },
      },
      { status: 200, body: { keys: [{ kid: 'k1', kty: 'RSA' }] } },
      { status: 403, body: '<html>Just a moment...</html>' },
    ];
    const get = vi.fn(async (_label: string, _url: URL) => answers.shift()!);
    const { aws } = environment(
      () => [],
      () => cluster('running'),
      undefined,
      { http: { get } },
    );
    await aws.bootstrap(60_000, 900_000);
    await expect(aws.serviceAccountIssuer()).resolves.toEqual({
      issuer,
      jwksUri: `${issuer}/openid/v1/jwks`,
      keyIds: ['k1'],
    });
    expect(get.mock.calls.map(([, url]) => url.href)).toEqual([
      `${issuer}/.well-known/openid-configuration`,
      `${issuer}/openid/v1/jwks`,
    ]);
    await expect(aws.serviceAccountIssuer()).rejects.toThrow(
      `${issuer}/.well-known/openid-configuration answered 403: "<html>Just a moment...</html>"`,
    );
  });

  test('a cleanup refused for the version goes through the other CLI', async () => {
    const released: string[][] = [];
    const { aws, cleanup } = environment(
      () => [],
      (args) =>
        args[0] === 'cluster' || (args[0] === 'api' && args[1] === 'delete')
          ? {
              failed:
                'Failed to list clusters: Client/API version mismatch. Client version 0.1.999 must exactly match API version 0.1.65.',
            }
          : 'not restarted',
      undefined,
      {
        fromRelease: {
          version: '0.1.65',
          installerDirectory: '/tmp/installer',
          cli: {
            run: vi.fn(async (args: readonly string[]) => {
              released.push([...args]);
              return commandResultForTest({
                stdout: JSON.stringify(
                  args[1] === 'list'
                    ? [{ name: 'e2e-cluster-abcdef0123', state: 'ready' }]
                    : args[1] === 'create'
                      ? { id: 'c-1' }
                      : { state: 'destroyed' },
                ),
              });
            }),
          },
        },
        wait: pollsOnly(),
      },
    );
    // `api upgrade` ran but did not restart the installer.
    await expect(aws.bootstrap(60_000, 900_000)).rejects.toThrow(
      'api upgrade did not restart the 0.1.65 installer',
    );
    await cleanup.run();
    expect(released.map((args) => args.slice(0, 2)).slice(-2)).toEqual([
      ['cluster', 'list'],
      ['cluster', 'delete'],
    ]);
  });

  describe("a from_release bootstrap waits for the runner's resolver to answer an A record", () => {
    function released(lookup4: (hostname: string) => Promise<unknown>) {
      const pauses: number[] = [];
      const states = ['provisioning', 'starting', 'running'];
      const env = environment(
        () => [],
        (args) =>
          args[0] === 'api'
            ? 'Local API server is on 0.1.70; restarting it'
            : cluster('running'),
        undefined,
        {
          lookup4,
          wait: onFakeClock(pauses),
          fromRelease: {
            version: '0.1.70',
            installerDirectory: '/tmp/installer',
            cli: {
              run: vi.fn(async (args: readonly string[]) =>
                commandResultForTest({
                  stdout: JSON.stringify(
                    args[1] === 'list'
                      ? [
                          {
                            name: 'e2e-cluster-abcdef0123',
                            state: states.shift() ?? 'running',
                          },
                        ]
                      : { id: cluster('running').id },
                  ),
                }),
              ),
            },
          },
        },
      );
      return { ...env, pauses };
    }
    const nxdomain = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), {
        code: 'ENOTFOUND',
      });
    };

    /** Bootstrap on the fake clock; resolves to the milliseconds it took. */
    async function timed(bootstrap: () => Promise<unknown>) {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const startedAt = Date.now();
        await bootstrap();
        return Date.now() - startedAt;
      } finally {
        vi.useRealTimers();
      }
    }

    // `starting` is first seen on the second poll, 10 s in, so the floor is at
    // 10 s + 1890 s; the DNS wait polls every 15 s from `running`, 20 s in.
    test('no lookup ends it before the Release step + 1890 s, even when A answers at once', async () => {
      const lookup4 = vi.fn(async () => ({ address: '172.67.180.7' }));
      const { aws, pauses } = released(lookup4);
      expect(await timed(() => aws.bootstrap(2_400_000))).toBe(1_910_000);
      expect(lookup4).toHaveBeenCalledTimes(1);
      expect(lookup4).toHaveBeenCalledWith(
        'e2e-clust-1790000000000-e5f6.anycloud.sh',
      );
      expect(pauses).toEqual([10_000, 10_000, ...Array(126).fill(15_000)]);
    });

    test('after the floor, it ends on the first A record', async () => {
      const lookup4 = vi
        .fn<(hostname: string) => Promise<unknown>>()
        .mockImplementationOnce(nxdomain)
        .mockImplementationOnce(nxdomain)
        .mockResolvedValue({ address: '172.67.180.7', family: 4 });
      const { aws } = released(lookup4);
      expect(await timed(() => aws.bootstrap(2_400_000))).toBe(1_940_000);
      expect(lookup4).toHaveBeenCalledTimes(3);
    });

    test('it fails at 35 min after the Release step, naming the lookup error', async () => {
      const lookup4 = vi.fn(nxdomain);
      const { aws } = released(lookup4);
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const startedAt = Date.now();
        await expect(aws.bootstrap(2_400_000)).rejects.toThrow(
          /e2e-clust-1790000000000-e5f6\.anycloud\.sh A record at the runner's resolver: timed out .*no A record: ENOTFOUND/u,
        );
        expect(Date.now() - startedAt).toBe(10_000 + 35 * 60_000);
      } finally {
        vi.useRealTimers();
      }
      // Lookups only from the floor: 1910 s to 2105 s, every 15 s.
      expect(lookup4).toHaveBeenCalledTimes(14);
    });

    test('a run without from_release never looks the host up', async () => {
      const lookup4 = vi.fn(nxdomain);
      const { aws } = environment(
        () => [],
        () => cluster('running'),
        undefined,
        { lookup4 },
      );
      await aws.bootstrap(60_000);
      expect(lookup4).not.toHaveBeenCalled();
    });
  });

  test('records the hosted API identity after bootstrap and sweeps VMs by its owner tag', async () => {
    // Service and Job VMs the hosted API creates all carry anycloud_owner_api,
    // so none of their ids need recording.
    const identity = hostedApiIdentity('e2e-clust-1790000000000-e5f6');
    const ownerFilter = `Name=tag:anycloud_owner_api,Values=${identity}`;
    const { aws, runs, artifacts } = environment(
      (args) =>
        args.includes('describe-instances') && args.includes(ownerFilter)
          ? ['i-unrecorded-vm']
          : [],
      () => cluster('running'),
    );
    await aws.bootstrap(60_000);
    expect(artifacts.json).toHaveBeenCalledWith(
      'e2e-cluster-cloud-resources',
      expect.objectContaining({
        installationId: 'e2e-clust-1790000000000-e5f6',
        hostedApiIdentity: identity,
      }),
    );
    const leftovers = await aws.sweep();
    expect(leftovers.instances).toEqual(['i-unrecorded-vm']);
    for (const operation of [
      'describe-instances',
      'describe-security-groups',
      'describe-volumes',
    ]) {
      expect(runs).toContainEqual(
        expect.arrayContaining([operation, ownerFilter]),
      );
    }
    const workflow = readFileSync(
      new URL('../../.github/workflows/e2e-cluster-cloud.yml', import.meta.url),
      'utf8',
    );
    expect(workflow).toContain('.hostedApiIdentity // empty');
    // A failed run's resources are purged, not only reported, on every
    // cloud's sweep.
    for (const sweep of [
      'Sweep AWS resources tagged for this run',
      'Sweep GCP cluster resources',
      'Sweep Azure cluster resources',
    ]) {
      const start = workflow.indexOf(`- name: ${sweep}`);
      expect(start).toBeGreaterThan(-1);
      expect(
        workflow.slice(start, workflow.indexOf('- name:', start + 1)),
      ).toContain("steps.tests.outcome != 'success'");
    }
    expect(workflow).toContain(
      'Name=tag:anycloud_owner_api,Values=$hosted_api',
    );
  });

  test('without an installation id sweeps no bucket and deletes no DNS record of another run', async () => {
    // Runs are concurrent: every other `e2e-clust-` bucket may be a live run's.
    const { aws, runs, dnsDeletes } = environment((args) =>
      args.includes('list-buckets') ? ['e2e-clust-1790300000000-a1b2'] : [],
    );
    expect((await aws.sweep()).buckets).toEqual([]);
    expect(dnsDeletes).toEqual([]);
    expect(runs.some((args) => args.includes('list-buckets'))).toBe(false);
  });

  test('sweeps by the product tags of the run and reports every leftover class', async () => {
    seedLeft = true;
    onTestFinished(() => {
      seedLeft = false;
    });
    const id = 'e2e-clust-1790000000000-e5f6';
    const { aws, runs, envs, artifacts, dnsDeletes } = environment(
      (args) => {
        if (args.includes('describe-instances')) return ['i-0123'];
        if (args.includes('describe-security-groups')) return [];
        if (args.includes('describe-volumes')) return ['vol-9'];
        if (args.includes('list-buckets')) return [id];
        return [];
      },
      // `api create` returns the id, then the creation fails.
      () => cluster('failed'),
      () => 500,
    );
    await expect(aws.bootstrap(60_000)).rejects.toThrow('api create failed');
    // Recorded before bootstrap ran, for the workflow sweep.
    expect(artifacts.json).toHaveBeenCalledWith(
      'e2e-cluster-cloud-resources',
      expect.objectContaining({ installationId: id, hostedApiIdentity: null }),
    );
    const leftovers = await aws.sweep();
    // The Worker's 2xx is idempotent: only a failed delete is a leftover,
    // unverified.
    expect(leftovers).toEqual({
      instances: ['i-0123'],
      securityGroups: [],
      volumes: ['vol-9'],
      buckets: [id],
      // A create that failed leaves its stack and what it tagged.
      installation: [
        `aws:installation ${id} (stack ROLLBACK_COMPLETE)`,
        `aws:ec2 arn:aws:ec2:us-east-2:1:volume/vol-9`,
      ],
      dnsRecords: [`dns:${id} (unverified: HTTP 500: worker down)`],
      dnsDeferred: false,
    });
    expect(dnsDeletes).toEqual([`DELETE ${id} Bearer gh-token`]);
    expect(
      runs.find((args) => args.includes('list-buckets'))?.join(' '),
    ).toContain(`Buckets[?Name=='${id}'].Name`);
    const filters = runs
      .flatMap((args) => args)
      .filter((arg) => arg.startsWith('Name=tag:'));
    expect(new Set(filters)).toEqual(
      new Set([`Name=tag:anycloud_cluster,Values=${id}`]),
    );
    for (const env of envs) expect(env.AWS_ACCESS_KEY_ID).toBe('AKIA-test');
    // The harness's own inventory reads; the seed's are its CLI's text and JSON.
    for (const args of runs) {
      expect(args).toEqual(
        expect.arrayContaining(['--region', 'us-east-2', '--output', 'json']),
      );
    }
    expect(artifacts.json).toHaveBeenCalledWith(
      'cluster-native-sweep',
      expect.objectContaining({
        runId: 'abcdef0123',
        instances: ['i-0123'],
      }),
    );
  });

  test.each([
    ['GCP', gcpProfile, 'us-central1', 'gcp'],
    ['Azure', azureProfile, 'westus2', 'azure'],
  ] as const)(
    'reads a management VM on %s from its own cloud: its VM and network by scope, its checkpoint buckets, and no AWS call',
    async (_name, profile, region, cloud) => {
      const scopes: string[] = [];
      const clusterInventory = {
        liveInstances: async (scope: string) => {
          scopes.push(scope);
          return ['anycloud-cluster-vm'];
        },
        networkLeftovers: async (scope: string) => {
          scopes.push(scope);
          return ['firewall/anycloud-cluster-rule'];
        },
      };
      const pages = [
        {
          buckets: [
            { name: 'e2e-clust-1790000000000-e5f6', region, createdAt: null },
            { name: 'someone-elses', region, createdAt: null },
          ],
          nextCursor: 'page-2',
        },
        {
          buckets: [
            { name: 'e2e-clust-1790500000000-f7a8', region, createdAt: null },
          ],
          nextCursor: null,
        },
      ];
      const listings: (string | undefined)[] = [];
      const clusterStorage = {
        listBuckets: async (options: { cursor?: string }) => {
          listings.push(options.cursor);
          return pages.shift()!;
        },
      };
      const { aws, runs, artifacts } = environment(
        () => [],
        () => ({
          ...cluster('running'),
          cloudProvider: profile.provider,
          region,
        }),
        undefined,
        { profile, region, clusterInventory, clusterStorage },
      );
      expect(aws.clusterProvider).toBe(cloud);
      await aws.bootstrap(60_000);
      expect(artifacts.json).toHaveBeenCalledWith(
        'e2e-cluster-cloud-resources',
        expect.objectContaining({ clusterProvider: cloud }),
      );
      expect(await aws.backupObjectVersions()).toBeNull();
      const leftovers = await aws.sweep();
      expect(leftovers.instances).toEqual([`${cloud}:anycloud-cluster-vm`]);
      expect(leftovers.securityGroups).toEqual([
        `${cloud}:firewall/anycloud-cluster-rule`,
      ]);
      // Every page is read; another run's leftover is not this run's.
      expect(leftovers.buckets).toEqual(['e2e-clust-1790000000000-e5f6']);
      expect(listings).toEqual([undefined, 'page-2']);
      expect(new Set(scopes)).toEqual(
        new Set(['anycloud-cluster-e2e-clust-1790000000000-e5f6']),
      );
      // Nothing cluster-side is read with the AWS CLI.
      expect(runs).toEqual([]);
      expect(artifacts.json).toHaveBeenCalledWith(
        'cluster-native-sweep',
        expect.objectContaining({ clusterProvider: cloud, filters: [] }),
      );
    },
  );

  test('the workflow sweeps a GCP or Azure management VM, its network and checkpoint bucket', () => {
    const workflow = readFileSync(
      '.github/workflows/e2e-cluster-cloud.yml',
      'utf8',
    );
    expect(workflow).toContain('options: [aws, gcp, azure]');
    // GCP: the management VM's resource scope, or without a record every
    // stale e2e installation's; GCS buckets named after installations.
    expect(workflow).toContain('scopes="anycloud-cluster-$installation"');
    // An empty scope never becomes an empty (list-everything) filter.
    expect(workflow).toContain('if [ -n "${scopes//[[:space:]]/}" ]; then');
    expect(workflow).toContain(
      `listing="$(gcloud storage buckets list --project "$GCP_PROJECT_ID" --format='value(name)' --quiet)"`,
    );
    // Azure: installations by their own tags, both regions, and the shared
    // storage account's checkpoint containers.
    expect(workflow).toContain(
      '"[?tags.anycloud_cluster].tags.anycloud_cluster"',
    );
    expect(workflow).toContain(
      `account="anycloud$(printf '%s' "$AZURE_SUBSCRIPTION_ID" | tr -d '-' | cut -c1-8)"`,
    );
    // Every id the owner purge reaches is this member's, wherever it was found.
    expect(workflow).toContain(
      `INSTALLATION_IDS="$(printf '%s\\n' $INSTALLATION_IDS | grep '^e2e-clust-' | sort -u | tr '\\n' ' ' || true)"`,
    );
    // The container check runs before, and regardless of, the installations' owners.
    const azure = workflow.slice(
      workflow.indexOf('- name: Sweep Azure cluster resources'),
    );
    expect(azure.indexOf('az storage container list')).toBeGreaterThan(0);
    expect(azure.indexOf('az storage container list')).toBeLessThan(
      azure.indexOf('for id in $INSTALLATION_IDS'),
    );
    expect(azure).not.toContain('No installation ids to sweep on Azure');
    // Only a cluster on that cloud (or sweep_only) widens either sweep.
    expect(workflow).toContain(
      'cluster_here="${{ inputs.cluster_provider == \'gcp\' || inputs.sweep_only }}"',
    );
    expect(workflow).toContain(
      "CLUSTER_HERE: ${{ inputs.cluster_provider == 'azure' || inputs.sweep_only }}",
    );
  });

  test('reads a missing Azure regional group as an empty pool', async () => {
    const missing = () => ({
      [Symbol.asyncIterator]: () => ({
        next: () =>
          Promise.reject(
            Object.assign(new Error('gone'), { code: 'ResourceGroupNotFound' }),
          ),
      }),
    });
    const inventory = new AzurePoolInventory(
      azureProfile.credential,
      'westus2',
      {
        vms: missing,
        disks: missing,
        nics: missing,
        publicIps: missing,
        nsgs: missing,
        vnets: missing,
      },
    );
    expect(await inventory.liveInstances('p-pool-1')).toEqual([]);
    expect(await inventory.networkLeftovers('p-pool-1')).toEqual([]);
    expect(
      () => new AzurePoolInventory(gcpProfile.credential, 'westus2'),
    ).toThrow('An Azure node pool needs an Azure credential');
  });

  test('verifies the destroy by DNS resolution: an answer is a leftover, ENOTFOUND is clean, other errors are unverified', async () => {
    const failing = (code: string) => async () => {
      throw Object.assign(new Error(code), { code });
    };
    const resolve = vi.fn(async () => ['104.21.0.1', '172.67.0.1']);
    const poll = { timeoutMs: 1, intervalMs: 1, sleep: async () => undefined };
    expect(await resolveDnsRecord('r-1', { resolve, ...poll })).toEqual({
      outcome: 'leftover',
      addresses: ['104.21.0.1', '172.67.0.1'],
    });
    expect(resolve).toHaveBeenCalledWith('r-1.anycloud.sh');
    expect(
      await resolveDnsRecord('r-2', { resolve: failing('ENOTFOUND') }),
    ).toEqual({ outcome: 'clean' });
    expect(
      await resolveDnsRecord('r-3', { resolve: failing('EAI_AGAIN') }),
    ).toEqual({ outcome: 'unverified', reason: 'EAI_AGAIN' });
  });

  test('leaves the cluster DNS record alone while the cluster is live and sweeps it once destroyed', async () => {
    const { aws, dnsDeletes } = environment(
      () => [],
      (args) => (args.includes('delete') ? deleteResult() : cluster('running')),
    );
    await aws.bootstrap(60_000);
    // A failed journey sweeps before the cleanup stack has run `cluster
    // delete`, which still needs https://<id>.anycloud.sh: no DNS call.
    let leftovers = await aws.sweep();
    expect(dnsDeletes).toEqual([]);
    expect(leftovers.dnsDeferred).toBe(true);
    expect(leftovers.dnsRecords).toEqual([]);
    await aws.destroy(60_000);
    leftovers = await aws.sweep();
    expect(dnsDeletes).toEqual([
      'DELETE e2e-clust-1790000000000-e5f6 Bearer gh-token',
    ]);
    expect(leftovers.dnsDeferred).toBe(false);
  });
});

describe('the dead-API delete', () => {
  test('stops the VM, waits out the API, then deletes from a fresh home: plan, VMs, buckets, forget', async () => {
    const reports: Record<string, unknown> = {
      '': {
        outcome: 'planned',
        clusterId: cluster('running').id,
        finalBackup: null,
        deleted: [],
        remaining: [],
      },
      '--delete-vms': {
        outcome: 'destroyed',
        clusterId: cluster('running').id,
        finalBackup: null,
        deleted: [{ kind: 'managementVm', id: 'i-1' }],
        remaining: [],
      },
      '--delete-buckets': {
        outcome: 'destroyed',
        clusterId: cluster('running').id,
        finalBackup: null,
        deleted: [
          {
            kind: 'cloudResource',
            type: 'bucket',
            id: cluster('running').id,
            location: 'us-east-2',
          },
        ],
        remaining: [],
      },
      '--skip-cloud': {
        outcome: 'abandoned',
        clusterId: cluster('running').id,
        finalBackup: null,
        deleted: [],
        remaining: [],
      },
    };
    const { aws, cliRuns, seedRuns } = environment(
      (args) => (args.includes('list-buckets') ? [] : []),
      (args) => {
        if (args[1] !== 'delete') return cluster('running');
        const flag =
          args.find((arg) =>
            /^--(delete-vms|delete-buckets|skip-cloud)$/.test(arg),
          ) ?? '';
        return reports[flag];
      },
      undefined,
      { wait: pollsOnly() },
    );
    await aws.bootstrap(60_000);
    // Cloudflare's 52x for a gone origin is not an answer.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('origin down', { status: 521 }));
    onTestFinished(() => fetchSpy.mockRestore());
    const record = await aws.destroyWithoutApi(60_000);
    expect(
      record.steps.map((step) => [step.flags[0] ?? '', step.outcome]),
    ).toEqual([
      ['', 'planned'],
      ['--delete-vms', 'destroyed'],
      ['--delete-buckets', 'destroyed'],
      ['--skip-cloud', 'abandoned'],
    ]);
    expect(seedRuns).toContainEqual(
      expect.stringMatching(/^aws ec2 stop-instances --instance-ids i-mgmt/),
    );
    const deletes = cliRuns.filter(({ args }) => args[1] === 'delete');
    expect(deletes).toHaveLength(4);
    for (const run of deletes) {
      expect(run.args).toEqual(
        expect.arrayContaining([
          '--cloud',
          'aws',
          '--region',
          'us-east-2',
          '--json',
        ]),
      );
      expect(run.env).toMatchObject({
        HOME: expect.stringContaining('e2e-second-machine-'),
        API_URL: cluster('running').managementApiUrl,
      });
    }
    expect(deletes[3]!.args).toEqual(
      expect.arrayContaining([
        '--skip-cloud',
        '--confirm',
        cluster('running').id,
      ]),
    );
    expect(deletes[1]!.args).toEqual(
      expect.arrayContaining([
        '--delete-vms',
        '--confirm',
        cluster('running').id,
      ]),
    );
  });
});

describe('the dead-API delete when it fails', () => {
  test('cleanup deletes the VMs and buckets from the second machine', async () => {
    const { aws, cleanup, cliRuns } = environment(
      () => [],
      (args) => {
        if (args[1] !== 'delete') return cluster('running');
        if (args.includes('--delete-vms'))
          return {
            outcome: 'destroyed',
            clusterId: cluster('running').id,
            finalBackup: null,
            deleted: [],
            remaining: [],
          };
        return {
          outcome: 'planned',
          clusterId: 'other',
          finalBackup: null,
          deleted: [],
          remaining: [],
        };
      },
      undefined,
      { wait: pollsOnly() },
    );
    await aws.bootstrap(60_000);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('fetch failed'));
    onTestFinished(() => fetchSpy.mockRestore());
    await expect(aws.destroyWithoutApi(60_000)).rejects.toThrow(
      'with the API gone: planned, not destroyed',
    );
    await cleanup.run();
    const fallback = cliRuns.filter(
      ({ args }) =>
        args.includes('--delete-vms') && args.includes('--delete-buckets'),
    );
    expect(fallback).toHaveLength(1);
    expect(fallback[0]!.args).toEqual(
      expect.arrayContaining([
        '--delete-buckets',
        '--confirm',
        cluster('running').id,
        '--cloud',
        'aws',
      ]),
    );
  });
});

describe('the restore from the kept bucket', () => {
  test('restores under the same id and hostname, lists the cluster from the restored database, then deletes it with its bucket', async () => {
    const deletes: string[][] = [];
    const { aws, cliRuns } = environment(
      (args) =>
        args.includes('list-buckets')
          ? [cluster('running').checkpointBucket.name]
          : [],
      (args) => {
        if (args[1] === 'delete') {
          deletes.push([...args]);
          return deleteResult(deletes.length > 1);
        }
        return cluster('running');
      },
    );
    await aws.bootstrap(60_000);
    await aws.destroy(60_000, false);
    vi.spyOn(aws, 'hostedVersion').mockResolvedValue('0.1.74');
    const record = await aws.restoreFromKeptBucket(60_000, 60_000);
    expect(record).toEqual({
      name: cluster('running').checkpointBucket.name,
      kept: false,
      restored: {
        managementApiUrl: cluster('running').managementApiUrl,
        servedVersion: '0.1.74',
      },
    });
    const restore = cliRuns.filter(({ args }) => args[1] === 'create')[1]!;
    expect(restore.args).toEqual(
      expect.arrayContaining([
        '--checkpoint-bucket',
        cluster('running').checkpointBucket.name,
        '--cloud',
        'aws',
      ]),
    );
    expect(deletes[1]).toEqual(expect.arrayContaining(['--delete-buckets']));
  });
});

describe('the seed installation after delete', () => {
  test.each([
    [2, []],
    [
      20,
      [
        'aws:installation e2e-clust-1790000000000-e5f6 (stack DELETE_IN_PROGRESS)',
      ],
    ],
  ])(
    'waits for a self-deleting stack to go (still deleting for %i reads), and reports one that stays',
    async (deleting, installation) => {
      const { aws } = environment(
        () => [],
        (args) =>
          args.includes('delete') ? deleteResult() : cluster('running'),
        undefined,
        { wait: pollsOnly() },
      );
      await aws.bootstrap(60_000);
      await aws.destroy(60_000);
      seedDeleting = deleting;
      onTestFinished(() => {
        seedDeleting = 0;
      });
      expect((await aws.sweep()).installation).toEqual(installation);
    },
  );
});

describe('the installer token a from_release run presents', () => {
  test('is the GitHub sign-in until the upgraded installer writes its token', () => {
    const directory = mkdtempSync(join(tmpdir(), 'installer-token-'));
    try {
      // A pre-G0 release's `api start` wrote no token; its API takes GitHub.
      expect(readInstallerToken(directory, 'gho_github_sign_in')).toBe(
        'gho_github_sign_in',
      );
      expect(() => readInstallerToken(directory)).toThrow('ENOENT');
      writeFileSync(join(directory, 'local-api-token'), 'a'.repeat(64));
      expect(readInstallerToken(directory, 'gho_github_sign_in')).toBe(
        'a'.repeat(64),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
