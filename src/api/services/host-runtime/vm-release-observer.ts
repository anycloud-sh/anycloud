/**
 * Cloud VM release observation shared by the retry, completion, and VM repair
 * workflows: one bounded provider read per VM at a time, stable release
 * confirmation, and a short memory of confirmed releases.
 */

import { log } from '../logger.js';
import { vmComputeIdentityKey, type VmCompute } from '../vm-compute.js';
import {
  createVMReleaseConfirmer,
  VM_RELEASED,
  VMReleaseState,
  vmReleaseUnknown,
  type VMReleaseConfirmer,
  type VMReleaseStatus,
} from '../gateways/cloud.js';
import { withTimeout, tcpPing } from '../../../shared/utils.js';
import type { DbVM } from '../entities.js';

const VM_RELEASE_PROVIDER_DEADLINE_MS = 25_000;
const VM_RELEASE_MONITOR_TIMEOUT_MS = 30_000;

interface VMReleaseCheckEntry {
  controller: AbortController;
  promise: Promise<VMReleaseStatus>;
}

// A timed-out SDK read remains tracked until it settles, preventing the next
// monitor tick from starting overlapping work. Authoritative late termination
// results are retained briefly so the next tick can consume them.
const vmReleaseChecks = new Map<string, VMReleaseCheckEntry>();
const vmReleaseConfirmers = new Map<string, VMReleaseConfirmer>();
const confirmedReleasedVMs = new Map<string, ReturnType<typeof setTimeout>>();
const CONFIRMED_RELEASED_TTL_MS = 5 * 60_000;

export function resetVMReleaseObserverForTests(): void {
  for (const entry of vmReleaseChecks.values()) {
    entry.controller.abort(new Error('VM termination monitor state reset'));
  }
  vmReleaseChecks.clear();
  vmReleaseConfirmers.clear();
  for (const expiry of confirmedReleasedVMs.values()) clearTimeout(expiry);
  confirmedReleasedVMs.clear();
}

function vmReleaseCheckKey(workloadId: string, vm: VmCompute): string {
  return `${workloadId}:${vmComputeIdentityKey(vm)}`;
}

function rememberConfirmedRelease(key: string): void {
  vmReleaseConfirmers.delete(key);
  const existing = confirmedReleasedVMs.get(key);
  if (existing) clearTimeout(existing);
  const expiry = setTimeout(
    () => confirmedReleasedVMs.delete(key),
    CONFIRMED_RELEASED_TTL_MS,
  );
  expiry.unref?.();
  confirmedReleasedVMs.set(key, expiry);
}

export function clearVMReleaseTracking(workloadId: string): void {
  const prefix = `${workloadId}:`;
  for (const [key, entry] of vmReleaseChecks) {
    if (!key.startsWith(prefix)) continue;
    entry.controller.abort(new Error('VM termination check no longer needed'));
    vmReleaseChecks.delete(key);
  }
  for (const [key, expiry] of confirmedReleasedVMs) {
    if (!key.startsWith(prefix)) continue;
    clearTimeout(expiry);
    confirmedReleasedVMs.delete(key);
  }
  for (const key of vmReleaseConfirmers.keys()) {
    if (key.startsWith(prefix)) vmReleaseConfirmers.delete(key);
  }
}

export async function checkVMRelease(
  workloadId: string,
  vm: VmCompute,
): Promise<VMReleaseStatus> {
  const { cloudId } = vm.identity;
  const key = vmReleaseCheckKey(workloadId, vm);
  if (confirmedReleasedVMs.has(key)) return VM_RELEASED;

  let entry = vmReleaseChecks.get(key);
  if (!entry) {
    const existingConfirmer = vmReleaseConfirmers.get(key);
    const confirmer =
      existingConfirmer ??
      createVMReleaseConfirmer(vm.releaseConfirmationPolicy);
    if (!existingConfirmer) {
      vmReleaseConfirmers.set(key, confirmer);
    }
    const controller = new AbortController();
    const startedAt = Date.now();
    const providerDeadline = setTimeout(
      () =>
        controller.abort(
          new Error(
            `Cloud VM status provider deadline exceeded after ${VM_RELEASE_PROVIDER_DEADLINE_MS}ms`,
          ),
        ),
      VM_RELEASE_PROVIDER_DEADLINE_MS,
    );
    providerDeadline.unref?.();

    const promise = Promise.resolve()
      .then(() =>
        confirmer.observe(() =>
          vm.observeReleaseOnce({
            signal: controller.signal,
          }),
        ),
      )
      .catch((error) => vmReleaseUnknown(error))
      .then((status) => {
        log.info('Cloud VM status check completed', {
          id: workloadId,
          cloudId,
          cloud: vm.identity.provider,
          status: status.state,
          durationMs: Date.now() - startedAt,
          ...(status.state === VMReleaseState.Unknown && {
            error: status.error,
          }),
        });
        if (
          status.state === VMReleaseState.Released &&
          vmReleaseChecks.get(key)?.controller === controller
        ) {
          rememberConfirmedRelease(key);
        }
        return status;
      })
      .finally(() => {
        clearTimeout(providerDeadline);
        if (vmReleaseChecks.get(key)?.controller === controller) {
          vmReleaseChecks.delete(key);
        }
      });
    entry = { controller, promise };
    vmReleaseChecks.set(key, entry);
  }

  try {
    return await withTimeout(
      entry.promise,
      VM_RELEASE_MONITOR_TIMEOUT_MS,
      `checkVMRelease for ${cloudId}`,
    );
  } catch (error) {
    return vmReleaseUnknown(error);
  }
}

export function isVmSshReachable(
  vm: Pick<DbVM, 'ip' | 'sshHost' | 'sshPort'>,
): Promise<boolean> {
  return tcpPing(vm.sshHost ?? vm.ip, vm.sshPort ?? 22, 5000);
}
