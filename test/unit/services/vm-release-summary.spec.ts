import { beforeEach, describe, expect, it } from 'vitest';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import { createTestWorkload, resetTestStore } from '../utils.js';
import { getProvisioningAttemptStore as ledger } from '../../../src/api/services/persistence.js';
import {
  provisionTestVm,
  releaseTestVms,
  walkToState,
} from '../../helpers/workload-store.js';

const NOW = Date.UTC(2026, 7, 26, 12, 0, 0);
const THRESHOLD = 5 * 60_000;

async function addRemovalAttempt(
  id: string,
  requestedAt: number,
  options: { ip?: string; ended?: boolean } = {},
): Promise<void> {
  await createTestWorkload(id, 'alice');
  const cloudId = `${id}-vm`;
  if (options.ip) {
    await provisionTestVm(id, { cloudId, ip: options.ip });
  } else {
    await provisionTestVm(id, { cloudId }, { region: 'us-east-1' });
  }
  await walkToState(id, WorkloadState.Terminated);
  await ledger().claimVmRemoval(id, [cloudId]);
  await getDB().query(
    `UPDATE vms SET removal_requested_at = ? WHERE workload_id = ?`,
    [requestedAt, id],
  );
  if (options.ended) await releaseTestVms(id, cloudId);
}

describe('overdue VM release summary', () => {
  beforeEach(async () => {
    await resetTestStore();
  });

  it('includes unresolved IP-less attempts and excludes young or ended rows', async () => {
    await addRemovalAttempt('release-summary-confirmed', NOW - THRESHOLD, {
      ip: '192.0.2.10',
    });
    await addRemovalAttempt('release-summary-placeholder', NOW - THRESHOLD);
    await addRemovalAttempt('release-summary-young', NOW - THRESHOLD + 1, {
      ip: '192.0.2.11',
    });
    await addRemovalAttempt('release-summary-ended', NOW - THRESHOLD - 1, {
      ip: '192.0.2.12',
      ended: true,
    });

    await expect(
      ledger().summarizeOverdueVmReleases(NOW - THRESHOLD),
    ).resolves.toEqual({
      vmCount: 2,
      workloadCount: 2,
      oldestRemovalRequestedAt: NOW - THRESHOLD,
      workloadIds: ['release-summary-confirmed', 'release-summary-placeholder'],
    });
  });

  it('orders and bounds the workload sample without changing totals', async () => {
    await addRemovalAttempt('release-summary-newest', NOW - THRESHOLD);
    await addRemovalAttempt('release-summary-oldest-b', NOW - THRESHOLD - 2);
    await addRemovalAttempt('release-summary-oldest-a', NOW - THRESHOLD - 2);

    await expect(
      ledger().summarizeOverdueVmReleases(NOW - THRESHOLD, 2),
    ).resolves.toEqual({
      vmCount: 3,
      workloadCount: 3,
      oldestRemovalRequestedAt: NOW - THRESHOLD - 2,
      workloadIds: ['release-summary-oldest-a', 'release-summary-oldest-b'],
    });
  });

  it('returns null when no release is overdue', async () => {
    await expect(
      ledger().summarizeOverdueVmReleases(NOW - THRESHOLD),
    ).resolves.toBeNull();
  });
});
