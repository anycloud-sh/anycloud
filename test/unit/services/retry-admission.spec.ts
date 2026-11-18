import { randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import config from '../../../src/api/config.js';
import type { CreateWorkloadInput } from '../../../src/api/services/repositories/workload-creation.js';
import {
  resetPersistence,
  getWorkloadLifecycle as lifecycle,
  getProvisioningAttemptStore as ledger,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
} from '../../../src/api/services/persistence.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import {
  walkToState,
  provisionTestVm,
  releaseTestVms,
} from '../../helpers/workload-store.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';

const workloadId = 'retry-admission';

type RetryInput = Partial<CreateWorkloadInput>;

/** Admit the fixture to Provisioning, where its VM attempts are registered. */
async function admitRetryWorkload(input: RetryInput = {}): Promise<void> {
  await createWorkload(getDB(), {
    id: workloadId,
    userId: 'test-user',
    workloadType: 'job',
    image: 'alpine:latest',
    requestedComputeProvider: CloudType.GCP,
    region: 'us-central1',
    vmType: 'n2-standard-4',
    dockerCommand: 'docker run alpine',
    sshPrivateKey: 'test-key',
    credentialId: null,
    ...input,
  });
  await walkToState(workloadId, WorkloadState.Provisioning);
}

/** Fail the admitted fixture at `failedAtState` and return its retry revision. */
async function failRetry(
  failedAtState = WorkloadState.Provisioning,
  retryState = WorkloadState.Retrying,
): Promise<number> {
  if (failedAtState !== WorkloadState.Provisioning) {
    await walkToState(workloadId, failedAtState);
  }
  await walkToState(workloadId, retryState);
  return (await queries().getWorkloadReconcileCandidate(workloadId))!.revision;
}

async function createRetry(
  failedAtState = WorkloadState.Provisioning,
  retryState = WorkloadState.Retrying,
  input: RetryInput = {},
): Promise<number> {
  await admitRetryWorkload(input);
  return failRetry(failedAtState, retryState);
}

async function addCompleteVM(cloudId = 'complete-vm'): Promise<void> {
  await provisionTestVm(workloadId, {
    cloudId,
    ip: '192.0.2.1',
  });
}

async function expectPending(revision: number): Promise<void> {
  const store = queries();
  const before = await eventLog().getWorkloadEvents(workloadId);
  await expect(
    lifecycle().getRetryVMEligibility(workloadId, revision),
  ).resolves.toBe('release-pending');
  await expect(
    lifecycle().queueRetryCandidate(workloadId, revision),
  ).resolves.toBe('release-pending');
  expect(await eventLog().getWorkloadEvents(workloadId)).toEqual(before);
  expect(
    (await store.getWorkloadReconcileCandidate(workloadId))?.revision,
  ).toBe(revision);
}

