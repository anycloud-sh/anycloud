import { randomUUID } from 'node:crypto';
import { getWorkloadOutcomes } from '../../../../src/api/services/persistence.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClusterInstallerStore } from '../../../../src/api/services/cluster-installer-store.js';
import { NodePoolStore } from '../../../../src/api/services/cluster-store.js';
import { DeploymentExecutionStore } from '../../../../src/api/services/repositories/deployment-executions.js';
import { createTargetedWorkload } from '../../../../src/api/services/repositories/targeted-job-creation.js';
import { WorkloadQueryStore } from '../../../../src/api/services/repositories/workload-queries.js';
import {
  createDatabase,
  type CloseableDB,
} from '../../../../src/api/services/repositories/db.js';
import { DeploymentStore } from '../../../../src/api/services/deployment-store.js';
import { CloudType } from '../../../../src/shared/cloud.js';
import { WorkloadState } from '../../../../src/shared/workload.js';
import { makeContainerSpec } from '../../helpers/fixtures.js';
import { WorkloadLifecycleStore } from '../../../../src/api/services/repositories/workload-lifecycle.js';
import { createJobChanges } from '../../../../src/api/services/job-changes.js';

let database: CloseableDB | undefined;
let directory: string | undefined;

afterEach(() => {
  database?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function reopen(): DeploymentExecutionStore {
  database?.close();
  database = createDatabase();
  return new DeploymentExecutionStore(database);
}

describe('Deployment submission recovery from SQLite', () => {
  it('retains revised claims and replays while discovering unattended expiry after reopen', async () => {
    directory = mkdtempSync(join(tmpdir(), 'anycloud-deployment-recovery-'));
    vi.stubEnv('SQLITE_PATH', join(directory, 'state.sqlite'));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    let store = reopen();
    await database!.query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider) VALUES ('cred', 'x', ?)`,
      [CloudType.AWS],
    );
    await new ClusterInstallerStore(database!).recordSelf({
      id: 'cluster',
      ownerUserId: 'owner',
      name: 'cluster',
      kubernetesIdentity: 'uid-cluster',
      connection: '{"stored":true}',
    });
    const nodePools = new NodePoolStore(database!);
    await nodePools.create({
      id: 'pool',
      clusterId: 'cluster',
      ownerUserId: 'owner',
      name: 'pool',
      computeCredentialId: 'cred',
      region: 'us-east-1',
      zone: null,
      vmTypes: ['t3.small'],
      minVmCount: 1,
      maxVmCount: 1,
    });
    await nodePools.markReady('pool');
    await new DeploymentStore(database!).create(
      {
        id: 'deployment',
        name: 'deployment',
        ownerUserId: 'owner',
        nodePoolId: 'pool',
        config: makeContainerSpec(),
        gpuCount: 0,
        maxConcurrentJobsPerReplica: 2,
      },
      { kind: 'api' },
    );
    const runtime = {
      deploymentId: 'deployment',
      generation: 1,
      podUid: 'pod',
      containerId: 'container',
    };
    const owner = { kind: 'api' } as const;
    for (const id of ['claimed', 'unattended']) {
      expect(
        await createTargetedWorkload(database!, createJobChanges(), {
          id,
          deploymentId: runtime.deploymentId,
          userId: 'owner',
          ownerUserId: 'owner',
          claimDeadlineAt: id === 'claimed' ? 100_000 : 120_000,
        }),
      ).toBe(true);
    }
    expect(await store.expireDueTargetedJobSubmissions()).toBe(1);
    expect(
      await getWorkloadOutcomes().resubmitWorkloadForScope(
        'claimed',
        owner,
        undefined,
        {
          claimDeadlineAt: 120_000,
        },
      ),
    ).toEqual({ submissionRevision: 1, claimDeadlineAt: 120_000 });
    const claim = {
      ...runtime,
      jobId: 'claimed',
      submissionRevision: 1,
      previousExecutionId: null,
      executionId: randomUUID(),
    };
    const selected = await store.claimTargetedJob(claim);
    expect(selected).toMatchObject({ kind: 'selected' });

    store = reopen();
    clock.mockReturnValue(130_000);
    await expect(
      new WorkloadQueryStore(database!).getWorkload('claimed'),
    ).resolves.toMatchObject({
      state: WorkloadState.Running,
      submissionRevision: 1,
      claimDeadlineAt: 120_000,
      firstClaimedAt: 100_000,
      currentExecutionId: claim.executionId,
    });
    await expect(
      store.claimTargetedJob({ ...claim, ready: false }),
    ).resolves.toEqual(selected);
    await expect(
      store.observeTargetedJobSubmission('claimed', 0),
    ).resolves.toMatchObject({
      outcome: 'changed',
      submissionRevision: 1,
    });
    await expect(
      new WorkloadQueryStore(database!).getWorkload('unattended'),
    ).resolves.toMatchObject({
      state: WorkloadState.Queued,
      claimDeadlineAt: 120_000,
      firstClaimedAt: null,
    });
    // Due work stays undiscoverable before any observer or background expiry.
    await expect(store.discoverTargetedJob(runtime)).resolves.toEqual({
      kind: 'empty',
    });
    expect(await store.expireDueTargetedJobSubmissions()).toBe(1);

    expect(
      await store.reportTargetedJobExecution('claimed', claim.executionId, {
        state: WorkloadState.Retrying,
        reason: 'retry after restart',
      }),
    ).toBe(true);
    const retry = await new WorkloadQueryStore(
      database!,
    ).getWorkloadReconcileCandidate('claimed');
    expect(
      await new WorkloadLifecycleStore(
        database!,
        createJobChanges(),
      ).queueRetryCandidate('claimed', retry!.revision),
    ).toBe('queued');
    const nextClaim = {
      ...claim,
      previousExecutionId: claim.executionId,
      executionId: randomUUID(),
    };
    await expect(store.claimTargetedJob(nextClaim)).resolves.toMatchObject({
      kind: 'selected',
    });

    store = reopen();
    // The retry waited its own 20 s `--timeout` window from 130 s.
    await expect(
      new WorkloadQueryStore(database!).getWorkload('claimed'),
    ).resolves.toMatchObject({
      submissionRevision: 1,
      claimDeadlineAt: 150_000,
      firstClaimedAt: 130_000,
      currentExecutionId: nextClaim.executionId,
    });
    await expect(store.claimTargetedJob(nextClaim)).resolves.toMatchObject({
      kind: 'selected',
      executionId: nextClaim.executionId,
    });
    await expect(
      store.observeTargetedJobSubmission('unattended', 0),
    ).resolves.toMatchObject({
      outcome: 'expired',
      claimed: false,
    });
    await expect(
      store.claimTargetedJob({
        ...claim,
        jobId: 'unattended',
        submissionRevision: 0,
        executionId: randomUUID(),
      }),
    ).resolves.toEqual({ kind: 'stale' });
    expect(await store.expireDueTargetedJobSubmissions()).toBe(0);
  });
});
