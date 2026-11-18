import { describe, expect, test, vi } from 'vitest';

import { CloudType } from '../../src/shared/cloud.js';
import { JobAttemptLedger } from '../integration/e2e/internal/job-attempt-ledger.js';
import {
  JobNativeCleanup,
  hasJobNativeCoordinates,
  type JobNativeReader,
} from '../integration/e2e/internal/job-native-cleanup.js';
import type { JobNativeAttempt } from '../integration/e2e/internal/targets/job-types.js';
import {
  PublicCloudVmHostPresenceProbe,
  type VmHostPresenceObservation,
  type VmReservationPresenceObservation,
} from '../integration/e2e/internal/transports/public-cloud-vm-host-presence.js';
import { Waiter } from '../integration/e2e/internal/wait.js';
import {
  commandResultForTest,
  trackedWorkloadRefForTest,
} from './helpers/e2e.js';

const ref = trackedWorkloadRefForTest('job-tracked-native');
const identity = {
  provider: CloudType.AWS as const,
  credentialId: 'credential-original',
  controller: { url: 'http://job-controller.invalid', generation: 1 },
};
function attempt(overrides: Partial<JobNativeAttempt> = {}): JobNativeAttempt {
  return Object.freeze({
    ref,
    rowId: 1,
    createdAt: 100,
    endedAt: 200,
    cloudId: 'i-0123456789abcdef0',
    ip: '192.0.2.1',
    cloudProvider: CloudType.AWS,
    credentialId: identity.credentialId,
    region: 'us-east-1',
    availabilityZone: 'a',
    vmType: 't3.large',
    ...overrides,
  });
}
function harness(
  initial: readonly JobNativeAttempt[] = [attempt()],
  options: {
    readonly provider?: JobNativeAttempt['cloudProvider'];
    readonly reservations?: JobNativeReader['reservations'];
    readonly sleep?: (milliseconds: number) => Promise<void>;
  } = {},
) {
  const originalIdentity = {
    ...identity,
    provider: options.provider ?? identity.provider,
    credentialId:
      options.provider === CloudType.Local ? null : identity.credentialId,
  };
  let rows = initial;
  let active = true;
  const artifacts: unknown[] = [];
  const reads: JobNativeAttempt[] = [];
  let native: (
    row: JobNativeAttempt,
  ) => Promise<VmHostPresenceObservation> = async (row) => ({
    cloudId: row.cloudId,
    provider: row.cloudProvider,
    presence: 'absent',
    diagnostic: 'exact native absence',
  });
  const kernel = {
    assertActive: (candidate: typeof ref) => {
      if (!active || candidate !== ref)
        throw new Error('Reference is forged or inactive');
    },
  };
  const ledger = new JobAttemptLedger({
    api: { controller: identity.controller },
    kernel,
    database: {
      queryComplete: async () =>
        rows.map((row) => ({
          id: row.rowId,
          workload_id: row.ref.id,
          created_at: row.createdAt,
          ended_at: row.endedAt,
          cloud_id: row.cloudId,
          ip: row.ip,
          cloud_provider: row.cloudProvider,
          credential_id: row.credentialId,
          region: row.region,
          availability_zone: row.availabilityZone,
          vm_type: row.vmType,
        })),
    },
  });
  vi.spyOn(ledger, 'read');
  const writeArtifact = vi.fn(async (_name: string, value: unknown) => {
    artifacts.push(value);
    return '';
  });
  const owner = new JobNativeCleanup({
    kernel,
    ledger,
    wait: new Waiter(new AbortController().signal, options.sleep),
    artifacts: { json: writeArtifact },
  });
  owner.register(ref, originalIdentity, {
    reservations: options.reservations,
    observe: async (row) => {
      reads.push(row);
      return native(row);
    },
  });
  return {
    owner,
    ledger,
    reads,
    artifacts,
    writeArtifact,
    setRows(value: readonly JobNativeAttempt[]) {
      rows = value;
    },
    setNative(value: typeof native) {
      native = value;
    },
    release() {
      active = false;
    },
  };
}

function reservationReader() {
  const provider = CloudType.AWS;
  const nativeId = 'i-11111111111111111';
  const receipt = (
    attempts: readonly JobNativeAttempt[],
    instanceIds: readonly string[] = [],
    complete = true,
  ): VmReservationPresenceObservation => ({
    kind: 'exact-attempt-current-presence',
    observedAt: Date.now(),
    provider,
    credentialName: 'original-compute',
    diagnostic: 'controlled exact reservation inventory',
    inventory: {
      pages: attempts.length,
      instances: instanceIds.length,
      complete,
    },
    attempts: attempts.map((original, index) => ({
      attemptId: original.cloudId,
      region: original.region,
      availabilityZone: original.availabilityZone,
      instanceIds: index === 0 ? instanceIds : [],
      presence:
        index === 0 && instanceIds.length > 0
          ? 'present'
          : complete
            ? 'absent'
            : 'unknown',
    })),
  });
  const reader = {
    credentialName: 'original-compute',
    observe: vi.fn<NonNullable<JobNativeReader['reservations']>['observe']>(
      async (attempts) => receipt(attempts),
    ),
    observeMatch: vi.fn<
      NonNullable<JobNativeReader['reservations']>['observeMatch']
    >(async (location) => ({
      provider,
      cloudId: location.cloudId,
      presence: 'absent',
      diagnostic: 'exact independent native absence',
    })),
  } satisfies NonNullable<JobNativeReader['reservations']>;
  return { reader, receipt, nativeId };
}

