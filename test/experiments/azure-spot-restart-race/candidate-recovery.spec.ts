import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComputeManagementClient } from '@azure/arm-compute';
import type { NetworkManagementClient } from '@azure/arm-network';
import type { ResourceManagementClient } from '@azure/arm-resources';
import { fakeSdkClient } from '../../unit/helpers/sdk-client.js';

const clients = vi.hoisted(() => {
  let compute!: ComputeManagementClient;
  let network!: NetworkManagementClient;
  let resources!: ResourceManagementClient;
  return { compute, network, resources };
});
vi.mock('@azure/arm-compute', () => ({
  ComputeManagementClient: vi.fn().mockImplementation(function () {
    return clients.compute;
  }),
}));
vi.mock('@azure/arm-network', () => ({
  NetworkManagementClient: vi.fn().mockImplementation(function () {
    return clients.network;
  }),
}));
vi.mock('@azure/arm-resources', () => ({
  ResourceManagementClient: vi.fn().mockImplementation(function () {
    return clients.resources;
  }),
}));
vi.mock('@azure/arm-storage', () => ({ StorageManagementClient: vi.fn() }));
vi.mock('@azure/identity', () => ({ ClientSecretCredential: vi.fn() }));
vi.mock('../../../src/api/services/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ownedGroup = 'azure-restart-qualification-123456-2';
const ownedTags = { qualification: 'anycloud-azure-restart', run: '123456-2' };
type Stall = 'settle' | 'read' | 'start' | 'poll' | 'ip';
let directory: string;
let originalArgv: string[];
let originalExitCode: typeof process.exitCode;
let fixture: ReturnType<typeof providerFixture>;

function providerFixture() {
  const state = {
    candidateActive: false,
    started: false,
    digest: '',
    failureCode: 'AllocationFailed',
    stall: 'settle' as Stall,
    requests: [] as AbortSignal[],
    starts: [] as number[],
    deletions: [] as { group: string; at: number }[],
    groups: new Map<string, Record<string, string>>(),
    leaveGroup: false,
    refuseDelete: false,
    events: [] as Record<string, unknown>[],
  };
  const notFound = () =>
    Object.assign(new Error('absent'), { statusCode: 404 });
  const stalled = (signal: AbortSignal) => {
    state.requests.push(signal);
    return new Promise<never>((_resolve, reject) => {
      const abort = () => reject(new DOMException('cancelled', 'AbortError'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  };
  clients.resources = fakeSdkClient({
    resourceGroups: {
      createOrUpdate: async (
        group: string,
        data: { tags: Record<string, string> },
      ) => {
        state.groups.set(group, data.tags);
      },
      get: async (group: string) => {
        const tags = state.groups.get(group);
        if (!tags) throw notFound();
        return { name: group, tags };
      },
      beginDeleteAndWait: async (group: string) => {
        if (state.refuseDelete) throw new Error('delete denied');
        state.deletions.push({ group, at: Date.now() });
        if (!state.leaveGroup) state.groups.delete(group);
      },
    },
  });
  clients.network = fakeSdkClient({
    virtualNetworks: {
      beginCreateOrUpdateAndWait: async () => ({
        subnets: [{ id: '/subnet' }],
      }),
    },
    publicIPAddresses: {
      beginCreateOrUpdateAndWait: async () => ({ id: '/ip' }),
      get: async (
        _group: string,
        _name: string,
        options: { abortSignal: AbortSignal },
      ) => {
        if (state.stall === 'ip') await stalled(options.abortSignal);
        return { ipAddress: '192.0.2.1' };
      },
    },
    networkSecurityGroups: {
      beginCreateOrUpdateAndWait: async () => ({ id: '/nsg' }),
    },
    networkInterfaces: {
      beginCreateOrUpdateAndWait: async () => ({ id: '/nic' }),
    },
  });
  clients.compute = fakeSdkClient({
    virtualMachines: {
      beginCreateOrUpdateAndWait: async () => undefined,
      simulateEviction: async () => undefined,
      get: async (
        _group: string,
        _name: string,
        options: { abortSignal: AbortSignal },
      ) => {
        if (state.candidateActive && state.stall === 'read')
          await stalled(options.abortSignal);
        const failed = state.candidateActive && !state.started;
        return {
          location: 'eastus2',
          vmId: 'original-vm',
          storageProfile: { osDisk: { managedDisk: { id: '/original-disk' } } },
          provisioningState: failed ? 'Failed' : 'Succeeded',
          instanceView: {
            statuses: failed
              ? [{ code: `ProvisioningState/failed/${state.failureCode}` }]
              : [
                  { code: 'ProvisioningState/succeeded' },
                  {
                    code: state.started
                      ? 'PowerState/running'
                      : 'PowerState/deallocated',
                  },
                ],
          },
        };
      },
      beginStart: async (
        _group: string,
        _name: string,
        options: { abortSignal: AbortSignal },
      ) => {
        if (state.candidateActive) {
          state.starts.push(Date.now());
          if (state.stall === 'start') await stalled(options.abortSignal);
          state.started = true;
        }
        return {
          pollUntilDone: async (pollOptions: { abortSignal: AbortSignal }) => {
            if (state.candidateActive && state.stall === 'poll')
              await stalled(pollOptions.abortSignal);
          },
        };
      },
    },
    virtualMachineRunCommands: {
      beginCreateOrUpdateAndWait: async (
        _group: string,
        _name: string,
        _command: string,
        data: { source: { script: string } },
      ) => {
        const marker = data.source.script.match(
          /printf '%s' '([a-f0-9]+)'/,
        )?.[1];
        if (marker)
          state.digest = createHash('sha256').update(marker).digest('hex');
      },
      getByVirtualMachine: async () => ({
        instanceView: {
          executionState: 'Succeeded',
          exitCode: 0,
          output: state.digest,
        },
      }),
      beginDeleteAndWait: async () => undefined,
    },
  });
  return state;
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(0);
  originalArgv = process.argv;
  originalExitCode = process.exitCode;
  process.argv = ['node', 'candidate-recovery.ts'];
  process.exitCode = undefined;
  directory = await mkdtemp(join(tmpdir(), 'azure-recovery-cancellation-'));
  fixture = providerFixture();
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    if (typeof line !== 'string') return;
    const entry = JSON.parse(line) as Record<string, unknown>;
    fixture.events.push(entry);
    if (entry.event === 'before-candidate') fixture.candidateActive = true;
    if (entry.event === 'after-candidate') fixture.candidateActive = false;
  });
  for (const key of [
    'AZURE_SUBSCRIPTION_ID',
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET',
  ]) {
    vi.stubEnv(key, '00000000-0000-0000-0000-000000000001');
  }
  vi.stubEnv('GITHUB_RUN_ID', '123456');
  vi.stubEnv('GITHUB_RUN_ATTEMPT', '2');
  vi.stubEnv('ANYCLOUD_SPOT_RACE_REPETITIONS', '1');
  vi.stubEnv('ANYCLOUD_SPOT_RACE_OUTPUT', join(directory, 'trace.json'));
});

afterEach(async () => {
  // Drain the real gateway's bounded timers even when a regression assertion fails.
  await vi.runAllTimersAsync();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  await rm(directory, { recursive: true, force: true });
});

async function launch() {
  await import(
    '../../../experiments/azure-spot-restart-race/candidate-recovery.js'
  );
  await vi.advanceTimersByTimeAsync(0);
}

describe('candidate recovery', () => {
  it.each([
    'AllocationFailed',
    'OverconstrainedAllocationRequest',
    'ZonalAllocationFailed',
    'OverconstrainedZonalAllocationRequest',
  ])('qualifies recovery after %s and confirms cleanup', async (code) => {
    fixture.failureCode = code;
    await launch();
    await vi.runAllTimersAsync();
    expect(fixture.starts).toEqual([10_000]);
    expect(fixture.events).toContainEqual(
      expect.objectContaining({
        event: 'failed-allocation-recovery-qualified',
      }),
    );
    expect(fixture.events).toContainEqual(
      expect.objectContaining({
        event: 'guest-marker-confirmed',
        failedAllocationStarted: true,
      }),
    );
    expect(fixture.groups.size).toBe(0);
    expect(process.exitCode).toBeUndefined();
  });

  it('preserves the gateway deadline when Azure polling stalls', async () => {
    fixture.stall = 'poll';
    await launch();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fixture.starts).toEqual([10_000]);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0].aborted).toBe(true);
    expect(fixture.deletions).toEqual([{ group: ownedGroup, at: 300_000 }]);
    expect(fixture.groups.size).toBe(0);
    expect(process.exitCode).toBe(1);
  });
});

