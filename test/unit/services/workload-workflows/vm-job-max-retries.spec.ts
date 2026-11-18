import { describe, expect, it, vi } from 'vitest';
import { endAtMaxRetries } from '../../../../src/api/services/workload-workflows/vm-job-max-retries.js';
import { WorkloadState } from '../../../../src/shared/workload.js';

function persistence(recoveries: number, preempted: boolean) {
  return {
    store: { lastVmPreempted: vi.fn(async () => preempted) },
    events: { countStateEvents: vi.fn(async () => recoveries) },
    outcomes: { publishTerminalOutcome: vi.fn(async () => true) },
  };
}

describe('endAtMaxRetries', () => {
  it('ends a Spot VM Job at its first reclaim with --max-retries 0', async () => {
    const deps = persistence(1, true);
    await expect(
      endAtMaxRetries(
        deps,
        { id: 'job-a', maxRetries: 0 },
        WorkloadState.Recovering,
      ),
    ).resolves.toEqual({ disposition: 'completed' });
    expect(deps.events.countStateEvents).toHaveBeenCalledWith(
      'job-a',
      WorkloadState.Recovering,
    );
    expect(deps.outcomes.publishTerminalOutcome).toHaveBeenCalledWith(
      'job-a',
      WorkloadState.Failed,
      WorkloadState.Recovering,
      {
        endReason: 'reclaimed',
        lastAttemptEndReason: 'reclaimed',
        metadata: { reason: 'max retries (0) reached' },
      },
    );
  });

  it('names a lost host lost', async () => {
    const deps = persistence(3, false);
    await endAtMaxRetries(
      deps,
      { id: 'job-a', maxRetries: 2 },
      WorkloadState.Recovering,
    );
    expect(deps.outcomes.publishTerminalOutcome).toHaveBeenCalledWith(
      'job-a',
      WorkloadState.Failed,
      WorkloadState.Recovering,
      expect.objectContaining({ endReason: 'lost' }),
    );
  });

  it('leaves the system budgets to a Job within its cap, without one, or retrying a deploy', async () => {
    for (const [maxRetries, state] of [
      [1, WorkloadState.Recovering],
      [null, WorkloadState.Recovering],
      [0, WorkloadState.Retrying],
    ] as const) {
      const deps = persistence(1, true);
      await expect(
        endAtMaxRetries(deps, { id: 'job-a', maxRetries }, state),
      ).resolves.toBeNull();
      expect(deps.outcomes.publishTerminalOutcome).not.toHaveBeenCalled();
    }
  });

  it('reports a lost race as stale', async () => {
    const deps = persistence(1, true);
    deps.outcomes.publishTerminalOutcome.mockResolvedValue(false);
    await expect(
      endAtMaxRetries(
        deps,
        { id: 'job-a', maxRetries: 0 },
        WorkloadState.Recovering,
      ),
    ).resolves.toEqual({ disposition: 'stale' });
  });
});
