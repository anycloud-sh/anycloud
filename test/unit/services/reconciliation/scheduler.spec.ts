import { describe, expect, it } from 'vitest';
import { Scheduler } from '../../../../src/api/services/reconciliation/scheduler.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface Work {
  key: string;
  lane: 'urgent' | 'bulk' | 'empty' | 'work';
  dueAt: number;
  value: string;
}

const scheduling = {
  key: (entry: Work) => entry.key,
  lane: (entry: Work) => entry.lane,
  shouldRefill: () => false,
};

function work(key: string, dueAt = 0, value = key): Work {
  return { key, lane: 'work' as const, dueAt, value };
}

describe('reconciliation scheduler', () => {
  it('preserves weighted turns across pumps and spills empty-lane turns', async () => {
    const started: string[] = [];
    const scheduler = new Scheduler({
      ...scheduling,
      laneCycle: ['urgent', 'bulk', 'bulk', 'empty'],
      maxInFlight: 2,
      now: () => 0,
      run: async (entry) => {
        started.push(entry.key);
        scheduler.removeIfCurrent(entry);
      },
    });
    for (const [lane, count] of [
      ['bulk', 6],
      ['urgent', 3],
    ] as const) {
      for (let index = 1; index <= count; index += 1) {
        const key = `${lane}-${index}`;
        scheduler.replace({ key, lane, dueAt: 0, value: key });
      }
    }

    for (const expected of [
      ['urgent-1', 'bulk-1'],
      ['bulk-2', 'urgent-2'],
      ['bulk-3', 'bulk-4'],
      ['urgent-3', 'bulk-5'],
      ['bulk-6'],
    ]) {
      const previousCount = started.length;
      expect(scheduler.pump().map((entry) => entry.key)).toEqual(expected);
      expect(started.slice(previousCount)).toEqual(expected);
      expect(scheduler.inFlightCount).toBe(expected.length);
      await scheduler.waitForInFlight();
    }
    expect(scheduler.pump()).toEqual([]);
  });

  it('moves replacements to the tail without sorting eligible work by deadline', async () => {
    let now = 100;
    const started: string[] = [];
    const scheduler = new Scheduler({
      ...scheduling,
      laneCycle: ['work'],
      maxInFlight: 4,
      now: () => now,
      run: async (entry) => {
        started.push(entry.value);
        scheduler.removeIfCurrent(entry);
      },
    });
    scheduler.replace(work('replaced', 0));
    scheduler.replace(work('future', 150));
    scheduler.replace(work('second', 90));
    scheduler.replace(work('third', 1));
    scheduler.replace(work('replaced', 100, 'replacement'));

    expect(scheduler.pump().map((entry) => entry.key)).toEqual([
      'second',
      'third',
      'replaced',
    ]);
    expect(started).toEqual(['second', 'third', 'replacement']);
    await scheduler.waitForInFlight();
    expect(scheduler.pump()).toEqual([]);

    now = 150;
    expect(scheduler.pump().map((entry) => entry.key)).toEqual(['future']);
    await scheduler.waitForInFlight();
  });

  it('retains per-key exclusion after removal and replacement while allowing another key', async () => {
    const active = deferred();
    const started: string[] = [];
    const scheduler = new Scheduler({
      ...scheduling,
      laneCycle: ['work'],
      maxInFlight: 2,
      now: () => 0,
      run: async (entry) => {
        started.push(entry.value);
        if (entry.value === 'first') await active.promise;
        scheduler.removeIfCurrent(entry);
      },
    });
    scheduler.replace(work('same-key', 0, 'first'));
    expect(scheduler.pump()).toHaveLength(1);
    scheduler.remove('same-key');
    const replacement = scheduler.replace(work('same-key', 0, 'replacement'));

    expect(scheduler.hasInFlight('same-key')).toBe(true);
    expect(scheduler.pump()).toEqual([]);
    scheduler.replace(work('other-key'));
    expect(scheduler.pump().map((entry) => entry.key)).toEqual(['other-key']);
    expect(started).toEqual(['first', 'other-key']);

    active.resolve();
    await scheduler.waitForInFlight();
    expect(scheduler.get('same-key')).toBe(replacement);
    expect(scheduler.pump().map((entry) => entry.key)).toEqual(['same-key']);
    expect(started).toEqual(['first', 'other-key', 'replacement']);
    await scheduler.waitForInFlight();
  });

  it('refills released capacity only while completion refill is enabled', async () => {
    let running = true;
    const operations = new Map([
      ['first', deferred()],
      ['second', deferred()],
      ['third', deferred()],
    ]);
    const started: string[] = [];
    const scheduler = new Scheduler({
      ...scheduling,
      laneCycle: ['work'],
      maxInFlight: 1,
      now: () => 0,
      shouldRefill: () => running,
      run: async (entry) => {
        started.push(entry.key);
        await operations.get(entry.key)!.promise;
        scheduler.removeIfCurrent(entry);
      },
    });
    for (const key of operations.keys()) scheduler.replace(work(key));
    scheduler.pump();
    expect(started).toEqual(['first']);

    const firstWait = scheduler.waitForInFlight();
    operations.get('first')!.resolve();
    await firstWait;
    expect(started).toEqual(['first', 'second']);
    expect(scheduler.inFlightCount).toBe(1);

    running = false;
    operations.get('second')!.resolve();
    await scheduler.waitForInFlight();
    expect(started).toEqual(['first', 'second']);
    expect(scheduler.inFlightCount).toBe(0);
    expect(scheduler.pump().map((entry) => entry.key)).toEqual(['third']);
    operations.get('third')!.resolve();
    await scheduler.waitForInFlight();
  });

  it('rejects conditional mutations from superseded handles even for identical schedules', () => {
    const scheduler = new Scheduler({
      ...scheduling,
      laneCycle: ['work'],
      maxInFlight: 1,
      now: () => 0,
      run: async () => {},
    });
    const input = work('key');
    const previous = scheduler.replace(input);
    const snapshot = scheduler.entries();
    const current = scheduler.replace(input);

    expect(previous).not.toBe(input);
    expect(current).not.toBe(previous);

    expect([...snapshot]).toEqual([previous]);
    expect(scheduler.isCurrent(previous)).toBe(false);
    expect(scheduler.isCurrent(current)).toBe(true);
    expect(
      scheduler.replaceIfCurrent(previous, work('key', 50)),
    ).toBeUndefined();
    expect(scheduler.removeIfCurrent(previous)).toBe(false);
    expect(scheduler.get('key')).toBe(current);

    const next = scheduler.replaceIfCurrent(current, work('key', 50));
    expect(next).toBeDefined();
    expect(scheduler.get('key')).toBe(next);
    expect(scheduler.removeIfCurrent(current)).toBe(false);
    const reinstalled = scheduler.replace(next!);
    expect(reinstalled).not.toBe(next);
    expect(scheduler.removeIfCurrent(next!)).toBe(false);
    expect(scheduler.removeIfCurrent(reinstalled)).toBe(true);
    expect([...scheduler.entries()]).toEqual([]);
  });

  it('releases a rejected callback without changing its error or choosing a retry policy', async () => {
    const operation = deferred();
    const error = new Error('operation failed');
    const scheduler = new Scheduler({
      ...scheduling,
      laneCycle: ['work'],
      maxInFlight: 1,
      now: () => 0,
      run: (entry) => {
        if (entry.key === 'failed') return operation.promise;
        scheduler.removeIfCurrent(entry);
        return Promise.resolve();
      },
    });
    const failed = scheduler.replace(work('failed'));
    scheduler.replace(work('other'));
    scheduler.pump();
    const waiting = scheduler.waitForInFlight();
    const originalError = expect(operation.promise).rejects.toBe(error);

    operation.reject(error);
    await Promise.all([waiting, originalError]);
    expect(scheduler.inFlightCount).toBe(0);
    expect(scheduler.get('failed')).toBe(failed);
    scheduler.remove('failed');
    expect(scheduler.pump().map((entry) => entry.key)).toEqual(['other']);
    await scheduler.waitForInFlight();
  });

  it('waits for the active snapshot without waiting for work admitted afterward', async () => {
    const operations = new Map([
      ['first', deferred()],
      ['later', deferred()],
    ]);
    const scheduler = new Scheduler({
      ...scheduling,
      laneCycle: ['work'],
      maxInFlight: 2,
      now: () => 0,
      run: async (entry) => {
        await operations.get(entry.key)!.promise;
        scheduler.removeIfCurrent(entry);
      },
    });
    scheduler.replace(work('first'));
    scheduler.pump();
    const waiting = scheduler.waitForInFlight();
    scheduler.replace(work('later'));
    scheduler.pump();

    operations.get('first')!.resolve();
    await waiting;
    expect(scheduler.hasInFlight('first')).toBe(false);
    expect(scheduler.hasInFlight('later')).toBe(true);
    expect(scheduler.inFlightCount).toBe(1);
    operations.get('later')!.resolve();
    await scheduler.waitForInFlight();
  });

  it('restricts admission without discarding other entries or counting active work as backlog', async () => {
    let now = 100;
    const operation = deferred();
    const scheduler = new Scheduler({
      ...scheduling,
      laneCycle: ['work'],
      maxInFlight: 2,
      now: () => now,
      run: async (entry) => {
        await operation.promise;
        scheduler.removeIfCurrent(entry);
      },
    });
    scheduler.replace(work('outside', 10));
    scheduler.replace(work('allowed', 40));
    scheduler.replace(work('future', 150));
    expect(scheduler.backlog()).toEqual({
      scheduledCount: 3,
      inFlightCount: 0,
      oldestDueAgeMs: 90,
    });

    expect(
      scheduler.pump(new Set(['allowed', 'future'])).map((entry) => entry.key),
    ).toEqual(['allowed']);
    now = 120;
    expect(scheduler.backlog()).toEqual({
      scheduledCount: 2,
      inFlightCount: 1,
      oldestDueAgeMs: 110,
    });
    expect(scheduler.pump(new Set(['future']))).toEqual([]);
    expect(
      scheduler.pump(new Set(['outside'])).map((entry) => entry.key),
    ).toEqual(['outside']);
    expect(scheduler.backlog()).toEqual({
      scheduledCount: 1,
      inFlightCount: 2,
      oldestDueAgeMs: 0,
    });

    now = 150;
    expect(scheduler.pump(new Set(['future']))).toEqual([]);
    operation.resolve();
    await scheduler.waitForInFlight();
    now = 160;
    expect(scheduler.backlog()).toEqual({
      scheduledCount: 1,
      inFlightCount: 0,
      oldestDueAgeMs: 10,
    });
    expect(
      scheduler.pump(new Set(['future'])).map((entry) => entry.key),
    ).toEqual(['future']);
    await scheduler.waitForInFlight();
  });
});
