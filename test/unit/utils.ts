import {
  resetPersistence,
  getWorkloadQueryStore as queries,
} from '../../src/api/services/persistence.js';
import { walkToState } from '../helpers/workload-store.js';
import { getDB } from '../../src/api/services/repositories/db.js';
import { WorkloadState } from '../../src/shared/workload.js';
import { CloudType } from '../../src/shared/cloud.js';
import { setImmediate as yieldToIo } from 'node:timers/promises';
import { vi } from 'vitest';
import { createWorkload } from '../../src/api/services/repositories/workload-creation.js';

/** Drive virtual sleeps while allowing database I/O between timer waves. */
export async function settleWithFakeTimers<T>(work: Promise<T>): Promise<T> {
  let settled = false;
  void work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while (!settled) {
    await vi.advanceTimersByTimeAsync(100);
    await yieldToIo();
  }
  return work;
}

/**
 * Reset the workload store and seed the canonical test credential rows
 * referenced by test fixtures. Use this in beforeEach of any spec that
 * inserts workloads with literal credentialId strings — without the seed,
 * FK enforcement (migration 0042) rejects the insert.
 */
export async function resetTestStore(): Promise<void> {
  resetPersistence();
  for (const id of ['test-credential-id', 'test-cred', 'test-cred-id']) {
    await getDB().query(
      `INSERT OR IGNORE INTO credentials (id, encrypted_data, cloud_provider) VALUES (?, '', 'AWS')`,
      [id],
    );
  }
}

/**
 * Helper to create a test workload in SQLite
 */
export async function createTestWorkload(
  id: string,
  userId: string,
  state: WorkloadState = WorkloadState.Queued,
  /**
   * Create the workload with no compute credential. Three callers were
   * already passing this as a fourth argument the signature did not take, so
   * the tests named "without credentials" ran with one.
   */
  withoutCredentials = false,
  ownerUserId?: string,
): Promise<void> {
  // Seed the credential row that the fixture references so FK enforcement
  // (migration 0042) doesn't reject the workload insert.
  await getDB().query(
    `INSERT OR IGNORE INTO credentials (id, encrypted_data, cloud_provider) VALUES (?, '', 'AWS')`,
    ['test-credential-id'],
  );
  await createWorkload(getDB(), {
    id,
    userId,
    ownerUserId,
    workloadType: 'job',
    image: 'test-image',
    dockerCommand: 'docker run -d --name test test-image',
    requestedComputeProvider: CloudType.AWS,
    region: 'us-east-1',
    vmType: 't3.medium',
    spot: false,
    sshPrivateKey: 'test-ssh-private-key',
    credentialId: withoutCredentials ? null : 'test-credential-id',
  });
  // Update state if not the initial Queued state
  if (state !== WorkloadState.Queued) {
    await walkToState(id, state);
  }
}

/**
 * Helper to get workload from SQLite
 */
export async function getTestWorkload(id: string) {
  return queries().getWorkload(id);
}
