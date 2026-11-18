import type { V1Pod } from '@kubernetes/client-node';
import { LIVE_EXECUTION_STATES, WorkloadState } from '../../shared/workload.js';
import {
  ApiVersionMismatchError,
  BucketNameTakenError,
} from '../../shared/errors.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import type {
  WorkloadCandidateResponse,
  WorkloadClaimJobBody,
  WorkloadExecution,
  WorkloadOutcome,
  WorkloadRunnerReport,
} from '../../shared/api-contract/deployment-workload-schemas.js';
import { clientWindowVersionCheck } from './api-version.js';
import {
  attemptEndOf,
  batchPolicy,
  UNUSABLE_GPU_POOL_RERUN,
  UNUSABLE_GPU_POOL_RETRY,
  type Cause,
} from './job-outcome.js';
import {
  assertRequestActive,
  awaitWithSignal,
  type RequestBudget,
} from './request-budget.js';
import { bearerTokenFromAuthorization } from './api-authentication.js';
import {
  deploymentTarget,
  type DeploymentRepository,
} from './deployment-store.js';
import type { claimSpendBlock } from './spend-controls.js';
import type {
  DeploymentExecutionStore,
  TargetedDeploymentRuntime,
  TargetedExecutionIdentity,
  TargetedJobCandidate,
  TargetedJobClaimResult,
} from './repositories/deployment-executions.js';
import type { AttemptEnd } from './repositories/workload-attempts.js';
import type { DeploymentRuntimeResolver } from './kubernetes/deployment-runtime.js';
import {
  ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE,
  KUBERNETES_DEPLOYMENT_CONTAINER,
} from './kubernetes/pool-objects.js';
import {
  KUBERNETES_GENERATION_ANNOTATION,
  isKubernetesWorkloadPod,
  kubernetesWorkloadResourceName,
} from './kubernetes/identity.js';
import { kubernetesRequestOptions } from './kubernetes/request-options.js';
import { reviewServiceAccountToken } from './kubernetes/token-review.js';
import {
  isKubernetesConflictError,
  isKubernetesNotFoundError,
} from './kubernetes/managed-resources.js';
import { captureTail, type CapturedTail } from './kubernetes/pod-logs.js';
import { podImagePull } from './kubernetes/pod-image-pull.js';
import type { ClusterKubernetesClient } from './kubernetes/cluster-client.js';
import type { JobChanges } from './job-changes.js';
import { DeploymentWorkloadError } from './deployment-errors.js';
import {
  looksLikeGpuNumericFault,
  looksLikeMissingGPU,
  UNUSABLE_GPU_HINT,
  UNUSABLE_GPU_POOL_RETRY_CAP,
} from './workload-workflows/missing-gpu.js';
import { checkNodeGpus } from './kubernetes/node-gpu-check.js';
import { requestedNvidiaGpus } from './kubernetes/node-pool-scheduling.js';
import { markNodePoolNodeGpuUnusable } from './kubernetes/node-pool-nodes.js';

interface DeploymentRuntimeIdentity {
  ready: boolean;
  generation: number;
  podUid: string;
  containerId: string;
}

interface AuthenticatedDeploymentRuntime {
  identity: DeploymentRuntimeIdentity;
  managed: boolean;
  /** The bound Pod, whose log a runner's report keeps (RFC 0044 § Logs). */
  pod: V1Pod;
  cluster: ClusterKubernetesClient;
}

export interface DeploymentWorkloadDomain {
  candidate(
    targetId: string,
    waitMs: number,
    authorization: string | undefined,
    operation?: RequestBudget,
    release?: string,
  ): Promise<WorkloadCandidateResponse>;
  claim(
    targetId: string,
    jobId: string,
    executionId: string,
    candidate: WorkloadClaimJobBody,
    authorization: string | undefined,
    operation?: RequestBudget,
    release?: string,
  ): Promise<{ jobId: string; executionId: string }>;
  cancellation(
    targetId: string,
    jobId: string,
    executionId: string,
    authorization: string | undefined,
    waitMs?: number,
    operation?: RequestBudget,
    release?: string,
  ): Promise<{ cancelled: boolean }>;
  outcome(
    targetId: string,
    jobId: string,
    outcome: WorkloadOutcome,
    authorization: string | undefined,
    release?: string,
  ): Promise<void>;
  cleanup(
    targetId: string,
    jobId: string,
    executionId: string,
    authorization: string | undefined,
    release?: string,
  ): Promise<void>;
  /** A runner's claimed Job: what to start, and renewed storage access. */
  execution(
    targetId: string,
    jobId: string,
    executionId: string,
    authorization: string | undefined,
    release: string | undefined,
  ): Promise<WorkloadExecution>;
  /** A runner's phase, or why its attempt ended. */
  report(
    targetId: string,
    jobId: string,
    report: WorkloadRunnerReport,
    authorization: string | undefined,
    release: string | undefined,
  ): Promise<void>;
}

