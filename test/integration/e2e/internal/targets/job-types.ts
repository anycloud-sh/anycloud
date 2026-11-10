import type { CloudType, DiskTier } from '../../../../../src/shared/cloud.js';
import type { DockerOptions } from '../../../../../src/shared/runtime.js';
import type { WorkloadState } from '../../../../../src/shared/workload.js';

import type { VmProvider } from '../profiles.js';
import type { PublicVmCloudType } from './persistent-vm-types.js';
import type { TrackedWorkloadRef, WorkloadKernel } from '../workloads.js';
import type { SubstrateAbsent } from '../workloads.js';

/** A results.json read mid-sync is not ready yet; it is never an observation. */
export class JobResultNotJson extends Error {
  constructor(length: number) {
    super(`Job MACE result is not valid JSON yet (read ${length} characters)`);
  }
}

/** Kubernetes-targeted Jobs have their own admission and cleanup owner. */
export type DedicatedJobTarget = VmProvider | 'local-smolvm';
export type DedicatedJobCloudType = PublicVmCloudType | CloudType.Local;
export type JobStorageProvider = 'aws' | 'azure' | 'gcp';

export type JobMember =
  | { readonly kind: 'bucket-sync'; readonly target: VmProvider }
  | {
      readonly kind: 'invalid-admission';
      readonly target: 'aws' | 'azure' | 'gcp';
    }
  | {
      readonly kind: 'concurrent-output';
      readonly target: JobStorageProvider;
    }
  | { readonly kind: 'host-recovery'; readonly target: JobStorageProvider }
  | { readonly kind: 'input-hydration-recovery'; readonly target: 'aws' }
  | { readonly kind: 'spot-request-cleanup'; readonly target: 'aws' }
  | { readonly kind: 'spot-eviction'; readonly target: JobStorageProvider }
  | { readonly kind: 'gpu-spot-eviction'; readonly target: 'azure' }
  | {
      readonly kind: 'gpu-probe-rerun';
      readonly target: 'aws' | 'azure' | 'gcp' | 'lambda';
    }
  | {
      readonly kind: 'gpu-health-fault';
      readonly target: 'aws' | 'azure' | 'gcp' | 'lambda';
    }
  | {
      readonly kind: 'runtime-secrets';
      readonly target: 'aws' | 'azure' | 'gcp' | 'lambda';
    }
  | {
      readonly kind: 'restricted-credential';
      readonly target: 'aws' | 'azure';
    }
  | { readonly kind: 'disk-tier'; readonly target: 'gcp' }
  | { readonly kind: 'host-docker'; readonly target: JobStorageProvider }
  | { readonly kind: 'ghcr-probe'; readonly target: 'azure' }
  | {
      readonly kind: 'mace-full-pull';
      readonly target: 'aws' | 'azure' | 'gcp' | 'lambda';
    }
  | {
      readonly kind: 'local-held' | 'local-completed' | 'local-resubmitted';
      readonly target: 'local-smolvm';
    };

export type JobExtension =
  | 'bucket-storage'
  | 'invalid-admission'
  | 'in-place-recovery'
  | 'host-recovery'
  | 'input-hydration-recovery'
  | 'spot-request-cleanup'
  | 'spot-eviction'
  | 'gpu-spot-eviction'
  | 'gpu-probe-rerun'
  | 'gpu-health-fault'
  | 'runtime-secrets'
  | 'restricted-credential'
  | 'disk-tier'
  | 'host-docker'
  | 'mace-full-pull'
  | 'ghcr-probe'
  | 'concurrent-output'
  | 'local-storage'
  | 'local-configuration'
  | 'same-id-resubmission';

