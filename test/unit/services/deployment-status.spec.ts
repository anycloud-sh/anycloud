import { describe, expect, it } from 'vitest';
import {
  deriveDeploymentStatus,
  type DeploymentObservation,
  type DeploymentRuntimeObservation,
} from '../../../src/api/services/deployment-status.js';
import type { StoredDeployment } from '../../../src/api/services/deployment-store.js';
import type { TargetedJobStatusSnapshot } from '../../../src/api/services/repositories/deployment-executions.js';
import { deploymentStatusSchema } from '../../../src/shared/api-contract/deployments-schemas.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import { makeContainerSpec } from '../helpers/fixtures.js';

const deployment: StoredDeployment = {
  id: 'deployment',
  name: 'worker',
  nodePoolId: 'node-pool-a',
  ownerUserId: 'owner',
  config: makeContainerSpec(),
  readinessProbe: { exec: { command: ['test', '-f', '/ready'] } },
  gracePeriodSeconds: 30,
  secretNames: [],
  gpuCount: 0,
  maxConcurrentJobsPerReplica: 2,
  minReplicas: 1,
  maxReplicas: 1,
  managed: false,
  apiIdentity: false,
  runnerRelease: null,
  generation: 1,
  deletionRequestedAt: null,
  deletedAt: null,
  createdAt: 1,
  updatedAt: 1,
};
const empty: TargetedJobStatusSnapshot = {
  counts: { queued: 1, running: 0, retrying: 0, terminal: 0, unreleased: 0 },
  blockers: [],
};
function observed(
  overrides: Partial<DeploymentRuntimeObservation> = {},
): DeploymentObservation {
  return {
    kind: 'observed',
    runtime: {
      workload: {
        observedGeneration: 1,
        podName: 'worker-pod',
        podUid: 'pod-1',
        containerId: 'containerd://1',
        containerReady: true,
        pendingReason: null,
      },
      appliedGeneration: 1,
      rolledOut: false,
      readyReplicas: 1,
      containerReady: true,
      containerRunning: true,
      containerFailed: false,
      podTerminating: false,
      probeConfigured: true,
      observedAt: 1,
      ...overrides,
    },
  };
}
function executions(...ids: string[]): TargetedJobStatusSnapshot {
  return {
    counts: { ...empty.counts, running: ids.length, unreleased: ids.length },
    blockers: ids.map((jobId) => ({
      jobId,
      executionId: `execution-${jobId}`,
      generation: 1,
      state: WorkloadState.Running,
    })),
  };
}

