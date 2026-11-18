import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  API_HEALTH_ALERT_COOLDOWN_MS,
  API_HEALTH_MONITOR_INTERVAL_MS,
  API_HEALTH_SUSTAINED_SAMPLES,
  EVENT_LOOP_STALL_THRESHOLD_MS,
  HEAP_USED_FRACTION_THRESHOLD,
  MONITOR_STALL_FLOOR_MS,
  RECONCILE_BACKLOG_THRESHOLD_MS,
  evaluateApiHealthSample,
  recordApiHealthSample,
  sampleApiHealth,
  startApiHealthWatchdog,
  runApiHealthMonitorOnce,
  stopApiHealthWatchdog,
  type ApiHealthSample,
} from '../../../src/api/services/api-health.js';
import {
  getNotificationsStore,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import { log } from '../../../src/api/services/logger.js';
import { recordSystemEvent } from '../../../src/api/services/telemetry.js';

// Spy on the soak-telemetry event without touching the rest of the module.
vi.mock('../../../src/api/services/telemetry.js', async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import('../../../src/api/services/telemetry.js')
    >();
  return { ...real, recordSystemEvent: vi.fn() };
});

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
const GIB = 1024 ** 3;

function sample(overrides: Partial<ApiHealthSample> = {}): ApiHealthSample {
  return {
    eventLoopStallMs: 40,
    eventLoopUtilization: 0.05,
    heapUsedBytes: 0.4 * GIB,
    heapLimitBytes: 4 * GIB,
    reconcile: { scheduledCount: 3, inFlightCount: 2, oldestDueAgeMs: 0 },
    monitors: [],
    ...overrides,
  };
}

