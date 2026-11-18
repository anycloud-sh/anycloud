/**
 * Degradation watchdog for the API process.
 *
 * The control plane's worst failures are not crashes. The process stays up and
 * `/health` keeps answering while the event loop is starved, the heap is about
 * to hit its limit, or background reconciliation has stopped keeping up — so
 * finished work is never torn down and cloud machines keep billing. Those
 * states are invisible from outside the process and can persist for days.
 *
 * Every signal here is deliberately conservative. Each threshold is a value a
 * healthy API never reaches, even under heavy fleet load; each breach must
 * persist across several consecutive checks before it alerts; and each signal
 * alerts at most once per cooldown while it stays bad. Silence under load is
 * the requirement — an alert that cries wolf gets muted, and then the real one
 * is missed too.
 *
 * Watchdog state is process-local on purpose. The degraded path must not add
 * synchronous database writes, since blocking the event loop is one of the very
 * things being measured, and a restart should re-arm the alert: an API that
 * crash-loops back into a degraded state deserves to say so again.
 */

import {
  monitorEventLoopDelay,
  performance,
  type EventLoopUtilization,
  type IntervalHistogram,
} from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { log } from './logger.js';
import { getNotificationsStore } from './persistence.js';
import { recordSystemEvent } from './telemetry.js';
import { loadNotifiers } from '../../shared/notifications/index.js';
import { sendToNotifiers } from './notify.js';
import type { WorkloadReconcileBacklog } from './workload-reconciler.js';

// ============================================================================
// Thresholds
// ============================================================================

/** How often the watchdog samples. Every probe is in-process and allocation-free. */
export const API_HEALTH_MONITOR_INTERVAL_MS = 60_000;

/**
 * Consecutive samples a signal must breach before it alerts, and consecutive
 * healthy samples before it clears. Three samples at the interval above means
 * an alert describes minutes of sustained trouble rather than one GC pause,
 * one slow provider call, or one oversized query.
 */
export const API_HEALTH_SUSTAINED_SAMPLES = 3;

/** At most one alert per signal per cooldown while it stays degraded. */
export const API_HEALTH_ALERT_COOLDOWN_MS = 60 * 60_000;

/** Timer granularity for the event-loop delay histogram. */
const EVENT_LOOP_SAMPLE_RESOLUTION_MS = 20;

/**
 * Longest single event-loop stall tolerated in one sample window. A healthy
 * control plane never blocks for seconds at a time; at this length ordinary CLI
 * requests are already at risk of timing out while the process still runs and
 * answers health checks.
 *
 * Thresholded on the maximum rather than a percentile, and that is not an
 * oversight. The delay histogram records one sample per stall no matter how
 * long the stall lasts, so a loop blocked for half of every minute still
 * reports a p99 at the timer resolution — measured at 21.5ms for fifteen
 * 2s stalls in 60s. The maximum is the only statistic that moves. Ruling out a
 * one-off pause is the sustained-breach rule's job, not the percentile's.
 *
 * The value is measured, not chosen. A passing nuke run at 3700 seeded
 * workloads stalls 153-1323ms in steady state and 5339ms in the minute after
 * boot, when the reconciler discovers its backlog. An earlier 2000ms sat
 * between those two, which is the worst available place: high enough to miss
 * nothing useful, low enough to fire on healthy load slightly heavier than that
 * run. This leaves roughly 3x headroom over the observed steady-state maximum
 * while staying under the 6s client timeout in `shared/api-contract/base.ts`,
 * so a breach still means requests are genuinely at risk.
 *
 * A later Azure run at the same seed measures 49ms min, 761ms median, 7638ms
 * p90 and 11492ms max. Provider latency dominates: the same code on `local`
 * peaks at 1323ms. Deliberately not raised to clear those — a 7.6s freeze
 * exceeds the 6s client timeout by definition, so alerting on it is correct and
 * the API stalling that long is the defect. Muting it would restore exactly the
 * blind spot this module exists to close.
 */
export const EVENT_LOOP_STALL_THRESHOLD_MS = 4_000;

/**
 * A stall at least this long alerts on a single sample, skipping the
 * sustained-breach rule.
 *
 * That rule assumes a breaching signal is still breaching next tick, which
 * holds for the level-shaped signals — heap fraction, backlog age and tick
 * staleness are all recomputed from durable state every sample. The stall is
 * the one event-shaped signal: the histogram is reset each tick, so a single
 * continuous freeze breaches exactly once, on the tick that runs when it ends,
 * and the streak resets to zero before it can ever reach the threshold. Without
 * this bypass the worst case — one unbroken freeze — is the case that stays
 * silent, while milder recurring stalls alert.
 *
 * A stall spanning a whole sample window has already demonstrated it is not a
 * one-off pause, which is the only thing corroboration was there to prove.
 */
