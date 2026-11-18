import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DescribeInstancesCommand,
  DescribeSpotInstanceRequestsCommand,
  StartInstancesCommand,
  type Instance,
  type SpotInstanceRequest,
} from '@aws-sdk/client-ec2';
import type { protos } from '@google-cloud/compute';
import { AWS } from '../../../../src/api/services/gateways/aws.js';
import { GCP } from '../../../../src/api/services/gateways/gcp.js';
import { completeCloudConfig } from '../../../../src/shared/cloud-config.js';
import { CloudType } from '../../../../src/shared/cloud.js';
import { requirePreemptible } from '../../helpers/fixtures.js';
import { fakeSdkClient } from '../../helpers/sdk-client.js';

type GcpInstance = protos.google.cloud.compute.v1.IInstance;
type GcpOperation = protos.google.cloud.compute.v1.IOperation;
type GcpOptions = { timeout?: number; retry?: unknown };

vi.mock('../../../../src/api/services/logger.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function awsInstance(code: number): Instance {
  return {
    InstanceId: 'i-original',
    InstanceLifecycle: 'spot',
    SpotInstanceRequestId: 'sir-original',
    State: { Code: code },
    PublicIpAddress: code === 16 ? '192.0.2.10' : undefined,
  };
}

function awsRestart() {
  const gateway = new AWS(
    completeCloudConfig({
      cloudProvider: CloudType.AWS,
      region: 'us-east-2',
      vmType: 't3.medium',
      spot: true,
      credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
    }),
  );
  let running = false;
  const get = vi.fn(
    async (): Promise<Instance | undefined> => awsInstance(running ? 16 : 80),
  );
  const request = vi.fn(
    async (): Promise<SpotInstanceRequest | undefined> => ({
      SpotInstanceRequestId: 'sir-original',
      InstanceId: 'i-original',
      State: 'disabled',
      Status: { Code: 'instance-stopped-by-user' },
    }),
  );
  const start = vi.fn(async () => {
    running = true;
    return {};
  });
  const send = vi.fn(
    async (command: unknown, _options?: { abortSignal?: AbortSignal }) => {
      if (command instanceof DescribeInstancesCommand) {
        const instance = await get();
        return { Reservations: [{ Instances: instance ? [instance] : [] }] };
      }
      if (command instanceof DescribeSpotInstanceRequestsCommand) {
        const value = await request();
        return { SpotInstanceRequests: value ? [value] : [] };
      }
      if (command instanceof StartInstancesCommand) return start();
      throw new Error('Recovery attempted an unexpected AWS operation');
    },
  );
  gateway.ec2client = fakeSdkClient({ send });
  return {
    gateway,
    get,
    request,
    start,
    send,
    recover: () => requirePreemptible(gateway.compute()).startVM('i-original'),
  };
}

function gcpInstance(status: string): GcpInstance {
  return {
    name: 'original-vm',
    id: '1234567890123456789',
    status,
    networkInterfaces: [{ accessConfigs: [{ natIP: '192.0.2.10' }] }],
  };
}

function gcpRestart() {
  const gateway = new GCP(
    completeCloudConfig({
      cloudProvider: CloudType.GCP,
      region: 'us-east4',
      availabilityZone: 'a',
      vmType: 'e2-standard-2',
      spot: true,
      credentials: {
        projectId: 'test-project',
        clientEmail: 'test@example.invalid',
        privateKey: 'test-key',
      },
    }),
  );
  let running = false;
  let operations = 0;
  const get = vi.fn(
    async (
      _request?: unknown,
      _options?: GcpOptions,
    ): Promise<[GcpInstance]> => [
      gcpInstance(running ? 'RUNNING' : 'TERMINATED'),
    ],
  );
  const start = vi.fn(
    async (
      _request?: { requestId?: string },
      _options?: GcpOptions,
    ): Promise<[GcpOperation]> => [{ name: `start-${++operations}` }],
  );
  const wait = vi.fn(
    async (
      _request?: unknown,
      _options?: GcpOptions,
    ): Promise<[GcpOperation]> => {
      running = true;
      return [{ status: 'DONE' }];
    },
  );
  gateway.instancesClient = fakeSdkClient({ get, start });
  gateway.zoneOperationsClient = fakeSdkClient({ wait });
  return {
    gateway,
    get,
    start,
    wait,
    recover: () => requirePreemptible(gateway.compute()).startVM('original-vm'),
  };
}

