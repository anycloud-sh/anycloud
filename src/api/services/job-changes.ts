import { once, setMaxListeners } from 'node:events';

interface JobChangeSubscription {
  promise: Promise<'changed' | 'timeout'>;
  dispose(): void;
}

/** A Deployment wake: `waiters` of the longest waiting, each handed `hops`. */
interface DeploymentWake {
  waiters: number;
  hops?: number;
}

export interface JobChanges {
  subscribe(
    jobId: string,
    signal: AbortSignal | undefined,
    deadlineAt: number,
  ): JobChangeSubscription;
  notify(jobId: string): void;
  subscribeDeployment(
    deploymentId: string,
    signal: AbortSignal | undefined,
    deadlineAt: number,
  ): JobChangeSubscription & {
    /** The hops it was woken with; 0 until woken, or after a broadcast. */
    readonly hops: number;
    /** Wake other waiters, never this one. */
    handOn(wake: DeploymentWake): void;
  };
  /** Without `wake`, wakes every waiter, as a runtime change must. */
  notifyDeployment(deploymentId: string, wake?: DeploymentWake): void;
}

/** Wake local observers; committed database state remains authoritative. */
export function createJobChanges(): JobChanges {
  const target = new EventTarget();
  // Concurrent requests can legitimately observe the same Job.
  setMaxListeners(0, target);
  function subscribe(
    key: string,
    signal: AbortSignal | undefined,
    deadlineAt: number,
  ): JobChangeSubscription {
    const controller = new AbortController();
    const timeout = Symbol('wait expired');
    const abort = () => controller.abort(signal?.reason);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    // once() registers synchronously, before the caller reads SQLite.
    const promise = once(target, key, {
      signal: controller.signal,
    })
      .then(
        () => 'changed' as const,
        () => {
          if (controller.signal.reason === timeout) return 'timeout' as const;
          throw controller.signal.reason;
        },
      )
      .finally(cleanup);
    // An abort can arrive during the database read, before anyone awaits us.
    // Retain the rejected Promise for the caller while handling it immediately.
    void promise.catch(() => undefined);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(timeout),
      Math.max(0, deadlineAt - performance.now()),
    );
    if (signal?.aborted) abort();

    return {
      promise,
      dispose() {
        cleanup();
        controller.abort(
          new DOMException('Subscription disposed', 'AbortError'),
        );
      },
    };
  }
  // Each Deployment's waiters, oldest first, so a Job change wakes one.
  const waiters = new Map<string, Map<string, { hops: number }>>();
  let next = 0;
  function notifyDeployment(
    deploymentId: string,
    wake?: DeploymentWake,
    skip?: string,
  ): void {
    const queue = waiters.get(deploymentId);
    if (!queue) return;
    const hops = wake?.hops ?? queue.size;
    let count = wake?.waiters ?? Infinity;
    for (const [key, waiter] of queue) {
      if (key === skip) continue;
      if (count-- <= 0) break;
      // Woken now, it takes no second wake before it settles.
      queue.delete(key);
      if (wake) waiter.hops = hops;
      target.dispatchEvent(new Event(key));
    }
  }
  return {
    subscribe: (jobId, signal, deadlineAt) =>
      subscribe(`job:${jobId}`, signal, deadlineAt),
    notify: (jobId) => {
      target.dispatchEvent(new Event(`job:${jobId}`));
    },
    subscribeDeployment: (deploymentId, signal, deadlineAt) => {
      const key = `deployment:${deploymentId}#${next++}`;
      const queue = waiters.get(deploymentId) ?? new Map();
      const waiter = { hops: 0 };
      waiters.set(deploymentId, queue.set(key, waiter));
      const release = () => {
        queue.delete(key);
        if (queue.size === 0 && waiters.get(deploymentId) === queue)
          waiters.delete(deploymentId);
      };
      const subscription = subscribe(key, signal, deadlineAt);
      void subscription.promise.then(release, release);
      return {
        promise: subscription.promise,
        get hops() {
          return waiter.hops;
        },
        handOn: (wake) => notifyDeployment(deploymentId, wake, key),
        dispose() {
          release();
          subscription.dispose();
        },
      };
    },
    notifyDeployment: (deploymentId, wake) =>
      notifyDeployment(deploymentId, wake),
  };
}
