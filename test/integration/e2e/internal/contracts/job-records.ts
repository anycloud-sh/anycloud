import { WorkloadState } from '../../../../../src/shared/workload.js';

import { isRecord, type StatusResponse } from '../types.js';
import type { TrackedWorkloadRef } from '../workloads.js';
import type { VmLedgerProbe } from '../vm-ledger.js';
import type {
  JobExtension,
  JobMemberProfile,
  JobNativeAttempt,
  JobRecoveryIdentity,
  JobHydrationWorker,
  JobHydrationApiLogs,
  JobHydrationActivity,
  JobHydrationDisk,
  JobAdmissionCase,
  JobAdmissionObservation,
} from '../targets/job-types.js';

const runBrand: unique symbol = Symbol('JobRun');
const recordBrand: unique symbol = Symbol('JobRecord');

export interface JobProgressObservation {
  readonly status: StatusResponse;
  readonly attempts: readonly JobNativeAttempt[];
}

export interface JobRun {
  readonly ref: TrackedWorkloadRef;
  readonly generation: number;
  readonly [runBrand]: true;
}

export interface JobProgress {
  readonly kind: 'active' | 'terminal-before-active';
  readonly state: WorkloadState;
  readonly [recordBrand]: true;
}

export interface JobExtensionRecord {
  readonly kind: JobExtension;
  readonly [recordBrand]: true;
}

export interface JobTerminal {
  readonly state: WorkloadState;
  readonly [recordBrand]: true;
}

export interface JobResubmission {
  readonly generation: number;
  readonly [recordBrand]: true;
}

export interface JobRecoveryBefore {
  readonly kind: 'before-in-place-recovery';
  readonly [recordBrand]: true;
}

export interface JobRecoveryFault {
  readonly kind: 'in-place-stop-acknowledged';
  readonly [recordBrand]: true;
}

export interface JobHostRecoveryBefore {
  readonly kind: 'before-host-recovery';
  readonly [recordBrand]: true;
}

export interface JobHostRecoveryFault {
  readonly kind: 'host-delete-acknowledged';
  readonly [recordBrand]: true;
}

export interface JobEvictionBefore {
  readonly kind: 'before-finalizing-eviction';
  readonly [recordBrand]: true;
}

export interface JobEvictionFault {
  readonly kind: 'finalizing-eviction-acknowledged';
  readonly [recordBrand]: true;
}

export interface JobHydrationBefore {
  readonly kind: 'before-hydration-recovery';
  readonly [recordBrand]: true;
}
export interface JobHydrationHealthy {
  readonly kind: 'healthy-hydration';
  readonly [recordBrand]: true;
}
export interface JobHydrationFault {
  readonly kind: 'hydration-visible-activity-hidden';
  readonly [recordBrand]: true;
}
export interface JobHydrationObservation extends JobProgressObservation {
  readonly worker: JobHydrationWorker;
}

interface HydrationState {
  readonly before: JobHydrationBefore;
  readonly original: JobNativeAttempt;
  readonly identity: JobRecoveryIdentity;
  readonly worker: JobHydrationWorker;
  readonly logs: JobHydrationApiLogs;
  readonly apiContainerId: string;
  readonly seedSha256: string;
  healthy?: JobHydrationHealthy;
  healthyAt?: number;
  fault?: JobHydrationFault;
  activity?: JobHydrationActivity;
  eventId?: number;
  eventAt?: number;
  completed: boolean;
}

interface HostRecoveryState {
  readonly before: JobHostRecoveryBefore;
  readonly original: JobNativeAttempt;
  readonly identity: JobRecoveryIdentity;
  readonly eventId: number;
  readonly eventAt: number;
  readonly checkpoint: string | undefined;
  fault?: JobHostRecoveryFault;
  completed: boolean;
}

interface RecoveryState {
  readonly before: JobRecoveryBefore;
  readonly original: JobNativeAttempt;
  readonly identity: JobRecoveryIdentity;
  readonly eventId: number;
  readonly molecules: number;
  fault?: JobRecoveryFault;
  completed: boolean;
}

interface EvictionState {
  readonly before: JobEvictionBefore;
  readonly original: JobNativeAttempt;
  readonly eventId: number;
  fault?: JobEvictionFault;
  completed: boolean;
}

interface RunState {
  readonly profile: JobMemberProfile;
  readonly extensions: Map<JobExtension, JobExtensionRecord>;
  progress?: JobProgress;
  terminal?: JobTerminal;
  resubmission?: JobResubmission;
  recovery?: RecoveryState;
  hostRecovery?: HostRecoveryState;
  eviction?: EvictionState;
  hydration?: HydrationState;
  finalizing: boolean;
}

export const JOB_TERMINAL_STATES: readonly WorkloadState[] = Object.freeze([
  WorkloadState.Completed,
  WorkloadState.Errored,
  WorkloadState.Failed,
  WorkloadState.Invalid,
  WorkloadState.Terminated,
]);

export const JOB_RECOVERY_STATES: readonly StatusResponse['events'][number]['state'][] =
  Object.freeze([
    WorkloadState.Starting,
    WorkloadState.Recovering,
    WorkloadState.Syncing,
    WorkloadState.Provisioning,
    WorkloadState.Initializing,
    WorkloadState.Downloading,
    WorkloadState.Queued,
  ]);

export function jobInvariant(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(`Dedicated Job: ${message}`);
}

export function jobHydrationRetryEvent(
  status: StatusResponse,
  id: string,
  eventId: number,
  eventAt: number,
): StatusResponse['events'][number] | undefined {
  return status.events.find(
    (event) =>
      event.workloadId === id &&
      event.id > eventId &&
      event.createdAt > eventAt &&
      event.state === WorkloadState.Retrying &&
      JSON.stringify(event.metadata)?.includes(
        'produced no output within 15 min',
      ),
  );
}

