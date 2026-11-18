import { WorkloadState } from '../../../../../src/shared/workload.js';
import type { TrackedDeploymentRef } from '../deployments.js';
import type {
  CleanupRecorded,
  WorkloadKernel,
  TrackedWorkloadRef,
} from '../workloads.js';
import type { FixtureNames } from '../names.js';
import type { StatusResponse } from '../types.js';
import type { VmLedgerProbe } from '../vm-ledger.js';
import type { Waiter } from '../wait.js';
import type {
  ClusterNodePoolAdapter,
  DeploymentWorkObservation,
  SubmissionResponseLossCapture,
  SubmissionResponseLossFault,
  SubmissionResponseLossObservation,
  ConcurrentTargetedJobSubmissionsObservation,
  DeploymentDrainEvidence,
  KubernetesDeploymentReadyObservation,
} from '../targets/cluster-node-pool.js';
import {
  waitForDeploymentLog,
  waitForDeploymentReady,
  waitForDeploymentStatus,
  type ManagedDeployment,
} from './deployment.js';

export interface TargetedJobDependencies {
  readonly jobs: {
    readonly kernel: Pick<
      WorkloadKernel,
      | 'recordSubstrateAbsence'
      | 'release'
      | 'reserve'
      | 'status'
      | 'waitForCleanupRecorded'
      | 'waitForState'
    >;
    readonly vmLedger: Pick<
      VmLedgerProbe,
      'assertCleared' | 'provisioningRecordCounts'
    >;
  };
  readonly names: Pick<FixtureNames, 'workload'>;
  readonly policy: { readonly workloadTimeoutMs: number };
  readonly target: Pick<
    ClusterNodePoolAdapter,
    | 'putReservation'
    | 'submitTargetedJob'
    | 'targetedJobStatus'
    | 'startSubmissionResponseLoss'
    | 'deploymentWorkStarted'
    | 'recordSubmissionResponseLoss'
    | 'rejectTargetedBucket'
    | 'resubmitTargetedJob'
    | 'submitConcurrentTargetedJobs'
    | 'duplicateTargetedJob'
    | 'deploymentStatus'
    | 'deploymentReadyByCli'
    | 'reservationLookups'
    | 'attemptLogTails'
    | 'terminateTargetedJob'
    | 'deploymentLogContains'
  >;
  readonly wait: Pick<Waiter, 'for'>;
  readonly completions: TargetedJobCompletion[];
}

export interface TargetedJobContractRecord {
  readonly contract: 'targeted-job';
  readonly jobId: string;
  readonly deploymentId: string;
  readonly deploymentName: string;
  readonly state: WorkloadState;
  readonly submissionRevision: number;
  readonly cleanedAt: number;
  readonly workloadRows: 1;
  readonly vmRows: 0;
}

