import { describe, expect, it, vi } from 'vitest';
import {
  activeWorkloadWorkCount,
  drainWorkloadWork,
  hasWorkloadWork,
  trackWorkloadWork,
} from '../../../src/api/services/workload-work-registry.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('workload work registry', () => {
  it('keeps ownership until tracked work settles without changing its result', async () => {
    const countBefore = activeWorkloadWorkCount();
    const operation = deferred<string>();
    trackWorkloadWork('operation', operation.promise);

    expect(hasWorkloadWork('operation')).toBe(true);
    expect(activeWorkloadWorkCount()).toBe(countBefore + 1);

    const drained = vi.fn();
    const drain = drainWorkloadWork('operation').then(drained);
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();

    operation.resolve('result');
    await drain;

    await expect(operation.promise).resolves.toBe('result');
    expect(drained).toHaveBeenCalledOnce();
    expect(hasWorkloadWork('operation')).toBe(false);
    expect(activeWorkloadWorkCount()).toBe(countBefore);
  });

  it('drains work registered while earlier work settles', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    trackWorkloadWork('chained-operation', first.promise);
    void first.promise.then(() => {
      trackWorkloadWork('chained-operation', second.promise);
    });

    let drainFinished = false;
    const drain = drainWorkloadWork('chained-operation').then(() => {
      drainFinished = true;
    });

    first.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(hasWorkloadWork('chained-operation')).toBe(true);
    expect(drainFinished).toBe(false);

    second.resolve();
    await drain;

    expect(hasWorkloadWork('chained-operation')).toBe(false);
  });

  it('observes rejection without changing the original promise', async () => {
    const countBefore = activeWorkloadWorkCount();
    const error = new Error('operation failed late');
    const operation = deferred<void>();
    trackWorkloadWork('rejected-operation', operation.promise);

    const originalResult = operation.promise.catch((caught) => caught);
    operation.reject(error);

    await expect(originalResult).resolves.toBe(error);
    await drainWorkloadWork('rejected-operation');
    expect(hasWorkloadWork('rejected-operation')).toBe(false);
    expect(activeWorkloadWorkCount()).toBe(countBefore);
  });

  it('counts a key once and retains ownership until its last operation settles', async () => {
    const countBefore = activeWorkloadWorkCount();
    const first = deferred<void>();
    const second = deferred<void>();
    const independent = deferred<void>();
    trackWorkloadWork('shared-key', first.promise);
    trackWorkloadWork('shared-key', second.promise);
    trackWorkloadWork('independent-key', independent.promise);
    expect(activeWorkloadWorkCount()).toBe(countBefore + 2);

    let sharedDrainFinished = false;
    const sharedDrain = drainWorkloadWork('shared-key').then(() => {
      sharedDrainFinished = true;
    });
    first.resolve();
    await first.promise;
    expect(hasWorkloadWork('shared-key')).toBe(true);
    expect(activeWorkloadWorkCount()).toBe(countBefore + 2);
    expect(sharedDrainFinished).toBe(false);

    independent.resolve();
    await drainWorkloadWork('independent-key');
    expect(hasWorkloadWork('independent-key')).toBe(false);
    expect(hasWorkloadWork('shared-key')).toBe(true);
    expect(activeWorkloadWorkCount()).toBe(countBefore + 1);
    expect(sharedDrainFinished).toBe(false);

    second.resolve();
    await sharedDrain;
    expect(hasWorkloadWork('shared-key')).toBe(false);
    expect(activeWorkloadWorkCount()).toBe(countBefore);
  });

  it('returns on an empty set without closing later registration', async () => {
    const countBefore = activeWorkloadWorkCount();
    const registerLater = deferred<void>();
    const operation = deferred<void>();
    const registration = registerLater.promise.then(() => {
      trackWorkloadWork('later-operation', operation.promise);
    });

    await drainWorkloadWork('later-operation');
    expect(hasWorkloadWork('later-operation')).toBe(false);

    registerLater.resolve();
    await registration;
    expect(hasWorkloadWork('later-operation')).toBe(true);
    expect(activeWorkloadWorkCount()).toBe(countBefore + 1);
    operation.resolve();
    await drainWorkloadWork('later-operation');
    expect(hasWorkloadWork('later-operation')).toBe(false);
    expect(activeWorkloadWorkCount()).toBe(countBefore);
  });
});