/** The product's in-place restart of a Finalizing Job's evicted VM, after `eventId`. */
export function jobEvictionRestarted(
  status: StatusResponse,
  eventId: number,
): boolean {
  return status.events.some(
    (event) =>
      event.id > eventId &&
      event.state === WorkloadState.Finalizing &&
      isRecord(event.metadata) &&
      event.metadata.reason === 'final-bucket-sync-vm-restarted',
  );
}

/** Records authorize only their original run/ref/generation, never their copied shape. */
export class JobRecords {
  readonly #vmLedger: Pick<VmLedgerProbe, 'snapshot' | 'liveEntries'>;
  readonly #runs = new WeakMap<JobRun, RunState>();
  readonly #records = new WeakMap<object, JobRun>();
  readonly #generations = new WeakMap<TrackedWorkloadRef, number>();
  readonly #resubmissions = new WeakMap<
    JobResubmission,
    { readonly run: JobRun; readonly profile: JobMemberProfile; next?: JobRun }
  >();

  constructor(vmLedger: Pick<VmLedgerProbe, 'snapshot' | 'liveEntries'>) {
    this.#vmLedger = vmLedger;
  }

  begin(
    ref: TrackedWorkloadRef,
    profile: JobMemberProfile,
    generation: number,
    previous?: JobResubmission,
  ): JobRun {
    jobInvariant(
      Number.isSafeInteger(generation) && generation > 0,
      'invalid submission generation',
    );
    jobInvariant(
      generation === (this.#generations.get(ref) ?? 0) + 1,
      'submission generation was reused or skipped',
    );
    const transition = previous && this.#resubmissions.get(previous);
    if (generation > 1)
      jobInvariant(
        transition &&
          !transition.next &&
          transition.run.ref === ref &&
          transition.run.generation + 1 === generation &&
          transition.profile === profile,
        'resubmission requires its original cleaned generation record',
      );
    else jobInvariant(!previous, 'initial submission cannot use a predecessor');
    const run: JobRun = Object.freeze({
      ref,
      generation,
      [runBrand]: true as const,
    });
    this.#generations.set(ref, generation);
    this.#runs.set(run, { profile, extensions: new Map(), finalizing: false });
    if (transition) transition.next = run;
    return run;
  }

  admission(
    run: JobRun,
    admissionCase: JobAdmissionCase,
    observation: JobAdmissionObservation,
  ): JobExtensionRecord {
    const state = this.#require(run);
    jobInvariant(
      state.profile.member.kind === 'invalid-admission' &&
        state.profile.admissionCases?.includes(admissionCase) &&
        run.generation === 1 &&
        !state.progress &&
        !state.terminal &&
        !state.extensions.size &&
        observation.ref === run.ref &&
        observation.kind === admissionCase.outcome,
      'admission requires its original case, outcome and single generation',
    );
    const bucket = `${admissionCase.bucketPrefix ?? ''}${run.ref.id}`;
    jobInvariant(
      admissionCase.expectedMessages.some((message) =>
        observation.message.includes(message.replace('{bucket}', bucket)),
      ) &&
        (admissionCase.kind !== 'docker-gpu' ||
          observation.message.includes(`"${admissionCase.vmType}"`)),
      'admission failed for a different reason than its named guard',
    );
    const record: JobExtensionRecord = Object.freeze({
      kind: 'invalid-admission',
      [recordBrand]: true as const,
    });
    this.#records.set(record, run);
    state.extensions.set('invalid-admission', record);
    return record;
  }

  claimAdmission(run: JobRun, record: JobExtensionRecord): void {
    const state = this.#require(run);
    this.#owns(run, record);
    jobInvariant(
      state.profile.member.kind === 'invalid-admission' &&
        state.extensions.get('invalid-admission') === record &&
        state.extensions.size === 1 &&
        !state.progress &&
        !state.terminal,
      'admission finalizer requires its original non-provisioning record',
    );
    state.finalizing = true;
  }

  prepareResubmission(
    run: JobRun,
    progress: JobProgress,
    terminal: JobTerminal,
    observation: JobProgressObservation,
  ): JobResubmission {
    const state = this.#require(run);
    this.#owns(run, progress);
    this.#owns(run, terminal);
    jobInvariant(
      state.profile.member.kind === 'local-resubmitted' &&
        run.generation === 1 &&
        !state.resubmission &&
        state.progress === progress &&
        state.terminal === terminal &&
        terminal.state === WorkloadState.Errored,
      'resubmission requires its first errored generation exactly once',
    );
    const { status, attempts } = observation;
    jobInvariant(
      status.workload.id === run.ref.id &&
        status.workload.state === WorkloadState.Errored &&
        typeof status.workload.cleanedAt === 'number' &&
        status.workload.cleanedAt > 0 &&
        attempts.length > 0 &&
        attempts.every(
          (attempt) => attempt.ref === run.ref && attempt.endedAt !== null,
        ),
      'resubmission requires persisted cleanup and ended original attempts',
    );
    const record: JobResubmission = Object.freeze({
      generation: run.generation,
      [recordBrand]: true as const,
    });
    this.#records.set(record, run);
    this.#resubmissions.set(record, { run, profile: state.profile });
    state.resubmission = record;
    return record;
  }

  resubmitted(
    run: JobRun,
    progress: JobProgress,
    previous: JobResubmission,
  ): JobExtensionRecord {
    const state = this.#require(run);
    this.#owns(run, progress);
    jobInvariant(
      this.#resubmissions.get(previous)?.next === run &&
        state.progress === progress &&
        !state.terminal,
      'resubmission extension requires its original pre/post generation records',
    );
    return this.#extension(run, state, 'same-id-resubmission');
  }

  beforeRecovery(
    run: JobRun,
    progress: JobProgress,
    observation: JobProgressObservation,
    identity: JobRecoveryIdentity,
    molecules: number,
  ): JobRecoveryBefore {
    const state = this.#require(run);
    this.#owns(run, progress);
    jobInvariant(
      state.progress === progress &&
        progress.kind === 'active' &&
        !state.terminal &&
        !state.recovery &&
        state.profile.requiredExtensions.includes('in-place-recovery'),
      'recovery requires its live original baseline exactly once',
    );
    const original = this.#runningAttempt(run, observation);
    jobInvariant(
      Number.isSafeInteger(molecules) && molecules > 0 && molecules < 10,
      'recovery requires a nonempty unfinished checkpoint',
    );
    jobInvariant(
      identity.cloudId === original.cloudId &&
        identity.region === original.region &&
        identity.vmType === original.vmType &&
        identity.vmId.length > 0 &&
        identity.osDiskId.length > 0,
      'recovery identity does not belong to its original attempt',
    );
    const before: JobRecoveryBefore = Object.freeze({
      kind: 'before-in-place-recovery',
      [recordBrand]: true as const,
    });
    this.#records.set(before, run);
    state.recovery = {
      before,
      original: Object.freeze({ ...original }),
      identity: Object.freeze({ ...identity }),
      eventId: this.#eventId(run, observation.status),
      molecules,
      completed: false,
    };
    return before;
  }

  recoveryFault(run: JobRun, before: JobRecoveryBefore): JobRecoveryFault {
    const state = this.#require(run);
    this.#owns(run, before);
    const recovery = state.recovery;
    jobInvariant(
      recovery?.before === before && !recovery.fault && !state.terminal,
      'recovery fault requires its original pre-fault record exactly once',
    );
    const fault: JobRecoveryFault = Object.freeze({
      kind: 'in-place-stop-acknowledged',
      [recordBrand]: true as const,
    });
    recovery.fault = fault;
    this.#records.set(fault, run);
    return fault;
  }

  recovered(
    run: JobRun,
    before: JobRecoveryBefore,
    fault: JobRecoveryFault,
    observation: JobProgressObservation,
    identity: JobRecoveryIdentity,
    molecules: number,
  ): JobExtensionRecord {
    const state = this.#require(run);
    this.#owns(run, before);
    this.#owns(run, fault);
    const recovery = state.recovery;
    jobInvariant(
      recovery?.before === before &&
        recovery.fault === fault &&
        !recovery.completed &&
        !state.terminal,
      'recovery extension requires its original pre/fault/post records exactly once',
    );
    const current = this.#runningAttempt(run, observation);
    this.#eventId(run, observation.status);
    jobInvariant(
      observation.status.events.some(
        (event) =>
          event.id > recovery.eventId &&
          JOB_RECOVERY_STATES.includes(event.state),
      ),
      'recovery has no new recovery event after its pre-fault baseline',
    );
    const old = observation.attempts.find(
      (attempt) => attempt.rowId === recovery.original.rowId,
    );
    jobInvariant(
      old &&
        old.endedAt !== null &&
        old.endedAt >= recovery.original.createdAt &&
        old.createdAt === recovery.original.createdAt &&
        old.cloudId === recovery.original.cloudId &&
        old.cloudProvider === recovery.original.cloudProvider &&
        old.credentialId === recovery.original.credentialId &&
        old.region === recovery.original.region &&
        old.availabilityZone === recovery.original.availabilityZone &&
        old.vmType === recovery.original.vmType &&
        current.rowId !== recovery.original.rowId &&
        current.createdAt >= old.endedAt &&
        current.cloudId === recovery.original.cloudId &&
        current.cloudProvider === recovery.original.cloudProvider &&
        current.credentialId === recovery.original.credentialId &&
        current.region === recovery.original.region &&
        current.availabilityZone === recovery.original.availabilityZone &&
        current.vmType === recovery.original.vmType,
      'in-place recovery lost its ended original and distinct live attempt on the same VM',
    );
    jobInvariant(
      (Object.keys(recovery.identity) as (keyof JobRecoveryIdentity)[]).every(
        (key) => identity[key] === recovery.identity[key],
      ),
      'in-place recovery changed its exact VM or boot-disk identity',
    );
    jobInvariant(
      Number.isSafeInteger(molecules) &&
        molecules >= recovery.molecules &&
        molecules <= 10,
      'recovery lost checkpoint contents',
    );
    const extension = this.#extension(run, state, 'in-place-recovery');
    recovery.completed = true;
    return extension;
  }

  beforeHostRecovery(
    run: JobRun,
    progress: JobProgress,
    observation: JobProgressObservation,
    identity: JobRecoveryIdentity,
    checkpoint: string | undefined,
  ): JobHostRecoveryBefore {
    const state = this.#require(run);
    this.#owns(run, progress);
    jobInvariant(
      state.progress === progress &&
        progress.kind === 'active' &&
        !state.terminal &&
        !state.hostRecovery &&
        state.profile.requiredExtensions.includes('host-recovery'),
      'host recovery requires its live original baseline exactly once',
    );
    const original = this.#runningAttempt(run, observation);
    this.#assertNativePlacement(run, observation.status, original);
    jobInvariant(
      original.cloudProvider === state.profile.computeProvider &&
        state.profile.vmTypes.includes(original.vmType) &&
        identity.cloudId === original.cloudId &&
        identity.region === original.region &&
        identity.vmType === original.vmType &&
        identity.vmId.length > 0 &&
        identity.osDiskId.length > 0,
      'host recovery identity does not belong to its original attempt',
    );
    jobInvariant(
      checkpoint ===
        (state.profile.explicitCheckpoint
          ? `checkpoint-${run.ref.id}`
          : undefined),
      'host recovery requires its exact uploaded checkpoint before deletion',
    );
    const before: JobHostRecoveryBefore = Object.freeze({
      kind: 'before-host-recovery',
      [recordBrand]: true as const,
    });
    this.#records.set(before, run);
    state.hostRecovery = {
      before,
      original: Object.freeze({ ...original }),
      identity: Object.freeze({ ...identity }),
      eventId: this.#eventId(run, observation.status),
      eventAt: Math.max(
        0,
        ...observation.status.events.map((event) => event.createdAt),
      ),
      checkpoint,
      completed: false,
    };
    return before;
  }

  hostRecoveryFault(
    run: JobRun,
    before: JobHostRecoveryBefore,
  ): JobHostRecoveryFault {
    const state = this.#require(run);
    this.#owns(run, before);
    const recovery = state.hostRecovery;
    jobInvariant(
      recovery?.before === before && !recovery.fault && !state.terminal,
      'host deletion requires its original pre-fault record exactly once',
    );
    const fault: JobHostRecoveryFault = Object.freeze({
      kind: 'host-delete-acknowledged',
      [recordBrand]: true as const,
    });
    recovery.fault = fault;
    this.#records.set(fault, run);
    return fault;
  }

  hostRecovered(
    run: JobRun,
    before: JobHostRecoveryBefore,
    fault: JobHostRecoveryFault,
    observation: JobProgressObservation,
    identity: JobRecoveryIdentity,
    restoredCheckpoint: string | undefined,
  ): JobExtensionRecord {
    const state = this.#require(run);
    this.#owns(run, before);
    this.#owns(run, fault);
    const recovery = state.hostRecovery;
    jobInvariant(
      recovery?.before === before &&
        recovery.fault === fault &&
        !recovery.completed &&
        !state.terminal,
      'host recovery requires its original pre/fault/post records exactly once',
    );
    const current = this.#runningAttempt(run, observation);
    this.#eventId(run, observation.status);
    const reason = observation.status.events
      .filter(
        (event) =>
          event.id > recovery.eventId &&
          event.createdAt > recovery.eventAt &&
          event.state === WorkloadState.Recovering,
      )
      .sort((left, right) => left.id - right.id)
      .map((event) =>
        isRecord(event.metadata) ? event.metadata.reason : undefined,
      )
      .find((value) => typeof value === 'string' && value.length > 0);
    jobInvariant(
      typeof reason === 'string' &&
        reason.includes('VM terminated (cloud confirmed)'),
      'host recovery lacks its post-fault cloud-confirmed termination reason',
    );
    const original = observation.attempts.find(
      (attempt) => attempt.rowId === recovery.original.rowId,
    );
    jobInvariant(
      original &&
        original.endedAt !== null &&
        original.endedAt >= original.createdAt &&
        (Object.keys(recovery.original) as (keyof JobNativeAttempt)[]).every(
          (key) =>
            key === 'endedAt' || original[key] === recovery.original[key],
        ) &&
        current.rowId !== original.rowId &&
        current.createdAt >= original.endedAt &&
        current.cloudId !== original.cloudId &&
        current.cloudProvider === original.cloudProvider &&
        current.credentialId === original.credentialId &&
        current.vmType === original.vmType,
      'host recovery lost its ended original attempt or distinct replacement',
    );
    this.#assertNativePlacement(run, observation.status, current);
    jobInvariant(
      identity.cloudId === current.cloudId &&
        identity.region === current.region &&
        identity.vmType === current.vmType &&
        identity.vmId.length > 0 &&
        identity.vmId !== recovery.identity.vmId &&
        identity.osDiskId.length > 0,
      'host recovery did not observe its distinct replacement native identity',
    );
    jobInvariant(
      restoredCheckpoint === recovery.checkpoint,
      'host recovery lost its exact restored checkpoint contents',
    );
    const extension = this.#extension(run, state, 'host-recovery');
    recovery.completed = true;
    return extension;
  }

  /** Pre-fault evidence: the exit-0 Job is Finalizing on its one live VM. */
  beforeEviction(
    run: JobRun,
    progress: JobProgress,
    observation: JobProgressObservation,
    identity: JobRecoveryIdentity,
  ): JobEvictionBefore {
    const state = this.#require(run);
    this.#owns(run, progress);
    jobInvariant(
      state.progress === progress &&
        progress.kind === 'active' &&
        !state.terminal &&
        !state.eviction &&
        state.profile.requiredExtensions.includes('spot-eviction'),
      'eviction requires its live original baseline exactly once',
    );
    const { status, attempts } = observation;
    const live = attempts.filter((attempt) => attempt.endedAt === null);
    jobInvariant(
      status.workload.id === run.ref.id &&
        status.workload.state === WorkloadState.Finalizing &&
        attempts.every((attempt) => attempt.ref === run.ref) &&
        live.length === 1,
      'eviction requires its own Finalizing Job on exactly one live attempt',
    );
    const original = live[0];
    jobInvariant(
      identity.cloudId === original.cloudId &&
        identity.region === original.region &&
        identity.vmType === original.vmType &&
        identity.vmId.length > 0 &&
        identity.osDiskId.length > 0,
      'eviction identity does not belong to its original attempt',
    );
    const before: JobEvictionBefore = Object.freeze({
      kind: 'before-finalizing-eviction',
      [recordBrand]: true as const,
    });
    this.#records.set(before, run);
    state.eviction = {
      before,
      original: Object.freeze({ ...original }),
      eventId: this.#eventId(run, status),
      completed: false,
    };
    return before;
  }

  evictionFault(run: JobRun, before: JobEvictionBefore): JobEvictionFault {
    const state = this.#require(run);
    this.#owns(run, before);
    const eviction = state.eviction;
    jobInvariant(
      eviction?.before === before && !eviction.fault && !state.terminal,
      'eviction requires its original pre-fault record exactly once',
    );
    const fault: JobEvictionFault = Object.freeze({
      kind: 'finalizing-eviction-acknowledged',
      [recordBrand]: true as const,
    });
    eviction.fault = fault;
    this.#records.set(fault, run);
    return fault;
  }

  /** Post-fault evidence: the product restarted the same VM while Finalizing. */
  evicted(
    run: JobRun,
    before: JobEvictionBefore,
    fault: JobEvictionFault,
    observation: JobProgressObservation,
  ): JobExtensionRecord {
    const state = this.#require(run);
    this.#owns(run, before);
    this.#owns(run, fault);
    const eviction = state.eviction;
    jobInvariant(
      eviction?.before === before &&
        eviction.fault === fault &&
        !eviction.completed &&
        !state.terminal,
      'eviction requires its original pre/fault/post records exactly once',
    );
    this.#eventId(run, observation.status);
    jobInvariant(
      jobEvictionRestarted(observation.status, eviction.eventId),
      'eviction has no final-bucket-sync-vm-restarted event after its pre-fault baseline',
    );
    const { original } = eviction;
    const old = observation.attempts.find(
      (attempt) => attempt.rowId === original.rowId,
    );
    jobInvariant(
      old?.endedAt != null &&
        old.endedAt >= original.createdAt &&
        observation.attempts.some(
          (attempt) =>
            attempt.ref === run.ref &&
            attempt.rowId !== original.rowId &&
            attempt.createdAt >= old.endedAt! &&
            (
              [
                'cloudId',
                'cloudProvider',
                'credentialId',
                'region',
                'availabilityZone',
                'vmType',
              ] as const
            ).every((key) => attempt[key] === original[key]),
        ),
      'eviction restart lost its ended original row or same-VM replacement row',
    );
    const extension = this.#extension(run, state, 'spot-eviction');
    eviction.completed = true;
    return extension;
  }

  beforeHydration(
    run: JobRun,
    progress: JobProgress,
    observation: JobHydrationObservation,
    identity: JobRecoveryIdentity,
    logs: JobHydrationApiLogs,
    disk: JobHydrationDisk,
    fixture: { readonly apiContainerId: string; readonly seedSha256: string },
  ): JobHydrationBefore {
    const state = this.#require(run);
    this.#owns(run, progress);
    jobInvariant(
      state.progress === progress &&
        progress.kind === 'active' &&
        progress.state === WorkloadState.Syncing &&
        !state.terminal &&
        !state.hydration &&
        state.profile.requiredExtensions.includes('input-hydration-recovery'),
      'hydration requires its original Syncing baseline exactly once',
    );
    const original = this.#hydratingAttempt(run, observation);
    jobInvariant(
      original.cloudProvider === state.profile.computeProvider &&
        original.region === state.profile.computeRegion &&
        state.profile.vmTypes.includes(original.vmType) &&
        identity.cloudId === original.cloudId &&
        identity.region === original.region &&
        identity.vmType === original.vmType &&
        identity.vmId.length > 0 &&
        identity.osDiskId.length > 0,
      'hydration native identity differs from its original attempt',
    );
    jobInvariant(
      disk.id === identity.osDiskId &&
        disk.type === 'gp3' &&
        disk.iops === 3000 &&
        disk.throughput === 125 &&
        disk.sizeGb === 350,
      'hydration requires the real 350 GiB medium-tier gp3 baseline',
    );
    jobInvariant(
      /^[a-f0-9]{64}$/u.test(fixture.seedSha256) &&
        /^[a-f0-9]{64}$/u.test(fixture.apiContainerId) &&
        Number.isSafeInteger(logs.launched) &&
        logs.launched > 0 &&
        Number.isSafeInteger(logs.adopted) &&
        logs.adopted >= 0,
      'hydration fixture or controller baseline is incomplete',
    );
    this.#hydrationWorker(observation.worker);
    const before: JobHydrationBefore = Object.freeze({
      kind: 'before-hydration-recovery',
      [recordBrand]: true as const,
    });
    this.#records.set(before, run);
    state.hydration = {
      before,
      original: Object.freeze({ ...original }),
      identity: Object.freeze({ ...identity }),
      worker: Object.freeze({ ...observation.worker }),
      logs: Object.freeze({ ...logs }),
      apiContainerId: fixture.apiContainerId,
      seedSha256: fixture.seedSha256,
      completed: false,
    };
    return before;
  }

  hydrationAdopted(
    run: JobRun,
    before: JobHydrationBefore,
    restart: {
      readonly identityBefore: string;
      readonly identityAfter: string;
    },
    observation: JobHydrationObservation,
    logs: JobHydrationApiLogs,
  ): void {
    const state = this.#require(run);
    this.#owns(run, before);
    const h = state.hydration;
    jobInvariant(
      h?.before === before && !h.healthy && !state.terminal,
      'hydration adoption requires its original pre-restart record',
    );
    jobInvariant(
      restart.identityBefore === h.apiContainerId &&
        restart.identityAfter === h.apiContainerId &&
        logs.launched === h.logs.launched &&
        Number.isSafeInteger(logs.adopted) &&
        logs.adopted > h.logs.adopted,
      'API restart replaced its controller or launched another hydration worker',
    );
    this.#sameHydrationAttempt(run, observation, h);
    this.#sameHydrationWorker(observation.worker, h.worker);
    jobInvariant(
      observation.worker.observedAt >= h.worker.observedAt,
      'hydration adoption precedes its baseline',
    );
  }

  hydrationHealthy(
    run: JobRun,
    before: JobHydrationBefore,
    restart: {
      readonly identityBefore: string;
      readonly identityAfter: string;
    },
    adopted: JobHydrationObservation,
    logs: JobHydrationApiLogs,
    samples: readonly JobHydrationObservation[],
  ): JobHydrationHealthy {
    this.hydrationAdopted(run, before, restart, adopted, logs);
    const h = this.#require(run).hydration!;
    let previous = adopted.worker;
    let growth = 0;
    for (const sample of samples) {
      this.#sameHydrationAttempt(run, sample, h);
      this.#sameHydrationWorker(sample.worker, h.worker);
      jobInvariant(
        sample.worker.observedAt > previous.observedAt &&
          sample.worker.logBytes >= previous.logBytes,
        'healthy hydration observations moved backwards',
      );
      if (sample.worker.logBytes > previous.logBytes) growth++;
      previous = sample.worker;
    }
    jobInvariant(
      previous.observedAt - adopted.worker.observedAt >= 870_000 && growth >= 5,
      'healthy hydration did not cross the real legacy ceiling with five growth samples',
    );
    const record: JobHydrationHealthy = Object.freeze({
      kind: 'healthy-hydration',
      [recordBrand]: true as const,
    });
    this.#records.set(record, run);
    h.healthy = record;
    h.healthyAt = previous.observedAt;
    return record;
  }

  hydrationFault(
    run: JobRun,
    healthy: JobHydrationHealthy,
    observation: JobHydrationObservation,
    activity: JobHydrationActivity,
  ): JobHydrationFault {
    const state = this.#require(run);
    this.#owns(run, healthy);
    const h = state.hydration;
    jobInvariant(
      h?.healthy === healthy &&
        !h.fault &&
        !state.terminal &&
        h.healthyAt !== undefined,
      'hydration fault requires its original healthy proof exactly once',
    );
    this.#sameHydrationAttempt(run, observation, h);
    this.#sameHydrationWorker(observation.worker, h.worker);
    jobInvariant(
      activity.visibleBytes === 0 &&
        Number.isSafeInteger(activity.hiddenBytes) &&
        activity.hiddenBytes > 0 &&
        activity.hiddenBytes >= observation.worker.logBytes &&
        Number.isSafeInteger(activity.observedAt) &&
        observation.worker.observedAt >= h.healthyAt &&
        activity.observedAt >= observation.worker.observedAt,
      'hydration fault did not hide actual activity after its healthy proof',
    );
    h.eventId = this.#eventId(run, observation.status);
    h.eventAt = Math.max(
      0,
      ...observation.status.events.map((event) => event.createdAt),
    );
    const record: JobHydrationFault = Object.freeze({
      kind: 'hydration-visible-activity-hidden',
      [recordBrand]: true as const,
    });
    this.#records.set(record, run);
    h.fault = record;
    h.activity = Object.freeze({ ...activity });
    return record;
  }

  hydrated(
    run: JobRun,
    before: JobHydrationBefore,
    healthy: JobHydrationHealthy,
    fault: JobHydrationFault,
    hidden: JobHydrationActivity,
    retry: JobHydrationObservation,
    resumed: JobHydrationObservation,
    identity: JobRecoveryIdentity,
    manifest: Readonly<
      Record<'count' | 'bytes' | 'first' | 'middle' | 'last', string>
    >,
  ): JobExtensionRecord {
    const state = this.#require(run);
    for (const record of [before, healthy, fault]) this.#owns(run, record);
    const h = state.hydration;
    jobInvariant(
      h?.before === before &&
        h.healthy === healthy &&
        h.fault === fault &&
        h.activity &&
        h.eventId !== undefined &&
        h.eventAt !== undefined &&
        !h.completed &&
        !state.terminal,
      'hydration recovery requires its original pre/healthy/fault/post records exactly once',
    );
    jobInvariant(
      hidden.visibleBytes === 0 &&
        Number.isSafeInteger(hidden.hiddenBytes) &&
        hidden.hiddenBytes > h.activity.hiddenBytes &&
        Number.isSafeInteger(hidden.observedAt) &&
        hidden.observedAt <= retry.worker.observedAt &&
        hidden.observedAt - h.activity.observedAt >= 75_000,
      'hydration worker did not continue real progress behind the hidden log',
    );
    this.#eventId(run, retry.status);
    jobInvariant(
      retry.status.workload.id === run.ref.id &&
        retry.attempts.length === 1 &&
        (Object.keys(h.original) as (keyof JobNativeAttempt)[]).every(
          (key) => retry.attempts[0][key] === h.original[key],
        ) &&
        Number.isSafeInteger(retry.worker.observedAt) &&
        retry.worker.observedAt - h.activity.observedAt >= 900_000 &&
        retry.worker.observedAt - h.activity.observedAt <= 1_080_000 &&
        jobHydrationRetryEvent(retry.status, run.ref.id, h.eventId, h.eventAt),
      'hydration did not observe its production inactivity retry within the original timing bounds',
    );
    this.#sameHydrationAttempt(run, resumed, h);
    this.#hydrationWorker(resumed.worker);
    jobInvariant(
      resumed.worker.observedAt >= retry.worker.observedAt &&
        resumed.worker.invocation !== h.worker.invocation &&
        resumed.worker.identity === h.worker.identity,
      'hydration retry did not run the same work in a new worker',
    );
    jobInvariant(
      (Object.keys(h.identity) as (keyof JobRecoveryIdentity)[]).every(
        (key) => identity[key] === h.identity[key],
      ),
      'hydration retry changed the exact original VM or boot disk',
    );
    jobInvariant(
      manifest.count === '2048' &&
        manifest.bytes === String(2048 * 128 * 1024 * 1024) &&
        [manifest.first, manifest.middle, manifest.last].every(
          (hash) => hash === h.seedSha256,
        ),
      'hydration did not validate the full real data and three original shard hashes',
    );
    h.completed = true;
    return this.#extension(run, state, 'input-hydration-recovery');
  }

  #hydratingAttempt(
    run: JobRun,
    observation: JobHydrationObservation,
  ): JobNativeAttempt {
    jobInvariant(
      observation.status.workload.id === run.ref.id &&
        observation.status.workload.state === WorkloadState.Syncing &&
        observation.attempts.length === 1 &&
        observation.attempts[0].ref === run.ref &&
        observation.attempts[0].endedAt === null,
      'hydration requires its one original live attempt in Syncing',
    );
    const attempt = observation.attempts[0];
    this.#assertNativePlacement(run, observation.status, attempt);
    return attempt;
  }

