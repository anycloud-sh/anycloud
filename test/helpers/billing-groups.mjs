import {
  encryptCredential,
  hashCredential,
} from '../../src/api/services/cloud-config.js';
import { getDB } from '../../src/api/services/repositories/db.js';
import { getWorkloadQueryStore as queries } from '../../src/api/services/persistence.js';
import { CloudType } from '../../src/shared/cloud.js';
import { WorkloadState } from '../../src/shared/workload.js';
import { walkToState, provisionTestVm } from './workload-store.js';
import { upsertCredential } from '../../src/api/services/repositories/credential-secrets.js';
import { createWorkload } from '../../src/api/services/repositories/workload-creation.js';

export async function seedBillingCredential(account) {
  const value = {
    cloudProvider: CloudType.AWS,
    accessKeyId: account,
    secretAccessKey: 'synthetic-no-authority',
  };
  return upsertCredential(
    getDB(),
    hashCredential(value),
    await encryptCredential(value),
    CloudType.AWS,
  );
}

/**
 * Complete unequal-runtime groups, using the repository's normal fixtures.
 * Attempts register while the workload is Provisioning, so a later call on
 * the same workload needs the earlier one to pass `state: Provisioning`.
 */
export async function seedBillingGroup({
  id,
  credentialId,
  vmCredentialId = credentialId,
  weights = [1, 2, 4],
  endedAt = Date.now() - 3 * 24 * 3600_000,
  suffix = '',
  workloadType = 'job',
  state = WorkloadState.Completed,
}) {
  if (!(await queries().getWorkload(id))) {
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType,
      image: 'fixture:synthetic',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      spot: false,
      dockerCommand: 'never-executed',
      sshPrivateKey: 'synthetic-test-key',
      credentialId,
    });
  }
  const cloudIds = weights.map((_, index) => id + suffix + '-vm-' + index);
  for (const cloudId of cloudIds) {
    await provisionTestVm(id, { cloudId, ip: '192.0.2.1' }, { credentialId });
  }
  if ((await queries().getWorkload(id)).state !== state) {
    await walkToState(id, state);
  }
  for (const [index, weight] of weights.entries()) {
    await getDB().query(
      'UPDATE vms SET credential_id=?,created_at=?,ended_at=? WHERE cloud_id=?',
      [vmCredentialId, endedAt - weight * 600_000, endedAt, cloudIds[index]],
    );
  }
}
