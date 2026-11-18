import { callApi } from '../helpers/api-test-helper';
import {
  getWorkloadQueryStore as queries,
  getDeploymentExecutionStore,
  getWorkloadOutcomes,
} from '../../../src/api/services/persistence.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TEST_ID, TEST_DAEMON_VERSION } from '../config';
import {
  walkToState,
  provisionTestVm,
  releaseTestVms,
} from '../../helpers/workload-store.js';
import { type WorkloadStatusResponse as StatusResponse } from '../../../src/shared/api-contract/workload-management-schemas.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { getDeploymentStore } from '../../../src/api/services/persistence.js';
import { resetTestStore } from '../utils';
import { seedReadyNodePool } from '../helpers/node-pool-seed.js';
import { getWorkloadAdmissionWriter } from '../../../src/api/services/workload-admission-writer.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';

const { fake } = await vi.hoisted(async () => {
  const { createFakeTransport } = await import('../helpers/mock-transport');
  return { fake: createFakeTransport() };
});
vi.mock('../../../src/api/services/gateways/transport', () => ({
  createTransport: vi.fn(() => fake),
}));

function statusRequest(
  id = TEST_ID,
  options: { authenticated?: boolean; verbose?: boolean } = {},
): Promise<Response> {
  const verbose =
    options.verbose === undefined ? '' : `?verbose=${options.verbose}`;
  return callApi(
    `https://example.com/v1/workloads/${encodeURIComponent(id)}${verbose}`,
    {
      headers:
        options.authenticated === false
          ? undefined
          : { Authorization: 'Bearer mock-github-token' },
    },
  );
}

async function createWorkloadWithLiveVm(
  id: string,
  state: WorkloadState,
): Promise<void> {
  await createWorkload(getDB(), {
    id,
    userId: 'test-user',
    workloadType: 'job',
    image: 'test-image',
    dockerCommand: 'docker run -d --name test test-image',
    requestedComputeProvider: CloudType.AWS,
    region: 'us-east-1',
    vmType: 't3.medium',
    sshPrivateKey: 'test-ssh-key',
    credentialId: 'test-credential-id',
  });
  await provisionTestVm(id, {
    ip: '10.0.0.9',
    cloudId: `vm-${id}`,
    privateIp: '192.168.0.9',
  });
  await walkToState(id, state);
}

