/** Complete state transitions, retry admission, recovery claims, and Service upgrades over the shared Workload database. */
import {
  WorkloadState,
  WorkloadType,
  VALID_TRANSITIONS,
  isTerminalState,
  type WorkloadTypeValue,
} from '../../../shared/workload.js';
import { CloudType } from '../../../shared/cloud.js';
import { normalizeBucketHostPaths } from '../../../shared/providers.js';
import { toArray } from '../../../shared/utils.js';
import { log, type ErrorMetadata } from '../logger.js';
import {
  eventMetadataColumn,
  GPU_RERUN_DIAGNOSIS,
  type WorkloadEventMetadataInput,
} from '../workload-event-metadata.js';
import {
  resolveGatewayVM,
  type AddVMAttempt,
  type GatewayVM,
} from '../entities.js';
import type { JobChanges } from '../job-changes.js';
import { encodeServiceContainerUpdate } from '../container-spec.js';
import { type DockerOptions } from '../../../shared/runtime.js';
import { computedWorkloadCloudProviderSql } from './credential-reference.js';
import { ownershipPredicate, type OwnershipScope } from './ownership-filter.js';
import type { DB, DBTransaction } from './db.js';
import {
  retryCandidatesQuery,
  type RetryCandidate,
} from './retry-candidates.js';

/**
 * A pool Job with checkpoint storage and no checkpoint bucket owns a managed
 * one (D-managed, `managesPoolCheckpoint`), so its ending leaves `cleaned_at`
 * NULL: cleanup deletes the bucket, then marks it cleaned. Every other pool
 * Job settles at once. Reads only the `workloads` row being updated, so a
 * deleted pool still leaves the bucket to cleanup.
 */
export const POOL_MANAGED_CHECKPOINT_SQL = `(workloads.deployment_id IS NOT NULL
  AND workloads.checkpoint_bucket IS NULL
  AND workloads.checkpoint_storage_credential_id IS NOT NULL)`;

interface WorkloadStateTransitionOptions {
  metadata?: WorkloadEventMetadataInput;
  workloadType?: WorkloadTypeValue;
  condition?: { sql: string; params: unknown[] };
  mutate?: (tx: DBTransaction, now: number) => void;
}

export function hasError(
  metadata: Record<string, unknown>,
): metadata is ErrorMetadata {
  return metadata.error !== undefined;
}

/** Collect observer wake-ups in the transaction and publish only after commit. */
export async function commitWorkloadChanges<T>(
  db: DB,
  jobChanges: JobChanges,
  write: (
    tx: DBTransaction,
    changed: JobChanges['notify'],
  ) => T extends PromiseLike<unknown> ? never : T,
): Promise<T> {
  const ids = new Set<string>();
  const deploymentIds = new Set<string>();
  const result = await db.transaction<T>((tx) => {
    const result = write(tx, (jobId) => {
      ids.add(jobId);
    });
    const changedIds = [...ids];
    // Capture Deployment routing with the mutation, before its transaction
    // closes. Notifications are process-local and run only after commit.
    for (let offset = 0; offset < changedIds.length; offset += 256) {
      const batch = changedIds.slice(offset, offset + 256);
      const targets = tx.query<{ deploymentId: string }>(
        `SELECT DISTINCT deployment_id AS deploymentId FROM workloads
         WHERE id IN (${batch.map(() => '?').join(', ')}) AND deployment_id IS NOT NULL`,
        batch,
      );
      for (const target of targets) deploymentIds.add(target.deploymentId);
    }
    return result;
  });
  for (const jobId of ids) jobChanges.notify(jobId);
  // One waiter per change; each that finds a Job wakes more.
  for (const deploymentId of deploymentIds)
    jobChanges.notifyDeployment(deploymentId, { waiters: 1 });
  return result;
}

