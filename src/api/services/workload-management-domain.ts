import { isHostedApiWorkload } from '../../shared/hosted-api.js';
import type {
  CostReportRequest,
  WorkloadActionResponse,
  WorkloadCostReport,
  WorkloadCostRequest,
  WorkloadCostRow,
  WorkloadListInput,
  WorkloadListResponse,
  WorkloadResubmitInput,
  WorkloadResubmitResponse,
  JobSubmissionObservationInput,
  JobSubmissionObservation,
  WorkloadSshAccessInput,
  WorkloadSshAccessResponse,
  WorkloadStatusInput,
  WorkloadStatusResponse,
  WorkloadTerminateInput,
  CheckpointHealth,
} from '../../shared/api-contract/workload-management-schemas.js';
import { DEFAULT_STATUS_EVENTS_LIMIT } from '../../shared/api-contract/workload-management-schemas.js';
import {
  clampListLimit,
  DEFAULT_LIST_LIMIT,
  MAX_COST_REPORT_PERIOD_DAYS,
  MAX_LIST_LIMIT,
  MIN_COST_REPORT_PERIOD_DAYS,
  normalizeCostReportSinceMs,
} from '../../shared/workload-list.js';
import {
  type WorkloadEvent,
  type WorkloadEventState,
  type StoredWorkload,
} from './workload-record.js';
import {
  WorkloadState,
  WorkloadType,
  isResubmittable,
  isTerminalState,
  isWorkloadHealthCheckableState,
  type ListStateClass,
  type WorkloadTypeValue,
} from '../../shared/workload.js';
import { ContainerState, WorkloadHealthStatus } from '../../shared/runtime.js';
import {
  CHECKPOINT_MOUNT_PATH,
  resolveCheckpointTarget,
} from '../../shared/checkpoint.js';
import { retryWindow } from './retry-backoff.js';
import { TimeoutError, withTimeout } from '../../shared/utils.js';
import type {
  OwnershipIdentity,
  OwnershipScope,
} from './repositories/ownership-filter.js';
import {
  latestEventMessage,
  type WorkloadEventMetadataInput,
} from './workload-event-metadata.js';
import type { ListedWorkload } from './repositories/workload-queries.js';
import type { WorkloadEventRow } from './repositories/workload-events.js';
import {
  normalizeAttribution,
  toStatusWorkloadMetadata,
} from './workload-operation-helpers.js';
import type { DbVM, User } from './entities.js';
import type { JobOperations, JobVmHealth } from './job/operations.js';
import {
  refuseNodePoolService,
  resolveSingleLiveVm,
} from './job/vm-host-operations.js';
import { toStatusVm } from './status-vm.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import {
  assertRequestActive,
  awaitWithSignal,
  type RequestBudget,
} from './request-budget.js';
import type { JobChanges } from './job-changes.js';
import { unclaimableWorkloadApiUrl } from './workload-api-url.js';

type ManagementErrorStatus = 400 | 404 | 409 | 503;

export class WorkloadManagementError extends Error {
  constructor(
    message: string,
    public readonly statusCode: ManagementErrorStatus,
    public readonly telemetryError: string = message,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'WorkloadManagementError';
  }
}

function workloadDetails(workload: StoredWorkload) {
  return {
    cloudProvider: workload.cloudProvider,
    region: workload.region,
    vmType: workload.vmType,
    gpuType: workload.gpuType,
  };
}

export interface WorkloadManagementDomain {
  costForWorkload(
    actor: User,
    input: WorkloadCostRequest,
    clientVersion: string,
    signal?: AbortSignal,
  ): Promise<WorkloadCostRow[]>;
  costWindow(
    actor: User,
    input: CostReportRequest,
    clientVersion: string,
    signal?: AbortSignal,
  ): Promise<WorkloadCostReport>;
  list(
    actor: User,
    input: WorkloadListInput,
    clientVersion: string,
    signal?: AbortSignal,
  ): Promise<WorkloadListResponse>;
  terminate(
    actor: User,
    input: WorkloadTerminateInput,
    clientVersion: string,
    signal?: AbortSignal,
  ): Promise<WorkloadActionResponse>;
  status(
    actor: User,
    input: WorkloadStatusInput,
    clientVersion: string,
    signal?: AbortSignal,
  ): Promise<WorkloadStatusResponse>;
  sshAccess(
    actor: User,
    input: WorkloadSshAccessInput,
    clientVersion: string,
    signal?: AbortSignal,
  ): Promise<WorkloadSshAccessResponse>;
  resubmit(
    actor: User,
    input: WorkloadResubmitInput,
    clientVersion: string,
    signal?: AbortSignal,
  ): Promise<WorkloadResubmitResponse>;
  observeSubmission(
    actor: User,
    input: JobSubmissionObservationInput,
    operation?: RequestBudget,
  ): Promise<JobSubmissionObservation>;
}

