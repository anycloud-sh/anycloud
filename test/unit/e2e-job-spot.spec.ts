import { afterEach, expect, test, vi } from 'vitest';
import {
  JOB_NATIVE_CREDENTIALS,
  jobNativeSessionFixture,
} from '../helpers/e2e-job-native.js';
import { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import type { JobNativeAttempt } from '../integration/e2e/internal/targets/job-types.js';
import { JobSpotTransport } from '../integration/e2e/internal/transports/job-spot.js';
import { trackedWorkloadRefForTest } from './helpers/e2e.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function harness() {
  const ref = trackedWorkloadRefForTest('spot-original-job');
  const ownerApi = 'a'.repeat(32);
  const credentialId = 'b'.repeat(64);
  const tags = [
    { Key: 'anycloud_deployment', Value: ref.id },
    { Key: 'anycloud_owner_api', Value: ownerApi },
  ];
  const attempt: JobNativeAttempt = {
    ref,
    credentialId,
    cloudProvider: JOB_NATIVE_CREDENTIALS.aws.cloudProvider,
    rowId: 1,
    createdAt: 1,
    endedAt: null,
    cloudId: 'i-0123456789abcdef0',
    region: 'us-east-1',
    availabilityZone: '1a',
    vmType: 't3.large',
    ip: '192.0.2.1',
  };
  const request = {
    SpotInstanceRequestId: 'sir-original',
    InstanceId: attempt.cloudId,
    Type: 'persistent',
    State: 'active',
    Tags: tags,
    LaunchSpecification: {
      InstanceType: 't3.large',
      UserData: 'private-launch-payload',
    },
  };
  const original = {
    InstanceId: attempt.cloudId,
    InstanceType: 't3.large',
    SpotInstanceRequestId: request.SpotInstanceRequestId,
    Placement: { AvailabilityZone: 'us-east-1a' },
    State: { Name: 'running' },
    Tags: tags,
  };
  const replacement: typeof original = {
    ...original,
    InstanceId: 'i-fedcba98765432100',
    State: { Name: 'running' },
    Tags: [],
  };
  const state = {
    owner: '123456789012',
    requests: [request],
    instances: [original],
    requestPage: false,
    instancePage: false,
    requestDenied: false,
    instanceDenied: false,
    truncated: false,
    invalidJson: false,
    cancelDenied: false,
    cancelLostReply: false,
    foreignCancel: false,
    foreignTerminate: false,
    controllerChanged: false,
    nativeAbsent: false,
    releasedByKernel: false,
    historyFailure: false,
    artifactFailure: false,
  };
  const order: string[] = [];
  const records: { name: string; body: unknown }[] = [];
  const world = jobNativeSessionFixture(
    JOB_NATIVE_CREDENTIALS.aws,
    (exe, args) => {
      if (exe !== 'aws') throw new Error('unexpected executable');
      order.push(args[1]);
      if (args[1] === 'describe-spot-instance-requests') {
        if (state.requestDenied)
          return {
            exitCode: 1,
            stderr:
              'An error occurred (AccessDenied) when calling the DescribeSpotInstanceRequests operation: denied',
          };
        const instanceFilter = args.find((arg) =>
          arg.startsWith('Name=instance-id,Values='),
        );
        const requestFilter = args.find((arg) =>
          arg.startsWith('Name=spot-instance-request-id,Values='),
        );
        const byId = args.indexOf('--spot-instance-request-ids');
        const selected = state.requests.filter(
          (row) =>
            (byId < 0 || row.SpotInstanceRequestId === args[byId + 1]) &&
            (!instanceFilter ||
              row.InstanceId === instanceFilter.split('Values=')[1]) &&
            (!requestFilter ||
              row.SpotInstanceRequestId === requestFilter.split('Values=')[1]),
        );
        const stdout = state.invalidJson
          ? '{'
          : JSON.stringify({
              SpotInstanceRequests: selected,
              ...(state.requestPage ? { NextToken: 'not-complete' } : {}),
            });
        return state.truncated ? { stdout, outputTruncated: true } : stdout;
      }
      if (args[1] === 'describe-instances') {
        if (state.instanceDenied)
          return {
            exitCode: 1,
            stderr:
              'An error occurred (AccessDenied) when calling the DescribeInstances operation: denied',
          };
        const exact = args.indexOf('--instance-ids');
        const requestFilter = args.find((arg) =>
          arg.startsWith('Name=spot-instance-request-id,Values='),
        );
        const tagged = args.some((arg) =>
          arg.startsWith('Name=tag:anycloud_deployment,'),
        );
        const instances = state.instances.filter(
          (vm) =>
            (exact < 0 || vm.InstanceId === args[exact + 1]) &&
            (!requestFilter ||
              vm.SpotInstanceRequestId === requestFilter.split('Values=')[1]) &&
            (!tagged ||
              vm.Tags.some(
                (tag) =>
                  tag.Key === 'anycloud_deployment' && tag.Value === ref.id,
              )),
        );
        return JSON.stringify({
          Reservations: [{ OwnerId: state.owner, Instances: instances }],
          ...(state.instancePage ? { NextToken: 'not-complete' } : {}),
        });
      }
      if (args[1] === 'cancel-spot-instance-requests') {
        if (state.cancelDenied)
          return {
            exitCode: 1,
            stderr:
              'An error occurred (AccessDenied) when calling the CancelSpotInstanceRequests operation: denied',
          };
        const id = args[args.indexOf('--spot-instance-request-ids') + 1];
        const found = state.requests.find(
          (row) => row.SpotInstanceRequestId === id,
        );
        if (!found) throw new Error('cancellation adopted a foreign request');
        found.State = 'cancelled';
        if (state.cancelLostReply) return { exitCode: null, timedOut: true };
        return JSON.stringify({
          CancelledSpotInstanceRequests: [
            {
              SpotInstanceRequestId: state.foreignCancel ? 'sir-foreign1' : id,
              State: 'cancelled',
            },
          ],
        });
      }
      if (args[1] === 'terminate-instances') {
        const id = args[args.indexOf('--instance-ids') + 1];
        const found = state.instances.find((vm) => vm.InstanceId === id);
        if (!found || request.State !== 'cancelled')
          throw new Error(
            'native termination preceded cancellation or adopted a foreign instance',
          );
        found.State.Name = 'terminated';
        return JSON.stringify({
          TerminatingInstances: [
            {
              InstanceId: state.foreignTerminate ? 'i-fffffffffffffffff' : id,
              CurrentState: { Name: 'terminated' },
            },
          ],
        });
      }
      throw new Error(`unexpected native operation ${args[1]}`);
    },
  );
  await world.session.initialize(Date.now() + 60_000);
  const cleanup = new CleanupStack();
  const spot = new JobSpotTransport({
    session: world.session,
    id: ref.id,
    ownerApi,
    credentialId,
    vmTypes: ['t3.large'],
    cleanupMs: 600_000,
    cleanup,
    nativeAbsent: () => state.nativeAbsent,
    assertController: () => {
      if (state.controllerChanged) throw new Error('controller changed');
    },
    artifacts: {
      json: async (name, body) => {
        if (state.artifactFailure) throw new Error('artifact failed');
        records.push({ name, body });
        return name;
      },
    },
    cleanupWait: {
      for: async (_label, probe, options) => {
        const value = await probe(Date.now() + options.timeoutMs);
        const unmet = options.unmet(value);
        if (unmet) throw new Error(unmet);
        return value;
      },
    },
  });
  const kernel = cleanup.defer('workload original', async () => {
    order.push('api-delete');
    original.State.Name = 'terminated';
    // The real private verification hook retains ended history while the
    // reference is still armed. Post-kernel rescue cannot capture it again.
    spot.remember([{ ...attempt, endedAt: 2 }]);
    state.nativeAbsent = true;
    state.releasedByKernel = true;
  });
  spot.arm(ref, async () => {
    if (state.releasedByKernel) throw new Error('kernel already released');
    if (state.historyFailure) throw new Error('later history incomplete');
    return [attempt];
  });
  spot.sent();
  return {
    ...world,
    cleanupSignal: world.cleanup.signal,
    state,
    request,
    original,
    replacement,
    attempt,
    spot,
    cleanup,
    kernel,
    records,
    order,
    tags,
  };
}

