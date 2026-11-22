import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { callApi } from '../helpers/api-test-helper';
import { walkToState, provisionTestVm } from '../../helpers/workload-store.js';
import { getDB } from '../../../src/api/services/repositories/db';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState, WorkloadType } from '../../../src/shared/workload.js';
import { resetTestStore } from '../utils';
import Github from '../../../src/api/services/gateways/github';
import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../../../src/shared/api-version';

const { execStreamMock } = vi.hoisted(() => ({
  execStreamMock: vi.fn(),
}));

vi.mock('../../../src/api/services/gateways/transport', () => ({
  createTransport: vi.fn(() => ({
    exec: vi.fn(),
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
import { writeExecStreamEvent } from '../../../src/api/routes/cli';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';

describe('POST /v1/workloads/{id}/exec', () => {
  let remoteStdout = 'out\n';
  let remoteStderr = '';
  let remoteCode = 0;

  beforeEach(async () => {
    remoteStdout = 'out\n';
    remoteStderr = '';
    remoteCode = 0;
    execStreamMock.mockReset();
    execStreamMock.mockImplementation(
      async (
        _command: string,
        options: {
          onStdout?: (chunk: Buffer) => void | Promise<void>;
          onStderr?: (chunk: Buffer) => void | Promise<void>;
        } = {},
      ) => {
        if (remoteStdout) await options.onStdout?.(Buffer.from(remoteStdout));
        if (remoteStderr) await options.onStderr?.(Buffer.from(remoteStderr));
        return remoteCode;
      },
    );
    vi.mocked(createTransport).mockClear();
    vi.mocked(createUserTransport).mockClear();
    vi.mocked(Github.authenticate).mockClear();
    await resetTestStore();
  });

  async function seedWorkload(
    id: string,
    {
      vms = [],
      cloudProvider = CloudType.AWS,
      workloadType = WorkloadType.Job,
    }: {
      vms?: Parameters<typeof provisionTestVm>[1][];
      cloudProvider?: CloudType;
      workloadType?: WorkloadType;
    } = {},
  ): Promise<void> {
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
      region: 'us-east-1',
      vmType: 't3.medium',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
    });
    for (const vm of vms) await provisionTestVm(id, vm);
    await walkToState(id, WorkloadState.Running);
  }

  async function execRequest(id: string, body: Record<string, unknown> = {}) {
    return callApi(`https://example.com/v1/workloads/${id}/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer mock-github-token',
      },
      body: JSON.stringify({
        command: 'echo ok',
        ...body,
      }),
    });
  }

  async function readExecEvents(response: Response) {
    const text = await response.text();
    return text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .map((event) => {
        if (event.type !== 'stdout' && event.type !== 'stderr') return event;
        return {
          ...event,
          data: Buffer.from(event.data, 'base64').toString(),
        };
      });
  }

  it.each([
    ['missing', ''],
    ['mismatched', '0.0.0-incompatible'],
  ])(
    'rejects a %s client version before authentication or execution',
    async (_case, clientVersion) => {
      const response = await callApi(
        'https://example.com/v1/workloads/version-gated/exec',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [ANYCLOUD_CLIENT_VERSION_HEADER]: clientVersion,
          },
          body: JSON.stringify({
            command: 'echo ok',
          }),
        },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: 'CLIENT_VERSION_MISMATCH',
        status: 400,
      });
      expect(Github.authenticate).not.toHaveBeenCalled();
      expect(execStreamMock).not.toHaveBeenCalled();
    },
  );

  it('bounds stalled response writes and removes listeners', async () => {
    vi.useFakeTimers();
    try {
      const res = Object.assign(new EventEmitter(), {
        destroyed: false,
        writableEnded: false,
        write: vi.fn(() => false),
      }) as unknown as Parameters<typeof writeExecStreamEvent>[0];

      const write = writeExecStreamEvent(
        res,
        { type: 'heartbeat' },
        undefined,
        25,
      );
      const assertion = expect(write).rejects.toThrow(
        'Exec stream write timed out',
      );
      await vi.advanceTimersByTimeAsync(25);

      await assertion;
      expect(res.listenerCount('drain')).toBe(0);
      expect(res.listenerCount('close')).toBe(0);
      expect(res.listenerCount('error')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs normal provider commands inside the workload container', async () => {
    const id = 'exec-normal';
    await seedWorkload(id, { vms: [{ ip: '10.0.0.1', cloudId: 'vm-1' }] });

    const response = await execRequest(id);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(
      'application/x-ndjson',
    );
    expect(response.headers.get('cache-control')).toBe(
      'no-cache, no-transform',
    );
    await expect(readExecEvents(response)).resolves.toEqual([
      { type: 'stdout', data: 'out\n' },
      { type: 'exit', code: 0 },
    ]);
    expect(createUserTransport).toHaveBeenCalledWith(
      '10.0.0.1',
      'test-ssh-key',
      22,
      'root',
    );
    expect(createTransport).not.toHaveBeenCalled();
    const remoteCommand = execStreamMock.mock.calls[0][0] as string;
    expect(remoteCommand).toContain('docker exec');
    // The guard must sit inside the container, after `docker exec -i`. Outside,
    // it stops only the client and dockerd keeps running the real process — and
    // `-i` is what carries the channel's stdin in for the guard to read.
    expect(remoteCommand).toContain('docker exec -i');
    expect(remoteCommand).toContain('/bin/sh -c');
    expect(remoteCommand.indexOf('docker exec -i')).toBeLessThan(
      remoteCommand.indexOf('exec 3<&0'),
    );
    // Exactly one guard: a second, outer one would background `docker exec`
    // with /dev/null stdin and fire the inner guard immediately.
    expect(remoteCommand.split('exec 3<&0').length - 1).toBe(1);
    expect(remoteCommand).toContain(id);
    expect(remoteCommand).toContain('echo ok');
  });

  it('runs VM commands inside the VM container', async () => {
    const id = 'exec-vm-container';
    await seedWorkload(id, {
      vms: [{ ip: '10.0.0.11', cloudId: 'vm-container' }],
      workloadType: WorkloadType.Vm,
    });

    const response = await execRequest(id, { command: 'pwd' });

    expect(response.status).toBe(200);
    const remoteCommand = execStreamMock.mock.calls[0][0] as string;
    expect(remoteCommand).toContain('docker exec');
    expect(remoteCommand).toContain(id);
    expect(remoteCommand).toContain('pwd');
  });

  it('runs commands inside the workload container over a mapped Local SSH port', async () => {
    const id = 'exec-local-mapped-port';
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
      cloudProvider: CloudType.Local,
    });

    const response = await execRequest(id, { command: 'whoami' });

    expect(response.status).toBe(200);
    const remoteCommand = execStreamMock.mock.calls[0][0] as string;
    expect(createUserTransport).toHaveBeenCalledWith(
      'localhost',
      'test-ssh-key',
      22022,
      'root',
    );
    expect(remoteCommand).toContain('whoami');
    expect(remoteCommand).toContain('docker exec -i');
  });

  it('returns non-zero remote command exits without failing the HTTP request', async () => {
    const id = 'exec-nonzero';
    remoteStdout = '';
    remoteStderr = 'bad\n';
    remoteCode = 17;
    await seedWorkload(id, { vms: [{ ip: '10.0.0.2', cloudId: 'vm-2' }] });

    const response = await execRequest(id, { command: 'false' });

    expect(response.status).toBe(200);
    await expect(readExecEvents(response)).resolves.toEqual([
      { type: 'stderr', data: 'bad\n' },
      { type: 'exit', code: 17 },
    ]);
  });

  it('streams an error event for transport failures after headers start', async () => {
    const id = 'exec-stream-error';
    execStreamMock.mockImplementationOnce(
      async (
        _command: string,
        options: {
          onStdout?: (chunk: Buffer) => void | Promise<void>;
        } = {},
      ) => {
        await options.onStdout?.(Buffer.from('before\n'));
        throw new Error('ssh failed');
      },
    );
    await seedWorkload(id, { vms: [{ ip: '10.0.0.9', cloudId: 'vm-9' }] });

    const response = await execRequest(id, { command: 'echo before && boom' });

    expect(response.status).toBe(200);
    await expect(readExecEvents(response)).resolves.toEqual([
      { type: 'stdout', data: 'before\n' },
      { type: 'error', error: 'ssh failed' },
    ]);
  });

  it('rejects the removed VM-host diagnostic target', async () => {
    const id = 'exec-vm';
    await seedWorkload(id, { vms: [{ ip: '10.0.0.3', cloudId: 'vm-3' }] });

    const response = await execRequest(id, { command: 'df -h', vm: true });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'EXEC_REQUEST_INVALID',
      status: 400,
    });
    expect(execStreamMock).not.toHaveBeenCalled();
  });

  it('returns 400 when there is no live VM', async () => {
    const id = 'exec-no-live-vm';
    await seedWorkload(id);

    const response = await execRequest(id);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'WORKLOAD_OPERATION_FAILED',
      status: 400,
      message: 'No live VMs found for this workload',
    });
    expect(execStreamMock).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown Workload ID', async () => {
    const response = await execRequest('missing');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      message: 'Workload not found',
    });
  });

  it('returns 400 for multi-VM workloads', async () => {
    const id = 'exec-multi-vm';
    await seedWorkload(id, {
      vms: [
        { ip: '10.0.0.4', cloudId: 'vm-4' },
        { ip: '10.0.0.5', cloudId: 'vm-5' },
      ],
    });

    const response = await execRequest(id);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'WORKLOAD_OPERATION_FAILED',
      status: 400,
      message:
        'Workload has 2 live VMs. exec only supports single-VM workloads.',
    });
    expect(execStreamMock).not.toHaveBeenCalled();
  });
});