const EVENT_LOOP_SELF_EVIDENT_STALL_MS = API_HEALTH_MONITOR_INTERVAL_MS;

/**
 * V8 spends progressively more time collecting as the heap approaches its
 * limit, and the process aborts outright when it gets there. Alert while there
 * is still headroom to raise the limit or shed load.
 *
 * Not yet anchored. Nuke at 3700 seeded workloads peaks at 30% of a 4GB limit
 * on Azure and 6% on `local`, so nothing observed comes close enough to say
 * whether 0.9 is right — only that it is not obviously too low. The June 2026
 * outage did reach the limit, so the failure is real even though no test run
 * has reproduced it.
 */
export const HEAP_USED_FRACTION_THRESHOLD = 0.9;

/**
 * Reconciliation work is normally picked up within seconds of falling due. Being
 * this far behind — twenty times the poll interval — means finished workloads
 * are not being finalized or torn down while their machines keep billing.
 *
 * Not yet anchored. Nuke at 3700 seeded workloads peaks at 7282ms on Azure and
 * 73ms on `local`, against 600000ms here — and in-flight work peaked at 20 of a
 * 40 slot bound, so the reconciler was never close to saturated. Either the
 * threshold has four orders of magnitude of slack or nuke does not generate the
 * shape that produces backlog. The June 2026 outage left 51 finished VMs
 * billing, so the failure is real; this run does not reproduce it.
 */
export const RECONCILE_BACKLOG_THRESHOLD_MS = 10 * 60_000;

/**
 * A monitor that has not finished a tick within this window is hung, typically
 * inside a provider call, rather than merely slow. The floor keeps the
 * fast-interval monitors from alerting on a single long tick.
 */
const MONITOR_STALL_INTERVAL_MULTIPLIER = 5;
export const MONITOR_STALL_FLOOR_MS = 10 * 60_000;

function monitorStallThresholdMs(intervalMs: number): number {
  return Math.max(
    MONITOR_STALL_FLOOR_MS,
    intervalMs * MONITOR_STALL_INTERVAL_MULTIPLIER,
  );
}

// ============================================================================
// Sampling
// ============================================================================

type ApiHealthSignal =
  | 'event-loop'
  | 'heap'
  | 'reconcile-backlog'
  | 'monitor-stall';

/** Liveness of one scheduled monitor, as seen by the watchdog. */
export interface MonitorTickStatus {
  name: string;
  intervalMs: number;
  /** Epoch ms of the last finished tick, or of `start()` before the first one. */
  lastCompletedAt: number;
}

/**
 * Probes the watchdog cannot read for itself. Supplied by the monitor lifecycle
 * that owns the reconciler and the scheduled monitors, which keeps this module
 * off that dependency cycle.
 */
export interface ApiHealthProbes {
  monitorTicks: () => MonitorTickStatus[];
  reconcileBacklog: () => WorkloadReconcileBacklog;
}

export interface ApiHealthSample {
  /** Longest single stall in the window — the signal. */
  eventLoopStallMs: number;
  /**
   * Fraction of the window the loop had work, 0 to 1. Diagnostic context, not a
   * signal: a healthy API doing real work reads high here — measured at 77% for
   * 8ms of work per 2ms yield — while its longest stall stays near the timer
   * resolution. Only the stall separates busy from stuck, but knowing which one
   * you are looking at is the first question when diagnosing the alert.
   */
  eventLoopUtilization: number;
  heapUsedBytes: number;
  heapLimitBytes: number;
  reconcile: WorkloadReconcileBacklog;
  monitors: MonitorTickStatus[];
}

let eventLoopHistogram: IntervalHistogram | null = null;
let lastEventLoopUtilization: EventLoopUtilization | null = null;

/**
 * Begin recording event-loop delay and drop any state from a previous run.
 *
 * Node's sampling timer for this histogram does not hold the event loop open,
 * so an enabled histogram cannot keep the process alive on its own.
 */
export function startApiHealthWatchdog(): void {
  signalStates.clear();
  if (!eventLoopHistogram) {
    eventLoopHistogram = monitorEventLoopDelay({
      resolution: EVENT_LOOP_SAMPLE_RESOLUTION_MS,
    });
  }
  eventLoopHistogram.reset();
  eventLoopHistogram.enable();
  lastEventLoopUtilization = performance.eventLoopUtilization();
}

