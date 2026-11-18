import {
  encryptCredential,
  hashCredential,
} from '../../../src/api/services/cloud-config.js';
import { walkToState, provisionTestVm } from '../../helpers/workload-store.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { CloudType, type CloudCredentials } from '../../../src/shared/cloud.js';
import {
  WorkloadState,
  type WorkloadTypeValue,
} from '../../../src/shared/workload.js';
import { TEST_GCP_CRED } from './fixtures.js';
import { upsertCredential } from '../../../src/api/services/repositories/credential-secrets.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';

/**
 * Seed `n` Running jobs, each with one VM, sharing one real (decryptable)
 * credential so the *real* `loadWorkloadConfigs` works. Requires
 * `config.cipherKey` set (see the spec's beforeAll).
 */
async function seedJobs(
  n: number,
  opts: { spot: boolean; idPrefix: string },
): Promise<string[]> {
  const credentialId = await upsertCredential(
    getDB(),
    hashCredential(TEST_GCP_CRED),
    await encryptCredential(TEST_GCP_CRED),
    CloudType.GCP,
  );
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `${opts.idPrefix}-${i}`;
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      spot: opts.spot,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-ssh-key',
      credentialId,
    });
    await provisionTestVm(id, {
      ip: `10.0.${(i >> 8) & 255}.${i & 255}`,
      cloudId: `vm-${i}`,
    });
    await walkToState(id, WorkloadState.Running);
    ids.push(id);
  }
  return ids;
}

/**
 * Seed `n` Running spot workloads for reconciler poll discovery.
 */
export async function seedSpotWorkloads(n: number): Promise<string[]> {
  return seedJobs(n, { spot: true, idPrefix: 'preempt-scale' });
}

/**
 * Seed `n` Running (non-spot) jobs for reconciler poll discovery.
 */
export async function seedRunningJobs(n: number): Promise<string[]> {
  return seedJobs(n, { spot: false, idPrefix: 'job-scale' });
}

/**
 * Seed `n` Queued jobs on one credential, each pinned to a scalar
 * (region, vmType) so provisioning resolution takes its fast path and builds
 * no cloud gateway. `startedAtBase` fixes queue order deterministically, which
 * a scheduler-dispatch test needs: the wall must sort ahead of the work it is
 * expected not to starve. Requires `config.cipherKey` (see the spec's
 * beforeAll).
 */
export async function seedQueuedJobs(
  n: number,
  opts: {
    cloud: CloudType;
    credentials: CloudCredentials;
    region: string;
    vmType: string;
    spot: boolean;
    idPrefix: string;
    startedAtBase: number;
    /** Must be a real key: provisioning derives a public key before newVM. */
    sshPrivateKey: string;
    /** Defaults to one shared caller; set both to seed a second tenant. */
    ownerUserId?: string;
    userId?: string;
    /** Defaults to sessionless; set to seed one agent session's workstream. */
    session?: string;
    workloadType?: WorkloadTypeValue;
  },
): Promise<{ credentialId: string; ids: string[] }> {
  const credentialId = await upsertCredential(
    getDB(),
    hashCredential(opts.credentials),
    await encryptCredential(opts.credentials),
    opts.cloud,
  );
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `${opts.idPrefix}-${i.toString().padStart(3, '0')}`;
    await createWorkload(getDB(), {
      id,
      userId: opts.userId ?? 'test-user',
      ownerUserId: opts.ownerUserId,
      workloadType: opts.workloadType ?? 'job',
      session: opts.session,
      image: 'alpine:latest',
      requestedComputeProvider: opts.cloud,
      region: opts.region,
      vmType: opts.vmType,
      spot: opts.spot,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: opts.sshPrivateKey,
      credentialId,
    });
    await getDB().query(`UPDATE workloads SET started_at = ? WHERE id = ?`, [
      opts.startedAtBase + i,
      id,
    ]);
    ids.push(id);
  }
  return { credentialId, ids };
}
