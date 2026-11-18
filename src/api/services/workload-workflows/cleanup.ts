/**
 * Terminal cleanup workflow: reconstruct every owned attempt group, pause on a
 * failing credential, run the runtime's cleanup inside the shared cleanup
 * fence, and commit cleaned_at only once settlement is complete.
 */

import { log } from '../logger.js';
import { loadWorkloadConfigs } from '../cloud-config.js';
import {
  completeWorkloadCleanup,
  type WorkloadCleanupOutcomes,
} from '../workload-cleanup.js';
import { getDefaultServeRuntime } from '../serve/default-runtime.js';
import { getDefaultJobRuntime } from '../job/default-runtime.js';
import { TERMINATION_TIMEOUT_MS } from '../../config.js';
import { errorMessage } from '../../../shared/log-diagnostics.js';
import type { WorkloadReconcileResult } from '../workload-reconciler.js';
import { withTimeout } from '../../../shared/utils.js';
import type { StoredWorkload } from '../workload-record.js';
import type { CloudConfig } from '../../../shared/cloud.js';
import { WorkloadType } from '../../../shared/workload.js';
import {
  hasWorkloadWork,
  trackWorkloadWork,
} from '../workload-work-registry.js';

/** The workload reads this workflow uses. */
interface CleanupStore {
  resolveActiveCredentialId(
    workload: StoredWorkload,
    computeCredIdOverride?: string,
  ): Promise<string | undefined>;
}

/** The auth-failed mark that pauses cleanup until the credential is fixed. */
interface CleanupCredentials {
  isCredentialAuthFailed(credentialId: string): Promise<boolean>;
}

/** The attempt ledger this workflow reads for teardown placements. */
interface CleanupAttempts {
  getProvisioningAttempts(
    workloadId: string,
  ): Promise<Array<{ credential_id: string | null }>>;
}

/** The persistence the cleanup workflow receives from its composition. */
export interface CleanupPersistence {
  store: CleanupStore;
  outcomes: WorkloadCleanupOutcomes;
  attempts: CleanupAttempts;
  credentials: CleanupCredentials;
}

/**
 * A Service on a node pool owns no VM attempt, credential or bucket of its
 * own: its cloud is the node pool's, and its native objects are removed
 * through the node pool Service runtime. The shared cleanup fence still
 * commits `cleaned_at` only once that runtime confirms nothing remains.
 */
async function reconcileNodePoolServiceCleanup(
  workload: StoredWorkload,
): Promise<WorkloadReconcileResult> {
  const { id } = workload;
  if (workload.cloudProvider === null) {
    log.warn('Cleanup deferred — node pool Service has no resolved cloud', {
      id,
    });
    return { disposition: 'deferred' };
  }
  const cloudConfig: CloudConfig = { cloudProvider: workload.cloudProvider };
  const cleanup = completeWorkloadCleanup(
    cloudConfig,
    id,
    async (terminalWorkload) => {
      await getDefaultServeRuntime().cleanup({
        workload: terminalWorkload,
        placement: { cloudConfig },
      });
    },
  );
  trackWorkloadWork(id, cleanup);
  const cleaned = await withTimeout(
    cleanup,
    TERMINATION_TIMEOUT_MS,
    `cleanup for ${id}`,
  );
  return { disposition: cleaned ? 'completed' : 'deferred' };
}

export async function reconcileCleanupCandidate(
  { store, outcomes, attempts: ledger, credentials }: CleanupPersistence,
  workload: StoredWorkload,
): Promise<WorkloadReconcileResult> {
  const { id } = workload;
  try {
    if (hasWorkloadWork(id)) {
      log.info('Cleanup deferred — workload work still in flight', { id });
      return { disposition: 'deferred' };
    }

    if (workload.completedAt === null || workload.cleanedAt !== null) {
      return { disposition: 'stale' };
    }

    if (workload.nodePoolId !== null) {
      return await reconcileNodePoolServiceCleanup(workload);
    }

    // Resubmission remains blocked until cleaned_at is set, so no attempt can
    // belong to a replacement lifecycle. Historical placements are safe,
    // idempotent teardown inputs and remain useful for credential selection.
    const attempts = await ledger.getProvisioningAttempts(id);

    // VM-host runtimes write an attempt before their first provider mutation,
    // so an empty VM ledger means they created nothing.
    if (attempts.length === 0) {
      // No provider resource was ever created, but this is still a cleanup
      // pass and its count must survive (RFC 0031).
      const attemptCounted = await outcomes.recordCleanupAttempt(id);
      const cleaned = await outcomes.markCleanupComplete(id, {
        ensureAttemptCounted: !attemptCounted,
      });
      return { disposition: cleaned ? 'completed' : 'stale' };
    }

    // Pause cleanup while the workload's active credential is failing
    // auth. Resolve it the way cleanup itself does (most recent live VM's
    // credential, then the workload credential). Teardown can't succeed
    // without valid auth, so
    // retrying just re-storms the provider and floods logs; cleanup is
    // idempotent and resumes once this credential id is valid again. A rotated
    // secret under a new id needs an explicit credential re-point because
    // cleaned_at deliberately blocks resubmission until teardown finishes.
    const credId = await store.resolveActiveCredentialId(
      workload,
      attempts.at(-1)?.credential_id ?? undefined,
    );
    if (credId && (await credentials.isCredentialAuthFailed(credId))) {
      log.warn('Cleanup paused — credential invalid; re-enter a valid secret', {
        id,
      });
      return { disposition: 'deferred' };
    }

    // Reuse the credential just resolved (the documented override) so the
    // teardown path doesn't re-run the same getVMs resolution.
    const configs = await loadWorkloadConfigs(workload, credId);
    if (!configs) {
      log.warn('Cleanup retry: credentials missing', { id });
      return { disposition: 'deferred' };
    }
    const cloudConfig = configs;

    log.info('Retrying workload cleanup', { id });
    const cleanup = completeWorkloadCleanup(
      cloudConfig,
      id,
      async (terminalWorkload) => {
        await (terminalWorkload.workloadType === WorkloadType.Service
          ? getDefaultServeRuntime().cleanup({
              workload: terminalWorkload,
              placement: { cloudConfig },
            })
          : getDefaultJobRuntime().cleanup({
              workload: terminalWorkload,
              placement: { cloudConfig },
            }));
      },
    );
    trackWorkloadWork(id, cleanup);
    const cleaned = await withTimeout(
      cleanup,
      TERMINATION_TIMEOUT_MS,
      `cleanup for ${id}`,
    );
    if (cleaned) return { disposition: 'completed' };
    // Cleanup used a current terminal row and resubmission cannot occur before
    // cleaned_at. A false completion therefore means live attempt rows remain
    // and cleanup must retry.
    return { disposition: 'deferred' };
  } catch (e) {
    log.warn('Cleanup retry failed — will retry on next tick', {
      id,
      error: e,
    });
    // The lane's own timeout and credential lookups fail outside
    // completeWorkloadCleanup; the reason still belongs on the workload.
    await outcomes.recordCleanupError(id, errorMessage(e));
    return { disposition: 'deferred' };
  }
}
