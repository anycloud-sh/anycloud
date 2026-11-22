import { LOGS_CONTAINER_NOT_READY } from '../../../src/shared/api-contract/native-schemas.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callApi } from '../helpers/api-test-helper';
import {
  walkToState,
  provisionTestVm,
  releaseTestVms,
} from '../../helpers/workload-store.js';
import { getDB } from '../../../src/api/services/repositories/db';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState, WorkloadType } from '../../../src/shared/workload.js';
import { resetTestStore } from '../utils';
import { STATUS_INSPECT_TIMEOUT_MS } from '../../../src/api/services/docker.js';

const MISSING_CONTAINER_SENTINEL = '__anycloud_missing_container__';

const { execMock, execStreamMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  execStreamMock: vi.fn(),
}));

vi.mock('../../../src/api/services/gateways/transport', () => ({
  createTransport: vi.fn((host: string) => ({
    exec: (...args: unknown[]) => execMock(host, ...args),
    execStream: execStreamMock,
    ping: vi.fn(async () => true),
  })),
  createUserTransport: vi.fn(() => ({
    exec: vi.fn(),
    execStream: execStreamMock,
    ping: vi.fn(async () => true),
  })),
}));

import {
  createTransport,
  createUserTransport,
} from '../../../src/api/services/gateways/transport';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';

