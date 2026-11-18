import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import config from '../../../../src/api/config.js';
import {
  getWorkloadLifecycle as lifecycle,
  resetPersistence,
  getProvisioningAttemptStore as ledger,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
  getWorkloadOutcomes as outcomes,
} from '../../../../src/api/services/persistence.js';
import {
  walkToState,
  provisionTestVm,
  releaseTestVms,
  preemptTestVm,
} from '../../../helpers/workload-store.js';
import { getDB } from '../../../../src/api/services/repositories/db.js';
import { CloudType } from '../../../../src/shared/cloud.js';
import {
  WorkloadState,
  WorkloadType,
} from '../../../../src/shared/workload.js';
import { explainQueryPlan } from '../../helpers/query-plan.js';
import { createWorkload } from '../../../../src/api/services/repositories/workload-creation.js';

describe('WorkloadLifecycleStore', () => {
  const baseWorkload = {
    userId: 'test-user',
    workloadType: 'job' as const,
    image: 'alpine:latest',
    cloudProvider: CloudType.GCP,
    region: 'us-central1',
    vmType: 'n2-standard-4',
    dockerCommand: 'echo hello',
    sshPrivateKey: 'test-key',
    credentialId: 'test-cred',
  };

  beforeEach(async () => {
    config.cipherKey = randomBytes(32).toString('hex');
    resetPersistence();
    for (const id of ['test-cred', 'test-credential-id']) {
      await getDB().query(
        `INSERT OR IGNORE INTO credentials (id, encrypted_data, cloud_provider) VALUES (?, '', 'AWS')`,
        [id],
      );
    }
  });

  describe('claimRecovery', () => {
    async function runningWorkload(id: string): Promise<void> {
      await createWorkload(getDB(), { ...baseWorkload, id });
      await provisionTestVm(id, {
        ip: '1.2.3.4',
        cloudId: 'old-cloud-id',
      });
      await walkToState(id, WorkloadState.Running);
    }

    it('claims the observed VM and marks it preempted with the recovery event', async () => {
      const id = 'recovery-claim';
      await runningWorkload(id);

      expect(
        await lifecycle().claimRecovery(id, WorkloadState.Running, {
          metadata: { reason: 'cloud-confirmed preemption' },
          vm: {
            ip: '1.2.3.4',
            cloudId: 'old-cloud-id',
            markPreempted: true,
          },
        }),
      ).toBe(true);
      const store = queries();
      expect((await store.getWorkload(id))?.state).toBe(
        WorkloadState.Recovering,
      );
      expect((await store.getVMs(id))[0]?.preempt).toBe(1);
      expect(
        (await eventLog().getWorkloadEvents(id)).at(-1)?.metadata,
      ).toContain('cloud-confirmed preemption');
    });

    it('leaves state, VM and event ledger unchanged when the observed VM is stale', async () => {
      const id = 'stale-recovery-claim';
      await runningWorkload(id);
      const store = queries();
      const eventsBefore = await eventLog().getWorkloadEvents(id);

      expect(
        await lifecycle().claimRecovery(id, WorkloadState.Running, {
          vm: { ip: '1.2.3.4', cloudId: 'different-vm' },
        }),
      ).toBe(false);
      expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Running);
      expect((await store.getVMs(id))[0]?.preempt).not.toBe(1);
      expect(await eventLog().getWorkloadEvents(id)).toEqual(eventsBefore);
    });
  });

  describe('updateState and claimStep FSM enforcement', () => {
    it('blocks Finalizing → Recovering', async () => {
      await createWorkload(getDB(), {
        ...baseWorkload,
        id: 'fsm-finalizing-recovery',
      });
      await walkToState('fsm-finalizing-recovery', WorkloadState.Running);
      await lifecycle().updateState(
        'fsm-finalizing-recovery',
        WorkloadState.Finalizing,
        {
          metadata: {
            targetState: WorkloadState.Completed,
            workloadExitCode: 0,
            attempt: 0,
            maxAttempts: 20,
          },
        },
      );

      expect(
        await lifecycle().updateState(
          'fsm-finalizing-recovery',
          WorkloadState.Recovering,
          { metadata: { reason: 'should not recover final artifacts' } },
        ),
      ).toBe(false);
    });

    it('blocks invalid FSM transition (Queued → Running)', async () => {
      await createWorkload(getDB(), { ...baseWorkload, id: 'fsm-test-2' });
      const updated = await lifecycle().updateState(
        'fsm-test-2',
        WorkloadState.Running,
      );
      expect(updated).toBe(false);
      const d = await queries().getWorkload('fsm-test-2');
      expect(d?.state).toBe(WorkloadState.Queued);
    });

    it('allows self-transition (Provisioning → Provisioning)', async () => {
      await createWorkload(getDB(), { ...baseWorkload, id: 'fsm-test-3' });
      await walkToState('fsm-test-3', WorkloadState.Provisioning);
      const updated = await lifecycle().updateState(
        'fsm-test-3',
        WorkloadState.Provisioning,
      );
      expect(updated).toBe(true);
    });

    it('does not insert an event when FSM blocks the transition', async () => {
      await createWorkload(getDB(), { ...baseWorkload, id: 'fsm-test-4' });
      await walkToState('fsm-test-4', WorkloadState.Terminated);

      const before = await getDB().query<{ count: number }>(
        'SELECT COUNT(*) as count FROM workload_events WHERE workload_id = ?',
        ['fsm-test-4'],
      );
      const countBefore = before[0].count;

      // Initializing is not a valid target from Terminated.
      await lifecycle().updateState('fsm-test-4', WorkloadState.Initializing);

      const after = await getDB().query<{ count: number }>(
        'SELECT COUNT(*) as count FROM workload_events WHERE workload_id = ?',
        ['fsm-test-4'],
      );
      expect(after[0].count).toBe(countBefore);
    });

    it('blocks transitions out of terminal states', async () => {
      await createWorkload(getDB(), { ...baseWorkload, id: 'fsm-test-7' });
      await walkToState('fsm-test-7', WorkloadState.Terminated);
      // Terminated → anything is invalid
      const updated = await lifecycle().updateState(
        'fsm-test-7',
        WorkloadState.Running,
      );
      expect(updated).toBe(false);
      const d = await queries().getWorkload('fsm-test-7');
      expect(d?.state).toBe(WorkloadState.Terminated);
    });

    it('allows Starting → Downloading (resumeOnExistingVM re-pull)', async () => {
      await createWorkload(getDB(), { ...baseWorkload, id: 'fsm-test-8' });
      await walkToState('fsm-test-8', WorkloadState.Starting);
      const updated = await lifecycle().updateState(
        'fsm-test-8',
        WorkloadState.Downloading,
      );
      expect(updated).toBe(true);
      const d = await queries().getWorkload('fsm-test-8');
      expect(d?.state).toBe(WorkloadState.Downloading);
    });

    it.each([WorkloadState.Starting, WorkloadState.Running])(
      'keeps generic Recovering → %s transitions blocked',
      async (targetState) => {
        const id = `fsm-generic-recovery-${targetState}`;
        await createWorkload(getDB(), { ...baseWorkload, id });
        await walkToState(id, WorkloadState.Recovering);

        expect(await lifecycle().updateState(id, targetState)).toBe(false);
        expect((await queries().getWorkload(id))?.state).toBe(
          WorkloadState.Recovering,
        );
      },
    );
  });

  describe('finishPreemptionRecovery', () => {
    it.each([
      [WorkloadType.Job, WorkloadState.Starting],
      [WorkloadType.Service, WorkloadState.Running],
    ] as const)(
      'finishes scoped %s in-place recovery as %s',
      async (workloadType, targetState) => {
        const id = `fsm-scoped-recovery-${workloadType}`;
        await createWorkload(getDB(), {
          ...baseWorkload,
          id,
          workloadType,
        });
        await provisionTestVm(id, {
          ip: '1.2.3.4',
          cloudId: 'old-cloud-id',
        });
        await preemptTestVm(id, 'old-cloud-id');
        await getDB().query(
          `UPDATE workload_events
           SET metadata = 'not valid json'
           WHERE workload_id = ? AND state = ?`,
          [id, WorkloadState.Recovering],
        );

        expect(
          await lifecycle().finishPreemptionRecovery(
            id,
            workloadType,
            'old-cloud-id',
            { ip: '5.6.7.8', cloudId: 'new-cloud-id' },
          ),
        ).toBe(true);
        expect((await queries().getWorkload(id))?.state).toBe(targetState);
        expect(await queries().getVMs(id)).toMatchObject([
          { ip: '5.6.7.8', cloudId: 'new-cloud-id' },
        ]);
      },
    );

    it('does not finish in-place recovery after termination wins', async () => {
      await createWorkload(getDB(), {
        ...baseWorkload,
        id: 'fsm-scoped-recovery-terminated',
      });
      await provisionTestVm('fsm-scoped-recovery-terminated', {
        ip: '1.2.3.4',
        cloudId: 'old-cloud-id',
      });
      await walkToState(
        'fsm-scoped-recovery-terminated',
        WorkloadState.Terminated,
      );

      expect(
        await lifecycle().finishPreemptionRecovery(
          'fsm-scoped-recovery-terminated',
          WorkloadType.Job,
          'old-cloud-id',
          { ip: '5.6.7.8', cloudId: 'new-cloud-id' },
        ),
      ).toBe(false);
      expect(
        (await queries().getWorkload('fsm-scoped-recovery-terminated'))?.state,
      ).toBe(WorkloadState.Terminated);
      expect(
        await queries().getVMs('fsm-scoped-recovery-terminated'),
      ).toMatchObject([{ ip: '1.2.3.4', cloudId: 'old-cloud-id' }]);
    });

    it('does not finish stale recovery when its preempted VM row is gone', async () => {
      const id = 'fsm-scoped-recovery-stale-vm';
      await createWorkload(getDB(), { ...baseWorkload, id });
      await provisionTestVm(id, {
        ip: '1.2.3.4',
        cloudId: 'old-cloud-id',
      });
      await preemptTestVm(id, 'old-cloud-id');
      await releaseTestVms(id, 'old-cloud-id');

      expect(
        await lifecycle().finishPreemptionRecovery(
          id,
          WorkloadType.Job,
          'old-cloud-id',
          { ip: '5.6.7.8', cloudId: 'new-cloud-id' },
        ),
      ).toBe(false);
      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Recovering,
      );
      expect(
        (await ledger().getProvisioningAttempts(id)).map((vm) => vm.cloud_id),
      ).toEqual(['old-cloud-id']);
    });

    it('does not charge successful in-place restarts to the retry budget', async () => {
      const id = 'fsm-successful-recovery-budget';
      await createWorkload(getDB(), { ...baseWorkload, id });
      await provisionTestVm(id, {
        ip: '1.2.3.4',
        cloudId: 'old-cloud-id',
      });
      await preemptTestVm(id, 'old-cloud-id');
      await lifecycle().finishPreemptionRecovery(
        id,
        WorkloadType.Job,
        'old-cloud-id',
        { ip: '5.6.7.8', cloudId: 'new-cloud-id' },
      );

      // A later failed recovery should count once; the prior successful
      // in-place restart must not consume a retry attempt.
      await walkToState(id, WorkloadState.Recovering);

      expect(
        (await lifecycle().getRetryCandidatesByIds([id]))[0]?.retryCount,
      ).toBe(1);
    });
  });

  describe('releaseEmptyProvisioningAdmission', () => {
    it('releases only an empty Provisioning admission back to Queued', async () => {
      await createWorkload(getDB(), { ...baseWorkload, id: 'empty-admission' });
      await walkToState('empty-admission', WorkloadState.Provisioning);

      expect(
        await lifecycle().releaseEmptyProvisioningAdmission('empty-admission'),
      ).toBe(true);
      expect((await queries().getWorkload('empty-admission'))?.state).toBe(
        WorkloadState.Queued,
      );
      expect(
        await lifecycle().releaseEmptyProvisioningAdmission('empty-admission'),
      ).toBe(false);
      const events = await eventLog().getWorkloadEvents('empty-admission');
      expect(JSON.parse(events.at(-1)!.metadata!)).toMatchObject({
        reason: 'empty-provisioning-admission-released',
      });

      await createWorkload(getDB(), {
        ...baseWorkload,
        id: 'admission-with-attempt',
      });
      await walkToState('admission-with-attempt', WorkloadState.Provisioning);
      expect(
        await lifecycle().claimStep(
          'admission-with-attempt',
          WorkloadState.Provisioning,
        ),
      ).not.toBeNull();
      await ledger().beginProvisioningAttempt(
        'admission-with-attempt',
        'admission-with-attempt-0',
      );
      expect(
        await lifecycle().releaseEmptyProvisioningAdmission(
          'admission-with-attempt',
        ),
      ).toBe(false);
      expect(
        (await queries().getWorkload('admission-with-attempt'))?.state,
      ).toBe(WorkloadState.Provisioning);

      await createWorkload(getDB(), {
        ...baseWorkload,
        id: 'admission-with-vm',
      });
      await provisionTestVm('admission-with-vm', {
        cloudId: 'i-live',
        ip: '1.2.3.4',
      });
      await walkToState('admission-with-vm', WorkloadState.Provisioning);
      expect(
        await lifecycle().releaseEmptyProvisioningAdmission(
          'admission-with-vm',
        ),
      ).toBe(false);
      expect((await queries().getWorkload('admission-with-vm'))?.state).toBe(
        WorkloadState.Provisioning,
      );
    });
  });

  describe('getRetryCandidatesByIds', () => {
    it('returns resubmitCount reflecting number of resubmits', async () => {
      const id = 'resub-retry-1';
      await createWorkload(getDB(), { ...baseWorkload, id });

      // Simulate first round of retries
      await walkToState(id, WorkloadState.Provisioning);
      await lifecycle().updateState(id, WorkloadState.Retrying);
      const revision = (await queries().getWorkloadReconcileCandidate(id))!
        .revision;
      await lifecycle().queueRetryCandidate(id, revision);
      await walkToState(id, WorkloadState.Provisioning);
      await lifecycle().updateState(id, WorkloadState.Retrying);

      // Mark failed, then resubmit
      expect(
        await outcomes().publishTerminalOutcome(
          id,
          WorkloadState.Failed,
          WorkloadState.Retrying,
        ),
      ).toBe(true);
      expect(await outcomes().markCleanupComplete(id)).toBe(true);
      await outcomes().resubmitWorkload(id);

      // Second round — back to Retrying
      await walkToState(id, WorkloadState.Provisioning);
      await lifecycle().updateState(id, WorkloadState.Retrying);

      const [candidate] = await lifecycle().getRetryCandidatesByIds([id]);
      expect(candidate).toBeDefined();
      expect(candidate!.resubmitCount).toBe(1);
      // retryCount includes all historical Retrying events
      expect(candidate!.retryCount).toBe(3);
    });

    it('retries at once, without growing the backoff, while a failover has an untried target', async () => {
      const id = 'failover-untried';
      await createWorkload(getDB(), { ...baseWorkload, id });
      const failover = {
        disposition: 'failover-target',
        launchFailover: true,
      };
      const attempt = async (
        untriedTargets: number,
        metadata: Record<string, unknown>,
      ) => {
        // The scheduler's claim records what it saw; the deploy step's own
        // Provisioning event after it doesn't.
        await lifecycle().updateState(id, WorkloadState.Provisioning, {
          metadata: { untriedTargets },
        });
        await lifecycle().updateState(id, WorkloadState.Provisioning);
        await lifecycle().updateState(id, WorkloadState.Retrying, { metadata });
        const [candidate] = await lifecycle().getRetryCandidatesByIds([id]);
        await lifecycle().queueRetryCandidate(
          id,
          (await queries().getWorkloadReconcileCandidate(id))!.revision,
        );
        return candidate!;
      };
      await walkToState(id, WorkloadState.Queued);
      // A full region with two untried targets left, then one.
      expect(await attempt(2, failover)).toMatchObject({
        regionDenied: 1,
        deniedRetryCount: 1,
      });
      expect(await attempt(1, failover)).toMatchObject({
        regionDenied: 1,
        deniedRetryCount: 2,
      });
      // Every target tried: the backoff starts at its first step.
      expect(await attempt(0, failover)).toMatchObject({
        regionDenied: 0,
        retryCount: 3,
        deniedRetryCount: 2,
      });
      // A retry on the same target waits, untried targets or not.
      expect(
        await attempt(3, { disposition: 'retry-same-target' }),
      ).toMatchObject({ regionDenied: 0, deniedRetryCount: 2 });
      // So does a failover recorded against no attempt: the next claim can't
      // skip its target.
      expect(
        await attempt(3, { disposition: 'failover-target' }),
      ).toMatchObject({ regionDenied: 0, deniedRetryCount: 2 });
    });

    it('waits after a failover whose claims predate untried counts', async () => {
      const id = 'failover-older-data';
      await createWorkload(getDB(), { ...baseWorkload, id });
      await walkToState(id, WorkloadState.Provisioning);
      await lifecycle().updateState(id, WorkloadState.Retrying, {
        metadata: { disposition: 'failover-target', launchFailover: true },
      });
      const [candidate] = await lifecycle().getRetryCandidatesByIds([id]);
      expect(candidate).toMatchObject({ regionDenied: 0, deniedRetryCount: 0 });
    });

    it('returns resubmitCount 0 when never resubmitted', async () => {
      const id = 'resub-retry-2';
      await createWorkload(getDB(), { ...baseWorkload, id });

      await walkToState(id, WorkloadState.Provisioning);
      await lifecycle().updateState(id, WorkloadState.Retrying);

      const [candidate] = await lifecycle().getRetryCandidatesByIds([id]);
      expect(candidate).toBeDefined();
      expect(candidate!.resubmitCount).toBe(0);
      expect(candidate!.retryCount).toBe(1);
    });

    it('bounded retry hydration probes event history by workload id', async () => {
      const { tmpdir } = await import('os');
      const { join } = await import('path');
      const { rmSync } = await import('fs');

      const dbFile = join(
        tmpdir(),
        `anycloud-retry-hydration-idx-spec-${process.pid}.db`,
      );
      rmSync(dbFile, { force: true });
      vi.stubEnv('SQLITE_PATH', dbFile);
      resetPersistence();
      try {
        const querySpy = vi.spyOn(getDB(), 'query');
        await lifecycle().getRetryCandidatesByIds(['missing-retry']);
        const call = querySpy.mock.calls.find(
          (candidate) =>
            typeof candidate[0] === 'string' &&
            candidate[0].includes('d.id IN ('),
        );
        expect(call).toBeDefined();
        const [sql, params] = call!;

        {
          const details = explainQueryPlan(dbFile, sql, params ?? []);
          const detailText = details.join('\n');

          expect(detailText).toContain('idx_events_workload_id');
          expect(detailText).toContain('idx_events_resubmit');
          expect(
            details.filter(
              (detail) =>
                detail.includes('SCAN workload_events') &&
                !detail.includes('USING'),
            ),
          ).toEqual([]);
        }
      } finally {
        vi.unstubAllEnvs();
        resetPersistence();
        rmSync(dbFile, { force: true });
      }
    });

    it('resubmitCount counts real resubmit events only, not metadata mentioning the word', async () => {
      resetPersistence();
      await getDB().query(
        `INSERT OR IGNORE INTO credentials (id, encrypted_data, cloud_provider) VALUES ('test-credential-id', '', 'AWS')`,
      );
      await createWorkload(getDB(), {
        id: 'idx-resubmit-test',
        userId: 'test-user',
        workloadType: 'job',
        image: 'alpine:latest',
        requestedComputeProvider: CloudType.AWS,
        region: 'us-east-1',
        vmType: 't3.medium',
        dockerCommand: 'docker run alpine',
        sshPrivateKey: 'ssh-ed25519-test-private-key',
        credentialId: 'test-credential-id',
      });
      await getDB().query(`UPDATE workloads SET state = ? WHERE id = ?`, [
        WorkloadState.Retrying,
        'idx-resubmit-test',
      ]);
      const insertEvent = (state: string, metadata: string, at: number) =>
        getDB().query(
          `INSERT INTO workload_events (workload_id, state, metadata, created_at) VALUES (?, ?, ?, ?)`,
          ['idx-resubmit-test', state, metadata, at],
        );
      // The retry event that makes the workload visible to reconciliation.
      await insertEvent(WorkloadState.Retrying, '{}', 1000);
      // A real resubmit, as written by resubmitWorkload.
      await insertEvent(
        WorkloadState.Queued,
        JSON.stringify({ reason: 'resubmitted' }),
        2000,
      );
      // A decoy: error text merely containing the word. The old LIKE
      // '%resubmitted%' miscounted this as a resubmit.
      await insertEvent(
        WorkloadState.Errored,
        JSON.stringify({ error: 'VM died after job was resubmitted upstream' }),
        3000,
      );
      // Corrupt legacy metadata is excluded by the guarded partial index and
      // must not break retry hydration.
      await insertEvent(WorkloadState.Recovering, 'not valid json', 4000);

      const [row] = await lifecycle().getRetryCandidatesByIds([
        'idx-resubmit-test',
      ]);
      expect(row).toBeDefined();
      expect(row.retryCount).toBe(2);
      expect(row.resubmitCount).toBe(1);
    });

    it('excludes retrying workloads that have no retry/recovery event', async () => {
      resetPersistence();
      await getDB().query(
        `INSERT OR IGNORE INTO credentials (id, encrypted_data, cloud_provider) VALUES ('test-credential-id', '', 'AWS')`,
      );
      await createWorkload(getDB(), {
        id: 'retry-state-no-event',
        userId: 'test-user',
        workloadType: 'job',
        image: 'alpine:latest',
        requestedComputeProvider: CloudType.AWS,
        region: 'us-east-1',
        vmType: 't3.medium',
        dockerCommand: 'docker run alpine',
        sshPrivateKey: 'ssh-ed25519-test-private-key',
        credentialId: 'test-credential-id',
      });
      await getDB().query(`UPDATE workloads SET state = ? WHERE id = ?`, [
        WorkloadState.Retrying,
        'retry-state-no-event',
      ]);

      expect(
        await lifecycle().getRetryCandidatesByIds(['retry-state-no-event']),
      ).toEqual([]);
    });
  });
});
