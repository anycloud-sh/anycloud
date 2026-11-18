import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  JOB_NATIVE_CREDENTIALS,
  jobNativeSessionFixture,
} from '../helpers/e2e-job-native.js';
import {
  JobRecoveryTransport,
  SYNCHRONOUS_HOST_DELETE_MS,
} from '../integration/e2e/internal/transports/job-recovery.js';
import type { JobNativeAttempt } from '../integration/e2e/internal/targets/job-types.js';
import { trackedWorkloadRefForTest } from './helpers/e2e.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const regions = { aws: 'us-east-1', gcp: 'us-central1', azure: 'eastus' };
const vmTypes = {
  aws: 't3.large',
  gcp: 'e2-standard-2',
  azure: 'Standard_D2s_v5',
};

function fixture(
  provider: 'aws' | 'gcp' | 'azure',
  region = regions[provider],
) {
  const ref = trackedWorkloadRefForTest('native-recovery-job');
  const credential = JOB_NATIVE_CREDENTIALS[provider];
  const attempt: JobNativeAttempt = {
    ref,
    cloudProvider: credential.cloudProvider,
    rowId: 1,
    createdAt: 10,
    endedAt: null,
    cloudId: provider === 'aws' ? 'i-0123456789abcdef0' : 'original-vm',
    region,
    availabilityZone:
      provider === 'aws' ? '1a' : provider === 'gcp' ? 'a' : '1',
    credentialId: 'a'.repeat(64),
    ip: '192.0.2.10',
    vmType: vmTypes[provider],
  };
  const azureId = `/subscriptions/${JOB_NATIVE_CREDENTIALS.azure.subscriptionId}/resourceGroups/anycloud-eastus/providers/Microsoft.Compute/virtualMachines/original-vm`;
  const gcpZone = `https://www.googleapis.com/compute/v1/projects/${JOB_NATIVE_CREDENTIALS.gcp.projectId}/zones/${region}-a`;
  const vm = {
    aws: {
      InstanceId: attempt.cloudId,
      InstanceType: attempt.vmType,
      State: { Name: 'running' },
      Placement: { AvailabilityZone: 'us-east-1a' },
      RootDeviceName: '/dev/sda1',
      BlockDeviceMappings: [
        { DeviceName: '/dev/sda1', Ebs: { VolumeId: 'vol-0123456789abcdef0' } },
      ],
    },
    gcp: {
      name: attempt.cloudId,
      selfLink: `${gcpZone}/instances/${attempt.cloudId}`,
      zone: gcpZone,
      id: '12345678901234',
      status: 'RUNNING',
      machineType: `${gcpZone}/machineTypes/${attempt.vmType}`,
      disks: [{ boot: true, source: `${gcpZone}/disks/original-disk` }],
    },
    azure: {
      name: attempt.cloudId,
      id: azureId,
      vmId: '44444444-4444-4444-4444-444444444444',
      location: 'eastus',
      hardwareProfile: { vmSize: attempt.vmType },
      storageProfile: {
        osDisk: {
          managedDisk: {
            id: azureId.replace(
              '/virtualMachines/original-vm',
              '/disks/original-disk',
            ),
          },
        },
      },
    },
  };
  const state = {
    owner: '123456789012',
    pagination: false,
    foreignStop: false,
    foreignDisk: false,
    evictDenied: false,
    fallback: false,
    foreignDelete: false,
    deleteDenied: false,
  };
  const gcpDisk: Record<string, unknown> = {
    type: `${gcpZone}/diskTypes/hyperdisk-balanced`,
    sizeGb: '100',
    provisionedIops: 8000,
    provisionedThroughput: '1000',
  };
  const world = jobNativeSessionFixture(credential, (exe, args) => {
    if (exe === 'aws' && args[1] === 'describe-instances')
      return JSON.stringify({
        Reservations: [{ OwnerId: state.owner, Instances: [vm.aws] }],
        ...(state.pagination ? { NextToken: 'more' } : {}),
      });
    if (exe === 'aws' && args[1] === 'stop-instances')
      return JSON.stringify({
        StoppingInstances: [
          {
            InstanceId: state.foreignStop
              ? 'i-fffffffffffffffff'
              : attempt.cloudId,
            CurrentState: { Name: 'stopping' },
          },
        ],
      });
    if (exe === 'aws' && args[1] === 'terminate-instances')
      return state.deleteDenied
        ? { exitCode: 1, stderr: 'An error occurred (UnauthorizedOperation)' }
        : JSON.stringify({
            TerminatingInstances: [
              {
                InstanceId: state.foreignDelete
                  ? 'i-fffffffffffffffff'
                  : attempt.cloudId,
                CurrentState: { Name: 'shutting-down' },
              },
            ],
          });
    if (exe === 'gcloud' && args[1] === 'instances' && args[2] === 'describe')
      return JSON.stringify(vm.gcp);
    if (exe === 'gcloud' && args[1] === 'disks')
      return JSON.stringify({
        ...gcpDisk,
        selfLink: state.foreignDisk
          ? `${gcpZone}/disks/foreign`
          : `${gcpZone}/disks/original-disk`,
        zone: gcpZone,
        id: '987654321',
      });
    if (exe === 'gcloud' && args[2] === 'stop')
      return JSON.stringify([
        {
          operationType: 'stop',
          targetLink: state.foreignStop
            ? `${gcpZone}/instances/foreign`
            : vm.gcp.selfLink,
        },
      ]);
    if (exe === 'gcloud' && args[2] === 'delete')
      return state.deleteDenied
        ? { exitCode: 1, stderr: 'PERMISSION_DENIED' }
        : args.includes('--async')
          ? // gcloud exits 2 on a flag `instances delete` does not have.
            { exitCode: 2, stderr: 'ERROR: unrecognized arguments: --async' }
          : '';
    if (exe === 'az' && args[1] === 'show') return JSON.stringify(vm.azure);
    if (exe === 'az' && args[1] === 'delete')
      return state.deleteDenied
        ? { exitCode: 1, stderr: 'ERROR: (AuthorizationFailed) denied' }
        : '';
    if (exe === 'az' && args[1] === 'simulate-eviction')
      return state.evictDenied
        ? { exitCode: 1, stderr: 'ERROR: (AuthorizationFailed) denied' }
        : '';
    if (exe === 'az' && args[1] === 'stop') {
      state.fallback = true;
      return '';
    }
    if (exe === 'az' && args[1] === 'get-instance-view')
      return JSON.stringify({
        id: state.foreignStop ? `${azureId}-foreign` : azureId,
        instanceView: { statuses: [{ code: 'PowerState/stopped' }] },
      });
    throw new Error('unexpected recovery command');
  });
  const artifacts: unknown[] = [];
  const transport = new JobRecoveryTransport(world.session, {
    json: async (_name, body) => {
      artifacts.push(body);
      return '';
    },
  });
  return { ...world, attempt, state, vm, gcpDisk, transport, artifacts };
}