/** State CAS, optional related mutation, and event are one durable operation. */
function transitionWorkloadStateInTransaction(
  tx: DBTransaction,
  workloadId: string,
  state: WorkloadState,
  allowedFrom: WorkloadState[],
  options?: WorkloadStateTransitionOptions,
): number | null {
  if (isTerminalState(state)) {
    throw new Error(
      `Workload ${workloadId}: terminal state ${state} must use publishTerminalOutcome`,
    );
  }
  const now = Date.now();
  const { metadata, workloadType } = options ?? {};
  const metadataWithId = { id: workloadId, state, ...metadata };
  if (hasError(metadataWithId)) {
    log.error(`State transition: ${state}`, metadataWithId);
  } else {
    log.info(`State transition: ${state}`, metadataWithId);
  }

  const placeholders = allowedFrom.map(() => '?').join(', ');
  const workloadTypeClause = workloadType ? ' AND workload_type = ?' : '';
  const conditionClause = options?.condition
    ? ` AND (${options.condition.sql})`
    : '';
  const sql = `UPDATE workloads SET state = ? WHERE id = ? AND state IN (${placeholders})${workloadTypeClause}${conditionClause}`;
  const params = [
    state,
    workloadId,
    ...allowedFrom,
    ...(workloadType ? [workloadType] : []),
    ...(options?.condition?.params ?? []),
  ];
  const result = tx.query<{ rowsAffected: number }>(sql, params);
  if (!result[0]?.rowsAffected) {
    log.warn('State transition blocked by FSM', {
      id: workloadId,
      to: state,
      allowedFrom,
    });
    return null;
  }

  options?.mutate?.(tx, now);
  const inserted = tx.query<{ id: number }>(
    `INSERT INTO workload_events (workload_id, state, metadata, created_at)
       VALUES (?, ?, ?, ?)
       RETURNING id`,
    [workloadId, state, eventMetadataColumn(metadata), now],
  );
  const eventId = inserted[0]?.id;
  if (typeof eventId !== 'number') {
    throw new Error(
      `Workload ${workloadId}: state claim event was not created`,
    );
  }
  return eventId;
}

function transitionWorkloadState(
  db: DB,
  jobChanges: JobChanges,
  workloadId: string,
  state: WorkloadState,
  allowedFrom: WorkloadState[],
  options?: WorkloadStateTransitionOptions,
): Promise<number | null> {
  return commitWorkloadChanges(db, jobChanges, (tx, changed) => {
    const eventId = transitionWorkloadStateInTransaction(
      tx,
      workloadId,
      state,
      allowedFrom,
      options,
    );
    if (eventId !== null) changed(workloadId);
    return eventId;
  });
}

export type RetryVMEligibility =
  | 'ready'
  | 'reuse'
  | 'release-pending'
  | 'stale';

export type RetryAdmissionResult = 'queued' | 'release-pending' | 'stale';

interface RetryWorkloadFacts {
  state: WorkloadState;
  deploymentId: string | null;
  cloudProvider: CloudType | null;
  revision: number | null;
  diagnosis: string | null;
}

interface RetryVMAttempt {
  ip: string | null;
  removal_requested_at: number | null;
}

/** A requested removal remains mandatory even after another attempt retires. */
function retryVMEligibility(
  workload: RetryWorkloadFacts,
  retry: RetryCandidate,
  attempts: readonly RetryVMAttempt[],
): Exclude<RetryVMEligibility, 'stale'> {
  if (attempts.length === 0) return 'ready';
  const reusableFailure =
    retry.failedAtState === WorkloadState.Downloading ||
    retry.failedAtState === WorkloadState.Syncing ||
    retry.failedAtState === WorkloadState.Starting ||
    workload.diagnosis === GPU_RERUN_DIAGNOSIS;
  if (
    attempts.length === 1 &&
    workload.state === WorkloadState.Retrying &&
    workload.deploymentId === null &&
    workload.cloudProvider !== null &&
    reusableFailure &&
    attempts.every(
      (attempt) => attempt.ip !== null && attempt.removal_requested_at === null,
    )
  ) {
    return 'reuse';
  }
  return 'release-pending';
}

export interface BeginServiceUpgradeInput {
  id: string;
  /** Which rows this caller may write — the API's on a hosted API, else theirs. */
  scope: OwnershipScope;
  image: string;
  previousImage: string;
  dockerCommand: string;
  command: string[] | null;
  env: Record<string, string> | null;
  dockerOptions?: DockerOptions | null;
  imageDigest?: string | null;
  githubToken?: string | null;
}

export class WorkloadLifecycleStore {
  constructor(
    private readonly db: DB,
    private readonly jobChanges: JobChanges,
  ) {}

