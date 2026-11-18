import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import packageJson from '../../package.json' with { type: 'json' };
import type {
  CloudCredentials,
  CloudType,
  InstanceCloudCredentials,
} from '../shared/cloud.js';
import { getApiUrl } from '../shared/config.js';
import { getAnycloudDir } from '../shared/utils.js';
import { SSH_RUNTIME_DIR } from '../shared/ssh-runtime.js';
import {
  SYSTEM_RELEASE_CHART_ENV,
  isPinnedApiImage,
} from '../shared/system-release.js';
import type { SystemReleaseClusterRecord } from '../shared/system-release-values.js';

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Public API origin advertised to persistent Kubernetes workloads. */
export function getWorkloadApiUrl(): string {
  return process.env.ANYCLOUD_WORKLOAD_API_URL?.trim() || getApiUrl();
}

/** The chart this API image was built with (Dockerfile `API_CHART`); null when built without one. */
export function getOwnApiChart(): string | null {
  return process.env[SYSTEM_RELEASE_CHART_ENV]?.trim() || null;
}

/**
 * The digest-pinned image a Helm-managed API runs, as its chart rendered it;
 * null outside one or when it isn't pinned.
 */
export function getOwnApiImage(): string | null {
  const image = process.env.ANYCLOUD_RELEASE_IMAGE?.trim();
  return image && isPinnedApiImage(image) ? image : null;
}

/** True inside the Helm-managed system release (chart-set marker). */
export function isHelmManagedApi(): boolean {
  return process.env.ANYCLOUD_SYSTEM_RELEASE?.trim() === 'helm';
}

/** The cluster a Helm-managed API runs in, as bootstrap rendered it into the chart. */
export interface HostedClusterConfig {
  name: string;
  /** `kube-system` namespace UID bootstrap observed. */
  kubernetesIdentity: string;
  /** `https://<public-ip>:6443`; what node pool VMs join through. */
  joinEndpoint: string;
  certificateAuthorityData: string;
  /** The creation facts bootstrap wrote (RFC 0049 C26 (a)); null before 0.1.74. */
  record: SystemReleaseClusterRecord | null;
}

/**
 * Raw chart-set cluster values. Every value is required on a Helm-managed
 * API: an empty one means the chart predates the cluster record and the API
 * must not start (cluster-self-record.ts decides).
 */
export function getHostedClusterConfig(): Record<
  Exclude<keyof HostedClusterConfig, 'record'>,
  string | undefined
> & { record?: string } {
  return {
    name: process.env.ANYCLOUD_CLUSTER_NAME?.trim(),
    kubernetesIdentity: process.env.ANYCLOUD_CLUSTER_IDENTITY?.trim(),
    joinEndpoint: process.env.ANYCLOUD_CLUSTER_JOIN_ENDPOINT?.trim(),
    certificateAuthorityData: process.env.ANYCLOUD_CLUSTER_CA?.trim(),
    record: process.env.ANYCLOUD_CLUSTER_RECORD?.trim(),
  };
}

export interface ApiBackupConfig {
  bucket: string;
  region: string;
  cloudProvider: CloudType;
  /** A stored credential, or the management VM's own identity. */
  credentials: CloudCredentials | InstanceCloudCredentials;
  /** The cluster's AWS account, GCP project or Azure subscription, for `backup.json`. */
  account?: string;
  /** The cluster's name, region and management VM type, for `backup.json`. */
  target?: { name: string; region: string; vmType: string };
}

/**
 * Test-only: where the boot script's e2e access kubeconfig is mounted in the
 * API's Pod (`ANYCLOUD_E2E_ACCESS`); undefined in every real install.
 */
export function getE2eAccessKubeconfigPath(): string | undefined {
  return process.env.ANYCLOUD_E2E_ACCESS?.trim() || undefined;
}

/**
 * Where a Helm-managed API backs its database up (chart Secret rendered from
 * the installation's recorded bucket and storage credential). Absent on a
 * local or Docker-hosted API.
 */
/** The release values' `selfDelete` (RFC 0049 C26, seed design), as JSON. */
export function getSelfDeleteConfig(): string | undefined {
  return process.env.ANYCLOUD_SELF_DELETE;
}

