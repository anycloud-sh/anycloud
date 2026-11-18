import type { CloudType, DiskTier } from '../../shared/cloud.js';
import type {
  EndReason,
  WorkloadState,
  WorkloadTypeValue,
} from '../../shared/workload.js';
import type { ImageRuntime } from '../../shared/image.js';
import type { DockerOptions } from '../../shared/runtime.js';

/** Durable workload record hydrated from SQLite. */
export interface WorkloadPublicEndpoint {
  /** The pool ingress entry IP the record was last published at. */
  ip: string | null;
  /** `published` = record current; `repointing` = publish/re-point pending; `stale` = the Worker refused. */
  state: 'published' | 'repointing' | 'stale';
  error: string | null;
}

export interface StoredWorkload {
  id: string;
  userId: string;
  /** Persistent Kubernetes workload target; null for dedicated VM-host work. */
  deploymentId: string | null;
  /** Explicit node pool a Service runs on in the shared cluster; null for VM-host work. */
  nodePoolId: string | null;
  /** Active name of that node pool when hydrated; null otherwise. */
  nodePoolName: string | null;
  /** Latest/current targeted execution fence; null before first selection. */
  currentExecutionId: string | null;
  /** Explicit resubmission advances this revision; automatic retries retain it. */
  submissionRevision: number;
  /** Admission-to-first-claim deadline, in epoch milliseconds. */
  claimDeadlineAt: number | null;
  /** Durable across completion and automatic retry within this submission. */
  firstClaimedAt: number | null;
  workloadType: WorkloadTypeValue;
  image: string | null;
  // Computed from explicit credentialless provider selection, credential
  // metadata, or VM attempt metadata. Before any VM exists this is the requested
  // credentialless provider (Local) or selected credential cloud; after
  // provisioning it is the latest VM attempt's credential cloud when present.
  // Null only for corrupt rows.
  cloudProvider: CloudType | null;
  region: string | null;
  vmType: string | string[] | null;
  gpuType: string | string[] | null; // User-specified GPU alias (e.g. "h100:8" or ["h100", "a100"]), stored for display
  spot: boolean;
  state: WorkloadState;
  startedAt: number;
  completedAt: number | null; // Terminal outcome timestamp
  cleanedAt?: number | null; // T3 provider teardown confirmation; absent on older API responses
  /** Why the last cleanup attempt failed; null once cleaned or before any failure. */
  cleanupError?: string | null;
  endReason: EndReason | null;
  lastAttemptEndReason: EndReason | null;
  /** A Job's own retry cap (`--max-retries`); null for the system's budgets alone. */
  maxRetries: number | null;
  /** A Spot VM Job without the managed checkpoint bucket (`--no-checkpoint`). */
  noCheckpoint: boolean;
  /** A VM Job launched with nested virtualization on (`--require-nested-virtualization`). */
  requireNestedVirtualization: boolean;
  /** A VM Job given the host's Docker socket, and `/dev/kvm` with nesting (`--host-docker`). */
  hostDocker: boolean;
  dockerCommand: string;
  inputBucket: string | null;
  outputBucket: string | null;
  checkpointBucket: string | null;
  diskSizeGb: number | null;
  diskTier: DiskTier | null;
  /** A VM Job's own AWS gp3 root volume IOPS and MiB/s (0168). */
  diskIops: number | null;
  diskThroughputMibps: number | null;
  /** A VM Job's region allow-list (0169); null when unset. */
  regions: string[] | null;
  dockerOptions: DockerOptions | null;
  availabilityZone: string | null;
  env: Record<string, string> | null;
  githubToken: string | null;
  /** Captured container registry/runtime username; null for Deployment Jobs. */
  registryUsername: string | null;
  vmCount: number; // Active VMs for this workload
  sshPrivateKey: string;
  // NULL is reserved for credentialless compute; a scalar id is the selected
  // compute credential. The actual credential each VM booted with is on
  // `vms.credential_id`.
  credentialId: string | null;
  inputStorageCredentialId: string | null; // NULL = use compute credential for input bucket storage
  inputStorageRegion: string | null; // Region for cross-cloud input bucket storage
  outputStorageCredentialId: string | null; // NULL = use compute credential for output bucket storage
  outputStorageRegion: string | null; // Region for cross-cloud output bucket storage
  checkpointStorageCredentialId: string | null; // NULL = use compute credential for checkpoint bucket storage
  checkpointStorageRegion: string | null; // Region for cross-cloud checkpoint bucket storage
  command: string[] | null; // Override container CMD (args after -- in CLI)
  imageDigest: string | null; // API-resolved linux/amd64 Docker manifest digest (sha256:...)
  imageRuntime: ImageRuntime | null; // GPU runtime the image base expects (detected at submit). null = legacy/undetected. Insert-only. See migration 0066.
  vmDurationMs: number | null; // Total VM compute time (sum of all VM lifetimes; clipped to the requested window in aggregate cost responses)
  // Portion of vmDurationMs that fell after teardown was requested. Reported
  // beside the total, never subtracted from it — the provider keeps charging
  // the customer's account until it confirms the release.
  awaitingReleaseMs: number | null;
  totalCost: number | null; // SUM of per-VM (vms.cost when reconciled from billing, else priceAtProvision × duration), clipped to the requested window in aggregate cost responses. 0 with vmDurationMs>0 means none of the VMs were priced.
  costSource: 'actual' | 'estimated' | null; // 'actual' iff no priced VM (live or ended) still awaits its billing-derived cost; 'estimated' otherwise; null for new rows
  dnsRecordId: string | null; // Cloudflare DNS record ID, if present
  /** Node pool Service only: where the record points and whether that is current. */
  publicEndpoint: WorkloadPublicEndpoint | null;
  secretNames: string[] | null; // Named secrets referenced at submit time; resolved server-side at provision
  session: string | null; // Caller-supplied attribution (auto-detected agent run). Insert-only.
  agent: string | null; // Short agent name (claude/codex/cursor/aider/…) when known. Insert-only.
  sessionLabel: string | null; // Human-readable session label for display (e.g. Claude Code session title). Insert-only. See migration 0052.
  latestMessage: string | null; // metadata.message from the most recent workload_event (e.g. "blocked by daily budget"). Surfaces soft-block reasons in `anycloud list`.
}

/** VM execution requires its owned container configuration. */
export function assertVmHostContainerConfiguration(
  workload: Pick<
    StoredWorkload,
    'id' | 'deploymentId' | 'registryUsername' | 'image'
  >,
): asserts workload is Pick<StoredWorkload, 'id'> & {
  deploymentId: null;
  registryUsername: string;
  image: string;
} {
  if (
    workload.deploymentId !== null ||
    typeof workload.registryUsername !== 'string' ||
    typeof workload.image !== 'string'
  ) {
    throw new Error(
      `Workload ${workload.id}: VM-host container configuration is required`,
    );
  }
}

export type WorkloadEventState = WorkloadState | 'baking';

export interface WorkloadEvent {
  id: number;
  workloadId: string;
  state: WorkloadEventState;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

/** Resolved provisioning details persisted for one attempt. */
export interface ProvisioningConfig {
  region?: string;
  vmType?: string;
  credentialId?: string;
  availabilityZone?: string | null;
}

/** Placement facts persisted before the workload pipeline is handed off. */
export interface ProvisioningIntent extends ProvisioningConfig {
  cloudProvider: CloudType;
  availabilityZone: string | null;
}