describe('evaluateApiHealthSample', () => {
  it('stays silent on a healthy sample', () => {
    expect(evaluateApiHealthSample(sample(), NOW)).toEqual([]);
  });

  it('reports an event loop blocked for seconds', () => {
    const findings = evaluateApiHealthSample(
      sample({ eventLoopStallMs: 9_100 }),
      NOW,
    );
    expect(findings.map((f) => f.signal)).toEqual(['event-loop']);
    expect(findings[0].detail).toContain('the API froze for 9.1s');
  });

  it('fires on one long stall even while utilization stays low', () => {
    // A single 2s stall in a 60s window is only ~3% utilization, and averages
    // and percentiles over the delay histogram barely move either. The longest
    // stall is the only statistic that responds, which is why it is the signal.
    const findings = evaluateApiHealthSample(
      sample({
        eventLoopStallMs: EVENT_LOOP_STALL_THRESHOLD_MS,
        eventLoopUtilization: 0.03,
      }),
      NOW,
    );
    expect(findings.map((f) => f.signal)).toEqual(['event-loop']);
  });

  it('stays silent on a busy but responsive API', () => {
    // Real work keeps the loop occupied without ever hogging a turn: measured
    // at 77% utilization with a 21ms longest stall. Thresholding utilization
    // would alert here, which is why it is context and not a signal.
    const findings = evaluateApiHealthSample(
      sample({ eventLoopStallMs: 21, eventLoopUtilization: 0.77 }),
      NOW,
    );
    expect(findings).toEqual([]);
  });

  it('marks a stall spanning a whole sample window as already sustained', () => {
    const brief = evaluateApiHealthSample(
      sample({ eventLoopStallMs: API_HEALTH_MONITOR_INTERVAL_MS - 1 }),
      NOW,
    );
    expect(brief[0].sustained).toBe(false);

    const long = evaluateApiHealthSample(
      sample({ eventLoopStallMs: API_HEALTH_MONITOR_INTERVAL_MS }),
      NOW,
    );
    expect(long[0].sustained).toBe(true);
  });

  it('reads a multi-minute freeze in minutes, not thousands of seconds', () => {
    const findings = evaluateApiHealthSample(
      sample({ eventLoopStallMs: 30 * 60_000 }),
      NOW,
    );
    expect(findings[0].detail).toContain('froze for 30m');
    expect(findings[0].detail).not.toContain('1800');
  });

  it('leaves an event loop below the threshold alone', () => {
    const findings = evaluateApiHealthSample(
      sample({ eventLoopStallMs: EVENT_LOOP_STALL_THRESHOLD_MS - 1 }),
      NOW,
    );
    expect(findings).toEqual([]);
  });

  it('reports a heap approaching its limit', () => {
    const findings = evaluateApiHealthSample(
      sample({
        heapUsedBytes: HEAP_USED_FRACTION_THRESHOLD * 4 * GIB,
        heapLimitBytes: 4 * GIB,
      }),
      NOW,
    );
    expect(findings.map((f) => f.signal)).toEqual(['heap']);
    expect(findings[0].detail).toContain(
      'using 90% of its 4.0 GiB memory limit',
    );
  });

  it('ignores an unknown heap limit instead of dividing by zero', () => {
    const findings = evaluateApiHealthSample(
      sample({ heapUsedBytes: 3 * GIB, heapLimitBytes: 0 }),
      NOW,
    );
    expect(findings).toEqual([]);
  });

  it('reports reconciliation falling behind', () => {
    const findings = evaluateApiHealthSample(
      sample({
        reconcile: {
          scheduledCount: 812,
          inFlightCount: 40,
          oldestDueAgeMs: RECONCILE_BACKLOG_THRESHOLD_MS,
        },
      }),
      NOW,
    );
    expect(findings.map((f) => f.signal)).toEqual(['reconcile-backlog']);
    expect(findings[0].detail).toContain('10m behind on tracking workloads');
    expect(findings[0].detail).toContain('machines can still be billing');
  });

  it('holds a fast monitor to the stall floor rather than five intervals', () => {
    const fast = (staleMs: number) =>
      evaluateApiHealthSample(
        sample({
          monitors: [
            {
              name: 'provisioning-scheduler',
              intervalMs: 5_000,
              lastCompletedAt: NOW - staleMs,
            },
          ],
        }),
        NOW,
      );

    expect(fast(MONITOR_STALL_FLOOR_MS - 60_000)).toEqual([]);
    expect(fast(MONITOR_STALL_FLOOR_MS).map((f) => f.signal)).toEqual([
      'monitor-stall',
    ]);
  });

  it('scales the stall window with a slow monitor interval', () => {
    const hourly = (staleMs: number) =>
      evaluateApiHealthSample(
        sample({
          monitors: [
            {
              name: 'catalog-refresh',
              intervalMs: 60 * 60_000,
              lastCompletedAt: NOW - staleMs,
            },
          ],
        }),
        NOW,
      );

    expect(hourly(4 * 60 * 60_000)).toEqual([]);
    expect(hourly(6 * 60 * 60_000).map((f) => f.signal)).toEqual([
      'monitor-stall',
    ]);
  });

  it('names every stalled monitor, worst first', () => {
    const findings = evaluateApiHealthSample(
      sample({
        monitors: [
          {
            name: 'quota-monitor',
            intervalMs: 5 * 60_000,
            lastCompletedAt: NOW - 30 * 60_000,
          },
          {
            name: 'provisioning-scheduler',
            intervalMs: 5_000,
            lastCompletedAt: NOW - 90 * 60_000,
          },
          {
            name: 'cost-calculation',
            intervalMs: 60 * 60_000,
            lastCompletedAt: NOW - 60_000,
          },
        ],
      }),
      NOW,
    );
    expect(findings.map((f) => f.signal)).toEqual(['monitor-stall']);
    // Internal scheduler names are diagnostic, so they belong in the log
    // record. The alert reaches someone running training jobs, who cannot look
    // up what `quota-monitor` is.
    expect(findings[0].logContext).toEqual({
      stalledMonitors: 'provisioning-scheduler, quota-monitor',
    });
    expect(findings[0].detail).not.toContain('provisioning-scheduler');
    expect(findings[0].detail).not.toContain('quota-monitor');
    expect(findings[0].detail).not.toContain('cost-calculation');
    expect(findings[0].detail).toContain(
      'has not run its background checks for 90m',
    );
  });

  it('reports every breaching signal in one pass', () => {
    const findings = evaluateApiHealthSample(
      sample({
        eventLoopStallMs: 6_000,
        heapUsedBytes: 3.9 * GIB,
        reconcile: {
          scheduledCount: 4,
          inFlightCount: 40,
          oldestDueAgeMs: 45 * 60_000,
        },
      }),
      NOW,
    );
    expect(findings.map((f) => f.signal)).toEqual([
      'event-loop',
      'heap',
      'reconcile-backlog',
    ]);
  });
});

