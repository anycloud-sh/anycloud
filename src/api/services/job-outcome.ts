import { WorkloadState } from '../../shared/workload.js';

/**
 * Why one attempt of a Job ended, in words that name what happened rather
 * than the object that showed it. Every substrate's classifier returns one;
 * `detail` carries the substrate's own wording, so policies never add any.
 */
export type Cause =
  | { kind: 'exit'; code: number; oom: boolean }
  | { kind: 'disrupted'; detail: string }
  | { kind: 'evicted-storage'; detail: string }
  | { kind: 'deadline'; detail: string }
  /** An image that can't be pulled, or a submission a scheduler refuses. */
  | { kind: 'unrecoverable'; detail: string }
  /** The runner's final upload made no progress for 15 minutes. */
  | { kind: 'transfer'; detail: string }
  /** Nothing observable: always a valid answer. */
  | { kind: 'lost'; detail: string };

/**
 * A pool Job's retry reason when its Node's GPU proved faulty. Its
 * retries have their own cap, so a Job's `maxRetries` doesn't count them.
 */
export const UNUSABLE_GPU_POOL_RETRY =
  'GPU unusable on its Node; retrying on another Node';

/**
 * A pool Job's retry reason when its Node's GPUs passed the check, or it
 * couldn't run: the Job reruns once in a new Pod, with no Node action.
 * It has its own cap too.
 */
export const UNUSABLE_GPU_POOL_RERUN =
  'GPU unusable in its container; rerunning once in a new Pod';

export type Outcome =
  | { state: WorkloadState.Completed }
  | { state: WorkloadState.Errored; exitCode: number; error: string }
  | { state: WorkloadState.Failed; error: string }
  | { state: WorkloadState.Invalid; error: string }
  | { state: WorkloadState.Retrying; reason: string };

/** One entry per Cause kind, so a new kind fails to compile until every
 *  policy table handles it. */
export type OutcomePolicy<O extends Outcome = Outcome> = {
  readonly [K in Cause['kind']]: (cause: Extract<Cause, { kind: K }>) => O;
};

export function outcomeOf<O extends Outcome>(
  policy: OutcomePolicy<O>,
  cause: Cause,
): O {
  return (policy[cause.kind] as (cause: Cause) => O)(cause);
}

/** The end `policy` gives `cause`, as the attempt writer records it. */
export function attemptEndOf(policy: OutcomePolicy, cause: Cause) {
  const outcome = outcomeOf(policy, cause);
  return {
    state: outcome.state,
    reason:
      'reason' in outcome
        ? outcome.reason
        : (outcome as { error?: string }).error,
    cause,
  };
}

const failed = (error: string): Outcome => ({
  state: WorkloadState.Failed,
  error,
});
const invalid = (error: string): Outcome => ({
  state: WorkloadState.Invalid,
  error,
});
const retrying = (reason: string): Outcome => ({
  state: WorkloadState.Retrying,
  reason,
});

type Retry = Extract<Outcome, { state: WorkloadState.Retrying }>;
const replica = (reason: string): Retry => ({
  state: WorkloadState.Retrying,
  reason: `replica ${reason}`,
});
/**
 * An execution on a user Deployment's long-lived replica: every end its
 * handler didn't report means the process went away, so each one retries
 * with what happened.
 */
export const DEPLOYMENT_POLICY: OutcomePolicy<Retry> = {
  exit: (c) =>
    replica(
      c.oom ? `OOMKilled (exit ${c.code})` : `exited with code ${c.code}`,
    ),
  disrupted: (c) => replica(c.detail),
  'evicted-storage': (c) => replica(c.detail),
  deadline: (c) => replica(c.detail),
  unrecoverable: (c) => replica(c.detail),
  transfer: (c) => replica(c.detail),
  lost: (c) => replica(`lost: ${c.detail}`),
};

/**
 * What an attempt's end means for a finite Job (RFC 0044's classification
 * table), and for every pool Job on a managed Deployment. A deadline ends
 * only the attempt of a resumable Job (RFC 0046).
 */
export const batchPolicy = ({
  resumable,
}: {
  resumable: boolean;
}): OutcomePolicy => ({
  exit: (c) =>
    c.code === 0
      ? { state: WorkloadState.Completed }
      : {
          state: WorkloadState.Errored,
          exitCode: c.code,
          error: c.oom
            ? `OOMKilled (exit ${c.code})`
            : `Exited with code ${c.code}`,
        },
  disrupted: (c) => retrying(c.detail),
  'evicted-storage': (c) => invalid(c.detail),
  deadline: (c) => (resumable ? retrying(c.detail) : failed(c.detail)),
  unrecoverable: (c) => invalid(c.detail),
  transfer: (c) => failed(`Final bucket sync failed: ${c.detail}`),
  lost: (c) => failed(`Job outcome lost: ${c.detail}`),
});

const batch = batchPolicy({ resumable: false });
/**
 * A managed Deployment's replica that ended before its runner reported. A
 * plain exit is the runner's, not the Job's, so the Job retries; an OOM, an
 * eviction for storage or a lost replica ends it (RFC 0044 § Outcomes).
 * Containerd keeps a container's `OOMKilled` reason, so an exit 0 that
 * carries it is never taken as the Job's success.
 */
export const RUNNER_REPLICA_POLICY: OutcomePolicy = {
  ...batch,
  exit: (c) =>
    c.oom && c.code !== 0
      ? batch.exit(c)
      : retrying(`runner exited with code ${c.code}`),
};