/** Closed member inputs are fixed before reservation or creation. */
export interface JobMemberProfile {
  readonly member: JobMember;
  readonly computeProvider: DedicatedJobCloudType;
  readonly vmTypes: readonly string[];
  readonly computeRegion: string | undefined;
  /** `--regions`: the Job must land in one of these. */
  readonly computeRegions?: readonly string[];
  readonly computeZone?: string;
  readonly diskSizeGb: number | undefined;
  readonly diskTier?: `${DiskTier}`;
  /** AWS gp3 root performance, which the native volume must carry. */
  readonly diskIops?: number;
  readonly diskThroughputMibps?: number;
  /** The head VM type is refused for quota, so each launch fails over. */
  readonly launchFailover?: boolean;
  readonly spot: boolean;
  readonly image: string;
  readonly credentialMode:
    | 'aws-import'
    | 'aws-restricted'
    | 'azure-restricted'
    | 'azure-generate'
    | 'gcp-import'
    | 'public-token-import'
    | 'bootstrap'
    | 'credentialless';
  /** Native reservation inventory capability, fixed by the target registration. */
  readonly reservationInventory?: 'matched-attempts';
  readonly storageProvider: JobStorageProvider | 'local' | 'none';
  readonly storageRegion: string;
  /** Ordinary same-cloud outputs use resolved compute placement; cross-cloud profiles pin storage. */
  readonly storageFollowsCompute: boolean;
  readonly crossCloudStorageCredential: 'aws-storage' | 'aws-test' | undefined;
  readonly recursiveTransfers: boolean;
  /** A host-recovery member owns this bucket explicitly through replacement and cleanup. */
  readonly explicitCheckpoint?: boolean;
  readonly requiredExtensions: readonly JobExtension[];
  readonly admissionCases?: readonly JobAdmissionCase[];
  readonly diskTierCases?: readonly JobDiskTierCase[];
  readonly restrictedCredential?: JobRestrictedCredentialProfile;
  /** A host-docker listener gets a prober Job in its network. */
  readonly hostDockerPeer?: boolean;
  readonly ghcr?: JobGhcrProfile;
  readonly mace?: {
    readonly observerTimeoutMs: number;
    readonly runLabel: string;
  };
  readonly expectedTerminalState:
    | WorkloadState.Completed
    | WorkloadState.Invalid
    | WorkloadState.Errored
    | WorkloadState.Terminated;
}

/** Explicit parameters of the two existing GHCR/containerd payloads. */
export interface JobGhcrProfile {
  readonly image: string;
  readonly sampleBytes: number;
  readonly ladder: readonly number[];
  readonly pullConcurrency: number;
  readonly pullChunkBytes: number;
  readonly measureBaseline: boolean;
  readonly pullTimeoutMs: number;
  readonly pollMs: number;
}

export interface JobGhcrImageFacts {
  readonly image: string;
  readonly layerDigest: string;
  readonly imageBytes: number;
  readonly resolution: 'runner' | 'vm-auto';
}

export interface JobGhcrPoll {
  readonly state:
    | 'done'
    | 'active'
    | 'activating'
    | 'deactivating'
    | 'inactive'
    | 'failed'
    | 'unknown'
    | 'transport-failure';
  readonly exitCode?: number;
}

export interface JobGhcrProbe {
  prepare(): Promise<JobGhcrImageFacts>;
  bind(attempt: JobNativeAttempt): Promise<void>;
  throughput(deadlineAt: number): Promise<string>;
  startPull(): Promise<void>;
  poll(deadlineAt: number): Promise<JobGhcrPoll>;
  capture(): Promise<string>;
  finish(deadlineAt: number): Promise<void>;
}

/**
 * RFC 0047's restricted credentials: AWS's pilot key (EC2 in these regions
 * only, no IAM) and Azure's Contributor-only principal.
 */
export interface JobRestrictedCredentialProfile {
  /** The regions the credential may use; absent when it is not regional. */
  readonly regions?: readonly string[];
  readonly cases: readonly JobRestrictedCredentialCase[];
}

/** A pinned, an unpinned, or a same-account output-bucket Job. */
export interface JobRestrictedCredentialCase {
  readonly key: 'pinned' | 'unpinned' | 'output';
  /** The RFC 0047 acceptance scenario the case proves. */
  readonly scenario: string;
  readonly vmType: string;
  readonly region?: string;
}

/** All six legacy GCP cases belong to one closed member. */
export interface JobDiskTierCase {
  readonly key: 'u' | 'hm' | 'hh' | 'hx' | 'pm' | 'px';
  readonly vmType: string;
  readonly tier?: `${DiskTier}`;
  readonly expectedType: 'pd-ssd' | 'pd-standard' | 'hyperdisk-balanced';
  readonly expectedIops?: number;
}

export interface JobDiskTierObservation {
  readonly ref: TrackedWorkloadRef;
  readonly rowId: number;
  readonly identity: JobRecoveryIdentity;
  readonly diskType: string;
  readonly sizeGb: number;
  readonly provisionedIops?: number;
  readonly provisionedThroughput?: number;
}

/** Fixed cases from the target registration, never supplied by a spec. */
export interface JobAdmissionCase {
  readonly kind:
    | 'reserved-bucket'
    | 'unknown-vm'
    | 'cuda-runtime'
    | 'docker-gpu';
  readonly outcome: 'rejected' | 'invalid';
  readonly vmType: string;
  readonly image: string;
  readonly region?: string;
  readonly bucketPrefix?: string;
  readonly dockerOptions?: DockerOptions;
  readonly expectedMessages: readonly string[];
}