describe('sampleApiHealth (real event loop)', () => {
  const idleProbes = {
    monitorTicks: () => [],
    reconcileBacklog: () => ({
      scheduledCount: 0,
      inFlightCount: 0,
      oldestDueAgeMs: 0,
    }),
  };

  afterEach(() => stopApiHealthWatchdog());

  // Every other test in this file feeds the evaluator numbers written by hand,
  // so they agree with whatever the author believed about `monitorEventLoopDelay`
  // and `eventLoopUtilization`. This one blocks the loop for real and reads what
  // Node actually recorded, so it can disagree.
  it('measures a real stall and reports it as degraded', async () => {
    startApiHealthWatchdog();
    // The leading idle is load-bearing, not padding. A percentile can only
    // dilute a stall once there are enough samples to push it past the top 1%:
    // measured, 16 samples put p99 at 2510ms (equal to max) while 107 samples
    // put it at 22ms. Shorten this and the test stops being able to tell a
    // percentile from a maximum.
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    // Must exceed EVENT_LOOP_STALL_THRESHOLD_MS: the point of this test is that
    // a real stall reaches the evaluator as degraded, so it has to clear the
    // real bar rather than a convenient one.
    const blockUntil = Date.now() + EVENT_LOOP_STALL_THRESHOLD_MS + 500;
    while (Date.now() < blockUntil) {
      /* hold the loop */
    }
    // The histogram only records the stall once the loop runs again.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const observed = sampleApiHealth(idleProbes);

    expect(observed.eventLoopStallMs).toBeGreaterThanOrEqual(
      EVENT_LOOP_STALL_THRESHOLD_MS,
    );
    expect(observed.eventLoopUtilization).toBeGreaterThan(0.5);
    expect(
      evaluateApiHealthSample(observed, Date.now()).map((f) => f.signal),
    ).toContain('event-loop');
  });

  it('reads a quiet loop as healthy', async () => {
    startApiHealthWatchdog();
    await new Promise((resolve) => setTimeout(resolve, 250));

    const observed = sampleApiHealth(idleProbes);

    expect(observed.eventLoopStallMs).toBeLessThan(
      EVENT_LOOP_STALL_THRESHOLD_MS,
    );
    expect(
      evaluateApiHealthSample(observed, Date.now()).map((f) => f.signal),
    ).not.toContain('event-loop');
  });
});

describe('recordApiHealthSample', () => {
  afterEach(() => stopApiHealthWatchdog());

  const stall = (ms: number) =>
    evaluateApiHealthSample(sample({ eventLoopStallMs: ms }), NOW);

  it('alerts on one unbroken freeze without waiting for corroboration', () => {
    // The histogram is reset every sample, so a single continuous freeze
    // breaches exactly once — on the tick that runs when it ends. Requiring
    // consecutive breaches would silence the worst case while alerting on
    // milder recurring stalls.
    const { degraded } = recordApiHealthSample(stall(30 * 60_000), NOW);

    expect(degraded.map((f) => f.signal)).toEqual(['event-loop']);
  });

  it('still requires corroboration for a stall short enough to be a blip', () => {
    const brief = API_HEALTH_MONITOR_INTERVAL_MS - 1;

    expect(recordApiHealthSample(stall(brief), NOW).degraded).toEqual([]);
    // A clean sample in between resets the streak, exactly as it should for a
    // pause that did not recur.
    expect(recordApiHealthSample([], NOW).degraded).toEqual([]);
    expect(recordApiHealthSample(stall(brief), NOW).degraded).toEqual([]);
  });

  it('alerts on a short stall once it repeats across consecutive samples', () => {
    const brief = API_HEALTH_MONITOR_INTERVAL_MS - 1;

    expect(recordApiHealthSample(stall(brief), NOW).degraded).toEqual([]);
    expect(recordApiHealthSample(stall(brief), NOW).degraded).toEqual([]);
    expect(
      recordApiHealthSample(stall(brief), NOW).degraded.map((f) => f.signal),
    ).toEqual(['event-loop']);
  });
});

