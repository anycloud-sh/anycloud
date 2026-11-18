import { describe, expect, it, vi } from 'vitest';
import type { NodePoolController } from '../../../src/api/services/node-pool-controller.js';
import { createNodePoolReconciler } from '../../../src/api/services/node-pool-reconciler.js';

function controllerWith(
  reconcile: NodePoolController['reconcile'],
): NodePoolController {
  return {
    reconcile,
    observeCapacity: vi.fn(),
    assertClusterCompatible: vi.fn(),
    ingress: vi.fn(),
  };
}

describe('node pool reconciler', () => {
  it('discovers every non-deleted node pool after startup and on each interval', async () => {
    const reconcile = vi.fn().mockResolvedValue(undefined);
    const listForReconciliation = vi
      .fn()
      .mockResolvedValue([{ id: 'node-pool-a' }, { id: 'node-pool-b' }]);
    const reconciler = createNodePoolReconciler({
      nodePools: { listForReconciliation },
      controller: controllerWith(reconcile),
      intervalMs: 60_000,
    });

    await reconciler.reconcileAll();
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledWith('node-pool-a');
    expect(reconcile).toHaveBeenCalledWith('node-pool-b');

    vi.useFakeTimers();
    try {
      reconciler.start();
      reconciler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(listForReconciliation).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(listForReconciliation).toHaveBeenCalledTimes(3);
      await reconciler.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(listForReconciliation).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces concurrent work into one requested rerun and survives a failed pass', async () => {
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const reconcile = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockRejectedValueOnce(new Error('transient failure'))
      .mockResolvedValue(undefined);
    const reconciler = createNodePoolReconciler({
      nodePools: { listForReconciliation: vi.fn().mockResolvedValue([]) },
      controller: controllerWith(reconcile),
    });

    const scheduled = reconciler.schedule('node-pool-a');
    expect(reconciler.schedule('node-pool-a')).toBe(scheduled);
    expect(reconciler.schedule('node-pool-a')).toBe(scheduled);
    releaseFirst?.();
    await scheduled;
    expect(reconcile).toHaveBeenCalledTimes(2);

    await reconciler.schedule('node-pool-a');
    expect(reconcile).toHaveBeenCalledTimes(3);
  });
});