test('Azure cleanup waits until the OS disk of a VM restarted in place, then deleted out of band, is gone', async () => {
  const vm = {
    cloudProvider: CloudType.Azure as const,
    cloudId: 'ac-azure-host',
    region: 'eastus',
    availabilityZone: null,
    vmType: 'Standard_D2s_v5',
  };
  // A spot eviction restarts the same VM in place on a new row; the disk
  // survives it, so cleanup reads the VM, then its disk, once per poll.
  const w = harness(
    [attempt(vm), attempt({ ...vm, rowId: 2, createdAt: 300, endedAt: 400 })],
    { provider: CloudType.Azure },
  );
  // The fault's `az vm delete` leaves the disk until Azure finishes deleting it.
  let disks = [
    {
      id: '/subscriptions/sub/resourceGroups/anycloud-eastus/providers/Microsoft.Compute/disks/ac-azure-host_OsDisk_1_0123abcd',
      name: 'ac-azure-host_OsDisk_1_0123abcd',
    },
  ];
  const probe = new PublicCloudVmHostPresenceProbe(
    {
      slug: 'azure',
      provider: CloudType.Azure,
      credentialName: 'azure-test',
      credential: {
        cloudProvider: CloudType.Azure,
        subscriptionId: 'sub',
        directoryId: 'dir',
        applicationId: 'app',
        secret: 'secret',
      },
      vmTypes: ['Standard_D2s_v5'],
    },
    {
      run: async (executable, args) => {
        const stderr =
          args[1] === 'show'
            ? "(ResourceNotFound) The Resource 'Microsoft.Compute/virtualMachines/ac-azure-host' under resource group 'anycloud-eastus' was not found."
            : '';
        const stdout = args[1] === 'list' ? JSON.stringify(disks) : '';
        if (args[1] === 'list') disks = [];
        return commandResultForTest({
          executable,
          args,
          exitCode: stderr ? 1 : 0,
          stdout,
          stderr,
          combined: stdout + stderr,
        });
      },
    },
    { directory: async (name) => name, privateText: async (name) => name },
    { get: vi.fn() },
  );
  w.setNative((row) => probe.observe(row, { bootDiskOwner: ref.id }));
  await w.owner.verify(ref, 10_000);
  expect(w.artifacts.at(-1)).toMatchObject({
    completed: true,
    observations: [
      { presence: 'present', diagnostic: expect.stringContaining('OsDisk') },
      { presence: 'absent', diagnostic: 'boot disk absent' },
    ],
  });
});