// End-to-end over the real notifications store and the Slack notifier, with
// `fetch` captured. Reconciliation backlog is the driven signal because it
// comes from an injected probe; the process-level signals are covered above.
// Ticks opt into delivery because the shipped default keeps it gated off
// during threshold calibration; the default itself is pinned by the last test.
describe('runApiHealthMonitorOnce', () => {
  const fetchMock = vi.fn();

  const tick = (oldestDueAgeMs: number) =>
    runApiHealthMonitorOnce(
      {
        monitorTicks: () => [],
        reconcileBacklog: () => ({
          scheduledCount: 812,
          inFlightCount: 40,
          oldestDueAgeMs,
        }),
      },
      { deliverAlerts: true },
    );

  const degradedTick = () => tick(RECONCILE_BACKLOG_THRESHOLD_MS);
  const healthyTick = () => tick(0);

  async function sustainDegradation(): Promise<void> {
    for (let i = 0; i < API_HEALTH_SUSTAINED_SAMPLES; i += 1) {
      await degradedTick();
    }
  }

  function postedMessages(): string[] {
    return fetchMock.mock.calls.map(
      (call) =>
        (JSON.parse((call[1] as { body: string }).body) as { text: string })
          .text,
    );
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    fetchMock.mockReset();
    vi.mocked(recordSystemEvent).mockClear();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);
    resetPersistence();
    stopApiHealthWatchdog();
    await getNotificationsStore().saveChannel('slack', {
      webhook: 'https://hooks.slack.com/services/T/B/x',
    });
  });

  afterEach(() => {
    stopApiHealthWatchdog();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('records every sample, not only the breaching ones', async () => {
    // Thresholds can only be checked against reality if the healthy readings
    // are written down too. A watchdog that speaks only when unhappy leaves no
    // baseline to compare against.
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});

    await healthyTick();

    const samples = info.mock.calls.filter(
      ([message]) => message === 'API health sample',
    );
    expect(samples).toHaveLength(1);
    expect(samples[0][1]).toMatchObject({
      eventLoopStallMs: expect.any(Number),
      eventLoopUtilizationPct: expect.any(Number),
      heapUsedPct: expect.any(Number),
      reconcileBacklogMs: 0,
      reconcileScheduledCount: 812,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('alerts only once the breach is sustained', async () => {
    for (let i = 0; i < API_HEALTH_SUSTAINED_SAMPLES - 1; i += 1) {
      await degradedTick();
      expect(fetchMock).not.toHaveBeenCalled();
    }

    await degradedTick();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(postedMessages()[0]).toContain('*anycloud: API degraded*');
    expect(postedMessages()[0]).toContain('behind on tracking workloads');
  });

  it('forgets a breach that does not persist', async () => {
    await degradedTick();
    await degradedTick();
    await healthyTick();
    await degradedTick();
    await degradedTick();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not repeat inside the cooldown', async () => {
    await sustainDegradation();
    expect(fetchMock).toHaveBeenCalledOnce();

    vi.setSystemTime(NOW + API_HEALTH_ALERT_COOLDOWN_MS - 60_000);
    await degradedTick();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('alerts again once the cooldown expires', async () => {
    await sustainDegradation();

    vi.setSystemTime(NOW + API_HEALTH_ALERT_COOLDOWN_MS);
    await degradedTick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(postedMessages()[1]).toContain('*anycloud: API degraded*');
  });

  it('posts one recovery notice and re-arms the signal', async () => {
    await sustainDegradation();

    for (let i = 0; i < API_HEALTH_SUSTAINED_SAMPLES - 1; i += 1) {
      await healthyTick();
      expect(fetchMock).toHaveBeenCalledOnce();
    }
    await healthyTick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(postedMessages()[1]).toContain('*anycloud: API recovered*');
    expect(postedMessages()[1]).toContain('caught up on tracking workloads');

    // Recovery clears the cooldown, so the next sustained breach alerts even
    // though less than a cooldown has passed.
    await sustainDegradation();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(postedMessages()[2]).toContain('*anycloud: API degraded*');
  });

  it('stays quiet while healthy', async () => {
    for (let i = 0; i < API_HEALTH_SUSTAINED_SAMPLES + 2; i += 1) {
      await healthyTick();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries on the next tick after a failed delivery', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'nope',
    });
    await sustainDegradation();
    expect(fetchMock).toHaveBeenCalledOnce();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    });
    await degradedTick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(postedMessages()[1]).toContain('*anycloud: API degraded*');
  });

  it('logs and arms the cooldown when no channel is configured', async () => {
    await getNotificationsStore().deleteChannel('slack');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    await sustainDegradation();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toBe('API degraded');
    expect(warn.mock.calls[0][1]).toMatchObject({
      signal: 'reconcile-backlog',
      reconcileBacklogMs: RECONCILE_BACKLOG_THRESHOLD_MS,
    });

    // The cooldown was armed without a delivery, so re-enabling a channel does
    // not replay the alert the operator already has in the log.
    await getNotificationsStore().saveChannel('slack', {
      webhook: 'https://hooks.slack.com/services/T/B/x',
    });
    await degradedTick();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ships with delivery gated off: logs and arms the cooldown by default', async () => {
    const defaultTick = () =>
      runApiHealthMonitorOnce({
        monitorTicks: () => [],
        reconcileBacklog: () => ({
          scheduledCount: 812,
          inFlightCount: 40,
          oldestDueAgeMs: RECONCILE_BACKLOG_THRESHOLD_MS,
        }),
      });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const loadConfig = vi.spyOn(getNotificationsStore(), 'loadConfig');

    for (let i = 0; i < API_HEALTH_SUSTAINED_SAMPLES; i += 1) {
      await defaultTick();
    }
    // Slack is configured, yet nothing is loaded, decrypted, or sent — until
    // the calibration gate flips, the record exists only in the log.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loadConfig).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toBe('API degraded');

    // The cooldown was armed exactly as in the no-channel case, so the log
    // keeps delivery's cadence instead of repeating every minute.
    await defaultTick();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('records soak telemetry for transitions even while delivery is gated off', async () => {
    const defaultTick = (oldestDueAgeMs: number) =>
      runApiHealthMonitorOnce({
        monitorTicks: () => [],
        reconcileBacklog: () => ({
          scheduledCount: 812,
          inFlightCount: 40,
          oldestDueAgeMs,
        }),
      });
    vi.spyOn(log, 'warn').mockImplementation(() => {});

    for (let i = 0; i < API_HEALTH_SUSTAINED_SAMPLES; i += 1) {
      await defaultTick(RECONCILE_BACKLOG_THRESHOLD_MS);
    }
    expect(vi.mocked(recordSystemEvent)).toHaveBeenCalledOnce();
    expect(vi.mocked(recordSystemEvent)).toHaveBeenCalledWith(
      'api_degraded',
      expect.objectContaining({
        signal: 'reconcile-backlog',
        reconcileBacklogMs: RECONCILE_BACKLOG_THRESHOLD_MS,
      }),
    );

    // Telemetry keeps the alert cadence: quiet inside the cooldown, one event
    // when the signal recovers.
    await defaultTick(RECONCILE_BACKLOG_THRESHOLD_MS);
    expect(vi.mocked(recordSystemEvent)).toHaveBeenCalledOnce();

    for (let i = 0; i < API_HEALTH_SUSTAINED_SAMPLES; i += 1) {
      await defaultTick(0);
    }
    expect(vi.mocked(recordSystemEvent)).toHaveBeenLastCalledWith(
      'api_recovered',
      { signal: 'reconcile-backlog' },
    );
  });
});
