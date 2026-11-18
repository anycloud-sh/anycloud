import { beforeEach, describe, it, expect, vi } from 'vitest';
import packageJson from '../../../package.json' with { type: 'json' };
import { callApi } from '../helpers/api-test-helper';
import { createTestWorkload, getTestWorkload } from '../utils';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState, WorkloadType } from '../../../src/shared/workload.js';
import { walkToState, provisionTestVm } from '../../helpers/workload-store.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import config from '../../../src/api/config.js';
import {
  createCheckpointStorageProvider,
  encryptCredential,
} from '../../../src/api/services/cloud-config.js';
import { TEST_AWS_CRED } from '../helpers/fixtures.js';
import { requestWorkloadCleanup } from '../../../src/api/services/monitor.js';
import {
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
} from '../../../src/api/services/persistence.js';
import { upsertCredential } from '../../../src/api/services/repositories/credential-secrets.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';

const { checkpointBucketExists } = vi.hoisted(() => ({
  checkpointBucketExists: vi.fn(),
}));

vi.mock('../../../src/api/services/cloud-config.js', async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import('../../../src/api/services/cloud-config.js')
    >();
  return {
    ...real,
    createCheckpointStorageProvider: vi.fn(() => ({
      hasBucket: checkpointBucketExists,
    })),
  };
});

vi.mock('../../../src/api/services/monitor', async (importActual) => {
  const real =
    await importActual<typeof import('../../../src/api/services/monitor.js')>();
  return {
    ...real,
    requestWorkloadCleanup: vi.fn().mockResolvedValue(true),
  };
});