/** The Deployment execution operations the in-Pod API serves. */
interface DeploymentWorkloadJobs {
  discoverTargetedJob: DeploymentExecutionStore['discoverTargetedJob'];
  claimTargetedJob(
    input: TargetedDeploymentRuntime &
      TargetedJobCandidate & { executionId: string },
  ): Promise<TargetedJobClaimResult>;
  podHasClaimed(podUid: string): Promise<boolean>;
  listTargetedExecutions(
    deploymentId: string,
  ): Promise<TargetedExecutionIdentity[]>;
  getTargetedExecution(
    jobId: string,
  ): Promise<TargetedExecutionIdentity | null>;
  reportTargetedJobExecution(
    jobId: string,
    executionId: string,
    end: AttemptEnd,
  ): Promise<boolean>;
  completeTargetedJobCleanup(
    jobId: string,
    executionId: string,
  ): Promise<boolean>;
  reportTargetedJobPhase(
    jobId: string,
    executionId: string,
    phase: WorkloadState.Running | WorkloadState.Finalizing,
  ): Promise<boolean>;
  getTargetedJobSpec(
    jobId: string,
  ): Promise<{ command: string[]; env: Record<string, string> }>;
  recordAttemptLogTail(executionId: string, tail: CapturedTail): Promise<void>;
  closeReplica(podUid: string): void;
}

