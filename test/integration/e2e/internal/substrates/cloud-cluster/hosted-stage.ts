import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod';
import * as semver from 'semver';

import { SCALE_IN_IDLE_WINDOW_MS } from '../../../../../../src/api/services/pool-scaling.js';
import { apiAccessUsersResponseSchema } from '../../../../../../src/shared/api-contract/api-access-schemas.js';
import { deploymentSummarySchema } from '../../../../../../src/shared/api-contract/deployments-schemas.js';
import {
  nodePoolSummarySchema,
  type NodePoolSummary,
} from '../../../../../../src/shared/api-contract/node-pools-schemas.js';
import {
  systemReleaseStatusSchema,
  type SystemReleaseStatus,
} from '../../../../../../src/shared/api-contract/system-release-schemas.js';
import {
  workloadStatusResponseSchema,
  type WorkloadStatusResponse,
} from '../../../../../../src/shared/api-contract/workload-management-schemas.js';
import type { CloudCredential } from '../../../../../../src/shared/api-contract/credentials-schemas.js';
import { CloudType } from '../../../../../../src/shared/cloud.js';
import { isImagePullTelemetry } from '../../../../../../src/shared/image.js';
import {
  getVCPUsForVMType,
  gpuCapabilityForVMType,
} from '../../../../../../src/shared/cloud-config.js';
import {
  isTerminalState,
  WorkloadState,
} from '../../../../../../src/shared/workload.js';
import type { ArtifactStore, Redactor } from '../../artifacts.js';
import type { CleanupRegistration, CleanupStack } from '../../cleanup.js';
import { TRANSIENT_FAILURE, type CliClient } from '../../cli.js';
import { cliArgs, type CliPath } from '../../cli-surface.js';
import type {
  HostedHealthRecord,
  EgressProbe,
  HostedPoolJobsRecord,
  HostedPoolJobStorageRecord,
  HostedRecursionRecord,
  HostedReleaseRecord,
  HostedScaleRecord,
  HostedStage,
  HostedVersion,
} from '../../contracts/cluster-cloud.js';
import { CHECK_IMAGE } from '../../contracts/pool-checks.js';
import { probeFailure, type TargetHttpClient } from '../../transports/http.js';
import type { ServiceDnsProbe } from '../../transports/service-dns.js';
import type { ProcessRunner } from '../../process.js';
import { FetchFailureCapture } from './hosted-fetch-failure.js';
import type { CommandResult } from '../../types.js';
import type { FixtureNames } from '../../names.js';
import { NAMED_SECRET_PROBE_KEY } from '../../probes/named-secret.js';
import { roleApplyCheck } from './role-apply-check.js';
import { completedCommand, rejectedCommand } from '../../api-assertions.js';
import {
  retryTransientProbeError,
  WaitTimeoutError,
  type Waiter,
} from '../../wait.js';

/**
 * Every verb the hosted-API stage drives against the API on the cluster,
 * typed against the generated CLI surface so an unknown flag is a compile
 * error. They run with `API_URL` pointed at the cluster's hostname; the
 * operator's `api use` is exercised once for the walk and the installer's
 * own target is never changed (its `API_URL` env wins over the saved file).
 */
const API_USE = 'api use' satisfies CliPath;
const API_UPGRADE = 'api upgrade' satisfies CliPath;
const API_STATUS = 'api status' satisfies CliPath;
const CLUSTER_LIST = 'cluster list' satisfies CliPath;
const API_ACCESS_ADD = 'api access add' satisfies CliPath;
const API_ACCESS_LIST = 'api access list' satisfies CliPath;
const API_ACCESS_REMOVE = 'api access remove' satisfies CliPath;
const CREDENTIALS_NEW = 'credentials new' satisfies CliPath;
const BUCKET_LIST = 'bucket list' satisfies CliPath;
const BUCKET_CREATE = 'bucket create' satisfies CliPath;
const BUCKET_UPLOAD = 'bucket upload' satisfies CliPath;
const BUCKET_DOWNLOAD = 'bucket download' satisfies CliPath;
const BUCKET_DELETE = 'bucket delete' satisfies CliPath;
const BUCKET_RM = 'bucket rm' satisfies CliPath;
const DEPLOYMENT_CREATE = 'deployment create' satisfies CliPath;
const DEPLOYMENT_STATUS = 'deployment status' satisfies CliPath;
const DEPLOYMENT_DELETE = 'deployment delete' satisfies CliPath;
const DEPLOYMENT_UPGRADE = 'deployment upgrade' satisfies CliPath;
const SECRETS_NEW = 'secrets new' satisfies CliPath;
const SECRETS_DELETE = 'secrets delete' satisfies CliPath;
const NODE_POOL_CREATE = 'node-pool create' satisfies CliPath;
const NODE_POOL_STATUS = 'node-pool status' satisfies CliPath;
const NODE_POOL_DELETE = 'node-pool delete' satisfies CliPath;
const SERVICE_CREATE = 'service' satisfies CliPath;
const JOB_CREATE = 'job' satisfies CliPath;
const WORKLOAD_STATUS = 'status' satisfies CliPath;
const WORKLOAD_LOGS = 'logs' satisfies CliPath;
const WORKLOAD_TERMINATE = 'terminate' satisfies CliPath;

/**
 * The recursive parent runs the CLI from the API image itself (`node
 * dist/cli/index.js`); the child is the smallest Job that can complete.
 */
const CONTAINER_CLI = 'node /app/dist/cli/index.js';
const CHILD_IMAGE = 'mirror.gcr.io/library/alpine:3.20';
const CHILD_POLL_SECONDS = 10;

/**
 * What RFC 0043 S6 must find nowhere: a SAS signature or an account key, an
 * STS session's access key ID or a Google access token. Case-sensitive, so
 * base64 in a CA bundle doesn't read as a key ID.
 */
const STORAGE_CREDENTIAL_PATTERN = 'sig=|AccountKey|ASIA[A-Z0-9]{16}|ya29\\.';
export const STORAGE_CREDENTIAL = new RegExp(STORAGE_CREDENTIAL_PATTERN, 'u');
const STORAGE_PROBE_DONE = 'STORAGE_PROBE_DONE';
const CHILD_POLLS = 120;

const shellQuote = (arg: string): string => `'${arg.replace(/'/gu, `'\\''`)}'`;
const shellCommand = (args: readonly string[]): string =>
  `${CONTAINER_CLI} ${args.map(shellQuote).join(' ')}`;

/**
 * A GitHub user and an organization for the live `api access` walk. User IDs
 * are immutable, so octocat's is a constant.
 */
const ACCESS_USER = { username: 'octocat', userId: '583231' } as const;
const ACCESS_ORG = 'anycloud-sh';

/** Not the official repository: refused before anything is recorded. */
export const REFUSED_RELEASE_IMAGE = `docker.io/library/nginx:1.27@sha256:${'0123456789abcdef'.repeat(4)}`;

/**
 * The GPU pool's Service (glibc, for the injected nvidia-smi): it serves the
 * `nvidia-smi -L` device list and starts only if a GPU is listed.
 */
export const GPU_SERVICE_IMAGE = CHECK_IMAGE;
export const GPU_SERVICE_COMMAND = [
  'sh',
  '-c',
  'mkdir -p /srv && nvidia-smi -L | tee /srv/index.html | grep -q "^GPU " && cd /srv && exec python3 -m http.server "$PORT" --bind 0.0.0.0',
] as const;
const GPU_DEVICE_LINE = /^GPU \d+: \S.*$/gmu;

/** The GPU pool's receiver base: e2e-gpu's cached-model MACE image. */
export const MACE_RECEIVER_BASE_IMAGE =
  'ghcr.io/anycloud-sh/mace@sha256:c60574d120937bd1db9c0c579d427f2b48d307f44c552888952354bf77c2d19d';
/** fixtures/mace_inference.py CANARY_OFFSET_EV and TOLERANCE_EV. */
export const MACE_CANARY_OFFSET_EV = 1;
const MACE_TOLERANCE_EV = 1e-5;
const MACE_MISMATCH =
  /^MACE (?<geometry>[ab]) energy (?<energy>-?\d+(?:\.\d+)?(?:e-?\d+)?) eV on (?<device>.+) differs from reference (?<compared>-?\d+(?:\.\d+)?(?:e-?\d+)?) eV$/u;

/** A launch the cloud refused for a quota, as a pool's `lastError` words it. */
const QUOTA_ERROR = /quota|(?:vcpu|instance).?limit/iu;

/**
 * Every hosted bucket create, delete and list. On Azure, a cold account cache
 * (per credential, 15 min) makes the API look the storage account up and list
 * its keys, and the Storage RP throttles both per subscription. The
 * SDK retries each of those ARM calls up to 10 times (`maxRetries`) and waits
 * out every 429's Retry-After, which it does not cap. Run 40934357557's create
 * waited about 280 s through Retry-Afters of 74, 35, 28, 30 and 30 s (39 s
 * mean); this bounds both calls' full retries at 45 s each. The CLI gives up
 * sooner, so `#bucketCall` reruns it until this bound.
 */
const BUCKET_TIMEOUT_MS = 2 * 10 * 45_000;

/** The CLI's own request timeout, or the API's `BUCKET_THROTTLED` answer. */
const BUCKET_CALL_TIMED_OUT = /aborted due to timeout|throttled credential/iu;

/** `stageInput`'s largest object: under Cloudflare's 100 MB request-body cap. */
const INPUT_PART_BYTES = 90_000_000;

/** Every cloud's capacity or quota refusal, as a pool's `lastError` words it. */
const CAPACITY_ERROR =
  /insufficient.?capacity|(?:vcpu|instance).?limit.?exceeded|quota|RESOURCE_POOL_EXHAUSTED|AllocationFailed/iu;

/** fixtures/voice_session.py TOLERANCE and MIN_SECONDS. */
export const VOICE_TOLERANCE = 0.1;
const VOICE_MIN_SECONDS = 2;
const VOICE_CANARY = /^VOICE_CANARY (?<evidence>\{.*\})$/u;
const voiceCanarySchema = z.object({
  seconds: z.number(),
  rms: z.number(),
  distance: z.number(),
  device: z.string().min(1),
  modelLoadId: z.string().min(1),
  /** From the session's admission to its first audio. */
  firstChunkMs: z.number(),
  /** The session's wall time over its audio time. */
  rtf: z.number(),
});
const AC_TIMING = /AC_TIMING (\{.*\})/gu;
const timingMarkSchema = z.object({ name: z.string(), epochMs: z.number() });

/** The fixtures' `AC_TIMING` lines in a receiver log: each name's first epoch ms. */
export function timingMarks(log: string): Record<string, number> {
  const marks: Record<string, number> = {};
  for (const [, json] of log.matchAll(AC_TIMING)) {
    const mark = timingMarkSchema.safeParse(JSON.parse(json));
    if (mark.success) marks[mark.data.name] ??= mark.data.epochMs;
  }
  return marks;
}

/**
 * The voice canary's error: the receiver ran and checked a whole session, then
 * errored it on purpose with that check's evidence. Its audio must be within
 * tolerance of the CPU reference Whisper heard at build, from a named device.
 */
export function voiceCanaryEvidence(
  message: string,
): z.infer<typeof voiceCanarySchema> {
  const json = VOICE_CANARY.exec(message)?.groups?.evidence;
  const evidence = json
    ? voiceCanarySchema.safeParse(JSON.parse(json))
    : undefined;
  if (!evidence?.success) {
    throw new Error(`the voice canary errored without its check: ${message}`);
  }
  const { distance, seconds } = evidence.data;
  if (!(distance <= VOICE_TOLERANCE) || !(seconds >= VOICE_MIN_SECONDS)) {
    throw new Error(
      `the voice canary's audio is not its reference: ${message}`,
    );
  }
  return evidence.data;
}

/**
 * The canary Job's error: the receiver checked its fresh CUDA energy against
 * the CPU reference plus the canary offset. The energy must still be the CPU
 * reference itself (within tolerance), computed on a named CUDA device.
 */
export function maceCanaryEvidence(message: string): {
  readonly geometry: string;
  readonly device: string;
  readonly energyEv: number;
} {
  const match = MACE_MISMATCH.exec(message)?.groups;
  if (!match?.geometry || !match.device || !match.energy || !match.compared) {
    throw new Error(`the MACE canary errored without its check: ${message}`);
  }
  const energyEv = Number(match.energy);
  const reference = Number(match.compared) - MACE_CANARY_OFFSET_EV;
  if (!(Math.abs(energyEv - reference) <= MACE_TOLERANCE_EV)) {
    throw new Error(
      `the MACE canary energy ${energyEv} eV is not its CPU reference ${reference} eV`,
    );
  }
  return { geometry: match.geometry, device: match.device, energyEv };
}

/** A Job's creation to its first claim. */
function claimMs(status: WorkloadStatusResponse): number {
  const claimed = status.events.find(
    (e) =>
      e.state === WorkloadState.Running || e.state === WorkloadState.Syncing,
  );
  if (!claimed) throw new Error(`Job ${status.workload.id} has no claim event`);
  return claimed.createdAt - status.workload.startedAt;
}

/**
 * The plain-line verdicts `anycloud api upgrade` prints for a hosted target
 * (`src/cli/commands/api.ts`): the started upgrade with its number, the
 * unchanged no-op, the refusal with the API's reason, and the local API's
 * lines, which a hosted upgrade must never print: it runs without Docker or
 * the local API. They are the primary signal;
 * `api status --json` and the backup count stay the definitive check.
 */
export const HOSTED_VERDICT = {
  started:
    /Hosted API upgrade (?<number>\d+) started: \S+ → (?<version>\S+)\./u,
  unchanged:
    /Hosted API \S+ already runs (?<image>\S+); nothing to do \(unchanged\)\./u,
  /** An API older than `Upgrade N` (0.1.65) accepts the upgrade without naming it. */
  accepted: /Hosted API \S+ accepted the upgrade to (?<image>\S+)\./u,
  refused: /Hosted API upgrade refused: (?<reason>.+)/u,
  localApi: /\blocal API server\b/iu,
  /** The K3s step this tree's API runs before it is asked (RFC 0049 C26 (b)). */
  kubernetes: /^\s*K3s step: configuration (changed|current)/mu,
} as const;

const bucketEntriesSchema = z
  .object({ entries: z.array(z.object({ name: z.string() }).loose()) })
  .loose();
/** `bucket list <bucket> --json`: its prefixes and objects. */
const objectEntriesSchema = z
  .object({
    entries: z.array(z.object({ kind: z.string(), key: z.string() }).loose()),
  })
  .loose();

const apiStatusSchema = z
  .object({ release: systemReleaseStatusSchema.nullable() })
  .loose();

const versionSchema = z
  .object({ version: z.string().min(1), schemaVersion: z.string().nullable() })
  .loose();

/** `credentials new` for the pool's credential, as the hosted stage and a released installer save it. */
export function credentialsNewArgs(
  name: string,
  material: CloudCredential,
): string[] {
  const secrets =
    material.cloudProvider === CloudType.AWS
      ? {
          provider: 'aws',
          'access-key-id': material.accessKeyId,
          'secret-access-key': material.secretAccessKey,
        }
      : material.cloudProvider === CloudType.Azure
        ? {
            provider: 'azure',
            'application-id': material.applicationId,
            secret: material.secret,
            'subscription-id': material.subscriptionId,
            'directory-id': material.directoryId,
          }
        : material.cloudProvider === CloudType.GCP
          ? {
              provider: 'gcp',
              'project-id': material.projectId,
              'client-email': material.clientEmail,
              'private-key': material.privateKey,
            }
          : material.cloudProvider === CloudType.Lambda
            ? { provider: 'lambda', 'api-key': material.apiKey }
            : undefined;
  if (!secrets) {
    throw new Error(
      'The hosted stage saves an AWS, Azure, GCP or Lambda credential',
    );
  }
  return cliArgs(CREDENTIALS_NEW, secrets, [name]);
}

/** The address GCP Nodes resolve through, and K5's one exception to its deny. */
const METADATA_RESOLVER = '169.254.169.254';

const egressProbeSchema = z
  .object({
    nameservers: z.array(z.string().min(1)).min(1),
    apiHostResolved: z.boolean(),
    metadataHttp: z.enum(['denied', 'reachable']),
    metadataError: z.string().optional(),
    wireServerErrors: z
      .object({ '80': z.string(), '32526': z.string() })
      .strict()
      .optional(),
  })
  .strict();

/**
 * The receiver's `EGRESS_PROBE` line (fixtures/deployment.py), checked
 * against K5's egress policy: the replica resolves the workload API host
 * through its Node's resolver and can't reach the metadata HTTP port. A GCP
 * Node resolves through the metadata server itself, so there the one address
 * must answer DNS and refuse HTTP: the deny's own control. Lambda has
 * no metadata service on that address, so there the probe records its
 * resolver and shows resolution works under the policy. On Azure the replica
 * resolves through the WireServer, so its DNS must answer while its HTTP and
 * HostGAPlugin ports refuse.
 */
