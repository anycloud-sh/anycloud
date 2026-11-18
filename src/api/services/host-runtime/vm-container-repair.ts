/**
 * Persistent-VM container repair on the existing Running host: observe the
 * deterministic container and create it only when it is absent.
 */

import { getWorkloadQueryStore } from '../persistence.js';
import { DockerManager } from '../docker.js';
import { WorkloadState, WorkloadType } from '../../../shared/workload.js';
import { ContainerState } from '../../../shared/runtime.js';
import { loadWorkloadConfigs } from '../cloud-config.js';
import { gpuRuntimeForVMType } from '../../../shared/cloud-config.js';
import type { DbVM } from '../entities.js';
import type { StoredWorkload } from '../workload-record.js';
import { resolveContainerRuntime } from './host-startup.js';
import { pullImage } from './image-delivery.js';

/** The workload and live-VM reads the repair re-checks around each effect. */
interface VmContainerRepairStore {
  getWorkload(workloadId: string): Promise<StoredWorkload | null>;
  getVMs(workloadId: string): Promise<DbVM[]>;
}

export type RunningVmContainerReconcileResult = (
  | { outcome: 'healthy' }
  | { outcome: 'created' }
  | { outcome: 'converged' }
  | { outcome: 'observed'; state: ContainerState }
  | { outcome: 'conflict'; state: ContainerState }
  | { outcome: 'deferred'; reason: string }
  | { outcome: 'stale' }
) & { repairAttempted?: true };

function classifyExistingVmContainer(
  inspection: Awaited<ReturnType<DockerManager['inspectVmContainer']>>,
): RunningVmContainerReconcileResult {
  if (inspection.kind === 'missing') return { outcome: 'stale' };
  if (inspection.kind === 'conflict') {
    return { outcome: 'conflict', state: inspection.state };
  }
  return inspection.state === ContainerState.Running
    ? { outcome: 'healthy' }
    : { outcome: 'observed', state: inspection.state };
}

/**
 * Reconcile the VM container on an existing Running VM. This path is
 * intentionally narrower than startup: it never allocates/replaces a host and
 * only creates the deterministic container when it is absent.
 */
export async function reconcileRunningVmContainer(
  workloadId: string,
): Promise<RunningVmContainerReconcileResult> {
  const store: VmContainerRepairStore = getWorkloadQueryStore();
  const [observedWorkload, observedVms] = await Promise.all([
    store.getWorkload(workloadId),
    store.getVMs(workloadId),
  ]);
  if (
    !observedWorkload ||
    observedWorkload.workloadType !== WorkloadType.Vm ||
    observedWorkload.state !== WorkloadState.Running
  ) {
    return { outcome: 'stale' };
  }
  if (observedVms.length !== 1) {
    return {
      outcome: 'deferred',
      reason: `expected one live VM ledger row, found ${observedVms.length}`,
    };
  }

  const observedVm = observedVms[0];
  let docker = new DockerManager(
    observedVm.sshHost ?? observedVm.ip,
    observedWorkload.sshPrivateKey,
    observedVm.sshPort,
  );
  const initial = await docker.inspectVmContainer(observedWorkload);
  if (initial.kind !== 'missing') return classifyExistingVmContainer(initial);
  const attempted = <T extends RunningVmContainerReconcileResult>(
    result: T,
  ): T & { repairAttempted: true } => ({
    ...result,
    repairAttempted: true,
  });

  try {
    // NotFound is only an observation. Re-read both durable owners before doing
    // any repair preparation and require the same single live cloud VM.
    const [workload, liveVms] = await Promise.all([
      store.getWorkload(workloadId),
      store.getVMs(workloadId),
    ]);
    if (
      !workload ||
      workload.workloadType !== WorkloadType.Vm ||
      workload.state !== WorkloadState.Running
    ) {
      return attempted({ outcome: 'stale' });
    }
    if (liveVms.length !== 1) {
      return attempted({
        outcome: 'deferred',
        reason: `expected one live VM ledger row, found ${liveVms.length}`,
      });
    }
    const vm = liveVms[0];
    if (vm.cloudId !== observedVm.cloudId) {
      return attempted({ outcome: 'stale' });
    }

    docker = new DockerManager(
      vm.sshHost ?? vm.ip,
      workload.sshPrivateKey,
      vm.sshPort,
    );
    const rechecked = await docker.inspectVmContainer(workload);
    if (rechecked.kind !== 'missing') {
      const result = classifyExistingVmContainer(rechecked);
      return attempted(
        result.outcome === 'healthy' ? { outcome: 'converged' } : result,
      );
    }

    const cloudConfig = await loadWorkloadConfigs(workload, vm.credentialId);
    if (!cloudConfig) {
      return attempted({
        outcome: 'deferred',
        reason: 'compute credentials unavailable',
      });
    }

    if (!(await docker.hasWorkloadImage(workload))) {
      const gpuRuntime =
        typeof cloudConfig.vmType === 'string'
          ? gpuRuntimeForVMType(cloudConfig.cloudProvider, cloudConfig.vmType)
          : null;
      await pullImage(docker, workload, {
        preferContainerdTransfer:
          gpuRuntime !== null || !!workload.dockerOptions?.gpus,
      });
    }
    const { runtimeProps, secrets } = await resolveContainerRuntime(
      workload,
      cloudConfig,
    );
    const create = await docker.createContainerIfAbsent(
      runtimeProps,
      secrets,
      async () => {
        const [current, currentVms] = await Promise.all([
          store.getWorkload(workloadId),
          store.getVMs(workloadId),
        ]);
        return (
          current?.workloadType === WorkloadType.Vm &&
          current.state === WorkloadState.Running &&
          currentVms.length === 1 &&
          currentVms[0].cloudId === vm.cloudId
        );
      },
    );
    switch (create.outcome) {
      case 'created':
        await docker.assertVmContainerReady(workloadId);
        return attempted({ outcome: 'created' });
      case 'already-running':
        return attempted({ outcome: 'converged' });
      case 'managed-not-running':
        return attempted({ outcome: 'observed', state: create.state });
      case 'conflict':
        return attempted({ outcome: 'conflict', state: create.state });
      case 'aborted':
        return attempted({ outcome: 'stale' });
    }
  } catch (error) {
    if (error instanceof Error) {
      Object.assign(error, { vmRepairAttempted: true });
    }
    throw error;
  }
}
