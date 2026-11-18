import { WorkloadState } from '../../../../../src/shared/workload.js';

import type { ArtifactStore } from '../artifacts.js';
import type { WorkloadKernel } from '../workloads.js';
import type { HostIdentityCapability } from '../host-identity.js';
import type { SecretManager } from '../secrets.js';
import type {
  ContractQualification,
  PersistentVmContractResult,
  PersistentVmRunningContext,
  PersistentVmTarget,
  PersistentVmTerminatedObservationAttempt,
  ProviderTerminatedObservation,
} from '../targets/persistent-vm-types.js';
import type { PersistentVmTargetFactory } from '../targets/persistent-vm.js';
import type { VmHarness } from '../vm.js';
import type { VmLedgerProbe } from '../vm-ledger.js';
import { WaitTimeoutError } from '../wait.js';
import {
  observePersistentVmRunning,
  persistentVmInvariant,
  persistentVmObservationContext,
  provisionRunningPersistentVm,
  type PersistentVmRunningDependencies,
  validatePersistentVmTerminatedObservation,
} from './persistent-vm-running.js';
import { waitForPersistentVmHostRelease } from './persistent-vm-host-release.js';
import {
  terminatedEvidence,
  type PersistentVmContractPolicy,
} from './persistent-vm-policy.js';

export interface PersistentVmContractDependencies
  extends PersistentVmRunningDependencies {
  readonly artifacts: Pick<ArtifactStore, 'json'>;
  readonly hostIdentity: HostIdentityCapability;
  readonly kernel: PersistentVmRunningDependencies['kernel'] &
    Pick<
      WorkloadKernel,
      'release' | 'requestTermination' | 'status' | 'waitForCleanupRecorded'
    >;
  readonly secrets: PersistentVmRunningDependencies['secrets'] &
    Pick<SecretManager, 'delete'>;
  readonly targets: PersistentVmRunningDependencies['targets'] &
    Pick<PersistentVmTargetFactory, 'observeTerminated'>;
  readonly vmLedger: PersistentVmRunningDependencies['vmLedger'] &
    Pick<VmLedgerProbe, 'assertCleared' | 'liveVmMetadata'>;
  readonly vm: PersistentVmRunningDependencies['vm'] &
    Pick<
      VmHarness,
      | 'ghcrCredentialFiles'
      | 'removeWorkload'
      | 'seedLegacyGhcrLoginAndRemoveWorkload'
      | 'waitForRepair'
      | 'workloadContainerId'
    >;
}

function describeTerminatedAttempt(
  attempt: PersistentVmTerminatedObservationAttempt,
): string {
  const { observation } = attempt;
  return observation.kind === 'provider-api'
    ? `${observation.provider} ${observation.outcome}`
    : `local-smolvm ${String(observation.remainingMachineCount)} remaining`;
}