/** The termination and resubmission writes this domain commits. */
interface WorkloadManagementOutcomes {
  requestTermination(
    workloadId: string,
    scope: OwnershipScope,
    options?: { metadata?: WorkloadEventMetadataInput },
  ): Promise<{ previousState: WorkloadState } | null>;
  resubmitWorkloadForScope(
    workloadId: string,
    scope: OwnershipScope,
    callerSession?: string | null,
    options?: { claimDeadlineAt?: number | null },
  ): Promise<
    { submissionRevision: number; claimDeadlineAt: number | null } | false
  >;
}

/** Attribution filters shared by the cost and list reads. */
interface WorkloadAttributionFilter {
  session?: string | null;
  sessionExact?: boolean;
  agent?: string | null;
  user?: string;
}

/** The authorized cost reads the domain serves. */
interface WorkloadManagementSpend {
  listWorkloadCostsForId(
    scope: OwnershipScope,
    workloadId: string,
    filter: WorkloadAttributionFilter,
  ): Promise<WorkloadCostRow[]>;
  getCostReportInWindow(
    scope: OwnershipScope,
    windowStartMs: number,
    windowEndMs: number,
    filter: WorkloadAttributionFilter,
    viewer: OwnershipIdentity,
  ): Promise<WorkloadCostReport>;
}

/** The authorized list and status reads the domain serves. */
interface WorkloadManagementQueries {
  listWorkloads(
    scope: OwnershipScope,
    limit: number,
    filter: WorkloadAttributionFilter & {
      sinceMs?: number;
      stateClass?: ListStateClass;
      status?: WorkloadState;
      workloadType?: WorkloadTypeValue;
      deploymentId?: string;
      credentialId?: string;
      search?: string;
      limitExplicit?: boolean;
    },
    viewer: OwnershipIdentity,
  ): Promise<ListedWorkload[]>;
  getWorkloadForScope(
    workloadId: string,
    scope: OwnershipScope,
  ): Promise<StoredWorkload | null>;
  getWorkloadStatusForScope(
    workloadId: string,
    scope: OwnershipScope,
    eventsLimit: number | null,
  ): Promise<{
    workload: StoredWorkload;
    events: WorkloadEventRow[];
    eventsTotal: number;
    jobsAhead: number | null;
    retry: {
      retryCount: number;
      lastRetryAt: number;
      failedAtState: WorkloadEventState | null;
      regionDenied: 0 | 1;
      deniedRetryCount: number;
    } | null;
    /** The latest targeted-Job attempt number, from `workload_attempts`. */
    attempt: number | null;
  } | null>;
  listVms(
    workloadId: string,
    options?: { readPath?: boolean },
  ): Promise<DbVM[]>;
}

