/** Canonical workload primitive and lifecycle vocabulary. */

export enum WorkloadType {
  Job = 'job',
  Service = 'service',
  Vm = 'vm',
}

export type WorkloadTypeValue = 'job' | 'service' | 'vm';

export enum WorkloadState {
  // Waiting for a provisioning slot
  Queued = 'queued',

  // Deploy steps (ordered)
  Provisioning = 'provisioning',
  Initializing = 'initializing', // SSH + install Docker/rclone binaries
  Downloading = 'downloading', // Docker image pull
  Starting = 'starting', // Container start + health check
  Syncing = 'syncing', // Startup bucket sync (rclone)

  // Operation states
  Retrying = 'retrying', // Auto-retry after failed workload
  Recovering = 'recovering', // Spot VM preempted, replacing in place

  // Running (after all steps complete)
  Running = 'running',

  // Workload exited; preserving final output/checkpoint artifacts
  Finalizing = 'finalizing',

  // Terminal states
  Completed = 'completed', // job exited with code 0
  Failed = 'failed', // VM never started
  Errored = 'errored', // job exited non-zero
  Invalid = 'invalid', // bad user config (bucket name, etc.) — never retried
  Terminated = 'terminated', // user explicitly terminated
}

export const DEPLOY_STEPS = [
  WorkloadState.Provisioning,
  WorkloadState.Initializing,
  WorkloadState.Downloading,
  WorkloadState.Syncing,
  WorkloadState.Starting,
] as const;

export type DeployPipelineState = (typeof DEPLOY_STEPS)[number];

export function isDeployPipelineState(
  state: WorkloadState,
): state is DeployPipelineState {
  return DEPLOY_STEPS.includes(state as DeployPipelineState);
}

export const stateEmoji: Record<WorkloadState, string> = {
  [WorkloadState.Queued]: '⏳',
  [WorkloadState.Provisioning]: '🏗️',
  [WorkloadState.Initializing]: '⚙️',
  [WorkloadState.Downloading]: '📥',
  [WorkloadState.Starting]: '🚀',
  [WorkloadState.Syncing]: '💾',
  [WorkloadState.Retrying]: '🛠️',
  [WorkloadState.Recovering]: '🔁',
  [WorkloadState.Running]: '⚡',
  [WorkloadState.Finalizing]: '🏁',
  [WorkloadState.Completed]: '✅',
  [WorkloadState.Failed]: '❌',
  [WorkloadState.Errored]: '🪲',
  [WorkloadState.Invalid]: '🚫',
  [WorkloadState.Terminated]: '🪦',
};

/**
 * FSM transition map: for each target state, the set of states that may transition into it.
 * Enforced atomically in updateState() via WHERE state IN (...).
 * Generic non-queued, non-terminal self-transitions are allowed for idempotent re-entry.
 * updateState() throws for queued/terminal targets and returns false when the FSM blocks;
 * runStep() throws StateConflictError on false.
 *
 * Flows:
 *
 *   Deploy pipeline:
 *     Queued → Provisioning → Initializing → Downloading → [Syncing] → Starting → Running
 *     Any deploy step failure → Retrying → (backoff + VM cleanup) → Queued (retry)
 *     Retrying/Recovering → Failed (retries exhausted or missing credentials)
 *
 *   Job completion/finalization reconciliation:
 *     Jobs publish Completed/Errored directly, then release provider resources
 *     Final-sync jobs pass through Finalizing before either outcome
 *     Final artifact sync failure stays in Finalizing while retrying, then Failed after exhaustion
 *
 *   Spot preemption (reconciler poll lane, every 30s):
 *     Any PREEMPTIBLE_STATE → Recovering → Queued (full re-provision)
 *     Running → Recovering → Starting (successful in-place job VM restart)
 *     Running → Recovering → Running (successful in-place server VM restart)
 *     The two in-place exits use a scoped exact-state store operation; they are
 *     intentionally not generic FSM transitions, so stale deploy work cannot
 *     overwrite a concurrent recovery claim.
 *
 *   API restart repair:
 *     Provisioning with no active attempt → Queued (repeat scheduler admission)
 *     This is an exact-state, no-active-row store operation rather than a
 *     generic FSM transition, so a newly registered attempt wins the race.
 *
 *   Cleanup admission:
 *     Every terminal outcome has cleaned_at=NULL until provider teardown succeeds
 *     User termination publishes Terminated before beginning teardown
 *     Cleanup never appends a workload state event
 *
 *   User-input error (isUserError in error-formatter.ts):
 *     Any deploy step or Retrying → Invalid (never retried)
 *
 *   State semantics:
 *     Errored = container/application failure (non-zero exit)
 *     Failed  = infrastructure failure (SSH, timeout, VM never started, final artifact sync exhausted, retries exhausted)
 *     Invalid = user-input configuration error (invalid bucket name, etc.) — never retried
 *     Terminated = user explicitly terminated (or no meaningful exit state)
 */
