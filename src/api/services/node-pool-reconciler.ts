import type { NodePoolRepository } from './cluster-store.js';
import type { NodePoolController } from './node-pool-controller.js';
import { log } from './logger.js';

const NODE_POOL_RECONCILE_INTERVAL_MS = 30_000;

export interface NodePoolReconciler {
  start(): void;
  stop(): Promise<void>;
  schedule(nodePoolId: string): Promise<void>;
  reconcileAll(): Promise<void>;
}

interface ActiveReconcile {
  promise: Promise<void>;
  rerun: boolean;
}

/** One reconcile per node pool at a time; a request during a run reruns it once. */
export function createNodePoolReconciler(input: {
  nodePools: Pick<NodePoolRepository, 'listForReconciliation'>;
  controller: NodePoolController;
  intervalMs?: number;
}): NodePoolReconciler {
  const active = new Map<string, ActiveReconcile>();
  const intervalMs = input.intervalMs ?? NODE_POOL_RECONCILE_INTERVAL_MS;
  let timer: NodeJS.Timeout | undefined;

  function schedule(nodePoolId: string): Promise<void> {
    const existing = active.get(nodePoolId);
    if (existing) {
      existing.rerun = true;
      return existing.promise;
    }
    const entry: ActiveReconcile = { rerun: false, promise: Promise.resolve() };
    entry.promise = (async () => {
      do {
        entry.rerun = false;
        try {
          await input.controller.reconcile(nodePoolId);
        } catch (error) {
          log.warn('Node pool reconciliation failed', {
            id: nodePoolId,
            error,
          });
        }
      } while (entry.rerun);
    })().finally(() => {
      if (active.get(nodePoolId) === entry) active.delete(nodePoolId);
    });
    active.set(nodePoolId, entry);
    return entry.promise;
  }

  async function reconcileAll(): Promise<void> {
    const nodePools = await input.nodePools.listForReconciliation();
    await Promise.all(nodePools.map((nodePool) => schedule(nodePool.id)));
  }

  function start(): void {
    if (timer) return;
    const discover = () =>
      void reconcileAll().catch((error) =>
        log.error('Node pool discovery failed', { id: 'system', error }),
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
