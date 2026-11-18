import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getDeploymentExecutionStore,
  getDeploymentStore,
  getWorkloadOutcomes,
  getWorkloadQueryStore,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { getWorkloadAdmissionWriter } from '../../../src/api/services/workload-admission-writer.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import { encryptCredential } from '../../../src/api/services/cloud-config.js';
import { NodePoolState } from '../../../src/shared/node-pools.js';
import {
  makeContainerSpec,
  TEST_AWS_CRED,
  TEST_AZURE_CRED,
  TEST_GCP_CRED,
} from '../helpers/fixtures.js';
import { seedReadyNodePool } from '../helpers/node-pool-seed.js';

const { cleanupManagedWorkloadStorage } = vi.hoisted(() => ({
  cleanupManagedWorkloadStorage: vi.fn(),
}));
vi.mock('../../../src/api/services/deployment-controller.js', () => ({
  getDefaultDeploymentControl: () => ({ schedule: () => {} }),
}));
vi.mock(
  '../../../src/api/services/workload-storage',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    cleanupManagedWorkloadStorage,
  }),
);

import { runWorkloadReconcileOnce } from '../../../src/api/services/monitor.js';

/**
 * D-managed and RFC 0043 S13 and S16: every way a pool Job ends leaves a
 * managed checkpoint bucket for cleanup to delete, with the credential its
 * row persists, before the Job counts as cleaned.
 */
const store = () => getDeploymentExecutionStore();
const runtime = {
  deploymentId: 'deployment',
  generation: 1,
  podUid: 'pod',
  containerId: 'container',
};

async function claim(jobId: string): Promise<string> {
  const executionId = randomUUID();
  await store().claimTargetedJob({
    ...runtime,
    jobId,
    submissionRevision: 0,
    previousExecutionId: null,
    executionId,
  });
  return executionId;
}

/** Each way a pool Job ends without a VM host's teardown. */
const endings: Record<string, (jobId: string) => Promise<void>> = {
  'the runner reports completed': async (jobId) => {
    await store().reportTargetedJobExecution(jobId, await claim(jobId), {
      state: WorkloadState.Completed,
    });
  },
  'it is terminated while Retrying': async (jobId) => {
    await store().reportTargetedJobExecution(jobId, await claim(jobId), {
      state: WorkloadState.Retrying,
      reason: 'evicted',
    });
    await getWorkloadOutcomes().requestTermination(jobId, { kind: 'api' });
  },
  'its runner cleans up after a terminate': async (jobId) => {
    const executionId = await claim(jobId);
    await getWorkloadOutcomes().requestTermination(jobId, { kind: 'api' });
    await store().completeTargetedJobCleanup(jobId, executionId);
  },
  'its Deployment ends it while Queued': async () => {
    await store().terminateUnassignedTargetedJobs(runtime.deploymentId);
  },
};