export interface JobAdmissionObservation {
  readonly ref: TrackedWorkloadRef;
  readonly kind: 'rejected' | 'invalid';
  readonly message: string;
}

/** Original attempt coordinates, never filled from the latest placement. */
export interface JobNativeAttempt {
  readonly ref: TrackedWorkloadRef;
  readonly rowId: number;
  readonly createdAt: number;
  readonly endedAt: number | null;
  readonly cloudId: string;
  readonly ip: string | null;
  /** The VM's address inside its network; a peer reaches it here. */
  readonly privateIp?: string | null;
  readonly cloudProvider: DedicatedJobCloudType;
  readonly credentialId: string | null;
  readonly region: string;
  readonly availabilityZone: string | null;
  readonly vmType: string;
}

export interface JobStageBudget {
  readonly runningMs: number;
  readonly cleanupMs: number;
  readonly storageMs: number;
  readonly completionMs: number;
}

export interface JobContractResult {
  readonly contract: 'dedicated-job';
  readonly member: JobMember;
  readonly target: DedicatedJobTarget;
  readonly qualification: 'conclusive';
  readonly satisfied: true;
}

/** Fixture callers can select only a concrete delivered family member. */
export type DeliveredJobMember = JobMember;

export interface JobFixture {
  readonly ref: TrackedWorkloadRef;
  readonly profile: JobMemberProfile;
}

export interface JobRecoveryIdentity {
  readonly cloudId: string;
  readonly vmId: string;
  readonly osDiskId: string;
  readonly region: string;
  readonly zone: string | null;
  readonly vmType: string;
}

/**
 * How many Job children one member prepares and finalizes together. Both the
 * transport's preparation guard and the family finalizer read this.
 */
export function jobGroupSize(profile: JobMemberProfile): number | undefined {
  switch (profile.member.kind) {
    case 'invalid-admission':
      return profile.admissionCases?.length;
    case 'disk-tier':
      return profile.diskTierCases?.length;
    case 'restricted-credential':
      return profile.restrictedCredential?.cases.length;
    case 'concurrent-output':
      return 3;
    // The spot-eviction member adds the clean-exit sibling.
    case 'runtime-secrets':
    case 'spot-eviction':
      return 2;
    // The second Spot cleanup Job shares its sibling's group.
    case 'spot-request-cleanup':
      return 2;
    case 'host-docker':
      return profile.hostDockerPeer ? 2 : 1;
    default:
      return 1;
  }
}

/** The VM types a cloud Job child is submitted with, in order. */
export function submittedVmTypes(fixture: CloudJobFixture): readonly string[] {
  if (fixture.diskTierCase) return [fixture.diskTierCase.vmType];
  if (fixture.restrictedCredentialCase)
    return [fixture.restrictedCredentialCase.vmType];
  // Unarmed, the refused head type could launch, so it is left out.
  return fixture.launchFailover?.armed === false
    ? fixture.profile.vmTypes.slice(1)
    : fixture.profile.vmTypes;
}

export interface CloudJobFixture extends JobFixture {
  readonly admissionCase?: JobAdmissionCase;
  readonly diskTierCase?: JobDiskTierCase;
  readonly restrictedCredentialCase?: JobRestrictedCredentialCase;
  /** The launch-failover quota read; unarmed, the Job omits the refused head type. */
  readonly launchFailover?: {
    readonly quotas: Readonly<Record<string, Record<string, number>>>;
    readonly armed: boolean;
  };
  readonly credentialName: string;
  readonly storageCredentialName: string;
  readonly inputBucket?: string;
  readonly outputBucket?: string;
  readonly checkpointBucket?: string;
  readonly runtimeSecretNames?: readonly string[];
  readonly maceCommand?: string;
  readonly hydration?: {
    readonly seedSha256: string;
    readonly apiContainerId: string;
    readonly command: string;
    readonly objects: number;
    readonly bytes: number;
  };
  readonly runLabel: string;
  readonly concurrentIndex: number;
  readonly concurrentWrites: readonly {
    readonly key: string;
    readonly contents: string;
  }[];
}