test('original persistent request and exact native placement precede read-only automatic release', async () => {
  const w = await harness();
  await expect(
    w.spot.active(w.attempt, Date.now() + 60_000),
  ).resolves.toMatchObject({
    id: w.request.SpotInstanceRequestId,
    state: 'active',
    type: 'persistent',
    instanceId: w.attempt.cloudId,
  });
  w.request.State = 'cancelled';
  w.original.State.Name = 'terminated';
  w.state.nativeAbsent = true;
  w.kernel.complete();
  await w.spot.release(Date.now() + 60_000);
  const count = w.calls.length;
  await w.cleanup.run();
  expect(w.calls).toHaveLength(count);
  expect(w.cleanup.observations().every((row) => row.completed)).toBe(true);
  expect(w.order).not.toContain('cancel-spot-instance-requests');
  expect(w.order).not.toContain('terminate-instances');
  expect(JSON.stringify(w.records)).not.toContain('private-launch-payload');
  expect(() => w.spot.assertAbsent()).not.toThrow();
});

test('fallback cancellation precedes API deletion and cleans a request-bound untagged replacement after foreground abort', async () => {
  const w = await harness();
  await w.spot.active(w.attempt, Date.now() + 60_000);
  w.state.instances.push(w.replacement);
  const before = w.calls.length;
  w.foreground.abort();
  await w.cleanup.run();
  expect(w.order.indexOf('cancel-spot-instance-requests')).toBeLessThan(
    w.order.indexOf('api-delete'),
  );
  expect(w.order.indexOf('terminate-instances')).toBeGreaterThan(
    w.order.indexOf('api-delete'),
  );
  expect(w.replacement.State.Name).toBe('terminated');
  expect(
    w.calls
      .slice(before)
      .every((call) => call.options?.signal === w.cleanupSignal),
  ).toBe(true);
  expect(w.cleanup.observations().every((row) => row.completed)).toBe(true);
  expect(
    w.calls
      .filter((call) => call.args[1] === 'terminate-instances')
      .map((call) => call.args[call.args.indexOf('--instance-ids') + 1]),
  ).toEqual([w.replacement.InstanceId]);
  expect(
    w.records.some(({ body }) => JSON.stringify(body).includes('"endedAt":2')),
  ).toBe(true);
});

