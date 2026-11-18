import { randomUUID } from 'node:crypto';
import {
  getWorkloadQueryStore as queries,
  getDeploymentExecutionStore,
  getWorkloadOutcomes,
} from '../../../src/api/services/persistence.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callApi } from '../helpers/api-test-helper.js';
import { makeContainerSpec } from '../helpers/fixtures.js';
import { seedTestWorkload } from '../../helpers/workload-store.js';
import {
  getDeploymentStore,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import { WorkloadReconciler } from '../../../src/api/services/workload-reconciler.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import {
  TEST_USER_ID,
  TEST_USERNAMES,
} from '../../../src/api/services/test-identity.js';
import { seedReadyNodePool } from '../helpers/node-pool-seed.js';

const deploymentId = 'submission-deployment';

function request(path: string, body: unknown): Promise<Response> {
  return callApi(`http://test/v1/workloads${path}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer mock-github-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('Deployment submission receipts and expiry over HTTP', () => {
  beforeEach(async () => {
    // Replicas claim from this origin; a loopback one refuses targeted Jobs.
    vi.stubEnv('ANYCLOUD_WORKLOAD_API_URL', 'https://api.example.com');
    resetPersistence();
    await seedReadyNodePool({
      nodePoolId: 'submission-pool',
      ownerUserId: TEST_USER_ID,
    });
    await getDeploymentStore().create(
      {
        id: deploymentId,
        name: deploymentId,
        nodePoolId: 'submission-pool',
        ownerUserId: TEST_USER_ID,
        config: makeContainerSpec(),
        gpuCount: 0,
        maxConcurrentJobsPerReplica: 1,
      },
      { kind: 'api' },
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('confirms durable expiry, preserves the public ID, and fences the old observer after resubmission', async () => {
    const admitted = await request('', {
      deployment: deploymentId,
      timeout: 0,
    });
    expect(admitted.status).toBe(202);
    const first = await admitted.json();
    expect(first).toMatchObject({
      submissionRevision: 0,
      claimDeadlineAt: expect.any(Number),
    });
    expect(first.id.length).toBeLessThanOrEqual(28);
    const expired = await request(`/${first.id}/claim-observation`, {
      submissionRevision: 0,
    });
    expect(expired.status).toBe(200);
    expect(await expired.json()).toMatchObject({
      outcome: 'expired',
      claimed: false,
    });

    const resubmitted = await request(`/${first.id}/resubmissions`, {});
    expect(resubmitted.status).toBe(202);
    expect(await resubmitted.json()).toEqual({
      message: `Workload ${first.id} resubmitted`,
      submissionRevision: 1,
      claimDeadlineAt: null,
    });
    const obsolete = await request(`/${first.id}/claim-observation`, {
      submissionRevision: 0,
    });
    expect(await obsolete.json()).toMatchObject({
      outcome: 'changed',
      submissionRevision: 1,
      claimed: false,
    });
    const current = await request(`/${first.id}/claim-observation`, {
      submissionRevision: 1,
    });
    expect(await current.json()).toMatchObject({
      outcome: 'pending',
      claimDeadlineAt: null,
    });
    expect((await queries().getWorkload(first.id))?.state).toBe(
      WorkloadState.Queued,
    );
  });

  it('refuses to resubmit a Job when its API moved to a loopback workload URL, leaving it ended', async () => {
    const admitted = await request('', {
      deployment: deploymentId,
      timeout: 0,
    });
    const { id } = await admitted.json();
    await request(`/${id}/claim-observation`, { submissionRevision: 0 });
    const ended = (await queries().getWorkload(id))?.state;
    vi.stubEnv('ANYCLOUD_WORKLOAD_API_URL', 'http://127.0.0.1:3000');

    const resubmitted = await request(`/${id}/resubmissions`, {});
    expect(resubmitted.status).toBe(400);
    expect(await resubmitted.text()).toContain(
      "Pods can't reach this API to claim Jobs: its workload URL http://127.0.0.1:3000 is loopback.",
    );
    expect(await queries().getWorkload(id)).toMatchObject({
      state: ended,
      submissionRevision: 0,
    });
  });

  it('reports a fast completed claim and distinguishes operator termination before claim', async () => {
    const claimed = await request('', {
      deployment: deploymentId,
      id: 'fast-claimed',
    });
    expect(claimed.status).toBe(202);
    const store = getDeploymentExecutionStore();
    const executionId = randomUUID();
    expect(
      await store.claimTargetedJob({
        deploymentId,
        jobId: 'fast-claimed',
        submissionRevision: 0,
        previousExecutionId: null,
        executionId,
        generation: 1,
        podUid: 'pod',
        containerId: 'container',
      }),
    ).toMatchObject({ kind: 'selected' });
    await store.reportTargetedJobExecution('fast-claimed', executionId, {
      state: WorkloadState.Completed,
    });
    const observation = await request('/fast-claimed/claim-observation', {
      submissionRevision: 0,
    });
    expect(await observation.json()).toMatchObject({
      outcome: 'claimed',
      claimed: true,
    });
    await request('', {
      deployment: deploymentId,
      id: 'operator-stopped',
      timeout: 0,
    });
    await getWorkloadOutcomes().requestTermination('operator-stopped', {
      kind: 'api',
    });
    const stopped = await request('/operator-stopped/claim-observation', {
      submissionRevision: 0,
    });
    expect(await stopped.json()).toMatchObject({
      outcome: 'terminated',
      claimed: false,
    });
  });

  it('observes expiry with all 40 provider reconciliation slots occupied', async () => {
    for (let index = 0; index < 40; index++) {
      await seedTestWorkload({
        id: `held-${index}`,
        userId: TEST_USERNAMES[0],
      });
    }
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reconciler = new WorkloadReconciler({ reconcile: () => held });
    try {
      await reconciler.discoverNow();
      expect(await reconciler.pumpNow()).toBe(40);
      await request('', {
        deployment: deploymentId,
        id: 'expires-under-load',
        timeout: 0,
      });
      const expired = await request('/expires-under-load/claim-observation', {
        submissionRevision: 0,
      });
      expect(expired.status).toBe(200);
      expect(await expired.json()).toMatchObject({
        outcome: 'expired',
        claimed: false,
      });
    } finally {
      release();
      await reconciler.stop();
    }
  });

  it('rediscovers unattended expiry after a fresh reconciler starts', async () => {
    await request('', {
      deployment: deploymentId,
      id: 'disconnected',
      timeout: 0,
    });
    const reconcile = vi.fn();
    const restarted = new WorkloadReconciler({ reconcile });
    await restarted.discoverNow();
    const job = await queries().getWorkload('disconnected');
    expect(job).toMatchObject({
      state: WorkloadState.Terminated,
      firstClaimedAt: null,
    });
    expect(job?.cleanedAt).not.toBeNull();
    expect(reconcile).not.toHaveBeenCalled();
  });
});
