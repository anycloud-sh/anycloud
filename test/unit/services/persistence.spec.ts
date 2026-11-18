import { beforeEach, describe, expect, it } from 'vitest';
import {
  getDeploymentStore,
  getPersistence,
  getSpendControlsStore,
  getWorkloadLifecycle,
  recordApiVersion,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import { getDB, resetDB } from '../../../src/api/services/repositories/db.js';

describe('persistence composition', () => {
  beforeEach(() => {
    resetPersistence();
  });

  it('returns both repositories from one stable composition', () => {
    const persistence = getPersistence();

    expect(getPersistence()).toBe(persistence);
    expect(getWorkloadLifecycle()).toBe(persistence.workloadLifecycle);
    expect(getSpendControlsStore()).toBe(persistence.spendControls);
    expect(getDeploymentStore()).toBe(persistence.deployments);
    expect(persistence.clusterRecords).toBeDefined();
    expect(persistence.nodePools).toBeDefined();
  });

  it('does not expose admission-only writes through the runtime facade', () => {
    for (const repository of Object.values(getPersistence())) {
      for (const write of [
        'createWorkload',
        'createTargetedWorkload',
        'createPoolJob',
        'upsertCredential',
      ]) {
        expect(write in repository).toBe(false);
      }
    }
    expect(typeof getWorkloadLifecycle().beginServiceUpgrade).toBe('function');
  });

  it('appends to the api_versions timeline only when the version changes', async () => {
    await recordApiVersion('0.1.0');
    await recordApiVersion('0.1.0');
    await recordApiVersion('0.2.0');

    const rows = await getDB().query<{ version: string }>(
      'SELECT version FROM api_versions ORDER BY first_seen_at, rowid',
    );
    expect(rows.map((row) => row.version)).toEqual(['0.1.0', '0.2.0']);
  });

  it('resets both repository instances and their shared database together', async () => {
    const previous = getPersistence();
    await previous.spendControls.setThrottle('account', 10);

    resetPersistence();

    const next = getPersistence();
    expect(next.workloadLifecycle).not.toBe(previous.workloadLifecycle);
    expect(next.spendControls).not.toBe(previous.spendControls);
    expect(next.deployments).not.toBe(previous.deployments);
    expect(next.clusterRecords).not.toBe(previous.clusterRecords);
    expect(next.nodePools).not.toBe(previous.nodePools);
    await expect(next.spendControls.listThrottles()).resolves.toEqual([]);
  });

  it('recomposes repositories after a low-level database reset', () => {
    const previous = getPersistence();

    resetDB();

    const next = getPersistence();
    expect(next.workloadLifecycle).not.toBe(previous.workloadLifecycle);
    expect(next.spendControls).not.toBe(previous.spendControls);
    expect(next.deployments).not.toBe(previous.deployments);
    expect(next.nodePools).not.toBe(previous.nodePools);
  });
});