async function recover(harness: { recover: () => Promise<string | null> }) {
  const result = harness.recover();
  await vi.runAllTimersAsync();
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AWS restart recovery', () => {
  it('waits for both shutdown and the delayed Spot-request transition observed live', async () => {
    const h = awsRestart();
    const startedAt: number[] = [];
    h.get.mockImplementation(async () =>
      awsInstance(startedAt.length ? 16 : Date.now() < 40_000 ? 64 : 80),
    );
    const settled = await h.request();
    h.request.mockImplementation(async () =>
      Date.now() < 150_000
        ? { ...settled, State: 'active', Status: { Code: 'marked-for-stop' } }
        : settled,
    );
    h.start.mockImplementation(async () => {
      startedAt.push(Date.now());
      return {};
    });

    await expect(recover(h)).resolves.toBe('192.0.2.10');
    expect(startedAt).toHaveLength(1);
    expect(startedAt[0]).toBeGreaterThanOrEqual(160_000);
    const requests = h.send.mock.calls.filter(
      ([command]) => command instanceof DescribeSpotInstanceRequestsCommand,
    );
    expect(
      requests.every(
        ([command]) =>
          (command as DescribeSpotInstanceRequestsCommand).input
            .SpotInstanceRequestIds?.[0] === 'sir-original',
      ),
    ).toBe(true);
  });

  it.each([
    'IncorrectSpotRequestState',
    'IncorrectInstanceState',
    'InsufficientInstanceCapacity',
  ])('retries a rejected %s start within the recovery budget', async (code) => {
    const h = awsRestart();
    h.start.mockRejectedValueOnce(
      Object.assign(new Error(code), { Code: code }),
    );
    await expect(recover(h)).resolves.toBe('192.0.2.10');
    expect(h.start).toHaveBeenCalledTimes(2);
  });

  it('does not restart or replace after stale stopped replies following acceptance', async () => {
    const h = awsRestart();
    h.get.mockImplementation(async () =>
      awsInstance(Date.now() < 30_000 ? 80 : 16),
    );
    await expect(recover(h)).resolves.toBe('192.0.2.10');
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it.each(['instance-stopped-no-capacity', 'instance-stopped-by-price'])(
    'waits for EC2 automatic resumption of %s without a manual start',
    async (code) => {
      const h = awsRestart();
      const request = await h.request();
      h.request.mockResolvedValue({
        ...request,
        State: 'open',
        Status: { Code: code },
      });
      h.get.mockImplementation(async () =>
        awsInstance(Date.now() < 60_000 ? 80 : 16),
      );
      await expect(recover(h)).resolves.toBe('192.0.2.10');
      expect(h.start).not.toHaveBeenCalled();
    },
  );

  it('bounds waiting for unavailable EC2 capacity without attempting an unauthorized start', async () => {
    const h = awsRestart();
    const request = await h.request();
    h.request.mockResolvedValue({
      ...request,
      State: 'open',
      Status: { Code: 'instance-stopped-no-capacity' },
    });
    await expect(recover(h)).resolves.toBeNull();
    expect(h.start).not.toHaveBeenCalled();
    expect(Date.now()).toBe(300_000);
  });

  it('does not use a request belonging to a different VM to authorize a start', async () => {
    const h = awsRestart();
    const request = await h.request();
    h.request.mockResolvedValue({ ...request, InstanceId: 'i-replacement' });
    await expect(recover(h)).resolves.toBeNull();
    expect(h.start).not.toHaveBeenCalled();
  });

  it.each([32, 48])(
    'never starts an irreversibly terminating VM in state %s',
    async (state) => {
      const h = awsRestart();
      h.get.mockResolvedValue(awsInstance(state));
      await expect(recover(h)).resolves.toBeNull();
      expect(h.start).not.toHaveBeenCalled();
      expect(Date.now()).toBe(0);
    },
  );

  it('fails on permission errors instead of spending the recovery budget retrying them', async () => {
    const h = awsRestart();
    h.request.mockRejectedValue(
      Object.assign(new Error('UnauthorizedOperation'), {
        name: 'UnauthorizedOperation',
      }),
    );
    await expect(recover(h)).resolves.toBeNull();
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.start).not.toHaveBeenCalled();
  });

  it('tolerates transient observation failures and requires readiness again afterward', async () => {
    const h = awsRestart();
    h.get.mockRejectedValueOnce(
      Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
    );
    await expect(recover(h)).resolves.toBe('192.0.2.10');
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('aborts a hung observation and ignores its late stopped response', async () => {
    const h = awsRestart();
    let finish!: (instance: Instance) => void;
    h.get.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await expect(recover(h)).resolves.toBeNull();
    expect(Date.now()).toBe(300_000);
    expect(h.send.mock.calls[0][1]?.abortSignal?.aborted).toBe(true);
    finish(awsInstance(80));
    await vi.runAllTimersAsync();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('does not restart its budget for a hung start or observe after its late completion', async () => {
    const h = awsRestart();
    let finish!: (value: object) => void;
    h.start.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await expect(recover(h)).resolves.toBeNull();
    expect(Date.now()).toBe(300_000);
    const reads = h.get.mock.calls.length;
    finish({});
    await vi.runAllTimersAsync();
    expect(h.get).toHaveBeenCalledTimes(reads);
    expect(h.start).toHaveBeenCalledTimes(1);
  });
});

describe('GCP restart recovery', () => {
  it('waits for the STOPPING transition before starting the retained VM', async () => {
    const h = gcpRestart();
    const starts: number[] = [];
    h.get.mockImplementation(async () => [
      gcpInstance(
        starts.length
          ? 'RUNNING'
          : Date.now() < 55_000
            ? 'STOPPING'
            : 'TERMINATED',
      ),
    ]);
    h.start.mockImplementation(async () => {
      starts.push(Date.now());
      return [{ name: 'start-operation' }];
    });
    await expect(recover(h)).resolves.toBe('192.0.2.10');
    expect(starts).toHaveLength(1);
    expect(starts[0]).toBeGreaterThanOrEqual(65_000);
  });

  it.each(['RESOURCE_NOT_READY_WITH_DETAILS', 'ZONE_RESOURCE_POOL_EXHAUSTED'])(
    'retries a completed %s operation with a fresh request ID',
    async (code) => {
      const h = gcpRestart();
      h.wait.mockResolvedValueOnce([
        {
          status: 'DONE',
          error: {
            errors: [
              {
                code,
                message:
                  'The resource fingerprint changed during the start operation.',
              },
            ],
          },
        },
      ]);
      await expect(recover(h)).resolves.toBe('192.0.2.10');
      expect(h.start).toHaveBeenCalledTimes(2);
      expect(h.start.mock.calls[0][0]?.requestId).not.toBe(
        h.start.mock.calls[1][0]?.requestId,
      );
    },
  );

  it('keeps the request ID when retrying an ambiguous start transport failure', async () => {
    const h = gcpRestart();
    h.start.mockRejectedValueOnce(
      Object.assign(new Error('unavailable'), { code: 14 }),
    );
    await expect(recover(h)).resolves.toBe('192.0.2.10');
    expect(h.start).toHaveBeenCalledTimes(2);
    expect(h.start.mock.calls[0][0]?.requestId).toBe(
      h.start.mock.calls[1][0]?.requestId,
    );
  });

  it('keeps polling the accepted operation through a transient RPC failure', async () => {
    const h = gcpRestart();
    h.wait.mockRejectedValueOnce(
      Object.assign(new Error('unavailable'), { code: 14 }),
    );
    await expect(recover(h)).resolves.toBe('192.0.2.10');
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.wait).toHaveBeenCalledTimes(2);
    expect(h.wait.mock.calls[0][0]).toEqual(h.wait.mock.calls[1][0]);
  });

  it('tolerates stale TERMINATED reads after a successful start operation', async () => {
    const h = gcpRestart();
    h.get.mockImplementation(async () => [
      gcpInstance(Date.now() < 30_000 ? 'TERMINATED' : 'RUNNING'),
    ]);
    await expect(recover(h)).resolves.toBe('192.0.2.10');
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of the same VM name with a different native identity', async () => {
    const h = gcpRestart();
    h.get.mockImplementation(async () => [
      {
        ...gcpInstance(h.start.mock.calls.length ? 'RUNNING' : 'TERMINATED'),
        id: h.start.mock.calls.length
          ? '9999999999999999999'
          : '1234567890123456789',
      },
    ]);
    await expect(recover(h)).resolves.toBeNull();
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it.each([5, 7])(
    'fails on definitive absence or permission error %s',
    async (code) => {
      const h = gcpRestart();
      h.get.mockRejectedValue(
        Object.assign(new Error('provider refusal'), { code }),
      );
      await expect(recover(h)).resolves.toBeNull();
      expect(h.start).not.toHaveBeenCalled();
      expect(Date.now()).toBe(0);
    },
  );

  it('does not retry an operation with a permanent configuration error', async () => {
    const h = gcpRestart();
    h.wait.mockResolvedValue([
      {
        status: 'DONE',
        error: {
          errors: [
            {
              code: 'INVALID_FIELD_VALUE',
              message: 'invalid disk configuration',
            },
          ],
        },
      },
    ]);
    await expect(recover(h)).resolves.toBeNull();
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.wait).toHaveBeenCalledTimes(1);
  });

  it('awaits a pending start and its operation before handing off after the deadline', async () => {
    const h = gcpRestart();
    let finish!: (value: [GcpOperation]) => void;
    h.start.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const handoff = vi.fn();
    const result = h.recover().then(handoff);
    await vi.advanceTimersByTimeAsync(300_000);
    const handoffsAtDeadline = handoff.mock.calls.length;
    finish([{ name: 'delayed-start-operation', status: 'PENDING' }]);
    await vi.runAllTimersAsync();
    await result;

    expect(handoffsAtDeadline).toBe(0);
    expect(handoff).toHaveBeenCalledExactlyOnceWith(null);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.get).toHaveBeenCalledTimes(3);
    expect(h.wait).toHaveBeenCalledExactlyOnceWith(
      {
        operation: 'delayed-start-operation',
        project: 'test-project',
        zone: 'us-east4-a',
      },
      { retry: null },
    );
    expect(h.start.mock.calls[0][1]).toEqual({ retry: null });
  });

  it('awaits a failed start without retrying after the deadline', async () => {
    const h = gcpRestart();
    let fail!: (error: Error) => void;
    h.start.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const handoff = vi.fn();
    const result = h.recover().then(handoff);
    await vi.advanceTimersByTimeAsync(300_000);
    const handoffsAtDeadline = handoff.mock.calls.length;
    fail(Object.assign(new Error('unavailable'), { code: 14 }));
    await vi.runAllTimersAsync();
    await result;

    expect(handoffsAtDeadline).toBe(0);
    expect(handoff).toHaveBeenCalledExactlyOnceWith(null);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.get).toHaveBeenCalledTimes(3);
    expect(h.wait).not.toHaveBeenCalled();
  });

  it('awaits operation completion beyond the budget and disables the SDK long retry policy', async () => {
    const h = gcpRestart();
    h.wait.mockImplementation(async () => [
      { status: Date.now() < 315_000 ? 'RUNNING' : 'DONE' },
    ]);
    await expect(recover(h)).resolves.toBeNull();
    expect(Date.now()).toBe(315_000);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.get).toHaveBeenCalledTimes(3);
    expect(h.get.mock.calls[0][1]).toEqual({ timeout: 300_000, retry: null });
    expect(
      h.wait.mock.calls.every(([, options]) => options?.retry === null),
    ).toBe(true);
  });

  it('awaits a hung operation RPC and never observes readiness after its late completion', async () => {
    const h = gcpRestart();
    let finish!: (value: [GcpOperation]) => void;
    h.wait.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const handoff = vi.fn();
    const result = h.recover().then(handoff);
    await vi.advanceTimersByTimeAsync(300_000);
    const handoffsAtDeadline = handoff.mock.calls.length;
    finish([{ status: 'DONE' }]);
    await vi.runAllTimersAsync();
    await result;

    expect(handoffsAtDeadline).toBe(0);
    expect(handoff).toHaveBeenCalledExactlyOnceWith(null);
    expect(h.get).toHaveBeenCalledTimes(3);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.wait).toHaveBeenCalledTimes(1);
  });

  it('keeps polling an accepted operation after a transient RPC failure at the deadline', async () => {
    const h = gcpRestart();
    h.wait.mockImplementationOnce(async () => {
      vi.setSystemTime(300_000);
      throw Object.assign(new Error('unavailable'), { code: 14 });
    });

    await expect(recover(h)).resolves.toBeNull();
    expect(Date.now()).toBe(305_000);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.get).toHaveBeenCalledTimes(3);
    expect(h.wait).toHaveBeenCalledTimes(2);
    expect(h.wait.mock.calls[0][0]).toEqual(h.wait.mock.calls[1][0]);
  });

  it('does not accept an observation that arrives at the absolute deadline', async () => {
    const h = gcpRestart();
    h.get.mockImplementation(async () => {
      vi.setSystemTime(300_000);
      return [gcpInstance('RUNNING')];
    });
    await expect(recover(h)).resolves.toBeNull();
    expect(h.start).not.toHaveBeenCalled();
  });
});

describe('Accepted starts that never become ready', () => {
  it('bounds the AWS attempt without starting the same VM again', async () => {
    const h = awsRestart();
    h.get.mockResolvedValue(awsInstance(80));
    await expect(recover(h)).resolves.toBeNull();
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(300_000);
  });

  it('bounds the GCP attempt without starting the same VM again', async () => {
    const h = gcpRestart();
    h.get.mockResolvedValue([gcpInstance('TERMINATED')]);
    await expect(recover(h)).resolves.toBeNull();
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(300_000);
  });
});