  /**
   * Claim only the state the caller observed. Unlike the generic FSM source
   * set, this is a single-source CAS, so termination or an advancing deploy
   * step wins cleanly. A preemption caller also binds the exact live VM row.
   */
  async claimRecovery(
    workloadId: string,
    expectedState: WorkloadState,
    options?: {
      metadata?: WorkloadEventMetadataInput;
      vm?: {
        cloudId: string;
        ip: string;
        markPreempted?: boolean;
      };
    },
  ): Promise<boolean> {
    if (!VALID_TRANSITIONS[WorkloadState.Recovering].includes(expectedState)) {
      return false;
    }
    const eventId = await transitionWorkloadState(
      this.db,
      this.jobChanges,
      workloadId,
      WorkloadState.Recovering,
      [expectedState],
      {
        metadata: options?.metadata,
        condition: options?.vm
          ? {
              sql: `EXISTS (
                SELECT 1 FROM vms
                WHERE workload_id = ?
                  AND cloud_id = ?
                  AND ip = ?
                  AND ended_at IS NULL
                  AND COALESCE(preempt, 0) <> 1
              )`,
              params: [workloadId, options.vm.cloudId, options.vm.ip],
            }
          : undefined,
        mutate:
          options?.vm?.markPreempted === true
            ? (tx) => {
                tx.query(
                  `UPDATE vms SET preempt = 1
                   WHERE workload_id = ?
                     AND cloud_id = ?
                     AND ip = ?
                     AND ended_at IS NULL`,
                  [workloadId, options.vm!.cloudId, options.vm!.ip],
                );
              }
            : undefined,
      },
    );
    return eventId !== null;
  }

  /**
   * Atomically track an in-place VM restart and exit Recovering.
   * This deliberately bypasses the generic FSM with an exact Recovering CAS;
   * globally allowing these transitions would let a stale deploy coroutine
   * overwrite recovery after a preemption.
   */
  async finishPreemptionRecovery(
    workloadId: string,
    workloadType: WorkloadTypeValue,
    previousCloudId: string,
    vm: GatewayVM,
    attempt: AddVMAttempt = {},
  ): Promise<boolean> {
    const state =
      workloadType === WorkloadType.Job
        ? WorkloadState.Starting
        : WorkloadState.Running;
    const eventId = await transitionWorkloadState(
      this.db,
      this.jobChanges,
      workloadId,
      state,
      [WorkloadState.Recovering],
      {
        workloadType,
        metadata: { reason: 'in-place VM restart succeeded' },
        condition: {
          sql: `EXISTS (
            SELECT 1 FROM vms
            WHERE workload_id = ?
              AND cloud_id = ?
              AND ended_at IS NULL
              AND preempt = 1
          )`,
          params: [workloadId, previousCloudId],
        },
        mutate: (tx, now) => {
          replacePreemptedVMRow(
            tx,
            now,
            workloadId,
            previousCloudId,
            vm,
            attempt,
          );
          const resolved = tx.query<{ rowsAffected: number }>(
            `UPDATE workload_events
             SET metadata = json_set(
               CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
               '$.inPlaceRestartSucceeded',
               1
             )
             WHERE id = (
               SELECT id FROM workload_events
               WHERE workload_id = ? AND state = ?
               ORDER BY id DESC
               LIMIT 1
             )`,
            [workloadId, WorkloadState.Recovering],
          );
          if (!resolved[0]?.rowsAffected) {
            throw new Error(
              `Workload ${workloadId}: recovery claim event is missing`,
            );
          }
        },
      },
    );
    return eventId !== null;
  }