export interface JobTransferFacts {
  readonly listedBucket: boolean;
  readonly rootObject: boolean;
  readonly nestedPrefix: boolean;
  readonly literalPrefix: boolean;
  readonly recursiveObjects: boolean;
  readonly recursive?: {
    readonly rootContents: boolean;
    readonly nestedContents: boolean;
    readonly hiddenContents: boolean;
    readonly existingMode: boolean;
    readonly newMode: boolean;
    readonly singleContents: boolean;
    readonly singleMode: boolean;
    readonly collisions: boolean;
    readonly deletedPrefix: boolean;
    readonly retainedSibling: boolean;
  };
}

export interface JobBucketRuntimeFacts {
  readonly inputReadOnly: boolean;
  readonly lateInputAbsent: boolean;
  readonly environment: boolean;
  readonly logsFollower: boolean;
  /** The host's GPU names, one per GPU. */
  readonly gpus: readonly string[];
}

/** The existing schema-2 log observer remains the source of this receipt. */
export interface JobMaceObservation {
  readonly schemaVersion: 2;
  readonly observationSource: 'ci-api-log-stream';
  readonly workloadId: string;
  readonly runId: string;
  readonly phase: 'armed' | 'attached' | 'observed' | 'failed';
  readonly observerArmedAtMs: number;
  readonly firstInferenceLogObservedAtMs: number | null;
  readonly marker: {
    readonly payload: Readonly<Record<string, unknown>>;
  } | null;
  readonly [field: string]: unknown;
}

/** Process and log observations only; the family owns every acceptance wait. */
export interface JobMaceProbe {
  start(timeoutMs: number): Promise<void>;
  observation(): Promise<JobMaceObservation | undefined>;
  finish(): Promise<void>;
  pullLogMessages(): Promise<readonly string[]>;
  writeReport(
    status: Awaited<ReturnType<WorkloadKernel['status']>> | undefined,
    observer: JobMaceObservation | undefined,
    deliveryPath: string,
  ): Promise<void>;
}

export interface CloudJobTransport {
  ghcr(fixture: CloudJobFixture): JobGhcrProbe;
  mace(fixture: CloudJobFixture): JobMaceProbe;
  diskTier(
    fixture: CloudJobFixture,
    attempt: JobNativeAttempt,
  ): Promise<JobDiskTierObservation>;
  submitAdmission(fixture: CloudJobFixture): Promise<'rejected' | 'accepted'>;
  admissionStatus(fixture: CloudJobFixture): Promise<WorkloadState>;
  admissionOutcome(fixture: CloudJobFixture): Promise<JobAdmissionObservation>;
  releaseUncreated(
    fixture: CloudJobFixture,
    substrate: SubstrateAbsent,
  ): Promise<void>;
  runtimeSecretFacts(fixture: CloudJobFixture): Promise<JobRuntimeSecretFacts>;
  /** The first Job's HF_TOKEN file, against the newest saved value. */
  runtimeSecretFile(fixture: CloudJobFixture): Promise<JobRuntimeSecretFile>;
  /** Save the first Job's Secret again with a new HF_TOKEN. */
  updateRuntimeSecret(fixture: CloudJobFixture): Promise<void>;
  /** Remove the Secret's files from the host, as a reboot clears `/run`. */
  clearRuntimeSecretFiles(fixture: CloudJobFixture): Promise<void>;
  forceDeleteRuntimeSecret(fixture: CloudJobFixture): Promise<void>;
  spot(fixture: CloudJobFixture): JobSpotProbe;
  hydration(fixture: CloudJobFixture): JobHydrationProbe;
  prepare(
    ids: readonly string[],
    profile: JobMemberProfile,
    budget: JobStageBudget,
  ): Promise<readonly CloudJobFixture[]>;
  submit(fixture: CloudJobFixture, args: readonly string[]): Promise<void>;
  attempts(
    fixture: JobFixture,
    deadlineAt?: number,
  ): Promise<readonly JobNativeAttempt[]>;
  imageConfigDigest(fixture: CloudJobFixture): Promise<string>;
  transfers(fixture: CloudJobFixture): Promise<JobTransferFacts>;
  bucketReady(
    fixture: CloudJobFixture,
    role: 'output' | 'checkpoint',
    deadlineAt: number,
  ): Promise<boolean>;
  results(
    fixture: CloudJobFixture,
    role: 'output' | 'checkpoint',
    deadlineAt: number,
  ): Promise<unknown>;
  runtime(fixture: CloudJobFixture): Promise<JobBucketRuntimeFacts>;
  logs(
    fixture: CloudJobFixture,
    originalIp: string,
    deadlineAt: number,
  ): Promise<string | undefined>;
  /** The checkpoint facts `anycloud status --json` reports for the Job. */
  statusCheckpoint(
    fixture: CloudJobFixture,
  ): Promise<CliCheckpointFacts | undefined>;
  /** `anycloud logs --follow 2>&1 | grep -m1 pattern` ends with its reader. */
  logsStopWithTheirReader(
    fixture: CloudJobFixture,
    pattern: string,
  ): Promise<{ readonly matched: boolean; readonly cliExitedZero: boolean }>;
  /** `wait` and `status` as a user sees a naturally completed Job. */
  completedByCli(fixture: CloudJobFixture): Promise<{
    readonly waitSucceeded: boolean;
    readonly statusFinished: boolean;
  }>;
  writeConcurrent(fixture: CloudJobFixture): Promise<void>;
  concurrentContents(
    fixture: CloudJobFixture,
    deadlineAt?: number,
  ): Promise<readonly (string | undefined)[]>;
  /** The spot-eviction marker's contents and the payload object's size. */
  evictionOutput(
    fixture: CloudJobFixture,
    deadlineAt: number,
  ): Promise<JobEvictionOutput>;
  syncCycle(): Promise<void>;
  verificationRetry(): Promise<void>;
  recoveryIdentity(
    fixture: CloudJobFixture,
    attempt: JobNativeAttempt,
  ): Promise<JobRecoveryIdentity>;
  stop(
    fixture: CloudJobFixture,
    attempt: JobNativeAttempt,
    identity: JobRecoveryIdentity,
  ): Promise<void>;
  /**
   * #2332: writes one driver-formed Xid line to the host's `/dev/kmsg` over
   * the product's own SSH route, then confirms it independently in the
   * kernel journal, ahead of the product's own (slower) status read.
   */
  injectGpuXid(
    fixture: CloudJobFixture,
    pci: string,
    code: number,
  ): Promise<JobGpuXidInjection>;
  deleteHost(
    fixture: CloudJobFixture,
    attempt: JobNativeAttempt,
    identity: JobRecoveryIdentity,
  ): Promise<void>;
  writeHostCheckpoint(fixture: CloudJobFixture): Promise<void>;
  hostCheckpoint(
    fixture: CloudJobFixture,
    source: 'bucket' | 'container',
    deadlineAt: number,
  ): Promise<string | undefined>;
  nativeAbsence(
    fixture: JobFixture,
    timeoutMs: number,
  ): Promise<SubstrateAbsent>;
  automaticCheckpointAbsence(fixture: JobFixture): Promise<void>;
  releaseResources(fixture: JobFixture): Promise<void>;
}