export interface TargetedJobCompletion {
  readonly job: TrackedWorkloadRef;
  readonly deployment: TrackedDeploymentRef;
  readonly record: TargetedJobContractRecord;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Managed Kubernetes contract: ${message}`);
}

export async function submitJob(
  dependencies: TargetedJobDependencies,
  deployment: TrackedDeploymentRef,
  prefix: string,
  behavior?: 'hold' | 'hold-no-cancel' | 'complete' | 'error' | 'retry' | 'oom',
): Promise<TrackedWorkloadRef> {
  const ref = await dependencies.jobs.kernel.reserve(
    dependencies.names.workload(prefix),
    dependencies.policy.workloadTimeoutMs,
  );
  if (behavior) await dependencies.target.putReservation(ref.id, behavior);
  const admitted = await dependencies.target.submitTargetedJob(ref, deployment);
  invariant(admitted.outcome === 'admitted', `Job ${ref.id} was not admitted`);
  const sdkStatus = await dependencies.target.targetedJobStatus(
    ref,
    deployment,
  );
  invariant(
    sdkStatus.targetsDeployment,
    `Job ${ref.id} did not retain its tracked Deployment target`,
  );
  const observableStates: readonly WorkloadState[] =
    behavior === 'complete'
      ? [WorkloadState.Queued, WorkloadState.Running, WorkloadState.Completed]
      : behavior === 'error'
        ? [WorkloadState.Queued, WorkloadState.Running, WorkloadState.Errored]
        : behavior === 'retry' || behavior === 'oom'
          ? [
              WorkloadState.Queued,
              WorkloadState.Running,
              WorkloadState.Retrying,
            ]
          : behavior === 'hold' || behavior === 'hold-no-cancel'
            ? [WorkloadState.Queued, WorkloadState.Running]
            : [
                WorkloadState.Queued,
                WorkloadState.Running,
                WorkloadState.Invalid,
              ];
  invariant(
    observableStates.includes(sdkStatus.state),
    `Job ${ref.id} entered unexpected post-submit state ${sdkStatus.state}`,
  );
  return ref;
}

export async function releaseJob(
  dependencies: TargetedJobDependencies,
  ref: TrackedWorkloadRef,
  deployment: TrackedDeploymentRef,
): Promise<CleanupRecorded> {
  const cleanup = await dependencies.jobs.kernel.waitForCleanupRecorded(
    ref,
    dependencies.policy.workloadTimeoutMs,
  );
  const counts = await dependencies.jobs.vmLedger.provisioningRecordCounts(ref);
  invariant(
    counts.workloadRows === 1 && counts.vmRows === 0,
    `targeted Job ${ref.id} entered VM provisioning`,
  );
  const workload = cleanup.status.workload;
  invariant(
    workload.id === ref.id &&
      workload.deploymentId !== null &&
      typeof workload.cleanedAt === 'number' &&
      Number.isFinite(workload.cleanedAt) &&
      typeof workload.submissionRevision === 'number' &&
      Number.isSafeInteger(workload.submissionRevision),
    `targeted Job ${ref.id} has incomplete identity or cleanup evidence`,
  );
  await dependencies.jobs.kernel.release({
    cleanup,
    ledger: await dependencies.jobs.vmLedger.assertCleared(ref),
    substrate: dependencies.jobs.kernel.recordSubstrateAbsence(ref),
  });
  dependencies.completions.push({
    job: ref,
    deployment,
    record: {
      contract: 'targeted-job',
      jobId: ref.id,
      deploymentId: workload.deploymentId,
      deploymentName: deployment.name,
      state: workload.state,
      submissionRevision: workload.submissionRevision,
      cleanedAt: workload.cleanedAt,
      workloadRows: 1,
      vmRows: 0,
    },
  });
  return cleanup;
}

export function responseLossExecutionViolation(
  status: {
    readonly workload: Pick<
      StatusResponse['workload'],
      'submissionRevision' | 'claimed'
    >;
    readonly events: StatusResponse['events'];
  },
  work: DeploymentWorkObservation,
  original?: DeploymentWorkObservation,
): string | undefined {
  const executions = status.events.filter(
    (event) => event.state === WorkloadState.Running,
  );
  if (executions.length !== 1 || work.executionIds.length !== 1) {
    return 'response-loss recovery requires exactly one execution and one application work start';
  }
  const execution = executions[0].metadata;
  if (
    status.workload.submissionRevision !== 0 ||
    !status.workload.claimed ||
    execution?.submissionRevision !== 0 ||
    execution.executionId !== work.executionIds[0] ||
    execution.generation !== work.generation ||
    execution.podUid !== work.podUid ||
    execution.containerId !== work.containerId
  ) {
    return 'response-loss execution history does not match the original submission and running container';
  }
  if (
    original &&
    (original.executionIds[0] !== work.executionIds[0] ||
      original.generation !== work.generation ||
      original.podUid !== work.podUid ||
      original.containerId !== work.containerId ||
      original.imageId !== work.imageId)
  ) {
    return 'response-loss recovery replaced its original execution or Kubernetes runtime';
  }
  return undefined;
}

export async function proveSubmissionResponseLoss(
  dependencies: TargetedJobDependencies,
  deployment: TrackedDeploymentRef,
  fault: SubmissionResponseLossFault,
): Promise<void> {
  const ref = await dependencies.jobs.kernel.reserve(
    dependencies.names.workload(`lost-${fault}`),
    dependencies.policy.workloadTimeoutMs,
  );
  await dependencies.target.putReservation(ref.id, 'hold');
  const session = await dependencies.target.startSubmissionResponseLoss(
    ref,
    deployment,
    fault,
  );
  invariant(
    session.job === ref && session.deployment === deployment,
    'response-loss session did not retain its tracked Job and Deployment',
  );
  let capture: SubmissionResponseLossCapture | null = null;
  let before: DeploymentWorkObservation | undefined;
  let after: DeploymentWorkObservation | undefined;
  let completed: DeploymentWorkObservation | undefined;
  let recovery: SubmissionResponseLossObservation | undefined;
  let cleanedAt: number | null | undefined;
  let qualified = false;
  try {
    capture = await dependencies.wait.for(
      `${fault} response captured for ${ref.id}`,
      () => session.captured(),
      {
        timeoutMs: 30_000,
        intervalMs: 100,
        probeError: 'fail',
        unmet: (value) => (value ? undefined : 'response not captured'),
      },
    );
    invariant(
      capture &&
        capture.fault === fault &&
        capture.jobId === ref.id &&
        capture.submissionRevision === 0 &&
        capture.method === 'POST' &&
        capture.statusCode >= 200 &&
        capture.statusCode < 300 &&
        capture.path ===
          (fault === 'admission'
            ? '/v1/workloads'
            : `/v1/workloads/${ref.id}/claim-observation`) &&
        capture.outcome === (fault === 'admission' ? 'admitted' : 'claimed'),
      'fault did not capture the selected successful response',
    );

    // The SDK child holds the real reply until both durable and in-Pod evidence
    // prove that the application is executing. Time alone never releases it.
    const started = await dependencies.wait.for(
      `running application before ${fault} response loss for ${ref.id}`,
      async () => {
        await session.captured(); // Surface child failure while awaiting the application.
        const [status, work] = await Promise.all([
          dependencies.jobs.kernel.status(ref, true),
          dependencies.target.deploymentWorkStarted(deployment, ref),
        ]);
        return { status, work };
      },
      {
        timeoutMs: 15_000,
        intervalMs: 100,
        probeError: 'fail',
        unmet: ({ status, work }) =>
          status.workload.state === WorkloadState.Running &&
          work?.executionIds.length
            ? undefined
            : 'application has not started work',
      },
    );
    invariant(
      started.work,
      'running application omitted its execution evidence',
    );
    before = started.work;
    const beforeViolation = responseLossExecutionViolation(
      started.status,
      before,
    );
    invariant(!beforeViolation, beforeViolation ?? 'invalid initial execution');
    await session.release();
    recovery = await session.recovered();
    invariant(
      recovery.id === ref.id &&
        recovery.uncertain &&
        recovery.outcome === 'claimed' &&
        recovery.submissionRevision === 0 &&
        recovery.admissions === 1 &&
        recovery.resubmissions === 0 &&
        recovery.losses === 1 &&
        recovery.client === 'AsyncClient' &&
        recovery.transportClosed &&
        recovery.pendingTasks === 0 &&
        recovery.observations.some((observation) => observation.afterLoss) &&
        recovery.observations.every(
          (observation) =>
            observation.jobId === ref.id &&
            observation.submissionRevision === 0,
        ),
      'response loss did not recover the original submission without additional admission or resubmission',
    );
    const held = await dependencies.jobs.kernel.status(ref, true);
    invariant(
      held.workload.state === WorkloadState.Running,
      'recovery did not leave the application running',
    );
    const recoveredWork = await dependencies.target.deploymentWorkStarted(
      deployment,
      ref,
    );
    invariant(recoveredWork, 'recovery lost the running Kubernetes container');
    after = recoveredWork;
    const afterViolation = responseLossExecutionViolation(held, after, before);
    invariant(!afterViolation, afterViolation ?? 'invalid recovered execution');

    await dependencies.target.putReservation(ref.id, 'complete');
    await dependencies.jobs.kernel.waitForState(
      ref,
      WorkloadState.Completed,
      dependencies.policy.workloadTimeoutMs,
    );
    const { status: cleanup } = await releaseJob(dependencies, ref, deployment);
    cleanedAt = cleanup.workload.cleanedAt;
    const completedWork = await dependencies.target.deploymentWorkStarted(
      deployment,
      ref,
    );
    invariant(
      completedWork,
      'completion lost the original Kubernetes container',
    );
    completed = completedWork;
    const completionViolation = responseLossExecutionViolation(
      cleanup,
      completed,
      before,
    );
    invariant(
      !completionViolation,
      completionViolation ?? 'invalid completed execution',
    );
    qualified = true;
  } finally {
    let checkpointsClosed = false;
    try {
      await session.close();
      checkpointsClosed = true;
    } finally {
      await dependencies.target.recordSubmissionResponseLoss(ref, deployment, {
        fault,
        qualified: qualified && checkpointsClosed,
        identity: session.identity,
        capture,
        before,
        after,
        completed,
        recovery,
        cleanedAt,
      });
    }
  }
}

export async function qualifyTargetedJobAdmission(
  dependencies: TargetedJobDependencies,
  deployment: TrackedDeploymentRef,
): Promise<void> {
  const bucketRef = await dependencies.jobs.kernel.reserve(
    dependencies.names.workload('bucket-reject'),
    dependencies.policy.workloadTimeoutMs,
  );
  const bucketRejection = await dependencies.target.rejectTargetedBucket(
    bucketRef,
    deployment,
  );
  invariant(
    bucketRejection.rejected && !bucketRejection.persisted,
    'targeted bucket input was accepted or persisted',
  );

  const missing = await submitJob(
    dependencies,
    deployment,
    'missing-reservation',
  );
  await dependencies.jobs.kernel.waitForState(
    missing,
    WorkloadState.Invalid,
    dependencies.policy.workloadTimeoutMs,
  );
  await releaseJob(dependencies, missing, deployment);

  const resubmitted = await submitJob(
    dependencies,
    deployment,
    'operator-resubmit',
    'error',
  );
  await dependencies.jobs.kernel.waitForState(
    resubmitted,
    WorkloadState.Errored,
    dependencies.policy.workloadTimeoutMs,
  );
  await dependencies.target.putReservation(resubmitted.id, 'complete');
  const resubmission =
    await dependencies.target.resubmitTargetedJob(resubmitted);
  invariant(
    resubmission.id === resubmitted.id && resubmission.submissionRevision === 1,
    'explicit resubmission changed its public Job ID or failed to advance revision',
  );
  await dependencies.jobs.kernel.waitForState(
    resubmitted,
    WorkloadState.Completed,
    dependencies.policy.workloadTimeoutMs,
  );
  await releaseJob(dependencies, resubmitted, deployment);
}

export async function qualifyConcurrentTargetedJobs(
  dependencies: TargetedJobDependencies,
  deployment: TrackedDeploymentRef,
  initialReady: KubernetesDeploymentReadyObservation,
): Promise<ConcurrentTargetedJobSubmissionsObservation> {
  const [first, second] = await Promise.all(
    ['concurrent-a', 'concurrent-b'].map((prefix) =>
      dependencies.jobs.kernel.reserve(
        dependencies.names.workload(prefix),
        dependencies.policy.workloadTimeoutMs,
      ),
    ),
  );
  await Promise.all(
    [first, second].map((ref) =>
      dependencies.target.putReservation(ref.id, 'hold'),
    ),
  );
  const concurrent = await dependencies.target.submitConcurrentTargetedJobs(
    [first, second],
    deployment,
    { timeout: 60, wait: true },
  );
  invariant(
    concurrent.client === 'AsyncClient' &&
      concurrent.transportClosed &&
      concurrent.pendingTasks === 0 &&
      concurrent.jobs.length === 2 &&
      new Set(concurrent.jobs.map((job) => job.id)).size === 2 &&
      concurrent.jobs.every(
        (job) =>
          job.outcome === 'claimed' &&
          job.claimed &&
          job.submissionRevision === 0 &&
          [first.id, second.id].includes(job.id),
      ),
    'concurrent submissions did not claim through one AsyncClient and close its requests and transport',
  );
  for (const ref of [first, second]) {
    const status = await dependencies.target.targetedJobStatus(ref, deployment);
    invariant(
      status.targetsDeployment && status.state === WorkloadState.Running,
      `concurrent Job ${ref.id} did not retain its target or waited for completion`,
    );
  }
  const duplicate = await dependencies.target.duplicateTargetedJob(
    first,
    deployment,
  );
  invariant(duplicate.rejected, 'duplicate client Job ID was accepted');
  await Promise.all([
    dependencies.jobs.kernel.waitForState(
      first,
      WorkloadState.Running,
      dependencies.policy.workloadTimeoutMs,
    ),
    dependencies.jobs.kernel.waitForState(
      second,
      WorkloadState.Running,
      dependencies.policy.workloadTimeoutMs,
    ),
  ]);
  await Promise.all(
    [first, second].map((job) =>
      waitForDeploymentLog(
        dependencies,
        deployment,
        initialReady.podUid,
        `cancellation-wait:${job.id}:20`,
      ),
    ),
  );
  const third = await submitJob(
    dependencies,
    deployment,
    'concurrent-c',
    'complete',
  );
  const saturated = await dependencies.target.deploymentStatus(deployment);
  invariant(
    saturated.jobs.running === 2 &&
      saturated.jobs.queued === 1 &&
      saturated.jobs.unreleased === saturated.maxConcurrentJobsPerReplica,
    'two-slot Deployment did not enforce saturation',
  );
  const expired = await dependencies.jobs.kernel.reserve(
    dependencies.names.workload('claim-expiry'),
    dependencies.policy.workloadTimeoutMs,
  );
  await dependencies.target.putReservation(expired.id, 'complete');
  const expiry = await dependencies.target.submitTargetedJob(
    expired,
    deployment,
    { timeout: 1, wait: true },
  );
  invariant(
    expiry.outcome === 'expired' &&
      !expiry.claimed &&
      expiry.submissionRevision === 0,
    'occupied-capacity submission did not confirm first-claim expiry',
  );

  const blocking = await dependencies.jobs.kernel.reserve(
    dependencies.names.workload('blocking-claim'),
    dependencies.policy.workloadTimeoutMs,
  );
  await dependencies.target.putReservation(blocking.id, 'hold');
  let blockingSettled = false;
  const blockingSubmission = dependencies.target
    .submitTargetedJob(blocking, deployment, {
      timeout: 60,
      wait: true,
    })
    .then(
      (value) => {
        blockingSettled = true;
        return { value };
      },
      (error: unknown) => {
        blockingSettled = true;
        return { error };
      },
    );
  const waiting = await dependencies.jobs.kernel.waitForState(
    blocking,
    WorkloadState.Queued,
    dependencies.policy.workloadTimeoutMs,
  );
  invariant(
    !blockingSettled && !waiting.workload.claimed,
    'blocking submission returned before capacity permitted a durable claim',
  );
  await dependencies.target.putReservation(first.id, 'complete');
  await dependencies.jobs.kernel.waitForState(
    first,
    WorkloadState.Completed,
    dependencies.policy.workloadTimeoutMs,
  );
  await dependencies.jobs.kernel.waitForState(
    third,
    WorkloadState.Completed,
    dependencies.policy.workloadTimeoutMs,
  );
  // The application finished and acknowledged work while its cancellation
  // request was outstanding. Joining the watcher before ACK would deadlock
  // until the wait expires; the SDK must keep lifecycle calls available.
  await Promise.all(
    [
      `completed-with-cancellation-wait:${first.id}`,
      `cancellation-watcher-closed:${first.id}`,
    ].map((line) =>
      waitForDeploymentLog(dependencies, deployment, initialReady.podUid, line),
    ),
  );
  invariant(
    !(await dependencies.target.deploymentLogContains(
      deployment,
      initialReady.podUid,
      `cancellation-watcher-closed:${second.id}`,
    )),
    'completion stopped another active Job cancellation watcher',
  );
  const claimedSubmission = await blockingSubmission;
  if ('error' in claimedSubmission) throw claimedSubmission.error;
  invariant(
    claimedSubmission.value.outcome === 'claimed' &&
      claimedSubmission.value.claimed,
    'blocking submission did not return its durable claim after capacity release',
  );
  const heldClaim = await dependencies.jobs.kernel.status(blocking, true);
  invariant(
    heldClaim.workload.state === WorkloadState.Running,
    'blocking submission waited for handler completion',
  );
  await dependencies.target.putReservation(blocking.id, 'complete');
  await dependencies.jobs.kernel.waitForState(
    blocking,
    WorkloadState.Completed,
    dependencies.policy.workloadTimeoutMs,
  );

  const stillExpired = await dependencies.jobs.kernel.status(expired, true);
  invariant(
    stillExpired.workload.state === WorkloadState.Terminated &&
      !stillExpired.workload.claimed &&
      !stillExpired.events.some(
        (event) => event.state === WorkloadState.Running,
      ) &&
      (await dependencies.target.reservationLookups(expired.id)) === 0,
    'expired submission started after occupied capacity was released',
  );
  const renewed = await dependencies.target.resubmitTargetedJob(expired, {
    timeout: 60,
    wait: true,
  });
  invariant(
    renewed.id === expired.id &&
      renewed.submissionRevision === 1 &&
      renewed.claimed,
    'same-ID resubmission did not acquire a fresh submission revision',
  );
  await dependencies.jobs.kernel.waitForState(
    expired,
    WorkloadState.Completed,
    dependencies.policy.workloadTimeoutMs,
  );
  await dependencies.target.terminateTargetedJob(second);
  await dependencies.jobs.kernel.waitForState(
    second,
    WorkloadState.Terminated,
    dependencies.policy.workloadTimeoutMs,
  );
  await Promise.all(
    [
      `cancellation-observed:${second.id}`,
      `cancelled:${second.id}`,
      `cancellation-watcher-closed:${second.id}`,
    ].map((line) =>
      waitForDeploymentLog(dependencies, deployment, initialReady.podUid, line),
    ),
  );
  await Promise.all([
    releaseJob(dependencies, first, deployment),
    releaseJob(dependencies, second, deployment),
    releaseJob(dependencies, third, deployment),
    releaseJob(dependencies, blocking, deployment),
    releaseJob(dependencies, expired, deployment),
  ]);

  return concurrent;
}

export async function completeTargetedJob(
  dependencies: TargetedJobDependencies,
  deployment: TrackedDeploymentRef,
  job: TrackedWorkloadRef,
): Promise<CleanupRecorded> {
  await dependencies.target.putReservation(job.id, 'complete');
  await dependencies.jobs.kernel.waitForState(
    job,
    WorkloadState.Completed,
    dependencies.policy.workloadTimeoutMs,
  );
  return releaseJob(dependencies, job, deployment);
}

export async function qualifyApplicationRetry(
  dependencies: TargetedJobDependencies,
  deployment: TrackedDeploymentRef,
): Promise<TrackedWorkloadRef> {
  const job = await submitJob(
    dependencies,
    deployment,
    'application-retry',
    'retry',
  );
  return finishApplicationRetry(dependencies, deployment, job);
}

export async function finishApplicationRetry(
  dependencies: TargetedJobDependencies,
  deployment: TrackedDeploymentRef,
  job: TrackedWorkloadRef,
): Promise<TrackedWorkloadRef> {
  await dependencies.wait.for(
    'application-requested Job retry',
    () => dependencies.jobs.kernel.status(job, true),
    {
      timeoutMs: dependencies.policy.workloadTimeoutMs,
      intervalMs: 1_000,
      probeError: 'fail',
      unmet: (status) =>
        status.events.some((event) => event.state === WorkloadState.Retrying)
          ? undefined
          : status.workload.state,
    },
  );
  await completeTargetedJob(dependencies, deployment, job);
  return job;
}

/** RFC 0044 S17: the replica's death names its cause, and the Job runs again. */
export async function qualifyReplicaOomRetry(
  dependencies: TargetedJobDependencies,
  deployment: TrackedDeploymentRef,
): Promise<void> {
  const job = await submitJob(dependencies, deployment, 'replica-oom', 'oom');
  const status = await dependencies.wait.for(
    `Job ${job.id} retry after its replica was OOMKilled`,
    () => dependencies.jobs.kernel.status(job, true),
    {
      timeoutMs: dependencies.policy.workloadTimeoutMs,
      intervalMs: 1_000,
      probeError: 'fail',
      unmet: (status) =>
        status.events.some((event) => event.state === WorkloadState.Retrying)
          ? undefined
          : status.workload.state,
    },
  );
  const reason = status.events.find(
    (event) => event.state === WorkloadState.Retrying,
  )?.metadata?.reason;
  invariant(
    reason === 'replica OOMKilled (exit 137)',
    `replica OOM kill retried its Job with ${JSON.stringify(reason)}`,
  );
  // The killed attempt keeps its replica's log tail, stored before its
  // outcome: what the handler printed before it allocated.
  const [killed] = await dependencies.target.attemptLogTails(job.id);
  invariant(
    killed?.logTailState === 'captured' &&
      killed.logTail?.includes(`started:${job.id}`),
    `replica OOM kill kept no log tail: ${JSON.stringify(killed)}`,
  );
  await completeTargetedJob(dependencies, deployment, job);
}

export async function startTargetedJobRecovery(
  dependencies: TargetedJobDependencies,
  deployment: TrackedDeploymentRef,
): Promise<TrackedWorkloadRef> {
  const job = await submitJob(
    dependencies,
    deployment,
    'runtime-recovery',
    'hold',
  );
  await dependencies.jobs.kernel.waitForState(
    job,
    WorkloadState.Running,
    dependencies.policy.workloadTimeoutMs,
  );
  return job;
}

export async function waitForTargetedJobRedelivery(
  dependencies: TargetedJobDependencies,
  job: TrackedWorkloadRef,
  replacement: KubernetesDeploymentReadyObservation,
): Promise<void> {
  await dependencies.wait.for(
    `Job ${job.id} redelivery after Pod replacement`,
    async () => ({
      status: await dependencies.jobs.kernel.status(job, true),
      lookups: await dependencies.target.reservationLookups(job.id),
    }),
    {
      timeoutMs: dependencies.policy.workloadTimeoutMs,
      intervalMs: 1_000,
      probeError: 'fail',
      unmet: ({ status, lookups }) => {
        const executions = status.events.filter(
          (event) => event.state === WorkloadState.Running,
        );
        return status.workload.state === WorkloadState.Running &&
          executions.length >= 2 &&
          executions.at(-1)?.metadata?.podUid === replacement.podUid &&
          lookups >= 2
          ? undefined
          : `${status.workload.state}, executions=${executions.length}, lookups=${lookups}`;
      },
    },
  );
}

export async function qualifyTargetedEnvironmentUpdate(
  dependencies: TargetedJobDependencies,
  deployment: TrackedDeploymentRef,
  ready: KubernetesDeploymentReadyObservation,
  idleStopKey: string,
): Promise<void> {
  await waitForDeploymentLog(
    dependencies,
    deployment,
    ready.podUid,
    `idle-stopped:${idleStopKey}`,
  );
  const job = await submitJob(
    dependencies,
    deployment,
    'environment-marker',
    'complete',
  );
  const paused = await dependencies.jobs.kernel.status(job, true);
  invariant(
    paused.workload.state === WorkloadState.Queued &&
      paused.workload.claimed === false &&
      !paused.events.some((event) => event.state === WorkloadState.Running),
    'a stopped acquisition call assigned the environment-probe Job',
  );
  await dependencies.target.putReservation(idleStopKey, 'complete');
  await dependencies.jobs.kernel.waitForState(
    job,
    WorkloadState.Completed,
    dependencies.policy.workloadTimeoutMs,
  );
  await waitForDeploymentLog(
    dependencies,
    deployment,
    ready.podUid,
    `configuration:${job.id}:updated`,
  );
  await releaseJob(dependencies, job, deployment);
}

export async function queueTargetedJobDuringDrain(
  dependencies: TargetedJobDependencies,
  deployment: TrackedDeploymentRef,
  blockers: readonly [TrackedWorkloadRef, TrackedWorkloadRef],
): Promise<{
  readonly job: TrackedWorkloadRef;
  readonly bothBlocked: DeploymentDrainEvidence['bothBlocked'];
}> {
  const next = await submitJob(dependencies, deployment, 'drain-next', 'hold');
  const draining = await waitForDeploymentStatus(
    dependencies,
    deployment,
    'waiting on Jobs',
  );
  invariant(
    draining.status.blockingJobs.total === 2 &&
      blockers.every((blocker) =>
        draining.status.blockingJobs.jobs.some((job) => job.id === blocker.id),
      ),
    'generation drain did not identify both active Jobs',
  );
  return {
    job: next,
    bothBlocked: {
      unreleasedJobs: draining.jobs.unreleased,
      status: draining.status,
    },
  };
}

export async function proveRemainingTargetedBlocker(
  dependencies: TargetedJobDependencies,
  deployment: TrackedDeploymentRef,
  blocker: TrackedWorkloadRef,
  next: TrackedWorkloadRef,
  podUid: string,
): Promise<DeploymentDrainEvidence['oneBlocked']> {
  const remaining = await waitForDeploymentStatus(
    dependencies,
    deployment,
    'waiting on Jobs',
  );
  const queuedJobState = (await dependencies.jobs.kernel.status(next, true))
    .workload.state;
  invariant(
    remaining.maxConcurrentJobsPerReplica - remaining.jobs.unreleased === 1 &&
      remaining.status.blockingJobs.total === 1 &&
      remaining.status.blockingJobs.jobs[0]?.id === blocker.id &&
      remaining.status.podUid === podUid &&
      queuedJobState === WorkloadState.Queued,
    'one released slot obscured the remaining generation blocker or admitted the next Job',
  );
  return {
    unreleasedJobs: remaining.jobs.unreleased,
    status: remaining.status,
    queuedJobState,
  };
}

export async function qualifyReplacementGenerationJob(
  dependencies: TargetedJobDependencies,
  deployment: ManagedDeployment,
  ready: KubernetesDeploymentReadyObservation,
  job: TrackedWorkloadRef,
): Promise<Pick<DeploymentDrainEvidence, 'replacement' | 'claim'>> {
  await dependencies.jobs.kernel.waitForState(
    job,
    WorkloadState.Running,
    dependencies.policy.workloadTimeoutMs,
  );
  const claimed = await dependencies.jobs.kernel.status(job, true);
  const execution = claimed.events.find(
    (event) => event.state === WorkloadState.Running,
  )?.metadata;
  invariant(
    execution?.generation === deployment.generation &&
      execution.podUid === ready.podUid &&
      typeof execution.containerId === 'string' &&
      execution.containerId.length > 0,
    'queued work did not claim the replacement generation and Pod',
  );
  const readyStatus = await waitForDeploymentStatus(
    dependencies,
    deployment.ref,
    'ready',
  );
  invariant(
    readyStatus.readinessProbe?.periodSeconds === 1 &&
      readyStatus.status.requestedGeneration ===
        readyStatus.status.appliedGeneration &&
      readyStatus.status.appliedGeneration ===
        readyStatus.status.podGeneration &&
      readyStatus.status.containerId === execution.containerId,
    'replacement status did not preserve the probe and matching generations',
  );
  await completeTargetedJob(dependencies, deployment.ref, job);
  return {
    replacement: readyStatus.status,
    claim: {
      generation: execution.generation,
      podUid: execution.podUid,
      containerId: execution.containerId,
    },
  };
}

export interface PendingTargetedRuntimeLoss {
  readonly deployment: TrackedDeploymentRef;
  readonly terminated: TrackedWorkloadRef;
  readonly follower: TrackedWorkloadRef;
}

export async function startTargetedRuntimeLoss(
  dependencies: TargetedJobDependencies,
  deployment: TrackedDeploymentRef,
): Promise<PendingTargetedRuntimeLoss> {
  const terminated = await submitJob(
    dependencies,
    deployment,
    'terminal-runtime-loss',
    'hold-no-cancel',
  );
  await dependencies.jobs.kernel.waitForState(
    terminated,
    WorkloadState.Running,
    dependencies.policy.workloadTimeoutMs,
  );
  await dependencies.target.terminateTargetedJob(terminated);
  const status = await dependencies.jobs.kernel.waitForState(
    terminated,
    WorkloadState.Terminated,
    dependencies.policy.workloadTimeoutMs,
  );
  invariant(
    status.workload.cleanedAt === null,
    'termination released capacity before cancellation acknowledgement',
  );
  const follower = await submitJob(
    dependencies,
    deployment,
    'after-runtime-loss',
    'complete',
  );
  const blocked = await dependencies.target.deploymentStatus(deployment);
  invariant(
    blocked.jobs.queued === 1 &&
      blocked.jobs.unreleased === 1 &&
      blocked.jobs.unreleased === blocked.maxConcurrentJobsPerReplica,
    'terminal pending-cleanup Job did not occupy its slot',
  );
  return { deployment, terminated, follower };
}

export async function finishTargetedRuntimeLoss(
  dependencies: TargetedJobDependencies,
  pending: PendingTargetedRuntimeLoss,
): Promise<void> {
  await dependencies.jobs.kernel.waitForCleanupRecorded(
    pending.terminated,
    dependencies.policy.workloadTimeoutMs,
  );
  await dependencies.jobs.kernel.waitForState(
    pending.follower,
    WorkloadState.Completed,
    dependencies.policy.workloadTimeoutMs,
  );
  await Promise.all([
    releaseJob(dependencies, pending.terminated, pending.deployment),
    releaseJob(dependencies, pending.follower, pending.deployment),
  ]);
}

type TargetedReadinessDependencies = TargetedJobDependencies & {
  readonly target: Pick<
    ClusterNodePoolAdapter,
    | 'deploymentReady'
    | 'deploymentReceive'
    | 'releaseReadinessReservation'
    | 'recordReadinessWakeup'
    | 'deploymentCliLogs'
  >;
};

export async function qualifyNativeReadiness(
  dependencies: TargetedReadinessDependencies,
  deployment: ManagedDeployment,
  reservation: string,
): Promise<KubernetesDeploymentReadyObservation> {
  const first = await submitJob(dependencies, deployment.ref, 'warmup', 'hold');
  const probing = await waitForDeploymentStatus(
    dependencies,
    deployment.ref,
    'probe failing',
  );
  invariant(probing.status.podUid, 'warmup did not identify its Pod');
  await waitForDeploymentLog(
    dependencies,
    deployment.ref,
    probing.status.podUid,
    'receive-wait:20',
  );
  // `anycloud logs` serves the Pod while its native probe still fails.
  const cliLogs = await dependencies.target.deploymentCliLogs(deployment.ref);
  invariant(
    cliLogs.includes('receive-wait:20'),
    `anycloud logs did not show the unready Deployment's output: ${cliLogs.slice(-500)}`,
  );
  invariant(
    probing.status.applicationReady === false &&
      probing.status.probeConfigured === true,
    'configured warmup did not report a failed native probe',
  );
  const queued = await dependencies.jobs.kernel.status(first, true);
  invariant(
    queued.workload.state === WorkloadState.Queued &&
      queued.events.length === 0,
    'work was claimed before application readiness',
  );
  await proveReadinessWakeup(
    dependencies,
    deployment,
    probing.status.podUid,
    first.id,
    reservation,
    'warmup',
  );
  const ready = await waitForDeploymentReady(dependencies, deployment);
  await dependencies.jobs.kernel.waitForState(
    first,
    WorkloadState.Running,
    dependencies.policy.workloadTimeoutMs,
  );
  await waitForDeploymentStatus(dependencies, deployment.ref, 'ready');

  await dependencies.target.putReservation(reservation, 'hold');
  const lost = await waitForDeploymentStatus(
    dependencies,
    deployment.ref,
    'probe failing',
  );
  const active = await dependencies.jobs.kernel.status(first, true);
  invariant(
    lost.status.podUid === ready.podUid &&
      lost.jobs.unreleased === 1 &&
      active.workload.state === WorkloadState.Running,
    'readiness loss released or replaced the active execution',
  );
  const second = await submitJob(
    dependencies,
    deployment.ref,
    'readiness-recovery',
    'hold',
  );
  invariant(
    (await dependencies.jobs.kernel.status(second, true)).workload.state ===
      WorkloadState.Queued,
    'an unused slot bypassed readiness loss',
  );
  await proveReadinessWakeup(
    dependencies,
    deployment,
    ready.podUid,
    second.id,
    reservation,
    'recovery',
  );
  await dependencies.jobs.kernel.waitForState(
    second,
    WorkloadState.Running,
    dependencies.policy.workloadTimeoutMs,
  );
  invariant(
    (await waitForDeploymentStatus(dependencies, deployment.ref, 'ready'))
      .status.podUid === ready.podUid,
    'readiness recovery replaced the warm Pod',
  );
  for (const job of [first, second]) {
    await dependencies.target.putReservation(job.id, 'complete');
    await dependencies.jobs.kernel.waitForState(
      job,
      WorkloadState.Completed,
      dependencies.policy.workloadTimeoutMs,
    );
    await releaseJob(dependencies, job, deployment.ref);
  }
  return ready;
}

