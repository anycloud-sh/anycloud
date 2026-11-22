import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callApi } from '../helpers/api-test-helper';
import { walkToState, provisionTestVm } from '../../helpers/workload-store.js';
import { getDB } from '../../../src/api/services/repositories/db';
import { CloudType } from '../../../src/shared/cloud.js';
import {
  WorkloadState,
  type WorkloadTypeValue,
} from '../../../src/shared/workload.js';
import { ContainerState } from '../../../src/shared/runtime.js';
import { DockerManager } from '../../../src/api/services/docker';
import { resetTestStore } from '../utils';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';

describe('GET /v1/workloads/{id}/ssh-access', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetTestStore();
  });

  async function seedWorkload(
    id: string,
    {
      vms = [],
      cloudProvider = CloudType.AWS,
      userId = 'test-user',
      workloadType = 'job',
    }: {
      vms?: Parameters<typeof provisionTestVm>[1][];
      cloudProvider?: CloudType;
      userId?: string;
      workloadType?: WorkloadTypeValue;
    } = {},
  ): Promise<void> {
    await getDB().query(
      `UPDATE credentials SET cloud_provider = ? WHERE id = ?`,
      [cloudProvider, 'test-credential-id'],
    );
    await createWorkload(getDB(), {
      id,
      userId,
      workloadType,
      image: 'test-image',
      dockerCommand: 'docker run -d --name test test-image',
      region: 'us-east-1',
      vmType: 't3.medium',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
    });
    for (const vm of vms) await provisionTestVm(id, vm);
    await walkToState(id, WorkloadState.Running);
  }

  async function sshAccessRequest(
    id: string,
    options: { mode?: unknown } = {},
  ) {
    const mode = options.mode ?? 'container';
    return callApi(
      `https://example.com/v1/workloads/${encodeURIComponent(id)}/ssh-access?mode=${encodeURIComponent(String(mode))}`,
      { headers: { Authorization: 'Bearer mock-github-token' } },
    );
  }

  it('returns SSH material to the workload owner', async () => {
    const id = 'ssh-access-ok';
    await seedWorkload(id, {
      vms: [
        {
          ip: '10.0.0.1',
          cloudId: 'vm-1',
          sshHost: 'ssh.example.com',
          sshPort: 2222,
          sshUsername: 'ubuntu',
        },
      ],
    });

    const response = await sshAccessRequest(id, { mode: 'vm' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workloadId: id,
      vmIp: '10.0.0.1',
      sshHost: 'ssh.example.com',
      sshPort: 2222,
      sshUsername: 'ubuntu',
      sshPrivateKey: 'test-ssh-key',
    });
  });

  it('enters a running VM container without falling back to host mode', async () => {
    const id = 'ssh-access-vm-container';
    await seedWorkload(id, {
      vms: [
        {
          ip: '10.0.0.7',
          cloudId: 'vm-7',
          sshHost: 'ssh.example.com',
          sshPort: 2222,
        },
      ],
      workloadType: 'vm',
    });
    const inspect = vi
      .spyOn(DockerManager.prototype, 'getContainerStatus')
      .mockResolvedValue({ state: ContainerState.Running });

    const response = await sshAccessRequest(id, { mode: 'container' });

    expect(response.status).toBe(200);
    expect(inspect).toHaveBeenCalledWith(id);
    expect((await response.json()).workloadId).toBe(id);
  });

  it('returns an actionable error for a missing VM container without host fallback', async () => {
    const id = 'ssh-access-vm-missing';
    await seedWorkload(id, {
      vms: [
        {
          ip: '10.0.0.8',
          cloudId: 'vm-8',
        },
      ],
      workloadType: 'vm',
    });
    vi.spyOn(DockerManager.prototype, 'getContainerStatus').mockResolvedValue({
      state: ContainerState.NotFound,
    });

    const response = await sshAccessRequest(id, { mode: 'container' });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe('WORKLOAD_MANAGEMENT_CONFLICT');
    expect(body.message).toMatch(/VM container/i);
    expect(body.message).toContain(`anycloud ssh ${id} --host`);
    expect(body).not.toHaveProperty('sshPrivateKey');
  });

  it('allows explicit VM host access without container inspection', async () => {
    const id = 'ssh-access-vm-host';
    await seedWorkload(id, {
      vms: [
        {
          ip: '10.0.0.9',
          cloudId: 'vm-9',
        },
      ],
      workloadType: 'vm',
    });
    const inspect = vi.spyOn(DockerManager.prototype, 'getContainerStatus');

    const response = await sshAccessRequest(id, { mode: 'vm' });

    expect(response.status).toBe(200);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('rejects snapshot access for VMs', async () => {
    const id = 'ssh-access-vm-snapshot';
    await seedWorkload(id, {
      vms: [
        {
          ip: '10.0.0.10',
          cloudId: 'vm-10',
        },
      ],
      workloadType: 'vm',
    });

    const response = await sshAccessRequest(id, { mode: 'snapshot' });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'WORKLOAD_MANAGEMENT_REQUEST_INVALID',
      message: 'VMs do not support snapshot SSH; use container or host access.',
    });
  });

  it('returns 400 when there is no live VM', async () => {
    const id = 'ssh-access-no-live-vm';
    await seedWorkload(id);

    const response = await sshAccessRequest(id);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'WORKLOAD_MANAGEMENT_REQUEST_INVALID',
      message: 'No live VMs found for this workload',
    });
  });

  it('returns 400 for multi-VM workloads', async () => {
    const id = 'ssh-access-multi-vm';
    await seedWorkload(id, {
      vms: [
        { ip: '10.0.0.4', cloudId: 'vm-4' },
        { ip: '10.0.0.5', cloudId: 'vm-5' },
      ],
    });

    const response = await sshAccessRequest(id);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'WORKLOAD_MANAGEMENT_REQUEST_INVALID',
      message:
        'Workload has 2 live VMs. ssh only supports single-VM workloads.',
    });
  });

  it('returns Local SSH material after inspecting a running VM container', async () => {
    const id = 'ssh-access-local';
    await seedWorkload(id, {
      vms: [
        {
          ip: 'localhost',
          cloudId: 'ac-local-job-1-0',
          sshPort: 22022,
        },
      ],
      cloudProvider: CloudType.Local,
      workloadType: 'vm',
    });
    const inspect = vi
      .spyOn(DockerManager.prototype, 'getContainerStatus')
      .mockResolvedValue({ state: ContainerState.Running });

    const response = await sshAccessRequest(id);

    expect(response.status).toBe(200);
    expect(inspect).toHaveBeenCalledWith(id);
    await expect(response.json()).resolves.toEqual({
      workloadId: id,
      vmIp: 'localhost',
      sshHost: 'localhost',
      sshPort: 22022,
      sshUsername: 'root',
      sshPrivateKey: 'test-ssh-key',
    });
  });

  it('returns Local host SSH material without container inspection', async () => {
    const id = 'ssh-access-local-host';
    await seedWorkload(id, {
      vms: [
        {
          ip: 'localhost',
          cloudId: 'ac-local-vm-1-0',
          sshPort: 22023,
        },
      ],
      cloudProvider: CloudType.Local,
      workloadType: 'vm',
    });
    const inspect = vi.spyOn(DockerManager.prototype, 'getContainerStatus');

    const response = await sshAccessRequest(id, { mode: 'vm' });

    expect(response.status).toBe(200);
    expect(inspect).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      workloadId: id,
      vmIp: 'localhost',
      sshHost: 'localhost',
      sshPort: 22023,
      sshUsername: 'root',
      sshPrivateKey: 'test-ssh-key',
    });
  });

  it('validates the requested SSH mode', async () => {
    const id = 'ssh-access-bad-mode';
    await seedWorkload(id, { vms: [{ ip: '10.0.0.6', cloudId: 'vm-6' }] });

    const response = await sshAccessRequest(id, { mode: 'bad' });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'BAD_REQUEST',
      data: {
        issues: [
          expect.objectContaining({
            code: 'invalid_value',
            path: ['query', 'mode'],
          }),
        ],
      },
    });
  });
});