export interface JobEvictionOutput {
  readonly marker: string | undefined;
  readonly payloadBytes: number | null | undefined;
}

/** #2332: the injected Xid line and whether the host's own journal read confirmed it. */
export interface JobGpuXidInjection {
  readonly line: string;
  readonly journalConfirmed: boolean;
}

export interface JobRuntimeSecretFacts {
  readonly environment: boolean;
  readonly containerId: string;
  readonly startedAt: string;
  readonly mode?: string;
  readonly uid?: number;
  readonly fileSystem?: string;
  /** Before deletion: private Git cloned through the `github` Secret, or was refused without it. */
  readonly privateGit?: boolean;
}

export interface JobRuntimeSecretFile {
  readonly value: 'newest' | 'stale' | 'missing';
  readonly mode?: string;
  readonly uid?: number;
  /** uid 65534 in the container can read it. */
  readonly nobodyReads?: boolean;
  /** The host file system under /run/anycloud-secrets/files. */
  readonly fileSystem: string;
}

export interface JobSpotRequest {
  readonly id: string;
  readonly region: string;
  readonly instanceId: string | undefined;
  /** The request's `Status.Code` and `Status.UpdateTime`. */
  readonly statusCode?: string;
  readonly updatedAt?: number;
  readonly type: 'persistent';
  readonly state:
    | 'open'
    | 'active'
    | 'disabled'
    | 'cancelled'
    | 'closed'
    | 'failed';
}

/** Native observations only; the family owns the active/cancelled waits and replacement guard. */
export interface JobSpotProbe {
  now(): number;
  active(
    attempt: JobNativeAttempt,
    deadlineAt: number,
  ): Promise<JobSpotRequest>;
  /** The request a just-launched instance names, read by its ID. */
  launched(
    attempt: JobNativeAttempt,
    deadlineAt: number,
  ): Promise<{ readonly request: JobSpotRequest; readonly launchedAt: number }>;
  request(deadlineAt: number): Promise<JobSpotRequest>;
  /** What the `instance-id` request filter, the old lookup, finds now. */
  instanceFilter(deadlineAt: number): Promise<readonly JobSpotRequest[]>;
  liveInstances(deadlineAt: number): Promise<readonly string[]>;
  pause(milliseconds: number, deadlineAt: number): Promise<void>;
}