describe('Job exact native recovery protocol', () => {
  test('reads disk-tier performance from the exact original VM and boot disk', async () => {
    const w = fixture('gcp');
    await expect(
      w.transport.diskTier(w.attempt, Date.now() + 60_000),
    ).resolves.toEqual({
      ref: w.attempt.ref,
      rowId: w.attempt.rowId,
      identity: {
        cloudId: w.attempt.cloudId,
        vmId: '12345678901234',
        osDiskId: '987654321',
        region: 'us-central1',
        zone: 'us-central1-a',
        vmType: 'e2-standard-2',
      },
      diskType: 'hyperdisk-balanced',
      sizeGb: 100,
      provisionedIops: 8000,
      provisionedThroughput: 1000,
    });
  });

  test.each([
    [
      'type',
      'https://www.googleapis.com/compute/v1/projects/foreign/zones/us-central1-a/diskTypes/pd-ssd',
    ],
    ['sizeGb', '100.0'],
    ['sizeGb', 0],
    ['provisionedIops', 'NaN'],
    ['provisionedThroughput', '1000junk'],
    ['provisionedIops', '9007199254740992'],
  ])('rejects ambiguous disk-tier native %s values', async (key, value) => {
    const w = fixture('gcp');
    w.gcpDisk[String(key)] = value;
    await expect(
      w.transport.diskTier(w.attempt, Date.now() + 60_000),
    ).rejects.toThrow();
  });

  test('disk-tier cannot adopt a foreign boot disk or an ended attempt', async () => {
    const w = fixture('gcp');
    w.state.foreignDisk = true;
    await expect(
      w.transport.diskTier(w.attempt, Date.now() + 60_000),
    ).rejects.toThrow('identity is missing or foreign');
    await expect(
      w.transport.diskTier({ ...w.attempt, endedAt: 10 }, Date.now() + 60_000),
    ).rejects.toThrow('live original provider attempt');
  });
  test.each(['aws', 'gcp', 'azure'] as const)(
    'deletes only the rechecked original %s host with original authorization and placement',
    async (provider) => {
      const w = fixture(provider);
      const identity = await w.transport.identity(
        w.attempt,
        Date.now() + 5_000,
      );
      await w.transport.deleteHost(w.attempt, identity);
      const deletion = w.calls.find(
        ({ args }) =>
          args.includes('terminate-instances') || args.includes('delete'),
      );
      expect(deletion?.args).toContain(w.attempt.cloudId);
      if (provider === 'aws')
        expect(deletion?.args).toContain(w.attempt.region);
      if (provider === 'gcp') {
        expect(deletion?.args).toContain('--zone=us-central1-a');
        expect(deletion?.args).toContain('--quiet');
      }
      if (provider === 'azure')
        expect(deletion?.args).toEqual(
          expect.arrayContaining([
            'anycloud-eastus',
            '--force-deletion',
            'true',
          ]),
        );
      // AWS acknowledges termination at once; GCE and Azure deletes return
      // only when the host is gone, well past the 30 s read budget.
      const budget = deletion?.options?.timeoutMs ?? 0;
      if (provider === 'aws') {
        expect(budget).toBeLessThanOrEqual(30_000);
      } else {
        expect(budget).toBeGreaterThan(30_000);
        expect(budget).toBeLessThanOrEqual(SYNCHRONOUS_HOST_DELETE_MS);
        expect(SYNCHRONOUS_HOST_DELETE_MS).toBeGreaterThanOrEqual(180_000);
      }
      // Reads and asynchronous acknowledgements keep the default.
      for (const call of w.calls.filter((entry) => entry !== deletion)) {
        expect(call.options?.timeoutMs ?? 0).toBeLessThanOrEqual(30_000);
      }
      expect(w.artifacts.at(-1)).toMatchObject({
        kind: 'host-delete',
        identity,
        workloadId: w.attempt.ref.id,
        rowId: 1,
        credentialId: w.attempt.credentialId,
      });
    },
  );

  test.each(['aws', 'gcp', 'azure'] as const)(
    'does not delete a changed %s native identity or acknowledge denied deletion',
    async (provider) => {
      const w = fixture(provider);
      const identity = await w.transport.identity(
        w.attempt,
        Date.now() + 5_000,
      );
      await expect(
        w.transport.deleteHost(w.attempt, { ...identity, osDiskId: 'changed' }),
      ).rejects.toThrow('original native VM and disk');
      expect(
        w.calls.some(
          ({ args }) =>
            args.includes('terminate-instances') || args.includes('delete'),
        ),
      ).toBe(false);
      w.state.deleteDenied = true;
      await expect(
        w.transport.deleteHost(w.attempt, identity),
      ).rejects.toThrow();
      expect(
        w.artifacts.some(
          (value) => (value as { kind?: string }).kind === 'host-delete',
        ),
      ).toBe(false);
    },
  );

  test.each(['aws'] as const)(
    'rejects foreign %s deletion acknowledgements',
    async (provider) => {
      const w = fixture(provider);
      const identity = await w.transport.identity(
        w.attempt,
        Date.now() + 5_000,
      );
      w.state.foreignDelete = true;
      await expect(w.transport.deleteHost(w.attempt, identity)).rejects.toThrow(
        'incomplete or foreign',
      );
      expect(
        w.artifacts.some(
          (value) => (value as { kind?: string }).kind === 'host-delete',
        ),
      ).toBe(false);
    },
  );

  test.each(['europe-west10', 'europe-west12'])(
    'retains the full original %s zone through native identity and stop readback',
    async (region) => {
      const w = fixture('gcp', region);
      const before = await w.transport.identity(w.attempt, Date.now() + 5_000);
      expect(before).toMatchObject({
        region,
        zone: `${region}-a`,
        vmId: '12345678901234',
        osDiskId: '987654321',
      });
      await w.transport.stop(w.attempt, before);
      const nativeCalls = w.calls.filter(({ args }) => args[0] === 'compute');
      expect(nativeCalls.length).toBeGreaterThanOrEqual(5);
      expect(
        nativeCalls.every(({ args }) => args.includes(`--zone=${region}-a`)),
      ).toBe(true);
      expect(w.artifacts.at(-1)).toMatchObject({
        kind: 'in-place-stop',
        identity: before,
      });
    },
  );

  test.each([
    'europe-west0',
    'europe-west01',
    'europe-west10/a',
    'europe-west10-a',
  ])(
    'rejects malformed original region %s before VM or disk access',
    async (region) => {
      const w = fixture('gcp', region);
      await expect(
        w.transport.identity(w.attempt, Date.now() + 5_000),
      ).rejects.toThrow('exact original zone');
      expect(w.calls.filter(({ args }) => args[0] === 'compute')).toEqual([]);
    },
  );

  test.each(['aws', 'gcp', 'azure'] as const)(
    'captures and rechecks the original %s VM and boot disk before the stop',
    async (provider) => {
      const w = fixture(provider);
      vi.spyOn(w.session, 'pause').mockResolvedValue();
      const before = await w.transport.identity(w.attempt, Date.now() + 5_000);
      expect(before).toMatchObject({
        cloudId: w.attempt.cloudId,
        region: w.attempt.region,
        vmType: w.attempt.vmType,
      });
      expect(before.vmId).not.toBe('');
      expect(before.osDiskId).not.toBe('');
      await w.transport.stop(w.attempt, before);
      expect(w.artifacts.at(-1)).toMatchObject({
        workloadId: w.attempt.ref.id,
        credentialId: w.attempt.credentialId,
        rowId: 1,
        kind: 'in-place-stop',
        identity: before,
      });
      const stopIndex = w.calls.findIndex(
        (call) =>
          call.args.includes('stop-instances') ||
          call.args.includes('stop') ||
          call.args.includes('simulate-eviction'),
      );
      expect(stopIndex).toBeGreaterThan(1);
      expect(
        w.calls.filter(
          (call) =>
            call.args.includes('describe-instances') ||
            call.args.includes('show') ||
            (call.args.includes('instances') && call.args.includes('describe')),
        ).length,
      ).toBeGreaterThanOrEqual(2);
    },
  );

  test.each(['aws', 'gcp', 'azure'] as const)(
    'refuses a %s stop after the original boot disk changed',
    async (provider) => {
      const w = fixture(provider);
      const before = await w.transport.identity(w.attempt, Date.now() + 5_000);
      await expect(
        w.transport.stop(w.attempt, { ...before, osDiskId: 'different-disk' }),
      ).rejects.toThrow('original native VM and disk');
      expect(
        w.calls.some(
          (call) =>
            call.args.includes('stop') ||
            call.args.includes('stop-instances') ||
            call.args.includes('simulate-eviction'),
        ),
      ).toBe(false);
    },
  );

  test.each(['aws', 'gcp', 'azure'] as const)(
    'rejects an incomplete or foreign %s stop acknowledgement',
    async (provider) => {
      const w = fixture(provider);
      vi.spyOn(w.session, 'pause').mockResolvedValue();
      const before = await w.transport.identity(w.attempt, Date.now() + 5_000);
      w.state.foreignStop = true;
      await expect(w.transport.stop(w.attempt, before)).rejects.toThrow();
      expect(w.artifacts).not.toContainEqual(
        expect.objectContaining({ kind: 'in-place-stop' }),
      );
    },
  );

  test.each(['owner', 'pagination', 'zone', 'duplicate-disk'] as const)(
    'rejects AWS %s ambiguity before a fault can run',
    async (failure) => {
      const w = fixture('aws');
      if (failure === 'owner') w.state.owner = '999999999999';
      if (failure === 'pagination') w.state.pagination = true;
      if (failure === 'zone')
        w.vm.aws.Placement.AvailabilityZone = 'us-east-1b';
      if (failure === 'duplicate-disk')
        w.vm.aws.BlockDeviceMappings.push(w.vm.aws.BlockDeviceMappings[0]);
      await expect(
        w.transport.identity(w.attempt, Date.now() + 5_000),
      ).rejects.toThrow();
      expect(w.artifacts).toHaveLength(0);
    },
  );

  test.each(['project', 'zone', 'duplicate-disk', 'disk-readback'] as const)(
    'rejects GCP %s ambiguity',
    async (failure) => {
      const w = fixture('gcp');
      if (failure === 'project')
        w.vm.gcp.selfLink = w.vm.gcp.selfLink.replace(
          'original-project',
          'foreign-project',
        );
      if (failure === 'zone')
        w.vm.gcp.zone = w.vm.gcp.zone.replace('central1-a', 'central1-b');
      if (failure === 'duplicate-disk') w.vm.gcp.disks.push(w.vm.gcp.disks[0]);
      if (failure === 'disk-readback') w.state.foreignDisk = true;
      await expect(
        w.transport.identity(w.attempt, Date.now() + 5_000),
      ).rejects.toThrow();
      expect(w.artifacts).toHaveLength(0);
    },
  );

  test('retains Azure authorization failure without treating it as eviction propagation', async () => {
    const w = fixture('azure');
    const before = await w.transport.identity(w.attempt, Date.now() + 5_000);
    w.state.evictDenied = true;
    const pause = vi.spyOn(w.session, 'pause').mockResolvedValue();
    await expect(w.transport.stop(w.attempt, before)).rejects.toThrow(
      'AuthorizationFailed',
    );
    expect(pause).not.toHaveBeenCalled();
    expect(w.state.fallback).toBe(false);
  });

  test('rejects Azure disk ownership outside the original resource group', async () => {
    const w = fixture('azure');
    w.vm.azure.storageProfile.osDisk.managedDisk.id =
      w.vm.azure.storageProfile.osDisk.managedDisk.id.replace(
        'anycloud-eastus',
        'foreign-group',
      );
    await expect(
      w.transport.identity(w.attempt, Date.now() + 5_000),
    ).rejects.toThrow('outside its original resource group');
    expect(w.artifacts).toHaveLength(0);
  });
});
