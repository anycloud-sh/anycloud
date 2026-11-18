import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from 'vitest';

import {
  printError,
  printInfo,
  printSuccess,
} from '../../src/cli/utils/output.js';
import { formatClusterList } from '../../src/cli/commands/cluster.js';
import { validateId } from '../../src/api/services/workload-admission-checks.js';
import { throughBucketStorage } from '../../src/api/services/bucket-storage-operation.js';
import { createDeploymentInputSchema } from '../../src/shared/api-contract/deployments-schemas.js';
import { createNodePoolInputSchema } from '../../src/shared/api-contract/node-pools-schemas.js';
import type { CloudCredential } from '../../src/shared/api-contract/credentials-schemas.js';
import { CloudType } from '../../src/shared/cloud.js';
import { BucketThrottledError } from '../../src/shared/errors.js';
import { WorkloadState } from '../../src/shared/workload.js';
import {
  STALE_AFTER_MS,
  staleIds,
} from '../../ci/cleanup/e2e-cluster-stale-ids.js';
import { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import {
  FixtureNames,
  RUN_ID_LENGTH,
} from '../integration/e2e/internal/names.js';
import {
  GPU_SERVICE_COMMAND,
  GPU_SERVICE_IMAGE,
  HOSTED_VERDICT,
  HostedApiStage,
  type HostedStageOptions,
  assertHostedStageConfiguration,
  credentialsNewArgs,
  egressProbeEvidence,
  MACE_CANARY_OFFSET_EV,
  VOICE_TOLERANCE,
  MACE_RECEIVER_BASE_IMAGE,
  pushReceiverImage,
  REFUSED_RELEASE_IMAGE,
  STORAGE_CREDENTIAL,
  watchRequests,
} from '../integration/e2e/internal/substrates/cloud-cluster/hosted-stage.js';
import type { ServeDnsAbsenceObservation } from '../integration/e2e/internal/targets/serve-types.js';
import { Waiter } from '../integration/e2e/internal/wait.js';
import { commandResultForTest } from './helpers/e2e.js';
import {
  makeMockCloudStorage,
  makeStatusWorkloadMetadata,
  TEST_AWS_CRED,
  TEST_AZURE_CRED,
  TEST_GCP_CRED,
  TEST_LAMBDA_CRED,
} from './helpers/fixtures.js';

// validateId's uniqueness read: no workload exists yet.
vi.mock('../../src/api/services/persistence.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getWorkloadQueryStore: () => ({ workloadExists: async () => false }),
}));

const RUN_ID = 'r'.repeat(RUN_ID_LENGTH);
const NAMES = new FixtureNames(RUN_ID);
const ID = {
  pool: NAMES.nodePool('hosted'),
  receiver: NAMES.deployment('receiver'),
  service: NAMES.workload('service'),
  complete: NAMES.workload('complete'),
  hold: NAMES.workload('hold'),
  loss: NAMES.workload('after-loss'),
  session: NAMES.workload('replica-loss'),
  canary: NAMES.workload('mace-canary'),
  voiceCanary: NAMES.workload('voice-canary'),
  voiceCanary2: NAMES.workload('voice-canary-2'),
  holds: [1, 2, 3].map((n) => NAMES.workload(`hold-${n}`)),
  upgrades: Array.from({ length: 3 }, (_, n) =>
    NAMES.workload(`upgrade-${n + 1}`),
  ),
  parent: NAMES.workload('rec-parent'),
  child: NAMES.workload('rec-child'),
};
const HOSTED_URL = 'https://e2e-clust-1.anycloud.sh';
const A = `ghcr.io/anycloud-sh/api:0.0.3@sha256:${'a'.repeat(64)}`;
const B = `ghcr.io/anycloud-sh/api:0.0.3@sha256:${'b'.repeat(64)}`;
const RECEIVER = `ghcr.io/anycloud-sh/api:0.0.3-receiver@sha256:${'c'.repeat(64)}`;
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
    activeNodePoolCount: 1,
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

/** The replica's kubelet pull its pool Jobs' claims record. */
const PULL = {
  schemaVersion: 1,
  method: 'kubelet',
  outcome: 'succeeded',
  elapsedMs: 41_200,
} as const;

/** A completed Job created at 1 and claimed at 4; the claim recorded its replica's pull unless kubelet's Event was dropped. */
const completedWithPull = (id: string, pulled = true) => {
  const status = JSON.parse(statusJson(id, WorkloadState.Completed, 2));
  status.workload.startedAt = 1;
  status.events = [
    {
      id: 1,
      workloadId: id,
      state: WorkloadState.Running,
      metadata: pulled ? { imagePull: PULL } : null,
      createdAt: 4,
    },
  ];
  return JSON.stringify(status);
};

/** A canary created at 10, claimed by the warm receiver at 15, then errored with `message`. */
const erroredCanary = (id: string, message: string) => {
  const status = JSON.parse(statusJson(id, WorkloadState.Errored, 2, message));
  status.workload.startedAt = 10;
  status.events.unshift({
    id: 0,
    workloadId: id,
    state: WorkloadState.Running,
    metadata: null,
    createdAt: 15,
  });
  return JSON.stringify(status);
};

/** What fixtures/voice_session.py raises for the voice canary on a T4. */
const VOICE_CANARY_MESSAGE = `VOICE_CANARY ${JSON.stringify({
  device: 'Tesla T4',
  distance: 0.0491,
  firstChunkMs: 830,
  modelLoadId: 'load-1',
  rms: 0.0779,
  rtf: 0.475,
  seconds: 7.28,
})}`;

/** What fixtures/mace_inference.py raises for the canary on a T4. */
const CANARY_MESSAGE =
  'MACE b energy -2079.8651234 eV on Tesla T4 differs from reference -2078.8651274 eV';