test('a failed automatic assertion stays failed even when rescue independently removes the resources', async () => {
  const w = await harness();
  await w.spot.active(w.attempt, Date.now() + 60_000);
  w.state.nativeAbsent = true;
  await expect(w.spot.release(Date.now() + 60_000)).rejects.toThrow(
    'automatically cancel',
  );
  expect(w.cleanup.observations().some((row) => !row.completed)).toBe(true);
  await w.cleanup.run();
  expect(w.request.State).toBe('cancelled');
  expect(w.cleanup.observations().every((row) => row.completed)).toBe(true);
  await expect(w.spot.release(Date.now() + 60_000)).rejects.toThrow('released');
});

test.each([
  'requestPage',
  'instancePage',
  'requestDenied',
  'instanceDenied',
  'truncated',
  'invalidJson',
] as const)(
  '%s is never successful active evidence or native absence',
  async (fault) => {
    const w = await harness();
    w.state[fault] = true;
    await expect(
      w.spot.active(w.attempt, Date.now() + 60_000),
    ).rejects.toThrow();
    expect(w.order).not.toContain('cancel-spot-instance-requests');
    expect(w.order).not.toContain('terminate-instances');
    expect(w.records.at(-1)?.body).toMatchObject({ complete: false });
    expect(() => w.spot.assertAbsent()).toThrow('unresolved');
  },
);

