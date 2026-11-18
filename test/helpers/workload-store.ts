import type {
  AddVMAttempt,
  GatewayVM,
  ProvisioningAttemptRef,
} from '../../src/api/services/entities.js';
import type { StoredWorkload } from '../../src/api/services/workload-record.js';
import {
  createWorkload,
  type CreateWorkloadInput,
} from '../../src/api/services/repositories/workload-creation.js';
import { getDB } from '../../src/api/services/repositories/db.js';
import {
  getProvisioningAttemptStore,
  getWorkloadLifecycle,
  getWorkloadQueryStore as queries,
  getWorkloadOutcomes,
} from '../../src/api/services/persistence.js';
import {
  VALID_TRANSITIONS,
  WorkloadState,
  isTerminalState,
} from '../../src/shared/workload.js';

/** Retry and queue states add retry history, so a path crosses them only when it must. */
const RETRY_HISTORY_STATES = new Set([
  WorkloadState.Queued,
  WorkloadState.Retrying,
  WorkloadState.Recovering,
]);

function canTransition(from: WorkloadState, to: WorkloadState): boolean {
  if (to === WorkloadState.Queued && from === WorkloadState.Provisioning) {
    return true;
  }
  return VALID_TRANSITIONS[to].includes(from);
}

function transitionPath(
  from: WorkloadState,
  to: WorkloadState,
): WorkloadState[] | null {
  if (from === to) return [to];
  for (const crossRetryHistory of [false, true]) {
    const previous = new Map<WorkloadState, WorkloadState>();
    const queue = [from];
    while (queue.length > 0) {
      const state = queue.shift()!;
      for (const next of Object.values(WorkloadState)) {
        if (next === from || previous.has(next) || !canTransition(state, next))
          continue;
        previous.set(next, state);
        if (next === to) {
          const path = [to];
          while (path[0] !== from) path.unshift(previous.get(path[0])!);
          return path.slice(1);
        }
        if (
          !isTerminalState(next) &&
          (crossRetryHistory || !RETRY_HISTORY_STATES.has(next))
        ) {
          queue.push(next);
        }
      }
    }
  }
  return null;
}

async function stateOf(workloadId: string): Promise<WorkloadState> {
  const [row] = await getDB().query<{ state: WorkloadState }>(
    'SELECT state FROM workloads WHERE id = ?',
    [workloadId],
  );
  if (!row) throw new Error(`Workload fixture ${workloadId} was not found`);
  return row.state;
}

/**
 * Move a fixture to `target` through the owned transitions production uses:
 * step claims, retry admission, empty-admission release, and terminal
 * outcomes. Each hop appends its real event, and a refused hop throws.
 */
export async function walkToState(
  workloadId: string,
  target: WorkloadState,
): Promise<void> {
  const state = await stateOf(workloadId);
  if (
    state === target &&
    (target === WorkloadState.Queued || isTerminalState(target))
  ) {
    return;
  }
  const path = transitionPath(state, target);
  if (!path) {
    throw new Error(
      `Workload fixture ${workloadId}: no transition from ${state} to ${target}`,
    );
  }
  const lifecycle = getWorkloadLifecycle();
  let from = state;
  for (const to of path) {
    let moved: boolean;
    if (to === WorkloadState.Queued && from === WorkloadState.Provisioning) {
      moved = await lifecycle.releaseEmptyProvisioningAdmission(workloadId);
    } else if (to === WorkloadState.Queued) {
      const [revision] = await getDB().query<{ id: number }>(
        'SELECT MAX(id) AS id FROM workload_events WHERE workload_id = ?',
        [workloadId],
      );
      moved =
        (await lifecycle.queueRetryCandidate(workloadId, revision!.id)) ===
        'queued';
    } else if (isTerminalState(to)) {
      moved = await getWorkloadOutcomes().publishTerminalOutcome(
        workloadId,
        to,
        from,
      );
    } else {
      moved = await lifecycle.updateState(workloadId, to);
    }
    if (!moved) {
      throw new Error(
        `Workload fixture ${workloadId}: ${from} → ${to} was refused`,
      );
    }
    from = to;
  }
}

/**
 * Register one provisioning attempt as the VM provisioner does, and complete
 * it with the provider's VM. Only a Provisioning workload admits an attempt,
 * so a Queued fixture is admitted first. A VM without an `ip` leaves the
 * attempt unresolved, the row a failed launch leaves for cleanup.
 */