export function stopApiHealthWatchdog(): void {
  signalStates.clear();
  eventLoopHistogram?.disable();
  lastEventLoopUtilization = null;
}

/**
 * Read every probe and reset the delay histogram, so each sample describes only
 * the window since the previous one. Before the watchdog starts, event-loop
 * delay reads as zero and simply never breaches.
 */
export function sampleApiHealth(probes: ApiHealthProbes): ApiHealthSample {
  const heap = getHeapStatistics();
  const sample: ApiHealthSample = {
    eventLoopStallMs: eventLoopHistogram
      ? nanosToMs(eventLoopHistogram.max)
      : 0,
    eventLoopUtilization: readEventLoopUtilization(),
    heapUsedBytes: heap.used_heap_size,
    heapLimitBytes: heap.heap_size_limit,
    reconcile: probes.reconcileBacklog(),
    monitors: probes.monitorTicks(),
  };
  eventLoopHistogram?.reset();
  return sample;
}

/**
 * Utilization since the previous sample. libuv maintains the counters
 * continuously, so a reading taken after a long freeze still describes the
 * whole freeze — unlike the histogram, which only records once the loop runs
 * again.
 */
function readEventLoopUtilization(): number {
  const current = performance.eventLoopUtilization();
  const delta = lastEventLoopUtilization
    ? performance.eventLoopUtilization(current, lastEventLoopUtilization)
    : current;
  lastEventLoopUtilization = current;
  return delta.utilization;
}

/** The histogram reports nanoseconds; every threshold here is milliseconds. */
function nanosToMs(nanos: number): number {
  return Number.isFinite(nanos) ? nanos / 1e6 : 0;
}

// ============================================================================
// Evaluation
// ============================================================================

export interface ApiHealthFinding {
  signal: ApiHealthSignal;
  /**
   * One line for the operator, in their terms. The reader runs training jobs;
   * they have no reason to know the control plane is a Node process, so this
   * says what stopped working and what it costs them, never which runtime
   * primitive is unhappy. Internal identifiers belong in `logContext`.
   */
  detail: string;
  /** Diagnostic fields merged into the log record and never into the alert. */
  logContext?: Record<string, unknown>;
  /**
   * Set when this single sample already proves sustained trouble, so the
   * consecutive-breach requirement is skipped. The cooldown still applies.
   */
  sustained?: boolean;
}

/** Which signals a single sample breaches, independent of history. */
export function evaluateApiHealthSample(
  sample: ApiHealthSample,
  now: number,
): ApiHealthFinding[] {
  const findings: ApiHealthFinding[] = [];

  if (sample.eventLoopStallMs >= EVENT_LOOP_STALL_THRESHOLD_MS) {
    findings.push({
      signal: 'event-loop',
      detail:
        `the API froze for ${formatStall(sample.eventLoopStallMs)} — commands time out, ` +
        `and running work goes unwatched while it is stuck`,
      sustained: sample.eventLoopStallMs >= EVENT_LOOP_SELF_EVIDENT_STALL_MS,
    });
  }

  const heapFraction =
    sample.heapLimitBytes > 0
      ? sample.heapUsedBytes / sample.heapLimitBytes
      : 0;
  if (heapFraction >= HEAP_USED_FRACTION_THRESHOLD) {
    findings.push({
      signal: 'heap',
      detail:
        `the API is using ${formatPercent(heapFraction)} of its ${formatGiB(sample.heapLimitBytes)} ` +
        `memory limit — it is killed and restarted if it runs out`,
    });
  }

  if (sample.reconcile.oldestDueAgeMs >= RECONCILE_BACKLOG_THRESHOLD_MS) {
    findings.push({
      signal: 'reconcile-backlog',
      detail:
        `the API is ${formatMinutes(sample.reconcile.oldestDueAgeMs)} behind on tracking ` +
        `workloads — finished work may not be shut down, so machines can still be billing`,
    });
  }

  const stalled = sample.monitors
    .map((monitor) => ({ monitor, staleMs: now - monitor.lastCompletedAt }))
    .filter(
      ({ monitor, staleMs }) =>
        staleMs >= monitorStallThresholdMs(monitor.intervalMs),
    )
    .sort((a, b) => b.staleMs - a.staleMs);
  if (stalled.length > 0) {
    findings.push({
      signal: 'monitor-stall',
      detail:
        `the API has not run its background checks for ${formatMinutes(stalled[0].staleMs)} — ` +
        `new workloads may not start, and finished ones may not be cleaned up`,
      // Which schedulers are stuck narrows the cause immediately, but the names
      // are ours: they appear nowhere a user can look them up.
      logContext: {
        stalledMonitors: stalled.map(({ monitor }) => monitor.name).join(', '),
      },
    });
  }

  return findings;
}