export interface WorkloadManagementDomainDependencies {
  jobChanges: JobChanges;
  store: WorkloadManagementQueries;
  spend: WorkloadManagementSpend;
  submissions: {
    observeTargetedJobSubmission(
      jobId: string,
      submissionRevision: number,
      signal?: AbortSignal,
    ): Promise<JobSubmissionObservation | null>;
  };
  outcomes: WorkloadManagementOutcomes;
  credentials: {
    getNamedCredential(name: string): Promise<{ id: string } | null>;
  };
  resolveScope(actor: User): Promise<OwnershipScope>;
  validateTargetDeployment(
    deploymentId: string,
    scope: OwnershipScope,
  ): Promise<void>;
  prepareCheckpoint(
    workload: StoredWorkload,
    operation: 'terminate',
  ): Promise<void>;
  preflightSecrets(
    secretNames: readonly string[] | null | undefined,
  ): Promise<void>;
  requestCleanup(workloadId: string): Promise<void>;
  getWorkloadOperations(workload: StoredWorkload): JobOperations;
  /**
   * Why a queued pool Job waits, given its latest event's message (the
   * claim's session-cap block); null for any other Job.
   */
  poolJobWait(
    workload: StoredWorkload,
    latestMessage: string | null,
  ): Promise<string | null>;
  /** Whether a pool Job's node pool gives it a managed checkpoint bucket. */
  poolJobSpot(workload: StoredWorkload): Promise<boolean>;
  /** The URL replicas claim Jobs through (`ANYCLOUD_API_URL`). */
  workloadApiUrl(): string;
  inspectContainerState(
    workload: StoredWorkload,
    vm: DbVM,
  ): Promise<ContainerState>;
  toWorkloadEvent(row: WorkloadEventRow): WorkloadEvent;
  recordEvent(
    actor: Pick<User, 'username'>,
    event: string,
    properties?: Record<string, unknown>,
  ): void;
  recordStatusEvent(actor: User, properties?: Record<string, unknown>): void;
  logDebug(message: string, metadata: Record<string, unknown>): void;
  logWarn(message: string, metadata: Record<string, unknown>): void;
  statusHealthCheckTimeoutMs: number;
  /** List a live Workload's checkpoint bucket; the domain caches the result. */
  readCheckpointHealth(workload: StoredWorkload): Promise<CheckpointHealth>;
  now(): number;
}

/** The newest event's message, as the claim records a cap block. */
function latestMessage(events: readonly WorkloadEventRow[]): string | null {
  const newest = events.reduce<WorkloadEventRow | undefined>(
    (latest, event) =>
      !latest || event.created_at >= latest.created_at ? event : latest,
    undefined,
  );
  return newest ? latestEventMessage(newest.metadata) : null;
}

const CHECKPOINT_HEALTH_TTL_MS = 60_000;