describe('individual Deployment status', () => {
  it('starts until a revision that has not rolled out passes its probe', () => {
    const jobs = executions('first');
    for (const containerReady of [false, true, false, true]) {
      const status = deriveDeploymentStatus(
        deployment,
        jobs,
        observed({ containerReady }),
      );
      expect(status).toMatchObject({
        state: containerReady ? WorkloadState.Running : WorkloadState.Starting,
        ready: containerReady,
        upgrade: null,
        applicationReady: containerReady,
        requestedGeneration: 1,
        appliedGeneration: 1,
        podGeneration: 1,
        podUid: 'pod-1',
        containerId: 'containerd://1',
        blockingJobs: { total: 0, jobs: [] },
      });
      expect(deploymentStatusSchema.parse(status)).toEqual(status);
    }
    expect(jobs.counts.unreleased).toBe(1);
  });

  it.each([false, true])(
    'waits for every replica to be ready even when the selected Pod is healthy (rolled out: %s)',
    (rolledOut) => {
      const record = { ...deployment, minReplicas: 2, maxReplicas: 2 };
      expect(
        deriveDeploymentStatus(record, empty, observed({ rolledOut })),
      ).toMatchObject({
        state: rolledOut ? WorkloadState.Running : WorkloadState.Starting,
        ready: false,
        readyReplicas: 1,
      });
      expect(
        deriveDeploymentStatus(
          record,
          empty,
          observed({ rolledOut, readyReplicas: 2 }),
        ),
      ).toMatchObject({ state: WorkloadState.Running, ready: true });
    },
  );

  it('keeps an upgrade running while Jobs on the previous revision drain and the Pod is replaced', () => {
    const next = { ...deployment, generation: 2 };
    expect(
      deriveDeploymentStatus(next, executions('first', 'second'), observed()),
    ).toMatchObject({
      state: WorkloadState.Running,
      upgrade: { number: 1, state: WorkloadState.Starting },
      requestedGeneration: 2,
      appliedGeneration: 1,
      podGeneration: 1,
      blockingJobs: { total: 2, jobs: [{ id: 'first' }, { id: 'second' }] },
    });
    const remaining = executions('second');
    remaining.blockers[0].state = WorkloadState.Completed;
    remaining.counts.running = 0;
    remaining.counts.terminal = 1;
    expect(deriveDeploymentStatus(next, remaining, observed())).toMatchObject({
      state: WorkloadState.Running,
      upgrade: { number: 1, state: WorkloadState.Starting },
      blockingJobs: {
        total: 1,
        jobs: [{ id: 'second', state: WorkloadState.Completed }],
      },
    });
    expect(deriveDeploymentStatus(next, empty, observed())).toMatchObject({
      state: WorkloadState.Running,
      upgrade: { number: 1, state: WorkloadState.Starting },
      reason: 'Replacing the Pod with revision 2; new Jobs wait.',
    });
    const replacing = {
      appliedGeneration: 2,
      workload: {
        observedGeneration: 2,
        podName: 'replacement',
        podUid: 'pod-2',
        containerId: 'containerd://2',
        containerReady: true,
        pendingReason: null,
      },
    };
    expect(
      deriveDeploymentStatus(
        next,
        empty,
        observed({ ...replacing, containerReady: false }),
      ),
    ).toMatchObject({
      state: WorkloadState.Running,
      upgrade: { number: 1, state: WorkloadState.Starting },
    });
    const replacement = observed(replacing);
    expect(deriveDeploymentStatus(next, empty, replacement)).toMatchObject({
      state: WorkloadState.Running,
      upgrade: { number: 1, state: WorkloadState.Running },
      requestedGeneration: 2,
      appliedGeneration: 2,
      podGeneration: 2,
      podUid: 'pod-2',
      containerId: 'containerd://2',
      blockingJobs: { total: 0, jobs: [] },
    });
  });

  it('uses the observed Pod probe rather than the next desired configuration', () => {
    expect(
      deriveDeploymentStatus(
        { ...deployment, readinessProbe: null },
        empty,
        observed(),
      ),
    ).toMatchObject({
      state: WorkloadState.Running,
      reason: 'The readiness probe passes; new Jobs can start.',
      probeConfigured: true,
      applicationReady: true,
    });
    expect(
      deriveDeploymentStatus(
        deployment,
        empty,
        observed({ probeConfigured: false }),
      ),
    ).toMatchObject({
      state: WorkloadState.Running,
      reason: 'The container is ready; no readiness probe is set.',
      containerReady: true,
      probeConfigured: false,
      applicationReady: null,
    });
  });

  it('retains database drain blockers while unavailable runtime facts remain unknown', () => {
    const snapshot = executions(
      ...Array.from({ length: 10 }, (_, index) => `job-${index}`),
    );
    snapshot.counts.unreleased = 13;
    const status = deriveDeploymentStatus(
      { ...deployment, generation: 2 },
      snapshot,
      { kind: 'unavailable', message: 'offline' },
    );
    expect(status).toMatchObject({
      state: WorkloadState.Running,
      upgrade: { number: 1, state: WorkloadState.Starting },
      observation: 'unavailable',
      observationError: 'offline',
      appliedGeneration: null,
      podGeneration: null,
      containerReady: null,
      applicationReady: null,
      blockingJobs: { total: 13 },
    });
    expect(status.blockingJobs.jobs).toHaveLength(10);
    expect(deploymentStatusSchema.parse(status)).toEqual(status);
    expect(
      deploymentStatusSchema.safeParse({
        ...status,
        blockingJobs: {
          total: 13,
          jobs: [...status.blockingJobs.jobs, status.blockingJobs.jobs[0]],
        },
      }).success,
    ).toBe(false);
  });

  it('keeps missing identity and terminating containers from reporting ready', () => {
    const unknownPod = observed({
      workload: {
        observedGeneration: null,
        podName: 'pod',
        podUid: 'uid',
        containerId: 'container',
        containerReady: true,
        pendingReason: null,
      },
    });
    expect(deriveDeploymentStatus(deployment, empty, unknownPod).state).toBe(
      'unknown',
    );
    expect(
      deriveDeploymentStatus(deployment, empty, {
        kind: 'unavailable',
        message: 'offline',
      }),
    ).toMatchObject({ state: 'unknown', upgrade: null });
    expect(
      deriveDeploymentStatus(
        deployment,
        empty,
        observed({
          podTerminating: true,
          containerRunning: false,
          containerReady: false,
        }),
      ),
    ).toMatchObject({
      state: WorkloadState.Starting,
      reason: 'Replacing the Pod with revision 1; new Jobs wait.',
      applicationReady: null,
    });
    expect(
      deriveDeploymentStatus(
        deployment,
        empty,
        observed({
          containerRunning: false,
          containerReady: null,
          probeConfigured: null,
        }),
      ),
    ).toMatchObject({ state: WorkloadState.Starting, applicationReady: null });
  });

  it('fails a container Kubernetes keeps retrying, including during an upgrade', () => {
    const crashing = observed({
      containerRunning: false,
      containerReady: false,
      containerFailed: true,
      workload: {
        observedGeneration: 2,
        podName: 'worker-pod',
        podUid: 'pod-2',
        containerId: null,
        containerReady: false,
        pendingReason: 'CrashLoopBackOff: back-off restarting',
      },
      appliedGeneration: 2,
    });
    expect(
      deriveDeploymentStatus({ ...deployment, generation: 2 }, empty, crashing),
    ).toMatchObject({
      state: WorkloadState.Failed,
      upgrade: { number: 1, state: WorkloadState.Failed },
      reason: 'CrashLoopBackOff: back-off restarting',
    });
  });

  it('keeps an upgrade starting while it replaces a crash-looping Pod', () => {
    const crashingOld = observed({
      appliedGeneration: 2,
      containerRunning: false,
      containerReady: false,
      containerFailed: true,
      workload: {
        observedGeneration: 1,
        podName: 'worker-pod',
        podUid: 'pod-1',
        containerId: null,
        containerReady: false,
        pendingReason: 'CrashLoopBackOff: back-off restarting',
      },
    });
    expect(
      deriveDeploymentStatus(
        { ...deployment, generation: 2 },
        empty,
        crashingOld,
      ),
    ).toMatchObject({
      state: WorkloadState.Running,
      upgrade: { number: 1, state: WorkloadState.Starting },
      reason: 'Replacing the Pod with revision 2; new Jobs wait.',
    });
  });

  it('keeps Upgrade N starting while the Pod is unidentified', () => {
    const unidentified = observed({
      appliedGeneration: 2,
      workload: {
        observedGeneration: null,
        podName: 'pod',
        podUid: 'uid',
        containerId: 'container',
        containerReady: true,
        pendingReason: null,
      },
    });
    expect(
      deriveDeploymentStatus(
        { ...deployment, generation: 2 },
        empty,
        unidentified,
      ),
    ).toMatchObject({
      state: 'unknown',
      upgrade: { number: 1, state: WorkloadState.Starting },
    });
  });

  it('stays running with readiness lost once a revision has rolled out', () => {
    const revision2 = {
      appliedGeneration: 2,
      workload: {
        observedGeneration: 2,
        podName: 'worker-pod',
        podUid: 'pod-2',
        containerId: 'containerd://2',
        containerReady: false,
        pendingReason: null,
      },
    };
    for (const [stored, upgrade, overrides] of [
      [deployment, null, {}],
      [
        { ...deployment, generation: 2 },
        { number: 1, state: WorkloadState.Running },
        revision2,
      ],
    ] as const) {
      expect(
        deriveDeploymentStatus(
          stored,
          empty,
          observed({ ...overrides, rolledOut: true, containerReady: false }),
        ),
      ).toMatchObject({
        state: WorkloadState.Running,
        ready: false,
        upgrade,
        applicationReady: false,
        reason: 'Waiting for the readiness probe to pass; new Jobs wait.',
      });
    }
    expect(
      deriveDeploymentStatus(
        deployment,
        empty,
        observed({
          rolledOut: true,
          containerRunning: false,
          containerReady: false,
          containerFailed: true,
          workload: {
            observedGeneration: 1,
            podName: 'worker-pod',
            podUid: 'pod-1',
            containerId: null,
            containerReady: false,
            pendingReason: 'CrashLoopBackOff: back-off restarting',
          },
        }),
      ),
    ).toMatchObject({
      state: WorkloadState.Running,
      ready: false,
      reason: 'CrashLoopBackOff: back-off restarting',
    });
  });

  it('keeps an upgrade starting while only the previous revision has rolled out', () => {
    // The native Deployment's rollout still reflects revision 1.
    expect(
      deriveDeploymentStatus(
        { ...deployment, generation: 2 },
        empty,
        observed({ rolledOut: true }),
      ),
    ).toMatchObject({
      state: WorkloadState.Running,
      ready: false,
      upgrade: { number: 1, state: WorkloadState.Starting },
    });
  });

  it('keeps a Recreate upgrade starting between its old and new Pods', () => {
    // The old Pod is gone, and the native rollout condition is still the
    // previous revision's.
    expect(
      deriveDeploymentStatus({ ...deployment, generation: 2 }, empty, {
        ...observed({
          appliedGeneration: 2,
          rolledOut: true,
          containerRunning: false,
          containerReady: null,
          probeConfigured: null,
          workload: {
            observedGeneration: null,
            podName: null,
            podUid: null,
            containerId: null,
            containerReady: false,
            pendingReason: null,
          },
        }),
      }),
    ).toMatchObject({
      state: WorkloadState.Running,
      ready: false,
      upgrade: { number: 1, state: WorkloadState.Starting },
    });
  });

  it('terminates on deletion and releases until its Jobs are cleaned up', () => {
    const deleting = { ...deployment, deletionRequestedAt: 2 };
    expect(
      deriveDeploymentStatus(deleting, executions('first'), observed()),
    ).toMatchObject({
      state: WorkloadState.Terminated,
      releasing: true,
      upgrade: null,
      blockingJobs: { total: 1 },
    });
    expect(deriveDeploymentStatus(deleting, empty, observed())).toMatchObject({
      state: WorkloadState.Terminated,
      releasing: true,
      blockingJobs: { total: 0 },
    });
    expect(
      deriveDeploymentStatus({ ...deleting, deletedAt: 3 }, empty, {
        kind: 'not-requested',
      }),
    ).toMatchObject({
      state: WorkloadState.Terminated,
      releasing: false,
      applicationReady: null,
      observation: 'not-requested',
    });
  });
});