// ============================================================================
// Sustained-breach state
// ============================================================================

interface SignalState {
  breachStreak: number;
  healthyStreak: number;
  /** Epoch ms of the last delivered alert; null while the signal is quiet. */
  alertedAt: number | null;
}

interface ApiHealthTransitions {
  degraded: ApiHealthFinding[];
  recovered: ApiHealthSignal[];
}

const signalStates = new Map<ApiHealthSignal, SignalState>();

function stateFor(signal: ApiHealthSignal): SignalState {
  const existing = signalStates.get(signal);
  if (existing) return existing;
  const created: SignalState = {
    breachStreak: 0,
    healthyStreak: 0,
    alertedAt: null,
  };
  signalStates.set(signal, created);
  return created;
}

/**
 * Fold this sample's findings into the streaks and report what crossed a
 * threshold. Streaks advance here; the cooldown timestamp is only committed
 * once the alert has actually been handled, so a failed Slack post is retried
 * on the next tick instead of going quiet for an hour.
 */
export function recordApiHealthSample(
  findings: ApiHealthFinding[],
  now: number,
): ApiHealthTransitions {
  const breaching = new Map(
    findings.map((finding) => [finding.signal, finding] as const),
  );

  for (const [signal, state] of signalStates) {
    if (breaching.has(signal)) continue;
    state.breachStreak = 0;
    state.healthyStreak += 1;
  }

  const degraded: ApiHealthFinding[] = [];
  for (const [signal, finding] of breaching) {
    const state = stateFor(signal);
    state.breachStreak += 1;
    state.healthyStreak = 0;
    if (
      !finding.sustained &&
      state.breachStreak < API_HEALTH_SUSTAINED_SAMPLES
    ) {
      continue;
    }
    if (
      state.alertedAt !== null &&
      now - state.alertedAt < API_HEALTH_ALERT_COOLDOWN_MS
    ) {
      continue;
    }
    degraded.push(finding);
  }

  const recovered: ApiHealthSignal[] = [];
  for (const [signal, state] of signalStates) {
    if (
      state.alertedAt !== null &&
      state.healthyStreak >= API_HEALTH_SUSTAINED_SAMPLES
    ) {
      recovered.push(signal);
    }
  }

  return { degraded, recovered };
}

/** Arm the cooldown and clear recovered signals, once delivery is settled. */
function commitApiHealthTransitions(
  transitions: ApiHealthTransitions,
  now: number,
): void {
  for (const finding of transitions.degraded) {
    stateFor(finding.signal).alertedAt = now;
  }
  for (const signal of transitions.recovered) {
    signalStates.delete(signal);
  }
}

// ============================================================================
// Message
// ============================================================================

const RECOVERY_DETAIL: Record<ApiHealthSignal, string> = {
  'event-loop': 'the API is responding normally again',
  heap: 'memory use is back to a safe level',
  'reconcile-backlog': 'the API has caught up on tracking workloads',
  'monitor-stall': 'background checks are running again',
};

function formatApiHealthMessage(
  degraded: ApiHealthFinding[],
  recovered: ApiHealthSignal[],
): string {
  const sections: string[] = [];
  if (degraded.length > 0) {
    sections.push(
      [
        '*anycloud: API degraded*',
        ...degraded.map((f) => `• ${f.detail}`),
      ].join('\n'),
    );
  }
  if (recovered.length > 0) {
    sections.push(
      [
        '*anycloud: API recovered*',
        ...recovered.map((signal) => `• ${RECOVERY_DETAIL[signal]}`),
      ].join('\n'),
    );
  }
  return sections.join('\n\n');
}

// ============================================================================
// Monitor tick
// ============================================================================

/**
 * Slack delivery ships hard-off while the thresholds above soak against real
 * fleets — several are marked "not yet anchored", and an alert that misfires
 * during calibration gets the channel muted before the thresholds are proven.
 * The gate sits on delivery only: every sample and every degraded/recovered
 * transition still reaches the log at exactly the cadence delivery would have,
 * because the gated path reuses the no-notifier commit below. Flipped, or
 * replaced by a per-API setting, in a later release once the logged record
 * shows the thresholds hold.
 */