export interface JobHydrationWorker {
  readonly observedAt: number;
  readonly active: boolean;
  readonly invocation: string;
  readonly pid: number;
  readonly identity: string;
  readonly logBytes: number;
}

export interface JobHydrationActivity {
  readonly observedAt: number;
  readonly visibleBytes: number;
  readonly hiddenBytes: number;
}

export interface JobHydrationApiLogs {
  readonly launched: number;
  readonly adopted: number;
}

export interface JobHydrationDisk {
  readonly id: string;
  readonly type: string;
  readonly iops: number;
  readonly throughput: number;
  readonly sizeGb: number;
}

/** Raw observations/actions for the one production-timing hydration member. */
export interface JobHydrationProbe {
  snapshot(deadlineAt: number): Promise<JobHydrationWorker>;
  apiLogs(deadlineAt: number): Promise<JobHydrationApiLogs>;
  restart(): Promise<{
    readonly identityBefore: string;
    readonly identityAfter: string;
  }>;
  disk(
    identity: JobRecoveryIdentity,
    deadlineAt: number,
  ): Promise<JobHydrationDisk>;
  hideActivity(): Promise<JobHydrationActivity>;
  activity(deadlineAt: number): Promise<JobHydrationActivity>;
  pause(milliseconds: number): Promise<void>;
  manifest(deadlineAt: number): Promise<string | undefined>;
}

export interface LocalJobFixture extends JobFixture {
  readonly inputBucket: string;
  readonly outputBucket: string;
  readonly checkpointBucket: string;
  readonly secretName: string;
  readonly secretDigest: string;
  readonly environmentFile: string;
  readonly fileValue: string;
  readonly overrideValue: string;
  readonly stdoutMarker: string;
  readonly stderrMarker: string;
}

export interface LocalJobConfiguration {
  readonly workloadExec: boolean;
  readonly environment: boolean;
  readonly runtimeSecretFile: boolean;
  readonly labels: boolean;
  readonly dockerOptions: boolean;
  readonly stdoutLogs: boolean;
  readonly stderrLogs: boolean;
  readonly hostExec: boolean;
  /** A saved Secret's file reaches the running container. */
  readonly liveSecretFile: boolean;
}

/**
 * The checkpoint facts `anycloud status --json` reports for a Job. Target
 * modules may not import the product contract, so this restates its shape.
 */
export interface CliCheckpointFacts {
  readonly bucket: string;
  readonly mount: string;
  readonly retained: boolean;
  readonly health?: {
    readonly objects: number;
    readonly bytes: number;
    readonly lastModifiedAt: number | null;
    readonly truncated: boolean;
  };
}

/** Single-attempt transport capabilities; waits and assertions belong to the family. */
export interface LocalJobTransport {
  prepare(
    id: string,
    profile: JobMemberProfile,
    cleanupMs: number,
  ): Promise<LocalJobFixture>;
  prepareTerminal(
    id: string,
    profile: JobMemberProfile,
    cleanupMs: number,
  ): Promise<JobFixture>;
  submit(fixture: JobFixture, args: readonly string[]): Promise<void>;
  firstGenerationAbsence(fixture: JobFixture, timeoutMs: number): Promise<void>;
  resubmit(fixture: JobFixture): Promise<void>;
  attempts(
    fixture: JobFixture,
    deadlineAt?: number,
  ): Promise<readonly JobNativeAttempt[]>;
  configuration(fixture: LocalJobFixture): Promise<LocalJobConfiguration>;
  storage(fixture: LocalJobFixture): Promise<{
    readonly output: string | undefined;
    readonly checkpoint: string | undefined;
  }>;
  lateInputRemainsAbsent(fixture: LocalJobFixture): Promise<boolean>;
  /** `wait` and `status` as a user sees a naturally completed Job. */
  completedByCli(fixture: JobFixture): Promise<{
    readonly waitSucceeded: boolean;
    readonly statusFinished: boolean;
  }>;
  nativeAbsence(
    fixture: JobFixture,
    timeoutMs: number,
  ): Promise<SubstrateAbsent>;
  releaseResources(fixture: JobFixture): Promise<void>;
}