export function getApiBackupConfig(): ApiBackupConfig | undefined {
  const raw = process.env.ANYCLOUD_BACKUP_CONFIG?.trim();
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as Partial<ApiBackupConfig>;
  if (
    typeof parsed.bucket !== 'string' ||
    typeof parsed.region !== 'string' ||
    typeof parsed.cloudProvider !== 'string' ||
    typeof parsed.credentials !== 'object' ||
    parsed.credentials === null
  ) {
    throw new Error(
      'ANYCLOUD_BACKUP_CONFIG is missing bucket, region, cloudProvider or credentials',
    );
  }
  return parsed as ApiBackupConfig;
}

// ============================================================================
// Timeout Constants
// ============================================================================

/** VM provisioning must complete within this time or it's marked as failed */
export const PROVISIONING_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes (SDK clients handle transient retries internally)

/** VM initialization (SSH wait + package install + docker daemon) must complete within this time */
export const INITIALIZATION_TIMEOUT_MS = 50 * 60 * 1000; // 50 minutes

/** Max time to wait for SSH to become reachable on a VM (new or reused) */
export const SSH_READY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** VM termination must complete within this time */
export const TERMINATION_TIMEOUT_MS = 45 * 60 * 1000; // 45 minutes

/** Pre-teardown storage diagnostics run over SSH while the VM is still billing,
 * ahead of the terminate call they precede, and repeat on every cleanup attempt.
 * The default exec budget (4 attempts, ConnectTimeout=15, no command timeout,
 * several execs per capture) is unbounded enough to add minutes of GPU time to a
 * teardown whose box is exactly the kind that is already unreachable. Best-effort
 * detail never outranks stopping the meter. */
export const TERMINAL_DIAGNOSTICS_TIMEOUT_MS = 15 * 1000; // 15 seconds

/** Rclone setup without an input-bucket hydrate must complete within this time */
export const RCLONE_INIT_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

/** Input hydration has no total-duration ceiling, but a detached rclone worker
 * that stops producing its once-per-minute stats is treated as wedged. */
export const INPUT_SYNC_INACTIVITY_TIMEOUT_MS = positiveIntegerEnv(
  'INPUT_SYNC_INACTIVITY_TIMEOUT_MS',
  15 * 60 * 1000,
); // 15 minutes without worker output

/** Final output/checkpoint rclone copy must complete within this time */
export const FINAL_SYNC_TIMEOUT_MS = positiveIntegerEnv(
  'FINAL_SYNC_TIMEOUT_MS',
  TERMINATION_TIMEOUT_MS,
); // 45 minutes

/** Docker image pull must complete within this time (can be large for GPU images) */
export const IMAGE_PULL_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 3 hours (up to 3 attempts × 60 min each for large ML images)

/** Image pull runs detached on the VM as a systemd transient unit, decoupled from
 * the SSH control stream (a long `docker pull` over one SSH exec gets killed by
 * ~5-min NAT/idle teardowns). These bound the short-exec control loop that polls
 * the detached pull's result; the pull itself is not tied to any SSH channel. */
export const PULL_TOTAL_TIMEOUT_MS = 60 * 60 * 1000; // 60 min budget for one detached pull
/** Give the accelerated transfer one bounded attempt, preserving at least two
 * hours of the enclosing IMAGE_PULL_TIMEOUT_MS for the ordinary Docker fallback. */
export const CONTAINERD_TRANSFER_PULL_TIMEOUT_MS = 30 * 60 * 1000;
export const PULL_POLL_INTERVAL_MS = 15 * 1000; // poll the result sentinel every 15s
export const PULL_CONTROL_TIMEOUT_MS = 60 * 1000; // per short control exec (login/launch/poll/tail)

/** Container start + health check must complete within this time */
export const CONTAINER_SETUP_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** Status endpoint: VM health checks must complete within this time */
export const STATUS_HEALTH_CHECK_TIMEOUT_MS = 5_000; // 5 seconds (allows for 2 sequential SSH calls per service)

/**
 * Per-region budget for a `quota status` fan-out. The no-region read queries
 * every catalog region in parallel; a single opt-in/disabled region whose
 * Service Quotas endpoint hangs (no connection response) would otherwise block
 * the whole response indefinitely. Cap each region so the slowest one — not the
 * sum — bounds the call. A region that exceeds this contributes no entries.
 */