test.each([
  'account',
  'region',
  'zone',
  'type',
  'request-owner',
  'instance-owner',
  'request-type',
  'duplicate-request',
] as const)('%s corruption rejects before native mutation', async (fault) => {
  const w = await harness();
  if (fault === 'account') w.state.owner = '999999999999';
  if (fault === 'region') w.original.Placement.AvailabilityZone = 'us-west-2a';
  if (fault === 'zone') w.original.Placement.AvailabilityZone = 'us-east-1b';
  if (fault === 'type') w.original.InstanceType = 't3.nano';
  if (fault === 'request-owner')
    w.request.Tags = [{ Key: 'anycloud_deployment', Value: 'another-job' }];
  if (fault === 'instance-owner')
    w.original.Tags = [{ Key: 'anycloud_owner_api', Value: 'c'.repeat(32) }];
  if (fault === 'request-type') w.request.Type = 'one-time';
  if (fault === 'duplicate-request') w.state.requests.push({ ...w.request });
  await expect(w.spot.active(w.attempt, Date.now() + 60_000)).rejects.toThrow();
  expect(w.order).not.toContain('cancel-spot-instance-requests');
  expect(w.order).not.toContain('terminate-instances');
  expect(() => w.spot.assertAbsent()).toThrow('unresolved');
});

test('lost cancellation reply retains its failed registration after exact cancelled readback', async () => {
  const w = await harness();
  await w.spot.active(w.attempt, Date.now() + 60_000);
  w.state.cancelLostReply = true;
  await expect(w.cleanup.run()).rejects.toThrow('E2E cleanup failed');
  expect(w.request.State).toBe('cancelled');
  expect(
    w.order.filter((value) => value === 'cancel-spot-instance-requests'),
  ).toHaveLength(1);
  expect(w.cleanup.observations()).toEqual([
    expect.objectContaining({ completed: true }),
    expect.objectContaining({ completed: true }),
    expect.objectContaining({
      label: expect.stringContaining('cancel persistent'),
      completed: false,
    }),
  ]);
});

test('native rescue never terminates while request cancellation is denied or unproven', async () => {
  const w = await harness();
  await w.spot.active(w.attempt, Date.now() + 60_000);
  w.state.instances.push(w.replacement);
  w.state.cancelDenied = true;
  await expect(w.cleanup.run()).rejects.toThrow('E2E cleanup failed');
  expect(w.order).not.toContain('terminate-instances');
  expect(w.replacement.State.Name).toBe('running');
  expect(w.cleanup.observations().filter((row) => !row.completed)).toHaveLength(
    2,
  );
  expect(() => w.spot.assertAbsent()).toThrow('unresolved');
});

test('a bound replacement with contradictory ownership is retained, not terminated', async () => {
  const w = await harness();
  await w.spot.active(w.attempt, Date.now() + 60_000);
  w.replacement.Tags = [{ Key: 'anycloud_owner_api', Value: 'f'.repeat(32) }];
  w.state.instances.push(w.replacement);
  await expect(w.cleanup.run()).rejects.toThrow('E2E cleanup failed');
  expect(w.order).not.toContain('terminate-instances');
  expect(() => w.spot.assertAbsent()).toThrow('unresolved');
});

