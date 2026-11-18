import { log } from './logger.js';
import type { NodePoolServiceController } from './node-pool-service-controller.js';
import type { NodePoolServiceCandidate } from './repositories/node-pool-services.js';

const NODE_POOL_SERVICE_RECONCILE_INTERVAL_MS = 15_000;

export interface NodePoolServiceReconciler {
  start(): void;
  stop(): Promise<void>;
  /** Reconcile one Service now; a request during a run reruns it once. */
  schedule(workloadId: string): Promise<void>;
  reconcileAll(): Promise<void>;
}

interface ActiveReconcile {
  promise: Promise<void>;
  rerun: boolean;
}

/**
 * Discovers node-pool-targeted Services from SQLite and reconciles each one at
 * a time. Restart recovery is the same discovery: every non-terminal row is
 * re-read and its native objects re-applied idempotently.
 */
export function createNodePoolServiceReconciler(input: {
  workloads: {
    listNodePoolServiceCandidates(): Promise<NodePoolServiceCandidate[]>;
  };
  controller: Pick<NodePoolServiceController, 'reconcile'>;
  intervalMs?: number;
}): NodePoolServiceReconciler {
  const active = new Map<string, ActiveReconcile>();
  const intervalMs =
    input.intervalMs ?? NODE_POOL_SERVICE_RECONCILE_INTERVAL_MS;
  let timer: NodeJS.Timeout | undefined;

  function schedule(workloadId: string): Promise<void> {
    const existing = active.get(workloadId);
    if (existing) {
      existing.rerun = true;
      return existing.promise;
    }
    const entry: ActiveReconcile = { rerun: false, promise: Promise.resolve() };
    entry.promise = (async () => {
      do {
        entry.rerun = false;
        try {
          await input.controller.reconcile(workloadId);
        } catch (error) {
          log.warn('Node pool Service reconcile deferred', {
            id: workloadId,
            error,
          });
        }
      } while (entry.rerun);
    })().finally(() => {
      if (active.get(workloadId) === entry) active.delete(workloadId);
    });
    active.set(workloadId, entry);
    return entry.promise;
  }

  async function reconcileAll(): Promise<void> {
    const candidates = await input.workloads.listNodePoolServiceCandidates();
    await Promise.all(candidates.map((candidate) => schedule(candidate.id)));
  }

  function start(): void {
    if (timer) return;
    const discover = () =>
      void reconcileAll().catch((error) =>
        log.error('Node pool Service discovery failed', {
          id: 'system',
          error,
        }),
      );
    discover();
    timer = setInterval(discover, intervalMs);
    timer.unref();
  }

  async function stop(): Promise<void> {
    if (timer) clearInterval(timer);
    timer = undefined;
    await Promise.allSettled(
      [...active.values()].map((entry) => entry.promise),
    );
  }

  return { start, stop, schedule, reconcileAll };
}