export const VALID_TRANSITIONS: Record<WorkloadState, WorkloadState[]> = {
  [WorkloadState.Queued]: [WorkloadState.Retrying, WorkloadState.Recovering],
  [WorkloadState.Provisioning]: [WorkloadState.Queued],
  [WorkloadState.Initializing]: [WorkloadState.Provisioning],
  [WorkloadState.Downloading]: [
    WorkloadState.Initializing,
    WorkloadState.Starting, // resumeOnExistingVM re-pulls after spot recovery
  ],
  // Queued → Syncing: a runner claims a pool Job (RFC 0044).
  [WorkloadState.Syncing]: [
    WorkloadState.Queued,
    WorkloadState.Downloading,
    WorkloadState.Starting,
  ],
  [WorkloadState.Starting]: [
    WorkloadState.Downloading,
    WorkloadState.Syncing,
    WorkloadState.Running,
  ],
  // Starting → Running (VM host) and Provisioning → Running (workloads that
  // skip the host-side Initializing/Downloading/Starting steps).
  [WorkloadState.Running]: [
    WorkloadState.Starting,
    WorkloadState.Provisioning,
    WorkloadState.Syncing,
  ],
  [WorkloadState.Finalizing]: [WorkloadState.Running],
  [WorkloadState.Retrying]: [
    WorkloadState.Provisioning,
    WorkloadState.Initializing,
    WorkloadState.Downloading,
    WorkloadState.Syncing,
    WorkloadState.Starting,
    // checkJobCompletion routes Running → Retrying when the container exit
    // looks like a host-level GPU flake (CUDA_ERROR_NO_DEVICE) rather than
    // user code.
    WorkloadState.Running,
    // A runner stopped by its replica's SIGTERM after the command ended.
    WorkloadState.Finalizing,
  ],
  [WorkloadState.Recovering]: [
    WorkloadState.Initializing,
    WorkloadState.Downloading,
    WorkloadState.Syncing,
    WorkloadState.Starting,
    WorkloadState.Running,
  ],
  [WorkloadState.Completed]: [WorkloadState.Running, WorkloadState.Finalizing],
  [WorkloadState.Errored]: [WorkloadState.Running, WorkloadState.Finalizing],
  [WorkloadState.Failed]: [
    // A provider-confirmed persistent-VM host loss is an infrastructure
    // failure even though the workload had already reached Running.
    WorkloadState.Running,
    // The API's own network blocks DNS publication; no retry can succeed.
    WorkloadState.Starting,
    WorkloadState.Retrying,
    WorkloadState.Recovering,
    WorkloadState.Finalizing,
  ],
  [WorkloadState.Invalid]: [
    WorkloadState.Queued,
    WorkloadState.Provisioning,
    WorkloadState.Initializing,
    WorkloadState.Downloading,
    WorkloadState.Syncing,
    WorkloadState.Starting,
    WorkloadState.Retrying,
  ],
  [WorkloadState.Terminated]: [
    WorkloadState.Queued,
    WorkloadState.Provisioning,
    WorkloadState.Initializing,
    WorkloadState.Downloading,
    WorkloadState.Syncing,
    WorkloadState.Starting,
    WorkloadState.Running,
    WorkloadState.Finalizing,
    WorkloadState.Retrying,
    WorkloadState.Recovering,
  ],
};

/**
 * A targeted execution holds its replica's slot in these states: a runner's
 * Job stages, runs and uploads (RFC 0044); an SDK handler's Job only runs.
 */