describe('Job reservation cleanup using the shared inventory contract', () => {
  const corruptions: ReadonlyArray<
    readonly [
      string,
      (
        value: VmReservationPresenceObservation,
      ) => VmReservationPresenceObservation,
    ]
  > = [
    ['foreign provider', (value) => ({ ...value, provider: CloudType.GCP })],
    [
      'foreign credential',
      (value) => ({ ...value, credentialName: 'replacement' }),
    ],
    ['missing attempt', (value) => ({ ...value, attempts: [] })],
    [
      'repeated attempt',
      (value) => ({
        ...value,
        attempts: [...value.attempts, ...value.attempts],
      }),
    ],
    [
      'foreign token',
      (value) => ({
        ...value,
        attempts: [{ ...value.attempts[0], attemptId: 'foreign-0' }],
      }),
    ],
    [
      'foreign region',
      (value) => ({
        ...value,
        attempts: [{ ...value.attempts[0], region: 'us-west-2' }],
      }),
    ],
    [
      'foreign zone',
      (value) => ({
        ...value,
        attempts: [{ ...value.attempts[0], availabilityZone: 'b' }],
      }),
    ],
    [
      'malformed native ID',
      (value) => ({
        ...value,
        attempts: [{ ...value.attempts[0], instanceIds: ['not-native'] }],
      }),
    ],
    [
      'repeated native ID',
      (value) => ({
        ...value,
        attempts: [
          {
            ...value.attempts[0],
            instanceIds: [
              ...value.attempts[0].instanceIds,
              ...value.attempts[0].instanceIds,
            ],
          },
        ],
      }),
    ],
    [
      'absence with a match',
      (value) => ({
        ...value,
        attempts: [{ ...value.attempts[0], presence: 'absent' }],
      }),
    ],
    ['missing inventory', (value) => ({ ...value, inventory: null })],
    [
      'wrong match count',
      (value) => ({
        ...value,
        inventory: { ...value.inventory!, instances: 2 },
      }),
    ],
    [
      'zero pages',
      (value) => ({ ...value, inventory: { ...value.inventory!, pages: 0 } }),
    ],
    ['early receipt', (value) => ({ ...value, observedAt: 1 })],
    [
      'future receipt',
      (value) => ({ ...value, observedAt: Date.now() + 60_000 }),
    ],
    [
      'incomplete absence',
      (value) => ({
        ...value,
        inventory: { pages: 1, instances: 0, complete: false },
        attempts: [
          { ...value.attempts[0], instanceIds: [], presence: 'absent' },
        ],
      }),
    ],
  ];
  test.each(corruptions)('rejects a %s receipt', async (_label, corrupt) => {
    const probe = reservationReader();
    const world = harness([attempt({ cloudId: `${ref.id}-0`, ip: null })], {
      reservations: probe.reader,
    });
    probe.reader.observe.mockImplementation(async (attempts) =>
      corrupt(probe.receipt(attempts, [probe.nativeId])),
    );
    await expect(world.owner.verify(ref, 1_000)).rejects.toThrow(
      'original scope or inventory',
    );
    expect(probe.reader.observeMatch).not.toHaveBeenCalled();
    expect(world.artifacts[0]).toMatchObject({
      completed: false,
      reservationObservations: [],
      reservationMatches: [],
    });
  });

  test.each([true, false])(
    'an empty inventory with complete=%s still needs stable absence',
    async (complete) => {
      const probe = reservationReader();
      const world = harness([attempt({ cloudId: `${ref.id}-0`, ip: null })], {
        reservations: probe.reader,
      });
      probe.reader.observe.mockImplementation(async (attempts) => {
        const value = probe.receipt(attempts, [], complete);
        return {
          ...value,
          attempts: value.attempts.map((row) => ({
            ...row,
            presence: 'unknown',
          })),
        };
      });
      await expect(world.owner.verify(ref, 1_000)).rejects.toThrow(
        'reservation inventory is not absent',
      );
      expect(world.artifacts[0]).toMatchObject({ completed: false });
    },
  );

  test('an incomplete inventory cannot pass even when every known matched host is absent', async () => {
    const probe = reservationReader();
    const world = harness([attempt({ cloudId: `${ref.id}-0`, ip: null })], {
      reservations: probe.reader,
    });
    probe.reader.observe.mockImplementation(async (attempts) =>
      probe.receipt(attempts, [probe.nativeId], false),
    );
    await expect(world.owner.verify(ref, 1_000)).rejects.toThrow(
      'reservation inventory is not absent',
    );
    expect(probe.reader.observeMatch).toHaveBeenCalledOnce();
    expect(world.artifacts[0]).toMatchObject({ completed: false });
  });

  test('a deadline that passes inside a poll still reports the last unmet condition', async () => {
    const probe = reservationReader();
    // No pause between polls, so the second poll starts before the deadline.
    const world = harness([attempt({ cloudId: `${ref.id}-0`, ip: null })], {
      reservations: probe.reader,
      sleep: async () => {},
    });
    probe.reader.observe
      .mockImplementationOnce(async (attempts) =>
        probe.receipt(attempts, [], false),
      )
      .mockImplementationOnce(async (attempts, deadline) => {
        const receipt = probe.receipt(attempts, [], false);
        // Block the event loop past the deadline: the poll sees it before
        // the wait's own deadline timer can fire.
        while (Date.now() <= deadline);
        return receipt;
      });
    await expect(world.owner.verify(ref, 200)).rejects.toThrow(
      'last observation: original reservation inventory is not absent',
    );
    expect(probe.reader.observe).toHaveBeenCalledTimes(2);
  });

  test.each(['foreign-0', `${ref.id}-00`, `${ref.id}-9007199254740992`])(
    'does not send non-owning or noncanonical reservation %s',
    async (cloudId) => {
      const probe = reservationReader();
      const world = harness([attempt({ cloudId, ip: null })], {
        reservations: probe.reader,
      });
      await expect(world.owner.verify(ref, 1_000)).rejects.toThrow(
        'unresolved native provisioning identity',
      );
      expect(probe.reader.observe).not.toHaveBeenCalled();
      expect(world.artifacts[0]).toMatchObject({ completed: false });
    },
  );

  test('retains every original reservation and independently checks all matches after adoption', async () => {
    const probe = reservationReader();
    const world = harness([], { reservations: probe.reader });
    await world.owner.creationStarted(ref);
    const reserved = attempt({ cloudId: `${ref.id}-0`, ip: null });
    world.setRows([reserved]);
    await world.owner.capture(ref);
    const retargeted = { ...reserved, cloudId: `${ref.id}-1` };
    world.setRows([retargeted]);
    await world.owner.capture(ref);
    const adopted = {
      ...reserved,
      cloudId: 'i-22222222222222222',
      ip: '192.0.2.2',
      createdAt: 150,
    };
    world.setRows([adopted]);
    probe.reader.observe.mockImplementation(async (attempts) =>
      probe.receipt(attempts, [probe.nativeId]),
    );
    await world.owner.verify(ref, 1_000);
    expect(probe.reader.observe.mock.calls[0][0]).toEqual([
      reserved,
      retargeted,
    ]);
    expect(world.reads).toEqual([adopted]);
    expect(probe.reader.observeMatch).toHaveBeenCalledWith(
      {
        cloudId: probe.nativeId,
        region: reserved.region,
        availabilityZone: reserved.availabilityZone,
      },
      expect.any(Number),
      expect.any(Number),
    );
    expect(world.artifacts[0]).toMatchObject({
      completed: true,
      creations: [{ resolvedRowIds: [1] }],
      attemptHistory: [reserved, retargeted, adopted],
      reservationMatches: [
        { reservation: reserved, location: { cloudId: probe.nativeId } },
      ],
    });
  });

  test.each(['authentication', 'schema', 'cancellation'])(
    'retains validated partial matches when a later %s failure aborts the read',
    async (failureKind) => {
      const probe = reservationReader();
      const reserved = attempt({ cloudId: `${ref.id}-0`, ip: null });
      const world = harness([reserved], { reservations: probe.reader });
      const failure = new Error(`later reservation ${failureKind} failure`);
      probe.reader.observe.mockImplementation(
        async (attempts, _deadline, retain) => {
          retain(probe.receipt(attempts, [probe.nativeId], false));
          throw failure;
        },
      );
      await expect(world.owner.verify(ref, 1_000)).rejects.toBe(failure);
      expect(probe.reader.observeMatch).not.toHaveBeenCalled();
      expect(world.artifacts[0]).toMatchObject({
        completed: false,
        reservationObservations: [{ inventory: { complete: false } }],
        reservationMatches: [
          { reservation: reserved, location: { cloudId: probe.nativeId } },
        ],
      });
      await world.owner.recordObservations();
      expect(world.artifacts[1]).toMatchObject({
        reservationMatches: [{ location: { cloudId: probe.nativeId } }],
      });
      await expect(world.owner.verify(ref, 1_000)).rejects.toBe(failure);
      expect(probe.reader.observe).toHaveBeenCalledTimes(1);
    },
  );

  test('preserves both native and artifact failures and still retains partial matches', async () => {
    const probe = reservationReader();
    const reserved = attempt({ cloudId: `${ref.id}-0`, ip: null });
    const world = harness([reserved], { reservations: probe.reader });
    const readFailure = new Error('reservation page rejected');
    const writeFailure = new Error('artifact unavailable');
    probe.reader.observe.mockImplementation(
      async (attempts, _deadline, retain) => {
        retain(probe.receipt(attempts, [probe.nativeId], false));
        throw readFailure;
      },
    );
    world.writeArtifact.mockRejectedValueOnce(writeFailure);
    await expect(world.owner.verify(ref, 1_000)).rejects.toMatchObject({
      errors: [readFailure, writeFailure],
    });
    await world.owner.recordObservations();
    expect(world.artifacts[0]).toMatchObject({
      reservationMatches: [{ location: { cloudId: probe.nativeId } }],
    });
  });

  test.each(['present', 'unknown'] as const)(
    'one %s native match prevents completion even when its peer is absent',
    async (presence) => {
      const probe = reservationReader();
      const reserved = attempt({ cloudId: `${ref.id}-0`, ip: null });
      const world = harness([reserved], { reservations: probe.reader });
      probe.reader.observe.mockImplementation(async (attempts) =>
        probe.receipt(attempts, [probe.nativeId, 'i-22222222222222222']),
      );
      probe.reader.observeMatch.mockImplementation(async (location) => ({
        provider: CloudType.AWS,
        cloudId: location.cloudId,
        presence:
          location.cloudId === 'i-22222222222222222' ? presence : 'absent',
        diagnostic: 'controlled presence',
      }));
      // Frozen clock: both matches are observed before the deadline can pass,
      // then the advance expires the wait so the report names the presence.
      vi.useFakeTimers();
      try {
        const rejection = expect(world.owner.verify(ref, 10)).rejects.toThrow(
          presence,
        );
        await vi.advanceTimersByTimeAsync(10);
        await rejection;
      } finally {
        vi.useRealTimers();
      }
      expect(
        probe.reader.observeMatch.mock.calls.map(
          ([location]) => location.cloudId,
        ),
      ).toEqual([probe.nativeId, 'i-22222222222222222']);
      expect(world.artifacts[0]).toMatchObject({
        completed: false,
        reservationMatches: expect.any(Array),
      });
    },
  );

  test('retains a match from a failed generation proof when a later inventory omits it', async () => {
    const probe = reservationReader();
    const world = harness([], { reservations: probe.reader });
    await world.owner.creationStarted(ref);
    const reserved = attempt({ cloudId: `${ref.id}-0`, ip: null });
    world.setRows([reserved]);
    probe.reader.observe.mockImplementationOnce(async (attempts) =>
      probe.receipt(attempts, [probe.nativeId]),
    );
    probe.reader.observeMatch.mockRejectedValueOnce(
      new Error('native read unavailable'),
    );
    await expect(world.owner.generationAbsence(ref, 1, 1_000)).rejects.toThrow(
      'native read unavailable',
    );
    await world.owner.verify(ref, 1_000);
    expect(probe.reader.observeMatch).toHaveBeenCalledTimes(2);
    expect(world.artifacts).toMatchObject([
      {
        completed: false,
        reservationObservations: [
          { attempts: [{ instanceIds: [probe.nativeId] }] },
        ],
      },
      {
        completed: true,
        reservationMatches: [{ location: { cloudId: probe.nativeId } }],
      },
    ]);
    expect(probe.reader.observe.mock.calls[1][0]).toEqual([reserved]);
  });

  test('an absent reservation cannot resolve a lost later submission using an old row', async () => {
    const probe = reservationReader();
    const world = harness([], { reservations: probe.reader });
    await world.owner.creationStarted(ref);
    world.setRows([attempt({ cloudId: `${ref.id}-0`, ip: null })]);
    const absence = await world.owner.generationAbsence(ref, 1, 1_000);
    await world.owner.creationStarted(ref, undefined, absence);
    await expect(world.owner.verify(ref, 1_000)).rejects.toThrow(
      'unresolved provisioning identity',
    );
    expect(probe.reader.observe).toHaveBeenCalledTimes(1);
    expect(world.artifacts.at(-1)).toMatchObject({
      completed: false,
      creations: [{ resolvedRowIds: [1] }, { resolvedRowIds: [] }],
    });
  });

  test('captures the original reservation reader and credential before caller replacement', async () => {
    const probe = reservationReader();
    const world = harness([attempt({ cloudId: `${ref.id}-0`, ip: null })], {
      reservations: probe.reader,
    });
    const originalObserve = probe.reader.observe;
    probe.reader.credentialName = 'replacement';
    probe.reader.observe = vi.fn(async () => {
      throw new Error('replacement reader');
    });
    await world.owner.verify(ref, 1_000);
    expect(originalObserve).toHaveBeenCalledTimes(1);
    expect(probe.reader.observe).not.toHaveBeenCalled();
    expect(world.artifacts[0]).toMatchObject({
      reservationObservations: [{ credentialName: 'original-compute' }],
      completed: true,
    });
  });
});