export async function observePersistentVmTerminated(
  dependencies: {
    readonly artifacts: Pick<ArtifactStore, 'json'>;
    readonly targets: Pick<PersistentVmTargetFactory, 'observeTerminated'>;
    readonly wait: PersistentVmRunningDependencies['wait'];
  },
  target: PersistentVmTarget,
  context: PersistentVmRunningContext,
  policy: PersistentVmContractPolicy,
): Promise<ContractQualification> {
  const evidence = terminatedEvidence(target);
  if (evidence.kind === 'provider-api') {
    const expectedProvider = evidence.provider;
    persistentVmInvariant(
      policy.terminatedObservation,
      `${target} is missing its provider termination policy`,
    );
    let attempt: PersistentVmTerminatedObservationAttempt;
    try {
      attempt = await dependencies.wait.for(
        `${target} provider termination for ${context.cloudId}`,
        (deadlineAt) =>
          dependencies.targets.observeTerminated(target, context, deadlineAt),
        {
          timeoutMs: policy.terminatedObservation.timeoutMs,
          intervalMs: policy.terminatedObservation.intervalMs,
          probeError: 'fail',
          unmet: (candidate) =>
            candidate.observation.kind === 'provider-api' &&
            candidate.observation.provider === expectedProvider &&
            candidate.observation.outcome === 'terminated'
              ? undefined
              : describeTerminatedAttempt(candidate),
          reject: (candidate) => {
            if (candidate.observation.kind !== 'provider-api') {
              return `${target} transport returned the wrong termination evidence`;
            }
            if (candidate.observation.provider !== expectedProvider) {
              return `${target} termination evidence identified the wrong provider`;
            }
            if (candidate.observation.outcome === 'present') {
              return `${target} still reports ${context.cloudId} present`;
            }
            return candidate.observation.outcome === 'invalid'
              ? `${target} termination verifier returned an invalid response`
              : undefined;
          },
        },
      );
    } catch (error) {
      if (!(error instanceof WaitTimeoutError)) throw error;
      const observation: ProviderTerminatedObservation = {
        kind: 'provider-api',
        outcome: 'inconclusive',
        provider: expectedProvider,
      };
      await dependencies.artifacts.json(
        `${target}-terminated-observation`,
        observation,
      );
      return validatePersistentVmTerminatedObservation(target, observation);
    }
    await dependencies.artifacts.json(
      `${target}-terminated-observation`,
      attempt.observation,
    );
    return validatePersistentVmTerminatedObservation(
      target,
      attempt.observation,
    );
  }

  persistentVmInvariant(
    !policy.terminatedObservation,
    `${target} has an undeclared provider termination policy`,
  );
  const attempt = await dependencies.targets.observeTerminated(target, context);
  return validatePersistentVmTerminatedObservation(target, attempt.observation);
}

export class PersistentVmContract {
  readonly #dependencies: PersistentVmContractDependencies;

  constructor(dependencies: PersistentVmContractDependencies) {
    this.#dependencies = dependencies;
  }