describe('DELETE /v1/workloads/{id}', () => {
  const testUsername = 'test-user';

  const terminateRequest = (
    id: string,
    query: Record<string, unknown> = {},
    authenticated = true,
  ) => {
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) search.set(name, String(value));
    }
    const suffix = search.size === 0 ? '' : `?${search}`;
    return callApi(
      `https://example.com/v1/workloads/${encodeURIComponent(id)}${suffix}`,
      {
        method: 'DELETE',
        headers: authenticated
          ? { Authorization: 'Bearer mock-github-token' }
          : undefined,
      },
    );
  };

  beforeEach(() => {
    vi.mocked(requestWorkloadCleanup).mockClear();
    checkpointBucketExists.mockReset();
    checkpointBucketExists.mockResolvedValue(true);
    vi.mocked(createCheckpointStorageProvider).mockClear();
  });

  it('durably requests termination before scheduling cleanup', async () => {
    const deployId = `deploy-terminate-with-creds-${Date.now()}`;
    await createTestWorkload(
      deployId,
      testUsername,
      WorkloadState.Provisioning,
    );
    await provisionTestVm(deployId, { ip: '10.0.0.1', cloudId: 'vm-1' });
    await walkToState(deployId, WorkloadState.Running);

    const response = await terminateRequest(deployId);

    expect(response.status).toBe(202);
    const data = await response.json();
    expect(data.message).toBe(
      'Termination scheduled (resource cleanup will complete shortly)',
    );

    const workload = await getTestWorkload(deployId);
    expect(workload?.state).toBe(WorkloadState.Terminated);
    expect(requestWorkloadCleanup).toHaveBeenCalledWith(deployId);
  });

  it('should schedule termination without credentials', async () => {
    const deployId = `deploy-terminate-no-creds-${Date.now()}`;
    await createTestWorkload(
      deployId,
      testUsername,
      WorkloadState.Provisioning,
      true,
    );
    await provisionTestVm(deployId, { ip: '10.0.0.2', cloudId: 'vm-2' });
    await walkToState(deployId, WorkloadState.Running);

    const response = await terminateRequest(deployId);

    expect(response.status).toBe(202);
    const data = await response.json();
    expect(data.message).toBe(
      'Termination scheduled (resource cleanup will complete shortly)',
    );

    // Verify workload state was updated to Terminated.
    const workload = await getTestWorkload(deployId);
    expect(workload).not.toBeNull();
    expect(workload!.state).toBe(WorkloadState.Terminated);
  });

  it('records callerSession in terminate metadata when state changes', async () => {
    const deployId = `deploy-terminate-caller-${Date.now()}`;
    await createTestWorkload(deployId, testUsername, WorkloadState.Running);

    const response = await terminateRequest(deployId, {
      session: 'session-123',
    });

    expect(response.status).toBe(202);
    const events = await eventLog().getWorkloadEvents(deployId);
    const terminalEvent = events.find(
      (e) => e.state === WorkloadState.Terminated && e.metadata,
    );
    expect(terminalEvent).toBeDefined();
    expect(JSON.parse(terminalEvent!.metadata!)).toEqual({
      reason: 'terminated',
      callerSession: 'session-123',
    });
  });

  it('should handle non-existent workload', async () => {
    const response = await terminateRequest('non-existent-workload');

    expect(response.status).toBe(202);
    const data = await response.json();
    expect(data.message).toBe('Workload not found');
  });

  it('rejects a blank workload resource identifier', async () => {
    const response = await terminateRequest(' ');

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'BAD_REQUEST',
      data: {
        issues: [expect.objectContaining({ path: ['params', 'id'] })],
      },
    });
  });

  it('requires bearer authentication', async () => {
    const response = await terminateRequest('test-workload', {}, false);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Missing access token',
    });
  });

  it('rejects the obsolete version request field', async () => {
    const response = await terminateRequest('test-workload', {
      version: 'legacy-body-version',
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Unrecognized key');
  });

  it('rejects the obsolete credentials request field', async () => {
    const response = await terminateRequest('test-workload', {
      credentials: 'legacy-body-value',
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Unrecognized key');
  });

  it('should terminate a queued workload (no VMs yet)', async () => {
    const deployId = `deploy-terminate-queued-${Date.now()}`;
    await createTestWorkload(deployId, testUsername, WorkloadState.Queued);

    const response = await terminateRequest(deployId);

    expect(response.status).toBe(202);
    const data = await response.json();
    expect(data.message).toBe(
      'Termination scheduled (resource cleanup will complete shortly)',
    );
  });

  it('schedules cleanup even when no VM attempt rows exist', async () => {
    const deployId = `deploy-terminate-no-attempts-${Date.now()}`;
    config.cipherKey = 'a'.repeat(64);
    await createTestWorkload(deployId, testUsername, WorkloadState.Running);
    await getDB().query(
      `UPDATE credentials SET encrypted_data = ?, cloud_provider = ? WHERE id = ?`,
      [
        await encryptCredential(TEST_AWS_CRED),
        CloudType.AWS,
        'test-credential-id',
      ],
    );

    const response = await terminateRequest(deployId);

    expect(response.status).toBe(202);
    expect(requestWorkloadCleanup).toHaveBeenCalledWith(deployId);
  });

  it('schedules Service cleanup through bounded reconciliation', async () => {
    const deployId = `serve-terminate-runtime-${Date.now()}`;
    config.cipherKey = 'b'.repeat(64);
    const encryptedCred = await encryptCredential(TEST_AWS_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      `serve-runtime-credential-${Date.now()}`,
      encryptedCred,
      CloudType.AWS,
    );
    await createWorkload(getDB(), {
      id: deployId,
      userId: testUsername,
      workloadType: WorkloadType.Service,
      image: 'nginx:v1',
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run nginx:v1',
      sshPrivateKey: 'test-ssh-private-key',
      credentialId,
    });
    await walkToState(deployId, WorkloadState.Running);

    const response = await terminateRequest(deployId);

    expect(response.status).toBe(202);
    expect(requestWorkloadCleanup).toHaveBeenCalledWith(deployId);
  });

  it('terminates a VM through generic provider cleanup', async () => {
    const deployId = `vm-terminate-runtime-${Date.now()}`;
    await createWorkload(getDB(), {
      id: deployId,
      userId: testUsername,
      workloadType: WorkloadType.Vm,
      image: 'ghcr.io/acme/dev:test',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run vm:test',
      sshPrivateKey: 'test-ssh-private-key',
    });
    await provisionTestVm(deployId, {
      ip: '10.0.0.6',
      cloudId: 'vm-container-runtime',
    });
    await walkToState(deployId, WorkloadState.Running);

    const response = await terminateRequest(deployId);

    expect(response.status).toBe(202);
    expect((await getTestWorkload(deployId))?.state).toBe(
      WorkloadState.Terminated,
    );
    expect(createCheckpointStorageProvider).not.toHaveBeenCalled();
    expect(requestWorkloadCleanup).toHaveBeenCalledWith(deployId);
  });

  it('rejects terminating an ordinary Service before mutation when its checkpoint bucket is missing', async () => {
    checkpointBucketExists.mockResolvedValueOnce(false);
    const deployId = `server-terminate-missing-checkpoint-${Date.now()}`;
    config.cipherKey = 'c'.repeat(64);
    const credentialId = await upsertCredential(
      getDB(),
      `serve-stop-missing-credential-${Date.now()}`,
      await encryptCredential(TEST_AWS_CRED),
      CloudType.AWS,
    );
    await createWorkload(getDB(), {
      id: deployId,
      userId: testUsername,
      workloadType: WorkloadType.Service,
      image: 'nginx:v1',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      checkpointBucket: 'deleted-server-checkpoint',
      dockerCommand: 'docker run nginx:v1',
      sshPrivateKey: 'test-ssh-private-key',
      credentialId,
    });
    await provisionTestVm(deployId, {
      ip: '10.0.0.3',
      cloudId: 'vm-server-checkpoint',
    });
    await walkToState(deployId, WorkloadState.Running);

    const response = await terminateRequest(deployId);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'WORKLOAD_MANAGEMENT_REQUEST_INVALID',
      message: expect.stringContaining(
        'Checkpoint bucket "deleted-server-checkpoint" not found. Recreate it before terminating this Service',
      ),
    });
    expect((await getTestWorkload(deployId))?.state).toBe(
      WorkloadState.Running,
    );
    expect(requestWorkloadCleanup).not.toHaveBeenCalled();
  });

  it('validates retained hosted API state before terminating its VM', async () => {
    const deployId = `hosted-api-terminate-${Date.now()}`;
    const stateBucket = 'hosted-api-state';
    config.cipherKey = 'd'.repeat(64);
    const credentialId = await upsertCredential(
      getDB(),
      `hosted-api-terminate-credential-${Date.now()}`,
      await encryptCredential(TEST_AWS_CRED),
      CloudType.AWS,
    );
    await createWorkload(getDB(), {
      id: deployId,
      userId: testUsername,
      workloadType: WorkloadType.Service,
      image: `${packageJson.apiImage}:${packageJson.version}`,
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      checkpointBucket: stateBucket,
      dockerCommand: `docker run ${packageJson.apiImage}:${packageJson.version}`,
      sshPrivateKey: 'test-ssh-private-key',
      credentialId,
      env: { ANYCLOUD_DIR: '/mnt/checkpoint' },
    });
    await provisionTestVm(deployId, {
      ip: '10.0.0.4',
      cloudId: 'vm-hosted-api',
    });
    await walkToState(deployId, WorkloadState.Running);

    const response = await terminateRequest(deployId);

    expect(response.status).toBe(202);
    expect(checkpointBucketExists).toHaveBeenCalledWith(stateBucket);
    expect((await getTestWorkload(deployId))?.state).toBe(
      WorkloadState.Terminated,
    );
    expect(requestWorkloadCleanup).toHaveBeenCalledWith(deployId);
  });

  it('0036/S10 allows terminating a legacy hosted API without a retained state bucket', async () => {
    const deployId = `legacy-hosted-api-terminate-${Date.now()}`;
    await createWorkload(getDB(), {
      id: deployId,
      userId: testUsername,
      workloadType: WorkloadType.Service,
      image: `${packageJson.apiImage}:0.1.53`,
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: `docker run ${packageJson.apiImage}:0.1.53`,
      sshPrivateKey: 'test-ssh-private-key',
    });
    await provisionTestVm(deployId, {
      ip: '10.0.0.5',
      cloudId: 'vm-legacy-hosted-api',
    });
    await walkToState(deployId, WorkloadState.Running);

    const response = await terminateRequest(deployId);

    expect(response.status).toBe(202);
    expect((await getTestWorkload(deployId))?.state).toBe(
      WorkloadState.Terminated,
    );
    expect(requestWorkloadCleanup).toHaveBeenCalledWith(deployId);
  });

  it('should preserve Completed state when terminating a completed workload', async () => {
    const deployId = `deploy-completed-terminate-${Date.now()}`;
    await createTestWorkload(
      deployId,
      testUsername,
      WorkloadState.Provisioning,
    );
    await provisionTestVm(deployId, {
      ip: '10.0.0.10',
      cloudId: 'vm-completed',
    });
    await walkToState(deployId, WorkloadState.Completed);
    expect((await queries().getWorkload(deployId))?.cleanedAt).toBeNull();
    const beforeEvents = await eventLog().getWorkloadEvents(deployId);

    const response = await terminateRequest(deployId);

    expect(response.status).toBe(202);

    // State stays Completed for already-terminal workloads.
    const workload = await getTestWorkload(deployId);
    expect(workload!.state).toBe(WorkloadState.Completed);
    expect(workload!.cleanedAt).toBeNull();
    const afterEvents = await eventLog().getWorkloadEvents(deployId);
    expect(afterEvents).toHaveLength(beforeEvents.length);
  });

  it('should handle already terminated workload', async () => {
    const deployId = `deploy-already-terminated-${Date.now()}`;
    await createTestWorkload(
      deployId,
      testUsername,
      WorkloadState.Terminated,
      true,
    );

    const response = await terminateRequest(deployId);

    expect(response.status).toBe(202);
    const data = await response.json();
    // Should still succeed (idempotent operation)
    expect(data.message).toBe(
      'Termination scheduled (resource cleanup will complete shortly)',
    );
  });
});