  #assertNativePlacement(
    run: JobRun,
    status: StatusResponse,
    attempt: JobNativeAttempt,
  ): void {
    const { profile } = this.#require(run);
    const { workload } = status;
    const requestedTypes = Array.isArray(workload.vmType)
      ? workload.vmType
      : [workload.vmType];
    const live = this.#vmLedger.liveEntries(
      this.#vmLedger.snapshot(run.ref, status),
    );
    // Workload fields retain requested placement; VM rows carry its resolution.
    jobInvariant(
      workload.id === run.ref.id &&
        attempt.ref === run.ref &&
        attempt.cloudProvider === profile.computeProvider &&
        workload.cloudProvider === attempt.cloudProvider &&
        workload.region === (profile.computeRegion || null) &&
        requestedTypes.length === profile.vmTypes.length &&
        requestedTypes.every(
          (type, index) => type === profile.vmTypes[index],
        ) &&
        profile.vmTypes.includes(attempt.vmType) &&
        (!profile.computeRegion || profile.computeRegion === attempt.region) &&
        live.length === 1 &&
        String(live[0].cloudId) === attempt.cloudId &&
        live[0].region === attempt.region &&
        (live[0].availabilityZone ?? null) === attempt.availabilityZone,
      'recovery status changed its requested or native placement',
    );
  }
  #sameHydrationAttempt(
    run: JobRun,
    observation: JobHydrationObservation,
    h: HydrationState,
  ): void {
    const attempt = this.#hydratingAttempt(run, observation);
    jobInvariant(
      (Object.keys(h.original) as (keyof JobNativeAttempt)[]).every(
        (key) => attempt[key] === h.original[key],
      ),
      'hydration changed its original VM attempt',
    );
  }
  #hydrationWorker(worker: JobHydrationWorker): void {
    jobInvariant(
      worker.active &&
        /^[a-f0-9]{32}$/u.test(worker.invocation) &&
        Number.isSafeInteger(worker.pid) &&
        worker.pid > 0 &&
        /^[a-f0-9]{64}$/u.test(worker.identity) &&
        Number.isSafeInteger(worker.logBytes) &&
        worker.logBytes >= 0 &&
        Number.isSafeInteger(worker.observedAt) &&
        worker.observedAt > 0,
      'hydration worker observation is incomplete',
    );
  }
  #sameHydrationWorker(
    worker: JobHydrationWorker,
    original: JobHydrationWorker,
  ): void {
    this.#hydrationWorker(worker);
    jobInvariant(
      worker.invocation === original.invocation &&
        worker.pid === original.pid &&
        worker.identity === original.identity,
      'hydration replaced its adopted worker',
    );
  }

  #runningAttempt(
    run: JobRun,
    observation: JobProgressObservation,
  ): JobNativeAttempt {
    jobInvariant(
      observation.status.workload.id === run.ref.id &&
        observation.status.workload.state === WorkloadState.Running &&
        observation.attempts.every((attempt) => attempt.ref === run.ref),
      'recovery requires its own Running observation',
    );
    const live = observation.attempts.filter(
      (attempt) => attempt.endedAt === null,
    );
    jobInvariant(
      live.length === 1,
      'recovery requires exactly one live original attempt',
    );
    return live[0];
  }

  #eventId(run: JobRun, status: StatusResponse): number {
    jobInvariant(
      new Set(status.events.map((event) => event.id)).size ===
        status.events.length &&
        status.events.every(
          (event) =>
            event.workloadId === run.ref.id &&
            Number.isSafeInteger(event.id) &&
            event.id > 0,
        ),
      'recovery event history contains a foreign or invalid event',
    );
    return Math.max(0, ...status.events.map((event) => event.id));
  }

  progress(run: JobRun, observation: JobProgressObservation): JobProgress {
    const state = this.#require(run);
    jobInvariant(!state.progress && !state.terminal, 'baseline is single use');
    const { status, attempts } = observation;
    jobInvariant(
      status.workload.id === run.ref.id,
      'baseline belongs to another Workload',
    );
    jobInvariant(
      attempts.every((attempt) => attempt.ref === run.ref),
      'baseline contains foreign attempts',
    );
    const active =
      status.workload.state === WorkloadState.Running ||
      (state.profile.requiredExtensions.includes('input-hydration-recovery') &&
        status.workload.state === WorkloadState.Syncing);
    jobInvariant(
      active || JOB_TERMINAL_STATES.includes(status.workload.state),
      'baseline has not reached active or terminal',
    );
    if (active)
      jobInvariant(
        attempts.filter((attempt) => attempt.endedAt === null).length === 1,
        'active baseline requires exactly one live attempt',
      );
    const record: JobProgress = Object.freeze({
      kind: active ? 'active' : 'terminal-before-active',
      state: status.workload.state,
      [recordBrand]: true as const,
    });
    this.#records.set(record, run);
    state.progress = record;
    return record;
  }

  extension(
    run: JobRun,
    progress: JobProgress,
    kind: JobExtension,
  ): JobExtensionRecord {
    const state = this.#require(run);
    this.#owns(run, progress);
    jobInvariant(
      state.progress === progress && progress.kind === 'active',
      'extension requires its active baseline',
    );
    jobInvariant(
      !state.terminal,
      'extension arrived after terminal observation',
    );
    jobInvariant(
      kind !== 'same-id-resubmission',
      'resubmission extension requires its generation transition',
    );
    jobInvariant(
      kind !== 'in-place-recovery',
      'recovery extension requires its original pre/fault/post records',
    );
    jobInvariant(
      kind !== 'host-recovery',
      'host recovery extension requires its original pre/fault/post records',
    );
    jobInvariant(
      kind !== 'spot-eviction',
      'eviction extension requires its original pre/fault/post records',
    );
    jobInvariant(
      kind !== 'input-hydration-recovery',
      'hydration extension requires its original pre/healthy/fault/post records',
    );
    return this.#extension(run, state, kind);
  }

  /** A spot Job terminated before it ran, whose request then ended cancelled. */
  spotEarlyCancel(run: JobRun, progress: JobProgress): JobExtensionRecord {
    const state = this.#require(run);
    this.#owns(run, progress);
    jobInvariant(
      state.progress === progress &&
        progress.kind === 'terminal-before-active' &&
        progress.state === WorkloadState.Terminated,
      'early Spot cancellation requires its terminated baseline',
    );
    return this.#extension(run, state, 'spot-request-cleanup');
  }

  /** The spot-eviction member's sibling ends `exited` with no retries left. */
  spotExit(
    run: JobRun,
    progress: JobProgress,
    status: StatusResponse,
  ): JobExtensionRecord {
    const state = this.#require(run);
    this.#owns(run, progress);
    jobInvariant(
      state.progress === progress && progress.kind === 'active',
      'spot exit requires its active baseline',
    );
    jobInvariant(
      status.workload.id === run.ref.id &&
        status.workload.state === WorkloadState.Completed &&
        status.workload.endReason === 'exited',
      `the spot Job's clean exit ended ${String(status.workload.endReason)}`,
    );
    return this.#extension(run, state, 'spot-eviction');
  }

  #extension(
    run: JobRun,
    state: RunState,
    kind: JobExtension,
  ): JobExtensionRecord {
    jobInvariant(
      state.profile.requiredExtensions.includes(kind),
      'extension is not a member requirement',
    );
    jobInvariant(!state.extensions.has(kind), 'extension record was reused');
    const record: JobExtensionRecord = Object.freeze({
      kind,
      [recordBrand]: true as const,
    });
    this.#records.set(record, run);
    state.extensions.set(kind, record);
    return record;
  }

  terminal(run: JobRun, status: StatusResponse): JobTerminal {
    const state = this.#require(run);
    jobInvariant(
      state.progress && !state.terminal,
      'terminal requires one baseline and is single use',
    );
    jobInvariant(
      status.workload.id === run.ref.id,
      'terminal belongs to another Workload',
    );
    jobInvariant(
      status.workload.state === state.profile.expectedTerminalState,
      'unexpected terminal outcome',
    );
    const record: JobTerminal = Object.freeze({
      state: status.workload.state,
      [recordBrand]: true as const,
    });
    this.#records.set(record, run);
    state.terminal = record;
    return record;
  }

  /** Synchronously claim finalization before any cleanup/release awaits. */
  claim(
    run: JobRun,
    progress: JobProgress,
    extensions: readonly JobExtensionRecord[],
    terminal: JobTerminal,
  ): void {
    const state = this.#require(run);
    for (const record of [progress, ...extensions, terminal])
      this.#owns(run, record);
    jobInvariant(
      state.progress === progress && state.terminal === terminal,
      'finalizer records do not match this run',
    );
    jobInvariant(
      extensions.length === state.profile.requiredExtensions.length,
      'finalizer is missing required extensions',
    );
    const unique = new Set(extensions);
    jobInvariant(
      unique.size === extensions.length,
      'finalizer repeats an extension',
    );
    for (const kind of state.profile.requiredExtensions) {
      const expected = state.extensions.get(kind);
      jobInvariant(
        expected && unique.has(expected),
        `finalizer is missing ${kind}`,
      );
    }
    state.finalizing = true;
  }

  #owns(run: JobRun, record: object): void {
    jobInvariant(
      this.#records.get(record) === run,
      'copied, missing or mismatched evidence record',
    );
  }

  #require(run: JobRun): RunState {
    const state = this.#runs.get(run);
    jobInvariant(state, 'unknown Job run');
    jobInvariant(
      this.#generations.get(run.ref) === run.generation,
      'stale Job generation',
    );
    jobInvariant(!state.finalizing, 'Job finalizer is single use');
    return state;
  }
}
