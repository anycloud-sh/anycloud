import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getDeploymentStore,
  getPersistence,
  resetPersistence,
  getWorkloadLifecycle,
  getWorkloadQueryStore as queries,
  getDeploymentExecutionStore,
  getWorkloadOutcomes,
} from '../../../src/api/services/persistence.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { makeContainerSpec } from '../helpers/fixtures.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import { seedReadyNodePool } from '../helpers/node-pool-seed.js';
import { getWorkloadAdmissionWriter } from '../../../src/api/services/workload-admission-writer.js';

const owner = { kind: 'api' } as const;
const runtime = {
  deploymentId: 'deployment',
  generation: 1,
  podUid: 'pod',
  containerId: 'container',
};
const store = () => getDeploymentExecutionStore();
const deployment = (id = 'deployment') => ({
  id,
  name: id,
  ownerUserId: 'owner',
  nodePoolId: 'pool',
  config: makeContainerSpec(),
  secretNames: [],
  gpuCount: 0,
  maxConcurrentJobsPerReplica: 2,
});
const claim = (jobId = 'job') => ({
  ...runtime,
  jobId,
  submissionRevision: 0,
  previousExecutionId: null,
  executionId: randomUUID(),
});
const admit = (
  id = 'job',
  options: { deploymentId?: string; claimDeadlineAt?: number } = {},
) =>
  getWorkloadAdmissionWriter().createTargetedWorkload({
    id,
    deploymentId: 'deployment',
    userId: 'owner',
    ownerUserId: 'owner',
    ...options,
  });

beforeEach(async () => {
  resetPersistence();
  await seedReadyNodePool({ nodePoolId: 'pool', ownerUserId: 'owner' });
  await getDeploymentStore().create(deployment(), owner);
});
afterEach(() => vi.restoreAllMocks());