test('history and artifact failures preserve both errors and the original intent', async () => {
  const w = await harness();
  await w.spot.active(w.attempt, Date.now() + 60_000);
  w.state.requestDenied = true;
  w.state.artifactFailure = true;
  let failure: unknown;
  try {
    await w.spot.request(Date.now() + 60_000);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([
    expect.objectContaining({ nativeCode: 'AccessDenied' }),
    expect.objectContaining({ message: 'artifact failed' }),
  ]);
  expect(w.cleanup.observations().some((row) => !row.completed)).toBe(true);
});

test('a later history failure cannot discard an already captured region or request', async () => {
  const w = await harness();
  await w.spot.active(w.attempt, Date.now() + 60_000);
  w.state.historyFailure = true;
  await expect(w.cleanup.run()).rejects.toThrow('E2E cleanup failed');
  expect(w.request.State).toBe('cancelled');
  expect(
    w.records.some(({ body }) =>
      JSON.stringify(body).includes(w.attempt.cloudId),
    ),
  ).toBe(true);
  expect(w.cleanup.observations().some((row) => !row.completed)).toBe(true);
});

test('an original deadline or controller failure does not widen authority', async () => {
  const w = await harness();
  await expect(w.spot.active(w.attempt, Date.now() - 1)).rejects.toThrow(
    'deadline',
  );
  const count = w.calls.length;
  w.state.controllerChanged = true;
  await expect(w.spot.active(w.attempt, Date.now() + 60_000)).rejects.toThrow(
    'controller changed',
  );
  expect(w.calls).toHaveLength(count);
  expect(() => w.spot.assertAbsent()).toThrow('unresolved');
});

test('a just-launched instance binds the request it names, which the instance-id filter still misses', async () => {
  const w = await harness();
  // For about 30 s after launch, the request does not yet name its instance.
  Object.assign(w.request, {
    InstanceId: undefined,
    Status: {
      Code: 'request-canceled-and-instance-running',
      UpdateTime: '2026-11-09T07:24:31.000Z',
    },
  });
  Object.assign(w.original, { LaunchTime: '2026-11-09T07:24:11.000Z' });
  await expect(w.spot.active(w.attempt, Date.now() + 60_000)).rejects.toThrow(
    'does not uniquely name the original VM',
  );
  await expect(
    w.spot.launched(w.attempt, Date.now() + 60_000),
  ).resolves.toEqual({
    // Bound to the instance that names it, so later reads keep its identity.
    request: expect.objectContaining({
      id: 'sir-original',
      instanceId: w.attempt.cloudId,
      statusCode: 'request-canceled-and-instance-running',
      updatedAt: Date.parse('2026-11-09T07:24:31.000Z'),
    }),
    launchedAt: Date.parse('2026-11-09T07:24:11.000Z'),
  });
  await expect(w.spot.instanceFilter(Date.now() + 60_000)).resolves.toEqual([]);
  await expect(w.spot.request(Date.now() + 60_000)).resolves.toMatchObject({
    id: 'sir-original',
  });
  // Read by ID, as the product reads it, never through a lagging filter.
  const reads = w.records
    .map(({ body }) => (body as { body?: { selection?: string[] } }).body)
    .filter((body) => body?.selection?.[0] === '--spot-instance-request-ids');
  expect(reads).toHaveLength(2);
});

test.each([
  [
    'names no request',
    { SpotInstanceRequestId: undefined },
    {},
    'request identity',
  ],
  ['has no launch time', {}, {}, 'no live launch record'],
  [
    'is in another zone than its attempt',
    { Placement: { AvailabilityZone: 'us-east-1b' } },
    {},
    'no live launch record',
  ],
  [
    'is named by a request for another VM',
    {},
    { InstanceId: 'i-fedcba98765432100' },
    'names another VM',
  ],
] as const)(
  'a launched spot instance that %s is not evidence',
  async (_case, instance, request, message) => {
    const w = await harness();
    Object.assign(
      w.original,
      {
        LaunchTime:
          _case === 'has no launch time'
            ? undefined
            : '2026-11-09T07:24:11.000Z',
      },
      instance,
    );
    Object.assign(w.request, request);
    await expect(
      w.spot.launched(w.attempt, Date.now() + 60_000),
    ).rejects.toThrow(message);
  },
);
