import { ORPCError } from '@orpc/client';
import { LocalApiUnavailableError } from '../../shared/services/api-client/runtime.js';
import type { WorkloadStatusResponse } from '../../shared/api-contract/workload-management-schemas.js';
import type { ClusterSummary } from '../../shared/api-contract/clusters-schemas.js';
import {
  WorkloadState,
  WorkloadType,
  isTerminalState,
  type EndReason,
} from '../../shared/workload.js';
import { errorMessage } from '../../shared/log-diagnostics.js';

/** `anycloud wait` exit codes; 3 stays reserved for truncated output, 130 is Ctrl-C. */
export const WAIT_EXIT = {
  succeeded: 0,
  failed: 1,
  'observer-error': 2,
  timeout: 4,
} as const;

const WAIT_HEARTBEAT_MS = 30 * 60_000;
const WAIT_POLL_MS = 5_000;
const WAIT_MAX_BACKOFF_MS = 60_000;
const WAIT_READ_CONCURRENCY = 8;

/** What can be waited on: a Workload by bare ID, or a typed reference. */
export type WaitTarget =
  | { readonly kind: 'workload'; readonly id: string }
  | { readonly kind: 'cluster'; readonly id: string };

/** One status read of a target. */
export type WaitObservation =
  | { readonly kind: 'workload'; readonly status: WorkloadStatusResponse }
  | { readonly kind: 'cluster'; readonly cluster: ClusterSummary };

