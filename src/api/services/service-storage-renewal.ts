import { WorkloadState, WorkloadType } from '../../shared/workload.js';
import { loadWorkloadConfigs } from './cloud-config.js';
import { createTransport } from './gateways/transport.js';
import { log } from './logger.js';
import { getWorkloadQueryStore } from './persistence.js';
import { SupervisorManager } from './supervisor.js';
import { mintedUploadBuckets, renewAt } from './vm-runtime-storage.js';
import type { StoredWorkload } from './workload-record.js';
import type { WorkloadReconcileResult } from './workload-reconciler.js';
import {
  hasWorkloadWork,
  trackWorkloadWork,
} from './workload-work-registry.js';

/**
 * Renew the minted bucket tokens of running VM-host Jobs and Services a few
 * minutes before each token's own expiry. Timing is disposable: a fresh API
 * immediately remints for every running workload.
 */
export function createStorageRenewer() {
  const deadlines = new Map<string, { vms: string; renewAt: number }>();

  return {
    forget(id: string): void {
      deadlines.delete(id);
    },

    async renew(workload: StoredWorkload): Promise<WorkloadReconcileResult> {
      const id = workload.id;
      if (
        (workload.workloadType !== WorkloadType.Service &&
          workload.workloadType !== WorkloadType.Job) ||
        workload.state !== WorkloadState.Running ||
        !(workload.outputBucket || workload.checkpointBucket || workload.spot)
      ) {
        deadlines.delete(id);
        return { disposition: 'stale' };
      }
      if (hasWorkloadWork(id)) return { disposition: 'deferred' };

      // Register before starting asynchronous work. Upgrade/cleanup may claim a
      // state transition, but their teardown waits for this operation to settle.
      const operation = Promise.resolve().then(
        async (): Promise<WorkloadReconcileResult> => {
          const store = getWorkloadQueryStore();
          const vms = await store.getVMs(id);
          if (vms.length === 0) return { disposition: 'stale' };
          const vmKey = vms.map((vm) => vm.cloudId).join(',');
          const deadline = deadlines.get(id);
          if (deadline?.vms === vmKey && deadline.renewAt > Date.now()) {
            return { disposition: 'completed' };
          }

          const cloudConfig = await loadWorkloadConfigs(
            workload,
            vms[0].credentialId,
          );
          if (!cloudConfig)
            throw new Error('Workload storage credentials are unavailable');
          const buckets = await mintedUploadBuckets(cloudConfig, id);
          const at = renewAt(buckets);
          if (at === undefined) {
            // Instance identity renews through the cloud metadata service.
            deadlines.set(id, { vms: vmKey, renewAt: Infinity });
            return { disposition: 'completed' };
          }
          if (at <= Date.now()) {
            throw new Error('Minted storage token has no usable expiration');
          }

          const [current, currentVms] = await Promise.all([
            store.getWorkload(id),
            store.getVMs(id),
          ]);
          if (
            current?.state !== WorkloadState.Running ||
            current.outputBucket !== workload.outputBucket ||
            current.checkpointBucket !== workload.checkpointBucket ||
            current.checkpointStorageCredentialId !==
              workload.checkpointStorageCredentialId ||
            current.checkpointStorageRegion !==
              workload.checkpointStorageRegion ||
            currentVms.map((vm) => vm.cloudId).join(',') !== vmKey
          ) {
            deadlines.delete(id);
            return { disposition: 'stale' };
          }

          await Promise.all(
            currentVms.map((vm) =>
              new SupervisorManager(
                createTransport(
                  vm.sshHost ?? vm.ip,
                  current.sshPrivateKey!,
                  vm.sshPort,
                  vm.sshUsername,
                ),
              ).refreshRcloneCredentials(buckets),
            ),
          );
          deadlines.set(id, { vms: vmKey, renewAt: at });
          log.info('Minted storage credentials renewed', {
            id,
            buckets: Object.values(buckets).map((bucket) => bucket.name),
            renewAt: at,
          });
          return { disposition: 'completed' };
        },
      );
      trackWorkloadWork(id, operation);
      return operation;
    },
  };
}