  /**
   * Track a cloud-stopped VM's in-place restart while the workload keeps its
   * state: a Running persistent VM, or a Finalizing Job whose final sync needs
   * the restarted disk. The stopped row must still be live at `previous.ip`.
   */
  async restartVMInPlace(
    workloadId: string,
    state: WorkloadState.Running | WorkloadState.Finalizing,
    previous: { cloudId: string; ip: string },
    { vm, attempt }: { vm: GatewayVM; attempt: AddVMAttempt },
    reason: string,
  ): Promise<boolean> {
    const eventId = await transitionWorkloadState(
      this.db,
      this.jobChanges,
      workloadId,
      state,
      [state],
      {
        metadata: { reason },
        condition: {
          sql: `EXISTS (SELECT 1 FROM vms WHERE workload_id = ? AND cloud_id = ? AND ip = ? AND ended_at IS NULL)`,
          params: [workloadId, previous.cloudId, previous.ip],
        },
        mutate: (tx, now) => {
          tx.query(
            `UPDATE vms SET preempt = 1
             WHERE workload_id = ? AND cloud_id = ? AND ended_at IS NULL`,
            [workloadId, previous.cloudId],
          );
          replacePreemptedVMRow(
            tx,
            now,
            workloadId,
            previous.cloudId,
            vm,
            attempt,
          );
        },
      },
    );
    return eventId !== null;
  }

  /**
   * Update workload state and log event.
   *
   * Queued and terminal targets throw and require their owned admission/outcome
   * methods. For other targets, the UPDATE succeeds only from a state allowed
   * by VALID_TRANSITIONS or from the target itself for idempotent re-entry.
   * Returns `false` (and skips the event INSERT) when the FSM blocks the write.
   * The state CAS and its event insert commit in one SQLite transaction.
   */
  async updateState(
    workloadId: string,
    state: WorkloadState,
    options?: { metadata?: WorkloadEventMetadataInput },
  ): Promise<boolean> {
    if (state === WorkloadState.Queued) {
      throw new Error(
        `Workload ${workloadId}: queued state must use an owned queue operation`,
      );
    }
    // FSM enforcement: only allow transitions defined in VALID_TRANSITIONS,
    // plus self-transitions (idempotent re-entry into current state).
    const eventId = await transitionWorkloadState(
      this.db,
      this.jobChanges,
      workloadId,
      state,
      [...VALID_TRANSITIONS[state], state],
      options,
    );
    return eventId !== null;
  }

  private readRetryVMEligibility(
    tx: DBTransaction,
    workloadId: string,
    expectedRevision: number,
  ): RetryVMEligibility {
    const [workload] = tx.query<RetryWorkloadFacts>(
      `SELECT d.state,
              d.deployment_id AS deploymentId,
              ${computedWorkloadCloudProviderSql('d')} AS cloudProvider,
              (SELECT id FROM workload_events
               WHERE workload_id = d.id
               ORDER BY id DESC LIMIT 1) AS revision,
              (SELECT CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.diagnosis') END
               FROM workload_events WHERE workload_id = d.id ORDER BY id DESC LIMIT 1) AS diagnosis
       FROM workloads d
       WHERE d.id = ?`,
      [workloadId],
    );
    if (
      !workload ||
      (workload.state !== WorkloadState.Retrying &&
        workload.state !== WorkloadState.Recovering) ||
      workload.revision !== expectedRevision
    ) {
      return 'stale';
    }

    const { sql, params } = retryCandidatesQuery([workloadId]);
    const [retry] = tx.query<RetryCandidate>(sql, params);
    if (!retry) return 'stale';
    const attempts = tx.query<RetryVMAttempt>(
      `SELECT ip, removal_requested_at FROM vms
       WHERE workload_id = ? AND ended_at IS NULL`,
      [workloadId],
    );
    return retryVMEligibility(workload, retry, attempts);
  }

  /** Read the same durable VM eligibility facts used by retry admission. */
  async getRetryVMEligibility(
    workloadId: string,
    expectedRevision: number,
  ): Promise<RetryVMEligibility> {
    return this.db.transaction((tx) =>
      this.readRetryVMEligibility(tx, workloadId, expectedRevision),
    );
  }