const READY_POOL = JSON.stringify({
  id: 'np-1',
  name: ID.pool,
  clusterId: 'cluster-1',
  state: 'running',
  releasing: false,
  cloudProvider: CloudType.AWS,
  region: 'us-east-2',
  zone: null,
  vmTypes: ['t3.small'],
  minVmCount: 1,
  maxVmCount: 1,
  osDiskSizeGb: null,
  osDiskTier: null,
  spot: false,
  allowPrivilegedJobs: false,
  userNamespaceJobs: false,
  requireNestedVirtualization: false,
  capacity: {
    readyVmCount: 1,
    startingVmCount: 0,
    drainingVmCount: 0,
    locations: [],
  },
  liveReferences: 0,
  ingressEntryIp: null,
  ingress: { entryIp: null, release: null },
  lastError: null,
  createdAt: 1,
  updatedAt: 1,
});
const DELETING_POOL = JSON.stringify({
  ...JSON.parse(READY_POOL),
  state: 'terminated',
  releasing: true,
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

/** `deployment status --json` for the receiver; `podUid` null while it starts. */
const deploymentJson = (
  podUid: string | null,
  jobs: { terminal: number; unreleased: number } = {
    terminal: 0,
    unreleased: 0,
  },
  deletedAt: number | null = null,
  gpuCount = 0,
) =>
  JSON.stringify({
    id: 'dep-1',
    name: ID.receiver,
    nodePoolId: 'np-1',
    managed: false,
    privileged: false,
    target: { kind: 'nodePool', nodePoolId: 'np-1' },
    image: RECEIVER,
    command: null,
    readinessProbe: null,
    gracePeriodSeconds: 30,
    gpuCount,
    envKeys: [],
    secretNames: [],
    minReplicas: 1,
    maxReplicas: 1,
    maxConcurrentJobsPerReplica: 1,
    generation: 1,
    deletionRequestedAt: deletedAt,
    deletedAt,
    createdAt: 1,
    updatedAt: 1,
    jobs: { queued: 0, running: 0, retrying: 0, ...jobs },
    workload: null,
    usage: null,
    status: {
      state: podUid ? WorkloadState.Running : WorkloadState.Starting,
      releasing: false,
      ready: !!podUid,
      upgrade: null,
      reason: podUid ? 'Container is ready' : 'Waiting for a container',
      requestedGeneration: 1,
      appliedGeneration: 1,
      podGeneration: podUid ? 1 : null,
      podName: podUid ? 'receiver-pod' : null,
      podUid,
      containerId: podUid ? 'containerd://c1' : null,
      containerReady: podUid !== null,
      readyReplicas: podUid === null ? 0 : 1,
      applicationReady: null,
      probeConfigured: false,
      observation: 'observed',
      observedAt: 1,
      observationError: null,
      blockingJobs: { total: 0, jobs: [] },
    },
  });

/** The receiver's egress self-probe under K5's policy (fixtures/deployment.py). */
const EGRESS_LOG =
  'EGRESS_PROBE {"nameservers": ["169.254.169.254"], "apiHostResolved": true, "metadataHttp": "denied", "metadataError": "timeout"}\n';
const EGRESS = { nameservers: ['169.254.169.254'], metadataError: 'timeout' };

/**
 * The hosted API behind the receiver: a Job in E2E_COMPLETE_JOB_IDS completes and
 * is cleaned up at once; any other runs until terminated, then ends
 * `cancelled` (Terminated by default) with its cleanup acknowledged unless
 * `acknowledge` is false. `podAfterJobs` is the Pod the Deployment reports
 * once both Jobs are released.
 */
function poolJobsAnswer(
  options: {
    acknowledge?: boolean;
    cancelled?: WorkloadState;
    podAfterJobs?: string;
    gpuCount?: number;
    /** The Deployment's current Pod (host loss replaces it). */
    pod?: () => string;
    /** The canary Job's error message (GPU pools). */
    canaryMessage?: string;
    /** Voice: the Deployment runs all three held sessions at once. */
    admitsThree?: boolean;
    /** Voice: the canary beside a held session. */
    besideMessage?: string;
    /** kubelet's `Pulled` Event was dropped, so the claim recorded no pull. */
    eventDropped?: boolean;
  } = {},
) {
  const workloads = new Map<string, string>();
  let complete: readonly string[] = [];
  let deleted = false;
  let jobsDone = 0;
  const pod = () => options.pod?.() ?? 'pod-1';
  return (args: readonly string[]): object => {
    if (args[0] === 'deployment' && args[1] === 'create') {
      const env = args.find((arg) => arg.startsWith('E2E_COMPLETE_JOB_IDS='));
      complete = env?.split('=')[1]?.split(',') ?? [];
      return {
        stdout: deploymentJson(null, undefined, null, options.gpuCount),
      };
    }
    if (args[0] === 'deployment' && args[1] === 'status') {
      if (deleted) return { stdout: deploymentJson(pod(), undefined, 5) };
      return {
        stdout:
          jobsDone >= 2
            ? deploymentJson(
                options.podAfterJobs ?? pod(),
                { terminal: jobsDone, unreleased: 0 },
                null,
                options.gpuCount,
              )
            : deploymentJson(pod(), undefined, null, options.gpuCount),
      };
    }
    if (args[0] === 'deployment' && args[1] === 'delete') {
      deleted = true;
      return { stdout: deploymentJson(pod(), undefined, 5) };
    }
    if (args[0] === 'node-pool' && args[1] === 'status') {
      return { stdout: READY_POOL };
    }
    if (args[0] === 'job') {
      const id = args[args.indexOf('--id') + 1];
      const completes = complete.includes(id);
      const canary = [ID.canary, ID.voiceCanary, ID.voiceCanary2].includes(id);
      if (completes || canary) jobsDone += 1;
      // At concurrency 2 the third held voice session waits for a slot.
      const queued = id === ID.holds[2] && !options.admitsThree;
      workloads.set(
        id,
        completes
          ? completedWithPull(id, !options.eventDropped)
          : canary
            ? erroredCanary(
                id,
                (id === ID.voiceCanary2 ? options.besideMessage : undefined) ??
                  options.canaryMessage ??
                  (id === ID.canary ? CANARY_MESSAGE : VOICE_CANARY_MESSAGE),
              )
            : statusJson(
                id,
                queued ? WorkloadState.Queued : WorkloadState.Running,
              ),
      );
      return { combined: `ID: ${id}` };
    }
    if (args[0] === 'terminate') {
      if (args[1] === ID.holds[0] && workloads.has(ID.holds[2])) {
        workloads.set(
          ID.holds[2],
          statusJson(ID.holds[2], WorkloadState.Running),
        );
      }
      const acknowledged = options.acknowledge !== false;
      if (acknowledged) jobsDone += 1;
      workloads.set(
        args[1],
        statusJson(
          args[1],
          options.cancelled ?? WorkloadState.Terminated,
          acknowledged ? 3 : null,
        ),
      );
      return { combined: 'Termination scheduled' };
    }
    if (args[0] === 'status') {
      const stdout = workloads.get(args.at(-1)!);
      return stdout
        ? { stdout }
        : { exitCode: 1, combined: 'Workload not found' };
    }
    if (args[0] === 'logs') return { stdout: EGRESS_LOG };
    return {};
  };
}

/**
 * The hosted API behind a Deployment with a named Secret: each create or
 * upgrade starts a Pod on the Secret's current token, whose log carries its
 * digest; a non-forced delete is refused while the Deployment exists.
 * `stale` keeps the first value, `leak` puts it in the status, `allowDelete`
 * accepts the in-use delete, `noLogGrant` refuses `logs` as an API whose
 * ServiceAccount lacks `get pods/log`.
 */
function secretAnswer(
  options: {
    stale?: boolean;
    leak?: boolean;
    allowDelete?: boolean;
    noLogGrant?: boolean;
  } = {},
) {
  let token: string | undefined;
  let podToken: string | undefined;
  let pod = 0;
  let deleted = false;
  const status = () =>
    JSON.stringify({
      ...JSON.parse(
        deploymentJson(`pod-${pod}`, undefined, deleted ? 5 : null),
      ),
      secretNames: [NAMES.secret('hosted')],
      ...(options.leak ? { command: [podToken] } : {}),
    });
  return (args: readonly string[]): object => {
    const verb = args.slice(0, 2).join(' ');
    if (verb === 'secrets new') {
      token = args[3].startsWith('SERVE_SECRET_TOKEN=')
        ? args[3].split('=')[1]
        : undefined;
    } else if (verb === 'deployment create' || verb === 'deployment upgrade') {
      pod += 1;
      if (!options.stale || pod === 1) podToken = token;
    } else if (verb === 'deployment delete') {
      deleted = true;
    } else if (verb === 'deployment status') {
      return { stdout: status() };
    } else if (args[0] === 'logs' && options.noLogGrant) {
      return {
        exitCode: 1,
        combined:
          'Could not reach the cluster of Deployment dep-1: cluster c-1: the registered identity lacks permissions node pools and Services need: get pods/log in node pool namespaces.',
      };
    } else if (args[0] === 'logs') {
      const line = podToken
        ? `SECRET_SHA256 ${createHash('sha256').update(podToken).digest('hex')}\n`
        : '';
      return { stdout: `${line}RECEIVE_STARTED {}\n` };
    } else if (verb === 'secrets delete' && !deleted && !options.allowDelete) {
      return {
        exitCode: 1,
        combined: `Secret "${NAMES.secret('hosted')}" is in use by 1 non-terminal workload(s) or Deployment(s): dep-1.`,
      };
    }
    return {};
  };
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

/** A stage whose Service status reads as published at 203.0.113.7. */
function publishedStage(extra: Partial<HostedStageOptions>) {
  return stage(
    (args) => ({
      stdout: JSON.stringify({
        workload: makeStatusWorkloadMetadata({
          id: args.at(-1)!,
          state: WorkloadState.Running,
          dnsRecordId: 'dns-1',
          publicEndpoint: {
            ip: '203.0.113.7',
            state: 'published',
            error: null,
          },
        }),
        events: [],
        status: '-',
      }),
    }),
    [],
    pollsWaiter(3),
    undefined,
    undefined,
    extra,
  );
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
  gpu: HostedStageOptions['gpu'] = false,
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
      pool: { region: 'us-east-2', vmTypes: ['t3.small'] },
      gpu,
      service: { image: 'nginx:1.27', port: 80 },
      receiverImage: async () => RECEIVER,
      redactor: { add: vi.fn() },
      token: 'harness-token',
      timeouts: {
        nodePoolMs: 30_000,
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

  test('every name and workload ID the stage creates passes the product validation', async () => {
    const { pool, receiver, ...workloads } = ID;
    for (const id of Object.values(workloads).flat()) {
      await expect(validateId(id)).resolves.toBe(id);
    }
    createNodePoolInputSchema.shape.name.parse(pool);
    createDeploymentInputSchema.shape.name.parse(receiver);
  });

  test('drives the operator walk and the node pool against the hosted API; only api use runs on the installer target', async () => {
    const users: (typeof OCTOCAT)[] = [];
    const { hosted, calls } = stage(
      (args) =>
        accessAnswer(args, users) ??
        (args[0] === 'node-pool'
          ? { stdout: READY_POOL }
          : { combined: 'Saved to api-url' }),
    );
    await hosted.operatorWalk();
    // Recorded for the sweeps as soon as it exists: after the create, before
    // the first ready poll.
    const recorded: string[][] = [];
    expect(
      await hosted.createReadyNodePool((id) =>
        recorded.push([
          id,
          ...calls.slice(-1).map((c) => c.args.slice(0, 2).join(' ')),
        ]),
      ),
    ).toBe('np-1');
    expect(recorded).toEqual([['np-1', 'node-pool create']]);
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
      ['node-pool', 'create', '--credentials', HOSTED_URL],
      ['node-pool', 'status', '--json', HOSTED_URL],
    ]);
    expect(calls[4].args).toEqual(['api', 'access', 'add', 'anycloud-sh']);
    expect(users).toEqual([]);
    expect(calls[0].args).toEqual(['api', 'use', HOSTED_URL]);
    expect(calls[7].args).toEqual(
      expect.arrayContaining(['--credentials', 'aws-test', '--min-vms', '1']),
    );
  });

  test('runs a Lambda GPU pool on two VMs of its type list, and its Deployment takes the GPU', async () => {
    const lambda: HostedStageOptions['credential'] = {
      name: 'lambda-test',
      material: { cloudProvider: CloudType.Lambda, apiKey: 'L' },
    };
    const jobs = poolJobsAnswer({ gpuCount: 1 });
    const { hosted, calls } = stage(
      (args) => (args[0] === 'node-pool' ? { stdout: READY_POOL } : jobs(args)),
      [],
      undefined,
      false,
      lambda,
      {
        pool: {
          region: 'us-east-1',
          vmTypes: ['gpu_1x_a10', 'gpu_1x_a100_sxm4'],
        },
      },
    );
    await hosted.createReadyNodePool(() => undefined);
    // The Service and one Deployment each take a Node's GPU.
    expect(calls[0]!.args).toEqual(
      expect.arrayContaining([
        '--vm-type',
        'gpu_1x_a10',
        '--vm-type',
        'gpu_1x_a100_sxm4',
        '--min-vms',
        '2',
        '--max-vms',
        '5',
      ]),
    );
    await expect(hosted.poolJobs('np-1')).resolves.toMatchObject({
      podUid: 'pod-1',
    });
  });

  test('saves an Azure pool credential into the hosted API with its Azure fields', async () => {
    const users: (typeof OCTOCAT)[] = [];
    const { hosted, calls } = stage(
      (args) => accessAnswer(args, users) ?? { combined: 'Saved' },
      [],
      undefined,
      'mace',
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
      false,
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

  test('on a GCP pool the released CLI also saves the cluster credential, which lists the backups', async () => {
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
      false,
      {
        name: 'gcp-test',
        material: {
          cloudProvider: CloudType.GCP,
          projectId: 'p-1',
          clientEmail: 'sa@p-1.iam.gserviceaccount.com',
          privateKey: 'KEY',
        },
      },
      {
        fromRelease: { cli: { run } },
        backup: {
          credential: {
            name: 'aws-test',
            material: {
              cloudProvider: CloudType.AWS,
              accessKeyId: 'AKIA',
              secretAccessKey: 'secret',
            },
          },
          region: 'us-east-2',
        },
      },
    );
    await built.hosted.operatorWalk();
    expect(
      released.filter((args) => args[1] === 'new').map((args) => args.at(-1)),
    ).toEqual(['gcp-test', 'aws-test']);
    const lists = built.calls.filter(
      (call) => call.args[0] === 'bucket' && call.args[1] === 'list',
    );
    expect(lists).toHaveLength(2);
    for (const { args } of lists) {
      expect(args.join(' ')).toContain(
        '--credentials aws-test --region us-east-2',
      );
    }
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
      false,
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
        false,
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

  test('a Job on the pool completes and a cancelled one is cleaned up by the receiver, both on one observed Pod; the Deployment is deleted before the pool', async () => {
    const { hosted, calls, cleanup, artifacts } = stage(poolJobsAnswer());
    await expect(hosted.poolJobs('np-1')).resolves.toEqual({
      deploymentId: 'dep-1',
      podUid: 'pod-1',
      egress: EGRESS,
      completedJobId: ID.complete,
      claimMs: 3,
      imagePull: PULL,
      cancelledJobId: ID.hold,
    });
    const verbs = calls.map((call) => call.args.slice(0, 2).join(' '));
    expect(calls.every((call) => call.apiUrl === HOSTED_URL)).toBe(true);
    expect(calls[0].args).toEqual([
      'deployment',
      'create',
      '--node-pool',
      'np-1',
      '--env',
      `E2E_COMPLETE_JOB_IDS=${[ID.complete, ID.loss, ...ID.upgrades].join()}`,
      '--env',
      `E2E_FRESH_REPLICA_COMPLETE_JOB_IDS=${ID.session}`,
      '--env',
      'E2E_EGRESS_PROBE=1',
      '--json',
      ID.receiver,
      RECEIVER,
    ]);
    const jobs = calls.filter((call) => call.args[0] === 'job');
    expect(jobs.map((call) => call.args)).toEqual([
      ['job', '--deployment', ID.receiver, '--id', ID.complete],
      ['job', '--deployment', ID.receiver, '--id', ID.hold],
    ]);
    // Only the held Job is terminated, and before the Deployment goes.
    expect(verbs).not.toContain(`terminate ${ID.complete}`);
    expect(verbs.indexOf(`terminate ${ID.hold}`)).toBeLessThan(
      verbs.indexOf('deployment delete'),
    );
    expect(artifacts.json).toHaveBeenCalledWith(
      'hosted-pool-jobs',
      expect.anything(),
    );
    expect(cleanup.observations()).toEqual([
      { label: `hosted Deployment ${ID.receiver}`, completed: true },
      { label: `hosted Job ${ID.complete}`, completed: true },
      { label: `hosted Job ${ID.hold}`, completed: true },
    ]);
  });

  test("a dropped kubelet Event leaves the record without the replica's pull instead of failing the round", async () => {
    const { hosted } = stage(poolJobsAnswer({ eventDropped: true }));
    const record = await hosted.poolJobs('np-1');
    expect(record).toMatchObject({ completedJobId: ID.complete });
    expect(record).not.toHaveProperty('imagePull');
  });

  test.each([
    [
      'the receiver never acknowledges the cancellation',
      { acknowledge: false },
      `hosted Job ${ID.hold} to be cleaned up`,
    ],
    [
      'the receiver errors the held Job instead of observing its cancellation',
      { cancelled: WorkloadState.Errored },
      'Job ended errored',
    ],
    [
      'another Pod reports the released Jobs',
      { podAfterJobs: 'pod-2' },
      'the Jobs left the observed Pod pod-1',
    ],
  ])('the pool Jobs fail when %s', async (_name, options, error) => {
    const { hosted } = stage(poolJobsAnswer(options), [], pollsWaiter(3));
    await expect(hosted.poolJobs('np-1')).rejects.toThrow(error);
  });

  test('a Deployment Secret reaches each Pod a create or upgrade starts, never shows its value, and only deletes once the Deployment is gone', async () => {
    const secret = NAMES.secret('hosted');
    const deployment = NAMES.deployment('secret');
    const { hosted, calls, cleanup } = stage(secretAnswer());
    await expect(hosted.deploymentSecret('np-1')).resolves.toEqual([
      'pod-1',
      'pod-2',
      'pod-3',
    ]);
    const steps = calls
      .map((call) => call.args.slice(0, 2).join(' '))
      .filter((verb) => !/status|^logs/u.test(verb));
    expect(steps).toEqual([
      'secrets new',
      'deployment create',
      'secrets delete',
      'secrets new',
      'deployment upgrade',
      'secrets new',
      'deployment upgrade',
      'deployment delete',
      'secrets delete',
    ]);
    expect(calls[1].args).toEqual(
      expect.arrayContaining(['--secret', secret, deployment, RECEIVER]),
    );
    expect(calls.at(-1)!.args).toEqual(['secrets', 'delete', secret]);
    expect(cleanup.observations()).toEqual([
      { label: `hosted Secret ${secret}`, completed: true },
      { label: `hosted Deployment ${deployment}`, completed: true },
    ]);
  });

  test.each([
    [
      'a Pod keeps the old value',
      { stale: true },
      'no digest of the rotated value',
    ],
    ['the status shows the value', { leak: true }, 'and the value'],
    [
      'an in-use delete is accepted',
      { allowDelete: true },
      'Command unexpectedly succeeded',
    ],
    [
      'the ServiceAccount may not read Pod logs',
      { noLogGrant: true },
      "the hosted API's ServiceAccount may not read Pod logs",
    ],
  ])(
    'the Deployment Secret stage fails when %s',
    async (_name, options, error) => {
      const { hosted } = stage(secretAnswer(options), [], pollsWaiter(3));
      await expect(hosted.deploymentSecret('np-1')).rejects.toThrow(error);
    },
  );

  test('on a GPU pool the receiver proves its device and runs MACE, a canary Job errors with the CUDA energy, and the Deployment is kept for host loss', async () => {
    const { hosted, calls } = stage(
      poolJobsAnswer({ gpuCount: 1 }),
      [],
      undefined,
      'mace',
    );
    const jobs = await hosted.poolJobs('np-1', true);
    expect(jobs).toMatchObject({
      maceCanary: {
        jobId: ID.canary,
        geometry: 'b',
        device: 'Tesla T4',
        energyEv: -2079.8651234,
        claimMs: 5,
      },
    });
    // `complete` was claimed while the model loaded: not a warm claim.
    expect(jobs).not.toHaveProperty('claimMs');
    expect(calls[0].args).toEqual([
      'deployment',
      'create',
      '--node-pool',
      'np-1',
      '--env',
      `E2E_COMPLETE_JOB_IDS=${[ID.complete, ID.loss, ...ID.upgrades].join()}`,
      '--env',
      `E2E_FRESH_REPLICA_COMPLETE_JOB_IDS=${ID.session}`,
      '--env',
      'E2E_EGRESS_PROBE=1',
      '--env',
      'E2E_REQUIRE_GPU=1',
      '--env',
      'E2E_WORKLOAD_PROFILE=mace-cuda',
      '--env',
      `E2E_MACE_CANARY_JOB_IDS=${ID.canary}`,
      '--json',
      ID.receiver,
      RECEIVER,
    ]);
    expect(
      calls.filter((call) => call.args[0] === 'job').map((call) => call.args),
    ).toEqual([
      ['job', '--deployment', ID.receiver, '--id', ID.complete],
      ['job', '--deployment', ID.receiver, '--id', ID.canary],
      ['job', '--deployment', ID.receiver, '--id', ID.hold],
    ]);
    expect(calls.map((call) => call.args.slice(0, 2).join(' '))).not.toContain(
      'deployment delete',
    );
  });

  test.each([
    [
      'MACE did not run',
      'GPU receiver runs without the MACE profile',
      'errored without its check',
    ],
    [
      'MACE failed to load',
      'MACE failed to load: MACE Deployment requires a visible CUDA device',
      'errored without its check',
    ],
    [
      'the energy is not the CPU reference',
      'MACE a energy -2079.9 eV on Tesla T4 differs from reference -2078.8651274 eV',
      'is not its CPU reference',
    ],
  ])('the GPU pool Jobs fail when %s', async (_name, canaryMessage, error) => {
    const { hosted } = stage(
      poolJobsAnswer({ gpuCount: 1, canaryMessage }),
      [],
      undefined,
      'mace',
    );
    await expect(hosted.poolJobs('np-1', true)).rejects.toThrow(error);
  });

  test('the voice workload admits two held sessions of three, releases a slot to the third on cancel, and reads a checked canary', async () => {
    const { hosted, calls } = stage(
      poolJobsAnswer({ gpuCount: 1 }),
      [],
      pollsWaiter(20),
      'voice',
    );
    await expect(hosted.poolJobs('np-1', true)).resolves.toMatchObject({
      cancelledJobId: ID.holds[0],
      voiceCanary: {
        jobId: ID.voiceCanary,
        device: 'Tesla T4',
        distance: 0.0491,
        modelLoadId: 'load-1',
        claimMs: 5,
        firstChunkMs: 830,
        rtf: 0.475,
      },
      voiceSessions: {
        heldJobIds: ID.holds.slice(0, 2),
        queuedJobId: ID.holds[2],
        besideCanary: {
          jobId: ID.voiceCanary2,
          modelLoadId: 'load-1',
          claimMs: 5,
        },
      },
    });
    expect(calls[0].args).toEqual([
      'deployment',
      'create',
      '--node-pool',
      'np-1',
      '--env',
      `E2E_COMPLETE_JOB_IDS=${[ID.complete, ID.loss, ...ID.upgrades].join()}`,
      '--env',
      `E2E_FRESH_REPLICA_COMPLETE_JOB_IDS=${ID.session}`,
      '--env',
      'E2E_EGRESS_PROBE=1',
      '--env',
      'E2E_REQUIRE_GPU=1',
      '--env',
      'E2E_WORKLOAD_PROFILE=voice',
      '--env',
      `E2E_VOICE_CANARY_JOB_IDS=${ID.voiceCanary},${ID.voiceCanary2}`,
      '--max-concurrent-jobs-per-replica',
      '2',
      '--json',
      ID.receiver,
      RECEIVER,
    ]);
    expect(
      calls
        .filter((call) => call.args[0] === 'job')
        .map((call) => call.args.at(-1)),
    ).toEqual([ID.complete, ID.voiceCanary, ...ID.holds, ID.voiceCanary2]);
    expect(
      calls
        .filter((call) => call.args[0] === 'terminate')
        .map((call) => call.args[1]),
    ).toEqual([ID.holds[0], ID.holds[2], ID.holds[1]]);
  });

  test.each([
    [
      'the Deployment runs a third session at once',
      { admitsThree: true },
      'two of three held voice sessions to run: timed out',
    ],
    [
      'the canary is not its reference',
      {
        canaryMessage: VOICE_CANARY_MESSAGE.replace('0.0491', '0.147'),
      },
      "the voice canary's audio is not its reference",
    ],
    [
      'the canary beside a held session came from another model load',
      { besideMessage: VOICE_CANARY_MESSAGE.replace('load-1', 'load-2') },
      'the voice canaries came from different model loads: load-1 and load-2',
    ],
    [
      'the canary beside a held session is not its reference',
      { besideMessage: VOICE_CANARY_MESSAGE.replace('0.0491', '0.147') },
      "the voice canary's audio is not its reference",
    ],
    [
      'the voice model failed to load',
      { canaryMessage: 'voice failed to load: no CUDA device' },
      'the voice canary errored without its check',
    ],
  ])('the voice workload fails when %s', async (_name, options, error) => {
    const { hosted } = stage(
      poolJobsAnswer({ gpuCount: 1, ...options }),
      [],
      pollsWaiter(20),
      'voice',
    );
    await expect(hosted.poolJobs('np-1', true)).rejects.toThrow(error);
  });

  test.each([false, true])(
    'two replicas recover one session and reject both retrying (both=%s)',
    async (bothRetry) => {
      const ids = ['replica-loss-a', 'replica-loss-b'].map((suffix) =>
        NAMES.workload(suffix),
      );
      const base = poolJobsAnswer({ gpuCount: 1 });
      const cancelled = new Set<string>();
      let lost = false;
      const built = stage(
        (args) => {
          if (args[0] === 'terminate') cancelled.add(args[1]);
          if (args[0] === 'node-pool' && args[1] === 'status') {
            const pool = JSON.parse(READY_POOL);
            pool.capacity.readyVmCount = 2;
            return { stdout: JSON.stringify(pool) };
          }
          const index = args[0] === 'status' ? ids.indexOf(args.at(-1)!) : -1;
          if (index >= 0 && !cancelled.has(ids[index])) {
            const status = JSON.parse(
              statusJson(ids[index], WorkloadState.Running),
            );
            const event = (
              state: WorkloadState,
              metadata: object,
              n: number,
            ) => ({
              id: n,
              workloadId: ids[index],
              state,
              metadata,
              createdAt: n,
            });
            status.events = [
              event(WorkloadState.Running, { podUid: `pod-${index}` }, 1),
            ];
            if (lost && (index === 0 || bothRetry))
              status.events.push(
                event(WorkloadState.Retrying, { reason: 'replica lost' }, 2),
                event(
                  WorkloadState.Running,
                  { podUid: `replacement-${index}` },
                  3,
                ),
              );
            return { stdout: JSON.stringify(status) };
          }
          return base(args);
        },
        [],
        pollsWaiter(5),
        'voice',
        undefined,
        { replicas: 2 },
      );
      await built.hosted.poolJobs('np-1', true);
      await built.hosted.startReplicaLossSessions();
      lost = true;
      const result = built.hosted.poolJobAfterHostLoss('np-1', 'pod-0');
      if (bothRetry) await expect(result).rejects.toThrow('timed out');
      else {
        await expect(result).resolves.toMatchObject({
          podUid: 'replacement-0',
          jobId: ID.loss,
        });
        expect(cancelled).toEqual(new Set([ID.hold, ...ids]));
        expect(built.artifacts.json).toHaveBeenCalledWith(
          'two-replica-host-loss',
          expect.objectContaining({
            before: [
              [ids[0], 'pod-0'],
              [ids[1], 'pod-1'],
            ],
          }),
        );
      }
    },
  );

  test('the voice tolerance and minimum length match the receiver', () => {
    const fixture = readFileSync(
      new URL(
        '../integration/e2e/internal/fixtures/voice_session.py',
        import.meta.url,
      ),
      'utf8',
    );
    expect(fixture).toMatch(/^TOLERANCE = 0\.1$/mu);
    expect(fixture).toMatch(/^MIN_SECONDS = 2\.0$/mu);
    expect(VOICE_TOLERANCE).toBe(0.1);
  });

  test('the canary offset and tolerance match the receiver', () => {
    const fixture = readFileSync(
      new URL(
        '../integration/e2e/internal/fixtures/mace_inference.py',
        import.meta.url,
      ),
      'utf8',
    );
    expect(fixture).toMatch(/^CANARY_OFFSET_EV = 1\.0$/mu);
    expect(fixture).toMatch(/^TOLERANCE_EV = 1e-5$/mu);
    expect(MACE_CANARY_OFFSET_EV).toBe(1);
  });

  test.each([
    [
      'a GPU pool admitted without a GPU',
      'mace' as const,
      0,
      'admitted with 0 GPUs',
    ],
    [
      'a CPU pool admitted with a GPU',
      false as const,
      1,
      'admitted with 1 GPUs',
    ],
  ])('the pool Jobs fail for %s', async (_name, gpu, gpuCount, error) => {
    const { hosted, calls } = stage(
      poolJobsAnswer({ gpuCount }),
      [],
      undefined,
      gpu,
    );
    await expect(hosted.poolJobs('np-1')).rejects.toThrow(error);
    expect(calls.some((call) => call.args[0] === 'job')).toBe(false);
  });

  /** The session's status once it was retried from `pod-1` onto `onto`. */
  const retriedSession = (onto: string, reason?: string) =>
    JSON.stringify({
      workload: makeStatusWorkloadMetadata({
        id: ID.session,
        state: WorkloadState.Completed,
        cleanedAt: 4,
      }),
      events: [
        { state: WorkloadState.Running, metadata: { podUid: 'pod-1' } },
        ...(reason
          ? [{ state: WorkloadState.Retrying, metadata: { reason } }]
          : []),
        { state: WorkloadState.Running, metadata: { podUid: onto } },
        { state: WorkloadState.Completed, metadata: {} },
      ].map((event, index) => ({
        id: index + 1,
        workloadId: ID.session,
        createdAt: index + 1,
        ...event,
      })),
      status: '-',
    });
  const LOST = 'replica DeletionByPodGC: PodGC: node no longer exists';

  test('after host loss the session on the lost replica is retried and completes on the new Pod before one more Job runs there, then the Deployment is deleted', async () => {
    let pod = 'pod-1';
    const answer = poolJobsAnswer({ gpuCount: 1, pod: () => pod });
    const { hosted, calls, cleanup } = stage(
      (args) =>
        args[0] === 'status' && args.at(-1) === ID.session && pod === 'pod-2'
          ? { stdout: retriedSession('pod-2', LOST) }
          : answer(args),
      [],
      pollsWaiter(3),
      'mace',
    );
    const { podUid } = await hosted.poolJobs('np-1', true);
    const create = calls.find((call) => call.args[1] === 'create')!;
    expect(create.args).toContain(
      `E2E_FRESH_REPLICA_COMPLETE_JOB_IDS=${ID.session}`,
    );
    await expect(hosted.startReplicaLossSession()).resolves.toBe(ID.session);
    // The Pod on the lost host is still reported until the new one runs.
    await expect(
      hosted.poolJobAfterHostLoss('np-1', podUid, ID.session),
    ).rejects.toThrow('to run a new Pod');
    pod = 'pod-2';
    // The replacement is read while its Deployment still exists.
    let readAt = -1;
    await expect(
      hosted.poolJobAfterHostLoss('np-1', podUid, ID.session, async (uid) => {
        expect(uid).toBe('pod-2');
        readAt = calls.length;
      }),
    ).resolves.toEqual({
      podUid: 'pod-2',
      jobId: ID.loss,
      session: { jobId: ID.session, retryReason: LOST },
    });
    const verbs = calls.map((call) => call.args.slice(0, 2).join(' '));
    const submitted = calls
      .filter((call) => call.args[0] === 'job')
      .map((call) => call.args[call.args.indexOf('--id') + 1]);
    // The session runs before the Job that follows host loss is submitted.
    expect(submitted.slice(-2)).toEqual([ID.session, ID.loss]);
    expect(verbs.lastIndexOf('node-pool status')).toBeLessThan(
      verbs.lastIndexOf('job --deployment'),
    );
    expect(verbs.at(-2)).toBe('deployment delete');
    expect(verbs.slice(readAt)).toContain('deployment delete');
    expect(cleanup.observations().every((entry) => entry.completed)).toBe(true);
  });

  test.each([
    ['without a replica retry', retriedSession('pod-2')],
    ['onto another Pod', retriedSession('pod-9', LOST)],
  ])('host loss fails when the session completed %s', async (_name, status) => {
    let pod = 'pod-1';
    const answer = poolJobsAnswer({ gpuCount: 1, pod: () => pod });
    const { hosted } = stage(
      (args) =>
        args[0] === 'status' && args.at(-1) === ID.session && pod === 'pod-2'
          ? { stdout: status }
          : answer(args),
      [],
      pollsWaiter(3),
      'mace',
    );
    const { podUid } = await hosted.poolJobs('np-1', true);
    await hosted.startReplicaLossSession();
    pod = 'pod-2';
    await expect(
      hosted.poolJobAfterHostLoss('np-1', podUid, ID.session),
    ).rejects.toThrow('was not classified and retried onto Pod pod-2');
  });

  test('on a GPU pool the Service runs the device-gated server from the pinned glibc image', async () => {
    const { hosted, calls } = stage(
      (args) =>
        args[0] === 'service'
          ? { combined: `ID: ${ID.service}` }
          : { stdout: statusJson(args.at(-1)!, WorkloadState.Running) },
      [],
      undefined,
      'mace',
    );
    await hosted.runService('np-1');
    expect(calls[0].args).toEqual([
      'service',
      '--node-pool',
      'np-1',
      '--id',
      ID.service,
      '--env',
      'PORT=80',
      GPU_SERVICE_IMAGE,
      '--',
      ...GPU_SERVICE_COMMAND,
    ]);
  });

  test.each([
    ['serves a GPU line', 'GPU 0: Tesla T4 (UUID: GPU-1)\n', undefined],
    ['serves no GPU line', 'No devices were found\n', 'to answer'],
  ])(
    'the GPU Service evidence waits for its published record, then its URL %s',
    async (_name, body, error) => {
      let polls = 0;
      const { hosted } = stage(
        (args) => {
          polls += 1;
          const published = polls > 1;
          return {
            stdout: JSON.stringify({
              workload: makeStatusWorkloadMetadata({
                id: args.at(-1)!,
                state: WorkloadState.Running,
                dnsRecordId: published ? 'dns-1' : null,
                publicEndpoint: published
                  ? { ip: '203.0.113.7', state: 'published', error: null }
                  : null,
              }),
              events: [],
              status: '-',
            }),
          };
        },
        [
          { status: 502, body: 'Bad gateway' },
          { status: 200, body },
          { status: 200, body },
        ],
        pollsWaiter(3),
      );
      const devices = hosted.gpuServiceDevices(ID.service);
      if (error) await expect(devices).rejects.toThrow(error);
      else
        await expect(devices).resolves.toEqual([
          'GPU 0: Tesla T4 (UUID: GPU-1)',
        ]);
      expect(polls).toBe(2);
    },
  );

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

  test.each([
    [undefined, [], []],
    [
      'mace' as const,
      [`BASE_IMAGE=${MACE_RECEIVER_BASE_IMAGE}`, 'WORKLOAD_PROFILE=mace-cuda'],
      [],
    ],
    [
      'voice' as const,
      [
        'BASE_IMAGE=ghcr.io/anycloud-sh/api:0.0.3-receiver-voice-base',
        'WORKLOAD_PROFILE=voice',
      ],
      ['/repo/test/docker/Dockerfile.voice'],
    ],
  ])(
    'pins the pushed receiver by its registry digest (gpu workload %s)',
    async (gpu, buildArgs, baseFiles) => {
      const digest = `sha256:${'d'.repeat(64)}`;
      const run = vi.fn(async (_executable: string, args: readonly string[]) =>
        commandResultForTest({
          stdout:
            args[0] === 'inspect' ? `ghcr.io/anycloud-sh/api@${digest}\n` : '',
        }),
      );
      const image = await pushReceiverImage({
        runner: { run },
        projectRoot: '/repo',
        wheelDirectory: async () => 'python/dist/e2e-run1',
        tag: 'ghcr.io/anycloud-sh/api:0.0.3-receiver',
        ...(gpu ? { gpu } : {}),
      });
      expect(image).toBe(`ghcr.io/anycloud-sh/api:0.0.3-receiver@${digest}`);
      const builds = run.mock.calls
        .map(([, args]) => args)
        .filter((args) => args[0] === 'build');
      // The voice base is built first, locally, from its pinned sources.
      expect(
        builds.slice(0, -1).map((args) => args[args.indexOf('--file') + 1]),
      ).toEqual(baseFiles);
      const build = builds.at(-1)!;
      expect(
        build.filter((_arg, index) => build[index - 1] === '--build-arg'),
      ).toEqual(['ANYCLOUD_SDK_WHEEL_DIR=python/dist/e2e-run1', ...buildArgs]);
    },
  );

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

  test("a live check's own pool fails at its first capacity error, and waits through throttling; the journey's pool waits through both", async () => {
    const pool = (lastError: string) => {
      const answer = JSON.stringify({
        ...JSON.parse(READY_POOL),
        state: 'provisioning',
        lastError,
      });
      return stage(() => ({ stdout: answer }), [], pollsWaiter(3)).hosted;
    };
    const checkPool = (hosted: ReturnType<typeof pool>) =>
      hosted.checkPool(
        'gpu',
        { vmTypes: ['g4dn.12xlarge'], minVms: 1, maxVms: 1 },
        () => undefined,
      );
    const starved = pool(
      'Insufficient capacity. Try a different instance type or region.',
    );
    await expect(checkPool(starved)).rejects.toThrow(
      'node pool failed: Insufficient capacity',
    );
    await expect(starved.createReadyNodePool(() => undefined)).rejects.toThrow(
      'timed out',
    );
    await expect(
      checkPool(pool('vCPU limit exceeded. Request a quota increase.')),
    ).rejects.toThrow('node pool failed: vCPU limit exceeded');
    // AWS's RequestLimitExceeded is transient; the product retries it.
    await expect(checkPool(pool('Request limit exceeded.'))).rejects.toThrow(
      'timed out',
    );
  });

  test("a live check's privileged pool and Job pass their flags only when asked", async () => {
    const { hosted, calls } = stage(() => ({ stdout: READY_POOL }));
    const spec = { vmTypes: ['t3.large'], minVms: 1, maxVms: 1 };
    await hosted.checkPool('plain', spec, () => undefined);
    await hosted.checkPool(
      'priv',
      { ...spec, privilegedJobs: true },
      () => undefined,
    );
    const job = { image: 'python:3.12-slim', command: ['true'] };
    await hosted.checkJob('plain', 'np-1', job);
    await hosted.checkJob('priv', 'np-1', { ...job, privileged: true });
    const flagged = (verb: string, flag: string) =>
      calls
        .filter((c) => c.args.slice(0, 2).join(' ').startsWith(verb))
        .map((c) => c.args.includes(flag));
    expect(flagged('node-pool create', '--allow-privileged-jobs')).toEqual([
      false,
      true,
    ]);
    expect(flagged('job ', '--privileged')).toEqual([false, true]);
  });

  test('cleanup deletes the hosted pool and waits until it is gone before the deferred cluster destroy runs', async () => {
    const order: string[] = [];
    const { hosted, cleanup } = stage((args) => {
      if (args[0] === 'node-pool' && args[1] === 'status') {
        if (!order.includes('delete')) return { stdout: READY_POOL };
        order.push('status');
        // The pool lingers for one poll after the delete was accepted, as a
        // real pool does while its VM terminates (F run 15).
        return order.filter((step) => step === 'status').length > 1
          ? { exitCode: 1, combined: `Node pool "${args.at(-1)}" not found` }
          : { stdout: DELETING_POOL };
      }
      if (args[0] === 'node-pool' && args[1] === 'delete') {
        order.push('delete');
        return { stdout: READY_POOL };
      }
      return { stdout: READY_POOL };
    });
    cleanup.defer('cluster destroy', async () => {
      order.push('destroy');
    });
    await hosted.createReadyNodePool(() => undefined);
    order.length = 0;
    await cleanup.run();
    expect(order).toEqual(['delete', 'status', 'status', 'destroy']);
  });

  test('a fetch failed still fails the step with its own error, and its probes are recorded before the diagnostics', async () => {
    const { hosted, probes } = stage(() => ({
      exitCode: 1,
      combined: '✗ fetch failed',
    }));
    await expect(hosted.createReadyNodePool(() => undefined)).rejects.toThrow(
      'fetch failed',
    );
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

  test('a published Service URL is first looked up only once every authoritative nameserver answers its A record (run 41028695286)', async () => {
    const events: string[] = [];
    const hostname = `${ID.service}.anycloud.sh`;
    let observed = 0;
    const { hosted } = publishedStage({
      dns: {
        // A failed nameserver lookup, then one authority still on NXDOMAIN.
        observe: async (name) => {
          observed += 1;
          events.push(`authorities ${name}: poll ${observed}`);
          if (observed === 1) throw new Error('queryNs ESERVFAIL anycloud.sh');
          return dnsAnswers(
            name,
            observed === 2 ? ['present', 'absent'] : undefined,
          );
        },
      },
      http: {
        get: vi.fn(async (_label: string, url: URL) => {
          events.push(`GET ${url.href}`);
          return { status: 200, body: 'ok' };
        }) as never,
      },
    });
    await expect(hosted.publishedUrl(ID.service, () => true)).resolves.toEqual({
      url: new URL(`https://${hostname}/`),
      ip: '203.0.113.7',
      body: 'ok',
    });
    expect(events).toEqual([
      ...[1, 2, 3].map((poll) => `authorities ${hostname}: poll ${poll}`),
      `GET https://${hostname}/`,
    ]);
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

  test("a published Service URL that gets no HTTP answer keeps its error's code and probes its hostname once (run 40815323572)", async () => {
    const { hosted, probes } = publishedStage({
      http: {
        get: vi.fn(async () => {
          throw new Error('hosted-service request failed: fetch failed', {
            cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), {
              code: 'ENOTFOUND',
            }),
          });
        }) as never,
      },
    });
    await expect(hosted.publishedUrl(ID.service, () => true)).rejects.toThrow(
      'fetch failed (ENOTFOUND)',
    );
    await hosted.captureDiagnostics();
    expect(probes.filter((label) => label.startsWith(ID.service))).toEqual(
      [
        'getent',
        'doh',
        'edge',
        'dig-vpc-A',
        'dig-public-A',
        'dig-vpc-AAAA',
        'dig-public-AAAA',
      ].map((probe) => `${ID.service}-no-answer-${probe}`),
    );
  });

  test('before the upgrade, diagnostics read the released API with the released CLI (run 40815323572)', async () => {
    const released = vi.fn(async () =>
      commandResultForTest({ combined: 'diagnostic output' }),
    );
    const { hosted, calls } = stage(
      () => ({}),
      [],
      undefined,
      undefined,
      undefined,
      { fromRelease: { cli: { run: released } } },
    );
    await hosted.captureDiagnostics();
    expect(released).toHaveBeenCalledWith(
      ['api', 'status', '--json'],
      expect.anything(),
    );
    expect(calls).toEqual([]);
  });

  test("stages a check's input in objects under the edge's 100 MB cap, in one recursive upload (run 40815305387)", async () => {
    const sizes: number[] = [];
    const { hosted, calls, cleanup } = stage((args) => {
      const local = args.find((arg) => arg.includes('pool-check-input-'));
      if (args[1] === 'upload' && local)
        for (const file of readdirSync(local))
          sizes.push(statSync(path.join(local, file)).size);
      return {};
    });
    await hosted.stageInput(1_500_000_000);
    await cleanup.run();
    const uploads = calls.filter(({ args }) => args[1] === 'upload');
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.args).toContain('--recursive');
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100_000_000);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(1_500_000_000);
  });

  describe("a bucket call outlasts the CLI's own give-up after about 182 s (run 40934357557)", () => {
    const cliTimeout = (verb: string) => ({
      exitCode: 1,
      combined: `✗ ${verb} failed: The operation was aborted due to timeout`,
    });
    const rerunNow = new Waiter(new AbortController().signal, async () => {});
    const verbs = (calls: { args: string[] }[]) =>
      calls.filter((c) => c.args[0] === 'bucket').map((c) => c.args[1]);

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
      await hosted.stageInput(1);
      await cleanup.run();
      expect(verbs(calls)).toEqual([
        'create',
        'create',
        'create',
        'upload',
        'delete',
        'delete',
      ]);
      expect(cleanup.observations()).toEqual([
        { label: expect.stringMatching(/^check bucket /u), completed: true },
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
      await expect(hosted.stageInput(1)).rejects.toThrow(
        'denied this credential',
      );
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
        undefined,
        { cli: { run } },
      );
      try {
        await expect(hosted.stageInput(1)).rejects.toThrow(
          'aborted due to timeout',
        );
      } finally {
        vi.useRealTimers();
      }
      // Each run gets the time left; a 10 s pause separates them.
      expect(bounds).toEqual([900_000, 708_000, 516_000, 324_000, 132_000]);
    });
  });

  test('after the journey tore its objects down, the deferred cleanups are complete and never call the (gone) hosted API', async () => {
    let torn = false;
    const { hosted, cleanup, calls } = stage((args) => {
      if (torn) {
        // Run 17: the cluster is destroyed by then; the hosted API is gone.
        return { exitCode: 1, combined: '✗ fetch failed' };
      }
      if (args[0] === 'node-pool' && args[1] === 'status') {
        return calls.some((c) => c.args[1] === 'delete')
          ? { exitCode: 1, combined: `Node pool "${args.at(-1)}" not found` }
          : { stdout: READY_POOL };
      }
      return { stdout: READY_POOL };
    });
    const nodePoolId = await hosted.createReadyNodePool(() => undefined);
    await hosted.deleteNodePool(nodePoolId);
    expect(cleanup.observations()).toEqual([
      { label: `hosted node pool ${ID.pool}`, completed: true },
    ]);
    torn = true;
    const before = calls.length;
    await cleanup.run();
    expect(calls.length).toBe(before);
  });

  test('every hosted-API cleanup still owed runs before the cluster is deleted, so none reaches the gone API (run 40934349682)', async () => {
    let torn = false;
    const { hosted, cleanup, calls } = stage((args) => {
      if (torn) return { exitCode: 1, combined: 'HTTP 530' };
      if (args[0] === 'node-pool' && args[1] === 'status') {
        return calls.some((c) => c.args[1] === 'delete')
          ? { exitCode: 1, combined: `Node pool "${args.at(-1)}" not found` }
          : { stdout: READY_POOL };
      }
      return { stdout: READY_POOL };
    });
    // Torn down by the journey, then a check bucket the journey leaves.
    await hosted.deleteNodePool(
      await hosted.createReadyNodePool(() => undefined),
    );
    await hosted.stageInput(1);
    const before = calls.length;
    await hosted.settleCleanups();
    expect(calls.slice(before).map(({ args }) => args.slice(0, 2))).toEqual([
      ['bucket', 'delete'],
    ]);
    expect(cleanup.observations()).toEqual([
      { label: `hosted node pool ${ID.pool}`, completed: true },
      { label: expect.stringMatching(/^check bucket /u), completed: true },
    ]);
    torn = true;
    await cleanup.run();
    expect(calls).toHaveLength(before + 1);
  });

  test('a pool delete waits on a released CLI status that predates requireNestedVirtualization (from 0.1.72)', async () => {
    const { requireNestedVirtualization: _, ...released } =
      JSON.parse(READY_POOL);
    let deletes = 0;
    const { hosted } = stage((args) => {
      if (args[1] === 'delete') deletes += 1;
      if (args[1] !== 'status' || deletes === 0) return { stdout: READY_POOL };
      return {
        stdout: JSON.stringify({
          ...released,
          state: WorkloadState.Terminated,
          releasing: false,
        }),
      };
    });
    await hosted.deleteNodePool(
      await hosted.createReadyNodePool(() => undefined),
    );
    expect(deletes).toBe(1);
  });

  test('a pool delete that times out is not waited on again by its cleanup', async () => {
    const { hosted, cleanup, calls } = stage(
      (args) =>
        args[1] === 'status' && calls.some((c) => c.args[1] === 'delete')
          ? { stdout: DELETING_POOL }
          : { stdout: READY_POOL },
      [],
      pollsWaiter(2),
    );
    const nodePoolId = await hosted.createReadyNodePool(() => undefined);
    await expect(hosted.deleteNodePool(nodePoolId)).rejects.toThrow(
      'state terminated (releasing)',
    );
    const before = calls.length;
    await cleanup.run();
    expect(calls.length).toBe(before);
  });

  test.each([
    ['claims each Job once and raises nothing', '', undefined],
    [
      'fails on an SDK error raised through the upgrade',
      'next_job retrying after 503\n',
      'raised 1 SDK errors',
    ],
  ])(
    'the kept receiver %s while the API upgrades',
    async (_name, raised, failure) => {
      const created: string[] = [];
      let logReads = 0;
      const pool = poolJobsAnswer();
      // Generation 1 before the upgrade, 2 once it runs and still 2 after.
      let statusReads = 0;
      const { hosted } = releaseStage(
        (args, bumpBackups) => {
          if (args[0] === 'api' && args[1] === 'upgrade') {
            bumpBackups();
            return { combined: startedOutput(1) };
          }
          const access = accessAnswer(args, []);
          if (access) return access;
          if (args[0] === 'job') created.push(args[args.indexOf('--id') + 1]);
          if (args[0] !== 'logs') return pool(args);
          logReads += 1;
          const work = created.map(
            (id) =>
              `WORK_STARTED {"executionId": "e", "jobId": "${id}"}\ncompleted:${id}\n`,
          );
          return {
            // The first read is poolJobs' egress probe, the second the baseline.
            stdout: `${EGRESS_LOG}RECEIVE_STARTED {}\n${logReads > 2 ? raised : ''}${work.join('')}`,
          };
        },
        {
          status: () =>
            statusOutput(1, undefined, null, statusReads++ === 0 ? 1 : 2),
        },
      );
      await hosted.poolJobs('np-1', true);
      const released = hosted.releaseUnderLoad(B);
      if (failure) {
        await expect(released).rejects.toThrow(failure);
        return;
      }
      const record = await released;
      expect(created.slice(-3)).toEqual(ID.upgrades);
      expect(record.health).toMatchObject({ failed: 0 });
    },
  );

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
    await expect(hosted.deleteNodePool('np-1')).rejects.toThrow(combined);
  });

  test('permanent status failures abort with their original reason', async () => {
    const { hosted, calls } = stage((args) =>
      args[0] === 'status'
        ? { exitCode: 1, combined: 'HTTP 403 forbidden' }
        : { combined: `ID: ${ID.service}` },
    );
    await expect(hosted.runService('np-1')).rejects.toThrow(
      'HTTP 403 forbidden',
    );
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
  const configuration = {
    hostedStage: true,
    gpuPool: false,
    alternateImage: B as string | undefined,
    poolProvider: 'aws',
    poolRegion: 'us-east-2',
    poolVmType: 't3.small',
    clusterRegion: 'us-east-2',
  };
  const gpu = {
    ...configuration,
    hostedStage: false,
    gpuPool: true,
    alternateImage: undefined,
    poolVmType: 'g4dn.xlarge',
  };

  test('resolves the journey from the flags', () => {
    // Neither flag: the default journey, through the hosted API too.
    expect(
      assertHostedStageConfiguration({
        ...configuration,
        hostedStage: false,
        alternateImage: undefined,
      }),
    ).toEqual({ pool: true });
    expect(assertHostedStageConfiguration(configuration)).toEqual({
      alternateImage: B,
      recursion: true,
    });
    // A GCP, Azure or Lambda pool, in its own region, without the
    // recursive VM Jobs no native sweep would see.
    for (const [poolProvider, poolRegion] of [
      ['gcp', 'us-central1'],
      ['azure', 'westus2'],
      ['lambda', 'us-east-1'],
    ]) {
      expect(
        assertHostedStageConfiguration({
          ...configuration,
          poolProvider: poolProvider!,
          poolRegion: poolRegion!,
        }),
      ).toEqual({ alternateImage: B, recursion: false });
    }
    expect(assertHostedStageConfiguration(gpu)).toEqual({ gpuPool: true });
    // An Azure GPU pool runs in its own region, not the cluster's.
    expect(
      assertHostedStageConfiguration({
        ...gpu,
        poolProvider: 'azure',
        poolRegion: 'westus2',
        poolVmType: 'Standard_NC4as_T4_v3',
      }),
    ).toEqual({ gpuPool: true });
    expect(
      assertHostedStageConfiguration({
        ...gpu,
        poolProvider: 'gcp',
        poolRegion: 'us-east4',
        poolVmType: 'g2-standard-4',
      }),
    ).toEqual({ gpuPool: true });
    // RFC 0043 S14 runs in the release journey: the GPU journey refuses Lambda.
    expect(() =>
      assertHostedStageConfiguration({
        ...gpu,
        poolProvider: 'lambda',
        poolRegion: 'us-east-1',
      }),
    ).toThrow(
      'E2E_CLUSTER_GPU_POOL runs its node pool on AWS, Azure or GCP, not lambda',
    );
  });

  test('saves a GCP or Lambda pool credential into the hosted API', () => {
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

  test('reads the replica egress probe and holds it to K5 policy', () => {
    const line = (probe: object) =>
      `RECEIVE_STARTED {}\nEGRESS_PROBE ${JSON.stringify(probe)}\n`;
    const gcp = {
      nameservers: ['169.254.169.254'],
      apiHostResolved: true,
      metadataHttp: 'denied',
      metadataError: 'ECONNREFUSED',
    };
    const evidence = {
      nameservers: gcp.nameservers,
      metadataError: 'ECONNREFUSED',
    };
    expect(egressProbeEvidence(line(gcp), CloudType.GCP)).toEqual(evidence);
    // Train 6: a GCP Node's resolv.conf named the metadata server twice.
    expect(
      egressProbeEvidence(
        line({ ...gcp, nameservers: ['169.254.169.254', '169.254.169.254'] }),
        CloudType.GCP,
      ),
    ).toEqual({
      ...evidence,
      nameservers: ['169.254.169.254', '169.254.169.254'],
    });
    // Lambda records whatever its Node resolves through.
    const lambda = { ...gcp, nameservers: ['8.8.8.8'] };
    expect(egressProbeEvidence(line(lambda), CloudType.Lambda)).toEqual({
      ...evidence,
      nameservers: ['8.8.8.8'],
    });
    // Azure resolves through the WireServer, whose other ports refuse.
    const wireServerErrors = { '80': 'timeout', '32526': 'timeout' };
    const azure = { ...gcp, nameservers: ['168.63.129.16'], wireServerErrors };
    expect(egressProbeEvidence(line(azure), CloudType.Azure)).toEqual({
      ...evidence,
      nameservers: ['168.63.129.16'],
      wireServerErrors,
    });
    expect(() =>
      egressProbeEvidence(
        line({
          ...azure,
          wireServerErrors: { ...wireServerErrors, '32526': '' },
        }),
        CloudType.Azure,
      ),
    ).toThrow('reached the Azure WireServer on port 32526');
    expect(() => egressProbeEvidence(line(lambda), CloudType.Azure)).toThrow(
      'logged no WireServer probe',
    );
    // On GCP the metadata server is the resolver: the deny's own control.
    expect(() => egressProbeEvidence(line(lambda), CloudType.GCP)).toThrow(
      'not only the metadata server 169.254.169.254',
    );
    expect(() =>
      egressProbeEvidence(
        line({ ...gcp, metadataHttp: 'reachable', metadataError: '' }),
        CloudType.GCP,
      ),
    ).toThrow('reached the instance metadata HTTP port');
    expect(() =>
      egressProbeEvidence(
        line({ ...gcp, apiHostResolved: false }),
        CloudType.GCP,
      ),
    ).toThrow(
      'could not resolve the workload API host through 169.254.169.254',
    );
    expect(() =>
      egressProbeEvidence('RECEIVE_STARTED {}\n', CloudType.AWS),
    ).toThrow('no EGRESS_PROBE line');
  });

  test.each([
    [
      configuration,
      { alternateImage: undefined },
      'needs E2E_CLUSTER_ALTERNATE_IMAGE',
    ],
    [
      configuration,
      { poolProvider: 'oci' },
      'E2E_CLUSTER_HOSTED_STAGE runs its node pool on AWS, Azure, GCP or Lambda, not oci',
    ],
    [
      configuration,
      { poolRegion: 'us-west-2' },
      'requires the pool and recursive Jobs in E2E_CLUSTER_REGION',
    ],
    [
      gpu,
      { hostedStage: true },
      'E2E_CLUSTER_GPU_POOL and E2E_CLUSTER_HOSTED_STAGE are separate journeys',
    ],
    [
      gpu,
      { poolProvider: 'gcp', poolVmType: 'g2-standard-24' },
      'exactly one NVIDIA GPU, not g2-standard-24 on gcp',
    ],
    [
      gpu,
      { poolProvider: 'azure', poolVmType: 'Standard_D2s_v5' },
      'exactly one NVIDIA GPU, not Standard_D2s_v5 on azure',
    ],
    [
      gpu,
      { poolRegion: 'us-west-2' },
      'E2E_CLUSTER_GPU_POOL requires the pool in E2E_CLUSTER_REGION',
    ],
    [gpu, { poolVmType: 't3.small' }, 'exactly one NVIDIA GPU, not t3.small'],
    [
      gpu,
      { poolVmType: 'g4dn.12xlarge' },
      'exactly one NVIDIA GPU, not g4dn.12xlarge',
    ],
  ])(
    'rejects unsupported hosted composition %j + %j before admission',
    (base, override, reason) => {
      expect(() => assertHostedStageConfiguration(base)).not.toThrow();
      expect(() =>
        assertHostedStageConfiguration({ ...base, ...override }),
      ).toThrow(reason);
    },
  );

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
    [
      'node pool create',
      (h: HostedApiStage) => h.createReadyNodePool(() => undefined),
    ],
    ['Service create', (h: HostedApiStage) => h.runService('np-1')],
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

  describe('0043/S1, S6 and S13: a bucketed Job on an Azure pool', () => {
    const azure = { name: 'azure-test', material: TEST_AZURE_CRED };
    const JOB = NAMES.workload('storage');
    /** The hosted API's containers, behind its `bucket` verbs. */
    const blobs = new Map<string, Map<string, string>>();
    /** S13: the Pods the stage deleted; the first loss completes the retry. */
    const lost: string[] = [];
    beforeEach(() => {
      blobs.clear();
      lost.length = 0;
    });
    /**
     * The CLI answers, with containers in `blobs`; the Job's upload is
     * `upload` applied to the output container admission created.
     */
    const azureStage = (
      upload: (output: Map<string, string>) => void,
      log = 'STORAGE_PROBE_DONE\n',
      refuseDelete?: string,
      pool: {
        cloud?: 'lambda' | 'aws';
        spot?: boolean;
        /** S16: an AWS spot pool's managed bucket in Azure. */
        azureCheckpoint?: boolean;
      } = {},
    ) => {
      const spot = pool.spot ?? false;
      return stage(
        (args) => {
          const [name, a, b] = args.slice(-3);
          const last = args.at(-1)!;
          if (args[0] === 'bucket') {
            switch (args[1]) {
              case 'create':
                blobs.set(last, new Map());
                return {};
              case 'upload':
                blobs.get(name!)!.set(b!, readFileSync(a!, 'utf8'));
                return {};
              case 'download':
                writeFileSync(b!, blobs.get(name!)!.get(a!)!);
                return {};
              case 'list':
                if (!blobs.has(last)) {
                  return { exitCode: 1, combined: `Bucket not found: ${last}` };
                }
                return {
                  stdout: JSON.stringify({
                    entries: [...blobs.get(last)!.keys()].map((key) => ({
                      kind: 'object',
                      key,
                    })),
                  }),
                };
              case 'delete':
                if (last.startsWith(refuseDelete ?? '-')) {
                  return { exitCode: 1, combined: 'HTTP 503' };
                }
                blobs.delete(last);
                return {};
            }
          }
          if (args[0] === 'job') {
            const flag = (option: string) => args[args.indexOf(option) + 1]!;
            const input = blobs.get(flag('--input-bucket'))!;
            // Admission creates the missing output bucket.
            const output = new Map([
              [`${JOB}/probe.txt`, input.get('probe.txt')!],
            ]);
            blobs.set(flag('--output-bucket'), output);
            // Without --checkpoint-bucket, the managed bucket named after the Job.
            if (spot) blobs.set(JOB, new Map([['s13', '1']]));
            blobs
              .get(spot ? JOB : flag('--checkpoint-bucket'))!
              .set(`${JOB}/probe.txt`, input.get('probe.txt')!);
            upload(output);
            return { combined: `ID: ${JOB}` };
          }
          if (args[0] === 'logs') return { stdout: log, combined: log };
          // Cleanup deletes the managed bucket before `terminate` sees it cleaned.
          if (args[0] === 'terminate' && spot) blobs.delete(JOB);
          if (args[0] === 'status' && spot) {
            return {
              stdout: JSON.stringify({
                ...JSON.parse(
                  statusJson(
                    JOB,
                    lost.length > 0
                      ? WorkloadState.Completed
                      : WorkloadState.Running,
                    lost.length > 0 ? 2 : null,
                  ),
                ),
                // As the API records them: the claim names the Pod.
                events: [
                  {
                    id: 1,
                    workloadId: JOB,
                    state: WorkloadState.Syncing,
                    metadata: { executionId: 'e1', podUid: 'pod-1' },
                    createdAt: 1,
                  },
                  {
                    id: 2,
                    workloadId: JOB,
                    state: WorkloadState.Running,
                    metadata: { executionId: 'e1' },
                    createdAt: 2,
                  },
                ],
                checkpoint: {
                  bucket: JOB,
                  mount: '/mnt/checkpoint',
                  retained: false,
                  health: {
                    objects: 1,
                    bytes: 2,
                    lastModifiedAt: 1,
                    truncated: false,
                  },
                },
              }),
            };
          }
          return args[0] === 'status'
            ? { stdout: statusJson(args[2]!, WorkloadState.Completed, 2) }
            : { combined: '' };
        },
        [],
        undefined,
        false,
        pool.cloud === 'lambda'
          ? { name: 'lambda-test', material: TEST_LAMBDA_CRED }
          : pool.cloud === 'aws'
            ? { name: 'aws-test', material: TEST_AWS_CRED }
            : azure,
        pool.cloud
          ? {
              pool: {
                region: pool.cloud === 'aws' ? 'us-east-2' : null,
                vmTypes: [pool.cloud === 'aws' ? 'g4dn.xlarge' : 'gpu_1x_a10'],
                spot,
              },
              storage:
                pool.cloud === 'lambda'
                  ? {
                      input: signer(
                        'gcp-storage',
                        TEST_GCP_CRED,
                        'us-central1',
                      ),
                      output: signer('aws-storage', TEST_AWS_CRED, 'us-east-2'),
                      checkpoint: signer('azure-storage', TEST_AZURE_CRED),
                    }
                  : pool.azureCheckpoint
                    ? { checkpoint: signer('azure-storage', TEST_AZURE_CRED) }
                    : {},
            }
          : // The Azure GPU journey's pool: one T4 per VM.
            {
              pool: {
                region: 'westus2',
                vmTypes: ['Standard_NC4as_T4_v3'],
                spot,
              },
            },
      );
    };
    const noSecrets = async () => [];
    const signer = (
      name: string,
      material: CloudCredential,
      region = 'westus2',
    ) => ({ credential: { name, material }, region });
    const lose = async (podUid: string) => {
      lost.push(podUid);
    };

    test('stages the input, finds the copies only under the Job prefix and deletes every container', async () => {
      const { hosted, calls } = azureStage(() => {});
      const record = await hosted.poolJobStorage('np-1', noSecrets, lose);
      expect(record).toMatchObject({
        jobId: JOB,
        outputObjects: [`${JOB}/probe.txt`],
      });
      const job = calls.find((call) => call.args[0] === 'job')!.args;
      expect(job).toEqual(
        expect.arrayContaining([
          '--node-pool',
          'np-1',
          '--gpus',
          '1',
          GPU_SERVICE_IMAGE,
        ]),
      );
      // S6: the command fails on a storage credential in its env or files.
      expect(job.at(-1)).toContain(
        `env | grep -qE '${STORAGE_CREDENTIAL.source}'`,
      );
      expect(job.at(-1)).toContain('/var/run/secrets | grep -q .');
      // Every container call went through the hosted API, with the pool's credential.
      const verbs = calls
        .filter((call) => call.args[0] === 'bucket')
        .map((call) => call.args[1]);
      expect(verbs).toEqual([
        'create',
        'create',
        'upload',
        'download',
        'list',
        'download',
        'list',
        'delete',
        'delete',
        'delete',
      ]);
      expect(record).toMatchObject({
        checkpointObjects: [`${JOB}/probe.txt`],
      });
      expect(job).toEqual(
        expect.arrayContaining([
          '--checkpoint-bucket',
          record!.checkpointBucket,
        ]),
      );
      expect(
        calls
          .filter((call) => call.args[0] === 'bucket')
          .every(
            (call) =>
              call.apiUrl === HOSTED_URL && call.args.includes('azure-test'),
          ),
      ).toBe(true);
      expect(blobs.size).toBe(0);
      // The sweep reclaims either container once it is stale.
      const created = calls
        .find((call) => call.args[1] === 'create')!
        .args.at(-1)!;
      expect(created).toMatch(/^e2e-clust-in-/u);
      expect(staleIds([created], Date.now() + STALE_AFTER_MS + 60_000)).toEqual(
        [created],
      );
    });

    test('a failed stage still deletes every container, the others even when the input delete fails', async () => {
      const { hosted, cleanup } = azureStage(
        (output) => output.set('other/x', 'x'),
        undefined,
        'e2e-clust-in-',
      );
      await expect(
        hosted.poolJobStorage('np-1', noSecrets, lose),
      ).rejects.toThrow('outside its prefix');
      await expect(cleanup.run()).rejects.toThrow('HTTP 503');
      expect([...blobs.keys()]).toEqual([
        expect.stringMatching(/^e2e-clust-in-/u),
      ]);
    });

    test.each([
      [
        'a credential in its log',
        'Uploading output failed: ?sv=2021&sig=abc\nSTORAGE_PROBE_DONE\n',
        noSecrets,
        'holds a storage credential',
      ],
      ['a log without its output', 'other\n', noSecrets, 'lacks its output'],
      [
        'a namespace Secret with a credential',
        undefined,
        async () => ['grant'],
        "Secrets in node pool np-1's namespace hold a storage credential: grant",
      ],
    ])('refuses %s', async (_case, log, secrets, message) => {
      const { hosted, cleanup } = azureStage(() => {}, log);
      await expect(
        hosted.poolJobStorage('np-1', secrets, lose),
      ).rejects.toThrow(message);
      await cleanup.run();
      expect(blobs.size).toBe(0);
    });

    test('refuses an upload outside the Job prefix', async () => {
      const { hosted, cleanup } = azureStage((output) =>
        output.set('other/x', 'x'),
      );
      await expect(
        hosted.poolJobStorage('np-1', noSecrets, lose),
      ).rejects.toThrow(`${JOB} uploaded outside its prefix`);
      await cleanup.run();
      expect(blobs.size).toBe(0);
    });

    test('0043/S13: on a spot pool the retry restores the managed checkpoint after a lost replica, and the bucket goes with the Job', async () => {
      const { hosted, calls } = azureStage(() => {}, undefined, undefined, {
        spot: true,
      });
      await hosted.poolJobStorage('np-1', noSecrets, lose);
      // The replica was lost once `status` listed the managed bucket's upload.
      expect(lost).toEqual(['pod-1']);
      const job = calls.find((call) => call.args[0] === 'job')!.args;
      expect(job).not.toContain('--checkpoint-bucket');
      // The managed bucket is found gone only after the Job was cleaned up.
      const last = (...args: string[]) =>
        calls.findLastIndex((call) =>
          args.every((arg) => call.args.includes(arg)),
        );
      expect(last('bucket', 'list', JOB)).toBeGreaterThan(
        last('terminate', JOB),
      );
      expect(blobs.size).toBe(0);
    });

    test.each([false, true])(
      "0043/S16, S17 and S21: on an AWS spot pool every role signs with the pool's credential, the managed bucket too unless an Azure one is named (%s)",
      async (azureCheckpoint) => {
        const { hosted, calls } = azureStage(() => {}, undefined, undefined, {
          cloud: 'aws',
          spot: true,
          azureCheckpoint,
        });
        await hosted.poolJobStorage('np-1', noSecrets, lose);
        expect(lost).toEqual(['pod-1']);
        const job = calls.find((call) => call.args[0] === 'job')!.args;
        expect(job).not.toContain('--checkpoint-bucket');
        expect(job.join(' ').includes('-storage-')).toBe(azureCheckpoint);
        if (azureCheckpoint) {
          const at = job.indexOf('--checkpoint-storage-credentials');
          expect(job.slice(at, at + 4)).toEqual([
            '--checkpoint-storage-credentials',
            'azure-storage',
            '--checkpoint-storage-region',
            'westus2',
          ]);
        }
        for (const { args } of calls.filter((c) => c.args[0] === 'bucket')) {
          const azure = azureCheckpoint && args.includes(JOB);
          expect(args).toEqual(
            expect.arrayContaining(
              azure ? ['azure-storage'] : ['aws-test', 'us-east-2'],
            ),
          );
          expect(args.includes('aws-test')).toBe(!azure);
        }
        expect(blobs.size).toBe(0);
      },
    );

    test("0043/S20 on a Lambda pool names each role its own backend, and every bucket call uses that role's credential", async () => {
      const { hosted, calls } = azureStage(() => {}, undefined, undefined, {
        cloud: 'lambda',
      });
      const record = await hosted.poolJobStorage('np-1', noSecrets, lose);
      expect(record).toMatchObject({ outputObjects: [`${JOB}/probe.txt`] });
      const job = calls.find((call) => call.args[0] === 'job')!.args;
      const signers = {
        input: ['gcp-storage', 'us-central1'],
        output: ['aws-storage', 'us-east-2'],
        checkpoint: ['azure-storage', 'westus2'],
      };
      const buckets = calls.filter((call) => call.args[0] === 'bucket');
      expect(buckets).toHaveLength(10);
      for (const [role, [name, region]] of Object.entries(signers)) {
        const at = job.indexOf(`--${role}-storage-credentials`);
        expect(job.slice(at, at + 4)).toEqual([
          `--${role}-storage-credentials`,
          name,
          `--${role}-storage-region`,
          region,
        ]);
        const bucket = record![`${role}Bucket` as 'inputBucket']!;
        for (const { args } of buckets.filter((c) => c.args.includes(bucket))) {
          expect(args).toEqual(expect.arrayContaining([name, region]));
        }
      }
      expect(buckets.some((c) => c.args.includes('lambda-test'))).toBe(false);
      expect(blobs.size).toBe(0);
    });

    test('runs nothing on a Lambda pool without storage credentials', async () => {
      const { hosted, calls } = stage(() => ({}), [], undefined, false, {
        name: 'lambda-test',
        material: TEST_LAMBDA_CRED,
      });
      await expect(
        hosted.poolJobStorage('np-1', noSecrets, lose),
      ).resolves.toBeNull();
      expect(calls).toEqual([]);
    });
  });
});

describe('RFC 0048 scale stage', () => {
  const pass = { at: 1, pendingPods: 2, lostVms: 0, vms: 2 };
  const names = new FixtureNames(RUN_ID);
  const longJob = names.workload('scale-0');
  const filler = names.workload('scale-filler-0');
  /** Lambda's two-Node GPU pool, where the Service takes one Node's GPU. */
  const gpuPool = {
    credential: { name: 'lambda-test', material: TEST_LAMBDA_CRED },
    pool: { region: 'us-east-1', vmTypes: ['gpu_1x_a10'] },
  } as const;
  afterEach(() => {
    vi.restoreAllMocks();
  });
  /**
   * The pool (1..4, or 2..5 on `gpuPool`) gains the burst's 2 VMs on its third
   * read, through `scaleOuts`, keeps the long Job's Node once the short Job
   * completed, and is back at its minimum once the long one did, which reads
   * Queued first. The pool has room for one Job, beside the Service or on its
   * idle GPU Node: unless a filler reads Running before the burst, a burst Job
   * runs there and the one pass buys one VM (run 40074196755). Fillers run
   * until terminated. Each clock read is 13 min on, past every idle window.
   */
  const scaling = (
    scaleOuts: object[],
    retried: boolean,
    gpu?: typeof gpuPool,
    lastError: string | null = null,
  ) => {
    const min = gpu ? 2 : 1;
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 13 * 60_000));
    let reads = 0;
    let longReads = 0;
    let shortDone = false;
    let passes = scaleOuts;
    let burstSubmitted = false;
    let fillerRan = false;
    const terminated = new Set<string>();
    return stage(
      (args) => {
        const id = args.at(-1)!;
        if (args[0] === 'job' && !args.includes(filler) && !burstSubmitted) {
          burstSubmitted = true;
          if (!fillerRan) {
            passes = [{ ...pass, pendingPods: 1, vms: 1 }];
          }
        }
        if (args[0] === 'node-pool') {
          reads += 1;
          const pool = {
            ...(JSON.parse(READY_POOL) as { capacity: object }),
            lastError,
          };
          const readyVmCount =
            reads <= 2 || longReads > 3 ? min : shortDone ? min + 1 : min + 2;
          const lastScaleOut = passes[Math.min(reads - 2, passes.length - 1)];
          return {
            stdout: JSON.stringify({
              ...pool,
              capacity: { ...pool.capacity, readyVmCount, lastScaleOut },
            }),
          };
        }
        if (args[0] === 'terminate') terminated.add(id);
        if (args[0] !== 'status') return {};
        if (terminated.has(id)) {
          return { stdout: statusJson(id, WorkloadState.Terminated, 3) };
        }
        if (id === filler) fillerRan = true;
        if (id === 'svc-1' || id === filler) {
          return { stdout: statusJson(id, WorkloadState.Running) };
        }
        if (id === longJob) longReads += 1;
        else shortDone = true;
        const job = JSON.parse(
          id === longJob && longReads <= 3
            ? statusJson(
                id,
                longReads === 1 ? WorkloadState.Queued : WorkloadState.Running,
              )
            : statusJson(id, WorkloadState.Completed, 3),
        ) as object;
        const events =
          id === longJob && retried
            ? [
                {
                  id: 1,
                  workloadId: id,
                  state: WorkloadState.Retrying,
                  metadata: {},
                  createdAt: 1,
                },
              ]
            : [];
        return { stdout: JSON.stringify({ ...job, events }) };
      },
      [],
      pollsWaiter(2),
      false,
      gpu?.credential,
      gpu ? { pool: gpu.pool } : {},
    );
  };

  test.each([
    [
      'buys exactly the burst under a higher --max-vms, its long Job Queued first',
      [pass],
      false,
      '',
    ],
    [
      'fails on a double buy',
      [
        { ...pass, pendingPods: 1, vms: 1 },
        { ...pass, at: 2 },
      ],
      false,
      'the burst should buy 2 VMs',
    ],
    [
      "fails on the long Job's retry past the idle window",
      [pass],
      true,
      'stopped running or was retried',
    ],
  ])('0048/S1 S3: %s', async (_case, scaleOuts, retried, message) => {
    const run = expect(
      scaling(scaleOuts, retried).hosted.scalePool('np-1', 'svc-1', vi.fn()),
    );
    await (message
      ? run.rejects.toThrow(message)
      : run.resolves.toMatchObject({ maxVms: 4, burstVms: 2 }));
  });

  test('0048/S1: a launch refused for a cloud quota is environmental and names the quota, not a double buy (run 40815310015)', async () => {
    const quota =
      'launching VM 3 in us-east-2 failed (quota-exhausted-region); next launch in 60 s: You have requested more vCPU capacity than your current vCPU limit of 8 allows';
    await expect(
      scaling(
        [
          { ...pass, pendingPods: 1, vms: 1 },
          { ...pass, at: 2 },
        ],
        false,
        undefined,
        quota,
      ).hosted.scalePool('np-1', 'svc-1', vi.fn()),
    ).rejects.toThrow(/^environmental: .*vCPU limit of 8/u);
  });

  test.each([
    ["the Service Node's room on a CPU pool", undefined, 1, 4],
    ['the GPU Node the Service leaves idle (run 40074196755)', gpuPool, 2, 5],
  ])(
    '0048/S1: fills %s before the burst and holds it through scale-in',
    async (_case, gpu, minVms, maxVms) => {
      const { hosted, calls } = scaling([pass], false, gpu);
      await expect(
        hosted.scalePool('np-1', 'svc-1', vi.fn()),
      ).resolves.toMatchObject({
        minVms,
        maxVms,
        burstVms: 2,
        jobIds: [longJob, names.workload('scale-1')],
      });
      const at = (head: string, id: string) =>
        calls.findIndex(({ args }) => args[0] === head && args.includes(id));
      const fillerJob = calls[at('job', filler)]!.args;
      expect(fillerJob.slice(-2)).toEqual(['sleep', 'infinity']);
      expect(fillerJob.includes('--gpus')).toBe(gpu !== undefined);
      // One filler: beside the Service, or min - 1 on the GPU pool.
      expect(
        calls.filter(
          ({ args }) => args[0] === 'job' && args.at(-1) === 'infinity',
        ),
      ).toHaveLength(1);
      expect(at('status', filler)).toBeLessThan(at('job', longJob));
      const lastPoolRead = calls.findLastIndex(
        ({ args }) => args[0] === 'node-pool',
      );
      expect(at('terminate', filler)).toBeGreaterThan(lastPoolRead);
    },
  );
});