export const LIVE_EXECUTION_STATES: WorkloadState[] = [
  WorkloadState.Syncing,
  WorkloadState.Running,
  WorkloadState.Finalizing,
];

// States where a spot VM can be preempted and reconciliation should act.
// Excludes states with no completed VM yet (Queued, Provisioning) and states
// already in cleanup/recovery (Retrying, Recovering).
export const PREEMPTIBLE_STATES: WorkloadState[] = [
  WorkloadState.Initializing,
  WorkloadState.Downloading,
  WorkloadState.Syncing,
  WorkloadState.Starting,
  WorkloadState.Running,
];

// State groupings for filtering
export const ACTIVE_STATES: WorkloadState[] = [
  WorkloadState.Queued,
  WorkloadState.Provisioning,
  WorkloadState.Initializing,
  WorkloadState.Downloading,
  WorkloadState.Starting,
  WorkloadState.Syncing,
  WorkloadState.Retrying,
  WorkloadState.Recovering,
  WorkloadState.Running,
  WorkloadState.Finalizing,
];

// States where the container ran and exited
// - Completed: container exited with code 0
// - Errored: container exited with non-zero code
const EXITED_STATES: WorkloadState[] = [
  WorkloadState.Completed,
  WorkloadState.Errored,
];

// Terminal outcomes other than a normal container exit. Provider teardown is
// tracked independently by workloads.cleaned_at; none of these states imply
// that every resource is already gone.
const TERMINATED_STATES: WorkloadState[] = [
  WorkloadState.Failed,
  WorkloadState.Invalid,
  WorkloadState.Terminated,
];

// All final states (superset of EXITED_STATES + TERMINATED_STATES)
export const TERMINAL_STATES: WorkloadState[] = [
  ...EXITED_STATES,
  ...TERMINATED_STATES,
];

export function isTerminalState(state: WorkloadState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * Why a workload ended (RFC 0049 C15): set with its terminal state, null
 * before it. Each value's meaning is in docs/platform/jobs.md#lifecycle.
 */
export const END_REASONS = [
  'exited',
  'cancelled',
  'reclaimed',
  'lost',
  'timeout',
  'retries-exhausted',
  'invalid',
] as const;
export type EndReason = (typeof END_REASONS)[number];

const STATE_END_REASONS: Partial<Record<WorkloadState, EndReason>> = {
  [WorkloadState.Completed]: 'exited',
  [WorkloadState.Errored]: 'exited',
  [WorkloadState.Invalid]: 'invalid',
  [WorkloadState.Terminated]: 'cancelled',
};

/** The end reason a terminal state implies when nothing more is known. */
export function endReasonOfState(state: WorkloadState): EndReason {
  return STATE_END_REASONS[state] ?? 'lost';
}

/**
 * True when a workload has reached its outcome but still owns a provider VM.
 *
 * Cleanup is tracked on its own axis (`cleanedAt`) precisely so it never
 * clobbers the outcome, which means a terminal state alone says nothing about
 * whether the machine is gone — or whether the user is still being billed for
 * it. Every surface that renders a terminal state should ask this too.
 *
 * `cleanedAt` is absent on responses from older APIs, so the live VM count is
 * the authority and `cleanedAt` only suppresses the flag once teardown has
 * been committed.
 */
export function isReleasingResources(workload: {
  state: WorkloadState;
  cleanedAt?: number | null;
  vmCount: number;
}): boolean {
  return (
    isTerminalState(workload.state) &&
    workload.vmCount > 0 &&
    (workload.cleanedAt === undefined || workload.cleanedAt === null)
  );
}

export function isWorkloadHealthCheckableState(state: WorkloadState): boolean {
  return state === WorkloadState.Running;
}

// Terminal states a workload can be resubmitted from. Excludes Completed:
// resubmit re-runs a workload that didn't succeed; a finished (exit 0) run is
// started again with a fresh submit, not by resetting the completed one in place.
export const RESUBMITTABLE_STATES: WorkloadState[] = TERMINAL_STATES.filter(
  (state) => state !== WorkloadState.Completed,
);

export function isResubmittable(state: WorkloadState): boolean {
  return RESUBMITTABLE_STATES.includes(state);
}

/** Named server-side workload sets used by action pickers. */
export type ListStateClass = 'terminatable' | 'resubmittable';