describe('recorded Job reservation refinement', () => {
  test.each(['adopted', 'partial-native-retarget'] as const)(
    'preserves a Local reservation and checks its exact %s machine name',
    async (completion) => {
      const world = harness([], { provider: CloudType.Local });
      await world.owner.creationStarted(ref);
      const original = attempt({
        cloudProvider: CloudType.Local,
        credentialId: null,
        cloudId: `${ref.id}-0`,
        region: 'local',
        availabilityZone: null,
        vmType: 'local',
        ip: null,
      });
      world.setRows([original]);
      await world.owner.capture(ref);
      const native = {
        ...original,
        cloudId: `ac-local-${ref.id}-0`,
        ip: completion === 'adopted' ? '127.0.0.1' : null,
        createdAt: completion === 'adopted' ? 150 : 100,
      };
      world.setRows([native]);
      await world.owner.verify(ref, 1_000);
      expect(world.reads).toEqual([native]);
      expect(world.artifacts[0]).toMatchObject({
        completed: true,
        attemptHistory: [original, native],
      });
    },
  );

  test.each([
    ['foreign-0', `ac-local-${ref.id}-0`],
    [`${ref.id}-0`, `ac-local-${ref.id}-1`],
    [`${ref.id}-00`, `ac-local-${ref.id}-00`],
  ])(
    'cannot refine Local provisional name %s into %s',
    async (originalId, nativeId) => {
      const world = harness([], { provider: CloudType.Local });
      await world.owner.creationStarted(ref);
      const original = attempt({
        cloudProvider: CloudType.Local,
        credentialId: null,
        cloudId: originalId,
        region: 'local',
        availabilityZone: null,
        vmType: 'local',
        ip: null,
      });
      world.setRows([original]);
      await world.owner.capture(ref);
      world.setRows([{ ...original, cloudId: nativeId, ip: '127.0.0.1' }]);
      await expect(world.owner.verify(ref, 1_000)).rejects.toThrow(
        'unresolved native provisioning identity',
      );
      expect(world.reads).toEqual([]);
    },
  );

  test.each([
    {
      provider: CloudType.GCP,
      originalId: 'job-native-name',
      nativeId: 'job-native-name',
      ip: '192.0.2.2',
      createdAt: 150,
      zone: 'c',
    },
    {
      provider: CloudType.Lambda,
      originalId: `${ref.id}-0`,
      nativeId: 'a'.repeat(32),
      ip: '192.0.2.2',
      createdAt: 150,
      zone: null,
    },
    {
      provider: CloudType.Lambda,
      originalId: `${ref.id}-0`,
      nativeId: 'a'.repeat(32),
      ip: null,
      createdAt: 100,
      zone: null,
    },
  ] as const)(
    'accepts only a scoped $provider native refinement with IP $ip',
    async (value) => {
      const world = harness([], { provider: value.provider });
      await world.owner.creationStarted(ref);
      const original = attempt({
        cloudProvider: value.provider,
        cloudId: value.originalId,
        availabilityZone: null,
        ip: null,
      });
      world.setRows([original]);
      await world.owner.capture(ref);
      const native = {
        ...original,
        cloudId: value.nativeId,
        availabilityZone: value.zone,
        ip: value.ip,
        createdAt: value.createdAt,
      };
      world.setRows([native]);
      await world.owner.verify(ref, 1_000);
      expect(world.reads).toEqual([native]);
      expect(world.artifacts[0]).toMatchObject({
        completed: true,
        attemptHistory: [original, native],
        reservationMatches: [],
      });
    },
  );

  test.each([
    {
      provider: CloudType.GCP,
      originalIds: ['job-old-name'],
      nativeId: 'job-new-name',
      zone: 'c',
    },
    {
      provider: CloudType.Lambda,
      originalIds: ['arbitrary-unknown'],
      nativeId: 'a'.repeat(32),
      zone: null,
    },
    {
      provider: CloudType.Lambda,
      originalIds: [`${ref.id}-0`, `${ref.id}-1`],
      nativeId: 'a'.repeat(32),
      zone: null,
    },
    {
      provider: CloudType.Lambda,
      originalIds: [`${ref.id}-0`, 'arbitrary-unknown'],
      nativeId: 'a'.repeat(32),
      zone: null,
    },
  ] as const)(
    'retains unresolved $provider history $originalIds after adoption',
    async (value) => {
      const world = harness([], { provider: value.provider });
      await world.owner.creationStarted(ref);
      for (const cloudId of value.originalIds) {
        world.setRows([
          attempt({
            cloudProvider: value.provider,
            cloudId,
            availabilityZone: null,
            ip: null,
          }),
        ]);
        await world.owner.capture(ref);
      }
      world.setRows([
        attempt({
          cloudProvider: value.provider,
          cloudId: value.nativeId,
          availabilityZone: value.zone,
          ip: '192.0.2.2',
          createdAt: 150,
        }),
      ]);
      await expect(world.owner.verify(ref, 1_000)).rejects.toThrow(
        'unresolved native provisioning identity',
      );
      expect(world.artifacts[0]).toMatchObject({
        completed: false,
        attemptHistory: expect.any(Array),
      });
      expect(world.reads).toEqual([]);
    },
  );
});

