import type { WorkloadEventMetadataInput } from '../workload-event-metadata.js';
import type { StoredWorkload } from '../workload-record.js';
import { WorkloadState, type EndReason } from '../../../shared/workload.js';

/** The reads and the outcome write the VM Job's own retry cap needs. */
interface VmJobMaxRetriesPersistence {
  store: { lastVmPreempted(workloadId: string): Promise<boolean> };
  events: {
    countStateEvents(workloadId: string, state: WorkloadState): Promise<number>;
  };
  outcomes: {
    publishTerminalOutcome(
      workloadId: string,
      targetState: WorkloadState,
      expectedState: WorkloadState,
      options?: {
        metadata?: WorkloadEventMetadataInput;
        endReason?: EndReason;
        lastAttemptEndReason?: EndReason;
      },
    ): Promise<boolean>;
  };
}

/** Whether a VM Job's disruptions so far exceed its own --max-retries. */
export async function pastMaxRetries(
  events: VmJobMaxRetriesPersistence['events'],
  { id, maxRetries }: Pick<StoredWorkload, 'id' | 'maxRetries'>,
): Promise<boolean> {
  return (
    maxRetries !== null &&
    (await events.countStateEvents(id, WorkloadState.Recovering)) > maxRetries
  );
}

/**
 * A VM Job's own `--max-retries` (RFC 0049 C3) caps its disruptions: each
 * reclaimed or lost host is one Recovering transition. Past the cap it ends
 * the Job with what ended the attempt, so 0 ends a Spot Job as `reclaimed`.
 * Null while within the cap or with no cap; the system's budgets then apply.
 */
export async function endAtMaxRetries(
  { store, events, outcomes }: VmJobMaxRetriesPersistence,
  workload: Pick<StoredWorkload, 'id' | 'maxRetries'>,
  state: WorkloadState,
): Promise<{ disposition: 'completed' | 'stale' } | null> {
  const { id, maxRetries } = workload;
  if (
    state !== WorkloadState.Recovering ||
    !(await pastMaxRetries(events, workload))
  ) {
    return null;
  }
  const endReason: EndReason = (await store.lastVmPreempted(id))
    ? 'reclaimed'
    : 'lost';
  const published = await outcomes.publishTerminalOutcome(
    id,
    WorkloadState.Failed,
    state,
    // Both name what ended the last attempt, as on a pool.
    {
      endReason,
      lastAttemptEndReason: endReason,
      metadata: { reason: `max retries (${maxRetries}) reached` },
    },
  );
  return { disposition: published ? 'completed' : 'stale' };
}
