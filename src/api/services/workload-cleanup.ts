import {
  getProvisioningAttemptStore,
  getWorkloadEventStore,
  getWorkloadOutcomes,
  getWorkloadQueryStore,
} from './persistence.js';
import {
  captureVmStorageDiagnostics,
  hasVmRuntimeStorage,
} from './vm-runtime-storage.js';
import { cleanupManagedWorkloadStorage } from './workload-storage.js';
import { type StoredWorkload } from './workload-record.js';
import { type CloudConfig } from '../../shared/cloud.js';
import { WorkloadState, isTerminalState } from '../../shared/workload.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import { withTimeout } from '../../shared/utils.js';
import { TERMINAL_DIAGNOSTICS_TIMEOUT_MS } from '../config.js';
import { log } from './logger.js';

/** The cleanup pass bookkeeping and completion fence this controller commits. */
export interface WorkloadCleanupOutcomes {
  recordCleanupAttempt(workloadId: string): Promise<boolean>;
  recordCleanupError(workloadId: string, reason: string): Promise<void>;
  markCleanupComplete(
    workloadId: string,
    options?: { ensureAttemptCounted?: boolean },
  ): Promise<boolean>;
}

/** The best-effort diagnostics write on the terminal outcome event. */
interface WorkloadCleanupEvents {
  updateTerminalDiagnostics(
    workloadId: string,
    metadata: Record<string, unknown>,
  ): Promise<void>;
}

/** The attempt read that names a deferral no live VM explains. */
interface WorkloadCleanupAttempts {
  getUnresolvedProvisioningAttempts(
    workloadId: string,
  ): Promise<Array<{ cloud_id: string }>>;
}

/**
 * Run teardown after the terminal outcome is durable, then commit cleaned_at.
 * The supplied callback owns runtime resources; this controller owns the final
 * storage and database fence shared by VM and Kubernetes runtimes.
 */
export async function completeWorkloadCleanup(
  cloudConfig: CloudConfig,
  id: string,
  cleanupResources: (workload: StoredWorkload) => Promise<void>,
): Promise<boolean> {
  const store = getWorkloadQueryStore();
  const outcomes: WorkloadCleanupOutcomes = getWorkloadOutcomes();
  const workload = await store.getWorkload(id);
  if (
    !workload ||
    !isTerminalState(workload.state) ||
    workload.completedAt === null ||
    workload.cleanedAt !== null
  ) {
    return false;
  }

  // Count the pass at entry; the completion UPDATE backstops a failed write
  // so a cleaned workload can never record zero passes (RFC 0031).
  const attemptCounted = await outcomes.recordCleanupAttempt(id);

  // Explicit termination is the only terminal path without prior exit
  // diagnostics. Native runtimes have no VM row and naturally skip this.
  if (
    hasVmRuntimeStorage(cloudConfig) &&
    workload.sshPrivateKey &&
    workload.state === WorkloadState.Terminated
  ) {
    const vms = await store.getVMs(id);
    if (vms.length > 0) {
      // captureVmStorageDiagnostics swallows its own errors, but its SSH budget
      // is unbounded from here; the deadline is what keeps a wedged box from
      // billing through every cleanup attempt before terminate is even called.
      const diagnostics = await withTimeout(
        captureVmStorageDiagnostics(vms[0], workload.sshPrivateKey, id),
        TERMINAL_DIAGNOSTICS_TIMEOUT_MS,
        `terminal diagnostics for ${id}`,
      ).catch((error: unknown) => {
        log.warn('Terminal diagnostics timed out — proceeding with teardown', {
          id,
          error: error,
        });
        return undefined;
      });
      if (diagnostics) {
        const events: WorkloadCleanupEvents = getWorkloadEventStore();
        await events.updateTerminalDiagnostics(id, { logs: diagnostics });
      }
    }
  }

  // The reason a pass did not commit is recorded on the workload so
  // `anycloud status` can show it; only the API log knew before (F run 6).
  try {
    await cleanupResources(workload);
  } catch (error) {
    await outcomes.recordCleanupError(id, errorMessage(error));
    throw error;
  }

  // Managed storage stays intact until every provider-backed VM attempt has
  // been retired; markCleanupComplete enforces the same fence atomically.
  const liveVMs = await store.getVMs(id);
  if (liveVMs.length > 0) {
    // Every minute between here and the next attempt is billed to the user, so
    // the deferral is worth a line even though the reconciler retries it. Which
    // vmIds survived is what distinguishes a provider that has not reported the
    // instance gone yet from a terminate call that never landed.
    log.warn('Cleanup deferred — VM rows still live after teardown', {
      id,
      liveVmCount: liveVMs.length,
      cloudIds: liveVMs.map((vm) => vm.cloudId),
    });
    await outcomes.recordCleanupError(
      id,
      `VM still live after teardown: ${liveVMs.map((vm) => vm.cloudId).join(', ')}`,
    );
    return false;
  }

  try {
    await cleanupManagedWorkloadStorage(cloudConfig, id);
  } catch (error) {
    await outcomes.recordCleanupError(id, errorMessage(error));
    throw error;
  }
  const completed = await outcomes.markCleanupComplete(id, {
    ensureAttemptCounted: !attemptCounted,
  });
  if (!completed) {
    // The guard above reads getVMs, which excludes rows with no IP;
    // markCleanupComplete fences on every un-ended vms row. A failed
    // provisioning attempt whose cloud resource was never confirmed gone
    // therefore defers cleanup through a branch that guard cannot see — which
    // is the one deferral path that would otherwise still be silent.
    const attempts: WorkloadCleanupAttempts = getProvisioningAttemptStore();
    const unresolved = await attempts.getUnresolvedProvisioningAttempts(id);
    log.warn('Cleanup deferred — unretired provisioning attempts remain', {
      id,
      attemptCount: unresolved.length,
      cloudIds: unresolved.map((attempt) => attempt.cloud_id),
    });
    await outcomes.recordCleanupError(
      id,
      `provisioning attempt not confirmed released: ${unresolved.map((attempt) => attempt.cloud_id).join(', ')}`,
    );
  }
  return completed;
}