describe('Job native cleanup owner', () => {
  test('checks every resolved historical host, including a partial failed launch', async () => {
    const world = harness([]);
    await world.owner.creationStarted(ref);
    world.setRows([attempt({ ip: null })]);
    await world.owner.capture(ref);
    world.setRows([
      attempt({ cloudId: 'i-11111111111111111' }),
      attempt({ rowId: 2, cloudId: 'i-22222222222222222' }),
    ]);
    await world.owner.verify(ref, 1_000);
    expect(world.reads.map((row) => row.cloudId)).toEqual([
      'i-0123456789abcdef0',
      'i-11111111111111111',
      'i-22222222222222222',
    ]);
    expect(world.artifacts[0]).toMatchObject({
      completed: true,
      authorizedCreates: 1,
      workloadId: ref.id,
      attemptHistory: expect.any(Array),
    });
  });

  test('refuses to forget an unobserved historical reservation after native adoption', async () => {
    const world = harness([]);
    await world.owner.creationStarted(ref);
    world.setRows([attempt({ cloudId: 'job-reserved-0', ip: null })]);
    await world.owner.capture(ref);
    world.setRows([attempt()]);
    await expect(world.owner.verify(ref, 1_000)).rejects.toThrow(
      'unresolved native provisioning identity',
    );
    expect(world.reads).toEqual([]);
    expect(world.artifacts[0]).toMatchObject({
      attemptHistory: [
        expect.objectContaining({ cloudId: 'job-reserved-0' }),
        expect.objectContaining({ cloudId: 'i-0123456789abcdef0' }),
      ],
      completed: false,
    });
  });

  test('uses partial native identities previously observed by the shared attempt ledger', async () => {
    const world = harness([]);
    await world.owner.creationStarted(ref);
    world.setRows([attempt({ ip: null })]);
    await world.ledger.read(ref, identity);
    world.setRows([attempt({ cloudId: 'i-11111111111111111' })]);
    world.setNative(async (row) => ({
      provider: row.cloudProvider,
      cloudId: row.cloudId,
      presence: row.cloudId === 'i-0123456789abcdef0' ? 'present' : 'absent',
      diagnostic: 'original partial host still exists',
    }));
    vi.useFakeTimers();
    try {
      const rejection = expect(world.owner.verify(ref, 10)).rejects.toThrow(
        'i-0123456789abcdef0: present',
      );
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
    expect(world.reads.map((row) => row.cloudId)).toEqual([
      'i-0123456789abcdef0',
      'i-11111111111111111',
    ]);
    expect(world.artifacts[0]).toMatchObject({ completed: false });
  });

  test('retains already-known native history when its first fresh cleanup read fails', async () => {
    const world = harness([]);
    await world.owner.creationStarted(ref);
    world.setRows([attempt()]);
    await world.ledger.read(ref, identity);
    const failure = new Error('complete database read failed');
    vi.mocked(world.ledger.read).mockRejectedValueOnce(failure);
    await expect(world.owner.verify(ref, 1_000)).rejects.toBe(failure);
    expect(world.reads).toEqual([]);
    expect(world.artifacts[0]).toMatchObject({
      completed: false,
      failure: failure.message,
      authorizedCreates: 1,
      attemptHistory: [attempt()],
    });
  });

  test.each([1, 2])(
    'does not let %i old ended attempts resolve a later lost resubmit reply',
    async (oldCount) => {
      const world = harness([]);
      await world.owner.creationStarted(ref);
      world.setRows(
        Array.from({ length: oldCount }, (_, index) =>
          attempt({
            rowId: index + 1,
            cloudId: `i-${String(index + 1).repeat(17)}`,
          }),
        ),
      );
      await world.owner.capture(ref);
      const absence = await world.owner.generationAbsence(ref, 1, 1_000);
      await world.owner.creationStarted(ref, undefined, absence);
      await expect(world.owner.verify(ref, 1_000)).rejects.toThrow(
        'unresolved provisioning identity',
      );
      expect(world.reads).toHaveLength(oldCount);
      expect(world.artifacts.at(-1)).toMatchObject({
        completed: false,
        authorizedCreates: 2,
        creations: [
          expect.objectContaining({ ordinal: 1 }),
          expect.objectContaining({ ordinal: 2, resolvedRowIds: [] }),
        ],
      });
    },
  );

  test('verifies both submissions once the resubmit has its own new attempt row', async () => {
    const world = harness([]);
    await world.owner.creationStarted(ref);
    world.setRows([attempt()]);
    await world.owner.capture(ref);
    const absence = await world.owner.generationAbsence(ref, 1, 1_000);
    await world.owner.creationStarted(ref, undefined, absence);
    world.setRows([
      attempt(),
      attempt({ rowId: 2, cloudId: 'i-22222222222222222' }),
    ]);
    await world.owner.verify(ref, 1_000);
    expect(world.reads.map((row) => row.cloudId)).toEqual([
      'i-0123456789abcdef0',
      'i-0123456789abcdef0',
      'i-22222222222222222',
    ]);
    expect(world.artifacts[0]).toMatchObject({
      kind: 'job-generation-absence',
      generation: 1,
      completed: true,
      authorizedCreates: 1,
    });
    expect(world.artifacts[1]).toMatchObject({
      completed: true,
      authorizedCreates: 2,
      creations: [
        { ordinal: 1, baselineRowIds: [], resolvedRowIds: [1] },
        { ordinal: 2, baselineRowIds: [1], resolvedRowIds: [2] },
      ],
    });
  });

  test('requires original intermediate native absence before an ended generation can resubmit', async () => {
    const world = harness([]);
    await world.owner.creationStarted(ref);
    world.setRows([attempt()]);
    await expect(world.owner.creationStarted(ref)).rejects.toThrow(
      'unused original generation absence',
    );
    expect(world.reads).toEqual([]);
    const absence = await world.owner.generationAbsence(ref, 1, 1_000);
    await expect(
      world.owner.creationStarted(ref, undefined, { ...absence }),
    ).rejects.toThrow('unused original generation absence');
    const foreign = harness([]);
    await foreign.owner.creationStarted(ref);
    foreign.setRows([attempt()]);
    await expect(
      foreign.owner.creationStarted(ref, undefined, absence),
    ).rejects.toThrow('unused original generation absence');
    await world.owner.creationStarted(ref, undefined, absence);
    world.setRows([
      attempt(),
      attempt({ rowId: 2, cloudId: 'i-22222222222222222' }),
    ]);
    await expect(
      world.owner.creationStarted(ref, undefined, absence),
    ).rejects.toThrow('unused original generation absence');
    expect(world.reads).toEqual([attempt()]);
  });

  test('rejects a generation absence after the fresh inventory contains another native attempt', async () => {
    const world = harness([]);
    await world.owner.creationStarted(ref);
    world.setRows([attempt()]);
    const absence = await world.owner.generationAbsence(ref, 1, 1_000);
    world.setRows([
      attempt(),
      attempt({ rowId: 2, cloudId: 'i-22222222222222222' }),
    ]);
    await expect(
      world.owner.creationStarted(ref, undefined, absence),
    ).rejects.toThrow('unused original generation absence');
    await world.owner.verify(ref, 1_000);
    expect(world.artifacts.at(-1)).toMatchObject({
      authorizedCreates: 1,
      currentAttempts: [attempt(), expect.objectContaining({ rowId: 2 })],
      completed: true,
    });
  });

  test('keeps the reference armed while generation absence runs and admits only its eventual original receipt', async () => {
    const world = harness([]);
    await world.owner.creationStarted(ref);
    world.setRows([attempt()]);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.setNative(async (row) => {
      await gate;
      return {
        cloudId: row.cloudId,
        provider: row.cloudProvider,
        presence: 'absent',
        diagnostic: 'absent',
      };
    });
    const checking = world.owner.generationAbsence(ref, 1, 1_000);
    await expect(world.owner.creationStarted(ref)).rejects.toThrow(
      'generation absence is in progress',
    );
    expect(() => world.owner.verify(ref, 1_000)).toThrow(
      'generation absence is in progress',
    );
    release?.();
    const absence = await checking;
    await expect(world.owner.generationAbsence(ref, 1, 1_000)).rejects.toThrow(
      'unavailable or reused',
    );
    await world.owner.creationStarted(ref, undefined, absence);
    await world.owner.recordObservations();
    expect(world.artifacts.at(-1)).toMatchObject({
      creations: [
        expect.objectContaining({ ordinal: 1 }),
        expect.objectContaining({ ordinal: 2 }),
      ],
    });
  });

  test('retains failed intermediate absence even when final fallback later observes the host absent', async () => {
    const world = harness([]);
    await world.owner.creationStarted(ref);
    world.setRows([attempt()]);
    world.setNative(async (row) => ({
      cloudId: row.cloudId,
      provider: row.cloudProvider,
      presence: 'unknown',
      diagnostic: 'read unavailable',
    }));
    vi.useFakeTimers();
    try {
      const rejection = expect(
        world.owner.generationAbsence(ref, 1, 10),
      ).rejects.toThrow(/unknown|deadline expired/u);
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
    await expect(world.owner.creationStarted(ref)).rejects.toThrow(
      'unused original generation absence',
    );
    world.setNative(async (row) => ({
      cloudId: row.cloudId,
      provider: row.cloudProvider,
      presence: 'absent',
      diagnostic: 'exact absence',
    }));
    await world.owner.verify(ref, 1_000);
    expect(world.artifacts).toEqual([
      expect.objectContaining({
        kind: 'job-generation-absence',
        generation: 1,
        completed: false,
        observations: [expect.objectContaining({ presence: 'unknown' })],
      }),
      expect.objectContaining({
        kind: 'job-native-cleanup',
        completed: true,
        authorizedCreates: 1,
      }),
    ]);
    await expect(world.owner.creationStarted(ref)).rejects.toThrow(
      'cleanup has started',
    );
  });

  test('blocks resubmission until the preceding authorized creation resolves', async () => {
    const world = harness([]);
    await world.owner.creationStarted(ref);
    await expect(world.owner.creationStarted(ref)).rejects.toThrow(
      'cannot resubmit an unresolved provisioning identity',
    );
    expect(world.reads).toEqual([]);
  });

  test('blocks a new submission while an earlier VM attempt is live', async () => {
    const world = harness([]);
    await world.owner.creationStarted(ref);
    world.setRows([attempt({ endedAt: null })]);
    await expect(world.owner.creationStarted(ref)).rejects.toThrow(
      'still has live provisioning attempts',
    );
    expect(world.reads).toEqual([]);
  });

  test('cleanup overtaking a fresh baseline prevents the pending mutation from sending', async () => {
    const world = harness([]);
    let release: (() => void) | undefined;
    const baselineWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(world.ledger.read).mockImplementationOnce(async () => {
      await baselineWait;
      return [];
    });
    const send = vi.fn();
    const creation = world.owner.creationStarted(ref).then(send);
    const rejection = expect(creation).rejects.toThrow('cleanup has started');
    await expect(world.owner.creationStarted(ref)).rejects.toThrow(
      'creation authorization is in progress',
    );
    await world.owner.verify(ref, 1_000);
    release?.();
    await rejection;
    expect(send).not.toHaveBeenCalled();
    expect(world.reads).toEqual([]);
    expect(world.artifacts[0]).toMatchObject({
      completed: true,
      authorizedCreates: 0,
    });
  });

  test('retains earlier native observations when a later host fails', async () => {
    const world = harness([]);
    await world.owner.creationStarted(ref);
    world.setRows([
      attempt(),
      attempt({ rowId: 2, cloudId: 'i-22222222222222222' }),
    ]);
    const failure = new Error('second host authorization rejected');
    world.setNative(async (row) => {
      if (row.rowId === 2) throw failure;
      return {
        cloudId: row.cloudId,
        provider: row.cloudProvider,
        presence: 'absent',
        diagnostic: 'first native host is absent',
      };
    });
    await expect(world.owner.verify(ref, 1_000)).rejects.toBe(failure);
    expect(world.artifacts[0]).toMatchObject({
      completed: false,
      failure: failure.message,
      observations: [{ cloudId: 'i-0123456789abcdef0', presence: 'absent' }],
    });
  });

  test('refuses to forget an authorized lost create reply without any attempt identity', async () => {
    const world = harness([]);
    await world.owner.creationStarted(ref);
    await expect(world.owner.verify(ref, 1_000)).rejects.toThrow(
      'unresolved provisioning identity',
    );
    expect(world.reads).toEqual([]);
    expect(world.artifacts[0]).toMatchObject({
      completed: false,
      authorizedCreates: 1,
    });
  });

  test('does not pass a synthetic AWS client token to an absence observer', async () => {
    const world = harness([]);
    await world.owner.creationStarted(ref);
    world.setRows([attempt({ cloudId: 'job-reserved-0', ip: null })]);
    await expect(world.owner.verify(ref, 1_000)).rejects.toThrow(
      'unresolved native provisioning identity',
    );
    expect(world.reads).toEqual([]);
    expect(world.artifacts[0]).toMatchObject({ completed: false });
  });

  test('requires zero live attempt rows before querying native absence', async () => {
    const world = harness([]);
    await world.owner.creationStarted(ref);
    world.setRows([attempt({ endedAt: null })]);
    vi.useFakeTimers();
    try {
      const rejection = expect(world.owner.verify(ref, 10)).rejects.toThrow(
        'live provisioning attempts remain',
      );
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
    expect(world.reads).toEqual([]);
    expect(world.artifacts[0]).toMatchObject({ completed: false });
  });

  test.each(['present', 'unknown'] as const)(
    'a native %s observation cannot complete cleanup',
    async (presence) => {
      const world = harness([]);
      await world.owner.creationStarted(ref);
      world.setRows([attempt()]);
      world.setNative(async (row) => ({
        cloudId: row.cloudId,
        provider: row.cloudProvider,
        presence,
        diagnostic: 'provider observation',
      }));
      vi.useFakeTimers();
      try {
        const rejection = expect(world.owner.verify(ref, 10)).rejects.toThrow(
          presence,
        );
        await vi.advanceTimersByTimeAsync(10);
        await rejection;
      } finally {
        vi.useRealTimers();
      }
      expect(world.artifacts[0]).toMatchObject({
        completed: false,
        observations: [expect.objectContaining({ presence })],
      });
    },
  );

  test.each([
    { cloudId: 'i-99999999999999999' },
    { provider: CloudType.Azure },
  ])(
    'rejects a successful receipt for a foreign native identity %#',
    async (override) => {
      const world = harness();
      world.setNative(async (row) => ({
        cloudId: row.cloudId,
        provider: row.cloudProvider,
        presence: 'absent',
        diagnostic: '',
        ...override,
      }));
      await expect(world.owner.verify(ref, 1_000)).rejects.toThrow(
        'different host',
      );
      expect(world.artifacts[0]).toMatchObject({ completed: false });
    },
  );

  test('joins fallback and explicit cleanup and blocks mutation before the first await', async () => {
    const world = harness([]);
    await world.owner.creationStarted(ref);
    world.setRows([attempt()]);
    let release: (() => void) | undefined;
    const nativeWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.setNative(async (row) => {
      await nativeWait;
      return {
        cloudId: row.cloudId,
        provider: row.cloudProvider,
        presence: 'absent',
        diagnostic: '',
      };
    });
    const first = world.owner.verify(ref, 1_000);
    const second = world.owner.verify(ref, 1_000);
    expect(first).toBe(second);
    await expect(world.owner.creationStarted(ref)).rejects.toThrow(
      'cleanup has started',
    );
    release?.();
    await Promise.all([first, second]);
    expect(world.reads).toHaveLength(1);
    expect(world.artifacts).toHaveLength(1);
  });

  test('retains the exact native exception and never writes success on failure', async () => {
    const world = harness();
    const failure = new Error('native authentication rejected');
    world.setNative(async () => {
      throw failure;
    });
    await expect(world.owner.verify(ref, 1_000)).rejects.toBe(failure);
    expect(world.artifacts[0]).toMatchObject({
      completed: false,
      failure: failure.message,
    });
    await expect(world.owner.verify(ref, 1_000)).rejects.toBe(failure);
    expect(world.reads).toHaveLength(1);
  });

  test('rejects missing or forged registration without any database or native call', async () => {
    const world = harness();
    expect(() =>
      world.owner.verify(trackedWorkloadRefForTest(ref.id), 1_000),
    ).toThrow('forged');
    world.release();
    expect(() => world.owner.verify(ref, 1_000)).toThrow('inactive');
    expect(world.ledger.read).not.toHaveBeenCalled();
    expect(world.reads).toEqual([]);
  });

  test.each([
    { cloudProvider: CloudType.AWS, cloudId: 'job-pending' },
    { cloudProvider: CloudType.Lambda, cloudId: 'job-pending' },
    {
      cloudProvider: CloudType.GCP,
      cloudId: 'job-pending',
      availabilityZone: null,
    },
    {
      cloudProvider: CloudType.Local,
      cloudId: 'ac-local-job-pending',
      region: 'local',
      vmType: 'local',
      ip: null,
    },
  ] satisfies readonly Partial<JobNativeAttempt>[])(
    'does not infer complete native coordinates from an unresolved reservation %#',
    (overrides) => {
      expect(hasJobNativeCoordinates(attempt(overrides))).toBe(false);
    },
  );

  test('accepts exact Azure/GCP reserved names with original placement, and adopted hashed Local names', () => {
    expect(
      hasJobNativeCoordinates(
        attempt({
          cloudProvider: CloudType.Azure,
          cloudId: 'job-pending-0',
          ip: null,
          availabilityZone: null,
        }),
      ),
    ).toBe(true);
    expect(
      hasJobNativeCoordinates(
        attempt({
          cloudProvider: CloudType.GCP,
          cloudId: 'job-pending-0',
          ip: null,
          availabilityZone: 'a',
        }),
      ),
    ).toBe(true);
    expect(
      hasJobNativeCoordinates(
        attempt({
          cloudProvider: CloudType.Local,
          cloudId: 'truncated-original-8ccaae190a',
          region: 'local',
          vmType: 'local',
        }),
      ),
    ).toBe(true);
  });
});
