import { beforeEach, describe, expect, it, vi } from 'vitest';
import config from '../../../src/api/config.js';
import {
  resetPersistence,
  getProvisioningAttemptStore as ledger,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
} from '../../../src/api/services/persistence.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import {
  preemptTestVm,
  provisionTestVm,
  releaseTestVms,
  seedTestWorkload,
} from '../../helpers/workload-store.js';

describe('workload store test fixtures', () => {
  beforeEach(() => {
    resetPersistence();
    config.cipherKey = 'a'.repeat(64);
  });

  it('preserves fixture fields and ownership, and rejects duplicate IDs', async () => {
    const fixture = {
      id: 'shared-fixture',
      userId: 'captured-user',
      ownerUserId: 'durable-owner',
      image: 'example/image:pinned',
      state: WorkloadState.Completed,
      env: { FIXTURE_CANARY: 'retained' },
    };
    const workload = await seedTestWorkload(fixture);

    expect(workload).toMatchObject({
      id: 'shared-fixture',
      userId: 'captured-user',
      image: 'example/image:pinned',
      state: WorkloadState.Completed,
      env: { FIXTURE_CANARY: 'retained' },
    });
    expect(workload.completedAt).toEqual(expect.any(Number));
    expect(workload.cleanedAt).toBeNull();
    const events = await eventLog().getWorkloadEvents(fixture.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      state: WorkloadState.Completed,
      created_at: workload.completedAt,
    });
    await expect(
      queries().getWorkloadForScope(fixture.id, { kind: 'api' }),
    ).resolves.toMatchObject({ id: fixture.id });
    await expect(seedTestWorkload(fixture)).rejects.toThrow('already exists');
  });

  it('never exposes a non-Queued fixture to the provisioning scheduler', async () => {
    const db = getDB();
    const transaction = db.transaction.bind(db);
    let observedQueued: boolean | undefined;
    vi.spyOn(db, 'transaction').mockImplementationOnce(async (write) => {
      const result = await transaction(write);
      observedQueued = (await queries().listQueued(10)).some(
        ({ id }) => id === 'atomic-running-fixture',
      );
      return result;
    });

    const workload = await seedTestWorkload({
      id: 'atomic-running-fixture',
      userId: 'fixture-owner',
      state: WorkloadState.Running,
    });

    expect(observedQueued).toBe(false);
    expect(workload.state).toBe(WorkloadState.Running);
  });

  it('registers VM attempts only through Provisioning and releases them as termination does', async () => {
    await seedTestWorkload({
      id: 'running-fixture',
      userId: 'fixture-owner',
    });
    await expect(
      provisionTestVm('running-fixture', { ip: '10.0.0.1', cloudId: 'late' }),
    ).rejects.toThrow('needs a Provisioning workload, not running');

    const id = 'attempt-fixture';
    await seedTestWorkload({
      id,
      userId: 'fixture-owner',
      state: WorkloadState.Queued,
    });
    await provisionTestVm(id, { ip: '10.0.0.1', cloudId: 'kept' });
    await provisionTestVm(id, { ip: '10.0.0.2', cloudId: 'released' });
    await provisionTestVm(id, { cloudId: 'failed-launch' });
    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Provisioning,
    );

    await releaseTestVms(id, 'released');
    await preemptTestVm(id, 'kept');

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Recovering,
    );
    const rows = new Map(
      (await ledger().getProvisioningAttempts(id)).map((row) => [
        row.cloud_id,
        row,
      ]),
    );
    expect(rows.get('kept')).toMatchObject({
      ip: '10.0.0.1',
      preempt: 1,
      ended_at: null,
      removal_requested_at: null,
    });
    expect(rows.get('released')).toMatchObject({
      ended_at: expect.any(Number),
      removal_requested_at: expect.any(Number),
    });
    expect(rows.get('failed-launch')).toMatchObject({
      ip: null,
      ended_at: null,
    });
  });
});
