import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'crypto';
import { getDB } from '../../../../src/api/services/repositories/db';

const { fake, terminateVMs, terminateNetworking } = await vi.hoisted(
  async () => {
    const { createFakeTransport } = await import(
      '../../helpers/mock-transport'
    );
    return {
      fake: createFakeTransport(),
      terminateVMs: vi.fn().mockResolvedValue(['i-123']),
      terminateNetworking: vi.fn().mockResolvedValue(undefined),
    };
  },
);

vi.mock('../../../../src/api/services/gateways/transport', () => ({
  createTransport: vi.fn(() => fake),
}));

// Stub the compute provider so terminate() can run its VM cleanup without
// reaching a real cloud SDK; the store and SSH transport stay observable.
vi.mock('../../../../src/api/services/cloud-config', async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import('../../../../src/api/services/cloud-config')
    >();
  return {
    ...real,
    createComputeProvider: vi.fn(
      (cloudConfig: import('../../../../src/shared/cloud.js').CloudConfig) => ({
        type: cloudConfig.cloudProvider,
        region: cloudConfig.region ?? '',
        terminateVMs,
        terminateNetworking,
      }),
    ),
  };
});

import { terminate } from '../../../../src/api/services/host-runtime/termination';
import { TEST_AWS_CRED } from '../../helpers/fixtures';
import { CloudType } from '../../../../src/shared/cloud.js';
import { WorkloadState } from '../../../../src/shared/workload.js';
import {
  walkToState,
  provisionTestVm,
  releaseTestVms,
} from '../../../helpers/workload-store.js';
import { resetTestStore } from '../../utils';
import config from '../../../../src/api/config';

const AWS_CONFIG = {
  cloudProvider: CloudType.AWS,
  credentials: TEST_AWS_CRED,
  region: 'us-east-1',
  vmType: 't3.large',
  outputBucket: 'results-bucket',
};

import {
  getWorkloadLifecycle,
  getProvisioningAttemptStore as ledger,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
  getWorkloadOutcomes,
} from '../../../../src/api/services/persistence.js';
import { upsertCredential } from '../../../../src/api/services/repositories/credential-secrets.js';
import { createWorkload } from '../../../../src/api/services/repositories/workload-creation.js';

// Every caller reaches the whole API; the identity arguments name the submitter.
const scope = (_username?: string, _id?: string) => ({ kind: 'api' }) as const;