describe('Status endpoint', () => {
  beforeEach(async () => {
    fake.reset();
    await resetTestStore();
  });

  it('should retrieve workload status with WorkloadEvent structure', async () => {
    // Seed test data (DB is fresh per test)
    await createWorkload(getDB(), {
      id: TEST_ID,
      userId: 'test-user',
      workloadType: 'job',
      image: 'test-image',
      dockerCommand: 'docker run -d --name test test-image',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
      checkpointBucket: 'durable-state',
      env: { API_KEY: 'secret-env-value' },
      githubToken: 'ghp_secret-token',
    });
    await walkToState(TEST_ID, WorkloadState.Running);

    const response = await statusRequest();

    if (response.status !== 200) {
      console.error('Status response error:', await response.text());
    }

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.workload).toBeDefined();
    expect(body.workload.id).toBe(TEST_ID);
    expect(body.workload.checkpointBucket).toBe('durable-state');
    expect(body.workload.env).toBeUndefined();
    expect(body.workload.githubToken).toBeUndefined();
    expect(body.workload.sshPrivateKey).toBeUndefined();
    expect(body.sshPrivateKey).toBeUndefined();
    expect(body.jobsAhead).toBeNull();

    // Events now come from workload_events table
    expect(body.events).toBeDefined();
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBeGreaterThan(0);

    // Verify WorkloadEvent structure
    const runningEvent = body.events.find((e: any) => e.state === 'running');
    expect(runningEvent).toBeDefined();
    expect(runningEvent.workloadId).toBe(TEST_ID);
    expect(typeof runningEvent.id).toBe('number');
    expect(typeof runningEvent.createdAt).toBe('number');
    // metadata should be parsed object or null
    expect(
      runningEvent.metadata === null ||
        typeof runningEvent.metadata === 'object',
    ).toBe(true);
    if (runningEvent.metadata) {
      expect(runningEvent.metadata.message).toBe('Workload complete');
    }
  });

  it('reports the shared Deployment queue until pickup or cancellation', async () => {
    const store = getDeploymentExecutionStore();
    await seedReadyNodePool({
      nodePoolId: 'status-pool',
      ownerUserId: 'test-owner',
    });
    await getDeploymentStore().create(
      {
        id: 'status-deployment',
        ownerUserId: 'test-owner',
        name: 'status-deployment',
        nodePoolId: 'status-pool',
        config: {
          image: 'deployment-image',
          imageDigest: null,
          command: null,
          env: null,
          registryUsername: 'test-owner',
          registryToken: null,
          dockerOptions: null,
        },
        gpuCount: 0,
        maxConcurrentJobsPerReplica: 1,
      },
      { kind: 'api' },
    );
    for (const [index, id] of ['peer-job', TEST_ID].entries()) {
      await getWorkloadAdmissionWriter().createTargetedWorkload({
        id,
        userId: id === TEST_ID ? 'test-user' : 'peer-user',
        deploymentId: 'status-deployment',
      });
      await getDB().query(
        `UPDATE workloads SET submitted_at = ? WHERE id = ?`,
        [index + 1, id],
      );
    }

    const queued = await statusRequest();
    expect(queued.status).toBe(200);
    expect(await queued.json()).toMatchObject({
      workload: { state: 'queued' },
      jobsAhead: 1,
      events: [],
    });

    await getWorkloadOutcomes().requestTermination('peer-job', {
      kind: 'api',
    });
    const firstInQueue = await statusRequest();
    expect(firstInQueue.status).toBe(200);
    expect(await firstInQueue.json()).toMatchObject({
      workload: { state: 'queued' },
      jobsAhead: 0,
      events: [],
    });

    await store.claimTargetedJob({
      deploymentId: 'status-deployment',
      jobId: TEST_ID,
      submissionRevision: 0,
      previousExecutionId: null,
      executionId: '11111111-1111-4111-8111-111111111111',
      generation: 1,
      podUid: 'status-pod',
      containerId: 'status-container',
    });
    const pickedUp = await statusRequest();
    expect(pickedUp.status).toBe(200);
    expect(await pickedUp.json()).toMatchObject({
      workload: { state: 'running' },
      jobsAhead: null,
      events: [
        expect.objectContaining({ state: 'running', workloadId: TEST_ID }),
      ],
    });

    await getWorkloadOutcomes().requestTermination(TEST_ID, { kind: 'api' });
    const cancelled = await statusRequest();
    expect(cancelled.status).toBe(200);
    const body = (await cancelled.json()) as StatusResponse;
    expect(body.workload.state).toBe('terminated');
    expect(body.jobsAhead).toBeNull();
    expect(body.events.at(-1)?.state).toBe('terminated');
  });

  it.each([
    { label: 'before cleanup', settled: false },
    { label: 'after cleanup settled', settled: true },
  ])('maps malformed event metadata to null $label', async ({ settled }) => {
    const id = `status-malformed-metadata-${settled ? 'settled' : 'pending'}`;
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'test-image',
      dockerCommand: 'docker run test-image',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
    });
    await walkToState(id, WorkloadState.Terminated);
    if (settled) {
      expect(await getWorkloadOutcomes().markCleanupComplete(id)).toBeDefined();
    }
    await getDB().query(
      `UPDATE workload_events
         SET metadata = 'not valid json'
         WHERE workload_id = ?`,
      [id],
    );

    const response = await statusRequest(id);

    expect(response.status).toBe(200);
    const body = (await response.json()) as StatusResponse;
    expect(body.events).toHaveLength(1);
    expect(body.events.at(0)?.metadata).toBeNull();
  });

  it('returns VM metadata without exposing its environment or SSH key', async () => {
    const id = `status-vm-${Date.now()}`;
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'vm',
      image: 'ghcr.io/acme/dev:test',
      dockerCommand: 'docker run vm',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      sshPrivateKey: 'vm-private-key',
      credentialId: 'test-credential-id',
      env: { PORT: '3000', SECRET: 'hidden' },
    });

    const response = await statusRequest(id);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.workload.workloadType).toBe('vm');
    expect(body.workload.env).toBeUndefined();
    expect(body.workload.sshPrivateKey).toBeUndefined();
    expect(body.jobsAhead).toBeNull();
  });

  it("returns the VM's actual zone instead of the workload's requested zone", async () => {
    const id = 'status-vm-actual-zone';
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'vm',
      image: 'ghcr.io/acme/dev:test',
      dockerCommand: 'docker run vm',
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      availabilityZone: 'a',
      vmType: 'e2-standard-2',
      sshPrivateKey: 'vm-private-key',
      credentialId: 'test-credential-id',
    });
    await provisionTestVm(
      id,
      {
        ip: '10.0.0.10',
        cloudId: 'vm-fallback-zone',
        availabilityZone: 'b',
      },
      { region: 'us-central1', availabilityZone: 'a' },
    );
    await walkToState(id, WorkloadState.Initializing);

    const response = await statusRequest(id);

    expect(response.status).toBe(200);
    const body = (await response.json()) as StatusResponse;
    expect(body.workload.availabilityZone).toBe('a');
    expect(body.vms?.[0]?.availabilityZone).toBe('b');
  });

  it('exposes outcome and cleanup timestamps as separate lifecycle facts', async () => {
    await createWorkload(getDB(), {
      id: TEST_ID,
      userId: 'test-user',
      workloadType: 'job',
      image: 'test-image',
      dockerCommand: 'docker run test-image',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
    });
    await walkToState(TEST_ID, WorkloadState.Completed);
    const completedAt = (await queries().getWorkload(TEST_ID))!.completedAt;
    await expect(
      getWorkloadOutcomes().markCleanupComplete(TEST_ID),
    ).resolves.toBe(true);

    const response = await statusRequest();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.workload.completedAt).toBe(completedAt);
    expect(body.workload.cleanedAt).toEqual(expect.any(Number));
    expect(body.workload.cleanedAt).toBeGreaterThanOrEqual(
      body.workload.completedAt,
    );
  });

  it('returns VM aggregates (vmDurationMs, totalCost, costSource) on the workload', async () => {
    await createWorkload(getDB(), {
      id: TEST_ID,
      userId: 'test-user',
      workloadType: 'job',
      image: 'test-image',
      dockerCommand: 'docker run -d --name test test-image',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
    });
    await provisionTestVm(
      TEST_ID,
      { ip: '1.2.3.4', cloudId: 'vm-1' },
      { region: 'us-east-1', pricePerHour: 2.0 },
    );
    await new Promise((r) => setTimeout(r, 25));
    await releaseTestVms(TEST_ID, 'vm-1');

    const response = await statusRequest();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.workload.vmDurationMs).toBeGreaterThan(0);
    expect(body.workload.totalCost).toBeGreaterThan(0);
    expect(body.workload.costSource).toBe('estimated');
  });

  it('exposes effective Local SSH routing facts but never the private key', async () => {
    const localId = 'local-status-test-' + Date.now();
    await createWorkload(getDB(), {
      id: localId,
      userId: 'test-user',
      workloadType: 'job',
      image: 'test-image',
      dockerCommand: 'docker run -d --name test test-image',
      requestedComputeProvider: CloudType.Local,
      region: 'local',
      vmType: 'local',
      sshPrivateKey: 'local-harness-key',
      credentialId: null,
    });
    await provisionTestVm(
      localId,
      {
        ip: 'localhost',
        cloudId: 'ac-local-local-status-test-0',
        sshPort: 22022,
      },
      { region: 'local' },
    );
    await walkToState(localId, WorkloadState.Running);
    await walkToState(localId, WorkloadState.Completed);

    const response = await statusRequest(localId);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.workload.cloudProvider).toBe(CloudType.Local);
    expect(body.sshPrivateKey).toBeUndefined();
    expect(body.vms[0].ip).toBe('localhost');
    expect(body.vms[0].sshHost).toBe('localhost');
    expect(body.vms[0].sshPort).toBe(22022);
    expect(body.vms[0].sshUsername).toBe('root');
  });

  it('preserves a non-root SSH username through hydration and the status contract', async () => {
    const id = 'status-non-root-ssh';
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'vm',
      image: 'ghcr.io/acme/dev:test',
      dockerCommand: 'docker run vm',
      requestedComputeProvider: CloudType.Azure,
      region: 'eastus',
      vmType: 'Standard_D2s_v5',
      sshPrivateKey: 'vm-private-key',
      credentialId: 'test-credential-id',
    });
    await provisionTestVm(
      id,
      {
        ip: '203.0.113.10',
        cloudId: 'azure-vm-non-root',
        sshUsername: 'azureuser',
      },
      { region: 'eastus' },
    );
    await walkToState(id, WorkloadState.Initializing);

    const response = await statusRequest(id);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.vms[0]).toMatchObject({
      ip: '203.0.113.10',
      sshHost: '203.0.113.10',
      sshPort: 22,
      sshUsername: 'azureuser',
    });
  });

  it('should return 404 for non-existent workload', async () => {
    const response = await statusRequest('non-existent');

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toMatchObject({
      code: 'WORKLOAD_MANAGEMENT_NOT_FOUND',
      message: 'Workload not found',
    });
  });

  it('rejects a blank workload resource identifier', async () => {
    const response = await statusRequest(' ');

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'BAD_REQUEST',
      data: {
        issues: [expect.objectContaining({ path: ['params', 'id'] })],
      },
    });
  });

  // Provisioning timeout is now handled by deployInBackground retry logic (30min timeout with retry),
  // not by the status endpoint. The status endpoint returns '-' for provisioning workloads.

  it('skips live VM health checks before the workload can be running', async () => {
    const initializingId = 'status-initializing-db-only';
    await createWorkloadWithLiveVm(initializingId, WorkloadState.Initializing);
    fake.default(new Error('status should not SSH before running'));

    const response = await statusRequest(initializingId);

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.status).toBe('-');
    expect(body.workload.state).toBe(WorkloadState.Initializing);
    expect(body.vms).toHaveLength(1);
    expect(body.vms[0].ip).toBe('10.0.0.9');
    expect(body.vms[0].container).toBeUndefined();
    expect(fake.exec).not.toHaveBeenCalled();
  });

  it('does not let verbose status bypass the pre-running health-check guard', async () => {
    const initializingId = 'status-initializing-verbose-db-only';
    await createWorkloadWithLiveVm(initializingId, WorkloadState.Initializing);
    fake.default(new Error('verbose status should not SSH before running'));

    const response = await statusRequest(initializingId, { verbose: true });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.status).toBe('-');
    expect(body.workload.state).toBe(WorkloadState.Initializing);
    expect(fake.exec).not.toHaveBeenCalled();
  });

  it('still runs live VM health checks once a workload is running', async () => {
    const runningId = 'status-running-health-checks';
    await createWorkloadWithLiveVm(runningId, WorkloadState.Running);
    fake.default(new Error('fast health-check failure'));

    const response = await statusRequest(runningId);

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.status).toBe('-');
    expect(fake.exec).toHaveBeenCalled();
    expect(fake.commands.some((cmd) => cmd.includes('docker inspect'))).toBe(
      true,
    );
  });

  it('skips live VM health checks when a workload is not running', async () => {
    const terminatingId = 'terminated-test-' + Date.now();

    // Create workload in Terminated state (with cloud config to avoid error in resume logic)
    await createWorkload(getDB(), {
      id: terminatingId,
      userId: 'test-user',
      workloadType: 'job',
      image: 'test-image',
      dockerCommand: 'docker run -d --name test test-image',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
    });
    // Add a VM IP
    await provisionTestVm(terminatingId, {
      ip: '10.0.0.3',
      cloudId: 'vm-terminatingId',
      privateIp: '192.168.0.3',
    });
    await walkToState(terminatingId, WorkloadState.Running);
    await walkToState(terminatingId, WorkloadState.Terminated);

    fake.default(new Error('fast health-check failure'));

    // Call status endpoint
    const response = await statusRequest(terminatingId);

    expect(response.status).toBe(200);
    const body = await response.json();

    // Health checks are only meaningful for running workloads.
    expect(body.status).toBe('-');
    expect(body.vms).toBeDefined();
    expect(body.vms.length).toBe(1);
    expect(body.vms[0].ip).toBe('10.0.0.3');
    expect(fake.exec).not.toHaveBeenCalled();
  });

  it('should skip health checks for persisted workload in terminal state', async () => {
    const persistedId = 'persisted-completed-test-' + Date.now();

    // Create persisted workload in Completed state
    await createWorkload(getDB(), {
      id: persistedId,
      userId: 'test-user',
      workloadType: 'job',
      image: 'test-image',
      dockerCommand: 'docker run -d --name test test-image',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
    });
    // Add a VM IP
    await provisionTestVm(persistedId, {
      ip: '10.0.0.2',
      cloudId: 'vm-persistedId',
      privateIp: '192.168.0.2',
    });
    await walkToState(persistedId, WorkloadState.Running);
    await walkToState(persistedId, WorkloadState.Completed);

    // Call status endpoint
    const response = await statusRequest(persistedId);

    expect(response.status).toBe(200);
    const body = await response.json();

    // Should return status '-' (not 'up' or 'down') since health checks are skipped
    expect(body.status).toBe('-');
    // Should still have VM IPs available
    expect(body.vms).toBeDefined();
    expect(body.vms.length).toBe(1);
    expect(body.vms[0].ip).toBe('10.0.0.2');
  });

  // Starting timeout is now handled by the step system (runStep with timeout),
  // not by the status endpoint. The status endpoint is read-only.
});