describe('retry admission', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(() => {
    resetPersistence();
  });

  it('waits for a no-IP attempt to end, then queues the revision exactly once', async () => {
    await admitRetryWorkload();
    await provisionTestVm(workloadId, { cloudId: 'booting-vm' });
    const revision = await failRetry();
    const store = queries();

    await expectPending(revision);
    expect((await store.getWorkload(workloadId))?.state).toBe(
      WorkloadState.Retrying,
    );
    expect(
      (await lifecycle().getRetryCandidatesByIds([workloadId]))[0],
    ).toMatchObject({
      retryCount: 1,
    });

    await releaseTestVms(workloadId, 'booting-vm');
    await expect(
      lifecycle().getRetryVMEligibility(workloadId, revision),
    ).resolves.toBe('ready');
    await expect(
      lifecycle().queueRetryCandidate(workloadId, revision),
    ).resolves.toBe('queued');
    await expect(
      lifecycle().queueRetryCandidate(workloadId, revision),
    ).resolves.toBe('stale');
    const events = await eventLog().getWorkloadEvents(workloadId);
    expect(
      events.filter(({ state }) => state === WorkloadState.Queued),
    ).toHaveLength(1);
    expect(events.at(-1)?.state).toBe(WorkloadState.Queued);
  });

  it.each([WorkloadState.Provisioning, WorkloadState.Initializing])(
    'requires release of a complete VM after %s fails',
    async (failedAtState) => {
      await admitRetryWorkload();
      await addCompleteVM();
      const revision = await failRetry(failedAtState);
      await expectPending(revision);
    },
  );

  it.each([
    WorkloadState.Downloading,
    WorkloadState.Syncing,
    WorkloadState.Starting,
  ])('preserves complete VM reuse after %s fails', async (failedAtState) => {
    await admitRetryWorkload();
    await addCompleteVM();
    const revision = await failRetry(failedAtState);
    const store = queries();
    await expect(
      lifecycle().getRetryVMEligibility(workloadId, revision),
    ).resolves.toBe('reuse');
    await expect(
      lifecycle().queueRetryCandidate(workloadId, revision),
    ).resolves.toBe('queued');
    expect(await store.getVMs(workloadId)).toHaveLength(1);
  });

  it('requires release when more than one complete VM remains', async () => {
    await admitRetryWorkload();
    await addCompleteVM();
    await addCompleteVM('second-complete-vm');
    const revision = await failRetry(WorkloadState.Downloading);
    await expectPending(revision);
  });

  it('requires release during recovery even if the preceding step permits reuse', async () => {
    await admitRetryWorkload();
    await addCompleteVM();
    const revision = await failRetry(
      WorkloadState.Starting,
      WorkloadState.Recovering,
    );
    await expectPending(revision);
  });

  it('keeps a requested complete VM pending after the no-IP attempt retires first', async () => {
    await admitRetryWorkload();
    await addCompleteVM();
    await provisionTestVm(workloadId, { cloudId: 'booting-vm' });
    const revision = await failRetry(WorkloadState.Downloading);
    await expectPending(revision);

    await ledger().claimVmRemoval(workloadId, ['complete-vm', 'booting-vm']);
    await releaseTestVms(workloadId, 'booting-vm');
    await expectPending(revision);

    await releaseTestVms(workloadId, 'complete-vm');
    await expect(
      lifecycle().getRetryVMEligibility(workloadId, revision),
    ).resolves.toBe('ready');
    await expect(
      lifecycle().queueRetryCandidate(workloadId, revision),
    ).resolves.toBe('queued');
  });

  it('rereads attempts inserted after the controller observed an empty ledger', async () => {
    await admitRetryWorkload();
    const ref = await ledger().beginProvisioningAttempt(
      workloadId,
      'late-attempt',
    );
    const revision = await failRetry();
    await releaseTestVms(workloadId, 'late-attempt');
    await expect(
      lifecycle().getRetryVMEligibility(workloadId, revision),
    ).resolves.toBe('ready');
    await ledger().completeProvisioningAttempt(workloadId, ref!, {
      cloudId: 'late-attempt',
      ip: '192.0.2.9',
    });
    await expectPending(revision);
  });

  it('rereads removal requests written after the controller observed reusable VMs', async () => {
    await admitRetryWorkload();
    await addCompleteVM();
    const revision = await failRetry(WorkloadState.Syncing);
    await expect(
      lifecycle().getRetryVMEligibility(workloadId, revision),
    ).resolves.toBe('reuse');
    await ledger().claimVmRemoval(workloadId, ['complete-vm']);
    await expectPending(revision);
  });

  it.each([WorkloadState.Retrying, WorkloadState.Terminated])(
    'rejects a revision superseded by a new %s event',
    async (nextState) => {
      const revision = await createRetry();
      const store = queries();
      await walkToState(workloadId, nextState);
      const before = await eventLog().getWorkloadEvents(workloadId);
      await expect(
        lifecycle().getRetryVMEligibility(workloadId, revision),
      ).resolves.toBe('stale');
      await expect(
        lifecycle().queueRetryCandidate(workloadId, revision),
      ).resolves.toBe('stale');
      expect(await eventLog().getWorkloadEvents(workloadId)).toEqual(before);
      expect((await store.getWorkload(workloadId))?.state).toBe(nextState);
    },
  );

  it('rolls back the queue transition if its event cannot be persisted', async () => {
    const revision = await createRetry();
    const store = queries();
    const before = await eventLog().getWorkloadEvents(workloadId);
    await getDB().query(
      `CREATE TRIGGER reject_queue_event BEFORE INSERT ON workload_events
       WHEN NEW.state = 'queued'
       BEGIN SELECT RAISE(ABORT, 'queue event rejected'); END`,
    );
    await expect(
      lifecycle().queueRetryCandidate(workloadId, revision),
    ).rejects.toThrow('queue event rejected');
    expect((await store.getWorkload(workloadId))?.state).toBe(
      WorkloadState.Retrying,
    );
    expect(await eventLog().getWorkloadEvents(workloadId)).toEqual(before);
  });

  it.each(['updateState', 'claimStep'] as const)(
    'prevents %s from bypassing retry admission',
    async (method) => {
      await admitRetryWorkload();
      await provisionTestVm(workloadId, { cloudId: 'pending-vm' });
      await failRetry();
      const store = queries();
      const before = await eventLog().getWorkloadEvents(workloadId);
      await expect(
        lifecycle()[method](workloadId, WorkloadState.Queued),
      ).rejects.toThrow('queued state must use an owned queue operation');
      expect((await store.getWorkload(workloadId))?.state).toBe(
        WorkloadState.Retrying,
      );
      expect(await eventLog().getWorkloadEvents(workloadId)).toEqual(before);
    },
  );

  it('derives VM ownership from a legacy attempt credential when no provider was requested', async () => {
    await admitRetryWorkload({ requestedComputeProvider: null });
    await getDB().query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider)
       VALUES ('vm-credential', '', ?)`,
      [CloudType.AWS],
    );
    await provisionTestVm(
      workloadId,
      { cloudId: 'legacy-vm', ip: '192.0.2.1' },
      { credentialId: 'vm-credential' },
    );
    const revision = await failRetry(WorkloadState.Downloading);
    await expect(
      lifecycle().getRetryVMEligibility(workloadId, revision),
    ).resolves.toBe('reuse');
    await expect(
      lifecycle().queueRetryCandidate(workloadId, revision),
    ).resolves.toBe('queued');
  });

  it('does not authorize VM reuse when durable execution ownership is unknown', async () => {
    await admitRetryWorkload({ requestedComputeProvider: null });
    await addCompleteVM();
    const revision = await failRetry(WorkloadState.Downloading);
    await expectPending(revision);
  });
});
