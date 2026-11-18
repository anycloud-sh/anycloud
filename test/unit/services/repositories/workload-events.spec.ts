import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import config from '../../../../src/api/config.js';
import {
  getWorkloadEventStore as eventLog,
  getWorkloadLifecycle as lifecycle,
  resetPersistence,
  getWorkloadQueryStore as queries,
} from '../../../../src/api/services/persistence.js';
import { getDB } from '../../../../src/api/services/repositories/db.js';
import { walkToState } from '../../../helpers/workload-store.js';
import { CloudType } from '../../../../src/shared/cloud.js';
import {
  WorkloadState,
  WorkloadType,
} from '../../../../src/shared/workload.js';
import { createWorkload } from '../../../../src/api/services/repositories/workload-creation.js';

const CREDENTIAL_ID = 'test-credential-id';
// Every caller reaches the whole API; the identity arguments name the submitter.
const scope = (_username?: string, _id?: string) => ({ kind: 'api' }) as const;

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

describe('WorkloadEventStore', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(async () => {
    resetPersistence();
    await getDB().query(
      `INSERT OR IGNORE INTO credentials (id, encrypted_data, cloud_provider) VALUES (?, '', 'AWS')`,
      [CREDENTIAL_ID],
    );
  });

  describe('countStateEvents', () => {
    it("counts a state's events since the latest resubmission", async () => {
      const id = 'recovery-count';
      await createWorkload(getDB(), {
        ...baseInput,
        id,
        noCheckpoint: true,
        requireNestedVirtualization: true,
        hostDocker: true,
      });
      const event = (state: WorkloadState, reason?: string) =>
        getDB().query(
          `INSERT INTO workload_events (workload_id, state, metadata, created_at) VALUES (?, ?, ?, ?)`,
          [id, state, reason ? JSON.stringify({ reason }) : null, Date.now()],
        );
      await event(WorkloadState.Recovering);
      await event(WorkloadState.Recovering);
      expect(
        await eventLog().countStateEvents(id, WorkloadState.Recovering),
      ).toBe(2);
      await event(WorkloadState.Queued, 'resubmitted');
      await event(WorkloadState.Recovering);
      expect(
        await eventLog().countStateEvents(id, WorkloadState.Recovering),
      ).toBe(1);
      // The flags round-trip through the record.
      expect(
        (await queries().getWorkload(id))?.requireNestedVirtualization,
      ).toBe(true);
      expect((await queries().getWorkload(id))?.noCheckpoint).toBe(true);
      expect((await queries().getWorkload(id))?.hostDocker).toBe(true);
    });
  });

  describe('getLatestProvisioningIntent', () => {
    it('reads placement only from the latest Provisioning event', async () => {
      const id = 'durable-provisioning-intent';
      await createWorkload(getDB(), { ...baseInput, id });
      await lifecycle().updateState(id, WorkloadState.Provisioning, {
        metadata: {
          provisioningIntent: {
            cloudProvider: CloudType.AWS,
            availabilityZone: null,
            region: 'us-west-2',
            vmType: 'm7i.large',
            credentialId: 'test-credential-id',
          },
        },
      });

      await expect(eventLog().getLatestProvisioningIntent(id)).resolves.toEqual(
        {
          cloudProvider: CloudType.AWS,
          availabilityZone: null,
          region: 'us-west-2',
          vmType: 'm7i.large',
          credentialId: 'test-credential-id',
        },
      );

      // A newer replay without an intent must not revive stale placement from
      // an earlier attempt.
      await lifecycle().updateState(id, WorkloadState.Provisioning, {
        metadata: { reason: 'legacy-replay' },
      });
      await expect(
        eventLog().getLatestProvisioningIntent(id),
      ).resolves.toBeNull();

      const latestEvent = (await eventLog().getWorkloadEvents(id)).at(-1)!;
      await getDB().query(
        `UPDATE workload_events SET metadata = 'not valid json' WHERE id = ?`,
        [latestEvent.id],
      );
      await expect(
        eventLog().getLatestProvisioningIntent(id),
      ).resolves.toBeNull();
    });
  });

  describe('updateTerminalDiagnostics', () => {
    it('does not throw when outcome diagnostics cannot be persisted', async () => {
      const query = vi
        .spyOn(getDB(), 'query')
        .mockRejectedValueOnce(new Error('database unavailable'));

      await expect(
        eventLog().updateTerminalDiagnostics('diagnostics-write-failed', {
          logs: 'output-sync: failed',
        }),
      ).resolves.toBeUndefined();

      query.mockRestore();
    });

    it('repairs malformed metadata when persisting terminal diagnostics', async () => {
      const id = 'diagnostics-repairs-malformed-metadata';
      await createWorkload(getDB(), { ...baseInput, id });
      await walkToState(id, WorkloadState.Terminated);
      const indexes = await getDB().query<{ name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'index'
           AND name IN (
             'idx_events_resubmit',
             'idx_events_resubmit_created_at'
           )
         ORDER BY name`,
      );
      expect(indexes.map(({ name }) => name)).toEqual([
        'idx_events_resubmit',
        'idx_events_resubmit_created_at',
      ]);
      await getDB().query(
        `UPDATE workload_events
         SET metadata = 'not valid json'
         WHERE workload_id = ?`,
        [id],
      );

      await eventLog().updateTerminalDiagnostics(id, {
        logs: 'output-sync: failed',
      });

      const terminalEvent = (await eventLog().getWorkloadEvents(id)).at(-1)!;
      expect(JSON.parse(terminalEvent.metadata!)).toMatchObject({
        logs: 'output-sync: failed',
      });
    });
  });

  describe('recordQueuedBlockReason', () => {
    it('never appends a Queued event to a terminal workload', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'lm-4' });
      await walkToState('lm-4', WorkloadState.Failed);

      await eventLog().recordQueuedBlockReason(
        'lm-4',
        'blocked by daily budget',
      );

      expect((await queries().getWorkload('lm-4'))?.cleanedAt).toBeNull();
      const [d] = await queries().listWorkloads(scope('test-user'));
      expect(d.latestMessage).toBeNull();
    });
  });

  describe('setImagePullTelemetry', () => {
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

    it('binds pull telemetry to the claimed Downloading event', async () => {
      const id = 'fsm-current-step-telemetry';
      await createWorkload(getDB(), { ...baseWorkload, id });
      await walkToState(id, WorkloadState.Initializing);
      const firstEventId = await lifecycle().claimStep(
        id,
        WorkloadState.Downloading,
      );
      expect(firstEventId).toEqual(expect.any(Number));

      // A resumed pull claims a newer Downloading event before the old pull
      // completes. The old result must stay attached to its original event.
      await lifecycle().updateState(id, WorkloadState.Starting);
      const secondEventId = await lifecycle().claimStep(
        id,
        WorkloadState.Downloading,
      );
      expect(secondEventId).toEqual(expect.any(Number));
      expect(secondEventId).not.toBe(firstEventId);

      await getDB().query(
        `UPDATE workload_events SET metadata = 'not valid json' WHERE id = ?`,
        [firstEventId],
      );

      await eventLog().setImagePullTelemetry(id, firstEventId!, {
        schemaVersion: 1,
        method: 'docker-fallback',
        outcome: 'succeeded',
        elapsedMs: 1234,
        reason: 'token ghp_abcdefghijklmnopqrstuvwxyz123456 registry_throttled',
      });
      const events = await eventLog().getWorkloadEvents(id);
      const updatedFirst = events.find((event) => event.id === firstEventId)!;
      const untouchedSecond = events.find(
        (event) => event.id === secondEventId,
      )!;
      expect(JSON.parse(updatedFirst.metadata!)).toEqual({
        imagePull: {
          schemaVersion: 1,
          method: 'docker-fallback',
          outcome: 'succeeded',
          elapsedMs: 1234,
          reason: 'token <REDACTED_GH_TOKEN> registry_throttled',
        },
      });
      expect(untouchedSecond.metadata).toBeNull();
    });
  });

  describe('getLatestFailureClassification', () => {
    const baseInput = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'test-credential-id',
    };

    const insertFailureEvent = (
      id: string,
      metadata: Record<string, unknown> | null,
      createdAt: number,
    ) =>
      getDB().query(
        `INSERT INTO workload_events (workload_id, state, metadata, created_at)
         VALUES (?, ?, ?, ?)`,
        [
          id,
          WorkloadState.Retrying,
          metadata ? JSON.stringify({ ...metadata, error: 'x' }) : null,
          createdAt,
        ],
      );

    it('returns null when no event carries a failure diagnosis', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'ek-1' });
      expect(
        await eventLog().getLatestFailureClassification('ek-1'),
      ).toBeNull();
    });

    it('returns diagnosis and disposition from the most recent classified event', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'ek-2' });
      await insertFailureEvent(
        'ek-2',
        {
          diagnosis: 'quota-exhausted-region',
          disposition: 'failover-target',
        },
        100,
      );
      await insertFailureEvent(
        'ek-2',
        {
          diagnosis: 'quota-exhausted-account',
          disposition: 'retry-same-target',
        },
        200,
      );
      await getDB().query(
        `INSERT INTO workload_events (workload_id, state, metadata, created_at)
         VALUES (?, ?, 'not valid json', ?)`,
        ['ek-2', WorkloadState.Retrying, 300],
      );
      expect(await eventLog().getLatestFailureClassification('ek-2')).toEqual({
        diagnosis: 'quota-exhausted-account',
        disposition: 'retry-same-target',
      });
    });

    it('falls back to legacy errorKind when diagnosis is absent', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'ek-3' });
      await insertFailureEvent(
        'ek-3',
        { errorKind: 'quota-exhausted-account' },
        100,
      );
      await insertFailureEvent('ek-3', null, 200);
      expect(await eventLog().getLatestFailureClassification('ek-3')).toEqual({
        diagnosis: 'quota-exhausted-account',
        disposition: null,
      });
    });
  });

  describe('getLatestFinalizationEventMetadata', () => {
    const baseJob = {
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

    it('returns the latest finalization-control metadata behind non-control events', async () => {
      const id = 'job-finalization-metadata';

      await createWorkload(getDB(), { ...baseJob, id });
      await walkToState(id, WorkloadState.Running);
      await lifecycle().updateState(id, WorkloadState.Finalizing, {
        metadata: {
          targetState: WorkloadState.Completed,
          workloadExitCode: 0,
          attempt: 0,
          maxAttempts: 20,
        },
      });
      await lifecycle().updateState(id, WorkloadState.Finalizing, {
        metadata: {
          reason: 'job finalization retry pending',
          error: { message: 'first transient failure' },
        },
      });
      await lifecycle().updateState(id, WorkloadState.Finalizing, {
        metadata: {
          targetState: WorkloadState.Errored,
          workloadExitCode: 7,
          attempt: 1,
          maxAttempts: 20,
        },
      });
      await lifecycle().updateState(id, WorkloadState.Finalizing, {
        metadata: {
          reason: 'job finalization retry pending',
          error: { message: 'second transient failure' },
        },
      });

      const events = await eventLog().getWorkloadEvents(id);
      const latest = JSON.parse(events.at(-1)!.metadata!);
      expect(latest).toMatchObject({
        reason: 'job finalization retry pending',
      });
      expect(latest).not.toHaveProperty('targetState');

      const finalization =
        await eventLog().getLatestFinalizationEventMetadata(id);
      expect(finalization?.metadata).toMatchObject({
        targetState: WorkloadState.Errored,
        workloadExitCode: 7,
        attempt: 1,
        maxAttempts: 20,
      });
    });

    it('returns null when the only Finalizing events lack control metadata', async () => {
      const id = 'job-finalization-metadata-missing';

      await createWorkload(getDB(), { ...baseJob, id });
      await walkToState(id, WorkloadState.Running);
      await lifecycle().updateState(id, WorkloadState.Finalizing, {
        metadata: {
          reason: 'job finalization retry pending',
          error: { message: 'transient finalization failure' },
        },
      });

      const events = await eventLog().getWorkloadEvents(id);
      expect(JSON.parse(events.at(-1)!.metadata!)).not.toHaveProperty(
        'targetState',
      );

      const finalization =
        await eventLog().getLatestFinalizationEventMetadata(id);
      expect(finalization).toBeNull();
    });
  });

  describe('getLatestRunningAndProvisioningEventIds', () => {
    const baseService = {
      userId: 'test-user',
      workloadType: WorkloadType.Service,
      image: 'service:latest',
      cloudProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      dockerCommand: 'docker run service:latest',
      sshPrivateKey: 'test-key',
      credentialId: 'test-cred',
    };

    it('returns zero ids when the workload has no events', async () => {
      const id = 'service-without-events';
      await createWorkload(getDB(), { ...baseService, id });

      await expect(
        eventLog().getLatestRunningAndProvisioningEventIds(id),
      ).resolves.toEqual({
        latestRunningEventId: 0,
        latestProvisioningEventId: 0,
      });
    });

    it('returns the latest ids while ignoring unrelated states', async () => {
      const id = 'service-generation-events';
      await createWorkload(getDB(), { ...baseService, id });
      await walkToState(id, WorkloadState.Provisioning);
      await walkToState(id, WorkloadState.Retrying);
      await walkToState(id, WorkloadState.Running);
      await walkToState(id, WorkloadState.Recovering);
      await walkToState(id, WorkloadState.Provisioning);
      await walkToState(id, WorkloadState.Downloading);
      await walkToState(id, WorkloadState.Running);
      await walkToState(id, WorkloadState.Finalizing);

      const events = await eventLog().getWorkloadEvents(id);
      const expectedRunningId = events
        .filter((event) => event.state === WorkloadState.Running)
        .at(-1)!.id;
      const expectedProvisioningId = events
        .filter((event) => event.state === WorkloadState.Provisioning)
        .at(-1)!.id;

      await expect(
        eventLog().getLatestRunningAndProvisioningEventIds(id),
      ).resolves.toEqual({
        latestRunningEventId: expectedRunningId,
        latestProvisioningEventId: expectedProvisioningId,
      });
    });
  });
});