  async run(target: PersistentVmTarget): Promise<PersistentVmContractResult> {
    const running = await provisionRunningPersistentVm(
      this.#dependencies,
      target,
      `vm-${target}`,
    );
    const {
      environmentMarker,
      fixtureObservation,
      policy,
      ref,
      runningContext,
      secretDigest,
      secretName,
      workload,
      workspaceMarker,
      workspaceMarkerFile,
    } = running;
    const { id: workloadId } = ref;

    // A private GHCR image (e2e-vm.yml `private_ghcr`) pulls with the
    // submitter's token; neither the pull nor the repair may leave it on the
    // host, and the repair must scrub a login an earlier release left there.
    const ghcrAuth =
      this.#dependencies.environment.optional('ANYCLOUD_E2E_GHCR_AUTH') ===
      'true';
    const assertNoGhcrCredential = async (pull: string) => {
      const files = await this.#dependencies.vm.ghcrCredentialFiles(workloadId);
      persistentVmInvariant(
        files.length === 0,
        `${pull} left a GHCR credential on the host: ${files.join(', ')}`,
      );
    };
    const originalContainerId =
      await this.#dependencies.vm.workloadContainerId(workloadId);
    if (ghcrAuth) {
      await assertNoGhcrCredential('the private GHCR pull');
      await this.#dependencies.vm.seedLegacyGhcrLoginAndRemoveWorkload(
        workloadId,
      );
    } else {
      await this.#dependencies.vm.removeWorkload(workloadId);
    }
    const repairedContainerId = await this.#dependencies.vm.waitForRepair(
      workloadId,
      originalContainerId,
      workspaceMarkerFile,
      workspaceMarker,
      policy.repairTimeoutMs,
    );
    persistentVmInvariant(
      repairedContainerId !== originalContainerId,
      'repair must create a new workload container',
    );
    if (ghcrAuth) await assertNoGhcrCredential('the repair pull');
    persistentVmInvariant(
      JSON.stringify(
        await this.#dependencies.vm.inspectWorkload(workloadId),
      ) === JSON.stringify(workload),
      'repaired workload must preserve the runtime contract',
    );
    persistentVmInvariant(
      JSON.stringify(
        await this.#dependencies.vm.probeWorkloadFixture(
          workloadId,
          environmentMarker,
          secretDigest,
        ),
      ) === JSON.stringify(fixtureObservation),
      'repaired workload must preserve its environment and secret',
    );

    const repairedStatus = await this.#dependencies.kernel.status(ref);
    await this.#dependencies.nativeCleanup.capture(ref, repairedStatus);
    const repairedLiveVms = this.#dependencies.vmLedger.liveEntries(
      this.#dependencies.vmLedger.snapshot(ref, repairedStatus),
    );
    const repairedVm = repairedLiveVms[0];
    persistentVmInvariant(
      repairedStatus.workload.state === WorkloadState.Running &&
        repairedLiveVms.length === 1 &&
        repairedVm &&
        repairedVm.cloudId === runningContext.cloudId,
      'repair must retain one live row for the same cloud VM',
    );
    const repairedMetadata =
      await this.#dependencies.vmLedger.liveVmMetadata(ref);
    persistentVmInvariant(
      repairedMetadata.cloudId === runningContext.cloudId,
      'repair must retain the original cloud VM in the ledger',
    );
    persistentVmInvariant(
      (await this.#dependencies.vmLedger.liveVmCount(ref)) === 1,
      'repair must retain one live VM row',
    );
    await observePersistentVmRunning(
      this.#dependencies,
      target,
      persistentVmObservationContext(
        target,
        {
          ...runningContext,
          sshHost: repairedVm.sshHost ?? repairedVm.ip,
          sshPort: repairedVm.sshPort ?? 22,
          sshUsername: repairedVm.sshUsername ?? 'root',
        },
        repairedMetadata,
      ),
    );
    const originalHostIdentity = await this.#dependencies.hostIdentity.capture(
      ref.id,
      {
        host: runningContext.sshHost,
        port: runningContext.sshPort,
      },
    );

    await this.#dependencies.kernel.requestTermination(
      ref,
      policy.cleanupTimeoutMs,
    );
    const terminated = await this.#dependencies.kernel.waitForState(
      ref,
      WorkloadState.Terminated,
      policy.terminatedTimeoutMs,
    );
    persistentVmInvariant(
      terminated.workload.state === WorkloadState.Terminated &&
        typeof terminated.workload.completedAt === 'number',
      'termination must persist an exact terminal outcome',
    );
    const cleanup = await this.#dependencies.kernel.waitForCleanupRecorded(
      ref,
      policy.cleanupTimeoutMs,
    );
    persistentVmInvariant(
      cleanup.status.workload.state === WorkloadState.Terminated &&
        typeof cleanup.status.workload.completedAt === 'number' &&
        typeof cleanup.status.workload.cleanedAt === 'number' &&
        cleanup.status.workload.cleanedAt >=
          cleanup.status.workload.completedAt,
      'termination cleanup timestamps are invalid',
    );
    if (policy.teardownMaxMs !== undefined) {
      persistentVmInvariant(
        cleanup.status.workload.cleanedAt -
          cleanup.status.workload.completedAt <=
          policy.teardownMaxMs,
        'termination must release the provider VM within the teardown budget',
      );
    }
    const ledger = await this.#dependencies.vmLedger.assertCleared(ref);
    const qualification = await observePersistentVmTerminated(
      this.#dependencies,
      target,
      runningContext,
      policy,
    );
    persistentVmInvariant(
      qualification === 'conclusive',
      'inconclusive termination cannot establish native absence or release tracking',
    );
    await this.#dependencies.nativeCleanup.capture(ref, cleanup.status);
    const substrate = await this.#dependencies.nativeCleanup.verify(
      ref,
      policy.cleanupTimeoutMs,
    );
    await waitForPersistentVmHostRelease(
      this.#dependencies,
      ref.id,
      originalHostIdentity,
      policy.hostReleaseTimeoutMs,
    );
    await this.#dependencies.secrets.delete(secretName);
    await this.#dependencies.kernel.release({
      cleanup,
      ledger,
      substrate,
    });

    const result: PersistentVmContractResult = {
      contract: 'persistent-vm',
      qualification,
      target,
      satisfied: true,
    };
    await this.#dependencies.artifacts.json('persistent-vm-result', result);
    return result;
  }
}
