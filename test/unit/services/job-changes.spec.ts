import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJobChanges } from '../../../src/api/services/job-changes.js';

describe('local Job change subscriptions', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('wakes every matching Deployment receiver without crossing Job or Deployment keys', async () => {
    const changes = createJobChanges();
    const deadline = performance.now() + 20_000;
    const receivers = Array.from({ length: 12 }, () =>
      changes.subscribeDeployment('shared', undefined, deadline),
    );
    const job = changes.subscribe('shared', undefined, deadline);
    const other = changes.subscribeDeployment('other', undefined, deadline);
    const settled = vi.fn();
    void job.promise.then(settled);
    void other.promise.then(settled);
    changes.notifyDeployment('shared');
    await expect(
      Promise.all(receivers.map(({ promise }) => promise)),
    ).resolves.toEqual(Array(12).fill('changed'));
    expect(settled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(2);
    changes.notify('shared');
    changes.notifyDeployment('other');
    await Promise.all([job.promise, other.promise]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wakes a Job change's waiters oldest first, each with its hops", async () => {
    const changes = createJobChanges();
    const deadline = performance.now() + 20_000;
    const [gone, first, second, third] = Array.from({ length: 4 }, () =>
      changes.subscribeDeployment('deployment', undefined, deadline),
    );
    const woken: number[] = [];
    [first, second, third].forEach(
      (waiter, i) => void waiter!.promise.then(() => woken.push(i)),
    );
    gone!.dispose();
    void gone!.promise.catch(() => undefined);
    changes.notifyDeployment('deployment', { waiters: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(woken).toEqual([0]);
    expect(first!.hops).toBe(3);
    changes.notifyDeployment('deployment', { waiters: 2, hops: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(woken).toEqual([0, 1, 2]);
    expect([second!.hops, third!.hops]).toEqual([1, 1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['deadline', 'cancel', 'dispose'] as const)(
    'releases a Deployment listener after %s',
    async (ending) => {
      const changes = createJobChanges();
      const controller = new AbortController();
      const registered = vi.spyOn(EventTarget.prototype, 'addEventListener');
      const subscription = changes.subscribeDeployment(
        'deployment',
        controller.signal,
        performance.now() + 100,
      );
      const call = registered.mock.calls.findIndex(([name]) =>
        name.startsWith('deployment:deployment#'),
      );
      const key = registered.mock.calls[call]![0];
      const target = registered.mock.contexts[call] as EventTarget;
      expect(getEventListeners(target, key)).toHaveLength(1);
      if (ending === 'deadline') {
        await vi.advanceTimersByTimeAsync(100);
        await expect(subscription.promise).resolves.toBe('timeout');
      } else {
        if (ending === 'cancel') controller.abort();
        else subscription.dispose();
        await expect(subscription.promise).rejects.toMatchObject({
          name: 'AbortError',
        });
      }
      expect(getEventListeners(target, key)).toHaveLength(0);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('wakes every matching waiter even before their Promises are awaited', async () => {
    const changes = createJobChanges();
    const signals = Array.from(
      { length: 20 },
      () => new AbortController().signal,
    );
    const deadline = performance.now() + 20_000;
    const waiters = signals.map((signal) =>
      changes.subscribe('job', signal, deadline),
    );
    const other = changes.subscribe('other', undefined, deadline);
    const otherResolved = vi.fn();
    void other.promise.then(otherResolved);
    changes.notify('job');
    await expect(
      Promise.all(waiters.map((waiter) => waiter.promise)),
    ).resolves.toEqual(Array(20).fill('changed'));
    expect(otherResolved).not.toHaveBeenCalled();
    for (const signal of signals)
      expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
    changes.notify('other');
    await expect(other.promise).resolves.toBe('changed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['error', 'newListener', 'removeListener', '__proto__'])(
    'treats %s as an ordinary Job ID',
    async (id) => {
      const changes = createJobChanges();
      expect(() => changes.notify(id)).not.toThrow();
      const own = changes.subscribe(id, undefined, performance.now() + 1000);
      const other = changes.subscribe(
        'unrelated',
        undefined,
        performance.now() + 1000,
      );
      const settled = vi.fn();
      void other.promise.then(settled, settled);
      changes.notify(id);
      await expect(own.promise).resolves.toBe('changed');
      expect(settled).not.toHaveBeenCalled();
      other.dispose();
      await expect(other.promise).rejects.toMatchObject({ name: 'AbortError' });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('releases both Job and disconnect listeners when its deadline expires', async () => {
    const changes = createJobChanges();
    const controller = new AbortController();
    const registered = vi.spyOn(EventTarget.prototype, 'addEventListener');
    const subscription = changes.subscribe(
      'job',
      controller.signal,
      performance.now() + 100,
    );
    const call = registered.mock.calls.findIndex(
      ([name]) => name === 'job:job',
    );
    const target = registered.mock.contexts[call] as EventTarget;
    expect(getEventListeners(target, 'job:job')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    await expect(subscription.promise).resolves.toBe('timeout');
    expect(getEventListeners(target, 'job:job')).toHaveLength(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    subscription.dispose();
    subscription.dispose();
  });

  it.each([true, false])(
    'preserves an abort reason before awaiting (already aborted: %s)',
    async (alreadyAborted) => {
      const changes = createJobChanges();
      const controller = new AbortController();
      const reason = new Error('HTTP request disconnected');
      if (alreadyAborted) controller.abort(reason);
      const subscription = changes.subscribe(
        'job',
        controller.signal,
        performance.now() + 1000,
      );
      if (!alreadyAborted) controller.abort(reason);
      // Simulate the handler still awaiting its database read.
      await vi.advanceTimersByTimeAsync(0);
      await expect(subscription.promise).rejects.toBe(reason);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('disposes an unused subscription and keeps independent instances isolated', async () => {
    const first = createJobChanges();
    const second = createJobChanges();
    const controller = new AbortController();
    const subscription = first.subscribe(
      'job',
      controller.signal,
      performance.now() + 1000,
    );
    const settled = vi.fn();
    void subscription.promise.then(settled, settled);
    second.notify('job');
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    subscription.dispose();
    subscription.dispose();
    await expect(subscription.promise).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