export const QUOTA_REGION_TIMEOUT_MS = positiveIntegerEnv(
  'QUOTA_REGION_TIMEOUT_MS',
  60_000,
);

/**
 * Candidate preflight is latency-sensitive: it runs in the provisioning
 * scheduler before a target is selected. Keep each regional quota read well
 * below the outer candidate-preflight wait budget so a single degraded AWS
 * Service Quotas endpoint can fail open locally instead of timing out the
 * entire sweep.
 */
export const AWS_CANDIDATE_PREFLIGHT_REGION_TIMEOUT_MS = positiveIntegerEnv(
  'AWS_CANDIDATE_PREFLIGHT_REGION_TIMEOUT_MS',
  5_000,
);

export const AWS_CANDIDATE_PREFLIGHT_REGION_CONCURRENCY = positiveIntegerEnv(
  'AWS_CANDIDATE_PREFLIGHT_REGION_CONCURRENCY',
  8,
);

export const AZURE_CANDIDATE_PREFLIGHT_REGION_TIMEOUT_MS = positiveIntegerEnv(
  'AZURE_CANDIDATE_PREFLIGHT_REGION_TIMEOUT_MS',
  5_000,
);

export const AZURE_CANDIDATE_PREFLIGHT_REGION_CONCURRENCY = positiveIntegerEnv(
  'AZURE_CANDIDATE_PREFLIGHT_REGION_CONCURRENCY',
  8,
);

/**
 * Azure quota create calls often take longer than normal read requests. This is
 * only the wait-for-confirmation budget: timing out does not prove Azure failed,
 * so callers surface TIMED_OUT and ask the user to verify with quota status.
 */

/** A workload stuck in an active pipeline step longer than this is considered orphaned (API restart) */
export const STUCK_ACTIVE_TIMEOUT_MS = Math.max(
  PROVISIONING_TIMEOUT_MS,
  INITIALIZATION_TIMEOUT_MS,
  IMAGE_PULL_TIMEOUT_MS,
  RCLONE_INIT_TIMEOUT_MS,
  CONTAINER_SETUP_TIMEOUT_MS,
);

/**
 * SSH-unreachable monitor intervals before fallback recovery when cloud
 * existence cannot be determined. A cloud-confirmed existing VM is preserved.
 */
export const JOB_CHECK_TIMEOUT_THRESHOLD = 20;

/** Maximum number of auto-retry attempts before a workload stays Failed permanently */
export const FAILED_DEPLOY_MAX_ATTEMPTS = 100;

/** Opaque provider provisioning rejections in a pinned region have no failover target */
export const PINNED_PROVISIONING_REJECTION_MAX_ATTEMPTS = 3;

/**
 * Fresh VMs a GPU Job gets after its log shows an unusable GPU. A Job that
 * hides its GPU itself, as with a CPU-only torch build, fails each time.
 */
export const UNUSABLE_GPU_MAX_RETRIES = 3;

/** Maximum number of workloads admitted into an active deploy-pipeline state */
export const MAX_ACTIVE_DEPLOY_PIPELINES = 50;

/** Independent billing-API groups admitted by the hourly cost monitor. */
export const COST_CALCULATION_CONCURRENCY = positiveIntegerEnv(
  'COST_CALCULATION_CONCURRENCY',
  20,
);

/** How often the provisioning scheduler polls for queued workloads */
export const PROVISIONING_SCHEDULER_INTERVAL_MS = 5_000;

/** Initial wait for the non-provisioning (later pipeline failure) retry curve */
export const RETRY_JITTER_BASE_MS = 60_000; // 1 minute

/** Hard ceiling on every retry curve — no computed wait may exceed it */
export const RETRY_JITTER_CAP_MS = 10 * 60_000; // 10 minutes max

/**
 * Provisioning retry ceiling at the first attempt, doubling per attempt until
 * it saturates RETRY_PROVISIONING_CAP_MS. Sized so a correlated fleet stays
 * de-synchronised: the sampling window at attempt 1 divided across
 * MAX_ACTIVE_DEPLOY_PIPELINES must stay wide relative to a provider's minimum
 * inter-launch interval.
 */