describe('candidate cancellation', () => {
  it.each(
    (['SIGINT', 'SIGTERM'] as const).flatMap((signal) =>
      (['settle', 'read', 'start', 'poll', 'ip'] as const).map((stall) => ({
        signal,
        stall,
      })),
    ),
  )(
    'cleans the fixture after $signal during $stall',
    async ({ signal, stall }) => {
      fixture.stall = stall;
      await launch();
      await vi.advanceTimersByTimeAsync(
        ['start', 'poll', 'ip'].includes(stall) ? 10000 : 0,
      );
      expect(fixture.candidateActive).toBe(true);
      const starts = fixture.starts.length;
      const cancelledAt = Date.now();
      process.emit(signal);
      await vi.advanceTimersByTimeAsync(6000);
      expect(fixture.starts).toHaveLength(starts);
      expect(fixture.requests).toHaveLength(stall === 'settle' ? 0 : 1);
      expect(fixture.requests.every((request) => request.aborted)).toBe(true);
      expect(fixture.groups.size).toBe(0);
      expect(fixture.deletions).toEqual([
        { group: ownedGroup, at: cancelledAt },
      ]);
      expect(process.exitCode).toBe(1);
    },
  );

  it('retains the allocated fixture identity before cancellation can kill the process', async () => {
    await launch();
    const trace = JSON.parse(
      await readFile(join(directory, 'trace.json'), 'utf8'),
    );
    expect(trace).toContainEqual(
      expect.objectContaining({
        event: 'qualification-start',
        group: ownedGroup,
      }),
    );
    process.emit('SIGINT');
    await vi.advanceTimersByTimeAsync(6000);
    expect(fixture.groups.size).toBe(0);
  });
});

