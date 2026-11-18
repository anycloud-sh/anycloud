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
  getWorkloadSpendStore as spend,
} from '../../../../src/api/services/persistence.js';
import {
  walkToState,
  provisionTestVm,
  releaseTestVms,
} from '../../../helpers/workload-store.js';
import { getDB } from '../../../../src/api/services/repositories/db.js';
import { CloudType } from '../../../../src/shared/cloud.js';
import {
  WorkloadState,
  WorkloadType,
} from '../../../../src/shared/workload.js';
import type { WorkloadEventMetadataInput } from '../../../../src/api/services/workload-event-metadata.js';
import { createWorkload } from '../../../../src/api/services/repositories/workload-creation.js';

// Every caller reaches the whole API; the identity arguments name the submitter.
const scope = (_username?: string, _id?: string) => ({ kind: 'api' }) as const;

describe('WorkloadOutcomeStore', () => {
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

  async function publishTerminal(
    workloadId: string,
    targetState: WorkloadState,
    expectedState: WorkloadState,
    metadata?: WorkloadEventMetadataInput,
  ) {
    const outcome = await outcomes().publishTerminalOutcome(
      workloadId,
      targetState,
      expectedState,
      metadata ? { metadata } : undefined,
    );
    expect(outcome).toBe(true);
  }

  async function markClean(workloadId: string): Promise<void> {
    const store = queries();
    expect((await store.getWorkload(workloadId))?.cleanedAt).toBeNull();
    await expect(outcomes().markCleanupComplete(workloadId)).resolves.toBe(
      true,
    );
  }

  describe('cleanup completion', () => {
    const baseInput = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'test-credential-id',
    };

    async function claimProvisioning(id: string): Promise<number> {
      const eventId = await lifecycle().claimStep(
        id,
        WorkloadState.Provisioning,
      );
      expect(eventId).not.toBeNull();
      return eventId!;
    }

    it('keeps terminal cleanup needed until every attempt row is ended', async () => {
      const id = 'cleanup-live-attempt';
      await createWorkload(getDB(), { ...baseInput, id });
      await claimProvisioning(id);
      const attempt = await ledger().beginProvisioningAttempt(id, `${id}-0`);
      expect(attempt).not.toBeNull();

      const outcome = await outcomes().publishTerminalOutcome(
        id,
        WorkloadState.Terminated,
        WorkloadState.Provisioning,
      );
      expect(outcome).toBe(true);
      expect((await queries().getWorkload(id))?.cleanedAt).toBeNull();
      const eventCount = (await eventLog().getWorkloadEvents(id)).length;

      await expect(outcomes().markCleanupComplete(id)).resolves.toBe(false);
      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Terminated,
      );

      await releaseTestVms(id, attempt!.cloudId);
      await expect(outcomes().markCleanupComplete(id)).resolves.toBe(true);
      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Terminated,
      );
      expect((await queries().getWorkload(id))?.cleanedAt).not.toBeNull();
      expect(await eventLog().getWorkloadEvents(id)).toHaveLength(eventCount);
    });

    it('counts cleanup passes and stops once cleanup completes', async () => {
      const id = 'cleanup-pass-count';
      await createWorkload(getDB(), { ...baseInput, id });
      await walkToState(id, WorkloadState.Terminated);

      await expect(outcomes().recordCleanupAttempt(id)).resolves.toBe(true);
      await expect(outcomes().recordCleanupAttempt(id)).resolves.toBe(true);
      await expect(outcomes().markCleanupComplete(id)).resolves.toBe(true);
      await expect(outcomes().recordCleanupAttempt(id)).resolves.toBe(false);

      const rows = await getDB().query<{ cleanup_attempts: number | null }>(
        'SELECT cleanup_attempts FROM workloads WHERE id = ?',
        [id],
      );
      expect(rows[0]?.cleanup_attempts).toBe(2);
    });

    it('records a one-line, bounded cleanup error only while cleanup is pending', async () => {
      const id = 'cleanup-error-bound';
      await createWorkload(getDB(), { ...baseInput, id });
      const cleanupError = async () =>
        (
          await getDB().query<{ cleanup_error: string | null }>(
            'SELECT cleanup_error FROM workloads WHERE id = ?',
            [id],
          )
        )[0]?.cleanup_error;

      await outcomes().recordCleanupError(id, 'not terminal yet');
      expect(await cleanupError()).toBeNull();

      await walkToState(id, WorkloadState.Failed);
      await outcomes().recordCleanupError(
        id,
        `  first\n\tsecond${'x'.repeat(600)}`,
      );
      const recorded = await cleanupError();
      expect(recorded).toHaveLength(500);
      expect(recorded).toMatch(/^first secondx+…$/);

      await markClean(id);
      expect(await cleanupError()).toBeNull();
      await outcomes().recordCleanupError(id, 'after cleanup');
      expect(await cleanupError()).toBeNull();
    });

    it('backstops the pass count in the cleanup-completion update', async () => {
      const id = 'cleanup-pass-backstop';
      await createWorkload(getDB(), { ...baseInput, id });
      await walkToState(id, WorkloadState.Terminated);

      await expect(
        outcomes().markCleanupComplete(id, { ensureAttemptCounted: true }),
      ).resolves.toBe(true);

      const rows = await getDB().query<{ cleanup_attempts: number | null }>(
        'SELECT cleanup_attempts FROM workloads WHERE id = ?',
        [id],
      );
      expect(rows[0]?.cleanup_attempts).toBe(1);
    });

    it('never records cleanup before its terminal outcome when the clock moves backwards', async () => {
      const id = 'cleanup-monotonic-time';
      await createWorkload(getDB(), { ...baseInput, id });
      await walkToState(id, WorkloadState.Running);

      const outcomeAt = Date.parse('2026-08-12T10:00:00Z');
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(outcomeAt);
      try {
        await publishTerminal(
          id,
          WorkloadState.Errored,
          WorkloadState.Running,
          { exitCode: 1 },
        );
        nowSpy.mockReturnValue(outcomeAt - 60_000);
        await expect(outcomes().markCleanupComplete(id)).resolves.toBe(true);
      } finally {
        nowSpy.mockRestore();
      }

      const workload = await queries().getWorkload(id);
      expect(workload?.completedAt).toBe(outcomeAt);
      expect(workload?.cleanedAt).toBe(outcomeAt);
    });

    it('does not let a terminal termination request rewrite the outcome', async () => {
      const id = 'cleanup-persisted-terminal-time';
      await createWorkload(getDB(), { ...baseInput, id });
      await provisionTestVm(id, { ip: '1.2.3.4', cloudId: `${id}-vm` });
      await walkToState(id, WorkloadState.Running);

      const outcomeAt = Date.now() + 1_000;
      const cleanupRequestedAt = outcomeAt + 60_000;
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(outcomeAt);
      try {
        await publishTerminal(
          id,
          WorkloadState.Completed,
          WorkloadState.Running,
          {
            exitCode: 0,
            logs: 'single-owner diagnostics',
          },
        );
        nowSpy.mockReturnValue(cleanupRequestedAt);
        const termination = await outcomes().requestTermination(
          id,
          scope(baseInput.userId),
          {
            metadata: { callerSession: 'codex-session' },
          },
        );

        expect(termination).toEqual({
          previousState: WorkloadState.Completed,
        });
      } finally {
        nowSpy.mockRestore();
      }

      const workload = await queries().getWorkload(id);
      expect(workload?.state).toBe(WorkloadState.Completed);
      expect(workload?.completedAt).toBe(outcomeAt);

      const events = await eventLog().getWorkloadEvents(id);
      expect(events.at(-1)).toMatchObject({
        id: expect.any(Number),
        state: WorkloadState.Completed,
        created_at: outcomeAt,
      });
      expect(JSON.parse(events.at(-1)!.metadata!)).toEqual({
        exitCode: 0,
        logs: 'single-owner diagnostics',
      });
    });

    it('uses one termination event at T1 and no cleanup event at T3', async () => {
      const id = 'cleanup-active-termination-time';
      await createWorkload(getDB(), { ...baseInput, id });

      const requestedAt = Date.now() + 1_000;
      const cleanupFinishedAt = requestedAt + 60_000;
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(requestedAt);
      try {
        const result = await outcomes().requestTermination(
          id,
          scope(baseInput.userId),
          {
            metadata: {
              reason: 'terminated',
              callerSession: 'codex-session',
            },
          },
        );
        expect(result).toMatchObject({
          previousState: WorkloadState.Queued,
        });
        expect((await queries().getWorkload(id))?.cleanedAt).toBeNull();
        expect((await queries().getWorkload(id))?.completedAt).toBe(
          requestedAt,
        );

        nowSpy.mockReturnValue(cleanupFinishedAt);
        await expect(outcomes().markCleanupComplete(id)).resolves.toBe(true);
      } finally {
        nowSpy.mockRestore();
      }

      const workload = await queries().getWorkload(id);
      expect(workload?.state).toBe(WorkloadState.Terminated);
      expect(workload?.completedAt).toBe(requestedAt);
      const events = await eventLog().getWorkloadEvents(id);
      expect(events.at(-1)).toMatchObject({
        state: WorkloadState.Terminated,
        created_at: requestedAt,
      });
      expect(JSON.parse(events.at(-1)!.metadata!)).toEqual({
        reason: 'terminated',
        callerSession: 'codex-session',
      });
    });

    it('marks each resubmitted lifecycle clean independently', async () => {
      const id = 'cleanup-stale-new-lifecycle';
      await createWorkload(getDB(), { ...baseInput, id });
      await walkToState(id, WorkloadState.Running);
      await publishTerminal(id, WorkloadState.Errored, WorkloadState.Running);

      await expect(outcomes().markCleanupComplete(id)).resolves.toBe(true);
      await expect(outcomes().resubmitWorkload(id)).resolves.toBe(true);

      await walkToState(id, WorkloadState.Running);
      await publishTerminal(id, WorkloadState.Errored, WorkloadState.Running);
      expect((await queries().getWorkload(id))?.cleanedAt).toBeNull();
      await expect(outcomes().markCleanupComplete(id)).resolves.toBe(true);
      expect((await queries().getWorkload(id))?.cleanedAt).not.toBeNull();
    });
  });

  describe('terminal outcomes and termination', () => {
    it('publishes a valid terminal transition (Running → Completed) and ends a VM Job exited', async () => {
      await createWorkload(getDB(), { ...baseWorkload, id: 'fsm-test-1' });
      await walkToState('fsm-test-1', WorkloadState.Running);
      await publishTerminal(
        'fsm-test-1',
        WorkloadState.Completed,
        WorkloadState.Running,
        { exitCode: 0 },
      );
      const d = await queries().getWorkload('fsm-test-1');
      expect(d).toMatchObject({
        state: WorkloadState.Completed,
        endReason: 'exited',
        lastAttemptEndReason: null,
      });
    });

    it('publishes from the current expected state after a same-state event', async () => {
      const id = 'fsm-terminal-same-state-aba';
      await createWorkload(getDB(), { ...baseWorkload, id });
      await walkToState(id, WorkloadState.Running);
      await lifecycle().updateState(id, WorkloadState.Running, {
        metadata: { reason: 'running observation' },
      });
      await expect(
        outcomes().publishTerminalOutcome(
          id,
          WorkloadState.Completed,
          WorkloadState.Running,
        ),
      ).resolves.toBe(true);

      expect(await queries().getWorkload(id)).toMatchObject({
        state: WorkloadState.Completed,
        completedAt: expect.any(Number),
      });
      expect(
        (await eventLog().getWorkloadEvents(id)).filter(
          (event) => event.state === WorkloadState.Completed,
        ),
      ).toHaveLength(1);
    });

    it('allows finalizing transition path (Running → Finalizing → Completed)', async () => {
      await createWorkload(getDB(), {
        ...baseWorkload,
        id: 'fsm-finalizing',
      });
      await walkToState('fsm-finalizing', WorkloadState.Running);

      expect(
        await lifecycle().updateState(
          'fsm-finalizing',
          WorkloadState.Finalizing,
          {
            metadata: {
              targetState: WorkloadState.Completed,
              workloadExitCode: 0,
              attempt: 0,
              maxAttempts: 20,
            },
          },
        ),
      ).toBe(true);
      await publishTerminal(
        'fsm-finalizing',
        WorkloadState.Completed,
        WorkloadState.Finalizing,
        { exitCode: 0 },
      );

      const d = await queries().getWorkload('fsm-finalizing');
      expect(d?.state).toBe(WorkloadState.Completed);
    });

    it('allows final-sync exhaustion to transition Finalizing → Failed', async () => {
      await createWorkload(getDB(), {
        ...baseWorkload,
        id: 'fsm-finalizing-failed',
      });
      await walkToState('fsm-finalizing-failed', WorkloadState.Running);
      await lifecycle().updateState(
        'fsm-finalizing-failed',
        WorkloadState.Finalizing,
        {
          metadata: {
            targetState: WorkloadState.Completed,
            workloadExitCode: 0,
            attempt: 20,
            maxAttempts: 20,
          },
        },
      );

      await publishTerminal(
        'fsm-finalizing-failed',
        WorkloadState.Failed,
        WorkloadState.Finalizing,
        { reason: 'final-bucket-sync-failed' },
      );
      const d = await queries().getWorkload('fsm-finalizing-failed');
      expect(d?.state).toBe(WorkloadState.Failed);
    });

    it('does not set completed_at when the terminal publisher blocks an invalid source', async () => {
      await createWorkload(getDB(), { ...baseWorkload, id: 'fsm-test-5' });
      // Queued → Completed is invalid per FSM
      await expect(
        outcomes().publishTerminalOutcome(
          'fsm-test-5',
          WorkloadState.Completed,
          WorkloadState.Queued,
        ),
      ).resolves.toBe(false);

      const row = await getDB().query<{ completed_at: number | null }>(
        'SELECT completed_at FROM workloads WHERE id = ?',
        ['fsm-test-5'],
      );
      expect(row[0].completed_at).toBeNull();
    });

    it('publishes Terminated from any active state', async () => {
      await createWorkload(getDB(), { ...baseWorkload, id: 'fsm-test-6' });
      // Queued → Terminated is valid (user terminate)
      await publishTerminal(
        'fsm-test-6',
        WorkloadState.Terminated,
        WorkloadState.Queued,
      );
      const d = await queries().getWorkload('fsm-test-6');
      expect(d?.state).toBe(WorkloadState.Terminated);
    });

    it('transitions an active workload to Terminated', async () => {
      const id = 'fsm-request-termination';
      await createWorkload(getDB(), {
        ...baseWorkload,
        id,
      });

      const result = await outcomes().requestTermination(
        id,
        scope(baseWorkload.userId),
        {
          metadata: { reason: 'terminated' },
        },
      );

      expect(result).toMatchObject({
        previousState: WorkloadState.Queued,
      });
      const workload = await queries().getWorkload(id);
      expect(workload?.state).toBe(WorkloadState.Terminated);
      expect((await eventLog().getWorkloadEvents(id)).at(-1)?.state).toBe(
        WorkloadState.Terminated,
      );
    });

    it('fails a persistent VM and leaves its confirmed-missing host to cleanup', async () => {
      const id = 'fsm-missing-vm-host';
      await createWorkload(getDB(), {
        ...baseWorkload,
        id,
        workloadType: WorkloadType.Vm,
      });
      const createdAt = Date.now() - 60 * 60 * 1000;
      await provisionTestVm(
        id,
        {
          ip: '1.2.3.4',
          cloudId: 'missing-cloud-id',
          createdAt,
        },
        { pricePerHour: 2 },
      );
      await walkToState(id, WorkloadState.Running);

      const reason =
        'Cloud provider confirms VM host no longer exists; Anycloud cannot recover its local /workspace.';
      expect(
        await outcomes().failMissingVmHost(
          id,
          { ip: '1.2.3.4', cloudId: 'missing-cloud-id' },
          { reason },
        ),
      ).toBe(true);

      const workload = await queries().getWorkload(id);
      expect(workload).toMatchObject({
        state: WorkloadState.Failed,
        completedAt: expect.any(Number),
        cleanedAt: null,
      });
      // The host's disk/NIC/public IP can outlive the VM, so the row stays live
      // for terminal cleanup to delete and end.
      expect(await queries().getVMs(id)).toMatchObject([
        { ip: '1.2.3.4', cloudId: 'missing-cloud-id' },
      ]);
      expect(await outcomes().markCleanupComplete(id)).toBe(false);
      expect((await queries().getWorkload(id))?.cleanedAt).toBeNull();

      const failureEvent = (await eventLog().getWorkloadEvents(id)).at(-1)!;
      expect(failureEvent).toMatchObject({
        state: WorkloadState.Failed,
        created_at: workload?.completedAt,
      });
      expect(JSON.parse(failureEvent.metadata!)).toEqual({
        reason,
        cloudId: 'missing-cloud-id',
      });

      await releaseTestVms(id, 'missing-cloud-id');
      expect(await outcomes().markCleanupComplete(id)).toBe(true);
    });

    it('fences missing-host failure to persistent VMs and the exact live row', async () => {
      const jobId = 'fsm-missing-host-job';
      await createWorkload(getDB(), { ...baseWorkload, id: jobId });
      await provisionTestVm(jobId, {
        ip: '1.2.3.4',
        cloudId: 'job-cloud-id',
      });
      await walkToState(jobId, WorkloadState.Running);

      expect(
        await outcomes().failMissingVmHost(
          jobId,
          { ip: '1.2.3.4', cloudId: 'job-cloud-id' },
          { reason: 'missing' },
        ),
      ).toBe(false);
      expect((await queries().getWorkload(jobId))?.state).toBe(
        WorkloadState.Running,
      );

      const vmId = 'fsm-missing-host-wrong-row';
      await createWorkload(getDB(), {
        ...baseWorkload,
        id: vmId,
        workloadType: WorkloadType.Vm,
      });
      await provisionTestVm(vmId, {
        ip: '5.6.7.8',
        cloudId: 'actual-cloud-id',
      });
      await walkToState(vmId, WorkloadState.Running);

      expect(
        await outcomes().failMissingVmHost(
          vmId,
          { ip: '5.6.7.8', cloudId: 'stale-cloud-id' },
          { reason: 'missing' },
        ),
      ).toBe(false);
      expect((await queries().getWorkload(vmId))?.state).toBe(
        WorkloadState.Running,
      );
      expect(await queries().getVMs(vmId)).toHaveLength(1);
    });

    it('rejects missing-host failure when the live VM ledger is ambiguous', async () => {
      const id = 'fsm-missing-host-ambiguous';
      await createWorkload(getDB(), {
        ...baseWorkload,
        id,
        workloadType: WorkloadType.Vm,
      });
      await provisionTestVm(id, {
        ip: '1.2.3.4',
        cloudId: 'first-cloud-id',
      });
      await provisionTestVm(id, {
        ip: '5.6.7.8',
        cloudId: 'second-cloud-id',
      });
      await walkToState(id, WorkloadState.Running);

      expect(
        await outcomes().failMissingVmHost(
          id,
          { ip: '1.2.3.4', cloudId: 'first-cloud-id' },
          { reason: 'missing' },
        ),
      ).toBe(false);
      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Running,
      );
      expect(await queries().getVMs(id)).toHaveLength(2);
    });

    it('preserves user termination when it wins the missing-host race', async () => {
      const id = 'fsm-missing-host-terminated';
      await createWorkload(getDB(), {
        ...baseWorkload,
        id,
        workloadType: WorkloadType.Vm,
      });
      await provisionTestVm(id, {
        ip: '1.2.3.4',
        cloudId: 'missing-cloud-id',
      });
      await walkToState(id, WorkloadState.Running);
      await outcomes().requestTermination(id, scope(baseWorkload.userId));

      expect(
        await outcomes().failMissingVmHost(
          id,
          { ip: '1.2.3.4', cloudId: 'missing-cloud-id' },
          { reason: 'missing' },
        ),
      ).toBe(false);
      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Terminated,
      );
      expect(await queries().getVMs(id)).toHaveLength(1);
    });
  });

  describe('resubmitWorkload', () => {
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

    it('resubmits a failed workload back to queued', async () => {
      await createWorkload(getDB(), { ...baseWorkload, id: 'resub-1' });
      await walkToState('resub-1', WorkloadState.Failed);
      await markClean('resub-1');

      const success = await outcomes().resubmitWorkload('resub-1');
      expect(success).toBe(true);

      const d = await queries().getWorkload('resub-1');
      expect(d?.state).toBe(WorkloadState.Queued);
      expect(d?.completedAt).toBeNull();
    });

    it('stays cleanup-eligible and resubmittable after termination', async () => {
      await createWorkload(getDB(), {
        ...baseWorkload,
        id: 'resub-cleanup-request',
      });
      await walkToState('resub-cleanup-request', WorkloadState.Errored);
      await outcomes().requestTermination(
        'resub-cleanup-request',
        scope(baseWorkload.userId),
      );

      expect(await outcomes().resubmitWorkload('resub-cleanup-request')).toBe(
        false,
      );
      expect(
        (await queries().getWorkload('resub-cleanup-request'))?.cleanedAt,
      ).toBeNull();
      expect(
        await outcomes().markCleanupComplete('resub-cleanup-request'),
      ).toBe(true);
      expect(await outcomes().resubmitWorkload('resub-cleanup-request')).toBe(
        true,
      );

      const workload = await queries().getWorkload('resub-cleanup-request');
      expect(workload?.state).toBe(WorkloadState.Queued);
    });

    it('keeps the initial submission separate from a resubmission', async () => {
      const now = Date.now();
      const initialAt = now - 2 * 24 * 60 * 60 * 1000;
      await createWorkload(getDB(), {
        ...baseWorkload,
        id: 'resub-started-at',
      });
      await walkToState('resub-started-at', WorkloadState.Failed);
      await markClean('resub-started-at');
      await getDB().query(
        `UPDATE workloads SET started_at = ?, submitted_at = ? WHERE id = ?`,
        [initialAt, initialAt, 'resub-started-at'],
      );

      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        await outcomes().resubmitWorkload('resub-started-at');
      } finally {
        nowSpy.mockRestore();
      }

      const starts = await spend().summarizeWorkloadStartsInWindow(
        now,
        now + 1,
      );
      const initial = await spend().summarizeWorkloadStartsInWindow(
        initialAt,
        initialAt + 1,
      );
      const workload = await queries().getWorkload('resub-started-at');
      expect(starts).toEqual({
        jobs: { initialSubmissions: 0, resubmissions: 1 },
        services: { initialSubmissions: 0, resubmissions: 0 },
        vms: { initialSubmissions: 0, resubmissions: 0 },
        users: [
          {
            userId: 'test-user',
            ownerUserId: null,
            jobs: { initialSubmissions: 0, resubmissions: 1 },
            services: { initialSubmissions: 0, resubmissions: 0 },
            vms: { initialSubmissions: 0, resubmissions: 0 },
          },
        ],
      });
      expect(initial).toEqual({
        jobs: { initialSubmissions: 1, resubmissions: 0 },
        services: { initialSubmissions: 0, resubmissions: 0 },
        vms: { initialSubmissions: 0, resubmissions: 0 },
        users: [
          {
            userId: 'test-user',
            ownerUserId: null,
            jobs: { initialSubmissions: 1, resubmissions: 0 },
            services: { initialSubmissions: 0, resubmissions: 0 },
            vms: { initialSubmissions: 0, resubmissions: 0 },
          },
        ],
      });
      expect(workload?.startedAt).toBe(now);
    });

    it('counts every repeated resubmission event independently', async () => {
      const now = Date.now();
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        await createWorkload(getDB(), {
          ...baseWorkload,
          id: 'repeated-resubmit',
        });
        await walkToState('repeated-resubmit', WorkloadState.Failed);
        await markClean('repeated-resubmit');

        nowSpy.mockReturnValue(now + 1);
        await outcomes().resubmitWorkload('repeated-resubmit');
        await walkToState('repeated-resubmit', WorkloadState.Failed);
        await markClean('repeated-resubmit');

        nowSpy.mockReturnValue(now + 2);
        await outcomes().resubmitWorkload('repeated-resubmit');
      } finally {
        nowSpy.mockRestore();
      }

      await expect(
        spend().summarizeWorkloadStartsInWindow(now, now + 3),
      ).resolves.toEqual({
        jobs: { initialSubmissions: 1, resubmissions: 2 },
        services: { initialSubmissions: 0, resubmissions: 0 },
        vms: { initialSubmissions: 0, resubmissions: 0 },
        users: [
          {
            userId: 'test-user',
            ownerUserId: null,
            jobs: { initialSubmissions: 1, resubmissions: 2 },
            services: { initialSubmissions: 0, resubmissions: 0 },
            vms: { initialSubmissions: 0, resubmissions: 0 },
          },
        ],
      });
    });

    it('rejects resubmit for a completed workload', async () => {
      await createWorkload(getDB(), { ...baseWorkload, id: 'resub-2' });
      await walkToState('resub-2', WorkloadState.Running);
      await publishTerminal(
        'resub-2',
        WorkloadState.Completed,
        WorkloadState.Running,
      );

      const before = await queries().getWorkload('resub-2');
      expect(before?.completedAt).not.toBeNull();

      // A successful run is re-run with a fresh submit, not resubmitted in place.
      const success = await outcomes().resubmitWorkload('resub-2');
      expect(success).toBe(false);

      const after = await queries().getWorkload('resub-2');
      expect(after?.state).toBe(WorkloadState.Completed);
      expect(after?.completedAt).not.toBeNull();
    });

    it('rejects resubmit for active workloads', async () => {
      await createWorkload(getDB(), { ...baseWorkload, id: 'resub-3' });
      await walkToState('resub-3', WorkloadState.Running);

      const success = await outcomes().resubmitWorkload('resub-3');
      expect(success).toBe(false);

      const d = await queries().getWorkload('resub-3');
      expect(d?.state).toBe(WorkloadState.Running);
    });

    it('rejects resubmit until prior resource cleanup retires live attempts', async () => {
      const id = 'resub-cleanup-incomplete';
      await createWorkload(getDB(), { ...baseWorkload, id });
      await provisionTestVm(id, {
        ip: '1.2.3.4',
        cloudId: 'previous-attempt',
      });
      await walkToState(id, WorkloadState.Failed);

      expect(await outcomes().resubmitWorkload(id)).toBe(false);
      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Failed,
      );

      await releaseTestVms(id, 'previous-attempt');

      // T2 alone is insufficient: provider teardown must commit T3.
      expect(await outcomes().resubmitWorkload(id)).toBe(false);
      await markClean(id);
      expect(await outcomes().resubmitWorkload(id)).toBe(true);
      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Queued,
      );
    });

    it('blocks resubmit while an errored workload still has a live VM', async () => {
      const id = 'resub-live-vm-blocks';
      await createWorkload(getDB(), { ...baseWorkload, id });
      await provisionTestVm(id, {
        ip: '1.2.3.4',
        cloudId: 'not-yet-released',
      });
      await walkToState(id, WorkloadState.Errored);

      expect(await outcomes().resubmitWorkload(id)).toBe(false);
      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Errored,
      );

      // Ending compute at T2 still leaves ancillary cleanup needed.
      await releaseTestVms(id, 'not-yet-released');
      expect(await outcomes().resubmitWorkload(id)).toBe(false);
      await markClean(id);
      expect(await outcomes().resubmitWorkload(id)).toBe(true);
      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Queued,
      );
    });

    it('inserts a queued event with resubmit metadata', async () => {
      await createWorkload(getDB(), { ...baseWorkload, id: 'resub-4' });
      await walkToState('resub-4', WorkloadState.Terminated);
      await markClean('resub-4');

      await outcomes().resubmitWorkload('resub-4');

      const events = await eventLog().getWorkloadEvents('resub-4');
      const resubmitEvent = events.find(
        (e) =>
          e.state === WorkloadState.Queued &&
          e.metadata &&
          JSON.parse(e.metadata).reason === 'resubmitted',
      );
      expect(resubmitEvent).toBeDefined();
    });

    it('records caller attribution in resubmit metadata when provided', async () => {
      await createWorkload(getDB(), { ...baseWorkload, id: 'resub-actor' });
      await walkToState('resub-actor', WorkloadState.Invalid);
      await markClean('resub-actor');

      await outcomes().resubmitWorkload('resub-actor', 'session-123');

      const events = await eventLog().getWorkloadEvents('resub-actor');
      const resubmitEvent = events.find(
        (e) =>
          e.state === WorkloadState.Queued &&
          e.metadata &&
          JSON.parse(e.metadata).reason === 'resubmitted',
      );
      expect(resubmitEvent).toBeDefined();
      expect(JSON.parse(resubmitEvent!.metadata!)).toEqual({
        reason: 'resubmitted',
        callerSession: 'session-123',
      });
    });

    it('works for all resubmittable (non-completed) terminal states', async () => {
      const states = [
        WorkloadState.Failed,
        WorkloadState.Errored,
        WorkloadState.Invalid,
        WorkloadState.Terminated,
      ];

      for (const state of states) {
        const id = `resub-terminal-${state}`;
        await createWorkload(getDB(), { ...baseWorkload, id });
        await walkToState(id, state);
        await markClean(id);

        const success = await outcomes().resubmitWorkload(id);
        expect(success).toBe(true);

        const d = await queries().getWorkload(id);
        expect(d?.state).toBe(WorkloadState.Queued);
      }
    });
  });
});