  /**
   * Admit the exact retry revision only when its VM ledger permits release or
   * supported reuse. The ledger read, revision CAS, and queue event share one
   * transaction, so controller observations cannot authorize stale resources.
   */
  async queueRetryCandidate(
    workloadId: string,
    expectedRevision: number,
  ): Promise<RetryAdmissionResult> {
    return commitWorkloadChanges(this.db, this.jobChanges, (tx, changed) => {
      const eligibility = this.readRetryVMEligibility(
        tx,
        workloadId,
        expectedRevision,
      );
      if (eligibility === 'stale' || eligibility === 'release-pending') {
        return eligibility;
      }
      const eventId = transitionWorkloadStateInTransaction(
        tx,
        workloadId,
        WorkloadState.Queued,
        [WorkloadState.Retrying, WorkloadState.Recovering],
        {
          condition: {
            sql: `(SELECT id
                   FROM workload_events
                   WHERE workload_id = workloads.id
                   ORDER BY id DESC
                   LIMIT 1) = ?`,
            params: [expectedRevision],
          },
          // A targeted Job's `--timeout` bounds each wait for a replica:
          // a retry waits as long as its last queueing allowed.
          mutate: (tx, now) =>
            tx.query(
              `UPDATE workloads SET first_claimed_at = NULL,
                 claim_deadline_at = ? + claim_deadline_at - COALESCE((SELECT MAX(created_at)
                   FROM workload_events WHERE workload_id = workloads.id AND state = ?
                     AND created_at >= workloads.started_at), started_at)
               WHERE id = ? AND deployment_id IS NOT NULL AND claim_deadline_at IS NOT NULL`,
              [now, WorkloadState.Queued, workloadId],
            ),
        },
      );
      if (eventId !== null) changed(workloadId);
      return eventId !== null ? 'queued' : 'stale';
    });
  }

  /**
   * Return an admitted Provisioning row to the scheduler when no provider work
   * could have started. This intentionally bypasses the generic FSM with a
   * single-source, fact-guarded transition: an active attempt or a concurrent
   * state change makes the repair a no-op.
   */
  async releaseEmptyProvisioningAdmission(
    workloadId: string,
  ): Promise<boolean> {
    const eventId = await transitionWorkloadState(
      this.db,
      this.jobChanges,
      workloadId,
      WorkloadState.Queued,
      [WorkloadState.Provisioning],
      {
        metadata: { reason: 'empty-provisioning-admission-released' },
        condition: {
          sql: `NOT EXISTS (
                  SELECT 1
                  FROM vms
                  WHERE workload_id = workloads.id
                    AND ended_at IS NULL
                )`,
          params: [],
        },
      },
    );
    return eventId !== null;
  }

  /** Record a step transition and return its event row for telemetry. */
  async claimStep(
    workloadId: string,
    state: WorkloadState,
    options?: { metadata?: WorkloadEventMetadataInput },
  ): Promise<number | null> {
    if (state === WorkloadState.Queued) {
      throw new Error(
        `Workload ${workloadId}: queued state must use an owned queue operation`,
      );
    }
    return transitionWorkloadState(
      this.db,
      this.jobChanges,
      workloadId,
      state,
      [...VALID_TRANSITIONS[state], state],
      options,
    );
  }

  /**
   * Retry-candidate fields (retryCount, lastRetryAt, failedAtState, resubmitCount)
   * for a bounded set of workload ids. The in-memory reconciler uses this to
   * reconstruct retry timing only for new or changed Retrying/Recovering rows,
   * not as a full event-history scan on every discovery.
   */
  async getRetryCandidatesByIds(ids: string[]): Promise<RetryCandidate[]> {
    if (ids.length === 0) return [];
    const { sql, params } = retryCandidatesQuery(ids);
    return this.db.query<RetryCandidate>(sql, params);
  }