async function proveReadinessWakeup(
  dependencies: TargetedReadinessDependencies,
  deployment: ManagedDeployment,
  podUid: string,
  jobId: string,
  reservation: string,
  phase: 'warmup' | 'recovery',
): Promise<void> {
  const waiting = await dependencies.wait.for(
    `Deployment ${deployment.ref.name} to wait before its native probe succeeds`,
    () => dependencies.target.deploymentReceive(deployment.ref, podUid),
    {
      timeoutMs: dependencies.policy.workloadTimeoutMs,
      intervalMs: 100,
      probeError: 'fail',
      unmet: (receive) =>
        receive &&
        receive.returnedAt === null &&
        receive.observedAt - receive.startedAt >= 1_000 &&
        receive.observedAt - receive.startedAt <= 3_000
          ? undefined
          : 'no fresh waiting receive',
    },
  );
  invariant(waiting, 'readiness qualification omitted its waiting receive');
  // This reservation is consumed by kubelet's exec probe. It has no Job row.
  const releasedAt =
    await dependencies.target.releaseReadinessReservation(reservation);
  const received = await dependencies.wait.for(
    `Job ${jobId} to wake its existing receive`,
    () => dependencies.target.deploymentReceive(deployment.ref, podUid, jobId),
    {
      timeoutMs: 20_000,
      intervalMs: 100,
      probeError: 'fail',
      unmet: (receive) =>
        receive?.returnedAt !== null && receive?.jobId === jobId
          ? undefined
          : 'receive has not returned its queued Job',
    },
  );
  invariant(
    received?.returnedAt !== null &&
      received?.returnedAt !== undefined &&
      received.probeSucceededAt !== null,
    'readiness qualification omitted probe/receive timestamps',
  );
  invariant(
    received.sequence === waiting.sequence,
    'readiness waited for a new receive instead of waking the existing request',
  );
  invariant(
    received.probeSucceededAt >= releasedAt &&
      received.returnedAt >= received.probeSucceededAt,
    'readiness timestamps are out of order; qualify clock synchronization',
  );
  invariant(
    received.returnedAt < waiting.startedAt + 19_000 &&
      received.returnedAt - received.probeSucceededAt < 5_000,
    'queued work did not wake promptly before the receive deadline',
  );
  await dependencies.target.recordReadinessWakeup(deployment.ref, {
    phase,
    generation: deployment.generation,
    jobId,
    podUid,
    waitingSequence: waiting.sequence,
    returnedSequence: received.sequence,
    receiveStartedAt: waiting.startedAt,
    releasedAt,
    probeSucceededAt: received.probeSucceededAt,
    returnedAt: received.returnedAt,
    probeDetectionMs: received.probeSucceededAt - releasedAt,
    probeToReceiveMs: received.returnedAt - received.probeSucceededAt,
  });
}