const API_HEALTH_ALERT_DELIVERY = false;

/**
 * Sample, evaluate, and report. Degradation is always logged, whether or not a
 * notification channel is configured, so the container log carries the same
 * record an operator would otherwise only see in Slack — and, while delivery
 * ships gated off, the only place it appears at all.
 */
export async function runApiHealthMonitorOnce(
  probes: ApiHealthProbes,
  {
    deliverAlerts = API_HEALTH_ALERT_DELIVERY,
  }: { deliverAlerts?: boolean } = {},
): Promise<void> {
  const now = Date.now();
  const sample = sampleApiHealth(probes);

  // Every sample, not only the breaching ones. A watchdog that speaks only when
  // it is unhappy leaves no way to know what "happy" looks like — which is how
  // thresholds end up asserted rather than measured. This is also the trace an
  // operator wants during an incident, so it is info rather than debug: a
  // reading you only have if someone set a flag in advance is not a reading you
  // have when it matters. One line a minute, against monitors that already log
  // several times that.
  const worstMonitorStaleMs = sample.monitors.reduce(
    (worst, monitor) => Math.max(worst, now - monitor.lastCompletedAt),
    0,
  );
  log.info('API health sample', {
    id: 'system',
    eventLoopStallMs: Math.round(sample.eventLoopStallMs),
    eventLoopUtilizationPct: Math.round(sample.eventLoopUtilization * 100),
    heapUsedBytes: sample.heapUsedBytes,
    heapLimitBytes: sample.heapLimitBytes,
    heapUsedPct:
      sample.heapLimitBytes > 0
        ? Math.round((sample.heapUsedBytes / sample.heapLimitBytes) * 100)
        : 0,
    reconcileBacklogMs: sample.reconcile.oldestDueAgeMs,
    reconcileScheduledCount: sample.reconcile.scheduledCount,
    reconcileInFlightCount: sample.reconcile.inFlightCount,
    worstMonitorStaleMs,
    monitorCount: sample.monitors.length,
  });

  const transitions = recordApiHealthSample(
    evaluateApiHealthSample(sample, now),
    now,
  );
  const { degraded, recovered } = transitions;
  if (degraded.length === 0 && recovered.length === 0) return;

  // Telemetry rides regardless of the delivery gate: the fleet-wide record of
  // would-be alerts is what calibrates the thresholds while Slack stays off.
  const sampleContext = {
    eventLoopStallMs: Math.round(sample.eventLoopStallMs),
    eventLoopUtilizationPct: Math.round(sample.eventLoopUtilization * 100),
    heapUsedBytes: sample.heapUsedBytes,
    heapLimitBytes: sample.heapLimitBytes,
    reconcileBacklogMs: sample.reconcile.oldestDueAgeMs,
    reconcileScheduledCount: sample.reconcile.scheduledCount,
    reconcileInFlightCount: sample.reconcile.inFlightCount,
  };
  for (const finding of degraded) {
    log.warn('API degraded', {
      id: 'system',
      signal: finding.signal,
      detail: finding.detail,
      ...sampleContext,
      ...finding.logContext,
    });
    recordSystemEvent('api_degraded', {
      signal: finding.signal,
      ...sampleContext,
    });
  }
  for (const signal of recovered) {
    log.info('API recovered', { id: 'system', signal });
    recordSystemEvent('api_recovered', { signal });
  }

  const notifiers = deliverAlerts
    ? loadNotifiers(await getNotificationsStore().loadConfig())
    : [];
  // With delivery gated off or no channel configured there is nothing to
  // retry, so the cooldown starts now and the log above is not repeated every
  // minute.
  if (notifiers.length === 0) {
    commitApiHealthTransitions(transitions, now);
    return;
  }
  const sent = await sendToNotifiers(
    notifiers,
    formatApiHealthMessage(degraded, recovered),
  );
  if (sent) commitApiHealthTransitions(transitions, now);
}

// ============================================================================
// Formatting helpers
// ============================================================================

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** A freeze can run for minutes; "1800.0s" is not a readable duration. */
function formatStall(ms: number): string {
  return ms >= 60_000 ? formatMinutes(ms) : formatSeconds(ms);
}

function formatMinutes(ms: number): string {
  const minutes = ms / 60_000;
  return minutes >= 10 ? `${Math.round(minutes)}m` : `${minutes.toFixed(1)}m`;
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