describe('independent workflow cleanup', () => {
  beforeEach(() => {
    process.argv.push('--cleanup');
    fixture.groups.set(ownedGroup, ownedTags);
    fixture.groups.set('azure-restart-qualification-123456-1', {
      ...ownedTags,
      run: '123456-1',
    });
    fixture.groups.set('anycloud-eastus', { qualification: 'production' });
  });

  it('deletes only this run and attempt without replaying the experiment', async () => {
    await launch();
    expect(fixture.deletions).toEqual([{ group: ownedGroup, at: 0 }]);
    expect([...fixture.groups.keys()]).toEqual([
      'azure-restart-qualification-123456-1',
      'anycloud-eastus',
    ]);
    expect(
      fixture.events.some((entry) => entry.event === 'qualification-start'),
    ).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('confirms a group already removed by the probe without another delete', async () => {
    fixture.groups.delete(ownedGroup);
    await launch();
    expect(fixture.deletions).toEqual([]);
    expect(fixture.events).toContainEqual(
      expect.objectContaining({
        event: 'cleanup-confirmed',
        group: ownedGroup,
      }),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it.each(['run', 'qualification'] as const)(
    'refuses a group with a different %s owner tag',
    async (tag) => {
      fixture.groups.set(ownedGroup, { ...ownedTags, [tag]: 'other-owner' });
      await launch();
      expect(fixture.deletions).toEqual([]);
      expect(fixture.groups.has(ownedGroup)).toBe(true);
      expect(process.exitCode).toBe(1);
    },
  );

  it.each(['leaveGroup', 'refuseDelete'] as const)(
    'fails cleanup when Azure reports $0',
    async (failure) => {
      fixture[failure] = true;
      await launch();
      expect(fixture.groups.has(ownedGroup)).toBe(true);
      expect(
        fixture.events.some((entry) => entry.event === 'cleanup-confirmed'),
      ).toBe(false);
      expect(process.exitCode).toBe(1);
    },
  );

  it('refuses cleanup without an exact workflow attempt', async () => {
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '');
    await launch();
    expect(fixture.deletions).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('can clean up after invalid probe configuration', async () => {
    vi.stubEnv('ANYCLOUD_SPOT_RACE_REPETITIONS', 'invalid');
    await launch();
    expect(fixture.deletions).toEqual([{ group: ownedGroup, at: 0 }]);
    expect(process.exitCode).toBeUndefined();
  });
});