describe('GET /v1/workloads/{id}/logs', () => {
  beforeEach(async () => {
    execMock.mockReset();
    execMock.mockResolvedValue({
      stdout: 'running\n',
      stderr: '',
      code: 0,
    });
    execStreamMock.mockReset();
    execStreamMock.mockImplementation(
      async (
        _command: string,
        options: {
          onStdout?: (chunk: Buffer) => void | Promise<void>;
        } = {},
      ) => {
        await options.onStdout?.(Buffer.from('log line\n'));
        return 0;
      },
    );
    vi.mocked(createTransport).mockClear();
    vi.mocked(createUserTransport).mockClear();
    await resetTestStore();
  });

  async function seedWorkload(
    id: string,
    {
      vms = [],
      cloudProvider = CloudType.Local,
      workloadType = WorkloadType.Job,
    }: {
      vms?: Parameters<typeof provisionTestVm>[1][];
      cloudProvider?: CloudType;
      workloadType?: WorkloadType;
    } = {},
  ): Promise<void> {
    const isLocal = cloudProvider === CloudType.Local;
    await getDB().query(
      `UPDATE credentials SET cloud_provider = ? WHERE id = ?`,
      [cloudProvider, 'test-credential-id'],
    );
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType,
      image: 'test-image',
      dockerCommand: 'docker run -d --name test test-image',
      region: isLocal ? 'local' : 'us-east-1',
      vmType: isLocal ? 'local' : 't3.medium',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
    });
    for (const vm of vms) await provisionTestVm(id, vm);
    await walkToState(id, WorkloadState.Running);
  }

  async function logsRequest(id: string, query: { follow?: boolean } = {}) {
    const url = new URL(`https://example.com/v1/workloads/${id}/logs`);
    if (query.follow !== undefined) {
      url.searchParams.set('follow', query.follow ? 'true' : 'false');
    }
    return callApi(url.toString(), {
      method: 'GET',
      headers: { Authorization: 'Bearer mock-github-token' },
    });
  }

  async function readEvents(response: Response) {
    const text = await response.text();
    return text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .map((event) => {
        if (event.type !== 'stdout' && event.type !== 'stderr') return event;
        return { ...event, data: Buffer.from(event.data, 'base64').toString() };
      });
  }

  it('streams host-level `docker logs <id>` over the API SSH for a vm-host workload', async () => {
    const id = 'logs-local';
    await seedWorkload(id, {
      vms: [
        {
          ip: 'ac-control-logs-local-0',
          cloudId: 'ac-control-logs-local-0',
          sshHost: 'ac-control-logs-local-0',
        },
      ],
    });

    const response = await logsRequest(id);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(
      'application/x-ndjson',
    );
    await expect(readEvents(response)).resolves.toEqual([
      { type: 'stdout', data: 'log line\n' },
      { type: 'exit', code: 0 },
    ]);
    expect(createTransport).toHaveBeenCalledWith(
      'ac-control-logs-local-0',
      'test-ssh-key',
      22,
      'root',
    );
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createUserTransport).toHaveBeenCalledWith(
      'ac-control-logs-local-0',
      'test-ssh-key',
      22,
      'root',
    );
    expect(execMock).toHaveBeenCalledWith(
      'ac-control-logs-local-0',
      expect.stringContaining('docker inspect --type container'),
      1,
      false,
      STATUS_INSPECT_TIMEOUT_MS,
    );
    const remoteCommand = execStreamMock.mock.calls[0][0] as string;
    expect(remoteCommand).toContain('exec docker logs');
    expect(remoteCommand).toContain(id);
    // Host-level, NOT exec-ed into the workload, and not following by default.
    expect(remoteCommand).not.toContain('docker exec');
    expect(remoteCommand).not.toContain('docker logs -f');
  });

  it('passes -f for follow mode', async () => {
    const id = 'logs-follow';
    await seedWorkload(id, {
      vms: [
        {
          ip: 'ac-control-logs-follow-0',
          cloudId: 'ac-control-logs-follow-0',
          sshHost: 'ac-control-logs-follow-0',
        },
      ],
    });

    await logsRequest(id, { follow: true });

    const remoteCommand = execStreamMock.mock.calls[0][0] as string;
    expect(remoteCommand).toContain('exec docker logs -f');
    // The follow has to be channel-bound. Without the stdin guard, cancelling
    // it leaves `docker logs -f` running on the VM: OpenSSH ignores the SIGINT
    // request, and a silent container gives the command no SIGPIPE either.
    expect(remoteCommand).toContain('exec 3<&0');
  });

  it('aborts the remote follow command when the client disconnects', async () => {
    const id = 'logs-follow-disconnect';
    let remoteSignal: AbortSignal | undefined;
    let resolveRemoteAbort: (() => void) | undefined;
    const remoteAborted = new Promise<void>((resolve) => {
      resolveRemoteAbort = resolve;
    });
    execStreamMock.mockImplementationOnce(
      async (_command: string, options: { signal?: AbortSignal } = {}) => {
        remoteSignal = options.signal;
        return await new Promise<number>((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => {
              resolveRemoteAbort?.();
              reject(options.signal?.reason);
            },
            { once: true },
          );
        });
      },
    );

    await seedWorkload(id, {
      vms: [
        {
          ip: 'ac-control-logs-disconnect-0',
          cloudId: 'ac-control-logs-disconnect-0',
          sshHost: 'ac-control-logs-disconnect-0',
        },
      ],
    });

    const controller = new AbortController();
    const response = await callApi(
      `https://example.com/v1/workloads/${id}/logs?follow=true`,
      {
        method: 'GET',
        headers: { Authorization: 'Bearer mock-github-token' },
        signal: controller.signal,
      },
    );
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(remoteSignal).toBeDefined());

    controller.abort(new Error('client interrupted'));

    await expect(response.text()).rejects.toThrow();
    await remoteAborted;
    expect(remoteSignal?.aborted).toBe(true);
    expect(remoteSignal?.reason).toEqual(new Error('Client disconnected'));
  });

  it('streams Service workload logs from the live VM that has the container', async () => {
    const id = 'logs-server';
    await seedWorkload(id, {
      vms: [
        {
          ip: '203.0.113.42',
          cloudId: 'vm-server-logs',
        },
      ],
      cloudProvider: CloudType.AWS,
      workloadType: WorkloadType.Service,
    });

    const response = await logsRequest(id);

    expect(response.status).toBe(200);
    await expect(readEvents(response)).resolves.toEqual([
      { type: 'stdout', data: 'log line\n' },
      { type: 'exit', code: 0 },
    ]);
    expect(execMock).toHaveBeenCalledWith(
      '203.0.113.42',
      expect.stringContaining('docker inspect --type container'),
      1,
      false,
      expect.any(Number),
    );
    const remoteCommand = execStreamMock.mock.calls[0][0] as string;
    expect(remoteCommand).toContain('docker logs');
    expect(remoteCommand).toContain(id);
  });

  it('streams VM keepalive logs from its VM container', async () => {
    const id = 'logs-vm-container';
    await seedWorkload(id, {
      vms: [
        {
          ip: '203.0.113.43',
          cloudId: 'vm-container-logs',
        },
      ],
      cloudProvider: CloudType.AWS,
      workloadType: WorkloadType.Vm,
    });

    const response = await logsRequest(id);

    expect(response.status).toBe(200);
    const remoteCommand = execStreamMock.mock.calls[0][0] as string;
    expect(remoteCommand).toContain('docker logs');
    expect(remoteCommand).toContain(id);
    expect(remoteCommand).not.toContain('docker exec');
  });

  it('selects the live VM that has the workload container', async () => {
    const id = 'logs-multi-vm';
    execMock.mockImplementation(async (host: string) => {
      if (host === 'ac-control-logs-new-0') {
        return { stdout: 'running\n', stderr: '', code: 0 };
      }
      return { stdout: `${MISSING_CONTAINER_SENTINEL}\n`, stderr: '', code: 0 };
    });

    await seedWorkload(id, {
      vms: [
        {
          ip: 'ac-control-logs-old-0',
          cloudId: 'ac-control-logs-old-0',
          sshHost: 'ac-control-logs-old-0',
        },
        {
          ip: 'ac-control-logs-new-0',
          cloudId: 'ac-control-logs-new-0',
          sshHost: 'ac-control-logs-new-0',
        },
      ],
    });

    const response = await logsRequest(id);

    expect(response.status).toBe(200);
    await expect(readEvents(response)).resolves.toEqual([
      { type: 'stdout', data: 'log line\n' },
      { type: 'exit', code: 0 },
    ]);
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(createTransport).toHaveBeenLastCalledWith(
      'ac-control-logs-new-0',
      'test-ssh-key',
      22,
      'root',
    );
    expect(createUserTransport).toHaveBeenCalledWith(
      'ac-control-logs-new-0',
      'test-ssh-key',
      22,
      'root',
    );
    const remoteCommand = execStreamMock.mock.calls[0][0] as string;
    expect(remoteCommand).toContain('docker logs');
    expect(remoteCommand).toContain(id);
  });

  it('returns 409 when multiple live VMs have the workload container', async () => {
    const id = 'logs-ambiguous-live-vms';
    await seedWorkload(id, {
      vms: [
        {
          ip: 'ac-control-logs-a-0',
          cloudId: 'ac-control-logs-a-0',
          sshHost: 'ac-control-logs-a-0',
        },
        {
          ip: 'ac-control-logs-b-0',
          cloudId: 'ac-control-logs-b-0',
          sshHost: 'ac-control-logs-b-0',
        },
      ],
    });

    const response = await logsRequest(id);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'WORKLOAD_OPERATION_FAILED',
      status: 409,
      message: `Workload has 2 live VMs with a workload container named "${id}". logs cannot choose safely.`,
    });
    expect(execStreamMock).not.toHaveBeenCalled();
  });

  it('returns 409 when no candidate VM has the workload container', async () => {
    const id = 'logs-missing-container';
    execMock.mockResolvedValue({
      stdout: `${MISSING_CONTAINER_SENTINEL}\n`,
      stderr: '',
      code: 0,
    });

    await seedWorkload(id, {
      vms: [
        {
          ip: 'ac-control-logs-empty-0',
          cloudId: 'ac-control-logs-empty-0',
          sshHost: 'ac-control-logs-empty-0',
        },
      ],
    });

    const response = await logsRequest(id);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: LOGS_CONTAINER_NOT_READY,
      status: 409,
      message: `Workload is running. No workload container named "${id}" found on any live VM for this workload.`,
    });
    expect(execStreamMock).not.toHaveBeenCalled();
  });

  it('reports the SSH error, not a missing container, when a live VM is unreachable', async () => {
    const id = 'logs-unreachable-vm';
    execMock.mockImplementation(async (host: string) => {
      if (host === 'ac-control-logs-down-0') {
        throw new Error('connect ETIMEDOUT 203.0.113.7:22');
      }
      return { stdout: `${MISSING_CONTAINER_SENTINEL}\n`, stderr: '', code: 0 };
    });

    await seedWorkload(id, {
      vms: [
        {
          ip: 'ac-control-logs-down-0',
          cloudId: 'ac-control-logs-down-0',
          sshHost: 'ac-control-logs-down-0',
        },
        {
          ip: 'ac-control-logs-up-0',
          cloudId: 'ac-control-logs-up-0',
          sshHost: 'ac-control-logs-up-0',
        },
      ],
    });

    const response = await logsRequest(id, { follow: true });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: LOGS_CONTAINER_NOT_READY,
      status: 409,
      message:
        'Workload is running. Could not reach the VM ac-control-logs-down-0 over SSH: connect ETIMEDOUT 203.0.113.7:22',
    });
    expect(execStreamMock).not.toHaveBeenCalled();
  });

  it('streams workload-container logs over a mapped Local SSH port', async () => {
    const id = 'logs-local-mapped-port';
    await seedWorkload(id, {
      vms: [
        {
          ip: 'localhost',
          cloudId: 'ac-local-job-1-0',
          sshHost: 'localhost',
          sshPort: 22022,
          sshUsername: 'root',
        },
      ],
    });

    const response = await logsRequest(id);

    expect(response.status).toBe(200);
    await expect(readEvents(response)).resolves.toEqual([
      { type: 'stdout', data: 'log line\n' },
      { type: 'exit', code: 0 },
    ]);
    expect(createTransport).toHaveBeenCalledWith(
      'localhost',
      'test-ssh-key',
      22022,
      'root',
    );
    expect(createUserTransport).toHaveBeenCalledWith(
      'localhost',
      'test-ssh-key',
      22022,
      'root',
    );
    expect(execStreamMock.mock.calls[0]?.[0]).toContain('exec docker logs');
    expect(execStreamMock.mock.calls[0]?.[0]).toContain(id);
  });

  it('returns 404 for an unknown Workload ID', async () => {
    const response = await logsRequest('missing');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      message: 'Workload not found',
    });
  });

  it('returns 400 when there is no live VM', async () => {
    const id = 'logs-no-vm';
    await seedWorkload(id, {
      vms: [
        {
          ip: 'ac-control-logs-ended-0',
          cloudId: 'ac-control-logs-ended-0',
          sshHost: 'ac-control-logs-ended-0',
        },
      ],
    });
    await releaseTestVms(id, 'ac-control-logs-ended-0');

    const response = await logsRequest(id);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: LOGS_CONTAINER_NOT_READY,
      status: 400,
      message: 'Workload is running. No live VMs found for this workload',
    });
    expect(execMock).not.toHaveBeenCalled();
    expect(execStreamMock).not.toHaveBeenCalled();
  });

  it('says a Workload that is still starting has no container yet', async () => {
    const id = 'logs-starting';
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: WorkloadType.Job,
      image: 'test-image',
      dockerCommand: 'docker run -d --name test test-image',
      region: 'local',
      vmType: 'local',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
    });
    await walkToState(id, WorkloadState.Provisioning);

    const response = await logsRequest(id);

    await expect(response.json()).resolves.toMatchObject({
      code: LOGS_CONTAINER_NOT_READY,
      message: 'Workload is provisioning; its container is not running yet.',
    });
  });

  it('keeps the final error once the Workload has ended', async () => {
    const id = 'logs-ended';
    await seedWorkload(id, {
      vms: [
        {
          ip: 'ac-control-logs-ended-1',
          cloudId: 'ac-control-logs-ended-1',
          sshHost: 'ac-control-logs-ended-1',
        },
      ],
    });
    await releaseTestVms(id, 'ac-control-logs-ended-1');
    await walkToState(id, WorkloadState.Completed);

    const response = await logsRequest(id);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'WORKLOAD_OPERATION_FAILED',
      message: 'No live VMs found for this workload',
    });
  });
});