describe('cleanup rclone capture', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(async () => {
    await resetTestStore();
    fake.reset();
    terminateVMs.mockReset();
    terminateVMs.mockResolvedValue(['i-123']);
    terminateNetworking.mockReset();
    terminateNetworking.mockResolvedValue(undefined);
  });

  async function createAwsWorkload(id: string, regionFallback = false) {
    await upsertCredential(
      getDB(),
      'aws-cred-hash',
      'cred-encrypted',
      CloudType.AWS,
    );
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.large',
      spot: false,
      dockerCommand: 'echo ok',
      sshPrivateKey: 'private-key',
      credentialId: 'aws-cred-hash',
    });
    await getWorkloadLifecycle().updateState(id, WorkloadState.Provisioning);
    await provisionTestVm(
      id,
      { ip: '203.0.113.20', cloudId: 'i-123' },
      { region: 'us-east-1' },
    );
    if (regionFallback) {
      await provisionTestVm(
        id,
        { ip: '203.0.113.21', cloudId: 'i-456' },
        { region: 'us-west-2', vmType: 't3.large' },
      );
    }
    await getWorkloadLifecycle().updateState(id, WorkloadState.Running);
  }

  it.each([
    WorkloadState.Completed,
    WorkloadState.Errored,
    WorkloadState.Failed,
    WorkloadState.Invalid,
  ])('does not capture rclone diagnostics for a %s job', async (state) => {
    const id = `aws-cleanup-after-${state}`;
    await createAwsWorkload(id);
    const store = queries();
    await walkToState(id, state);
    const eventsBefore = (await eventLog().getWorkloadEvents(id)).length;

    await terminate(AWS_CONFIG, id);

    const events = await eventLog().getWorkloadEvents(id);
    expect(events.length).toBe(eventsBefore);
    expect(events.at(-1)?.state).toBe(state);
    expect((await store.getWorkload(id))?.cleanedAt).not.toBeNull();
    const rcloneProbes = fake.commands.filter(
      (cmd) =>
        cmd.includes('systemctl is-active rclone') ||
        cmd.includes('/var/log/rclone'),
    );
    expect(rcloneProbes).toEqual([]);
  });

  it('still captures rclone diagnostics when stopping a live workload', async () => {
    // A user stop of a Running job bypasses the exit path entirely — the
    // pre-terminate capture is the only chance to persist sync failures.
    const id = 'aws-cleanup-user-stop';
    const rcloneError =
      '2026/07/10 23:26:14 ERROR : results.json: Failed to copy: permission denied';
    await createAwsWorkload(id);
    fake
      .on('ps -p 1 -o comm=', 'systemd\n')
      .on('systemctl is-active rclone-output', 'active\n')
      .on('systemctl is-active rclone-checkpoint', 'missing\n')
      .on('tail -200 /var/log/rclone-output.log', `${rcloneError}\n`);
    const eventsBefore = (await eventLog().getWorkloadEvents(id)).length;
    const termination = await getWorkloadOutcomes().requestTermination(
      id,
      scope('test-user'),
      { metadata: { reason: 'terminated' } },
    );
    expect(termination).toEqual({ previousState: WorkloadState.Running });
    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Terminated,
    );
    terminateVMs.mockImplementationOnce(async () => {
      const events = await eventLog().getWorkloadEvents(id);
      const diagnosticsWerePersisted = events.some((event) => {
        if (!event.metadata) return false;
        const metadata = JSON.parse(event.metadata);
        return (
          typeof metadata.logs === 'string' &&
          metadata.logs.includes(rcloneError)
        );
      });
      expect(diagnosticsWerePersisted).toBe(true);
      return ['i-123'];
    });

    await terminate(AWS_CONFIG, id);

    const events = await eventLog().getWorkloadEvents(id);
    const terminatedEvents = events.filter(
      (event) => event.state === WorkloadState.Terminated,
    );
    const rcloneEvents = events.filter((event) => {
      if (!event.metadata) return false;
      const metadata = JSON.parse(event.metadata);
      return (
        typeof metadata.logs === 'string' &&
        metadata.logs.includes('output-sync:')
      );
    });
    expect(events).toHaveLength(eventsBefore + 1);
    expect(terminatedEvents).toHaveLength(1);
    expect(rcloneEvents).toHaveLength(1);
    expect(rcloneEvents[0].state).toBe(WorkloadState.Terminated);
    expect(JSON.parse(rcloneEvents[0].metadata!).logs).toContain(rcloneError);
    expect(JSON.parse(terminatedEvents[0].metadata!)).toMatchObject({
      reason: 'terminated',
      logs: expect.stringContaining(rcloneError),
    });
    expect(terminateVMs).toHaveBeenCalledOnce();
  });

  it('does not create new events when diagnostic cleanup retries fail', async () => {
    const id = 'aws-cleanup-retry-diagnostics';
    const rcloneError =
      '2026/07/10 23:26:14 ERROR : results.json: Failed to copy: permission denied';
    await createAwsWorkload(id);
    const store = queries();
    await getWorkloadOutcomes().requestTermination(id, scope('test-user'), {
      metadata: { reason: 'terminated' },
    });
    fake
      .on('ps -p 1 -o comm=', 'systemd\n')
      .on('systemctl is-active rclone-output', 'active\n')
      .on('systemctl is-active rclone-checkpoint', 'missing\n')
      .on('tail -200 /var/log/rclone-output.log', `${rcloneError}\n`);
    terminateVMs.mockRejectedValue(new Error('provider cleanup failed'));

    const eventsBefore = await eventLog().getWorkloadEvents(id);
    await expect(terminate(AWS_CONFIG, id)).rejects.toThrow(
      'provider cleanup failed',
    );
    const eventsAfterFirst = await eventLog().getWorkloadEvents(id);
    const eventRevisionAfterFirst = (
      await store.getWorkloadReconcileCandidate(id)
    )?.revision;

    await expect(terminate(AWS_CONFIG, id)).rejects.toThrow(
      'provider cleanup failed',
    );

    const eventsAfter = await eventLog().getWorkloadEvents(id);
    const candidateAfter = await store.getWorkloadReconcileCandidate(id);
    const metadata = JSON.parse(eventsAfter.at(-1)!.metadata!);
    expect(eventsAfterFirst).toHaveLength(eventsBefore.length);
    expect(eventsAfter).toHaveLength(eventsAfterFirst.length);
    expect(candidateAfter?.revision).toBe(eventRevisionAfterFirst);
    expect(candidateAfter?.state).toBe(WorkloadState.Terminated);
    expect(metadata).toMatchObject({
      reason: 'terminated',
      logs: expect.stringContaining(rcloneError),
    });
    expect(terminateVMs).toHaveBeenCalledTimes(2);
  });

  it('retries networking after T2 without deleting compute again', async () => {
    const id = 'aws-cleanup-network-retry';
    await createAwsWorkload(id);
    const store = queries();
    await walkToState(id, WorkloadState.Completed);
    terminateNetworking.mockRejectedValueOnce(
      new Error('network control plane unavailable'),
    );

    await expect(terminate(AWS_CONFIG, id)).rejects.toThrow(
      'network control plane unavailable',
    );

    const attemptsAfterT2 = await ledger().getProvisioningAttempts(id);
    expect(attemptsAfterT2).toEqual([
      expect.objectContaining({
        cloud_id: 'i-123',
        ended_at: expect.any(Number),
      }),
    ]);
    expect((await store.getWorkload(id))?.cleanedAt).toBeNull();

    await expect(terminate(AWS_CONFIG, id)).resolves.toBe(true);

    expect(terminateVMs).toHaveBeenCalledOnce();
    expect(terminateNetworking).toHaveBeenCalledTimes(2);
    expect((await store.getWorkload(id))?.cleanedAt).not.toBeNull();
  });

  it('replays networking for every recorded placement after T2', async () => {
    const id = 'aws-cleanup-multi-placement-networking';
    await createAwsWorkload(id, true);
    const store = queries();
    await releaseTestVms(id, 'i-123');
    await releaseTestVms(id, 'i-456');
    await walkToState(id, WorkloadState.Completed);

    await expect(terminate(AWS_CONFIG, id)).resolves.toBe(true);

    expect(terminateVMs).not.toHaveBeenCalled();
    expect(terminateNetworking).toHaveBeenCalledTimes(2);
    expect((await store.getWorkload(id))?.cleanedAt).not.toBeNull();
  });

  it('still tears down when rclone diagnostics are unavailable', async () => {
    const id = 'aws-cleanup-diagnostics-unavailable';
    await createAwsWorkload(id);
    fake.default(new Error('SSH unavailable'));
    await getWorkloadOutcomes().requestTermination(id, scope('test-user'));

    await terminate(AWS_CONFIG, id);

    expect(terminateVMs).toHaveBeenCalledOnce();
  });

  it('still tears down when terminal diagnostics cannot find the outcome event', async () => {
    const id = 'aws-cleanup-diagnostics-event-missing';
    await createAwsWorkload(id);
    const store = queries();
    await getWorkloadOutcomes().requestTermination(id, scope('test-user'));
    fake
      .on('ps -p 1 -o comm=', 'systemd\n')
      .on('systemctl is-active rclone-output', 'active\n')
      .on('systemctl is-active rclone-checkpoint', 'missing\n')
      .on(
        'tail -200 /var/log/rclone-output.log',
        '2026/07/10 23:26:14 ERROR : results.json: permission denied\n',
      );
    await getDB().query('DELETE FROM workload_events WHERE workload_id = ?', [
      id,
    ]);

    await expect(terminate(AWS_CONFIG, id)).resolves.toBe(true);

    expect(terminateVMs).toHaveBeenCalledOnce();
    expect((await store.getWorkload(id))?.cleanedAt).not.toBeNull();
  });

  it('does not let stale cleanup terminate a resubmitted workload', async () => {
    const id = 'aws-cleanup-resubmitted';
    await createAwsWorkload(id);
    const store = queries();
    await getWorkloadOutcomes().requestTermination(id, scope('test-user'));
    await releaseTestVms(id, 'i-123');
    expect(await getWorkloadOutcomes().markCleanupComplete(id)).toBe(true);
    expect(await getWorkloadOutcomes().resubmitWorkload(id)).toBe(true);

    await expect(terminate(AWS_CONFIG, id)).resolves.toBe(false);

    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Queued);
    expect(terminateVMs).not.toHaveBeenCalled();
  });
});