describe('pool Job managed checkpoint cleanup', () => {
  beforeEach(async () => {
    resetPersistence();
    cleanupManagedWorkloadStorage.mockReset();
    await seedReadyNodePool({
      nodePoolId: 'pool',
      ownerUserId: 'owner',
      cloudProvider: CloudType.Azure,
    });
    await getDeploymentStore().create(
      {
        id: runtime.deploymentId,
        ownerUserId: 'owner',
        name: 'deployment',
        nodePoolId: 'pool',
        config: makeContainerSpec(),
        gpuCount: 0,
        maxConcurrentJobsPerReplica: 1,
      },
      { kind: 'api' },
    );
    await getWorkloadAdmissionWriter().createTargetedWorkload({
      id: 'job',
      deploymentId: runtime.deploymentId,
      userId: 'owner',
      ownerUserId: 'owner',
    });
    await getDB().query(
      "UPDATE credentials SET encrypted_data = ? WHERE id = 'cred-a'",
      [await encryptCredential(TEST_AZURE_CRED)],
    );
  });

  /** As admission persists a spot pool's bucketless Job (D-managed). */
  const managed = (credentialId = 'cred-a') =>
    getDB().query(
      `UPDATE workloads SET checkpoint_storage_credential_id = ?, checkpoint_storage_region = 'westus'
       WHERE id = 'job'`,
      [credentialId],
    );
  const signedBy = (credentials: object) =>
    expect.objectContaining({
      spot: true,
      checkpointStorageCredentials: credentials,
      checkpointStorageRegion: 'westus',
    });

  const cleanedAt = async () =>
    (await getWorkloadQueryStore().getWorkload('job'))?.cleanedAt ?? null;

  it.each(Object.keys(endings))(
    'leaves a spot pool Job for cleanup to delete its bucket when %s',
    async (ending) => {
      await managed();
      await endings[ending]!('job');

      const job = await getWorkloadQueryStore().getWorkload('job');
      expect(job?.completedAt).toEqual(expect.any(Number));
      expect(job?.cleanedAt).toBeNull();

      await runWorkloadReconcileOnce();
      expect(cleanupManagedWorkloadStorage).toHaveBeenCalledWith(
        signedBy(TEST_AZURE_CRED),
        'job',
      );
      expect(await cleanedAt()).toEqual(expect.any(Number));
    },
  );

  it('defers the cleanup while the bucket delete fails', async () => {
    await managed();
    await endings['the runner reports completed']!('job');
    cleanupManagedWorkloadStorage.mockRejectedValueOnce(new Error('locked'));

    await runWorkloadReconcileOnce();
    const job = await getWorkloadQueryStore().getWorkload('job');
    expect(job?.cleanedAt).toBeNull();
    expect(job?.cleanupError).toContain('locked');
  });

  it("keeps the bucket while a terminated Job's replica still runs", async () => {
    await managed();
    await claim('job');
    await getWorkloadOutcomes().requestTermination('job', { kind: 'api' });

    await runWorkloadReconcileOnce();
    expect(cleanupManagedWorkloadStorage).not.toHaveBeenCalled();
    expect(await cleanedAt()).toBeNull();
  });

  it.each(Object.keys(endings))(
    'settles any other pool Job at once when %s',
    async (ending) => {
      await endings[ending]!('job');
      expect(await cleanedAt()).toEqual(expect.any(Number));
    },
  );

  it('0043/S16 deletes the managed bucket of a Job on an AWS spot pool with its persisted Azure credential, after the pool is deleted', async () => {
    await getDB().query(
      "UPDATE credentials SET cloud_provider = 'AWS', encrypted_data = ? WHERE id = 'cred-a'",
      [await encryptCredential(TEST_AWS_CRED)],
    );
    await getDB().query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider) VALUES ('cred-s', ?, ?)`,
      [await encryptCredential(TEST_AZURE_CRED), CloudType.Azure],
    );
    await getDB().query("UPDATE node_pools SET spot = 1 WHERE id = 'pool'");
    await managed('cred-s');
    await endings['the runner reports completed']!('job');
    await getDB().query("UPDATE node_pools SET state = ? WHERE id = 'pool'", [
      NodePoolState.Deleted,
    ]);
    expect(await cleanedAt()).toBeNull();

    await runWorkloadReconcileOnce();
    expect(cleanupManagedWorkloadStorage).toHaveBeenCalledWith(
      signedBy(TEST_AZURE_CRED),
      'job',
    );
    expect(await cleanedAt()).toEqual(expect.any(Number));
  });

  it.each([
    ['AWS', TEST_AWS_CRED],
    ['GCP', TEST_GCP_CRED],
  ] as const)(
    '0043/S21 deletes the managed bucket of a Job on a %s spot pool with the compute credential and region its row persists, after the pool is deleted',
    async (cloud, compute) => {
      await getDB().query(
        "UPDATE credentials SET cloud_provider = ?, encrypted_data = ? WHERE id = 'cred-a'",
        [cloud, await encryptCredential(compute)],
      );
      await getDB().query("UPDATE node_pools SET spot = 1 WHERE id = 'pool'");
      await managed();
      await endings['the runner reports completed']!('job');
      await getDB().query("UPDATE node_pools SET state = ? WHERE id = 'pool'", [
        NodePoolState.Deleted,
      ]);

      await runWorkloadReconcileOnce();
      expect(cleanupManagedWorkloadStorage).toHaveBeenCalledWith(
        signedBy(compute),
        'job',
      );
      expect(await cleanedAt()).toEqual(expect.any(Number));
    },
  );

  it('keeps settling a spot pool Job that names its own checkpoint bucket', async () => {
    await managed();
    await getDB().query(
      "UPDATE workloads SET checkpoint_bucket = 'state' WHERE id = 'job'",
    );
    await endings['the runner reports completed']!('job');
    expect(await cleanedAt()).toEqual(expect.any(Number));
  });
});