export function createDeploymentWorkloadDomain(input: {
  jobChanges: JobChanges;
  deployments: Pick<DeploymentRepository, 'getMetadataById'>;
  jobs: DeploymentWorkloadJobs;
  runtimes: Pick<DeploymentRuntimeResolver, 'resolve'>;
  claimSpendBlock: typeof claimSpendBlock;
  /** A pool Job's storage credentials, freshly minted (RFC 0043). */
  mintStorage(jobId: string): Promise<WorkloadExecution['storage']>;
  /** Queues the Deployment's reconcile: a released slot may unblock a drain. */
  reconcile(deploymentId: string): void;
  maxOutstandingAcquisitionDependencies?: number;
}): DeploymentWorkloadDomain {
  let outstandingAcquisitionDependencies = 0;

  function acquireDependency<T>(
    start: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    assertRequestActive(signal);
    if (
      outstandingAcquisitionDependencies >=
      (input.maxOutstandingAcquisitionDependencies ?? 256)
    ) {
      throw new DeploymentWorkloadError(
        'Deployment pickup dependencies are busy; retry this request',
        503,
      );
    }
    outstandingAcquisitionDependencies++;
    // Cancellation ends the caller's wait, but the underlying dependency owns
    // its slot until settlement. Idle receiver subscriptions hold no slot.
    const work = Promise.resolve()
      .then(() => {
        assertRequestActive(signal);
        return start();
      })
      .finally(() => {
        outstandingAcquisitionDependencies--;
      });
    return awaitWithSignal(work, signal);
  }

  async function authenticate(
    targetId: string,
    authorization: string | undefined,
    options: {
      signal?: AbortSignal;
      acquisition?: boolean;
      release?: string;
    } = {},
  ): Promise<AuthenticatedDeploymentRuntime> {
    const { signal } = options;
    assertRequestActive(signal);
    const dependency = <T>(start: () => Promise<T>): Promise<T> =>
      options.acquisition
        ? acquireDependency(start, signal)
        : awaitWithSignal(start(), signal);
    const token = bearerTokenFromAuthorization(authorization);
    if (!token) {
      throw new DeploymentWorkloadError('Missing workload token', 401);
    }
    const deployment = await dependency(() =>
      input.deployments.getMetadataById(targetId),
    );
    if (!deployment || deployment.deletedAt !== null) {
      throw new DeploymentWorkloadError('Deployment not found', 404);
    }
    // A managed Deployment's runner is this release's or the previous one's
    // (RFC 0049 C27), whose wire the replica snapshot freezes; SDK replicas
    // keep an earlier exemption.
    if (deployment.managed) {
      try {
        clientWindowVersionCheck(options.release);
      } catch (error) {
        if (!(error instanceof ApiVersionMismatchError)) throw error;
        throw new DeploymentWorkloadError(
          error.message,
          400,
          'CLIENT_VERSION_MISMATCH',
        );
      }
    }

    let runtime;
    try {
      runtime = await dependency(() =>
        input.runtimes.resolve(deploymentTarget(deployment), signal),
      );
    } catch (error) {
      assertRequestActive(signal);
      throw new DeploymentWorkloadError(
        `Could not verify workload identity: ${errorMessage(error)}`,
        503,
      );
    }
    const resourceName = kubernetesWorkloadResourceName(
      'deployment',
      deployment.id,
    );

    let review;
    try {
      review = await dependency(() =>
        reviewServiceAccountToken(
          runtime.cluster,
          token,
          ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE,
          signal,
        ),
      );
    } catch (error) {
      assertRequestActive(signal);
      throw new DeploymentWorkloadError(
        `Kubernetes TokenReview failed: ${errorMessage(error)}`,
        503,
      );
    }
    const expectedUsername = `system:serviceaccount:${runtime.config.namespace}:${resourceName}`;
    if (!review) {
      throw new DeploymentWorkloadError(
        'Projected ServiceAccount token is not valid for this Deployment',
        401,
      );
    }
    if (review.username !== expectedUsername) {
      throw new DeploymentWorkloadError(
        'Projected ServiceAccount token belongs to another Deployment',
        403,
      );
    }
    const { podUid, podName } = review;
    if (!podUid || !podName) {
      throw new DeploymentWorkloadError(
        'Projected token is not bound to a Pod',
        401,
      );
    }

    // Read only the bound Pod: a LIST of every replica made each runner call
    // O(replicas) (S12).
    let pod: V1Pod | undefined;
    try {
      pod = await dependency(() =>
        runtime.cluster.core.readNamespacedPod(
          { name: podName, namespace: runtime.config.namespace },
          kubernetesRequestOptions(signal),
        ),
      );
    } catch (error) {
      assertRequestActive(signal);
      if (!isKubernetesNotFoundError(error)) {
        throw new DeploymentWorkloadError(
          `Kubernetes Pod observation failed: ${errorMessage(error)}`,
          503,
        );
      }
    }
    const container = pod?.status?.containerStatuses?.find(
      (candidate) => candidate.name === KUBERNETES_DEPLOYMENT_CONTAINER,
    );
    const generation = Number(
      pod?.metadata?.annotations?.[KUBERNETES_GENERATION_ANNOTATION],
    );
    if (
      !pod ||
      pod.metadata?.uid !== podUid ||
      !isKubernetesWorkloadPod(pod.metadata.labels, deployment.id) ||
      !Number.isSafeInteger(generation) ||
      generation <= 0
    ) {
      throw new DeploymentWorkloadError(
        'The bound Pod is not a current Deployment process',
        409,
      );
    }
    return {
      identity: {
        // A runner's first call can beat kubelet's status update. Until its
        // container is reported it is unready, so it waits for that Pod
        // event; a refusal would end it, and an error counts against it.
        ready:
          pod.metadata?.deletionTimestamp === undefined &&
          pod.status?.phase === 'Running' &&
          container?.ready === true &&
          container.containerID !== undefined,
        generation,
        podUid,
        containerId: container?.containerID ?? '',
      },
      managed: deployment.managed,
      pod,
      cluster: runtime.cluster,
    };
  }

  async function current(
    targetId: string,
    jobId: string,
    executionId: string,
    authorization: string | undefined,
    release?: string,
    /** Whether the route is the runner's (true) or an SDK handler's (false). */
    runner?: boolean,
  ): Promise<
    TargetedExecutionIdentity & { caller: AuthenticatedDeploymentRuntime }
  > {
    const caller = await authenticate(targetId, authorization, { release });
    if (runner !== undefined && runner !== caller.managed) {
      throw new DeploymentWorkloadError(
        runner
          ? 'Only a managed Deployment runs Jobs through the runner'
          : "A managed Deployment's Jobs report through its runner",
        409,
      );
    }
    return {
      ...(await currentExecution(
        targetId,
        jobId,
        executionId,
        caller.identity,
      )),
      caller,
    };
  }

  async function currentExecution(
    targetId: string,
    jobId: string,
    executionId: string,
    caller: DeploymentRuntimeIdentity,
    signal?: AbortSignal,
  ): Promise<TargetedExecutionIdentity> {
    assertRequestActive(signal);
    const execution = await awaitWithSignal(
      input.jobs.getTargetedExecution(jobId),
      signal,
    );
    if (!execution || execution.deploymentId !== targetId) {
      throw new DeploymentWorkloadError('Job execution not found', 404);
    }
    if (
      execution.executionId !== executionId ||
      execution.generation !== caller.generation ||
      execution.podUid !== caller.podUid ||
      execution.containerId !== caller.containerId
    ) {
      throw new DeploymentWorkloadError(
        'Job execution belongs to another Deployment process',
        409,
      );
    }
    return execution;
  }

  /**
   * A runner's Job's span of its replica's log, kept as the attempt's tail
   * at the Job's end, before the runner resets and claims the next one.
   */
  async function keepTail(
    execution: Awaited<ReturnType<typeof current>>,
  ): Promise<CapturedTail> {
    const tail = await captureTail(
      execution.caller.cluster,
      execution.caller.pod,
      KUBERNETES_DEPLOYMENT_CONTAINER,
      execution.containerId,
      { from: execution.openedAt },
    );
    await input.jobs.recordAttemptLogTail(execution.executionId, tail);
    return tail;
  }

  /**
   * A runner's Job end. A GPU Job's failed exit whose log shows an unusable
   * GPU has its Node's GPUs checked apart from the image. A Node that
   * fails the check, or whose GPU computed wrongly, is cordoned and labelled
   * for the node pool controller to replace, its replica takes no more Jobs,
   * and the Job retries on another Node under the VM path's budget. A Node
   * that passes, or one the check can't reach, is left alone, and the Job
   * reruns once in a new Pod: NVIDIA's Container Toolkit can drop a running
   * container's GPU on a healthy Node ("Failed to initialize NVML: Unknown
   * Error" after a `systemctl daemon-reload`), and a new container gets it
   * back. A second such end is Errored with the verdict.
   */
  async function runnerJobEnd(
    execution: Awaited<ReturnType<typeof current>>,
    cause: Cause,
    tail: CapturedTail,
  ): Promise<AttemptEnd> {
    const end = attemptEndOf(batchPolicy({ resumable: false }), cause);
    const { pod, cluster } = execution.caller;
    const node = pod.spec?.nodeName;
    if (
      end.state !== WorkloadState.Errored ||
      tail.state !== 'captured' ||
      !node ||
      requestedNvidiaGpus(pod.spec!) === 0 ||
      !looksLikeMissingGPU(tail.text)
    ) {
      return end;
    }
    // A numeric fault passes the probe, so only a DCGM-style diagnostic could
    // clear the Node; until then it retries and replaces as before.
    const check = looksLikeGpuNumericFault(tail.text)
      ? { verdict: 'unusable' as const }
      : await checkNodeGpus(cluster.core, pod, execution.executionId);
    if (check.verdict !== 'unusable') {
      return {
        state: WorkloadState.Retrying,
        reason: UNUSABLE_GPU_POOL_RERUN,
        cause,
        retryCap: {
          max: 1,
          ends: WorkloadState.Errored,
          failed: `${end.reason}; the Job failed the same way in a new Pod, and ${
            check.verdict === 'healthy'
              ? `the GPUs on Node ${node} passed a CUDA check, so the image or its CUDA setup is the likely cause; ${UNUSABLE_GPU_HINT}`
              : `the GPUs on Node ${node} couldn't be checked: ${check.detail}`
          }`,
        },
      };
    }
    input.jobs.closeReplica(execution.podUid);
    await markNodePoolNodeGpuUnusable(cluster.core, node);
    return {
      state: WorkloadState.Retrying,
      reason: UNUSABLE_GPU_POOL_RETRY,
      cause,
      retryCap: UNUSABLE_GPU_POOL_RETRY_CAP,
    };
  }

  /** Delete a closed replica, so its Deployment starts a new Pod. */
  async function replaceReplica(
    execution: Awaited<ReturnType<typeof current>>,
  ): Promise<void> {
    const { pod, cluster } = execution.caller;
    try {
      await cluster.core.deleteNamespacedPod(
        {
          namespace: pod.metadata!.namespace!,
          name: pod.metadata!.name!,
          body: { preconditions: { uid: execution.podUid } },
        },
        kubernetesRequestOptions(),
      );
    } catch (error) {
      if (
        !isKubernetesNotFoundError(error) &&
        !isKubernetesConflictError(error)
      )
        throw error;
    }
  }

  /**
   * A runner polls only once it no longer runs its Job, so a managed replica
   * polling with one live has lost it: fenced after an API restore (RFC 0049
   * C27). The Job ends lost, as on a gone replica, and the replica is
   * replaced, so nothing runs it untracked. A restarted container is the
   * controller's, which retries its Job as the runner's exit; an execution
   * opened since the poll began is a fresh claim a stale poll must not end.
   */
  async function endAbandoned(
    targetId: string,
    caller: AuthenticatedDeploymentRuntime,
    polledAt: number,
  ): Promise<void> {
    const abandoned = (await input.jobs.listTargetedExecutions(targetId)).find(
      (execution) =>
        execution.podUid === caller.identity.podUid &&
        execution.containerId === caller.identity.containerId &&
        execution.openedAt < polledAt &&
        LIVE_EXECUTION_STATES.includes(execution.state),
    );
    if (!abandoned) return;
    const execution = { ...abandoned, caller };
    await keepTail(execution);
    const ended = await input.jobs.reportTargetedJobExecution(
      execution.jobId,
      execution.executionId,
      attemptEndOf(batchPolicy({ resumable: false }), {
        kind: 'lost',
        detail: 'its runner no longer runs it',
      }),
    );
    // A report or terminate that won the race settled it.
    if (!ended) return;
    input.jobs.closeReplica(execution.podUid);
    await replaceReplica(execution);
    input.reconcile(targetId);
  }

  function applied(result: boolean): void {
    if (!result) {
      throw new DeploymentWorkloadError(
        'Job execution changed before the operation was applied',
        409,
      );
    }
  }

  /**
   * The queue's head that clears the claim's spend check (SLOT). A Job its
   * session's cap blocks stays queued with the reason, and the rest of that
   * session's Jobs are passed over; an account cap blocks every Job.
   */
  async function discover(
    deploymentId: string,
    caller: DeploymentRuntimeIdentity,
    signal?: AbortSignal,
  ): ReturnType<DeploymentWorkloadJobs['discoverTargetedJob']> {
    const skipSessions: string[] = [];
    for (;;) {
      const result = await awaitWithSignal(
        input.jobs.discoverTargetedJob({
          deploymentId,
          ...caller,
          skipSessions,
          signal,
        }),
        signal,
      );
      if (result.kind !== 'candidate' || !result.gate) return result;
      const block = await input.claimSpendBlock(
        result.candidate.jobId,
        result.gate,
      );
      if (!block) return result;
      if (block.sessionId === undefined) return { kind: 'empty' };
      skipSessions.push(block.sessionId);
    }
  }

  return {
    async candidate(targetId, waitMs, authorization, operation, release) {
      const signal = operation?.signal;
      // The request's start on the wall clock that stamps a claim.
      const polledAt =
        Date.now() - (operation ? performance.now() - operation.startedAt : 0);
      const cutoff = Math.min(
        (operation?.startedAt ?? performance.now()) + waitMs,
        operation?.deadlineAt ?? Infinity,
      );
      // The hops of a Job change's wake this waiter holds: finding
      // a Job wakes two more waiters, and a full replica hands it on, so a
      // wake reaches as many waiters as there are claimable Jobs.
      let held = 0;
      do {
        assertRequestActive(signal);
        // Subscribed before reading, so a Pod or Job change the pool loop
        // reports while this pass runs still wakes the wait below.
        const subscription =
          waitMs > 0
            ? input.jobChanges.subscribeDeployment(targetId, signal, cutoff)
            : undefined;
        // The hops this pass leaves unspent; until set, all it holds.
        let owed: number | undefined;
        try {
          const caller = await authenticate(targetId, authorization, {
            signal,
            acquisition: true,
            release,
          });
          assertRequestActive(operation?.signal);
          const result = await discover(targetId, caller.identity, signal);
          if (result.kind === 'conflict') {
            throw new DeploymentWorkloadError(
              'Deployment runtime changed during discovery',
              409,
            );
          }
          if (result.kind === 'full' && caller.managed) {
            await endAbandoned(targetId, caller, polledAt);
          }
          const woke = subscription?.hops ?? 0;
          if (result.kind === 'candidate' && (held || woke))
            subscription?.handOn({ waiters: 2 });
          else if (result.kind === 'full' && held > 1)
            subscription?.handOn({ waiters: 1, hops: held - 1 });
          // A wake during this pass is the next pass's, unless a Job spent it.
          owed = result.kind === 'candidate' ? 0 : woke;
          if (waitMs > 0 && performance.now() >= cutoff) return { status: 204 };
          if (result.kind === 'candidate')
            return { status: 200, body: result.candidate };
          if (waitMs === 0) return { status: 204 };
          await subscription?.promise;
          held = subscription?.hops ?? 0;
          owed = 0;
        } finally {
          // A pass that throws or times out hands on what it holds.
          const hops = owed ?? Math.max(held, subscription?.hops ?? 0);
          if (hops > 0) subscription?.handOn({ waiters: 1, hops });
          subscription?.dispose();
        }
      } while (performance.now() < cutoff);
      if (held > 0)
        input.jobChanges.notifyDeployment(targetId, { waiters: 1, hops: held });
      assertRequestActive(operation?.signal);
      return { status: 204 };
    },

    async claim(
      targetId,
      jobId,
      executionId,
      candidate,
      authorization,
      operation,
      release,
    ) {
      const caller = await authenticate(targetId, authorization, {
        signal: operation?.signal,
        acquisition: true,
        release,
      });
      assertRequestActive(operation?.signal);
      // Only the replica's first claim keeps its pull, so only it reads it.
      const imagePull = (await input.jobs.podHasClaimed(caller.identity.podUid))
        ? undefined
        : await podImagePull(
            caller.cluster,
            caller.pod,
            KUBERNETES_DEPLOYMENT_CONTAINER,
            operation?.signal,
          );
      const result = await awaitWithSignal(
        input.jobs.claimTargetedJob({
          deploymentId: targetId,
          jobId,
          executionId,
          ...candidate,
          ...caller.identity,
          imagePull,
          signal: operation?.signal,
        }),
        operation?.signal,
      );
      if (result.kind !== 'selected') {
        // Its offer is gone, so a Job still queued goes to another waiter.
        input.jobChanges.notifyDeployment(targetId, { waiters: 1 });
        throw new DeploymentWorkloadError(
          result.kind === 'stale'
            ? 'This Job candidate can never be claimed'
            : result.kind === 'execution-used'
              ? 'This execution UUID has already been used'
              : 'Claim conflicts with current Deployment state or candidate identity',
          409,
          result.kind === 'stale'
            ? 'WORKLOAD_CANDIDATE_STALE'
            : result.kind === 'execution-used'
              ? 'WORKLOAD_EXECUTION_USED'
              : undefined,
        );
      }
      return { jobId: result.jobId, executionId: result.executionId };
    },

    async cancellation(
      targetId,
      jobId,
      executionId,
      authorization,
      waitMs = 0,
      operation,
      release,
    ) {
      const signal = operation?.signal;
      const cutoff = Math.min(
        (operation?.startedAt ?? performance.now()) + waitMs,
        operation?.deadlineAt ?? Infinity,
      );
      let caller = await authenticate(targetId, authorization, {
        signal,
        release,
      });
      let waited = false;
      for (;;) {
        assertRequestActive(signal);
        const subscription = input.jobChanges.subscribe(jobId, signal, cutoff);
        try {
          let execution = await currentExecution(
            targetId,
            jobId,
            executionId,
            caller.identity,
            signal,
          );
          if (
            !LIVE_EXECUTION_STATES.includes(execution.state) ||
            performance.now() >= cutoff
          ) {
            if (waited) {
              // The workload token and Pod may have changed during an idle wait.
              caller = await authenticate(targetId, authorization, {
                signal,
                release,
              });
              execution = await currentExecution(
                targetId,
                jobId,
                executionId,
                caller.identity,
                signal,
              );
            }
            return {
              cancelled: execution.state === WorkloadState.Terminated,
            };
          }
          waited = true;
          await subscription.promise;
        } finally {
          subscription.dispose();
        }
      }
    },

    async outcome(targetId, jobId, outcome, authorization, release) {
      await current(
        targetId,
        jobId,
        outcome.executionId,
        authorization,
        release,
        false,
      );
      applied(
        await input.jobs.reportTargetedJobExecution(
          jobId,
          outcome.executionId,
          outcome.outcome === 'retryable'
            ? {
                state: WorkloadState.Retrying,
                reason: outcome.message ?? 'application requested retry',
              }
            : {
                state:
                  outcome.outcome === 'completed'
                    ? WorkloadState.Completed
                    : outcome.outcome === 'errored'
                      ? WorkloadState.Errored
                      : WorkloadState.Invalid,
                reason: outcome.message,
              },
        ),
      );
      input.reconcile(targetId);
    },

    async cleanup(targetId, jobId, executionId, authorization, release) {
      const execution = await current(
        targetId,
        jobId,
        executionId,
        authorization,
        release,
      );
      // A terminated pool Job's runner cleans up instead of reporting.
      if (execution.caller.managed) await keepTail(execution);
      applied(await input.jobs.completeTargetedJobCleanup(jobId, executionId));
      input.reconcile(targetId);
    },

    async execution(targetId, jobId, executionId, authorization, release) {
      const execution = await current(
        targetId,
        jobId,
        executionId,
        authorization,
        release,
        true,
      );
      // A managed checkpoint bucket keeps an ended Job uncleaned until
      // cleanup deletes it; its attempt's end alone stops the grants.
      if (execution.cleanedAt !== null || execution.endedAt !== null) {
        throw new DeploymentWorkloadError('Job execution has ended', 409);
      }
      // Each read mints fresh credentials, so the runner renews by reading
      // again; the fence above refuses it once the execution has ended.
      const storage = await input.mintStorage(jobId).catch(async (error) => {
        // A managed checkpoint bucket's name lost since admission: no retry
        // gets it back (RFC 0043 D-managed).
        if (!(error instanceof BucketNameTakenError)) throw error;
        applied(
          await input.jobs.reportTargetedJobExecution(
            jobId,
            executionId,
            attemptEndOf(batchPolicy({ resumable: false }), {
              kind: 'unrecoverable',
              detail: error.message,
            }),
          ),
        );
        input.reconcile(targetId);
        throw new DeploymentWorkloadError('Job execution has ended', 409);
      });
      return {
        ...(await input.jobs.getTargetedJobSpec(jobId)),
        timeLimitSeconds: null,
        storage,
      };
    },

    async report(targetId, jobId, report, authorization, release) {
      const { executionId } = report;
      const execution = await current(
        targetId,
        jobId,
        executionId,
        authorization,
        release,
        true,
      );
      if ('phase' in report) {
        applied(
          await input.jobs.reportTargetedJobPhase(
            jobId,
            executionId,
            report.phase === 'running'
              ? WorkloadState.Running
              : WorkloadState.Finalizing,
          ),
        );
      } else {
        const end = await runnerJobEnd(
          execution,
          report.cause,
          await keepTail(execution),
        );
        applied(
          await input.jobs.reportTargetedJobExecution(jobId, executionId, end),
        );
        // After the end is recorded, so a Job ended during the check leaves
        // its replica open, and the runner isn't stopped mid-report.
        if (end.reason === UNUSABLE_GPU_POOL_RERUN) {
          input.jobs.closeReplica(execution.podUid);
          await replaceReplica(execution);
        }
      }
      input.reconcile(targetId);
    },
  };
}