export function createWorkloadManagementDomain(
  dependencies: WorkloadManagementDomainDependencies,
): WorkloadManagementDomain {
  const checkpointHealthCache = new Map<
    string,
    { readAt: number; health: Promise<CheckpointHealth | undefined> }
  >();

  /**
   * One bounded bucket listing per Workload per minute, shared by concurrent
   * status reads; a failed or slow listing omits health until the next one.
   */
  function checkpointHealth(
    workload: StoredWorkload,
  ): Promise<CheckpointHealth | undefined> {
    const now = dependencies.now();
    for (const [id, entry] of checkpointHealthCache) {
      if (now - entry.readAt >= CHECKPOINT_HEALTH_TTL_MS) {
        checkpointHealthCache.delete(id);
      }
    }
    const cached = checkpointHealthCache.get(workload.id);
    if (cached) return cached.health;
    const health = withTimeout(
      dependencies.readCheckpointHealth(workload),
      dependencies.statusHealthCheckTimeoutMs,
      'Checkpoint health listing',
    ).catch((error: unknown) => {
      dependencies.logDebug('Checkpoint health listing failed', {
        id: workload.id,
        error,
      });
      return undefined;
    });
    checkpointHealthCache.set(workload.id, { readAt: now, health });
    return health;
  }

  async function cost(
    actor: User,
    input: WorkloadCostRequest,
    clientVersion: string,
    signal?: AbortSignal,
  ): Promise<WorkloadCostRow[]>;
  async function cost(
    actor: User,
    input: CostReportRequest,
    clientVersion: string,
    signal?: AbortSignal,
  ): Promise<WorkloadCostReport>;
  async function cost(
    actor: User,
    input: WorkloadCostRequest | CostReportRequest,
    clientVersion: string,
    signal?: AbortSignal,
  ): Promise<WorkloadCostRow[] | WorkloadCostReport> {
    const startedAt = dependencies.now();
    let failureMessage: string | undefined;
    let count: number | undefined;
    const mode = 'id' in input ? 'workload' : 'window';
    try {
      signal?.throwIfAborted();
      const spend = dependencies.spend;
      const scope = await dependencies.resolveScope(actor);
      const attribution = {
        session: normalizeAttribution(input.session),
        sessionExact: input.sessionExact === true,
        agent: normalizeAttribution(input.agent),
        user: input.user,
      };

      if ('id' in input) {
        const costs = await spend.listWorkloadCostsForId(
          scope,
          input.id,
          attribution,
        );
        count = costs.length;
        return costs;
      }

      const windowStartMs = normalizeCostReportSinceMs(
        input.sinceMs,
        startedAt,
      );
      if (windowStartMs === null) {
        throw new WorkloadManagementError(
          `Cost reporting period must be between ${MIN_COST_REPORT_PERIOD_DAYS} and ${MAX_COST_REPORT_PERIOD_DAYS} days`,
          400,
        );
      }
      const report = await spend.getCostReportInWindow(
        scope,
        windowStartMs,
        startedAt,
        attribution,
        actor,
      );
      count =
        report.totalJobs +
        report.totalServices +
        report.totalVms +
        report.workloadsWithoutPrice;
      return report;
    } catch (error) {
      failureMessage = errorMessage(error);
      throw error;
    } finally {
      dependencies.recordEvent(actor, 'cost', {
        version: clientVersion,
        durationMs: dependencies.now() - startedAt,
        mode,
        ...(failureMessage && { error: failureMessage }),
        ...(count !== undefined && { count }),
      });
    }
  }

  return {
    costForWorkload: cost,
    costWindow: cost,

    async observeSubmission(actor, input, operation) {
      const signal = operation?.signal;
      const cutoff = Math.min(
        (operation?.startedAt ?? performance.now()) + (input.waitMs ?? 0),
        operation?.deadlineAt ?? Infinity,
      );
      assertRequestActive(signal);
      const scope = await awaitWithSignal(
        dependencies.resolveScope(actor),
        signal,
      );
      const workload = await awaitWithSignal(
        dependencies.store.getWorkloadForScope(input.id, scope),
        signal,
      );
      if (!workload) {
        throw new WorkloadManagementError('Workload not found', 404);
      }
      if (!workload.deploymentId) {
        throw new WorkloadManagementError(
          'First-claim observation is only supported for Deployment Jobs',
          400,
        );
      }
      let claimDeadlineAt = workload.claimDeadlineAt;
      for (;;) {
        // This revision-fenced database write does not consume a provider
        // reconciliation slot. Expiry remains observable under provider load.
        assertRequestActive(signal);
        const deadlineAt = Math.min(
          cutoff,
          claimDeadlineAt == null
            ? Infinity
            : performance.now() +
                Math.max(0, claimDeadlineAt - dependencies.now()),
        );
        const subscription = dependencies.jobChanges.subscribe(
          input.id,
          signal,
          deadlineAt,
        );
        try {
          const observation = await awaitWithSignal(
            dependencies.submissions.observeTargetedJobSubmission(
              input.id,
              input.submissionRevision,
              signal,
            ),
            signal,
          );
          assertRequestActive(signal);
          if (!observation) {
            throw new WorkloadManagementError('Workload not found', 404);
          }
          if (observation.outcome !== 'pending' || performance.now() >= cutoff)
            return observation;
          if (observation.claimDeadlineAt !== claimDeadlineAt) {
            // Resubmission may have committed after the ownership lookup.
            // Re-arm before reading again so its deadline cannot be missed.
            claimDeadlineAt = observation.claimDeadlineAt;
            continue;
          }
          await subscription.promise;
        } finally {
          subscription.dispose();
        }
      }
    },

    async list(actor, input, clientVersion, signal) {
      const startedAt = dependencies.now();
      let failureMessage: string | undefined;
      let count: number | undefined;
      let limitValue: number | undefined;
      try {
        signal?.throwIfAborted();
        let status: WorkloadState | undefined;
        if (input.status !== undefined) {
          const requested = input.status.toLowerCase();
          status = Object.values(WorkloadState).find(
            (candidate) => candidate === requested,
          );
          if (!status) {
            throw new WorkloadManagementError(
              `Unknown status "${input.status}"`,
              400,
            );
          }
        }

        let credentialId: string | undefined;
        if (input.credentialName !== undefined) {
          const credentialName = input.credentialName.trim();
          if (!credentialName) {
            throw new WorkloadManagementError(
              '"credentialName" is required when provided',
              400,
            );
          }
          const credential =
            await dependencies.credentials.getNamedCredential(credentialName);
          if (!credential) {
            throw new WorkloadManagementError(
              `Credential "${credentialName}" not found`,
              400,
            );
          }
          credentialId = credential.id;
        }

        const limitExplicit = input.limit !== undefined;
        limitValue = clampListLimit(
          input.limit,
          input.stateClass ? MAX_LIST_LIMIT : DEFAULT_LIST_LIMIT,
        );
        const scope = await dependencies.resolveScope(actor);
        const workloads = await dependencies.store.listWorkloads(
          scope,
          limitValue,
          {
            session: normalizeAttribution(input.session),
            sessionExact: input.sessionExact === true,
            agent: normalizeAttribution(input.agent),
            sinceMs: input.sinceMs,
            stateClass: input.stateClass,
            status,
            workloadType: input.workloadType,
            deploymentId: input.deploymentId,
            credentialId,
            search:
              input.filter && input.filter.length > 0
                ? input.filter
                : undefined,
            user: input.user,
            limitExplicit,
          },
          actor,
        );
        count = workloads.length;
        signal?.throwIfAborted();
        return workloads.map((workload) => {
          const {
            currentExecutionId: _currentExecutionId,
            maxRetries: _maxRetries,
            noCheckpoint: _noCheckpoint,
            requireNestedVirtualization: _requireNestedVirtualization,
            hostDocker: _hostDocker,
            firstClaimedAt,
            ...publicWorkload
          } = workload;
          return {
            ...publicWorkload,
            claimed: firstClaimedAt !== null,
            // Retired: the submitted-with version is no longer stored
            // (RFC 0031); the wire field stays for older CLIs, always null.
            version: null,
            // The store receives the actor above, so this is always present.
            // Defaulting false is fail-visible if a future caller omits it.
            isOwnedByCaller: workload.isOwnedByCaller ?? false,
          };
        });
      } catch (error) {
        failureMessage = errorMessage(error);
        throw error;
      } finally {
        dependencies.recordEvent(actor, 'list', {
          version: clientVersion,
          durationMs: dependencies.now() - startedAt,
          ...(failureMessage && { error: failureMessage }),
          ...(count !== undefined && { count }),
          ...(limitValue !== undefined && { limit: limitValue }),
        });
      }
    },

    async terminate(actor, input, clientVersion, signal) {
      const startedAt = dependencies.now();
      let failureMessage: string | undefined;
      let workloadState: string | undefined;
      let workload: StoredWorkload | undefined;
      let wasTerminal: boolean | undefined;
      try {
        signal?.throwIfAborted();
        const store = dependencies.store;
        const scope = await dependencies.resolveScope(actor);
        const found = await store.getWorkloadForScope(input.id, scope);
        if (!found) {
          workloadState = 'not_found';
          return { message: 'Workload not found' };
        }
        workload = found;

        if (found.workloadType === WorkloadType.Service && found.vmCount > 0) {
          await dependencies.prepareCheckpoint(found, 'terminate');
        }
        const callerSession = normalizeAttribution(input.session);
        const termination = await dependencies.outcomes.requestTermination(
          input.id,
          scope,
          {
            metadata: {
              reason: 'terminated',
              ...(callerSession ? { callerSession } : {}),
            },
          },
        );
        if (!termination) {
          throw new Error(
            `Workload ${input.id} disappeared before termination was committed`,
          );
        }
        workloadState = termination.previousState;
        wasTerminal = isTerminalState(termination.previousState);

        try {
          await dependencies.requestCleanup(input.id);
        } catch (cleanupError) {
          dependencies.logWarn(
            'Failed to enqueue VM cleanup after terminate response',
            {
              id: input.id,
              error: cleanupError,
            },
          );
        }
        return {
          message:
            'Termination scheduled (resource cleanup will complete shortly)',
        };
      } catch (error) {
        failureMessage = errorMessage(error);
        throw error;
      } finally {
        dependencies.recordEvent(actor, 'terminate', {
          version: clientVersion,
          durationMs: dependencies.now() - startedAt,
          id: input.id,
          ...(failureMessage && { error: failureMessage }),
          ...(workloadState && { workloadState }),
          ...(wasTerminal !== undefined && { wasTerminal }),
          ...(workload && {
            ...workloadDetails(workload),
            ageSec: Math.round(
              (dependencies.now() - workload.startedAt) / 1000,
            ),
          }),
        });
      }
    },

    async status(actor, input, clientVersion, signal) {
      const startedAt = dependencies.now();
      let failureMessage: string | undefined;
      let workloadState: string | undefined;
      let resultStatus: WorkloadHealthStatus | undefined;
      let workload: StoredWorkload | undefined;
      let vmCount: number | undefined;
      let healthCheckSkipped: boolean | undefined;
      let healthCheckTimedOut: boolean | undefined;
      try {
        signal?.throwIfAborted();
        const store = dependencies.store;
        const scope = await dependencies.resolveScope(actor);
        const snapshot = await store.getWorkloadStatusForScope(
          input.id,
          scope,
          input.eventsLimit === 'all'
            ? null
            : (input.eventsLimit ?? DEFAULT_STATUS_EVENTS_LIMIT),
        );
        if (!snapshot) {
          workloadState = 'not_found';
          throw new WorkloadManagementError('Workload not found', 404);
        }
        const {
          workload: found,
          events,
          eventsTotal,
          jobsAhead,
          retry,
          attempt,
        } = snapshot;
        workload = found;
        workloadState = found.state;

        const allVms = await store.listVms(input.id, { readPath: true });
        const liveVms = allVms.filter((vm) => vm.endedAt == null);
        vmCount = liveVms.length;
        let status = WorkloadHealthStatus.Unknown;
        let healthChecks: JobVmHealth[] | undefined;
        const job = found.workloadType === WorkloadType.Job;
        const healthOperations =
          !found.deploymentId && (job || liveVms.length > 0)
            ? dependencies.getWorkloadOperations(found)
            : undefined;

        if (healthOperations) {
          const skipHealthCheck = !isWorkloadHealthCheckableState(found.state);
          healthCheckSkipped = skipHealthCheck;
          if (!skipHealthCheck) {
            try {
              const observation = await withTimeout(
                healthOperations.observeHealth({
                  workload: found,
                  allVms,
                  verbose: Boolean(input.verbose),
                }),
                input.verbose
                  ? 15_000
                  : dependencies.statusHealthCheckTimeoutMs,
                job ? 'Job health check' : 'VM health check',
              );
              status = observation.status;
              healthChecks = observation.vmHealth;
            } catch (error) {
              healthCheckTimedOut = error instanceof TimeoutError;
              dependencies.logDebug(
                error instanceof TimeoutError
                  ? 'Workload health check timeout'
                  : 'Workload health check failed',
                {
                  id: input.id,
                  error: error,
                },
              );
            }
          }
        }

        const exposeSsh = found.cloudProvider !== null;
        const vms = allVms.map((vm) =>
          toStatusVm(
            vm,
            healthChecks?.find((health) => health.ip === vm.ip),
            exposeSsh,
          ),
        );
        const window = retry
          ? retryWindow(
              retry.failedAtState,
              retry.retryCount - retry.deniedRetryCount,
              retry.regionDenied === 1,
            )
          : undefined;
        const checkpointTarget = resolveCheckpointTarget(
          found.id,
          found.deploymentId
            ? {
                checkpointBucket: found.checkpointBucket,
                spot: await dependencies.poolJobSpot(found),
              }
            : found,
        );
        const health =
          checkpointTarget && !isTerminalState(found.state)
            ? await checkpointHealth(found)
            : undefined;
        const waiting =
          found.deploymentId && found.state === WorkloadState.Queued
            ? await withTimeout(
                dependencies.poolJobWait(found, latestMessage(events)),
                dependencies.statusHealthCheckTimeoutMs,
                'Pool Job wait reason',
              ).catch(() => null)
            : null;
        resultStatus = status;
        signal?.throwIfAborted();
        return {
          workload: toStatusWorkloadMetadata(found),
          events: events.map(dependencies.toWorkloadEvent),
          eventsTotal,
          jobsAhead,
          status,
          vms,
          ...(attempt !== null && { attempt }),
          ...(waiting && { waiting }),
          ...(retry &&
            window && {
              retry: {
                attempt: Math.max(1, retry.retryCount),
                earliestAt: retry.lastRetryAt + window.minMs,
                latestAt: retry.lastRetryAt + window.maxMs,
              },
            }),
          ...(checkpointTarget && {
            checkpoint: {
              bucket: checkpointTarget.name,
              mount: CHECKPOINT_MOUNT_PATH,
              retained: !checkpointTarget.managed,
              ...(health && { health }),
            },
          }),
        };
      } catch (error) {
        failureMessage = errorMessage(error);
        throw error;
      } finally {
        dependencies.recordStatusEvent(actor, {
          version: clientVersion,
          durationMs: dependencies.now() - startedAt,
          id: input.id,
          ...(failureMessage && { error: failureMessage }),
          ...(workloadState && { workloadState }),
          ...(resultStatus && { status: resultStatus }),
          verbose: !!input.verbose,
          ...(vmCount !== undefined && { vmCount }),
          ...(healthCheckSkipped !== undefined && { healthCheckSkipped }),
          ...(healthCheckTimedOut !== undefined && { healthCheckTimedOut }),
          ...(workload && workloadDetails(workload)),
        });
      }
    },

    async sshAccess(actor, input, clientVersion, signal) {
      const startedAt = dependencies.now();
      let failureMessage: string | undefined;
      let workloadState: string | undefined;
      let workload: StoredWorkload | undefined;
      try {
        signal?.throwIfAborted();
        const store = dependencies.store;
        const scope = await dependencies.resolveScope(actor);
        const found = await store.getWorkloadForScope(input.id, scope);
        if (!found) {
          workloadState = 'not_found';
          throw new WorkloadManagementError('Workload not found', 404);
        }
        workload = found;
        workloadState = found.state;
        if (found.deploymentId) {
          throw new WorkloadManagementError(
            `SSH is unavailable for Deployment-targeted Job ${found.id}`,
            400,
            'Deployment-targeted Job SSH unsupported',
          );
        }
        const allVms = await store.listVms(input.id);

        if (
          found.workloadType === WorkloadType.Vm &&
          input.mode === 'snapshot'
        ) {
          throw new WorkloadManagementError(
            'VMs do not support snapshot SSH; use container or host access.',
            400,
            'VM snapshot access is unsupported',
          );
        }

        const vmTarget =
          refuseNodePoolService(found, 'ssh') ??
          resolveSingleLiveVm(allVms, 'ssh');
        if (!vmTarget.ok) {
          throw new WorkloadManagementError(
            vmTarget.clientError,
            vmTarget.status === 409 ? 409 : 400,
            vmTarget.telemetryError,
          );
        }
        const liveVm = vmTarget.vm;

        if (
          input.mode === 'container' &&
          found.workloadType === WorkloadType.Vm
        ) {
          let containerState: ContainerState;
          try {
            containerState = await dependencies.inspectContainerState(
              found,
              liveVm,
            );
          } catch (error) {
            throw new WorkloadManagementError(
              `Could not inspect the VM container. Use \`anycloud ssh ${found.id} --host\` to diagnose the VM: ${errorMessage(
                error,
              )}`,
              409,
              'VM container inspection failed',
              error,
            );
          }
          if (containerState === ContainerState.NotFound) {
            throw new WorkloadManagementError(
              `VM container "${found.id}" is missing. Repair is best-effort; use \`anycloud ssh ${found.id} --host\` to diagnose the VM.`,
              409,
              'VM container missing',
            );
          }
          if (containerState !== ContainerState.Running) {
            throw new WorkloadManagementError(
              `VM container "${found.id}" is ${containerState}. Use \`anycloud ssh ${found.id} --host\`, then run \`docker start ${found.id}\` if you want to restart it.`,
              409,
              `VM container ${containerState}`,
            );
          }
        }

        signal?.throwIfAborted();
        return {
          workloadId: found.id,
          vmIp: liveVm.ip,
          sshHost: liveVm.sshHost,
          sshPort: liveVm.sshPort,
          sshUsername: liveVm.sshUsername,
          sshPrivateKey: found.sshPrivateKey,
        };
      } catch (error) {
        failureMessage =
          error instanceof WorkloadManagementError
            ? error.telemetryError
            : errorMessage(error);
        throw error;
      } finally {
        dependencies.recordEvent(actor, 'ssh_access', {
          version: clientVersion,
          durationMs: dependencies.now() - startedAt,
          id: input.id,
          mode: input.mode,
          ...(failureMessage && { error: failureMessage }),
          ...(workloadState && { workloadState }),
          ...(workload && workloadDetails(workload)),
        });
      }
    },

    async resubmit(actor, input, clientVersion, signal) {
      const startedAt = dependencies.now();
      let failureMessage: string | undefined;
      let workloadState: string | undefined;
      let workload: StoredWorkload | undefined;
      try {
        signal?.throwIfAborted();
        const store = dependencies.store;
        const scope = await dependencies.resolveScope(actor);
        const found = await store.getWorkloadForScope(input.id, scope);
        if (!found) {
          workloadState = 'not_found';
          throw new WorkloadManagementError('Workload not found', 404);
        }
        workload = found;
        workloadState = found.state;

        if (isHostedApiWorkload(found)) {
          throw new WorkloadManagementError(
            'VM-hosted APIs are no longer supported. Use `anycloud cluster create` to host an API, then `anycloud api use` to select it.',
            400,
          );
        }
        if (found.workloadType === WorkloadType.Vm) {
          throw new WorkloadManagementError(
            'VM workloads cannot be resubmitted; create a replacement with `anycloud vm <image>`.',
            400,
            'VM workload is not resubmittable',
          );
        }
        if (found.deploymentId) {
          await dependencies.validateTargetDeployment(
            found.deploymentId,
            scope,
          );
        }
        if (input.timeout !== undefined && !found.deploymentId) {
          throw new WorkloadManagementError(
            'Submission timeout is only supported for Deployment Jobs',
            400,
          );
        }
        if (!isResubmittable(found.state)) {
          throw new WorkloadManagementError(
            `Workload is in state "${found.state}" — only failed, errored, invalid, or terminated workloads can be resubmitted`,
            400,
            'Not resubmittable',
          );
        }

        // A Job on a Deployment or node pool waits for a replica's claim.
        const unclaimable =
          found.deploymentId &&
          unclaimableWorkloadApiUrl(dependencies.workloadApiUrl());
        if (unclaimable) {
          throw new WorkloadManagementError(unclaimable, 400);
        }
        if (!found.deploymentId) {
          await dependencies.preflightSecrets(found.secretNames);
        }
        const claimDeadlineAt =
          input.timeout === undefined
            ? null
            : startedAt + Math.floor(input.timeout * 1000);
        if (
          claimDeadlineAt !== null &&
          !Number.isSafeInteger(claimDeadlineAt)
        ) {
          throw new WorkloadManagementError(
            'Submission timeout is too large',
            400,
          );
        }
        signal?.throwIfAborted();
        const resubmitted =
          await dependencies.outcomes.resubmitWorkloadForScope(
            input.id,
            scope,
            normalizeAttribution(input.session),
            { claimDeadlineAt },
          );
        if (!resubmitted) {
          if (found.deploymentId) {
            // Target deletion may have won after the optimistic validation.
            await dependencies.validateTargetDeployment(
              found.deploymentId,
              scope,
            );
          }
          const current = await store.getWorkloadForScope(input.id, scope);
          const stillReleasing =
            current !== null &&
            isResubmittable(current.state) &&
            (current.cleanedAt === null || current.vmCount > 0);
          const nodePoolBlocked =
            !stillReleasing &&
            current !== null &&
            isResubmittable(current.state) &&
            current.nodePoolId !== null;
          throw new WorkloadManagementError(
            stillReleasing
              ? `Workload ${input.id}'s resources are still being released — resubmit once cleanup finishes`
              : nodePoolBlocked
                ? `Node pool ${current.nodePoolName ?? current.nodePoolId} is not running and cannot accept Services; create a new Service on a running node pool`
                : `Workload is now in state "${current?.state ?? found.state}" and cannot be resubmitted`,
            400,
            'Not resubmittable',
          );
        }

        return {
          message: `Workload ${input.id} resubmitted`,
          ...(found.deploymentId
            ? {
                submissionRevision: resubmitted.submissionRevision,
                claimDeadlineAt: resubmitted.claimDeadlineAt,
              }
            : {}),
        };
      } catch (error) {
        failureMessage =
          error instanceof WorkloadManagementError
            ? error.telemetryError
            : errorMessage(error);
        throw error;
      } finally {
        dependencies.recordEvent(actor, 'resubmit', {
          version: clientVersion,
          durationMs: dependencies.now() - startedAt,
          id: input.id,
          ...(failureMessage && { error: failureMessage }),
          ...(workloadState && { workloadState }),
          ...(workload && workloadDetails(workload)),
        });
      }
    },
  };
}