export function egressProbeEvidence(
  log: string,
  cloud: CloudType,
): EgressProbe {
  const line = /EGRESS_PROBE (\{.*\})/u.exec(log)?.[1];
  if (!line) throw new Error('the receiver logged no EGRESS_PROBE line');
  const probe = egressProbeSchema.parse(JSON.parse(line));
  if (!probe.apiHostResolved) {
    throw new Error(
      `the replica could not resolve the workload API host through ${probe.nameservers.join(', ')}`,
    );
  }
  if (probe.metadataHttp !== 'denied' || !probe.metadataError) {
    throw new Error(
      "the replica reached the instance metadata HTTP port under K5's egress policy",
    );
  }
  // A GCP Node's resolv.conf may name the metadata server more than once.
  const nameservers = [...new Set(probe.nameservers)];
  if (cloud === CloudType.GCP && nameservers.join() !== METADATA_RESOLVER) {
    throw new Error(
      `a GCP replica resolved through ${nameservers.join(', ')}, not only the metadata server ${METADATA_RESOLVER}`,
    );
  }
  if (cloud === CloudType.Azure) {
    if (!probe.wireServerErrors) {
      throw new Error('an Azure replica logged no WireServer probe');
    }
    for (const [port, error] of Object.entries(probe.wireServerErrors)) {
      if (!error) {
        throw new Error(
          `the replica reached the Azure WireServer on port ${port} under K5's egress policy`,
        );
      }
    }
  }
  return {
    nameservers: probe.nameservers,
    metadataError: probe.metadataError,
    ...(probe.wireServerErrors && {
      wireServerErrors: probe.wireServerErrors,
    }),
  };
}

/** What a GPU pool's receiver runs per Job (`gpu_workload`). */
export type GpuWorkload = 'mace' | 'voice';

type StorageRole = 'input' | 'output' | 'checkpoint';
const STORAGE_ROLES: readonly StorageRole[] = ['input', 'output', 'checkpoint'];

export interface HostedStageOptions {
  readonly artifacts: Pick<ArtifactStore, 'json'>;
  readonly cleanup: CleanupStack;
  readonly cli: Pick<CliClient, 'run'>;
  /** Runs the `fetch failed` probes, which it records as command artifacts. */
  readonly runner: Pick<ProcessRunner, 'run'>;
  readonly http: Pick<TargetHttpClient, 'get'>;
  /** Wire queries to `anycloud.sh`'s authoritative nameservers. */
  readonly dns: Pick<ServiceDnsProbe, 'observe'>;
  readonly wait: Pick<Waiter, 'for'>;
  readonly names: Pick<
    FixtureNames,
    'workload' | 'nodePool' | 'deployment' | 'secret'
  >;
  readonly redactor: Pick<Redactor, 'add'>;
  /** The harness's sign-in token; the recursive parent's CLI reads it from a Secret. */
  readonly token: string;
  /** `from_release`: the published release's CLI, which drives the hosted API until the walk upgrades it. */
  readonly fromRelease?: { readonly cli: Pick<CliClient, 'run'> };
  /** The pool's credential (AWS, Azure, GCP or Lambda), saved again into the hosted API's own database. */
  readonly credential: {
    readonly name: string;
    readonly material: CloudCredential;
  };
  /**
   * The AWS cluster's credential, also saved, when the pool's cloud can't
   * list the cluster's checkpoint bucket (a GCP, Azure or Lambda pool); the
   * post-upgrade decrypt check lists backups with it.
   */
  readonly backup?: {
    readonly credential: {
      readonly name: string;
      readonly material: CloudCredential;
    };
    readonly region: string;
  };
  /**
   * The storage credential, also saved, that the bucketed Job names for a
   * role, and its region (RFC 0043 O11); a role left out uses the pool's own
   * credential. A Lambda pool's Job keeps each role on its own backend (S20).
   */
  readonly storage?: Partial<
    Record<
      StorageRole,
      {
        readonly credential: {
          readonly name: string;
          readonly material: CloudCredential;
        };
        readonly region: string;
      }
    >
  >;
  /** The pool's VM types, an ordered fallback list (Lambda's GPU list; one type elsewhere). */
  readonly pool: {
    readonly region: string | null;
    readonly vmTypes: readonly string[];
    readonly spot?: boolean;
  };
  /**
   * A GPU pool (`gpu_pool`): the receiver runs `nvidia-smi -L` before each Job,
   * then its workload: a MACE CUDA calculation checked against its CPU
   * reference, or a Kyutai TTS voice session checked against a CPU rendering
   * Whisper heard as its text.
   */
  readonly gpu: GpuWorkload | false;
  readonly replicas?: 1 | 2;
  /** The default pool journey: one VM, no scale stage. */
  readonly singleVm?: true;
  readonly service: { readonly image: string; readonly port: number };
  /**
   * Pushes the Deployment receiver (test/docker/Dockerfile.e2e-cluster-local-deployment,
   * this tree's SDK; on the MACE base for a GPU pool) and returns it digest-pinned.
   * It completes the Jobs listed in `E2E_COMPLETE_JOB_IDS` and holds any other
   * until cancelled; a failed MACE check errors the Job instead.
   */
  readonly receiverImage: () => Promise<string>;
  readonly timeouts: {
    readonly nodePoolMs: number;
    readonly workloadMs: number;
    readonly releaseMs: number;
    /** Two VM Jobs boot in sequence (the child inside the parent). */
    readonly recursionMs: number;
  };
  /** Test seam for the retry backoff and the served-version settle wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Validate the journey before any cloud resources are admitted
 * (configuration.ts has already checked the clouds against each other):
 * `hostedStage` (the release journey, which needs the alternate image),
 * `gpuPool` (one NVIDIA GPU per pool VM), never both, or else the default
 * pool journey. Each runs through the hosted API: no local API holds the
 * cluster since create runs in the CLI process (RFC 0049 C26 (e)).
 */
export function assertHostedStageConfiguration(options: {
  readonly hostedStage: boolean;
  readonly gpuPool: boolean;
  readonly alternateImage: string | undefined;
  readonly poolProvider: string;
  readonly poolRegion: string | null;
  readonly poolVmType: string;
  readonly clusterRegion: string;
}):
  | { readonly alternateImage: string; readonly recursion: boolean }
  | { readonly gpuPool: true }
  | { readonly pool: true } {
  const { alternateImage, gpuPool, hostedStage } = options;
  if (!hostedStage && !gpuPool) return { pool: true };
  const journey = gpuPool ? 'E2E_CLUSTER_GPU_POOL' : 'E2E_CLUSTER_HOSTED_STAGE';
  if (hostedStage && gpuPool) {
    throw new Error(
      'E2E_CLUSTER_GPU_POOL and E2E_CLUSTER_HOSTED_STAGE are separate journeys of the live cluster member; dispatch one per run',
    );
  }
  // The GPU journey runs on AWS, Azure or GCP; the release journey also on
  // Lambda (a Lambda GPU pool; K5's egress probe runs on each).
  const clouds = ['aws', 'azure', 'gcp', ...(gpuPool ? [] : ['lambda'])];
  if (!clouds.includes(options.poolProvider)) {
    throw new Error(
      `${journey} runs its node pool on ${gpuPool ? 'AWS, Azure or GCP' : 'AWS, Azure, GCP or Lambda'}, not ${options.poolProvider}`,
    );
  }
  // Both AWS native sweeps are scoped to the cluster region. Do not admit Jobs
  // in a second region that neither cleanup inventory could see.
  if (
    options.poolProvider === 'aws' &&
    options.poolRegion !== options.clusterRegion
  ) {
    throw new Error(
      `${journey} requires the pool${gpuPool ? '' : ' and recursive Jobs'} in E2E_CLUSTER_REGION; unset E2E_CLUSTER_POOL_REGION or use the same region`,
    );
  }
  if (gpuPool) {
    const poolCloud = {
      aws: CloudType.AWS,
      azure: CloudType.Azure,
      gcp: CloudType.GCP,
    }[options.poolProvider as 'aws' | 'azure' | 'gcp'];
    // The journey's Service and Deployment each take the Node's one device.
    const capability = gpuCapabilityForVMType(poolCloud, options.poolVmType);
    if (capability.kind !== 'nvidia' || capability.count !== 1) {
      throw new Error(
        `E2E_CLUSTER_GPU_POOL needs a VM type with exactly one NVIDIA GPU, not ${options.poolVmType} on ${options.poolProvider}`,
      );
    }
    return { gpuPool: true };
  }
  if (!alternateImage) {
    throw new Error(
      'E2E_CLUSTER_HOSTED_STAGE needs E2E_CLUSTER_ALTERNATE_IMAGE (the digest-pinned b image)',
    );
  }
  // The recursive VM Job pair runs on an AWS pool only: the native sweeps
  // cover a GCP, Azure or Lambda pool's instances by its node pool's tags, not the
  // instances of VM Jobs in that cloud.
  return { alternateImage, recursion: options.poolProvider === 'aws' };
}

/**
 * Builds the Deployment receiver from this tree's SDK wheel and pushes it as
 * a throwaway tag of the API package (the workflow is logged in to it, and
 * the pool pulls it like the API image); returns the digest-pinned reference.
 * For a GPU pool it builds on the MACE image so each Job runs checked CUDA work.
 */
export async function pushReceiverImage(options: {
  readonly runner: Pick<ProcessRunner, 'run'>;
  readonly projectRoot: string;
  readonly wheelDirectory: () => Promise<string>;
  readonly tag: string;
  /** A GPU pool's workload; the receiver builds on its image. */
  readonly gpu?: GpuWorkload;
}): Promise<string> {
  const { runner, tag } = options;
  const docker = async (args: readonly string[], label: string) =>
    completedCommand(
      await runner.run('docker', args, { timeoutMs: 1_200_000, label }),
      label,
    );
  // The voice base is built here from its pinned sources, not published.
  const voiceBase = `${tag}-voice-base`;
  if (options.gpu === 'voice') {
    await docker(
      [
        'build',
        '--tag',
        voiceBase,
        '--file',
        path.join(options.projectRoot, 'test/docker/Dockerfile.voice'),
        path.join(options.projectRoot, 'test/docker'),
      ],
      'voice-base-image-build',
    );
  }
  const base = {
    mace: [MACE_RECEIVER_BASE_IMAGE, 'mace-cuda'],
    voice: [voiceBase, 'voice'],
  } as const;
  await docker(
    [
      'build',
      '--tag',
      tag,
      '--build-arg',
      `ANYCLOUD_SDK_WHEEL_DIR=${await options.wheelDirectory()}`,
      ...(options.gpu
        ? [
            '--build-arg',
            `BASE_IMAGE=${base[options.gpu][0]}`,
            '--build-arg',
            `WORKLOAD_PROFILE=${base[options.gpu][1]}`,
          ]
        : []),
      '--file',
      path.join(
        options.projectRoot,
        'test/docker/Dockerfile.e2e-cluster-local-deployment',
      ),
      options.projectRoot,
    ],
    'receiver-image-build',
  );
  await docker(['push', tag], 'receiver-image-push');
  const digest = /@(sha256:[0-9a-f]{64})$/u.exec(
    await docker(
      ['inspect', '--format', '{{index .RepoDigests 0}}', tag],
      'receiver-image-digest',
    ),
  )?.[1];
  if (!digest) throw new Error(`could not read the pushed digest of ${tag}`);
  return `${tag}@${digest}`;
}

/** How long the served version may take to settle through the edge. */
const SERVED_VERSION_BUDGET_MS = 120_000;
/** `/health` is polled this often through an upgrade. */
const HEALTH_POLL_MS = 250;
/** Jobs submitted to the kept receiver just before the API upgrades. */
const UPGRADE_JOBS = 3;
/** How long the upgraded API's rollout is watched for a further generation. */
const STEADY_ROLLOUT_MS = 180_000;
/** Through that window a CLI read runs this often, riding out any restart. */
const STEADY_READ_MS = 10_000;
/** Two consecutive answers this far apart before the endpoint counts as settled. */
const SETTLE_GAP_MS = 5_000;
/** Each short scale Job holds its Node this long. */
const SCALE_JOB_SECONDS = 180;
/**
 * The long scale Job outlives the short Jobs' Nodes: their run, idle window
 * and removal, with about 7 min for the burst's Nodes to boot apart.
 */
const SCALE_LONG_JOB_SECONDS = 22 * 60;
/** Passes and the removal that follow an idle window. */
const SCALE_IN_SLACK_MS = 2 * 60_000;

export interface WatchRequestsOptions {
  readonly dns: Pick<ServiceDnsProbe, 'observe'>;
  /** Test seams: the request, and the runner's resolver as `fetch` uses it. */
  readonly fetch?: typeof fetch;
  readonly lookup?: (hostname: string) => Promise<readonly LookupAddress[]>;
}

/**
 * Polls `url` until stopped: what any caller saw through the edge, the
 * hosted API's `/health` or a pool Service. The longest gap is the
 * longest time between two good answers. Each failure is kept by kind, and
 * the first one also probes DNS, so a gap explains itself.
 */
export function watchRequests(
  url: URL,
  options: WatchRequestsOptions,
): () => Promise<HostedHealthRecord> {
  const request = options.fetch ?? fetch;
  const resolve =
    options.lookup ?? ((hostname) => lookup(hostname, { all: true }));
  let stopped = false;
  const record = { requests: 0, failed: 0, longestGapMs: 0 };
  const failures: Record<string, HostedHealthRecord['failures'][string]> = {};
  let probe: Promise<HostedHealthRecord['dns']> | undefined;
  let lastOk = Date.now();
  const polling = (async () => {
    while (!stopped) {
      const started = Date.now();
      const failure = await request(url, {
        signal: AbortSignal.timeout(5_000),
      }).then(
        (response) =>
          response.ok
            ? undefined
            : {
                kind: `HTTP ${response.status} ${response.headers.get('Server') ?? 'without Server header'}`,
                detail: `cf-ray ${response.headers.get('cf-ray') ?? 'none'}`,
              },
        (error: unknown) => ({
          kind: failureKind(error),
          detail: probeFailure(error),
        }),
      );
      record.requests += 1;
      if (!failure) {
        record.longestGapMs = Math.max(record.longestGapMs, started - lastOk);
        lastOk = started;
      } else {
        record.failed += 1;
        const at = new Date(started).toISOString();
        const seen = failures[failure.kind];
        failures[failure.kind] = seen
          ? { ...seen, count: seen.count + 1, lastAt: at }
          : { count: 1, firstAt: at, lastAt: at, detail: failure.detail };
        probe ??= probeDns(url.hostname, options.dns, resolve);
      }
      await delay(Math.max(0, HEALTH_POLL_MS - (Date.now() - started)));
    }
  })();
  let stopping: Promise<HostedHealthRecord> | undefined;
  return () =>
    (stopping ??= (async () => {
      stopped = true;
      await polling;
      const gap = Date.now() - lastOk;
      const dns = await probe;
      return {
        ...record,
        longestGapMs: Math.max(record.longestGapMs, gap),
        failures,
        ...(dns ? { dns } : {}),
      };
    })());
}

/** A request's error code (`ENOTFOUND`, `ECONNRESET`), or `timeout` at the 5 s abort. */
function failureKind(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if ('code' in cause && typeof cause.code === 'string') return cause.code;
  }
  return error instanceof Error ? error.name : 'error';
}