export interface WaitDependencies {
  read(target: WaitTarget, signal?: AbortSignal): Promise<WaitObservation>;
  emit(record: WaitRecord): void;
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface WaitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

type WaitOutcomeName = keyof typeof WAIT_EXIT;
type Outcome = 'succeeded' | 'failed' | 'pending';

const TYPED_REFERENCE = /^cluster\/(.+)$/u;

/** `cluster/<id>`, or a Workload ID. */
export function parseWaitTarget(reference: string): WaitTarget {
  const typed = TYPED_REFERENCE.exec(reference);
  if (typed) return { kind: 'cluster', id: typed[1] };
  if (reference.includes('/')) {
    throw new Error(
      `Cannot wait on "${reference}": use a Workload ID or cluster/<id>`,
    );
  }
  return { kind: 'workload', id: reference };
}

/** How a target is shown and keyed: its typed reference, or the Workload ID. */
function waitReference(target: WaitTarget): string {
  return target.kind === 'workload' ? target.id : `${target.kind}/${target.id}`;
}

/** What `wait` makes of one read: whether the target succeeded, and why not yet. */
interface Classified {
  readonly state: string;
  readonly outcome: Outcome;
  readonly ready?: true;
  readonly exitCode?: number;
  /** Why a Workload ended, such as `claim-deadline-expired`. */
  readonly reason?: string;
  /** A Workload's stable end reason, and the final attempt's once retries ran out. */
  readonly endReason?: EndReason;
  readonly lastAttemptEndReason?: EndReason;
  /** What the target is waiting on. */
  readonly message?: string;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Success per kind, from the shared state vocabulary: a Job at Completed; a
 * Service, VM or cluster at Running. Any other final state is a failure.
 */
function classify(observation: WaitObservation): Classified {
  switch (observation.kind) {
    case 'workload': {
      const { workload, events } = observation.status;
      const job = workload.workloadType === WorkloadType.Job;
      const target = job ? WorkloadState.Completed : WorkloadState.Running;
      const outcome: Outcome =
        workload.state === target
          ? 'succeeded'
          : isTerminalState(workload.state)
            ? 'failed'
            : 'pending';
      const metadata = events.at(-1)?.metadata ?? {};
      const exitCode = metadata.exitCode;
      return {
        state: workload.state,
        outcome,
        ...(outcome === 'succeeded' && !job && { ready: true as const }),
        ...(workload.endReason && { endReason: workload.endReason }),
        ...(workload.lastAttemptEndReason && {
          lastAttemptEndReason: workload.lastAttemptEndReason,
        }),
        ...(outcome === 'failed' &&
          typeof exitCode === 'number' && { exitCode }),
        ...(outcome === 'failed' &&
          text(metadata.reason) && { reason: text(metadata.reason) }),
        ...(outcome !== 'succeeded' &&
          text(metadata.message) && { message: text(metadata.message) }),
      };
    }
    case 'cluster': {
      const resource = observation.cluster;
      const outcome: Outcome =
        resource.state === WorkloadState.Running
          ? 'succeeded'
          : resource.state === WorkloadState.Failed ||
              resource.state === WorkloadState.Terminated
            ? 'failed'
            : 'pending';
      return {
        state: resource.state,
        outcome,
        ...(outcome === 'succeeded' && { ready: true as const }),
        ...(outcome !== 'succeeded' &&
          text(resource.lastError) && { message: text(resource.lastError) }),
      };
    }
  }
}

/** What `wait` observed, in order; the renderer prints each as a line or JSON. */
type WaitEvent =
  | ({
      type: 'state';
      ref: string;
      kind: WaitTarget['kind'];
      previousState: string | null;
      /** The Workload status read, for the retry facts a Retrying line carries. */
      status?: WorkloadStatusResponse;
    } & Omit<Classified, 'outcome'>)
  | {
      type: 'heartbeat';
      states: Record<string, number>;
      elapsedMs: number;
    }
  | { type: 'observer'; status: 'degraded' | 'recovered'; error?: string }
  | {
      type: 'result';
      outcome: WaitOutcomeName;
      succeeded: string[];
      failed: string[];
      pending: string[];
      timeoutMs?: number;
      error?: { ref: string; message: string };
    };

export type WaitRecord = WaitEvent & { observedAt: number };

/** `90s`, `30m` or `2h`, in milliseconds. */
export function parseWaitTimeout(value: string): number {
  const match = /^([1-9]\d*)([smh])$/.exec(value);
  if (!match) {
    throw new Error(
      `--timeout must be a whole number of seconds, minutes or hours, such as 90s, 30m or 2h (got "${value}")`,
    );
  }
  const unit = { s: 1_000, m: 60_000, h: 3_600_000 }[
    match[2] as 's' | 'm' | 'h'
  ];
  return Number(match[1]) * unit;
}

/**
 * Errors waiting cannot fix: 4xx answers (other than 408 and 429) and a
 * local API that is not running. Transport failures, timeouts and 5xx are
 * retried.
 */
function isPermanent(error: unknown): boolean {
  if (error instanceof LocalApiUnavailableError) return true;
  return (
    error instanceof ORPCError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

interface Member {
  target: WaitTarget;
  ref: string;
  state?: string;
  /** State plus what it waits on: a new line whenever either changes. */
  shown?: string;
  outcome: Outcome;
}

/**
 * Wait for an explicit set of Workloads and clusters
 * to reach their targets. The CLI owns success, failure and its own lifetime:
 * one line per change, a heartbeat after 30 minutes without one, and an exit
 * code for the aggregate. Waiting never changes what it waits on.
 */
export async function waitForTargets(
  targets: readonly WaitTarget[],
  deps: WaitDependencies,
  options: WaitOptions,
): Promise<number> {
  const members = [
    ...new Map(targets.map((target) => [waitReference(target), target])),
  ].map(([ref, target]): Member => ({ target, ref, outcome: 'pending' }));
  const startedAt = deps.now();
  let lastOutputAt = startedAt;
  let degraded = false;
  let backoffMs = WAIT_POLL_MS;

  const emit = (event: WaitEvent) => {
    lastOutputAt = deps.now();
    deps.emit({ ...event, observedAt: lastOutputAt });
  };
  const finish = (
    outcome: WaitOutcomeName,
    extra: {
      timeoutMs?: number;
      error?: { ref: string; message: string };
    } = {},
  ): number => {
    const of = (wanted: Outcome) =>
      members.filter((member) => member.outcome === wanted).map((m) => m.ref);
    emit({
      type: 'result',
      outcome,
      succeeded: of('succeeded'),
      failed: of('failed'),
      pending: of('pending'),
      ...extra,
    });
    return WAIT_EXIT[outcome];
  };

  const observe = (member: Member, observation: WaitObservation) => {
    // Keep reading the record first resolved, even if a name is reused or
    // stops resolving once the resource is deleted.
    if (observation.kind !== 'workload' && member.target.kind !== 'workload') {
      member.target = { ...member.target, id: observation.cluster.id };
    }
    const { outcome, ...classified } = classify(observation);
    member.outcome = outcome;
    const shown = `${classified.state}|${classified.message ?? ''}`;
    if (shown === member.shown) return;
    const previousState = member.state ?? null;
    member.shown = shown;
    member.state = classified.state;
    emit({
      type: 'state',
      ref: member.ref,
      kind: member.target.kind,
      previousState,
      ...classified,
      ...(observation.kind === 'workload' && { status: observation.status }),
    });
  };

  for (;;) {
    options.signal?.throwIfAborted();
    const pending = members.filter((member) => member.outcome === 'pending');
    let permanent: { ref: string; error: unknown } | undefined;
    let transient: unknown;
    for (let i = 0; i < pending.length; i += WAIT_READ_CONCURRENCY) {
      const batch = pending.slice(i, i + WAIT_READ_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((member) => deps.read(member.target, options.signal)),
      );
      options.signal?.throwIfAborted();
      results.forEach((result, index) => {
        const member = batch[index];
        if (result.status === 'fulfilled') {
          observe(member, result.value);
        } else if (isPermanent(result.reason)) {
          permanent ??= { ref: member.ref, error: result.reason };
        } else {
          transient ??= result.reason;
        }
      });
    }

    if (permanent) {
      return finish('observer-error', {
        error: {
          ref: permanent.ref,
          message: errorMessage(permanent.error),
        },
      });
    }
    if (transient !== undefined) {
      if (!degraded) {
        degraded = true;
        emit({
          type: 'observer',
          status: 'degraded',
          error: errorMessage(transient),
        });
      }
      backoffMs = Math.min(backoffMs * 2, WAIT_MAX_BACKOFF_MS);
    } else {
      if (degraded) {
        degraded = false;
        emit({ type: 'observer', status: 'recovered' });
      }
      backoffMs = WAIT_POLL_MS;
    }

    if (members.every((member) => member.outcome !== 'pending')) {
      return finish(
        members.some((member) => member.outcome === 'failed')
          ? 'failed'
          : 'succeeded',
      );
    }

    const now = deps.now();
    if (
      options.timeoutMs !== undefined &&
      now - startedAt >= options.timeoutMs
    ) {
      return finish('timeout', { timeoutMs: options.timeoutMs });
    }
    if (now - lastOutputAt >= WAIT_HEARTBEAT_MS) {
      const states: Record<string, number> = {};
      for (const member of members) {
        if (member.outcome !== 'pending' || !member.state) continue;
        states[member.state] = (states[member.state] ?? 0) + 1;
      }
      emit({ type: 'heartbeat', states, elapsedMs: now - startedAt });
    }
    const remaining =
      options.timeoutMs === undefined
        ? backoffMs
        : Math.max(0, Math.min(backoffMs, startedAt + options.timeoutMs - now));
    await deps.sleep(remaining, options.signal);
  }
}