export const RETRY_PROVISIONING_BASE_MS = positiveIntegerEnv(
  'RETRY_PROVISIONING_BASE_MS',
  150_000, // 2.5 minutes
);

/**
 * Ceiling the provisioning curve saturates at. Defaults to the shared cap so
 * the "no curve exceeds RETRY_JITTER_CAP_MS" invariant holds by construction.
 */
export const RETRY_PROVISIONING_CAP_MS = positiveIntegerEnv(
  'RETRY_PROVISIONING_CAP_MS',
  RETRY_JITTER_CAP_MS,
);

/**
 * Lambda HTTP 429s are retried reactively. Keep this policy operator-tunable:
 * the provider does not publish a useful recovery interval, and the nuke lane
 * is the evidence source for adjusting it without waiting for a release. The
 * default keeps a 50-launch burst under one local retry owner; a six-attempt
 * envelope handed more than half that fleet to durable workload retry.
 */
export const LAMBDA_429_RETRY_MAX_ATTEMPTS = positiveIntegerEnv(
  'LAMBDA_429_RETRY_MAX_ATTEMPTS',
  12,
);
export const LAMBDA_429_RETRY_BASE_MS = positiveIntegerEnv(
  'LAMBDA_429_RETRY_BASE_MS',
  10_000,
);
export const LAMBDA_429_RETRY_CAP_MS = positiveIntegerEnv(
  'LAMBDA_429_RETRY_CAP_MS',
  100_000,
);

/** How often the quota monitor checks for quota-exhausted workloads */

// ============================================================================
// Environment Configuration
// ============================================================================

function loadCipherKey(): string {
  if (process.env.CIPHER_KEY) {
    return process.env.CIPHER_KEY;
  }

  const anycloudDir = getAnycloudDir();
  const keyPath = join(anycloudDir, 'cipher.key');
  if (existsSync(keyPath)) {
    // A restore rebuilds this directory from object storage, which carries no
    // file modes, so the key comes back with the restore's defaults instead of
    // the 0600 it was written with. Re-tighten on every boot rather than only
    // at creation. Best-effort: this runs at module load, so a read-only or
    // foreign-owned state dir must degrade rather than block startup.
    try {
      chmodSync(anycloudDir, 0o700);
      chmodSync(keyPath, 0o600);
    } catch {
      // Intentionally ignored — see above.
    }
    return readFileSync(keyPath, 'utf-8').trim();
  }

  mkdirSync(anycloudDir, { recursive: true, mode: 0o700 });

  const sqlitePaths = process.env.SQLITE_PATH
    ? [process.env.SQLITE_PATH]
    : [join(anycloudDir, 'api.db'), join(anycloudDir, 'conductor.db')];
  const existingSqlitePath = sqlitePaths.find(
    (sqlitePath) => sqlitePath !== ':memory:' && existsSync(sqlitePath),
  );
  if (existingSqlitePath) {
    throw new Error(
      `CIPHER_KEY not set and no key file found at ${keyPath}; refusing to generate a new key because SQLite DB exists at ${existingSqlitePath}`,
    );
  }

  const key = randomBytes(32).toString('hex');
  writeFileSync(keyPath, key, { encoding: 'utf-8', mode: 0o600 });
  return key;
}
const cipherKey = loadCipherKey();

export default {
  cipherKey,
  sqlitePath: process.env.SQLITE_PATH ?? ':memory:',
  port: process.env.PORT,
  debug: process.env.DEBUG === 'true',
  sshPort: 22,
  sshRuntimeDirectory:
    process.env.IS_TEST === 'true'
      ? join('/tmp', `acssh-${process.pid}`)
      : SSH_RUNTIME_DIR,
  sshRuntimeRequiresTmpfs: process.env.IS_TEST !== 'true',
  githubToken: process.env.GITHUB_TOKEN,
  currVersion: packageJson.version,
  /** The release before this one, recorded by the release workflow's bump. */
  previousVersion: packageJson.previousVersion,
  posthogApiKey: 'phc_W1NIrjSmbVA6OtRALD7mMYB3FwlWVIXfuFNUiJ38Ufz',
};
