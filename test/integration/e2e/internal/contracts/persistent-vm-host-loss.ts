import { WorkloadState } from '../../../../../src/shared/workload.js';

import type { ArtifactStore } from '../artifacts.js';
import type { WorkloadKernel } from '../workloads.js';
import type { SecretManager } from '../secrets.js';
import type {
  PersistentVmHostLossContractResult,
  PersistentVmTarget,
} from '../targets/persistent-vm-types.js';
import type { PersistentVmTargetFactory } from '../targets/persistent-vm.js';
import type { VmLedgerProbe } from '../vm-ledger.js';
import {
  persistentVmInvariant,
  provisionRunningPersistentVm,
  type PersistentVmRunningDependencies,
} from './persistent-vm-running.js';
import { scalarString } from '../types.js';

export const PERSISTENT_VM_HOST_LOSS_REASON =
  'Cloud provider confirms VM host no longer exists; Anycloud cannot recover its local /workspace.';

export interface PersistentVmHostLossContractDependencies
  extends PersistentVmRunningDependencies {
  readonly artifacts: Pick<ArtifactStore, 'json'>;
  readonly kernel: PersistentVmRunningDependencies['kernel'] &
    Pick<WorkloadKernel, 'eventsSince' | 'release' | 'waitForCleanupRecorded'>;
  readonly secrets: PersistentVmRunningDependencies['secrets'] &
    Pick<SecretManager, 'delete'>;
  readonly targets: PersistentVmRunningDependencies['targets'] &
    Pick<PersistentVmTargetFactory, 'deleteHost'>;
  readonly vmLedger: PersistentVmRunningDependencies['vmLedger'] &
    Pick<
      VmLedgerProbe,
      'assertCleared' | 'assertUnchangedSince' | 'entriesForCloudId'
    >;
}

export class PersistentVmHostLossContract {
  readonly #dependencies: PersistentVmHostLossContractDependencies;

  constructor(dependencies: PersistentVmHostLossContractDependencies) {
    this.#dependencies = dependencies;
  }

  async run(
    target: PersistentVmTarget,
  ): Promise<PersistentVmHostLossContractResult> {
    const running = await provisionRunningPersistentVm(
      this.#dependencies,
      target,
      `vm-host-loss-${target}`,
    );
    const {
      policy,
      profile,
      ref,
      runningContext,
      runningLedger,
      runningStatus,
      secretName,
    } = running;
    const eventBaseline = Math.max(
      0,
      ...runningStatus.events.map((event) => event.createdAt),
    );

    await this.#dependencies.targets.deleteHost(target, runningContext);
    const failed = await this.#dependencies.kernel.waitForState(
      ref,
      WorkloadState.Failed,
      policy.hostLossFailureTimeoutMs,
    );
    persistentVmInvariant(
      failed?.workload.state === WorkloadState.Failed,
      'workload must fail after its provider confirms host loss',
    );
    const cleanup = await this.#dependencies.kernel.waitForCleanupRecorded(
      ref,
      policy.cleanupTimeoutMs,
    );
    const { workload } = cleanup.status;
    const completedAt = workload.completedAt;
    const cleanedAt = workload.cleanedAt;

    persistentVmInvariant(
      workload.workloadType === 'vm' &&
        workload.cloudProvider === profile.provider &&
        workload.state === WorkloadState.Failed,
      'host-loss cleanup must preserve the failed persistent-VM outcome',
    );
    persistentVmInvariant(
      typeof completedAt === 'number' &&
        typeof cleanedAt === 'number' &&
        cleanedAt >= completedAt,
      'host-loss cleanup timestamps are invalid',
    );
    // Shares the ordinary teardown budget, including its opt-in: the host is
    // already gone here, so termination confirms on its first lookup and this
    // path should if anything be quicker than a live teardown.
    if (policy.teardownMaxMs !== undefined) {
      persistentVmInvariant(
        cleanedAt - completedAt <= policy.teardownMaxMs,
        'host-loss cleanup must retire the workload within the teardown budget',
      );
    }
    const cleanedLedger = this.#dependencies.vmLedger.assertUnchangedSince(
      ref,
      runningLedger,
      cleanup.status,
    );
    const originalVms = this.#dependencies.vmLedger.entriesForCloudId(
      cleanedLedger,
      runningContext.cloudId,
    );
    const [originalVm] = originalVms;
    persistentVmInvariant(
      originalVms.length === 1 &&
        originalVm &&
        String(originalVm.cloudId ?? '') === runningContext.cloudId &&
        typeof originalVm.endedAt === 'number' &&
        originalVm.endedAt >= completedAt,
      'the original VM ledger row must end after the failed transition',
    );

    const laterEvents = await this.#dependencies.kernel.eventsSince(
      ref,
      eventBaseline,
    );
    const failedEvents = laterEvents.filter(
      (event) =>
        event.state === WorkloadState.Failed &&
        event.metadata?.reason === PERSISTENT_VM_HOST_LOSS_REASON &&
        scalarString(event.metadata.cloudId) === runningContext.cloudId,
    );
    persistentVmInvariant(
      failedEvents.length === 1,
      'host loss must record exactly one failed event with its cloud ID and reason',
    );
    const recoveryStates = new Set<string>([
      WorkloadState.Recovering,
      WorkloadState.Queued,
      WorkloadState.Provisioning,
    ]);
    persistentVmInvariant(
      !laterEvents.some((event) => recoveryStates.has(event.state)),
      'persistent VM host loss must not enter a replacement lifecycle',
    );
    const ledger = await this.#dependencies.vmLedger.assertCleared(ref);
    await this.#dependencies.nativeCleanup.capture(ref, cleanup.status);
    const substrate = await this.#dependencies.nativeCleanup.verify(
      ref,
      policy.cleanupTimeoutMs,
    );

    await this.#dependencies.secrets.delete(secretName);
    await this.#dependencies.kernel.release({
      cleanup,
      ledger,
      substrate,
    });
    const result: PersistentVmHostLossContractResult = {
      contract: 'persistent-vm-host-loss',
      qualification: 'conclusive',
      target,
      satisfied: true,
    };
    await this.#dependencies.artifacts.json(
      'persistent-vm-host-loss-result',
      result,
    );
    return result;
  }
}