export async function provisionTestVm(
  workloadId: string,
  vm: Omit<GatewayVM, 'ip'> & { ip?: string },
  attempt?: AddVMAttempt,
): Promise<ProvisioningAttemptRef> {
  if ((await stateOf(workloadId)) === WorkloadState.Queued) {
    await walkToState(workloadId, WorkloadState.Provisioning);
  }
  const ledger = getProvisioningAttemptStore();
  const ref = await ledger.beginProvisioningAttempt(
    workloadId,
    vm.cloudId,
    attempt,
  );
  if (!ref) {
    throw new Error(
      `Workload fixture ${workloadId}: an attempt needs a Provisioning workload, not ${await stateOf(workloadId)}`,
    );
  }
  const { ip } = vm;
  return ip === undefined
    ? ref
    : ledger.completeProvisioningAttempt(workloadId, ref, { ...vm, ip });
}

/**
 * Release a workload's live attempts as termination does: claim their
 * removal, then end each one the provider confirmed gone. Omit `cloudId` to
 * release every live attempt.
 */
export async function releaseTestVms(
  workloadId: string,
  cloudId?: string,
): Promise<void> {
  const ledger = getProvisioningAttemptStore();
  const live = (await ledger.getProvisioningAttempts(workloadId)).filter(
    (row) =>
      row.ended_at === null &&
      (cloudId === undefined || row.cloud_id === cloudId),
  );
  await ledger.claimVmRemoval(
    workloadId,
    live.map((row) => row.cloud_id),
  );
  for (const row of live) {
    await ledger.endProvisioningAttempt(workloadId, {
      vmRowId: row.id,
      cloudId: row.cloud_id,
      createdAt: row.created_at,
    });
  }
}

/**
 * Mark a live VM preempted as the monitor does: claim Recovering from the
 * workload's current step, bound to that VM. A Provisioning fixture reaches
 * Running first, since only a started VM can be preempted.
 */
export async function preemptTestVm(
  workloadId: string,
  cloudId: string,
): Promise<void> {
  if ((await stateOf(workloadId)) === WorkloadState.Provisioning) {
    await walkToState(workloadId, WorkloadState.Running);
  }
  const state = await stateOf(workloadId);
  const ip = (
    await getProvisioningAttemptStore().getProvisioningAttempts(workloadId)
  ).find(
    (row) => row.cloud_id === cloudId && row.ended_at === null && row.ip,
  )?.ip;
  const claimed =
    ip != null &&
    (await getWorkloadLifecycle().claimRecovery(workloadId, state, {
      vm: { cloudId, ip, markPreempted: true },
    }));
  if (!claimed) {
    throw new Error(
      `Workload fixture ${workloadId}: preempting ${cloudId} from ${state} was refused`,
    );
  }
}

export type TestWorkloadFixture = Pick<CreateWorkloadInput, 'id' | 'userId'> &
  Partial<Omit<CreateWorkloadInput, 'id' | 'userId'>> & {
    /** Defaults to Running so background schedulers cannot claim the fixture. */
    state?: WorkloadState;
  };

/**
 * Create and hydrate a workload through the same repository boundary as the
 * API. This keeps integration fixtures aligned with the current parent/child
 * persistence schema instead of teaching each test its columns.
 */
export async function seedTestWorkload(
  fixture: TestWorkloadFixture,
): Promise<StoredWorkload> {
  const {
    state = WorkloadState.Running,
    workloadType = 'job',
    image = 'img',
    dockerCommand = `docker run ${image}`,
    sshPrivateKey = 'seeded-test-private-key',
    ...input
  } = fixture;
  await createWorkload(
    getDB(),
    {
      ...input,
      workloadType,
      image,
      dockerCommand,
      sshPrivateKey,
    },
    { initialState: state },
  );
  return requireTestWorkload(fixture.id);
}

/** Hydrate an existing fixture through WorkloadQueryStore.getWorkload. */
export async function requireTestWorkload(
  workloadId: string,
): Promise<StoredWorkload> {
  const workload = await queries().getWorkload(workloadId);
  if (!workload) {
    throw new Error(`Workload fixture ${workloadId} was not found`);
  }
  return workload;
}

/**
 * The metadata a workload event actually carries, read back out of the row.
 *
 * Asserting the argument handed to a writer proves the call happened, not that
 * the data survived being written — an Error passed that way serialises to
 * `{}` and the assertion still passes. Read the row instead. See RFC 0023.
 */
export async function latestEventMetadata(
  workloadId: string,
): Promise<Record<string, unknown>> {
  const [row] = await getDB().query<{ metadata: string | null }>(
    `SELECT metadata FROM workload_events
     WHERE workload_id = ? AND metadata IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
    [workloadId],
  );
  if (!row?.metadata) {
    throw new Error(`No workload event with metadata for ${workloadId}`);
  }
  return JSON.parse(row.metadata);
}