  /**
   * Begin a URL-preserving service upgrade.
   *
   * This deliberately reuses the existing workload row and transitions a
   * running Service into Recovering. The recovery reconciler owns VM teardown and
   * then queues normal provisioning, which avoids doing slow cloud cleanup in
   * the HTTP request while ensuring a ghost live VM is not reused.
   */
  async beginServiceUpgrade(input: BeginServiceUpgradeInput): Promise<boolean> {
    const now = Date.now();
    const spec = await encodeServiceContainerUpdate(
      {
        image: input.image,
        imageDigest: input.imageDigest ?? null,
        command: input.command,
        env: input.env,
        dockerOptions: input.dockerOptions,
        registryToken: input.githubToken ?? null,
      },
      `Workload ${input.id}`,
    );
    const upgradeMetadata = {
      reason: 'serve-upgrade',
      previousImage: input.previousImage,
      image: input.image,
    };
    // Re-checked here so the row cannot change hands between the route's
    // lookup and this write; authorization itself already happened there.
    const owner = ownershipPredicate(input.scope);

    const upgraded = await this.db.transaction((tx) => {
      const result = tx.query<{ rowsAffected: number }>(
        `UPDATE workloads
       SET docker_command = ?,
           state = ?,
           started_at = ?,
           completed_at = NULL,
           cleaned_at = NULL
       WHERE id = ?
         AND ${owner.sql}
         AND workload_type = ?
         AND state = ?`,
        [
          input.dockerCommand,
          WorkloadState.Recovering,
          now,
          input.id,
          ...owner.params,
          WorkloadType.Service,
          WorkloadState.Running,
        ],
      );

      if (result[0]?.rowsAffected !== 1) return false;
      const updated = tx.query<{ rowsAffected: number }>(
        `UPDATE container_specs
         SET image = ?, image_digest = ?, command = ?, env = ?, registry_token = ?${spec.docker_options === undefined ? '' : ', docker_options = ?'}
         WHERE workload_id = ?`,
        [
          spec.image,
          spec.image_digest,
          spec.command,
          spec.env,
          spec.registry_token,
          ...(spec.docker_options === undefined ? [] : [spec.docker_options]),
          input.id,
        ],
      );
      if (updated[0]?.rowsAffected !== 1) {
        throw new Error(
          `Workload ${input.id}: container spec ownership is incomplete`,
        );
      }
      tx.query(
        `INSERT INTO workload_events (workload_id, state, metadata, created_at)
       VALUES (?, ?, ?, ?)`,
        [
          input.id,
          WorkloadState.Recovering,
          eventMetadataColumn(upgradeMetadata),
          now,
        ],
      );
      return true;
    });
    if (upgraded)
      log.info('Service upgrade queued', {
        id: input.id,
        previousImage: input.previousImage,
        image: input.image,
      });
    return upgraded;
  }
}

/**
 * End a preempted VM's live row and track its in-place restart as a new row,
 * carrying the bucket host paths forward.
 */
function replacePreemptedVMRow(
  tx: DBTransaction,
  now: number,
  workloadId: string,
  previousCloudId: string,
  vm: GatewayVM,
  attempt: AddVMAttempt,
): void {
  const { sshHost, sshPort, sshUsername } = resolveGatewayVM(vm);
  const previousRows = tx.query<{
    input_host_path: string | null;
    output_host_path: string | null;
    checkpoint_host_path: string | null;
  }>(
    `SELECT input_host_path, output_host_path, checkpoint_host_path
       FROM vms
       WHERE workload_id = ?
         AND cloud_id = ?
         AND ended_at IS NULL
         AND preempt = 1`,
    [workloadId, previousCloudId],
  );
  const bucketHostPaths =
    attempt.bucketHostPaths ??
    normalizeBucketHostPaths({
      input: previousRows[0]?.input_host_path ?? undefined,
      output: previousRows[0]?.output_host_path ?? undefined,
      checkpoint: previousRows[0]?.checkpoint_host_path ?? undefined,
    });
  const ended = tx.query<{ rowsAffected: number }>(
    `UPDATE vms SET ended_at = ?
       WHERE workload_id = ?
         AND cloud_id = ?
         AND ended_at IS NULL
         AND preempt = 1`,
    [now, workloadId, previousCloudId],
  );
  if (!ended[0]?.rowsAffected) {
    throw new Error(`Workload ${workloadId}: preempted VM row is missing`);
  }
  tx.query(
    `INSERT INTO vms (
         workload_id, ip, cloud_id, private_ip, base_image_id,
         availability_zone, created_at, region, credential_id,
         price_per_hour, ssh_host, ssh_port, ssh_username, vm_type,
         input_host_path, output_host_path, checkpoint_host_path
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      workloadId,
      vm.ip,
      vm.cloudId,
      vm.privateIp ?? null,
      vm.baseImageId ?? null,
      vm.availabilityZone ?? attempt.availabilityZone ?? null,
      now,
      attempt.region ?? null,
      attempt.credentialId ?? null,
      attempt.pricePerHour ?? null,
      sshHost,
      sshPort,
      sshUsername,
      toArray(attempt.vmType)[0] ?? null,
      bucketHostPaths.input,
      bucketHostPaths.output,
      bucketHostPaths.checkpoint,
    ],
  );
}