describe('committed Deployment availability notifications', () => {
  it('uses the composition channel for admissions and isolates other targets', async () => {
    const changes = getPersistence().jobChanges;
    const notify = vi.spyOn(changes, 'notifyDeployment');
    const waiting = changes.subscribeDeployment(
      'deployment',
      undefined,
      performance.now() + 20_000,
    );
    const job = changes.subscribe('job', undefined, performance.now() + 20_000);
    try {
      await admit();
      await expect(waiting.promise).resolves.toBe('changed');
      await expect(job.promise).resolves.toBe('changed');
      expect(notify.mock.calls).toEqual([['deployment', { waiters: 1 }]]);
      expect(await queries().getWorkload('job')).toMatchObject({
        state: WorkloadState.Queued,
        currentExecutionId: null,
      });
      expect(await getDB().query('SELECT * FROM workload_events')).toEqual([]);
      await getDeploymentStore().create(deployment('other'), owner);
      notify.mockClear();
      await admit('other-job', { deploymentId: 'other' });
      expect(notify.mock.calls).toEqual([['other', { waiters: 1 }]]);
    } finally {
      waiting.dispose();
      job.dispose();
    }
  });

  it('notifies claims, generic termination, and cleanup only for committed changes', async () => {
    await admit();
    const selected = claim();
    const notify = vi.spyOn(getPersistence().jobChanges, 'notifyDeployment');
    expect(await store().claimTargetedJob(selected)).toMatchObject({
      kind: 'selected',
    });
    expect(notify.mock.calls).toEqual([['deployment', { waiters: 1 }]]);
    notify.mockClear();
    expect(await store().claimTargetedJob(selected)).toMatchObject({
      kind: 'selected',
    });
    expect(await store().claimTargetedJob(claim())).toMatchObject({
      kind: 'stale',
    });
    expect(notify).not.toHaveBeenCalled();
    await getWorkloadOutcomes().requestTermination('job', owner);
    expect(notify.mock.calls).toEqual([['deployment', { waiters: 1 }]]);
    expect(await store().countTargetedJobs('deployment')).toMatchObject({
      unreleased: 1,
    });
    notify.mockClear();
    expect(await store().completeTargetedJobCleanup('job', randomUUID())).toBe(
      false,
    );
    expect(notify).not.toHaveBeenCalled();
    expect(
      await store().completeTargetedJobCleanup('job', selected.executionId),
    ).toBe(true);
    expect(notify.mock.calls).toEqual([['deployment', { waiters: 1 }]]);
    expect(await store().countTargetedJobs('deployment')).toMatchObject({
      unreleased: 0,
    });
    notify.mockClear();
    expect(
      await store().completeTargetedJobCleanup('job', selected.executionId),
    ).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });

  it.each(['application report', 'runtime loss'] as const)(
    'notifies %s and subsequent retry admission without stale-revision hints',
    async (writer) => {
      await admit();
      const selected = claim();
      await store().claimTargetedJob(selected);
      const notify = vi.spyOn(getPersistence().jobChanges, 'notifyDeployment');
      if (writer === 'application report')
        await store().reportTargetedJobExecution('job', selected.executionId, {
          state: WorkloadState.Retrying,
          reason: 'retry',
        });
      else
        await store().reportTargetedJobExecution('job', selected.executionId, {
          state: WorkloadState.Retrying,
          reason: 'Pod replaced',
        });
      expect(notify.mock.calls).toEqual([['deployment', { waiters: 1 }]]);
      const candidate = await queries().getWorkloadReconcileCandidate('job');
      notify.mockClear();
      expect(
        await getWorkloadLifecycle().queueRetryCandidate(
          'job',
          candidate!.revision - 1,
        ),
      ).toBe('stale');
      expect(notify).not.toHaveBeenCalled();
      expect(
        await getWorkloadLifecycle().queueRetryCandidate(
          'job',
          candidate!.revision,
        ),
      ).toBe('queued');
      expect(notify.mock.calls).toEqual([['deployment', { waiters: 1 }]]);
      expect(await store().discoverTargetedJob(runtime)).toMatchObject({
        kind: 'candidate',
        candidate: { previousExecutionId: selected.executionId },
      });
    },
  );

  it('notifies terminal outcome reports and generic cleanup acknowledgements', async () => {
    await admit('reported');
    await admit('terminated');
    const reported = claim('reported');
    const terminated = claim('terminated');
    await store().claimTargetedJob(reported);
    await store().claimTargetedJob(terminated);
    const notify = vi.spyOn(getPersistence().jobChanges, 'notifyDeployment');
    await store().reportTargetedJobExecution('reported', reported.executionId, {
      state: WorkloadState.Completed,
    });
    expect(notify.mock.calls).toEqual([['deployment', { waiters: 1 }]]);
    await getWorkloadOutcomes().requestTermination('terminated', owner);
    notify.mockClear();
    await getWorkloadOutcomes().markCleanupComplete('terminated');
    expect(notify.mock.calls).toEqual([['deployment', { waiters: 1 }]]);
    expect(await store().countTargetedJobs('deployment')).toMatchObject({
      unreleased: 0,
    });
    notify.mockClear();
    await getWorkloadOutcomes().markCleanupComplete('terminated');
    await store().reportTargetedJobExecution('reported', reported.executionId, {
      state: WorkloadState.Completed,
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it('routes expiry, resubmission and bulk target deletion through the committed writer', async () => {
    await admit('expired', { claimDeadlineAt: 0 });
    const notify = vi.spyOn(getPersistence().jobChanges, 'notifyDeployment');
    expect(await store().expireDueTargetedJobSubmissions()).toBe(1);
    expect(notify.mock.calls).toEqual([['deployment', { waiters: 1 }]]);
    notify.mockClear();
    await getWorkloadOutcomes().resubmitWorkloadForScope('expired', owner);
    expect(notify.mock.calls).toEqual([['deployment', { waiters: 1 }]]);
    // Cross the routing query's parameter chunk while issuing one target hint.
    for (let index = 0; index < 257; index++) await admit(`queued-${index}`);
    notify.mockClear();
    await store().terminateUnassignedTargetedJobs('deployment');
    expect(notify.mock.calls).toEqual([['deployment', { waiters: 1 }]]);
    expect(await store().countTargetedJobs('deployment')).toMatchObject({
      queued: 0,
      unreleased: 0,
    });
    notify.mockClear();
    await store().terminateUnassignedTargetedJobs('deployment');
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not emit a claim hint or retain an execution when its history write rolls back', async () => {
    await admit();
    const notify = vi.spyOn(getPersistence().jobChanges, 'notifyDeployment');
    await getDB().query(
      "CREATE TRIGGER reject_claim_history BEFORE INSERT ON workload_events BEGIN SELECT RAISE(ABORT, 'injected claim rollback'); END",
    );
    try {
      await expect(store().claimTargetedJob(claim())).rejects.toThrow(
        'injected claim rollback',
      );
      expect(notify).not.toHaveBeenCalled();
      expect(await queries().getWorkload('job')).toMatchObject({
        state: WorkloadState.Queued,
        currentExecutionId: null,
      });
      expect(await getDB().query('SELECT * FROM workload_events')).toEqual([]);
    } finally {
      await getDB().query('DROP TRIGGER reject_claim_history');
    }
  });

  it('publishes generation and deletion changes through the same channel, including failed CAS and rollback', async () => {
    const deployments = getDeploymentStore();
    const notify = vi.spyOn(getPersistence().jobChanges, 'notifyDeployment');
    const update = {
      ...deployment(),
      expectedGeneration: 1,
      readinessProbe: { exec: { command: ['true'] } },
    };
    await getDB().query(
      "CREATE TRIGGER reject_spec_update BEFORE UPDATE ON container_specs BEGIN SELECT RAISE(ABORT, 'injected generation rollback'); END",
    );
    try {
      await expect(deployments.update(update, owner)).rejects.toThrow(
        'injected generation rollback',
      );
      expect(notify).not.toHaveBeenCalled();
      expect(await deployments.getById('deployment')).toMatchObject({
        generation: 1,
        readinessProbe: null,
      });
    } finally {
      await getDB().query('DROP TRIGGER reject_spec_update');
    }
    expect(await deployments.update(update, owner)).toBe(2);
    expect(notify.mock.calls).toEqual([['deployment']]);
    notify.mockClear();
    expect(await deployments.update(update, owner)).toBeNull();
    expect(notify).not.toHaveBeenCalled();
    expect(await deployments.requestDeletion('deployment', owner)).toBe(
      'requested',
    );
    expect(notify.mock.calls).toEqual([['deployment']]);
    notify.mockClear();
    expect(await deployments.requestDeletion('deployment', owner)).toBe(
      'already-requested',
    );
    expect(notify).not.toHaveBeenCalled();
    expect(await deployments.markDeleted('deployment')).toBe(true);
    expect(notify.mock.calls).toEqual([['deployment']]);
    notify.mockClear();
    expect(await deployments.markDeleted('deployment')).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });
});