/** The runner's resolver against each authoritative answer; it never rejects. */
async function probeDns(
  hostname: string,
  dns: Pick<ServiceDnsProbe, 'observe'>,
  resolve: (hostname: string) => Promise<readonly LookupAddress[]>,
): Promise<HostedHealthRecord['dns']> {
  const at = new Date().toISOString();
  const [resolver, authoritative] = await Promise.all([
    resolve(hostname).then(
      (addresses) => addresses.map((a) => a.address).join(', '),
      probeFailure,
    ),
    dns.observe(hostname).then(
      (observed) =>
        observed.answers.map((a) => `${a.authority}: ${a.diagnostic}`),
      (error: unknown) => [probeFailure(error)],
    ),
  ]);
  return { at, resolver, authoritative };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

type Summary = z.output<typeof deploymentSummarySchema>;

/** The Deployment's running Pod and container as the hosted API observed them. */
const observed = (s: Summary | 'absent') =>
  s !== 'absent' &&
  s.status?.observation === 'observed' &&
  s.status.state === WorkloadState.Running &&
  s.status.ready &&
  s.status.upgrade?.state !== WorkloadState.Starting &&
  s.status.podUid &&
  s.status.containerId
    ? s.status
    : null;

const summarize = (s: Summary | 'absent') =>
  s === 'absent'
    ? 'absent'
    : JSON.stringify({ status: s.status, jobs: s.jobs });

/**
 * What creating and deleting a pool read; with `fromRelease` a published
 * release prints it, without fields added since.
 */
const createdNodePoolSchema = z.object({
  id: nodePoolSummarySchema.shape.id,
  state: nodePoolSummarySchema.shape.state,
  releasing: nodePoolSummarySchema.shape.releasing,
  lastError: nodePoolSummarySchema.shape.lastError,
});

const nodePoolAbsent = (id: string) =>
  new RegExp(`Node pool "${escapeRegExp(id)}" not found`, 'u');

/**
 * The hosted-API stage of the live cluster run: the operator walk against the
 * API on the cluster (`api use`, `credentials new`), a node pool created and a
 * Service run **through the hosted API** (its in-cluster ServiceAccount), the
 * self-update path with a real image change both ways, the unchanged and
 * refused cases, and teardown through the product.
 */
/** What the stage borrows from the cluster substrate. */
export interface HostedApiTarget {
  /** Known only after bootstrap: the installation's hostname URL. */
  readonly url: () => string;
  readonly backupVersions: () => Promise<number>;
  /** The installation's checkpoint bucket, which holds the API's database backups. */
  readonly bucket: () => string;
  /** Before `api upgrade`: cleanup then waits for an older hosted API to roll out. */
  readonly upgradeRequested: () => void;
}

export class HostedApiStage implements HostedStage {
  readonly #o: HostedStageOptions;
  readonly #hosted: HostedApiTarget;
  /** Deferred cleanups by object id, completed when the journey tears the object down itself. */
  readonly #workloadIds = new Set<string>();
  #nodePoolId: string | undefined;
  #deploymentName: string | undefined;
  readonly #cleanups = new Map<string, CleanupRegistration>();
  /** Every hosted-API cleanup not yet completed, in registration order. */
  readonly #owed = new Map<CleanupRegistration, () => Promise<void>>();
  /** The released CLI with `fromRelease` until the walk upgrades; this tree's after. */
  #cli: Pick<CliClient, 'run'>;
  readonly #fetchFailures: FetchFailureCapture;

  constructor(options: HostedStageOptions, hosted: HostedApiTarget) {
    this.#o = options;
    this.#hosted = hosted;
    this.#cli = options.fromRelease?.cli ?? options.cli;
    this.#fetchFailures = new FetchFailureCapture(options.runner, hosted.url);
  }

  /** A cleanup through the hosted API, owed until it completes. */
  #defer(label: string, action: () => Promise<void>): CleanupRegistration {
    const deferred = this.#o.cleanup.defer(label, action);
    const owed = {
      complete: () => {
        this.#owed.delete(owed);
        deferred.complete();
      },
    };
    this.#owed.set(owed, action);
    return owed;
  }

  /**
   * The hosted API goes with the cluster, so a cleanup still owed when the
   * stack runs gets HTTP 530 (run 40934349682): run each now, newest first.
   */
  async settleCleanups(): Promise<void> {
    for (const [owed, action] of [...this.#owed].reverse()) {
      // An earlier action can complete a later registration.
      if (!this.#owed.has(owed)) continue;
      await action();
      owed.complete();
    }
  }

  /**
   * One CLI call against the hosted API. The CLI itself rides out an API
   * restart on every replayable call for about two minutes, inside
   * this timeout; nothing here retries. A `fetch failed` starts its probes
   * in the background, so the result and its timing are unchanged.
   */
  async #send(
    args: readonly string[],
    label: string,
    timeoutMs = 180_000,
    cli = this.#cli,
  ): Promise<CommandResult> {
    const result = await cli.run(args, {
      env: { API_URL: this.#hosted.url() },
      label: `hosted-${label}`,
      timeoutMs,
    });
    this.#fetchFailures.observe(result);
    return result;
  }

  /**
   * A bucket create, delete or list, rerun until `BUCKET_TIMEOUT_MS` while it
   * times out or fails transiently: the CLI gives up on its own after its 60 s
   * request timeout × 3 attempts, about 182 s, and the API memoizes
   * the throttled account lookup, so a later run joins it. Create and delete
   * are idempotent in the API, so a rerun finds the bucket created or gone
   * and succeeds. Any other failure returns at once; the deadline returns the
   * last result.
   */
  async #bucketCall(
    args: readonly string[],
    label: string,
  ): Promise<CommandResult> {
    let last: CommandResult | undefined;
    try {
      return await this.#o.wait.for(
        label,
        async (deadlineAt) =>
          (last = await this.#send(
            args,
            label,
            Math.max(1, deadlineAt - Date.now()),
          )),
        {
          timeoutMs: BUCKET_TIMEOUT_MS,
          intervalMs: 10_000,
          probeError: 'fail',
          unmet: (result) =>
            result.timedOut ||
            (result.exitCode !== 0 &&
              (TRANSIENT_FAILURE.test(result.combined) ||
                BUCKET_CALL_TIMED_OUT.test(result.combined)))
              ? `timed out: ${result.combined.trim().split('\n').at(-1) ?? ''}`
              : undefined,
        },
      );
    } catch (error) {
      if (error instanceof WaitTimeoutError && last) return last;
      throw error;
    }
  }

  /**
   * After a release reports applied and rolled out, the served endpoint can
   * still answer 503 through the edge for a few seconds; the next step waits
   * until `/v1/version` answers the expected version twice, five seconds apart.
   */
  async #awaitServedVersion(
    expected: string,
    budgetMs = SERVED_VERSION_BUDGET_MS,
  ): Promise<HostedVersion> {
    const sleep =
      this.#o.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = Date.now() + budgetMs;
    let consecutive = 0;
    let last: HostedVersion | null = null;
    // eslint-disable-next-line local/no-hand-written-retry-loops -- needs the expected version twice in a row, not one accepted probe
    while (Date.now() < deadline) {
      try {
        const version = await this.#hostedVersion();
        if (version.version === expected) {
          consecutive += 1;
          last = version;
          if (consecutive === 2) return version;
        } else {
          consecutive = 0;
        }
      } catch {
        consecutive = 0;
      }
      await sleep(SETTLE_GAP_MS);
    }
    throw new Error(
      `the hosted API did not serve ${expected} steadily through the edge within ${budgetMs / 1_000} s${last ? ` (last answer ${last.version})` : ''}`,
    );
  }

  /** A `--json` read (built by the caller) against the hosted API; `'absent'` when the object is gone. */
  async #read<T>(
    args: readonly string[],
    schema: z.ZodType<T>,
    label: string,
    absent?: RegExp,
  ): Promise<T | 'absent'> {
    const result =
      args[0] === 'bucket'
        ? await this.#bucketCall(args, label)
        : await this.#send(args, label);
    if (result.exitCode !== 0 && absent?.test(result.combined)) {
      return 'absent';
    }
    completedCommand(result, label);
    try {
      return schema.parse(JSON.parse(result.stdout));
    } catch (error) {
      throw new Error(`${label} returned invalid JSON`, { cause: error });
    }
  }

  #workloadStatus(id: string) {
    return this.#read(
      cliArgs(WORKLOAD_STATUS, { json: true }, [id]),
      workloadStatusResponseSchema,
      'workload-status',
      /\bWorkload not found\b/u,
    );
  }

  #nodePoolStatus(id: string) {
    return this.#read(
      cliArgs(NODE_POOL_STATUS, { json: true }, [id]),
      nodePoolSummarySchema,
      'node-pool-status',
      nodePoolAbsent(id),
    );
  }

  /** Pool status a `fromRelease` CLI can print: {@link createdNodePoolSchema}. */
  #releasedNodePoolStatus(id: string) {
    return this.#read(
      cliArgs(NODE_POOL_STATUS, { json: true }, [id]),
      createdNodePoolSchema,
      'node-pool-status',
      nodePoolAbsent(id),
    );
  }

  #poll<T>(
    label: string,
    read: () => Promise<T>,
    timeoutMs: number,
    unmet: (value: T) => string | undefined,
    reject?: (value: T) => string | undefined,
  ): Promise<T> {
    return this.#o.wait.for(label, read, {
      timeoutMs,
      intervalMs: 5_000,
      probeError: 'fail',
      unmet,
      ...(reject ? { reject } : {}),
    });
  }

  /**
   * `api use` and `credentials new` against the hosted API. With
   * `fromRelease` both run on the released CLI the cluster was bootstrapped
   * with, and the walk ends with this tree's `api upgrade` (returned) and the
   * credential saved before it decrypting after it; the access walk follows.
   * `beforeUpgrade` runs on the released CLI just before that upgrade.
   */
  async operatorWalk(
    beforeUpgrade?: () => Promise<void>,
  ): Promise<HostedReleaseRecord | undefined> {
    const { credential, fromRelease } = this.#o;
    const cli = this.#cli;
    // `api use <url>` probes the hostname through Cloudflare and saves it;
    // the installer's own target stays in force through its API_URL env.
    completedCommand(
      await cli.run(cliArgs(API_USE, {}, [this.#hosted.url()]), {
        label: 'hosted-api-use',
        timeoutMs: 60_000,
      }),
      'api use',
    );
    const saving = [
      credential,
      this.#o.backup?.credential,
      ...Object.values(this.#o.storage ?? {}).map((s) => s.credential),
    ];
    // A Lambda pool's AWS storage credential is the cluster's, saved once.
    for (const saved of new Map(saving.map((c) => [c?.name, c])).values()) {
      if (!saved) continue;
      completedCommand(
        await this.#send(
          credentialsNewArgs(saved.name, saved.material),
          'credentials-new',
          120_000,
          cli,
        ),
        'credentials new (hosted)',
      );
    }
    await beforeUpgrade?.();
    const upgraded = fromRelease ? await this.release() : undefined;
    if (upgraded) await this.#credentialDecrypts();
    await this.#accessWalk();
    return upgraded;
  }

  async roleApply(): Promise<void> {
    await roleApplyCheck(
      {
        send: (args, label, timeoutMs) => this.#send(args, label, timeoutMs),
        runner: this.#o.runner,
        artifacts: this.#o.artifacts,
        cleanup: this.#o.cleanup,
        env: process.env,
      },
      this.#hosted.url(),
    );
  }

  /**
   * `api access` against live GitHub: a user is shared under its immutable
   * ID, an organization is refused, and the user is removed again.
   */
  async #accessWalk(): Promise<void> {
    const listed = async () => {
      const access = await this.#read(
        cliArgs(API_ACCESS_LIST, { json: true }),
        apiAccessUsersResponseSchema,
        'api-access-list',
      );
      return access === 'absent' ? [] : access.users;
    };
    completedCommand(
      await this.#send(
        cliArgs(API_ACCESS_ADD, {}, [ACCESS_USER.username]),
        'api-access-add',
      ),
      'api access add (hosted)',
    );
    const shared = (await listed()).find(
      (user) => user.username === ACCESS_USER.username,
    );
    if (shared?.userId !== ACCESS_USER.userId) {
      throw new Error(
        `api access list shows ${ACCESS_USER.username} as ${shared?.userId ?? 'absent'}, expected GitHub ID ${ACCESS_USER.userId}`,
      );
    }
    rejectedCommand(
      await this.#send(
        cliArgs(API_ACCESS_ADD, {}, [ACCESS_ORG]),
        'api-access-add-org',
      ),
      'not a user account',
    );
    completedCommand(
      await this.#send(
        cliArgs(API_ACCESS_REMOVE, {}, [ACCESS_USER.username]),
        'api-access-remove',
      ),
      'api access remove (hosted)',
    );
    if ((await listed()).some((user) => user.userId === ACCESS_USER.userId)) {
      throw new Error(`api access remove left ${ACCESS_USER.username} listed`);
    }
  }

  /**
   * After a release, what was created before it survives: the pool Service
   * still runs under its id, and a saved credential still decrypts (`bucket
   * list` resolves it by name inside the API with its cipher key): the pool's,
   * or on a GCP, Azure or Lambda pool the AWS cluster's, under the same key.
   */
  async stateSurvives(serviceId: string): Promise<void> {
    // A short poll: the Service may reconcile briefly after the API restart.
    await this.#o.wait.for(
      `Service ${serviceId} running after the release`,
      () => this.#workloadStatus(serviceId),
      {
        timeoutMs: 120_000,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: (s) =>
          s !== 'absent' &&
          s.workload.id === serviceId &&
          s.workload.state === WorkloadState.Running
            ? undefined
            : `state ${s === 'absent' ? 'absent' : s.workload.state}`,
        reject: (s) =>
          s !== 'absent' && isTerminalState(s.workload.state)
            ? `Service ${serviceId} ended ${s.workload.state}`
            : undefined,
      },
    );
    await this.#credentialDecrypts();
  }

  /**
   * Listing buckets decrypts the credential inside the API; the list names the
   * API's backup bucket, which the API itself refuses to open.
   */
  async #credentialDecrypts(): Promise<void> {
    // A GCP, Azure or Lambda pool's credential can't list the AWS cluster's buckets;
    // the cluster's own credential, also saved, does (`backup`).
    const { credential, region } = this.#o.backup ?? {
      credential: this.#o.credential,
      region: this.#o.pool.region,
    };
    const list = cliArgs(BUCKET_LIST, {
      credentials: credential.name,
      ...(region ? { region } : {}),
      all: true,
      json: true,
    });
    const buckets = await this.#read(list, bucketEntriesSchema, 'bucket-list');
    const backup = this.#hosted.bucket();
    if (buckets === 'absent' || !buckets.entries.some((b) => b.name === backup))
      throw new Error(
        `bucket list with ${credential.name} does not list the API backup bucket ${backup}`,
      );
    rejectedCommand(
      await this.#send(
        [...list, backup, 'anycloud-api/'],
        'bucket-list-backup',
      ),
      `Bucket "${backup}" is this API's own backup bucket`,
    );
  }

  /** NVIDIA GPUs on each of the pool's Nodes (0 on a CPU pool). */
  #poolGpus(): number {
    const capability = gpuCapabilityForVMType(
      this.#o.credential.material.cloudProvider,
      this.#o.pool.vmTypes[0],
    );
    return capability.kind === 'nvidia' ? (capability.count ?? 0) : 0;
  }

  /**
   * The GPU journey sizes its pool (`gpu_replicas`). On a GPU pool (Lambda's
   * GPU list) the release journey runs two VMs: every workload takes a
   * Node's GPUs by default, and the Service runs beside one Deployment.
   */
  #poolVms(): number {
    if (this.#o.gpu) return this.#o.replicas ?? 1;
    return this.#poolGpus() > 0 ? 2 : 1;
  }

  /**
   * The scale stage's burst needs `burst` new Nodes, two or one on a GPU
   * pool, and `--max-vms` leaves room for one more, so a double buy shows
   * rather than stopping at the clamp. A released API admits only equal
   * bounds; two GPU replicas leave a Node from before the burst idle, which
   * scale-in rightly takes first. Those pools stay fixed-size.
   */
  #poolBounds(): { min: number; max: number; burst: number } {
    if (this.#o.singleVm) return { min: 1, max: 1, burst: 0 };
    const min = this.#poolVms();
    if (this.#o.fromRelease || (this.#o.gpu && min > 1)) {
      return { min, max: min, burst: 0 };
    }
    const burst = this.#o.gpu ? 1 : 2;
    return { min, max: min + burst + 1, burst };
  }

  /** `node-pool create` through the hosted API, waited to ready. */
  /** `onCreated` hears the pool's id before the ready wait, so a pool that never gets ready is still swept. */
  async createReadyNodePool(
    onCreated: (nodePoolId: string) => void,
  ): Promise<string> {
    const { pool } = this.#o;
    const name = this.#o.names.nodePool('hosted');
    const { min, max } = this.#poolBounds();
    this.#nodePoolId = name;
    const id = await this.#createPool(name, {
      vmTypes: pool.vmTypes,
      minVms: min,
      maxVms: max,
      ...(pool.spot ? { spot: true } : {}),
      onCreated,
    });
    this.#nodePoolId = id;
    return id;
  }

  /**
   * A live check's own pool in the journey pool's cloud and, by default,
   * region. It fails at the first capacity or quota error instead of
   * waiting through the product's retries: a check is no reason to queue.
   */
  checkPool(
    label: string,
    spec: {
      readonly vmTypes: readonly string[];
      readonly minVms: number;
      readonly maxVms: number;
      readonly diskSizeGb?: number;
      readonly region?: string | undefined;
      readonly privilegedJobs?: boolean;
      readonly userNamespaceJobs?: boolean;
      readonly requireNestedVirtualization?: boolean;
    },
    onCreated: (nodePoolId: string) => void,
  ): Promise<string> {
    return this.#createPool(this.#o.names.nodePool(label), {
      ...spec,
      onCreated,
      refuseCapacity: true,
    });
  }

  async #createPool(
    name: string,
    spec: {
      readonly vmTypes: readonly string[];
      readonly minVms: number;
      readonly maxVms: number;
      readonly diskSizeGb?: number;
      readonly region?: string | undefined;
      readonly spot?: boolean;
      readonly privilegedJobs?: boolean;
      readonly userNamespaceJobs?: boolean;
      readonly requireNestedVirtualization?: boolean;
      readonly onCreated: (nodePoolId: string) => void;
      readonly refuseCapacity?: boolean;
    },
  ): Promise<string> {
    const { pool, credential, timeouts } = this.#o;
    const region = spec.region ?? pool.region;
    // Cleanup deletes through the hosted API and waits until the pool is
    // gone: `cluster delete` (deferred earlier, so it runs later) is refused
    // while the hosted API still manages a pool (F run 15).
    const registration = this.#defer(`hosted node pool ${name}`, () =>
      this.deleteNodePool(name),
    );
    const created = createdNodePoolSchema.parse(
      JSON.parse(
        completedCommand(
          await this.#send(
            cliArgs(
              NODE_POOL_CREATE,
              {
                credentials: credential.name,
                ...(region ? { region } : {}),
                'vm-type': [...spec.vmTypes],
                ...(spec.spot ? { spot: true } : {}),
                ...(spec.privilegedJobs
                  ? { 'allow-privileged-jobs': true }
                  : {}),
                'user-namespace-jobs': spec.userNamespaceJobs,
                'require-nested-virtualization':
                  spec.requireNestedVirtualization,
                ...(spec.diskSizeGb
                  ? { 'disk-size': String(spec.diskSizeGb) }
                  : {}),
                'min-vms': String(spec.minVms),
                'max-vms': String(spec.maxVms),
                json: true,
              },
              [name],
            ),
            'node-pool-create',
          ),
          'node-pool create (hosted)',
        ),
      ),
    );
    spec.onCreated(created.id);
    // The journey deletes by id; the cleanup was registered by name.
    this.#cleanups.set(created.id, registration);
    await this.#poll(
      `hosted node pool ${created.id} to be ready`,
      () => this.#releasedNodePoolStatus(created.id),
      timeouts.nodePoolMs,
      (p) =>
        p !== 'absent' && p.state === WorkloadState.Running
          ? undefined
          : `state ${p === 'absent' ? 'absent' : `${p.state}${p.lastError ? `: ${p.lastError}` : ''}`}`,
      (p) =>
        p !== 'absent' &&
        (p.state === WorkloadState.Failed ||
          (spec.refuseCapacity && CAPACITY_ERROR.test(p.lastError ?? '')))
          ? `node pool failed: ${p.lastError ?? ''}`
          : undefined,
    );
    return created.id;
  }

  /**
   * `anycloud service --node-pool` through the hosted API, waited to running;
   * on a GPU pool the Service runs `GPU_SERVICE_COMMAND`.
   */
  async runService(nodePoolId: string, label = 'service'): Promise<string> {
    const { gpu, service, timeouts, names } = this.#o;
    const id = names.workload(label);
    this.#workloadIds.add(id);
    this.#cleanups.set(
      id,
      this.#defer(`hosted Service ${id}`, () => this.terminate(id, 'Service')),
    );
    const created = await this.#send(
      cliArgs(
        SERVICE_CREATE,
        {
          'node-pool': nodePoolId,
          id,
          // The product probes `$PORT`; the image must be told where it listens.
          env: [`PORT=${String(service.port)}`],
        },
        [gpu ? GPU_SERVICE_IMAGE : service.image],
        gpu ? GPU_SERVICE_COMMAND : [],
      ),
      'service-create',
    );
    completedCommand(created, 'service (hosted)');
    if (!created.combined.includes(`ID: ${id}`)) {
      throw new Error(`service did not acknowledge ${id}: ${created.combined}`);
    }
    await this.#poll(
      `hosted Service ${id} to be running`,
      () => this.#workloadStatus(id),
      timeouts.workloadMs,
      (s) =>
        s !== 'absent' && s.workload.state === WorkloadState.Running
          ? undefined
          : `state ${s === 'absent' ? 'absent' : s.workload.state}`,
      (s) =>
        s !== 'absent' && s.workload.state === WorkloadState.Failed
          ? 'Service failed'
          : undefined,
    );
    return id;
  }

  /**
   * RFC 0048's scale stage beside a running Service (its own when
   * `serviceId` is undefined): one pool Job per Node the burst needs, each
   * taking over half a Node. Its passes buy exactly those Nodes, in one pass
   * once it saw every Job pending (S1). The first Job outlives the idle
   * window, so scale-in keeps its busy Node (not the ingress entry) while the
   * other Nodes go; no Job is retried, and the pool is then back at
   * `--min-vms` with its Service running (S3). Null on a fixed-size pool.
   */
  async scalePool(
    nodePoolId: string,
    serviceId: string | undefined,
    observe: () => Promise<unknown>,
  ): Promise<Omit<HostedScaleRecord, 'before' | 'launched' | 'kept'> | null> {
    const { min, max, burst } = this.#poolBounds();
    if (min === max) return null;
    const { credential, names, pool, storage, timeouts } = this.#o;
    const service = serviceId ?? (await this.runService(nodePoolId, 'scale'));
    const gpus = this.#poolGpus();
    const vcpus = getVCPUsForVMType(
      pool.vmTypes[0],
      credential.material.cloudProvider,
    );
    if (gpus === 0 && vcpus === undefined) {
      throw new Error(`the catalog has no vCPU count for ${pool.vmTypes[0]}`);
    }
    const capacity = (p: NodePoolSummary | 'absent') =>
      p === 'absent' ? 'absent' : JSON.stringify(p.capacity);
    const settledAt = (p: NodePoolSummary | 'absent', vms: number) =>
      p !== 'absent' &&
      p.capacity.readyVmCount === vms &&
      p.capacity.startingVmCount === 0 &&
      p.capacity.drainingVmCount === 0;
    const retried = (s: WorkloadStatusResponse | 'absent') =>
      s !== 'absent' &&
      s.events.some((e) => e.state === WorkloadState.Retrying);
    const completedOnce = async (id: string, timeoutMs?: number) => {
      const done = await this.#awaitJob(
        id,
        WorkloadState.Completed,
        true,
        timeoutMs,
      );
      if (retried(done)) {
        throw new Error(`pool Job ${id} was retried: ${JSON.stringify(done)}`);
      }
      this.#cleanups.get(id)?.complete();
    };
    const jobIds = Array.from({ length: burst }, (_, i) =>
      names.workload(`scale-${String(i)}`),
    );
    const [longJobId, ...shortJobIds] = jobIds as [string, ...string[]];
    const poolRead = async () => {
      await observe();
      return this.#nodePoolStatus(nodePoolId);
    };
    const prior = await this.#nodePoolStatus(nodePoolId);
    const priorAt =
      prior === 'absent' ? undefined : prior.capacity.lastScaleOut?.at;
    const submit = async (id: string, seconds: number | 'infinity') => {
      this.#workloadIds.add(id);
      this.#cleanups.set(
        id,
        this.#defer(`hosted Job ${id}`, () => this.terminate(id, 'Job')),
      );
      const created = await this.#send(
        cliArgs(
          JOB_CREATE,
          {
            id,
            'node-pool': nodePoolId,
            ...(gpus > 0
              ? { gpus: String(gpus), cpus: '0.1' }
              : { cpus: (vcpus! * 0.6).toFixed(1) }),
            // A spot pool's managed checkpoint bucket needs an account.
            ...(pool.spot && storage?.checkpoint
              ? {
                  'checkpoint-storage-credentials':
                    storage.checkpoint.credential.name,
                  'checkpoint-storage-region': storage.checkpoint.region,
                }
              : {}),
          },
          [GPU_SERVICE_IMAGE],
          ['sleep', String(seconds)],
        ),
        'job-create-scale',
      );
      completedCommand(created, 'job --node-pool (hosted scale)');
    };
    // Fillers take the room the pool already has, so every burst Job pends:
    // one Job beside the Service on a CPU Node, or each GPU Node the Service
    // left idle (run 40074196755 placed a burst Job there). They hold it
    // until scale-in ends, so it never takes a Node from before the burst.
    const fillers = Array.from({ length: gpus === 0 ? 1 : min - 1 }, (_, i) =>
      names.workload(`scale-filler-${String(i)}`),
    );
    await Promise.all(fillers.map((id) => submit(id, 'infinity')));
    for (const id of fillers) {
      await this.#awaitJob(id, WorkloadState.Running, false);
    }
    // Submitted together, so one pass can see every replica Pending.
    await Promise.all(
      jobIds.map((id) =>
        submit(
          id,
          id === longJobId ? SCALE_LONG_JOB_SECONDS : SCALE_JOB_SECONDS,
        ),
      ),
    );
    // Passes run every 30 s; reads every 5 s see each one's purchase.
    const passes = new Map<number, HostedScaleRecord['scaleOuts'][number]>();
    let quota: string | undefined;
    await this.#poll(
      `hosted node pool ${nodePoolId} to scale out to ${String(min + burst)} VMs`,
      async () => {
        const p = await poolRead();
        const last = p === 'absent' ? undefined : p.capacity.lastScaleOut;
        if (last && last.at !== priorAt) passes.set(last.at, last);
        if (p !== 'absent' && QUOTA_ERROR.test(p.lastError ?? ''))
          quota ??= p.lastError!;
        return p;
      },
      timeouts.nodePoolMs,
      (p) =>
        p !== 'absent' && p.capacity.readyVmCount === min + burst
          ? undefined
          : capacity(p),
      (p) =>
        p !== 'absent' &&
        p.capacity.readyVmCount + p.capacity.startingVmCount > min + burst
          ? `bought beyond the burst's ${String(burst)} VMs: ${capacity(p)}`
          : undefined,
    );
    const scaledAt = Date.now();
    const scaleOuts = [...passes.values()].sort((a, b) => a.at - b.at);
    const bought = scaleOuts.reduce((sum, pass) => sum + pass.vms, 0);
    if (
      bought !== burst ||
      ((scaleOuts[0]?.pendingPods ?? 0) >= burst && scaleOuts.length !== 1)
    ) {
      // A quota refusal's backoff passes still record a scale-out.
      throw new Error(
        quota
          ? `environmental: a launch in the burst hit a cloud quota, so its scale-outs ${JSON.stringify(scaleOuts)} don't count purchases: ${quota}`
          : `the burst should buy ${String(burst)} VMs, in one pass once it saw every Job pending; scale-outs ${JSON.stringify(scaleOuts)}`,
      );
    }
    for (const id of shortJobIds) await completedOnce(id);
    // A Job stays Queued, then Syncing, until its runner reports.
    await this.#awaitJob(longJobId, WorkloadState.Running, false);
    // Past an idle window since the long Job's Node joined, only that busy
    // Node is left beside the pool's own: the short Jobs' Nodes went.
    await this.#poll(
      `hosted node pool ${nodePoolId} to keep only Job ${longJobId}'s Node past the idle window`,
      async () =>
        [await poolRead(), await this.#workloadStatus(longJobId)] as const,
      SCALE_IN_IDLE_WINDOW_MS + timeouts.nodePoolMs,
      ([p]) =>
        Date.now() - scaledAt >= SCALE_IN_IDLE_WINDOW_MS + SCALE_IN_SLACK_MS &&
        settledAt(p, min + 1)
          ? undefined
          : capacity(p),
      ([, job]) =>
        job === 'absent' ||
        job.workload.state !== WorkloadState.Running ||
        retried(job)
          ? `Job ${longJobId} stopped running or was retried: ${job === 'absent' ? 'absent' : JSON.stringify(job.events)}`
          : undefined,
    );
    await completedOnce(longJobId, SCALE_LONG_JOB_SECONDS * 1000);
    await this.#poll(
      `hosted node pool ${nodePoolId} to scale in to ${String(min)} VMs`,
      poolRead,
      SCALE_IN_IDLE_WINDOW_MS + timeouts.nodePoolMs,
      (p) => (settledAt(p, min) ? undefined : capacity(p)),
    );
    const kept = await this.#workloadStatus(service);
    if (kept === 'absent' || kept.workload.state !== WorkloadState.Running) {
      throw new Error(
        `Service ${service} did not keep running through scale-in: ${kept === 'absent' ? 'absent' : kept.workload.state}`,
      );
    }
    for (const id of fillers) await this.terminate(id, 'Job');
    if (!serviceId) await this.terminate(service, 'Service');
    return {
      minVms: min,
      maxVms: max,
      burstVms: burst,
      jobIds,
      longJobId,
      scaleOuts,
    };
  }

  #deploymentStatus(name: string) {
    return this.#read(
      cliArgs(DEPLOYMENT_STATUS, { json: true }, [name]),
      deploymentSummarySchema,
      'deployment-status',
      /\bDeployment not found\b/u,
    );
  }

  /** A Job through `--deployment` until its terminal state and cleanup are recorded. */
  async #submitToDeployment(id: string, deployment: string): Promise<void> {
    this.#workloadIds.add(id);
    this.#cleanups.set(
      id,
      this.#defer(`hosted Job ${id}`, () => this.terminate(id, 'Job')),
    );
    const created = await this.#send(
      cliArgs(JOB_CREATE, { deployment, id }),
      'job-create-targeted',
    );
    completedCommand(created, 'job --deployment (hosted)');
  }

  #awaitJob(
    id: string,
    state: WorkloadState,
    cleaned: boolean,
    timeoutMs = this.#o.timeouts.workloadMs,
  ) {
    return this.#poll(
      `hosted Job ${id} to be ${state}${cleaned ? ' and cleaned up' : ''}`,
      () => this.#workloadStatus(id),
      timeoutMs,
      (s) =>
        s !== 'absent' &&
        s.workload.state === state &&
        (!cleaned || typeof s.workload.cleanedAt === 'number')
          ? undefined
          : `state ${s === 'absent' ? 'absent' : `${s.workload.state}, cleanedAt ${String(s.workload.cleanedAt)}`}`,
      (s) =>
        s !== 'absent' &&
        s.workload.state !== state &&
        isTerminalState(s.workload.state)
          ? `Job ended ${s.workload.state}`
          : undefined,
    );
  }

  /**
   * RFC 0043 S1 and S6 on an Azure pool, S17 on S3 and GCS on an AWS and a
   * GCP pool, and S20 on a Lambda pool with input on GCS, output on S3 and
   * checkpoint in Azure: a Job with `--node-pool`, an input, an output and a
   * checkpoint bucket checks its staged input, copies it to its output and
   * checkpoint, and fails if a storage credential (`STORAGE_CREDENTIAL`) is in
   * its env, its files or a mounted Secret. Once it completes, neither its log
   * nor a Secret in the node pool's namespace (`secretsWithCredential`) holds
   * one, and the output and checkpoint buckets hold the copy only under
   * `<job-id>/`. Every bucket call goes through the hosted API's `bucket`
   * verbs with the role's own credential, so the API creates (the input and
   * checkpoint here, the output at admission) and owns them under its
   * persisted identity; the stage deletes them. A role with a storage
   * credential names it; the others sign with the pool's own.
   *
   * On a spot pool the Job has no `--checkpoint-bucket`: 0043/S13 on Azure,
   * S21 on S3 and GCS, and S16 on AWS with an Azure storage credential. Its
   * managed bucket holds its first attempt's checkpoint when its Pod is
   * deleted; only a restore lets the retry finish, and the bucket goes with
   * the Job.
   */
  async poolJobStorage(
    nodePoolId: string,
    secretsWithCredential: () => Promise<readonly string[]>,
    deletePod: (podUid: string) => Promise<void>,
  ): Promise<HostedPoolJobStorageRecord | null> {
    const { credential, names, pool, storage = {}, timeouts } = this.#o;
    // Lambda's credential provides no storage, so its Job names one per role.
    const own =
      credential.material.cloudProvider === CloudType.Lambda
        ? undefined
        : { credential, region: pool.region };
    const signers = Object.fromEntries(
      STORAGE_ROLES.map((role) => [role, storage[role] ?? own]),
    ) as Partial<Record<StorageRole, typeof own>>;
    const where = (role: StorageRole) => {
      const signer = signers[role]!;
      return {
        credentials: signer.credential.name,
        ...(signer.region ? { region: signer.region } : {}),
      };
    };
    if (STORAGE_ROLES.some((role) => !signers[role])) return null;
    const named = Object.fromEntries(
      Object.entries(storage).flatMap(([role, signer]) => [
        [`${role}-storage-credentials`, signer.credential.name],
        [`${role}-storage-region`, signer.region],
      ]),
    );
    const bucket = async (args: readonly string[], label: string) => {
      // An upload or download takes the native path, outside that 60 s budget.
      const result =
        args[1] === 'upload' || args[1] === 'download'
          ? await this.#send(args, label, BUCKET_TIMEOUT_MS)
          : await this.#bucketCall(args, label);
      completedCommand(result, `${label} (hosted)`);
      return result;
    };
    const jobId = names.workload('storage');
    // `<ms>-<4>`, as ci/cleanup/e2e-cluster-stale-ids.ts parses: the
    // workflow's Azure sweep reclaims them once stale.
    const suffix = `${Date.now()}-${randomUUID().slice(0, 4)}`;
    const inputBucket = `e2e-clust-in-${suffix}`;
    const outputBucket = `e2e-clust-out-${suffix}`;
    // A spot pool's Job checkpoints to its managed bucket instead.
    const checkpointBucket = pool.spot ? undefined : `e2e-clust-ck-${suffix}`;
    const containers = (
      [
        ['input', inputBucket],
        ['output', outputBucket],
        ['checkpoint', checkpointBucket],
      ] as const
    ).filter(
      (entry): entry is readonly [StorageRole, string] =>
        entry[1] !== undefined,
    );
    const probe = randomUUID();
    const local = await mkdtemp(path.join(tmpdir(), 'pool-job-storage-'));
    // Every delete runs even when one fails.
    const deleteContainers = async () => {
      const deleted = await Promise.allSettled(
        containers.map(([role, name]) =>
          bucket(cliArgs(BUCKET_DELETE, where(role), [name]), 'bucket-delete'),
        ),
      );
      await rm(local, { recursive: true, force: true });
      const failed = deleted.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    };
    const deferred = this.#defer(`buckets of ${jobId}`, deleteContainers);
    for (const [role, name] of containers.filter(([r]) => r !== 'output')) {
      await bucket(
        cliArgs(BUCKET_CREATE, where(role), [name]),
        'bucket-create',
      );
    }
    await writeFile(path.join(local, 'probe.txt'), probe);
    await bucket(
      cliArgs(BUCKET_UPLOAD, where('input'), [
        inputBucket,
        path.join(local, 'probe.txt'),
        'probe.txt',
      ]),
      'bucket-upload',
    );
    this.#workloadIds.add(jobId);
    this.#cleanups.set(
      jobId,
      this.#defer(`hosted Job ${jobId}`, () => this.terminate(jobId, 'Job')),
    );
    const script = [
      'set -e',
      ...(pool.spot
        ? [
            'if [ ! -f /mnt/checkpoint/s13 ]; then echo 1 > /mnt/checkpoint/s13; sleep 3600; fi',
          ]
        : []),
      `test "$(cat /mnt/input/probe.txt)" = ${probe}`,
      'cp /mnt/input/probe.txt /mnt/output/probe.txt',
      'cp /mnt/input/probe.txt /mnt/checkpoint/probe.txt',
      `if env | grep -qE '${STORAGE_CREDENTIAL_PATTERN}'; then echo 'storage credential in env'; exit 1; fi`,
      // A match with a read error exits 2, so the decision is on the output.
      `if grep -rlsE '${STORAGE_CREDENTIAL_PATTERN}' /mnt /etc /tmp /root /var/run/secrets | grep -q .; then echo 'storage credential in a file'; exit 1; fi`,
      `echo ${STORAGE_PROBE_DONE}`,
    ].join('\n');
    completedCommand(
      await this.#send(
        cliArgs(
          JOB_CREATE,
          {
            id: jobId,
            'node-pool': nodePoolId,
            cpus: '0.1',
            // A GPU pool's Jobs each take one of its GPUs.
            ...(this.#poolGpus() > 0 ? { gpus: '1' } : {}),
            'input-bucket': inputBucket,
            'output-bucket': outputBucket,
            ...(checkpointBucket && { 'checkpoint-bucket': checkpointBucket }),
            ...named,
          },
          [GPU_SERVICE_IMAGE],
          ['sh', '-c', script],
        ),
        'job-create-storage',
      ),
      'job --node-pool with buckets (hosted)',
    );
    if (pool.spot) {
      const live = await this.#poll(
        `${jobId}'s periodic upload to its managed checkpoint bucket`,
        () => this.#workloadStatus(jobId),
        timeouts.workloadMs,
        (s) =>
          s !== 'absent' &&
          s.checkpoint?.bucket === jobId &&
          !s.checkpoint.retained &&
          (s.checkpoint.health?.objects ?? 0) > 0
            ? undefined
            : JSON.stringify(s === 'absent' ? s : (s.checkpoint ?? null)),
      );
      const pod =
        live === 'absent'
          ? undefined
          : // The claim's `syncing` event names the replica's Pod.
            live.events.findLast((e) => e.state === WorkloadState.Syncing)
              ?.metadata?.podUid;
      if (typeof pod !== 'string')
        throw new Error(`${jobId} did not identify its replica`);
      await deletePod(pod);
    }
    const status = await this.#poll(
      `hosted bucketed pool Job ${jobId} to complete`,
      () => this.#workloadStatus(jobId),
      timeouts.workloadMs,
      (s) =>
        s !== 'absent' && s.workload.state === WorkloadState.Completed
          ? undefined
          : `state ${s === 'absent' ? 'absent' : s.workload.state}`,
      (s) =>
        s !== 'absent' &&
        s.workload.state !== WorkloadState.Completed &&
        isTerminalState(s.workload.state)
          ? `ended ${s.workload.state}: ${JSON.stringify(s.events.at(-1)?.metadata ?? {})}`
          : undefined,
    );
    await this.#o.artifacts.json('hosted-pool-job-storage', status);
    const log = await this.#send(
      cliArgs(WORKLOAD_LOGS, {}, [jobId]),
      'job-logs-storage',
    );
    completedCommand(log, `logs ${jobId}`);
    // The marker proves the log read covers the Job's own output.
    if (!log.stdout.includes(STORAGE_PROBE_DONE)) {
      throw new Error(`the log of ${jobId} lacks its output: ${log.combined}`);
    }
    if (STORAGE_CREDENTIAL.test(log.combined)) {
      throw new Error(`the log of ${jobId} holds a storage credential`);
    }
    const secrets = await secretsWithCredential();
    if (secrets.length > 0) {
      throw new Error(
        `Secrets in node pool ${nodePoolId}'s namespace hold a storage credential: ${secrets.join(', ')}`,
      );
    }
    // The copy, under the Job's prefix and nowhere else.
    const uploaded = async (container: string, role: StorageRole) => {
      const copy = path.join(local, `${role}.txt`);
      await bucket(
        cliArgs(BUCKET_DOWNLOAD, where(role), [
          container,
          `${jobId}/probe.txt`,
          copy,
        ]),
        'bucket-download',
      );
      const copied = await readFile(copy, 'utf8');
      if (copied !== probe) {
        throw new Error(
          `${jobId} uploaded ${copied} to its ${role}, not its staged input`,
        );
      }
      const listed = await bucket(
        cliArgs(
          BUCKET_LIST,
          { ...where(role), recursive: true, all: true, json: true },
          [container],
        ),
        `bucket-list-${role}`,
      );
      const objects = objectEntriesSchema
        .parse(JSON.parse(listed.stdout))
        .entries.filter((entry) => entry.kind === 'object')
        .map((entry) => entry.key);
      if (objects.some((key) => !key.startsWith(`${jobId}/`))) {
        throw new Error(
          `${jobId} uploaded outside its prefix: ${objects.join(', ')}`,
        );
      }
      return objects;
    };
    const outputObjects = await uploaded(outputBucket, 'output');
    const checkpointObjects = checkpointBucket
      ? await uploaded(checkpointBucket, 'checkpoint')
      : [];
    await this.terminate(jobId, 'Job');
    if (pool.spot) {
      await this.#poll(
        `${jobId}'s managed checkpoint bucket to be deleted`,
        () =>
          this.#read(
            cliArgs(BUCKET_LIST, { ...where('checkpoint'), json: true }, [
              jobId,
            ]),
            z.unknown(),
            'bucket-list-managed',
            /\bBucket not found\b/u,
          ),
        timeouts.workloadMs,
        (listed) => (listed === 'absent' ? undefined : 'still listed'),
      );
    }
    await deleteContainers();
    deferred.complete();
    return {
      jobId,
      inputBucket,
      outputBucket,
      checkpointBucket: checkpointBucket ?? null,
      outputObjects,
      checkpointObjects,
    };
  }

  /**
   * Jobs on the node pool: a Deployment of the receiver through the hosted
   * API, one Job it completes, and one it holds until `terminate`, whose
   * cleanup only the receiver can acknowledge (its Pod is still there). The
   * native evidence is the API's own read of the Kubernetes Deployment: one
   * observed Pod and container ran both Jobs, and the Deployment is then
   * deleted before the pool, unless `keepDeployment` leaves it for host loss.
   * On a GPU pool a canary Job must also error with its checked evidence; the
   * voice workload replaces the one held Job with three at concurrency 2.
   */
  async poolJobs(
    nodePoolId: string,
    keepDeployment = false,
  ): Promise<HostedPoolJobsRecord> {
    const { gpu, names, timeouts } = this.#o;
    const name = names.deployment('receiver');
    const job = (
      behavior:
        | 'complete'
        | 'hold'
        | 'mace-canary'
        | 'voice-canary'
        | 'voice-canary-2',
    ) => names.workload(behavior);
    const canary = gpu === 'voice' ? job('voice-canary') : job('mace-canary');
    // The second voice canary runs beside a held session.
    const canaries =
      gpu === 'voice' ? `${canary},${job('voice-canary-2')}` : canary;
    const profile = {
      mace: ['mace-cuda', 'E2E_MACE_CANARY_JOB_IDS'],
      voice: ['voice', 'E2E_VOICE_CANARY_JOB_IDS'],
    } as const;
    this.#deploymentName = name;
    this.#cleanups.set(
      name,
      this.#defer(`hosted Deployment ${name}`, () =>
        this.#deleteDeployment(name),
      ),
    );
    completedCommand(
      await this.#send(
        cliArgs(
          DEPLOYMENT_CREATE,
          {
            'node-pool': nodePoolId,
            env: [
              `E2E_COMPLETE_JOB_IDS=${[job('complete'), names.workload('after-loss'), ...this.#upgradeJobIds()].join()}`,
              `E2E_FRESH_REPLICA_COMPLETE_JOB_IDS=${names.workload('replica-loss')}`,
              'E2E_EGRESS_PROBE=1',
              ...(this.#o.credential.material.cloudProvider === CloudType.Azure
                ? ['E2E_WIRESERVER_PROBE=1']
                : []),
              ...(gpu
                ? [
                    'E2E_REQUIRE_GPU=1',
                    `E2E_WORKLOAD_PROFILE=${profile[gpu][0]}`,
                    `${profile[gpu][1]}=${canaries}`,
                  ]
                : []),
            ],
            ...(this.#o.replicas === 2 ? { replicas: '2' } : {}),
            // Two voice sessions share the warm model; a third must wait.
            ...(gpu === 'voice'
              ? {
                  'max-concurrent-jobs-per-replica':
                    this.#o.replicas === 2 ? '1' : '2',
                }
              : {}),
            json: true,
          },
          [name, await this.prepareReceiverImage()],
        ),
        'deployment-create',
      ),
      'deployment create (hosted)',
    );
    const ready = await this.#awaitDeploymentPod(name);
    // A GPU pool's Deployment takes the Node's devices by default; its Pod
    // then schedules only where the Node advertises nvidia.com/gpu.
    const expectedGpus = gpu ? 1 : this.#poolGpus();
    if (ready.gpuCount !== expectedGpus) {
      throw new Error(
        `Deployment ${name} was admitted with ${ready.gpuCount} GPUs on a pool whose Nodes have ${expectedGpus}`,
      );
    }
    const pod = observed(ready)!;
    const egress = egressProbeEvidence(
      await this.#deploymentLog(name, 'EGRESS_PROBE '),
      this.#o.credential.material.cloudProvider,
    );
    await this.#submitToDeployment(job('complete'), name);
    const completed = await this.#awaitJob(
      job('complete'),
      WorkloadState.Completed,
      true,
    );
    if (completed === 'absent')
      throw new Error(`hosted Job ${job('complete')} is gone`);
    const imagePull = completed.events
      .map((e) => e.metadata?.imagePull)
      .find(isImagePullTelemetry);
    this.#cleanups.get(job('complete'))?.complete();
    const canaryJob = gpu ? await this.#canaryJob(canary, name) : undefined;
    const maceCanary =
      gpu === 'mace' && canaryJob
        ? {
            jobId: canary,
            ...maceCanaryEvidence(canaryJob.message),
            claimMs: canaryJob.claimMs,
          }
        : undefined;
    const voiceCanary =
      gpu === 'voice' && canaryJob
        ? {
            jobId: canary,
            ...voiceCanaryEvidence(canaryJob.message),
            claimMs: canaryJob.claimMs,
          }
        : undefined;
    const voiceSessions =
      voiceCanary && this.#o.replicas !== 2
        ? await this.#voiceSessions(name, job('voice-canary-2'))
        : undefined;
    if (
      voiceSessions &&
      voiceSessions.besideCanary.modelLoadId !== voiceCanary?.modelLoadId
    ) {
      throw new Error(
        `the voice canaries came from different model loads: ${voiceCanary?.modelLoadId ?? ''} and ${voiceSessions.besideCanary.modelLoadId}`,
      );
    }
    if (!voiceSessions) {
      await this.#submitToDeployment(job('hold'), name);
      await this.#awaitJob(job('hold'), WorkloadState.Running, false);
      await this.#cancel(job('hold'));
    }
    const jobCount = voiceSessions ? 6 : gpu ? 3 : 2;
    const after = await this.#poll(
      `hosted Deployment ${name} to release its ${jobCount} Jobs on Pod ${pod.podUid ?? ''}`,
      () => this.#deploymentStatus(name),
      timeouts.workloadMs,
      (s) =>
        observed(s) &&
        s !== 'absent' &&
        s.jobs.unreleased === 0 &&
        s.jobs.terminal >= jobCount
          ? undefined
          : summarize(s),
      (s) => {
        const now = observed(s);
        return s === 'absent' ||
          (now &&
            (now.podUid !== pod.podUid || now.containerId !== pod.containerId))
          ? `the Jobs left the observed Pod ${pod.podUid ?? ''}: ${summarize(s)}`
          : undefined;
      },
    );
    await this.#o.artifacts.json('hosted-pool-jobs', { ready, after, egress });
    if (!keepDeployment) await this.#deleteDeployment(name);
    return {
      deploymentId: ready.id,
      podUid: pod.podUid!,
      egress,
      completedJobId: job('complete'),
      // A GPU receiver claims `complete` while its model loads; its canaries
      // carry the warm claim.
      ...(gpu ? {} : { claimMs: claimMs(completed) }),
      ...(imagePull ? { imagePull } : {}),
      cancelledJobId: voiceSessions?.cancelledJobId ?? job('hold'),
      ...(maceCanary ? { maceCanary } : {}),
      ...(voiceCanary ? { voiceCanary } : {}),
      ...(voiceSessions ? { voiceSessions } : {}),
    };
  }

  /**
   * Deployment named Secrets through the hosted API: the receiver's
   * replica logs the digest of the Secret's value (fixtures/deployment.py),
   * its status shows the Secret's name and never the value, and a non-forced
   * delete is refused (409) while it references the Secret. Rotating the
   * value, then removing its key, reaches the Pod each `deployment upgrade`
   * starts; once the Deployment is deleted the Secret deletes without
   * `--force`. Every value is registered for redaction before it is sent.
   */
  async deploymentSecret(nodePoolId: string): Promise<readonly string[]> {
    const { names, redactor } = this.#o;
    const secret = names.secret('hosted');
    const name = names.deployment('secret');
    const save = async (entry: string) =>
      completedCommand(
        await this.#send(
          cliArgs(SECRETS_NEW, {}, [secret, entry]),
          'secrets-new',
        ),
        'secrets new (hosted)',
      );
    const value = () => {
      const generated = `anycloud-hosted-secret-${randomUUID()}`;
      redactor.add(generated);
      return generated;
    };
    const digest = (text: string) =>
      createHash('sha256').update(text).digest('hex');
    const first = value();
    await save(`${NAMED_SECRET_PROBE_KEY}=${first}`);
    // LIFO: a cleanup deletes the Deployment before its Secret.
    const secretCleanup = this.#defer(`hosted Secret ${secret}`, async () => {
      await this.#send(
        cliArgs(SECRETS_DELETE, { force: true }, [secret]),
        'secrets-delete-cleanup',
      );
    });
    this.#cleanups.set(
      name,
      this.#defer(`hosted Deployment ${name}`, () =>
        this.#deleteDeployment(name),
      ),
    );
    completedCommand(
      await this.#send(
        cliArgs(
          DEPLOYMENT_CREATE,
          {
            'node-pool': nodePoolId,
            // Any id: the receiver holds no reservation store.
            env: ['E2E_COMPLETE_JOB_IDS=none'],
            secret: [secret],
            json: true,
          },
          [name, await this.prepareReceiverImage()],
        ),
        'deployment-create-secret',
      ),
      'deployment create --secret (hosted)',
    );
    const pods = [observed(await this.#awaitDeploymentPod(name))!.podUid!];
    await this.#deploymentLog(name, `SECRET_SHA256 ${digest(first)}`);
    const shown = completedCommand(
      await this.#send(
        cliArgs(DEPLOYMENT_STATUS, { json: true }, [name]),
        'deployment-status-secret',
      ),
      'deployment status (hosted)',
    );
    const summary = deploymentSummarySchema.parse(JSON.parse(shown));
    if (
      shown.includes(first) ||
      summary.secretNames.join() !== secret ||
      summary.envKeys.includes(NAMED_SECRET_PROBE_KEY)
    ) {
      throw new Error(
        `Deployment ${name} shows Secrets ${JSON.stringify(summary.secretNames)} and env ${JSON.stringify(summary.envKeys)}${shown.includes(first) ? ' and the value' : ''}`,
      );
    }
    rejectedCommand(
      await this.#send(
        cliArgs(SECRETS_DELETE, {}, [secret]),
        'secrets-delete-in-use',
      ),
      `Secret "${secret}" is in use`,
    );
    // Rotation, then key removal: each upgrade starts a Pod on the current values.
    const upgrade = async (
      entry: string,
      logged: (log: string) => boolean,
      expected: string,
    ) => {
      await save(entry);
      completedCommand(
        await this.#send(
          cliArgs(DEPLOYMENT_UPGRADE, { secret: [secret], json: true }, [name]),
          'deployment-upgrade-secret',
        ),
        'deployment upgrade --secret (hosted)',
      );
      const ready = await this.#awaitDeploymentPod(name, pods.at(-1));
      pods.push(observed(ready)!.podUid!);
      // The receiver logs the digest line before it starts receiving.
      if (!logged(await this.#deploymentLog(name, 'RECEIVE_STARTED'))) {
        throw new Error(
          `Pod ${pods.at(-1) ?? ''} of ${name} logged ${expected}`,
        );
      }
    };
    const rotated = value();
    await upgrade(
      `${NAMED_SECRET_PROBE_KEY}=${rotated}`,
      (log) => log.includes(`SECRET_SHA256 ${digest(rotated)}`),
      'no digest of the rotated value',
    );
    await upgrade(
      'E2E_SECRET_KEY_REMOVED=1',
      (log) => !log.includes('SECRET_SHA256'),
      'a Secret digest after the key was removed',
    );
    await this.#deleteDeployment(name);
    completedCommand(
      await this.#send(cliArgs(SECRETS_DELETE, {}, [secret]), 'secrets-delete'),
      'secrets delete (hosted)',
    );
    secretCleanup.complete();
    return pods;
  }

  /**
   * `anycloud logs <deployment>` (its newest Pod) once it contains `text`.
   * A refusal for permissions fails at once: the hosted API reviews its own
   * ServiceAccount for `get pods/log` before it reads a Pod's log, and an
   * upgrade that did not carry the chart's RBAC leaves that grant missing.
   */
  async #deploymentLog(name: string, text: string): Promise<string> {
    const result = await this.#poll(
      `hosted Deployment ${name} to log ${text}`,
      () => this.#send(cliArgs(WORKLOAD_LOGS, {}, [name]), 'deployment-logs'),
      this.#o.timeouts.workloadMs,
      (r) =>
        r.exitCode === 0 && r.stdout.includes(text)
          ? undefined
          : `log: ${r.combined.slice(-300)}`,
      (r) =>
        r.exitCode !== 0 && /lacks permissions|forbidden/iu.test(r.combined)
          ? `the hosted API's ServiceAccount may not read Pod logs: ${r.combined.slice(-300)}`
          : undefined,
    );
    return result.stdout;
  }

  /** `terminate`, then Terminated and cleaned up by the receiver. */
  async #cancel(id: string): Promise<void> {
    await this.terminate(id, 'Job');
    // A receiver `job.error` would also clean up; only Terminated is a cancellation.
    await this.#awaitJob(id, WorkloadState.Terminated, true);
  }

  #receiverImage: Promise<string> | undefined;

  /**
   * Starts building and pushing the receiver once; the GPU journey calls it
   * before creating its pool, so the pool does not wait on the build.
   */
  prepareReceiverImage(): Promise<string> {
    if (!this.#receiverImage) {
      this.#receiverImage = this.#o.receiverImage();
      // Awaited by poolJobs; a failure surfaces there, not as unhandled.
      this.#receiverImage.catch(() => undefined);
    }
    return this.#receiverImage;
  }

  /** The receiver's newest Pod's `AC_TIMING` marks, once it logged its first claim. */
  async receiverMarks(): Promise<Record<string, number>> {
    return timingMarks(
      await this.#deploymentLog(this.#deploymentName!, '"name": "first_claim"'),
    );
  }

  /**
   * The canary Job errors on purpose; its message is the receiver's evidence.
   * It is submitted after `complete`, so its claim is a warm receiver's.
   */
  async #canaryJob(
    id: string,
    deployment: string,
  ): Promise<{ message: string; claimMs: number }> {
    await this.#submitToDeployment(id, deployment);
    const status = await this.#awaitJob(id, WorkloadState.Errored, true);
    this.#cleanups.get(id)?.complete();
    if (status === 'absent') throw new Error(`the canary ${id} is gone`);
    const message = status.events.findLast(
      (event) => event.state === WorkloadState.Errored,
    )?.metadata?.message;
    if (typeof message !== 'string') {
      throw new Error(`the canary ${id} errored without a message`);
    }
    return { message, claimMs: claimMs(status) };
  }

  /**
   * Three held voice sessions on a Deployment admitting two: two run (the
   * receiver errors a session that stops producing audio) while the third
   * stays queued for a minute; cancelling one releases its slot to the third
   * and leaves the other running; then a canary is checked beside it.
   */
  async #voiceSessions(deployment: string, besideCanary: string) {
    type HeldState = WorkloadState | 'absent';
    const holds = [1, 2, 3].map((n) => this.#o.names.workload(`hold-${n}`));
    for (const id of holds) await this.#submitToDeployment(id, deployment);
    const states = async () =>
      Promise.all(
        holds.map(async (id) => {
          const s = await this.#workloadStatus(id);
          return s === 'absent' ? ('absent' as const) : s.workload.state;
        }),
      );
    const described = (now: readonly HeldState[]) =>
      holds.map((id, i) => `${id} ${now[i]}`).join(', ');
    const admitted = (now: readonly HeldState[]) =>
      now[0] === WorkloadState.Running &&
      now[1] === WorkloadState.Running &&
      now[2] === WorkloadState.Queued;
    const broken = (now: readonly HeldState[]) =>
      now.some((state) => state !== 'absent' && isTerminalState(state))
        ? `a held session ended: ${described(now)}`
        : undefined;
    await this.#poll(
      'two of three held voice sessions to run',
      states,
      this.#o.timeouts.workloadMs,
      (now) => (admitted(now) ? undefined : described(now)),
      broken,
    );
    // Held for a minute: the first two keep running and the third stays out.
    let reads = 0;
    await this.#poll(
      'the admission to hold for 60 s',
      states,
      this.#o.timeouts.workloadMs,
      () => (++reads > 12 ? undefined : `observed ${reads} of 12`),
      (now) =>
        broken(now) ??
        (admitted(now)
          ? undefined
          : `the admission changed: ${described(now)}`),
    );
    await this.#cancel(holds[0]);
    await this.#poll(
      'the queued voice session to take the released slot',
      states,
      this.#o.timeouts.workloadMs,
      (now) =>
        now[1] === WorkloadState.Running && now[2] === WorkloadState.Running
          ? undefined
          : described(now),
      (now) =>
        now[1] !== WorkloadState.Running
          ? `the other held session stopped: ${described(now)}`
          : undefined,
    );
    // The third took the slot; free it, then check a session beside the second.
    await this.#cancel(holds[2]);
    const beside = await this.#canaryJob(besideCanary, deployment);
    await this.#cancel(holds[1]);
    for (const id of holds) this.#cleanups.get(id)?.complete();
    return {
      heldJobIds: holds.slice(0, 2),
      queuedJobId: holds[2],
      cancelledJobId: holds[0],
      besideCanary: {
        jobId: besideCanary,
        ...voiceCanaryEvidence(beside.message),
        claimMs: beside.claimMs,
      },
    };
  }

  /** `deployment delete` through the hosted API, waited until deleted or gone. */
  async #deleteDeployment(name: string): Promise<void> {
    const result = await this.#send(
      cliArgs(DEPLOYMENT_DELETE, { json: true }, [name]),
      'deployment-delete',
    );
    if (
      result.exitCode !== 0 &&
      /\bDeployment not found\b/u.test(result.combined)
    ) {
      this.#cleanups.get(name)?.complete();
      return;
    }
    completedCommand(result, 'deployment delete (hosted)');
    await this.#poll(
      `hosted Deployment ${name} to be deleted`,
      () => this.#deploymentStatus(name),
      this.#o.timeouts.workloadMs,
      (s) =>
        s === 'absent' || s.deletedAt !== null
          ? undefined
          : `${s.status?.state ?? 'no status'}: ${s.status?.reason ?? ''}`,
    );
    this.#cleanups.get(name)?.complete();
  }

  /** Waits until the Deployment observes a running Pod other than `previousPodUid`. */
  #awaitDeploymentPod(name: string, previousPodUid?: string): Promise<Summary> {
    return this.#poll(
      `hosted Deployment ${name} to run ${previousPodUid ? 'a new' : 'its'} Pod`,
      () => this.#deploymentStatus(name),
      this.#o.timeouts.workloadMs,
      (s) => {
        const pod = observed(s);
        return pod && pod.podUid !== previousPodUid ? undefined : summarize(s);
      },
    ) as Promise<Summary>;
  }

  /**
   * Once `<id>.anycloud.sh` is published, its URL through Cloudflare and the
   * pool's ingress until it answers 200 with a body `serves` accepts: the
   * URL, the entry IP the record points at, and the body.
   */
  async publishedUrl(id: string, serves: (body: unknown) => boolean) {
    const { http, timeouts } = this.#o;
    const published = await this.#poll(
      `hosted Service ${id} record to be published`,
      () => this.#workloadStatus(id),
      timeouts.workloadMs,
      (s) =>
        s !== 'absent' &&
        s.workload.dnsRecordId &&
        s.workload.publicEndpoint?.state === 'published'
          ? undefined
          : `endpoint ${s === 'absent' ? 'absent' : JSON.stringify(s.workload.publicEndpoint)}`,
    );
    const url = new URL(`https://${id}.anycloud.sh/`);
    // The first lookup before Cloudflare serves the record caches its
    // NXDOMAIN at the runner's resolver for 1800 s (run 41028695286).
    // Finding the authorities is itself a lookup, so its failures retry.
    await this.#o.wait.for(
      `${url.hostname} A record at every authoritative nameserver`,
      () => this.#o.dns.observe(url.hostname),
      {
        timeoutMs: timeouts.workloadMs,
        intervalMs: 5_000,
        probeError: retryTransientProbeError,
        unmet: ({ answers }) =>
          answers.every((a) => a.presence === 'present')
            ? undefined
            : answers.map((a) => `${a.authority}: ${a.diagnostic}`).join('; '),
      },
    );
    let probed = false;
    const response = await this.#poll(
      `${url.href} to answer`,
      () =>
        http
          .get('hosted-service', url, { timeoutMs: 30_000 })
          .catch((error: unknown) => {
            // No HTTP answer: DNS or the edge (run 40815323572 kept neither).
            if (!probed)
              this.#fetchFailures.probeUrl(url.href, `${id}-no-answer`);
            probed = true;
            return { status: 0, body: probeFailure(error) };
          }),
      timeouts.workloadMs,
      (r) =>
        r.status === 200 && serves(r.body)
          ? undefined
          : `HTTP ${r.status}: ${String(r.body).slice(0, 200)}`,
    );
    const ip =
      published === 'absent' ? null : published.workload.publicEndpoint?.ip;
    return { url, ip: ip ?? null, body: response.body };
  }

  /** {@link watchRequests} with this run's DNS probe. */
  watchRequests(url: URL): () => Promise<HostedHealthRecord> {
    return watchRequests(url, { dns: this.#o.dns });
  }

  /**
   * The GPU Service's own evidence: its published URL serves the
   * `nvidia-smi -L` list it wrote before starting. Returns the device lines.
   */
  async gpuServiceDevices(id: string): Promise<readonly string[]> {
    const devices = (body: unknown) =>
      typeof body === 'string' ? (body.match(GPU_DEVICE_LINE) ?? []) : [];
    const { body } = await this.publishedUrl(
      id,
      (served) => devices(served).length > 0,
    );
    return devices(body);
  }

  readonly #replicaSessions = new Map<string, string>();

  /** Fill both one-slot replicas before one of their VMs is removed. */
  async startReplicaLossSessions(): Promise<void> {
    const name = this.#deploymentName;
    if (!name || this.#o.replicas !== 2)
      throw new Error('two replicas are required');
    for (const suffix of ['replica-loss-a', 'replica-loss-b']) {
      const id = this.#o.names.workload(suffix);
      await this.#submitToDeployment(id, name);
      const status = await this.#awaitJob(id, WorkloadState.Running, false);
      const pod =
        status === 'absent'
          ? undefined
          : status.events
              .filter((e) => e.state === WorkloadState.Running)
              .at(-1)?.metadata?.podUid;
      if (typeof pod !== 'string')
        throw new Error(`session ${id} did not identify its replica`);
      this.#replicaSessions.set(id, pod);
    }
    if (new Set(this.#replicaSessions.values()).size !== 2)
      throw new Error('the sessions did not occupy both replicas');
  }

  async #finishReplicaLossSessions(): Promise<string> {
    const entries = [...this.#replicaSessions];
    const statuses = await this.#poll(
      'one session retried while the other keeps serving',
      () => Promise.all(entries.map(([id]) => this.#workloadStatus(id))),
      this.#o.timeouts.workloadMs,
      (now) => {
        const retried = now.filter(
          (s) =>
            s !== 'absent' &&
            s.events.some((e) => e.state === WorkloadState.Retrying),
        );
        return now.every(
          (s) => s !== 'absent' && s.workload.state === WorkloadState.Running,
        ) && retried.length === 1
          ? undefined
          : JSON.stringify(now);
      },
      (now) =>
        now.some((s) => s !== 'absent' && isTerminalState(s.workload.state))
          ? 'a held voice session ended'
          : undefined,
    );
    let replacementPod: string | undefined;
    for (let i = 0; i < statuses.length; i++) {
      const status = statuses[i];
      if (status === 'absent') throw new Error('replica session disappeared');
      const runs = status.events.filter(
        (e) => e.state === WorkloadState.Running,
      );
      const pod = runs.at(-1)?.metadata?.podUid;
      if (runs.length > 1) {
        if (
          typeof pod !== 'string' ||
          pod === entries[i][1] ||
          !status.events.some(
            (e) =>
              e.state === WorkloadState.Retrying &&
              typeof e.metadata?.reason === 'string' &&
              e.metadata.reason.startsWith('replica '),
          )
        )
          throw new Error('lost session was not retried onto another replica');
        replacementPod = pod;
      } else if (pod !== entries[i][1])
        throw new Error('surviving session changed its replica');
    }
    if (!replacementPod) throw new Error('no recovered session');
    await this.#o.artifacts.json('two-replica-host-loss', {
      before: entries,
      after: statuses,
    });
    for (const [id] of entries) await this.#cancel(id);
    return replacementPod;
  }

  /**
   * A session left running on the kept Deployment's replica for host loss.
   * The receiver holds it there, because that replica already claimed Jobs,
   * and completes it on a fresh replica (fixtures/deployment.py).
   */
  async startReplicaLossSession(): Promise<string> {
    const name = this.#deploymentName;
    if (!name) throw new Error('replica loss needs the kept pool Deployment');
    const id = this.#o.names.workload('replica-loss');
    await this.#submitToDeployment(id, name);
    await this.#awaitJob(id, WorkloadState.Running, false);
    return id;
  }

  /**
   * Host-loss continuity, after the pool's instance was terminated natively
   * and its replacement launched: the pool is ready again with one VM, the
   * kept Deployment runs a new Pod on it, and one more Job completes there
   * (on a GPU pool, after seeing the device). Then the Deployment is deleted.
   * First, the session the lost replica was running must have been
   * classified (a `replica …` Retrying event), claimed again on the new Pod
   * and completed there within its retry budget.
   */
  async poolJobAfterHostLoss(
    nodePoolId: string,
    previousPodUid: string,
    /** The one replica's lost session; two replicas hold their own. */
    sessionId?: string,
    /** Reads the replacement Pod before the Deployment is deleted. */
    beforeDelete: (podUid: string) => Promise<void> = () => Promise.resolve(),
  ): Promise<{
    podUid: string;
    jobId: string;
    session?: { jobId: string; retryReason: string };
  }> {
    const name = this.#deploymentName;
    if (!name) throw new Error('host loss needs the kept pool Deployment');
    await this.#poll(
      `hosted node pool ${nodePoolId} to be ready on its replacement VM`,
      () => this.#nodePoolStatus(nodePoolId),
      this.#o.timeouts.nodePoolMs,
      (p) =>
        p !== 'absent' &&
        p.state === WorkloadState.Running &&
        p.capacity.readyVmCount === (this.#o.replicas ?? 1) &&
        p.capacity.startingVmCount === 0 &&
        p.capacity.drainingVmCount === 0
          ? undefined
          : p === 'absent'
            ? 'absent'
            : `${p.state} ${JSON.stringify(p.capacity)}${p.lastError ? `: ${p.lastError}` : ''}`,
      (p) =>
        p !== 'absent' && p.state === WorkloadState.Failed
          ? `node pool failed: ${p.lastError ?? ''}`
          : undefined,
    );
    const podUid =
      this.#o.replicas === 2
        ? await this.#finishReplicaLossSessions()
        : observed(await this.#awaitDeploymentPod(name, previousPodUid))!
            .podUid;
    let session: { jobId: string; retryReason: string } | undefined;
    if (this.#o.replicas !== 2) {
      if (!sessionId) throw new Error('one replica needs its lost session');
      // Before any other Job, so the session is the fresh replica's first claim.
      await this.#awaitJob(sessionId, WorkloadState.Completed, true);
      this.#cleanups.get(sessionId)?.complete();
      const status = await this.#workloadStatus(sessionId);
      const events = status === 'absent' ? [] : status.events;
      const retryReason = events.find(
        (event) => event.state === WorkloadState.Retrying,
      )?.metadata?.reason;
      const runs = events.filter(
        (event) => event.state === WorkloadState.Running,
      );
      if (
        typeof retryReason !== 'string' ||
        !retryReason.startsWith('replica ') ||
        runs.length < 2 ||
        runs.at(-1)?.metadata?.podUid !== podUid
      ) {
        throw new Error(
          `session ${sessionId} was not classified and retried onto Pod ${podUid ?? ''}: ${JSON.stringify(
            events.map(({ state, metadata }) => ({ state, metadata })),
          )}`,
        );
      }
      session = { jobId: sessionId, retryReason };
    }
    const jobId = this.#o.names.workload('after-loss');
    await this.#submitToDeployment(jobId, name);
    await this.#awaitJob(jobId, WorkloadState.Completed, true);
    this.#cleanups.get(jobId)?.complete();
    await beforeDelete(podUid!);
    await this.#deleteDeployment(name);
    return {
      podUid: podUid!,
      jobId,
      ...(session ? { session } : {}),
    };
  }

  async #hostedVersion(): Promise<HostedVersion> {
    const response = await this.#o.http.get(
      'hosted-api-version',
      new URL('/v1/version', this.#hosted.url()),
      { timeoutMs: 30_000 },
    );
    if (response.status !== 200) {
      throw new Error(`hosted API version read returned ${response.status}`);
    }
    return versionSchema.parse(response.body);
  }

  /**
   * `api upgrade --image <image>` starts Upgrade N; `api status --json`
   * reports it `running` only once the release's ready check Job succeeded
   * (the Pod for that revision runs the pinned image, is Ready and serves
   * its version) and `starting` before that; the pre-upgrade backup added an
   * object version, and `cluster list` shows the API's own cluster
   * `running` on the new version. Both legs (a → b and back b → a)
   * come through here; without `image`, the upgrade from a published release
   * to this CLI's own (`a`), as an operator runs it.
   *
   * `rollsOnce`: the upgrade is between two images that both name their
   * chart, and the charts differ, so the one HelmChart write rolls the API
   * exactly once: one generation from before the request to running, and
   * none after it.
   */
  async release(
    image?: string,
    rollsOnce = false,
  ): Promise<HostedReleaseRecord> {
    // Upgraded to this tree's release, the API is this tree's CLI's from here.
    this.#cli = this.#o.cli;
    const stopWatching = this.watchRequests(
      new URL('/health', this.#hosted.url()),
    );
    try {
      const before = rollsOnce
        ? (await this.#releaseStatus())?.rollout?.observedGeneration
        : undefined;
      const { running, servedBefore, ...released } = await this.#release(image);
      // From a published release before 0.1.68, whose upgrade sets only the
      // image, the new API's chart repair may restart it once more.
      if (servedBefore) {
        await this.#rolloutSteady(
          running,
          semver.lt(servedBefore, '0.1.68') ? 1 : 0,
        );
      }
      if (rollsOnce) {
        const upgraded = running.rollout?.observedGeneration;
        if (before == null || upgraded !== before + 1) {
          throw new Error(
            `the upgrade did not roll the hosted API exactly once before it ran: generation ${String(before)} → ${String(upgraded)}`,
          );
        }
        await this.#rolloutSteady(running, 0);
      }
      const health = await stopWatching();
      if (health.requests === 0 || !Number.isFinite(health.longestGapMs)) {
        throw new Error(`/health was not measured: ${JSON.stringify(health)}`);
      }
      await this.#o.artifacts.json(
        `hosted-upgrade-${released.upgrade}-health`,
        health,
      );
      return { ...released, health };
    } finally {
      await stopWatching();
    }
  }

  async #release(image?: string): Promise<
    Omit<HostedReleaseRecord, 'health'> & {
      running: SystemReleaseStatus;
      servedBefore: string | undefined;
    }
  > {
    const backupVersionsBefore = await this.#hosted.backupVersions();
    // Only the from_release upgrade can meet an API older than this CLI.
    const servedBefore =
      this.#o.fromRelease && !image
        ? (await this.#hostedVersion()).version
        : undefined;
    this.#hosted.upgradeRequested();
    const requested = await this.#send(
      cliArgs(API_UPGRADE, image ? { image } : {}),
      'api-upgrade',
      // The K3s step (RFC 0049 C26 (b)) pulls the target image, may restart
      // K3s and waits up to 5 minutes for it before the request.
      900_000,
    );
    completedCommand(requested, 'api upgrade (hosted)');
    // `api upgrade` leaves the local API alone and prints the hosted verdict
    // as a plain line: the upgrade number and its target version.
    this.#localApiUntouched(requested);
    const verdict =
      HOSTED_VERDICT.started.exec(requested.combined)?.groups ??
      (servedBefore
        ? await this.#startedOnOlderApi(requested.combined, servedBefore)
        : undefined);
    if (!verdict) {
      throw new Error(
        `api upgrade did not report a started hosted upgrade: ${requested.combined}`,
      );
    }
    // This tree's API runs the K3s step through its host-step Job; an
    // older from_release API has no route for it, and the CLI skips it.
    if (!servedBefore && !HOSTED_VERDICT.kubernetes.test(requested.combined)) {
      throw new Error(
        `api upgrade did not report a finished K3s step: ${requested.combined}`,
      );
    }
    const upgrade = Number(verdict.number);
    const label = `Upgrade ${upgrade}`;
    const ofThis = (status: SystemReleaseStatus | null) =>
      status?.upgrade?.number === upgrade ? status.upgrade : null;
    const status = await this.#poll(
      `hosted ${label} to run`,
      () => this.#releaseStatus(),
      this.#o.timeouts.releaseMs,
      (read) => {
        const reported = ofThis(read);
        if (reported?.state === WorkloadState.Running) {
          // From a published release this status anchors `#rolloutSteady`.
          return servedBefore && read?.rollout?.observedGeneration == null
            ? `status shows ${label} running without a Deployment generation`
            : undefined;
        }
        return `status does not yet show ${label} running: ${reported ? `${reported.state}${reported.lastError ? `: ${reported.lastError}` : ''}` : 'no such upgrade'}`;
      },
      // A failed ready check fails at once rather than waiting out the budget.
      (read) => {
        const reported = ofThis(read);
        return reported?.state === WorkloadState.Failed
          ? `the upgrade failed: ${reported.lastError ?? 'no reason reported'}`
          : undefined;
      },
    );
    await this.#o.artifacts.json(`hosted-upgrade-${upgrade}`, {
      image,
      requested: requested.combined,
      status,
    });
    const backupVersionsAfter = await this.#hosted.backupVersions();
    if (backupVersionsAfter <= backupVersionsBefore) {
      throw new Error(
        `the pre-upgrade backup did not add an object version (${backupVersionsBefore} → ${backupVersionsAfter})`,
      );
    }
    const servedAfter = await this.#awaitServedVersion(verdict.version);
    await this.#clusterListShowsRunning(verdict.version);
    return {
      image: image ?? ofThis(status)!.apiImage,
      upgrade,
      backupVersionsBefore,
      backupVersionsAfter,
      servedAfter,
      running: status!,
      servedBefore,
    };
  }

  #upgradeJobIds(): string[] {
    return Array.from({ length: UPGRADE_JOBS }, (_, index) =>
      this.#o.names.workload(`upgrade-${index + 1}`),
    );
  }

  /**
   * `release(image)` while the receiver kept by `poolJobs` loops `next_job()`
   * and outcome; Jobs are submitted just before. Its SDK must raise nothing
   * through the restart (the fixture logs `retrying after` when it does), and
   * each Job is claimed exactly once. The receiver is deleted afterwards.
   */
  async releaseUnderLoad(image: string): Promise<HostedReleaseRecord> {
    const name = this.#deploymentName;
    if (!name) throw new Error('releaseUnderLoad needs the kept receiver');
    const retries = (log: string) => log.split('retrying after').length - 1;
    const before = retries(await this.#deploymentLog(name, 'RECEIVE_STARTED'));
    const jobIds = this.#upgradeJobIds();
    for (const id of jobIds) await this.#submitToDeployment(id, name);
    // `a` and `b` name different charts (e2e.sh): one write, one roll.
    const released = await this.release(image, true);
    for (const id of jobIds) {
      await this.#awaitJob(id, WorkloadState.Completed, false);
      this.#cleanups.get(id)?.complete();
    }
    const log = await this.#deploymentLog(name, `completed:${jobIds.at(-1)!}`);
    const claims = (id: string) =>
      log
        .split('\n')
        .filter(
          (line) =>
            line.startsWith('WORK_STARTED ') && line.includes(`"${id}"`),
        ).length;
    const misclaimed = jobIds.filter((id) => claims(id) !== 1);
    if (retries(log) !== before || misclaimed.length > 0) {
      throw new Error(
        `through the upgrade the replica raised ${retries(log) - before} SDK errors and claimed ${misclaimed.join(', ') || 'every Job'} other than once`,
      );
    }
    await this.#deleteDeployment(name);
    return released;
  }

  /**
   * A published API older than `Upgrade N` (v0.1.65) answers the request with
   * `{ unchanged: false, release }` and no `upgrade`, which this CLI prints as
   * accepted. That is a started upgrade once the API serves this CLI's
   * version; its status then names the upgrade. From 0.1.66 the API names
   * the upgrade, so its started verdict is required.
   */
  async #startedOnOlderApi(
    output: string,
    servedBefore: string,
  ): Promise<{ number: string; version: string } | undefined> {
    const image = HOSTED_VERDICT.accepted.exec(output)?.groups?.image;
    const version = image?.slice(image.lastIndexOf(':') + 1);
    // From 0.1.66 the API answers with `upgrade`: it must print the started verdict.
    if (
      !version ||
      version === servedBefore ||
      !semver.lt(servedBefore, '0.1.66')
    ) {
      return undefined;
    }
    await this.#awaitServedVersion(version, this.#o.timeouts.releaseMs);
    const upgrade = (await this.#releaseStatus())?.upgrade;
    if (upgrade?.apiVersion !== version) {
      throw new Error(
        `the hosted API serves ${version} but its status shows ${upgrade ? `Upgrade ${upgrade.number} to ${upgrade.apiVersion}` : 'no upgrade'}`,
      );
    }
    return { number: String(upgrade.number), version };
  }

  /**
   * After an upgrade from a release that inlined its chart, the new API's
   * chart repair may roll it once (`repairRolls` 1) but must not keep rolling
   * it; after an upgrade that set the chart, nothing rolls it (0). From the
   * status that first showed the upgrade running (before a repair's Helm run,
   * which waits for the ready check), three minutes on and settled, the
   * Deployment may be that many generations later, on the same release, and
   * no more: a loop rolling faster than every ninety seconds shows as two.
   * Through those minutes a CLI read every ten seconds must ride out any
   * restart.
   */
  async #rolloutSteady(
    running: SystemReleaseStatus,
    repairRolls: 0 | 1,
  ): Promise<void> {
    const generation = (status: SystemReleaseStatus | null) =>
      status?.rollout?.observedGeneration ?? undefined;
    const steady = (status: SystemReleaseStatus | null) =>
      status?.rollout?.replicas === 1 &&
      status.rollout.readyReplicas === 1 &&
      status.rollout.updatedReplicas === 1 &&
      generation(status) !== undefined
        ? status
        : undefined;
    const release = ({ servedVersion, upgrade }: SystemReleaseStatus) =>
      `${servedVersion} (Upgrade ${String(upgrade?.number)}, ${String(upgrade?.apiImage)})`;
    const baseline = generation(running);
    if (baseline === undefined) {
      throw new Error(
        `the running upgrade's status has no Deployment generation: ${JSON.stringify(running.rollout)}`,
      );
    }
    const sleep =
      this.#o.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let read = 0; read * STEADY_READ_MS < STEADY_ROLLOUT_MS; read += 1) {
      await sleep(STEADY_READ_MS);
      await this.#read(
        cliArgs(API_ACCESS_LIST, { json: true }),
        apiAccessUsersResponseSchema,
        'api-access-list',
      );
    }
    const after = steady(
      await this.#poll(
        'hosted API rollout settled after the upgrade',
        () => this.#releaseStatus(),
        this.#o.timeouts.releaseMs,
        (status) =>
          steady(status)
            ? undefined
            : `rollout ${JSON.stringify(status?.rollout ?? null)}`,
      ),
    )!;
    if (release(after) !== release(running)) {
      throw new Error(
        `the hosted API rolled to another release after the upgrade: ${release(running)} → ${release(after)}`,
      );
    }
    if (generation(after)! > baseline + repairRolls) {
      throw new Error(
        `the hosted API rolled again after the upgrade: generation ${baseline} → ${generation(after)!}, ${repairRolls ? "more than the chart repair's one roll" : 'though the upgrade set its chart'}`,
      );
    }
  }

  async #releaseStatus(): Promise<SystemReleaseStatus | null> {
    const read = await this.#read(
      cliArgs(API_STATUS, { json: true }),
      apiStatusSchema,
      'api-status',
    );
    return read === 'absent' ? null : read.release;
  }

  /**
   * An upgrade leaves the API running: the human `cluster list` row for the
   * API's own cluster reads `running` on the new version.
   */
  async #clusterListShowsRunning(version: string): Promise<void> {
    const id = new URL(this.#hosted.url()).hostname.split('.')[0];
    const listed = completedCommand(
      await this.#send(cliArgs(CLUSTER_LIST, {}), 'cluster-list'),
      'cluster list (hosted)',
    );
    const row = listed.split('\n').find((line) => line.includes(` ${id} `));
    if (
      !row ||
      !/\brunning\s*$/u.test(row) ||
      !row.split(/\s+/u).includes(version)
    ) {
      throw new Error(
        `cluster list does not show ${id} running on ${version}: ${listed}`,
      );
    }
  }

  /** The latest upgrade `api status` reports, plus the backup count: what a no-op must leave alone. */
  async #releaseState(): Promise<{ latest: string; backups: number }> {
    const upgrade = (await this.#releaseStatus())?.upgrade;
    return {
      latest: upgrade
        ? `Upgrade ${upgrade.number} (${upgrade.apiImage})`
        : 'no upgrade',
      backups: await this.#hosted.backupVersions(),
    };
  }

  /** With a hosted target active, the local API (and Docker) is not touched. */
  #localApiUntouched(result: CommandResult): void {
    if (HOSTED_VERDICT.localApi.test(result.combined)) {
      throw new Error(
        `api upgrade of a hosted API reconciled the local API: ${result.combined}`,
      );
    }
  }

  /**
   * A no-op upgrade: the plain verdict line is the primary signal (F runs 16
   * and 18 showed the spinner alone prints nothing in a non-TTY run); the
   * definitive check is that the latest upgrade and the backup count are as
   * they were.
   */
  async #releaseNoop(
    args: readonly string[],
    label: string,
    check: (result: CommandResult) => string | undefined,
  ): Promise<void> {
    const before = await this.#releaseState();
    const result = await this.#send(args, label, 180_000);
    this.#localApiUntouched(result);
    const problem = check(result);
    if (problem) throw new Error(`${problem}: ${result.combined}`);
    const after = await this.#releaseState();
    if (after.latest !== before.latest) {
      throw new Error(
        `${label} started an upgrade: latest moved from ${before.latest} to ${after.latest}`,
      );
    }
    if (after.backups !== before.backups) {
      throw new Error(`${label} still backed the database up`);
    }
  }

  /** The image the API already runs: no upgrade, no rollout, no backup. */
  async releaseUnchanged(image: string): Promise<void> {
    await this.#releaseNoop(
      cliArgs(API_UPGRADE, { image }),
      'api-upgrade-unchanged',
      (result) => {
        if (result.exitCode !== 0) return 'api upgrade (unchanged) failed';
        const verdict = HOSTED_VERDICT.unchanged.exec(result.combined)?.groups;
        if (verdict?.image !== image) {
          return `api upgrade did not report ${image} unchanged`;
        }
        return undefined;
      },
    );
  }

  /** A non-official image is refused before anything is written. */
  async releaseRefused(): Promise<void> {
    await this.#releaseNoop(
      cliArgs(API_UPGRADE, { image: REFUSED_RELEASE_IMAGE }),
      'api-upgrade-refused',
      (result) => {
        if (result.exitCode === 0) {
          return 'api upgrade accepted a non-official image';
        }
        if (!HOSTED_VERDICT.refused.test(result.combined)) {
          return 'api upgrade failed without the refusal verdict';
        }
        if (
          !HOSTED_VERDICT.refused
            .exec(result.combined)
            ?.groups?.reason.includes(
              'digest-pinned reference from the official repository',
            )
        ) {
          return 'api upgrade failed without the official image-policy refusal';
        }
        return undefined;
      },
    );
  }

  /**
   * The recursion property the retired `aws-recursion` member proved: an API
   * that hosts workloads that drive it. A parent Job submitted through the
   * hosted API runs the CLI from the API image and submits the child Job back
   * through the same API, then waits for it; the harness observes the child
   * complete, then the parent, and tears down child → parent. Both Jobs are
   * VM Jobs with the pool's credential: a Job on the pool itself is
   * identity-only work claimed by a Deployment application, which needs a
   * receiver image the live run has no registry for.
   */
  async recursion(apiImage: string): Promise<HostedRecursionRecord> {
    const { pool, credential, names, timeouts } = this.#o;
    // Anycloud passes no sign-in token into workloads, so the parent's CLI
    // gets the harness's token the way a user would: through a Secret.
    const secret = names.secret('recursion');
    this.#o.redactor.add(this.#o.token);
    completedCommand(
      await this.#send(
        cliArgs(SECRETS_NEW, {}, [secret, `GITHUB_TOKEN=${this.#o.token}`]),
        'secrets-new-recursion',
      ),
      'secrets new (hosted, recursion)',
    );
    // LIFO: the Jobs registered below are torn down before their Secret.
    const secretCleanup = this.#defer(`hosted Secret ${secret}`, async () => {
      await this.#send(
        cliArgs(SECRETS_DELETE, { force: true }, [secret]),
        'secrets-delete-recursion',
      );
    });
    const parentId = names.workload('rec-parent');
    const childId = names.workload('rec-child');
    this.#workloadIds.add(parentId);
    this.#workloadIds.add(childId);
    // On failure stop the producer first: a starting parent could submit its
    // child after an earlier child-absence read. Success still tears down
    // child → parent inline after both have completed.
    for (const id of [childId, parentId]) {
      this.#cleanups.set(
        id,
        this.#defer(`hosted Job ${id}`, () => this.terminate(id, 'Job')),
      );
    }
    const job = {
      credentials: credential.name,
      ...(pool.region ? { region: pool.region } : {}),
      'vm-type': pool.vmTypes[0],
    };
    const submitChild = shellCommand(
      cliArgs(
        JOB_CREATE,
        { ...job, id: childId },
        [CHILD_IMAGE],
        ['sh', '-c', 'echo child-done'],
      ),
    );
    const childState = `${shellCommand(cliArgs(WORKLOAD_STATUS, { json: true }, [childId]))} | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).workload.state)'`;
    const script = [
      'set -e',
      submitChild,
      `for i in $(seq 1 ${String(CHILD_POLLS)}); do state=$(${childState}) || state=unreachable; echo "child $state"`,
      'case "$state" in completed) exit 0;; failed|errored|invalid|terminated|terminating) exit 1;; esac',
      `sleep ${String(CHILD_POLL_SECONDS)}; done; echo "child did not complete in time"; exit 1`,
    ].join('\n');
    completedCommand(
      await this.#send(
        cliArgs(
          JOB_CREATE,
          {
            ...job,
            id: parentId,
            env: [`API_URL=${this.#hosted.url()}`],
            secret: [secret],
          },
          [apiImage],
          ['sh', '-c', script],
        ),
        'job-create-parent',
      ),
      'job (hosted, recursive parent)',
    );
    const parent = await this.#poll(
      `hosted recursive parent ${parentId} to complete`,
      () => this.#workloadStatus(parentId),
      timeouts.recursionMs,
      (s) =>
        s !== 'absent' && s.workload.state === WorkloadState.Completed
          ? undefined
          : `state ${s === 'absent' ? 'absent' : s.workload.state}`,
      (s) =>
        s !== 'absent' &&
        s.workload.state !== WorkloadState.Completed &&
        isTerminalState(s.workload.state)
          ? `parent ended ${s.workload.state}`
          : undefined,
    );
    const child = await this.#workloadStatus(childId);
    if (
      child === 'absent' ||
      child.workload.state !== WorkloadState.Completed
    ) {
      throw new Error(
        `the child Job ${childId} is ${child === 'absent' ? 'absent' : child.workload.state}, not completed`,
      );
    }
    await this.#o.artifacts.json('hosted-recursion', { parent, child });
    await this.terminate(childId, 'Job');
    await this.terminate(parentId, 'Job');
    completedCommand(
      await this.#send(
        cliArgs(SECRETS_DELETE, {}, [secret]),
        'secrets-delete-recursion',
      ),
      'secrets delete (hosted, recursion)',
    );
    secretCleanup.complete();
    return {
      parentId,
      childId,
    };
  }

  /** Terminate through the hosted API, waited until cleaned up or gone. */
  async terminate(id: string, kind: 'Service' | 'Job'): Promise<void> {
    // Idempotent: the journey terminates first and the deferred cleanup
    // repeats it; a workload the hosted API no longer knows is already done.
    const result = await this.#send(
      cliArgs(WORKLOAD_TERMINATE, {}, [id]),
      `${kind.toLowerCase()}-terminate`,
    );
    if (
      result.exitCode !== 0 &&
      /\bWorkload not found\b/u.test(result.combined)
    ) {
      this.#cleanups.get(id)?.complete();
      return;
    }
    completedCommand(result, 'terminate (hosted)');
    await this.#poll(
      `hosted ${kind} ${id} to be cleaned up`,
      () => this.#workloadStatus(id),
      this.#o.timeouts.workloadMs,
      (s) =>
        s === 'absent' || typeof s.workload.cleanedAt === 'number'
          ? undefined
          : `${s.workload.state}, cleanup pending`,
    );
    // Torn down by the journey: the deferred cleanup has nothing left to do
    // (and the hosted API may be gone by the time the stack runs, F run 17).
    this.#cleanups.get(id)?.complete();
  }

  /** `node-pool delete` through the hosted API, waited until absent. */
  async deleteNodePool(id: string): Promise<void> {
    const result = await this.#send(
      cliArgs(NODE_POOL_DELETE, { json: true }, [id]),
      'node-pool-delete',
    );
    if (result.exitCode !== 0 && nodePoolAbsent(id).test(result.combined)) {
      this.#cleanups.get(id)?.complete();
      return;
    }
    completedCommand(result, 'node-pool delete (hosted)');
    try {
      await this.#poll(
        `hosted node pool ${id} to be gone`,
        () => this.#releasedNodePoolStatus(id),
        this.#o.timeouts.nodePoolMs,
        (p) =>
          p === 'absent' ||
          (p.state === WorkloadState.Terminated && !p.releasing)
            ? undefined
            : `state ${p.state}${p.releasing ? ' (releasing)' : ''}`,
      );
    } finally {
      // Admitted and waited on once: a timeout must not wait on it again in cleanup.
      this.#cleanups.get(id)?.complete();
    }
  }

  /**
   * A fresh bucket signed by `where`'s credential, holding a small
   * object at each key. The returned call empties and deletes it; cleanup
   * does so if the caller never does.
   */
  async seedBucket(
    bucket: string,
    keys: readonly string[],
    where: { readonly credentials: string; readonly region: string },
  ): Promise<() => Promise<void>> {
    const remove = async () => {
      for (const prefix of new Set(keys.map((key) => key.split('/')[0])))
        await this.#send(
          cliArgs(BUCKET_RM, { ...where, recursive: true, yes: true }, [
            bucket,
            `${prefix}/`,
          ]),
          'bucket-rm',
        );
      const result = await this.#bucketCall(
        cliArgs(BUCKET_DELETE, where, [bucket]),
        'bucket-delete',
      );
      if (
        result.exitCode !== 0 &&
        !/not found|does not exist/iu.test(result.combined)
      )
        completedCommand(result, `bucket delete ${bucket} (token bucket)`);
    };
    const owed = this.#defer(`token bucket ${bucket}`, remove);
    completedCommand(
      await this.#bucketCall(
        cliArgs(BUCKET_CREATE, where, [bucket]),
        'bucket-create',
      ),
      'bucket create (token bucket)',
    );
    const local = await mkdtemp(path.join(tmpdir(), 'token-bucket-'));
    try {
      const file = path.join(local, 'ref.txt');
      await writeFile(file, bucket);
      for (const key of keys)
        completedCommand(
          await this.#send(
            cliArgs(BUCKET_UPLOAD, where, [bucket, file, key]),
            'bucket-upload',
          ),
          'bucket upload (token bucket)',
        );
    } finally {
      await rm(local, { recursive: true, force: true });
    }
    return async () => {
      await remove();
      owed.complete();
    };
  }

  /**
   * A sleeping Deployment registered (RFC 0049 C29) for hosted API
   * access, once its Pod runs. The registration and the Deployment are
   * removed at cleanup.
   */
  async registeredDeployment(
    nodePoolId: string,
    name: string,
  ): Promise<{
    id: string;
    podName: string;
    podUid: string;
    remove: () => Promise<void>;
  }> {
    this.#defer(`registration ${name}`, async () => {
      await this.#send(
        cliArgs(API_ACCESS_REMOVE, { 'service-account': name }),
        'api-access-remove-signer',
      );
    });
    completedCommand(
      await this.#send(
        cliArgs(API_ACCESS_ADD, { 'service-account': name }),
        'api-access-add-signer',
      ),
      'api access add --service-account (hosted)',
    );
    this.#cleanups.set(
      name,
      this.#defer(`hosted Deployment ${name}`, () =>
        this.#deleteDeployment(name),
      ),
    );
    completedCommand(
      await this.#send(
        cliArgs(
          DEPLOYMENT_CREATE,
          { 'node-pool': nodePoolId, cpus: '0.1', json: true },
          [name, CHECK_IMAGE, 'sleep', 'infinity'],
        ),
        'deployment-create-signer',
      ),
      'deployment create (signer)',
    );
    const ready = await this.#awaitDeploymentPod(name);
    const pod = observed(ready);
    if (!pod?.podName || !pod.podUid)
      throw new Error(`Deployment ${name} runs no named Pod`);
    return {
      id: ready.id,
      podName: pod.podName,
      podUid: pod.podUid,
      remove: () => this.#deleteDeployment(name),
    };
  }

  /**
   * A live check's pool Job, sized by the product unless the spec
   * sets `cpus`; terminated at cleanup. With `refused`, the hosted API
   * must refuse it with that text, and the result is its output.
   */
  async checkJob(
    label: string,
    nodePoolId: string,
    spec: {
      readonly image: string;
      readonly command: readonly string[];
      readonly gpus?: number;
      readonly inputBucket?: string;
      readonly outputBucket?: string;
      readonly cpus?: string;
      readonly privileged?: boolean;
      readonly caches?: readonly string[];
      readonly memory?: string;
      readonly bind?: string;
      /** The output bucket signed by this named credential instead of the pool's. */
      readonly outputStorage?: {
        readonly credentials: string;
        readonly region: string;
      };
      /** Text the refusal must hold. */
      readonly refused?: string;
    },
  ): Promise<string> {
    const id = this.#o.names.workload(label);
    this.#workloadIds.add(id);
    this.#cleanups.set(
      id,
      this.#defer(`hosted Job ${id}`, () => this.terminate(id, 'Job')),
    );
    const result = await this.#send(
      cliArgs(
        JOB_CREATE,
        {
          id,
          'node-pool': nodePoolId,
          ...(spec.gpus ? { gpus: String(spec.gpus) } : {}),
          // Signed by the pool's own credential, in its region.
          ...(spec.inputBucket ? { 'input-bucket': spec.inputBucket } : {}),
          ...(spec.outputBucket ? { 'output-bucket': spec.outputBucket } : {}),
          ...(spec.outputStorage
            ? {
                'output-storage-credentials': spec.outputStorage.credentials,
                'output-storage-region': spec.outputStorage.region,
              }
            : {}),
          ...(spec.cpus ? { cpus: spec.cpus } : {}),
          ...(spec.privileged ? { privileged: true } : {}),
          ...(spec.caches ? { cache: [...spec.caches] } : {}),
          memory: spec.memory,
          bind: spec.bind,
        },
        [spec.image],
        [...spec.command],
      ),
      'job-create-check',
    );
    if (spec.refused) {
      rejectedCommand(result, spec.refused);
      return result.combined;
    }
    completedCommand(result, 'job --node-pool (hosted check)');
    return id;
  }

  /**
   * A bucket in the pool's cloud holding `bytes` of zero-filled objects,
   * named as the workflow's sweeps reclaim; deleted before the cluster is.
   * Each object stays under Cloudflare's 100 MB request-body cap on the
   * proxied hosted API (one 1.5 GB PUT got a 413, run 40815305387).
   */
  async stageInput(bytes: number): Promise<string> {
    const { credential, pool } = this.#o;
    const where = {
      credentials: credential.name,
      ...(pool.region ? { region: pool.region } : {}),
    };
    const name = `e2e-clust-in-${String(Date.now())}-${randomUUID().slice(0, 4)}`;
    const local = await mkdtemp(path.join(tmpdir(), 'pool-check-input-'));
    this.#defer(`check bucket ${name}`, async () => {
      await rm(local, { recursive: true, force: true });
      const result = await this.#bucketCall(
        cliArgs(BUCKET_DELETE, where, [name]),
        'bucket-delete',
      );
      if (
        result.exitCode !== 0 &&
        !/not found|does not exist/iu.test(result.combined)
      )
        completedCommand(result, 'bucket delete (hosted check)');
    });
    completedCommand(
      await this.#bucketCall(
        cliArgs(BUCKET_CREATE, where, [name]),
        'bucket-create',
      ),
      'bucket create (hosted check)',
    );
    for (let part = 0; part * INPUT_PART_BYTES < bytes; part += 1) {
      const file = path.join(local, `input-${String(part)}.bin`);
      await writeFile(file, '');
      await truncate(
        file,
        Math.min(INPUT_PART_BYTES, bytes - part * INPUT_PART_BYTES),
      );
    }
    completedCommand(
      await this.#send(
        cliArgs(BUCKET_UPLOAD, { ...where, recursive: true }, [
          name,
          local,
          '',
        ]),
        'bucket-upload',
        1_800_000,
      ),
      'bucket upload (hosted check)',
    );
    return name;
  }

  /**
   * A bucket the API creates at a Job's admission, signed by `where`'s
   * credential: owed to cleanup now, and deleted at once by the function
   * returned, while that credential still works.
   */
  bucketDeletion(
    bucket: string,
    where: { readonly credentials: string; readonly region: string },
  ): () => Promise<void> {
    const remove = async () => {
      const result = await this.#bucketCall(
        cliArgs(BUCKET_DELETE, where, [bucket]),
        'bucket-delete',
      );
      if (
        result.exitCode !== 0 &&
        !/not found|does not exist/iu.test(result.combined)
      )
        completedCommand(result, `bucket delete ${bucket} (hosted)`);
    };
    const owed = this.#defer(`bucket ${bucket}`, remove);
    return async () => {
      await remove();
      owed.complete();
    };
  }

  /** One object of a `stageInput` bucket, as text; `where` signs with another credential. */
  async readBucketObject(
    bucket: string,
    key: string,
    where?: { readonly credentials: string; readonly region: string },
  ): Promise<string> {
    const { credential, pool } = this.#o;
    const local = await mkdtemp(path.join(tmpdir(), 'pool-check-output-'));
    try {
      const file = path.join(local, 'object');
      completedCommand(
        await this.#send(
          cliArgs(
            BUCKET_DOWNLOAD,
            where ?? {
              credentials: credential.name,
              ...(pool.region ? { region: pool.region } : {}),
            },
            [bucket, key, file],
          ),
          'bucket-download',
        ),
        `bucket download ${bucket}/${key}`,
      );
      return await readFile(file, 'utf8');
    } finally {
      await rm(local, { recursive: true, force: true });
    }
  }

  /** A workload's status through the hosted API; `'absent'` once it is gone. */
  status(id: string) {
    return this.#workloadStatus(id);
  }

  async logs(id: string): Promise<string> {
    const result = await this.#send(cliArgs(WORKLOAD_LOGS, {}, [id]), 'logs');
    return completedCommand(result, `logs ${id}`);
  }

  /** Capture each read independently before cleanup removes the evidence. */
  async captureDiagnostics(): Promise<void> {
    // A `fetch failed`'s probes are recorded before the run can end.
    await this.#fetchFailures.settled();
    const attempt = async (read: () => Promise<unknown>): Promise<unknown> => {
      try {
        return await read();
      } catch (error) {
        return {
          unavailable: error instanceof Error ? error.message : String(error),
        };
      }
    };
    // The released CLI until the walk upgrades: this one is refused by an older API.
    const read = (args: readonly string[], label: string) =>
      attempt(() =>
        this.#cli.run(args, {
          env: { API_URL: this.#hosted.url() },
          label: `hosted-${label}`,
          timeoutMs: 60_000,
        }),
      );
    const record = {
      url: this.#hosted.url(),
      releaseStatus: await read(
        cliArgs(API_STATUS, { json: true }),
        'api-status-diagnostic',
      ),
      version: await attempt(() => this.#hostedVersion()),
      deployment: this.#deploymentName
        ? await read(
            cliArgs(DEPLOYMENT_STATUS, { json: true }, [this.#deploymentName]),
            'deployment-diagnostic',
          )
        : null,
      nodePool: this.#nodePoolId
        ? await read(
            cliArgs(NODE_POOL_STATUS, { json: true }, [this.#nodePoolId]),
            'node-pool-diagnostic',
          )
        : null,
      workloads: await Promise.all(
        [...this.#workloadIds].map(async (id) => ({
          id,
          status: await read(
            cliArgs(WORKLOAD_STATUS, { json: true }, [id]),
            `status-diagnostic-${id}`,
          ),
          logs: await read(
            cliArgs(WORKLOAD_LOGS, {}, [id]),
            `logs-diagnostic-${id}`,
          ),
        })),
      ),
    };
    await attempt(() =>
      this.#o.artifacts.json('hosted-stage-diagnostics', record),
    );
  }
}
