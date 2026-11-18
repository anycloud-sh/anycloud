/**
 * Keep each running VM-host Workload's Secret files at the newest revision.
 * The poll compares every host's symlinks with the stored revisions and writes
 * only what differs, so a saved Secret, a rebooted host that lost `/run`, and
 * a restarted API all converge without delivery state in memory.
 */

import { WorkloadState } from '../../shared/workload.js';
import { DockerManager } from './docker.js';
import { log } from './logger.js';
import {
  getCredentialSecretStore,
  getWorkloadQueryStore,
} from './persistence.js';
import type { StoredWorkload } from './workload-record.js';
import {
  hasWorkloadWork,
  trackWorkloadWork,
} from './workload-work-registry.js';

/** Attached Secrets whose deletion was already logged. */
const missingLogged = new Set<string>();

export async function deliverLiveSecretFiles(
  workload: StoredWorkload,
): Promise<void> {
  const { id, secretNames } = workload;
  if (
    !secretNames?.length ||
    workload.deploymentId !== null ||
    workload.state !== WorkloadState.Running ||
    hasWorkloadWork(id)
  )
    return;

  const operation = deliver(workload, secretNames);
  trackWorkloadWork(id, operation);
  try {
    await operation;
  } catch (error) {
    // The container keeps its previous files; the next poll tries again.
    log.warn('Secret file delivery failed', { id, error });
  }
}

async function deliver(
  workload: StoredWorkload,
  names: readonly string[],
): Promise<void> {
  const { id } = workload;
  const store = getWorkloadQueryStore();
  const secrets = getCredentialSecretStore();
  const vms = await store.getVMs(id);
  const vmKey = vms.map((vm) => vm.cloudId).join(',');
  // Touches only the Workload's live VMs while it is still Running: the
  // poll's snapshot predates its own transitions (an unreachable Job may have
  // just moved to Recovering), so this is checked before any SSH.
  const workloadCurrent = async () => {
    const [current, currentVms] = await Promise.all([
      store.getWorkload(id),
      store.getVMs(id),
    ]);
    return (
      current?.state === WorkloadState.Running &&
      currentVms.map((vm) => vm.cloudId).join(',') === vmKey
    );
  };
  if (!(await workloadCurrent())) return;

  await Promise.all(
    vms.map(async (vm) => {
      const docker = new DockerManager(
        vm.sshHost ?? vm.ip,
        workload.sshPrivateKey!,
        vm.sshPort,
      );
      const held = await docker.readSecretFileRevisions(names);
      for (const name of names) {
        const revision = await secrets.getSecretRevision(name);
        if (revision === null) {
          if (!missingLogged.has(name))
            log.warn('Attached Secret is deleted; its last files stay', {
              id,
              secret: name,
            });
          missingLogged.add(name);
          continue;
        }
        missingLogged.delete(name);
        if (held.get(name) === revision) continue;
        const secret = await secrets.getRuntimeSecret(name);
        if (!secret || !(await workloadCurrent())) return;
        // Deliveries for one Workload run one at a time inside its poll, and
        // a save during this write wakes the next poll, which writes the newer
        // revision, so an older one never replaces a newer one.
        await docker.writeSecretFiles(secret);
        log.info('Secret files delivered', {
          id,
          host: docker.host,
          secret: name,
          revision: secret.revision,
        });
      }
    }),
  );
}
