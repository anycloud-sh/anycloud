import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import {
  getWorkloadQueryStore as queries,
  getWorkloadOutcomes,
} from '../../src/api/services/persistence.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

import { describe, expect, onTestFinished, test, vi } from 'vitest';

import { CloudType } from '../../src/shared/cloud.js';
import {
  hashCredential,
  encryptCredential,
} from '../../src/api/services/cloud-config.js';
import { resolveProvisioningTarget } from '../../src/api/services/optimizer.js';
import { getDB } from '../../src/api/services/repositories/db.js';
import {
  getCredentialSecretStore,
  resetPersistence,
} from '../../src/api/services/persistence.js';
import { ImageRuntime } from '../../src/shared/image.js';
import { cloudCredentialSchema } from '../../src/shared/api-contract/credentials-schemas.js';
import { WorkloadState } from '../../src/shared/workload.js';
import { WorkloadHealthStatus } from '../../src/shared/runtime.js';
import { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import {
  ArtifactStore,
  Redactor,
} from '../integration/e2e/internal/artifacts.js';
import { CliClient } from '../integration/e2e/internal/cli.js';
import { CliDatabase } from '../integration/e2e/internal/database.js';
import { ControllerEndpoint } from '../integration/e2e/internal/controller-session.js';
import { ProcessRunner } from '../integration/e2e/internal/process.js';
import { ApiClient } from '../integration/e2e/internal/api.js';
import { WorkloadMutationTransport } from '../integration/e2e/internal/workload-mutations.js';
import {
  PersistentVmCleanup,
  evaluateAdmissionNonCreation,
  type AdmissionNonCreationEvidence,
} from '../integration/e2e/internal/persistent-vm-cleanup.js';
import { PublicCloudVmHostPresenceProbe } from '../integration/e2e/internal/transports/public-cloud-vm-host-presence.js';
import type { VmProfile } from '../integration/e2e/internal/profiles.js';
import type {
  CommandResult,
  StatusResponse,
  WorkloadCreateBody,
} from '../integration/e2e/internal/types.js';
import { observeLocalSmolvmHost } from '../integration/e2e/internal/transports/local-smolvm.js';
import type { TargetHttpOptions } from '../integration/e2e/internal/transports/http.js';
import type {
  VmHostLocation,
  VmHostObservationOptions,
  VmHostPresenceObservation,
} from '../integration/e2e/internal/transports/public-cloud-vm-host-presence.js';
import type { WaitOptions } from '../integration/e2e/internal/wait.js';
import {
  TrackedWorkloadKernel,
  type TrackedWorkloadRef,
} from '../integration/e2e/internal/workloads.js';
import { persistentVmWorkload } from './helpers/persistent-vm-fixture.js';
import { makeMockCloudCompute } from './helpers/fixtures.js';
import { createWorkload } from '../../src/api/services/repositories/workload-creation.js';

const workloadId = 'vm-cleanup-owned';
const cloudId = 'i-0123456789abcdef0';
const secondCloudId = 'i-fedcba98765432100';

function admissionEvidence(): AdmissionNonCreationEvidence {
  const materialHash = hashCredential({
    cloudProvider: CloudType.AWS,
    accessKeyId: 'original-access',
    secretAccessKey: 'private-original-material',
  });
  const original = {
    workloadId,
    endpoint: 'https://original-manager.example',
    provider: CloudType.AWS as const,
    profileRowId: materialHash,
    credentialName: 'original-aws',
    materialHash,
  };
  return {
    original,
    baseline: {
      ...original,
      observedAt: 10,
      complete: true,
      workloads: 0,
      vms: 0,
      credential: {
        id: materialHash,
        name: 'original-aws',
        provider: CloudType.AWS,
      },
    },
    requestAuthorizedAt: 20,
    rejection: {
      ...original,
      observedAt: 30,
      defined: true,
      code: 'WORKLOAD_ADMISSION_REJECTED',
      status: 400,
    },
    afterRejection: {
      ...original,
      observedAt: 40,
      complete: true,
      workloads: 0,
      vms: 0,
    },
    recheck: {
      ...original,
      observedAt: 60,
      complete: true,
      workloads: 0,
      vms: 0,
    },
    history: {
      ...original,
      observedAt: 50,
      complete: true,
      attempts: [],
      statusIdentities: [],
    },
    evaluatedAt: 70,
  };
}

describe('Shared admission non-creation observations', () => {
  test('requires a later inventory and retained history before reporting non-creation', () => {
    const evidence = admissionEvidence();
    const { recheck: _recheck, ...beforeCleanup } = evidence;
    expect(
      evaluateAdmissionNonCreation({
        ...beforeCleanup,
        history: { ...evidence.history, observedAt: 35 },
      }),
    ).toEqual({ kind: 'rejection-observed', observedAt: 40 });
    expect(evaluateAdmissionNonCreation(evidence)).toEqual({
      kind: 'proven-non-creation',
      observedAt: 60,
    });
  });

  test.each([
    ['Workload', { workloadId: 'foreign-workload' }],
    ['endpoint', { endpoint: 'https://replacement-manager.example' }],
    ['provider', { provider: CloudType.GCP }],
    ['credential row', { profileRowId: 'f'.repeat(64) }],
  ])('rejects a foreign %s in every required observation', (_label, change) => {
    for (const part of [
      'baseline',
      'rejection',
      'afterRejection',
      'recheck',
      'history',
    ] as const) {
      const evidence = admissionEvidence();
      expect(
        evaluateAdmissionNonCreation({
          ...evidence,
          [part]: { ...evidence[part], ...change },
        }),
      ).toEqual({ kind: 'unknown', reason: 'foreign-observation' });
    }
  });

  test.each([
    ['credential material', { id: 'e'.repeat(64) }],
    ['credential name', { name: 'replacement-aws' }],
    ['credential provider', { provider: CloudType.GCP }],
  ])(
    'requires the actual baseline %s to match the original selection',
    (_label, change) => {
      const evidence = admissionEvidence();
      expect(
        evaluateAdmissionNonCreation({
          ...evidence,
          baseline: {
            ...evidence.baseline,
            credential: { ...evidence.baseline.credential, ...change },
          },
        }),
      ).toEqual({ kind: 'unknown', reason: 'original-credential-mismatch' });
    },
  );

  test.each([
    ['HTTP 400 without the declared SDK error', { defined: false }],
    [
      'a lost response with no decoded error',
      { defined: false, code: null, status: null },
    ],
    ['a different declared error', { code: 'OTHER_VALIDATION_ERROR' }],
    ['a different error status', { status: 403 }],
  ])('does not convert %s into non-creation', (_label, change) => {
    const evidence = admissionEvidence();
    expect(
      evaluateAdmissionNonCreation({
        ...evidence,
        rejection: { ...evidence.rejection, ...change },
      }),
    ).toEqual({ kind: 'unknown', reason: 'undeclared-rejection' });
  });

  test.each(['baseline', 'afterRejection', 'recheck'] as const)(
    'requires complete empty %s inventory',
    (part) => {
      for (const change of [
        { complete: false },
        { workloads: 1 },
        { vms: 1 },
        { workloads: Number.NaN },
      ]) {
        const evidence = admissionEvidence();
        expect(
          evaluateAdmissionNonCreation({
            ...evidence,
            [part]: { ...evidence[part], ...change },
          }),
        ).toEqual({
          kind: 'unknown',
          reason:
            'complete' in change
              ? 'incomplete-inventory'
              : 'nonempty-inventory',
        });
      }
    },
  );

  test.each([
    ['an incomplete read', { complete: false }, 'incomplete-history'],
    [
      'an ended reservation',
      { attempts: [{ endedAt: 1, cloudId: `${workloadId}-0` }] },
      'contradictory-history',
    ],
    [
      'a validated ID from an earlier page',
      { attempts: [{ cloudId }] },
      'contradictory-history',
    ],
    [
      'an earlier status identity',
      { statusIdentities: [{ cloudId }] },
      'contradictory-history',
    ],
  ])(
    'retains the obligation for %s even after a later zero ledger',
    (_label, change, reason) => {
      const evidence = admissionEvidence();
      expect(
        evaluateAdmissionNonCreation({
          ...evidence,
          history: { ...evidence.history, ...change },
        }),
      ).toEqual({ kind: 'unknown', reason });
    },
  );

  test.each([
    ['baseline', 21],
    ['rejection', 19],
    ['afterRejection', 29],
    ['recheck', 39],
    ['history', 29],
    ['history', 61],
    ['recheck', Number.NaN],
  ] as const)('rejects stale or unordered %s time %s', (part, observedAt) => {
    const evidence = admissionEvidence();
    expect(
      evaluateAdmissionNonCreation({
        ...evidence,
        [part]: { ...evidence[part], observedAt },
      }),
    ).toEqual({ kind: 'unknown', reason: 'invalid-observation-order' });
  });

  test('does not use a pre-rejection history snapshot or future cleanup observation', () => {
    const evidence = admissionEvidence();
    expect(
      evaluateAdmissionNonCreation({
        ...evidence,
        history: { ...evidence.history, observedAt: 35 },
      }),
    ).toEqual({ kind: 'unknown', reason: 'invalid-observation-order' });
    expect(
      evaluateAdmissionNonCreation({ ...evidence, evaluatedAt: 59 }),
    ).toEqual({
      kind: 'unknown',
      reason: 'invalid-observation-order',
    });
  });

  test('returns only a fixed unknown reason for invalid identity, excluding private material', () => {
    const evidence = admissionEvidence();
    const outcome = evaluateAdmissionNonCreation({
      ...evidence,
      original: {
        ...evidence.original,
        endpoint: 'https://user:private-original-material@manager.example',
      },
    });
    expect(outcome).toEqual({
      kind: 'unknown',
      reason: 'invalid-original-identity',
    });
    expect(JSON.stringify(outcome)).not.toContain('private-original-material');
  });
});

function receipt(args: readonly string[], value: unknown): CommandResult {
  const stdout = JSON.stringify(value);
  return {
    executable: 'anycloud',
    args,
    exitCode: 0,
    signal: null,
    stdout,
    stderr: '',
    combined: stdout,
    durationMs: 1,
    timedOut: false,
    aborted: false,
    outputTruncated: false,
  };
}

function attempt(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1,
    workload_id: workloadId,
    credential_id: 'credential-original',
    cloud_provider: CloudType.AWS,
    created_at: 10,
    ended_at: 20,
    cloud_id: cloudId,
    region: 'us-east-2',
    availability_zone: 'b',
    ip: '203.0.113.2',
    vm_type: 't3.small',
    ...overrides,
  };
}

class SingleProbeWaiter {
  async for<T>(
    label: string,
    probe: (deadlineAt: number) => Promise<T>,
    options: WaitOptions<T>,
  ): Promise<T> {
    const value = await probe(Date.now() + options.timeoutMs);
    const unmet = options.reject?.(value) ?? options.unmet(value);
    if (unmet !== undefined) throw new Error(`${label}: ${unmet}`);
    return value;
  }
}

async function harness(
  target: 'aws' | 'local-smolvm' = 'aws',
  service?: {
    readonly profile: VmProfile;
    readonly verify: (
      ref: TrackedWorkloadRef,
      deadlineAt: number,
    ) => Promise<void>;
  },
  cleanupTimeoutMs = 100,
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'vm-native-cleanup-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const primary = new AbortController();
  const teardown = new AbortController();
  const cleanup = new CleanupStack();
  const endpoint = new ControllerEndpoint('https://vm-owner.example');
  const artifacts = new Map<string, unknown>();
  let rows: readonly Record<string, unknown>[] = [];
  let readFailure: Error | undefined;
  let apiFailure: Error | undefined;
  let nativePresence: 'absent' | 'present' | 'unknown' = 'absent';
  let localMachines: unknown = [];
  const profile: VmProfile = {
    slug: 'aws',
    provider: CloudType.AWS,
    credentialName: 'aws-test',
    vmTypes: ['t3.small'],
    region: 'us-east-2',
    credential: {
      cloudProvider: CloudType.AWS,
      accessKeyId: 'original-access',
      secretAccessKey: 'never-retain-this-credential',
    },
  };
  const run = vi.fn(async (args: readonly string[]): Promise<CommandResult> => {
    teardown.signal.throwIfAborted();
    if (args[0] === 'terminate') return receipt(args, {});
    if (args.at(-1)?.includes('FROM credentials'))
      return receipt(args, {
        rows: [
          {
            id: 'credential-original',
            name: profile.credentialName,
            cloud_provider: profile.provider,
          },
        ],
        rowCount: 1,
        truncated: false,
      });
    if (readFailure) throw readFailure;
    return receipt(args, { rows, rowCount: rows.length, truncated: false });
  });
  const api = {
    lookupStatus: async () => {
      if (apiFailure) throw apiFailure;
      return {
        kind: 'found' as const,
        status: {
          workload: persistentVmWorkload(workloadId, {
            state: WorkloadState.Terminated,
            completedAt: 20,
            cleanedAt: 30,
          }),
          events: [],
          status: WorkloadHealthStatus.Up,
          vms: [],
        },
      };
    },
  };
  const waiter = new SingleProbeWaiter();
  const primaryRun = {
    run: async (args: readonly string[]) => {
      primary.signal.throwIfAborted();
      return run(args);
    },
  };
  const kernel = new TrackedWorkloadKernel(
    api,
    primaryRun,
    cleanup,
    waiter,
    directory,
    { api, cli: { run }, wait: waiter },
  );
  const observe = vi.fn(
    async (
      location: VmHostLocation,
      options?: VmHostObservationOptions,
    ): Promise<VmHostPresenceObservation> => {
      options?.signal?.throwIfAborted();
      expect(options?.deadlineAt).toBeGreaterThan(Date.now());
      return {
        cloudId: location.cloudId,
        provider: profile.provider,
        diagnostic: `${profile.provider} host ${nativePresence}`,
        presence: nativePresence,
      };
    },
  );
  const nativeRun = vi
    .fn<ProcessRunner['run']>()
    .mockImplementation(async (executable, args) => ({
      ...receipt(args, { Reservations: [] }),
      executable,
    }));
  const create = vi.fn((original: VmProfile) => {
    const probe = new PublicCloudVmHostPresenceProbe(
      original,
      { run: nativeRun },
      { directory: vi.fn(), privateText: vi.fn() },
      { get },
    );
    return {
      observe,
      observeReservations: probe.observeReservations.bind(probe),
    };
  });
  const get = vi.fn(
    async (_label: string, _url: URL, options?: TargetHttpOptions) => {
      if (target !== 'local-smolvm')
        throw new Error('Unexpected native inventory read');
      options?.signal?.throwIfAborted();
      expect(options?.deadlineAt).toBeGreaterThan(Date.now());
      expect(options?.redirect).toBe('error');
      return { status: 200, body: localMachines };
    },
  );
  const native = new PersistentVmCleanup({
    kernel,
    endpoint,
    database: new CliDatabase({ run }),
    profiles: { vm: () => profile },
    hosts: { create },
    http: { get },
    wait: waiter,
    signal: teardown.signal,
    artifacts: {
      json: async (name, value) => {
        artifacts.set(name, structuredClone(value));
        return path.join(directory, `${name}.json`);
      },
    },
  });
  const ref = service
    ? await native.reserveWithProfile(
        target,
        workloadId,
        cleanupTimeoutMs,
        service.profile,
        service.verify,
      )
    : await native.reserve(target, workloadId, cleanupTimeoutMs);
  return {
    artifacts,
    cleanup,
    create,
    directory,
    endpoint,
    get,
    kernel,
    native,
    nativeRun,
    observe,
    primary,
    profile,
    ref,
    run,
    teardown,
    waiter,
    setLocalMachines(value: unknown) {
      localMachines = value;
    },
    setRows(value: readonly Record<string, unknown>[]) {
      rows = value;
    },
    setReadFailure(value: Error | undefined) {
      readFailure = value;
    },
    setApiFailure(value: Error) {
      apiFailure = value;
    },
    setPresence(value: typeof nativePresence) {
      nativePresence = value;
    },
    async start() {
      await native.creationStarted(ref);
      kernel.authorizeMutation(ref, ref.id);
    },
    async manifest() {
      return readFile(path.join(directory, 'workloads-to-clean'), 'utf8');
    },
  };
}

describe('Persistent VM cleanup authority', () => {
  test('preserves normal creation and native cleanup across a controller restart without admission observation', async () => {
    const h = await harness();
    await h.start();
    h.setRows([attempt()]);
    h.endpoint.detach();
    h.endpoint.attach('https://vm-owner.example');
    await h.cleanup.run();
    expect(h.observe).toHaveBeenCalledOnce();
    expect(h.kernel.trackedWorkloadIds()).toEqual([]);
    expect(h.artifacts.get(`vm-${workloadId}-native-cleanup`)).toMatchObject({
      completed: true,
      admissionRejection: null,
    });
  });

  test('keeps the selected Service profile and native coordinates through fallback', async () => {
    const profile: VmProfile = {
      slug: 'aws',
      provider: CloudType.AWS,
      credentialName: 'aws-test',
      credential: {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'original-access',
        secretAccessKey: 'original-service-value',
      },
      vmTypes: ['g6e.xlarge'],
      diskSizeGb: 100,
    };
    const verify = vi.fn(
      async (ref: TrackedWorkloadRef, deadlineAt: number) => {
        expect(ref.id).toBe(workloadId);
        expect(deadlineAt).toBeGreaterThan(Date.now());
      },
    );
    const h = await harness('aws', { profile, verify });
    // A caller cannot redirect already registered cleanup to later capacity.
    Object.assign(profile, { region: 'us-west-2', vmTypes: ['t3.small'] });
    const selected = h.native.profile(h.ref);
    expect(selected).toMatchObject({
      vmTypes: ['g6e.xlarge'],
      diskSizeGb: 100,
    });
    expect(selected.region).toBeUndefined();
    await h.start();
    h.setRows([
      attempt({
        vm_type: 'g6e.xlarge',
        region: 'us-east-1',
        availability_zone: 'us-east-1c',
      }),
    ]);
    h.primary.abort(new Error('foreground cancelled'));
    await h.cleanup.run();
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        vmTypes: ['g6e.xlarge'],
        diskSizeGb: 100,
        credential: expect.objectContaining({
          secretAccessKey: 'original-service-value',
        }),
      }),
    );
    expect(h.create.mock.calls[0]![0].region).toBeUndefined();
    expect(h.observe).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudId,
        region: 'us-east-1',
        availabilityZone: 'us-east-1c',
      }),
      expect.anything(),
    );
    expect(verify).toHaveBeenCalledTimes(1);
    expect(await h.manifest()).toBe('');
  });

  test('keeps the Workload receipt when the Service supplement fails after native absence', async () => {
    const first = await harness();
    const verify = vi.fn(async () => {
      throw new Error('authoritative DNS remains');
    });
    const h = await harness('aws', { profile: first.profile, verify });
    await h.start();
    h.setRows([attempt()]);
    await expect(h.cleanup.run()).rejects.toThrow('authoritative DNS remains');
    expect(h.observe).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(await h.manifest()).toContain(workloadId);
    expect(h.cleanup.observations()).toContainEqual({
      label: `workload ${workloadId}`,
      completed: false,
    });
  });

  test.each([false, true])(
    'Local fallback retains owned siblings missing from the API ledger: sibling=%s',
    async (siblingPresent) => {
      const h = await harness('local-smolvm');
      await h.start();
      h.setRows([
        attempt({
          credential_id: null,
          cloud_provider: null,
          cloud_id: 'adopted-native-machine',
          region: 'local',
          availability_zone: null,
          ip: '127.0.0.1',
          vm_type: 'local',
        }),
      ]);
      const sibling = `ac-local-${workloadId}-1`;
      h.setLocalMachines(
        siblingPresent
          ? [
              {
                name: sibling,
                state: 'running',
                ports: [],
                privateData: 'unregistered-local-response-credential',
              },
            ]
          : [],
      );
      if (siblingPresent) {
        await expect(h.cleanup.run()).rejects.toThrow(
          'owned Local VM hosts remain',
        );
        expect(h.kernel.trackedWorkloadIds()).toEqual([workloadId]);
        expect(await h.manifest()).toContain(workloadId);
        expect(h.cleanup.observations()).toEqual([
          expect.objectContaining({
            label: `workload ${workloadId}`,
            completed: false,
          }),
        ]);
      } else {
        await h.cleanup.run();
        expect(h.kernel.trackedWorkloadIds()).toEqual([]);
        expect(await h.manifest()).not.toContain(workloadId);
      }
      expect(h.artifacts.get(`vm-${workloadId}-native-cleanup`)).toMatchObject({
        completed: !siblingPresent,
        observations: [
          {
            cloudId: 'adopted-native-machine',
            presence: 'absent',
            provider: CloudType.Local,
          },
        ],
        ownedLocalInventoryChecks: [
          {
            machineNames: siblingPresent ? [sibling] : [],
            observedAt: expect.any(Number),
          },
        ],
      });
      expect(JSON.stringify([...h.artifacts.values()])).not.toContain(
        'unregistered-local-response-credential',
      );
    },
  );

  test('native fallback accepts the persisted AWS numeric zone suffix through the real observer', async () => {
    const h = await harness();
    const probe = new PublicCloudVmHostPresenceProbe(
      h.profile,
      {
        run: async (executable, args) => ({
          ...receipt(args, {
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: cloudId,
                    State: { Name: 'terminated' },
                    Placement: { AvailabilityZone: 'us-east-2f' },
                  },
                ],
              },
            ],
          }),
          executable,
        }),
      },
      { directory: vi.fn(), privateText: vi.fn() },
      { get: vi.fn() },
    );
    h.observe.mockImplementation((location, options) =>
      probe.observe(location, options),
    );
    await h.start();
    h.setRows([attempt({ availability_zone: '2f' })]);
    await h.native.capture(h.ref);
    await h.cleanup.run();
    expect(h.kernel.trackedWorkloadIds()).toEqual([]);
    expect(await h.manifest()).not.toContain(workloadId);
    expect(h.artifacts.get(`vm-${workloadId}-native-cleanup`)).toMatchObject({
      completed: true,
      observations: [
        {
          cloudId,
          region: 'us-east-2',
          availabilityZone: '2f',
          presence: 'absent',
        },
      ],
    });
  });

  test('registers native verification before creation can fail without an observation', async () => {
    const h = await harness();
    expect(h.cleanup.observations()).toEqual([
      { label: `workload ${workloadId}`, completed: false },
    ]);
    await h.start();
    // A create can throw after sending while no attempt identity can be read.
    await expect(h.cleanup.run()).rejects.toThrow(
      'no complete native identity inventory',
    );
    expect(h.kernel.trackedWorkloadIds()).toEqual([workloadId]);
    expect(await h.manifest()).toContain(workloadId);
    expect(h.observe).not.toHaveBeenCalled();
  });

  test.each(['present', 'unknown'] as const)(
    '%s native evidence keeps fallback registration and its durable manifest',
    async (presence) => {
      const h = await harness();
      await h.start();
      h.setRows([attempt()]);
      h.setPresence(presence);
      await expect(h.cleanup.run()).rejects.toThrow(
        'native VM presence remains present or unknown',
      );
      expect(h.kernel.trackedWorkloadIds()).toEqual([workloadId]);
      expect(h.cleanup.observations()).toEqual([
        { label: `workload ${workloadId}`, completed: false },
      ]);
      expect(await h.manifest()).toContain(workloadId);
      expect(h.artifacts.get(`vm-${workloadId}-native-cleanup`)).toMatchObject({
        completed: false,
        observations: [{ cloudId, presence }],
      });
    },
  );

  test('verifies every ended attempt with original credentials and placement before completing cleanup', async () => {
    const h = await harness();
    await h.start();
    h.setRows([
      attempt(),
      attempt({ id: 2, cloud_id: secondCloudId, created_at: 12 }),
    ]);
    await h.native.capture(h.ref);
    if (h.profile.credential.cloudProvider !== CloudType.AWS)
      throw new Error('fixture credential type');
    h.profile.credential.secretAccessKey = 'changed-after-registration';
    Object.assign(h.profile, { region: 'us-west-1' });
    await h.cleanup.run();
    expect(
      h.observe.mock.calls.map(([location]) => [
        location.cloudId,
        location.region,
        location.availabilityZone,
      ]),
    ).toEqual([
      [cloudId, 'us-east-2', 'b'],
      [secondCloudId, 'us-east-2', 'b'],
    ]);
    expect(h.create.mock.calls[0][0].credential).toMatchObject({
      secretAccessKey: 'never-retain-this-credential',
    });
    expect(h.kernel.trackedWorkloadIds()).toEqual([]);
    expect(await h.manifest()).not.toContain(workloadId);
    expect(h.cleanup.observations()).toEqual([
      { label: `workload ${workloadId}`, completed: true },
    ]);
    expect(h.artifacts.get(`vm-${workloadId}-native-cleanup`)).toMatchObject({
      observations: [
        {
          cloudId,
          region: 'us-east-2',
          availabilityZone: 'b',
          presence: 'absent',
        },
        {
          cloudId: secondCloudId,
          region: 'us-east-2',
          availabilityZone: 'b',
          presence: 'absent',
        },
      ],
    });
    await h.native.recordObservations();
    const evidence = JSON.stringify([...h.artifacts.values()]);
    expect(evidence).not.toContain('secretAccessKey');
    expect(evidence).not.toContain('never-retain-this-credential');
    expect(evidence).not.toContain('changed-after-registration');
    const stored = new ArtifactStore(
      path.join(h.directory, 'redacted-artifacts'),
      new Redactor(),
    );
    const metadataFile = await stored.json(
      'native-cleanup',
      h.artifacts.get(`vm-${workloadId}-native-cleanup`),
    );
    expect(JSON.parse(await readFile(metadataFile, 'utf8'))).toHaveProperty(
      'originalIdentity.profileRowId',
      'credential-original',
    );
  });

  test('an aborted primary operation does not cancel native fallback verification', async () => {
    const h = await harness();
    await h.start();
    h.setRows([attempt()]);
    h.primary.abort(new Error('primary cancelled'));
    await h.cleanup.run();
    expect(h.observe).toHaveBeenCalledOnce();
    expect(h.observe.mock.calls[0][1]?.signal).toBe(h.teardown.signal);
    expect(h.kernel.trackedWorkloadIds()).toEqual([]);
  });

  test('cleanup cancellation cannot establish absence or release the manifest', async () => {
    const h = await harness();
    await h.start();
    h.setRows([attempt()]);
    h.teardown.abort(new Error('cleanup cancelled'));
    await expect(h.cleanup.run()).rejects.toThrow('cleanup cancelled');
    expect(h.observe).not.toHaveBeenCalled();
    expect(await h.manifest()).toContain(workloadId);
  });

  test('preserves known identities and earlier native observations when a later host fails', async () => {
    const h = await harness();
    await h.start();
    h.setRows([attempt(), attempt({ id: 2, cloud_id: secondCloudId })]);
    await h.native.capture(h.ref);
    h.observe.mockImplementationOnce(async (location) => ({
      cloudId: location.cloudId,
      provider: CloudType.AWS,
      presence: 'absent',
      diagnostic: 'AWS terminated',
    }));
    h.observe.mockImplementationOnce(async () => {
      throw new Error('Native authentication failed');
    });
    await expect(h.cleanup.run()).rejects.toThrow(
      'Native authentication failed',
    );
    expect(h.artifacts.get(`vm-${workloadId}-native-cleanup`)).toMatchObject({
      completed: false,
      observations: [{ cloudId, presence: 'absent' }],
      attemptHistory: [
        expect.objectContaining({ cloudId }),
        expect.objectContaining({ cloudId: secondCloudId }),
      ],
    });
    expect(await h.manifest()).toContain(workloadId);
  });

  test('retains status identities before a later database failure and API cleanup failure', async () => {
    const h = await harness();
    await h.start();
    h.setReadFailure(new Error('complete database response unavailable'));
    const status: StatusResponse = {
      workload: persistentVmWorkload(workloadId),
      events: [],
      status: WorkloadHealthStatus.Up,
      vms: [
        {
          ip: '203.0.113.2',
          cloudId,
          region: 'us-east-2',
          availabilityZone: 'b',
          endedAt: null,
        },
      ],
    };
    await expect(h.native.capture(h.ref, status)).rejects.toThrow(
      'database response unavailable',
    );
    h.setApiFailure(new Error('cleanup API unavailable'));
    await expect(h.cleanup.run()).rejects.toThrow('cleanup API unavailable');
    await h.native.recordObservations();
    expect(h.artifacts.get(`vm-${workloadId}-native-identities`)).toMatchObject(
      {
        statusIdentities: [
          { cloudId, region: 'us-east-2', availabilityZone: 'b' },
        ],
        verificationStarted: false,
      },
    );
    expect(await h.manifest()).toContain(workloadId);
  });

  test.each([
    ['Workload', { workload_id: 'foreign-vm' }],
    ['credential', { credential_id: 'other-credential' }],
    ['provider', { cloud_provider: CloudType.GCP }],
    ['region', { region: 'us-west-1' }],
    ['timestamp', { ended_at: 9 }],
    ['empty timestamp', { created_at: '' }],
    ['whitespace timestamp', { ended_at: ' ' }],
    ['exponent row ID', { id: '1e1' }],
  ] as const)(
    'rejects a foreign or invalid %s without using it to establish absence',
    async (_label, overrides) => {
      const h = await harness();
      await h.start();
      h.setRows([attempt(overrides)]);
      await expect(h.cleanup.run()).rejects.toThrow();
      expect(h.observe).not.toHaveBeenCalled();
      expect(await h.manifest()).toContain(workloadId);
    },
  );

  test('duplicate and partial inventories cannot discard an earlier validated identity', async () => {
    const h = await harness();
    await h.start();
    h.setRows([attempt(), attempt({ cloud_id: secondCloudId })]);
    await expect(h.native.capture(h.ref)).rejects.toThrow(
      'duplicate identities',
    );
    h.setReadFailure(new Error('inventory unavailable'));
    await expect(h.cleanup.run()).rejects.toThrow('inventory unavailable');
    await h.native.recordObservations();
    expect(h.artifacts.get(`vm-${workloadId}-native-identities`)).toMatchObject(
      { attemptHistory: [expect.objectContaining({ cloudId })] },
    );
    expect(await h.manifest()).toContain(workloadId);
  });

  test.each(['lost', 'rewritten'] as const)(
    'a %s adopted identity prevents cleanup proof',
    async (change) => {
      const h = await harness();
      await h.start();
      h.setRows([attempt()]);
      await h.native.capture(h.ref);
      h.setRows(
        change === 'lost' ? [] : [attempt({ cloud_id: secondCloudId })],
      );
      await expect(h.cleanup.run()).rejects.toThrow(
        change === 'lost'
          ? 'lost a previously observed'
          : 'rewrote original native coordinates',
      );
      expect(await h.manifest()).toContain(workloadId);
    },
  );

  test('an unresolved reservation cannot be passed to a provider as a native ID', async () => {
    const h = await harness();
    await h.start();
    h.setRows([attempt({ cloud_id: 'request-token', ip: null })]);
    await expect(h.cleanup.run()).rejects.toThrow(
      'unresolved native provisioning identity',
    );
    expect(h.observe).not.toHaveBeenCalled();
    expect(await h.manifest()).toContain(workloadId);
  });

  test('keeps a provisional native identity after the same row adopts another host', async () => {
    const h = await harness();
    await h.start();
    h.setRows([attempt({ ip: null, ended_at: null })]);
    await h.native.capture(h.ref);
    h.setRows([attempt({ cloud_id: secondCloudId, created_at: 12 })]);
    await h.cleanup.run();
    expect(h.observe.mock.calls.map(([location]) => location.cloudId)).toEqual([
      cloudId,
      secondCloudId,
    ]);
  });
});

describe('complete VM cleanup inputs', () => {
  test.each(['malformed stdout', 'failure stderr'])(
    'strict inventory omits an unregistered credential from %s before writing process artifacts',
    async (failure) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'native-db-artifacts-'),
      );
      onTestFinished(() => rm(directory, { recursive: true, force: true }));
      const canary = 'synthetic-unregistered-notebook-credential';
      const body = JSON.stringify({
        rows: [],
        rowCount: 0,
        truncated: false,
        notebookCredential: canary,
      });
      const fakeCli = path.join(directory, 'fake-cli.cjs');
      await writeFile(
        fakeCli,
        `#!${process.execPath}\n` +
          (failure === 'malformed stdout'
            ? `process.stdout.write(${JSON.stringify(body)});\n`
            : `process.stderr.write(${JSON.stringify(canary)}); process.exitCode = 1;\n`),
        { mode: 0o700 },
      );
      const artifacts = new ArtifactStore(
        path.join(directory, 'artifacts'),
        new Redactor(),
      );
      await artifacts.initialize({
        testName: 'strict inventory',
        runId: 'test',
        startedAt: new Date().toISOString(),
      });
      const signal = new AbortController().signal;
      const cli = new CliClient(
        new ProcessRunner(artifacts, signal, directory),
        process.cwd(),
        directory,
        'http://127.0.0.1:1',
        'unused-test-token',
        signal,
        fakeCli,
      );
      await expect(
        new CliDatabase(cli).queryComplete(
          'SELECT id FROM vms',
          'native-inventory',
        ),
      ).rejects.toThrow(
        failure === 'malformed stdout'
          ? 'incomplete or invalid'
          : 'did not complete',
      );
      const retained = await Promise.all(
        (await readdir(artifacts.directory)).map((file) =>
          readFile(path.join(artifacts.directory, file), 'utf8'),
        ),
      );
      expect(retained.join('\n')).not.toContain(canary);
    },
  );

  test.each([
    ['process truncation', { outputTruncated: true }],
    ['signal', { signal: 'SIGTERM' as const }],
    ['null exit', { exitCode: null }],
    ['spawn error', { spawnError: 'failed to spawn' }],
    ['timeout', { timedOut: true }],
    ['cancellation', { aborted: true }],
    ['authentication', { exitCode: 1, stderr: 'authentication failed' }],
  ])(
    'rejects %s even when partial stdout resembles a complete empty inventory',
    async (_name, fault) => {
      const database = new CliDatabase({
        run: async (args) => ({
          ...receipt(args, { rows: [], rowCount: 0, truncated: false }),
          ...fault,
        }),
      });
      await expect(
        database.queryComplete('SELECT id FROM vms', 'test'),
      ).rejects.toThrow('did not complete');
    },
  );

  test.each([
    { rows: [], rowCount: 1, truncated: false },
    { rows: [], rowCount: 0, truncated: true },
    { rows: [null], rowCount: 1, truncated: false },
    { rows: [] },
  ])('rejects incomplete database envelope %j', async (value) => {
    const database = new CliDatabase({
      run: async (args) => receipt(args, value),
    });
    await expect(
      database.queryComplete('SELECT id FROM vms', 'test'),
    ).rejects.toThrow('incomplete or invalid');
  });

  test('a stalled inventory remains bounded by the caller deadline', async () => {
    const database = new CliDatabase({
      run: async () => new Promise<CommandResult>(() => undefined),
    });
    const result = await Promise.race([
      database
        .queryComplete('SELECT id FROM vms', 'stalled', Date.now() + 20)
        .then(
          () => 'resolved',
          () => 'rejected',
        ),
      new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('still pending'), 500);
        timer.unref();
      }),
    ]);
    expect(result).toBe('rejected');
  });

  test('Local absence uses an exact adopted ID and rejects duplicate or malformed full inventories', async () => {
    const machine = {
      name: 'adopted-native-machine',
      state: 'running',
      ports: [],
    };
    const get = vi.fn(async () => ({ status: 200, body: [machine] }));
    expect(
      await observeLocalSmolvmHost(
        { get },
        new URL('http://127.0.0.1:18089'),
        machine.name,
      ),
    ).toMatchObject({ presence: 'present', cloudId: machine.name });
    expect(get.mock.calls[0]).toHaveLength(3);
    for (const body of [
      [machine, machine],
      { machines: [], error: 'inventory unavailable' },
      { machines: [], next: 'more' },
      [null],
    ])
      await expect(
        observeLocalSmolvmHost(
          { get: async () => ({ status: 200, body }) },
          new URL('http://127.0.0.1:18089'),
          machine.name,
        ),
      ).rejects.toThrow();
    await expect(
      observeLocalSmolvmHost(
        {
          get: async (_label, _url, options) => {
            expect(options?.redirect).toBe('error');
            return { status: 302, body: [] };
          },
        },
        new URL('http://127.0.0.1:18089'),
        machine.name,
      ),
    ).rejects.toThrow('HTTP 200');
  });
});

describe('AWS reservation cleanup with original attempt coordinates', () => {
  function tokenRow(overrides: Record<string, unknown> = {}) {
    return attempt({
      cloud_id: `${workloadId}-0`,
      ip: null,
      availability_zone: null,
      ...overrides,
    });
  }

  function tokenInventory(id = cloudId) {
    return {
      Reservations: [
        {
          Instances: [
            {
              InstanceId: id,
              ClientToken: `${workloadId}-0`,
              State: { Name: 'terminated' },
              Placement: { AvailabilityZone: 'us-east-2b' },
            },
          ],
        },
      ],
    };
  }

  function stableWait(
    h: Awaited<ReturnType<typeof harness>>,
    beforeSecond: () => void = () => {},
  ) {
    const before = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(before);
    onTestFinished(() => clock.mockRestore());
    const wait = h.waiter.for.bind(h.waiter);
    vi.spyOn(h.waiter, 'for').mockImplementation(
      async (label, probe, options) => {
        if (!label.startsWith('all native VM hosts absent'))
          return wait(label, probe, options);
        const deadline = before + options.timeoutMs;
        expect(options.unmet(await probe(deadline))).toBe(
          'Provisioning attempt presence remains present or unknown',
        );
        beforeSecond();
        clock.mockReturnValue(before + 10_000);
        const final = await probe(deadline);
        const unmet = options.unmet(final);
        if (unmet !== undefined) throw new Error(unmet);
        return final;
      },
    );
  }

  test('joins the earlier us-east-1 reservation with the us-east-2 GPU host before the Service verifier and release', async () => {
    const profile: VmProfile = {
      slug: 'aws',
      provider: CloudType.AWS,
      credentialName: 'aws-test',
      credential: {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'original-access',
        secretAccessKey: 'original-secret',
      },
      vmTypes: ['g6e.xlarge'],
      diskSizeGb: 100,
    };
    const verify = vi.fn(async () => {
      expect(h.kernel.trackedWorkloadIds()).toEqual([workloadId]);
      expect(await h.manifest()).toContain(workloadId);
      expect(h.observe).toHaveBeenCalledTimes(2);
      expect(h.nativeRun).toHaveBeenCalledTimes(2);
    });
    const h = await harness('aws', { profile, verify }, 30_000);
    await h.start();
    h.setRows([
      tokenRow({ region: 'us-east-1', vm_type: 'g6e.xlarge' }),
      attempt({
        id: 2,
        region: 'us-east-2',
        availability_zone: '2c',
        vm_type: 'g6e.xlarge',
      }),
    ]);
    await h.native.capture(h.ref);
    if (profile.credential.cloudProvider !== CloudType.AWS)
      throw new Error('test credential');
    profile.credential.secretAccessKey = 'replacement-secret';
    h.setPresence('present');
    stableWait(h, () => {
      expect(verify).not.toHaveBeenCalled();
      h.setPresence('absent');
    });
    h.primary.abort(new Error('foreground cancelled'));
    await h.cleanup.run();
    expect(verify).toHaveBeenCalledOnce();
    expect(h.kernel.trackedWorkloadIds()).toEqual([]);
    expect(await h.manifest()).toBe('');
    for (const [, args, options] of h.nativeRun.mock.calls) {
      expect(args[args.indexOf('--region') + 1]).toBe('us-east-1');
      expect(JSON.parse(args[args.indexOf('--filters') + 1]!)).toEqual([
        { Name: 'client-token', Values: [`${workloadId}-0`] },
      ]);
      expect(options?.env?.AWS_SECRET_ACCESS_KEY).toBe('original-secret');
      expect(options?.signal?.aborted).toBe(true);
    }
    expect(h.observe.mock.calls.map(([location]) => location)).toEqual([
      expect.objectContaining({
        cloudId,
        region: 'us-east-2',
        availabilityZone: '2c',
      }),
      expect.objectContaining({
        cloudId,
        region: 'us-east-2',
        availabilityZone: '2c',
      }),
    ]);
    expect(h.artifacts.get(`vm-${workloadId}-native-cleanup`)).toMatchObject({
      completed: true,
      attemptHistory: [
        expect.objectContaining({
          cloudId: `${workloadId}-0`,
          region: 'us-east-1',
        }),
        expect.objectContaining({ cloudId, region: 'us-east-2' }),
      ],
      reservationObservations: expect.arrayContaining([
        expect.objectContaining({
          credentialName: 'aws-test',
          inventory: { pages: 1, instances: 0, complete: true },
          attempts: [
            {
              attemptId: `${workloadId}-0`,
              region: 'us-east-1',
              availabilityZone: null,
              presence: 'absent',
              instanceIds: [],
            },
          ],
        }),
      ]),
    });
    expect(JSON.stringify([...h.artifacts.values()])).not.toContain(
      'original-secret',
    );
  });

  test.each(['absent', 'present', 'unknown'] as const)(
    'retains a historical token after adoption and joins its exact native %s observation',
    async (presence) => {
      const h = await harness();
      await h.start();
      h.setRows([tokenRow({ ended_at: null })]);
      await h.native.capture(h.ref);
      h.setRows([attempt({ created_at: 12 })]);
      h.setPresence(presence);
      h.nativeRun.mockImplementation(async (executable, args) => ({
        ...receipt(args, tokenInventory()),
        executable,
      }));
      if (presence === 'absent') await h.cleanup.run();
      else
        await expect(h.cleanup.run()).rejects.toThrow(
          'native VM presence remains present or unknown',
        );
      expect(h.nativeRun).toHaveBeenCalledOnce();
      expect(h.artifacts.get(`vm-${workloadId}-native-cleanup`)).toMatchObject({
        completed: presence === 'absent',
        attemptHistory: [
          expect.objectContaining({
            rowId: 1,
            cloudId: `${workloadId}-0`,
            endedAt: null,
          }),
          expect.objectContaining({ rowId: 1, cloudId, endedAt: 20 }),
        ],
        reservationObservations: expect.arrayContaining([
          expect.objectContaining({
            inventory: { pages: 1, instances: 1, complete: true },
            attempts: [
              expect.objectContaining({
                attemptId: `${workloadId}-0`,
                presence: 'present',
                instanceIds: [cloudId],
              }),
            ],
          }),
        ]),
      });
      expect((await h.manifest()).includes(workloadId)).toBe(
        presence !== 'absent',
      );
    },
  );

  test('a terminated token match cannot borrow a different attempt row to release tracking', async () => {
    const h = await harness();
    await h.start();
    h.setRows([tokenRow(), attempt({ id: 2 })]);
    h.nativeRun.mockImplementation(async (executable, args) => ({
      ...receipt(args, tokenInventory()),
      executable,
    }));
    await expect(h.cleanup.run()).rejects.toThrow(
      'native instance without ledger coordinates',
    );
    expect(h.observe).toHaveBeenCalledOnce();
    expect(h.kernel.trackedWorkloadIds()).toEqual([workloadId]);
    expect(await h.manifest()).toContain(workloadId);
    expect(h.artifacts.get(`vm-${workloadId}-native-cleanup`)).toMatchObject({
      completed: false,
      reservationObservations: expect.arrayContaining([
        expect.objectContaining({
          attempts: [expect.objectContaining({ instanceIds: [cloudId] })],
        }),
      ]),
    });
  });

  test('later inventory failure preserves discovered IDs, original scope and the outstanding manifest', async () => {
    const h = await harness();
    await h.start();
    h.setRows([tokenRow()]);
    h.nativeRun
      .mockImplementationOnce(async (executable, args) => ({
        ...receipt(args, { ...tokenInventory(), NextToken: 'page-2' }),
        executable,
      }))
      .mockImplementationOnce(async (executable, args) => ({
        ...receipt(args, {}),
        executable,
        exitCode: 1,
        stdout: '',
        stderr: 'AuthFailure: unregistered-secret',
        combined: 'AuthFailure: unregistered-secret',
      }));
    await expect(h.cleanup.run()).rejects.toThrow(
      'AWS authentication or request identity was rejected',
    );
    expect(await h.manifest()).toContain(workloadId);
    expect(h.artifacts.get(`vm-${workloadId}-native-cleanup`)).toMatchObject({
      completed: false,
      originalIdentity: { profileRowId: 'credential-original' },
      reservationObservations: [
        {
          kind: 'exact-attempt-current-presence',
          credentialName: 'aws-test',
          inventory: { pages: 1, instances: 1, complete: false },
          attempts: [
            {
              attemptId: `${workloadId}-0`,
              region: 'us-east-2',
              availabilityZone: null,
              presence: 'present',
              instanceIds: [cloudId],
            },
          ],
        },
      ],
    });
    expect(JSON.stringify([...h.artifacts.values()])).not.toContain(
      'unregistered-secret',
    );
  });

  test.each([
    'credential',
    'region',
    'zone',
    'kind',
    'incomplete',
    'future timestamp',
  ] as const)(
    'a foreign %s reservation receipt cannot release the Workload',
    async (fault) => {
      const h = await harness();
      await h.start();
      h.setRows([tokenRow()]);
      const observer = h.create.mock.results[0]!.value;
      vi.spyOn(observer, 'observeReservations').mockImplementation(
        async () => ({
          kind:
            fault === 'kind'
              ? ('foreign' as 'exact-attempt-current-presence')
              : 'exact-attempt-current-presence',
          credentialName: fault === 'credential' ? 'replacement' : 'aws-test',
          observedAt: Date.now() + (fault === 'future timestamp' ? 10_000 : 0),
          provider: CloudType.AWS,
          diagnostic: 'synthetic current presence',
          inventory: {
            pages: 1,
            instances: 0,
            complete: fault !== 'incomplete',
          },
          attempts: [
            {
              attemptId: `${workloadId}-0`,
              region: fault === 'region' ? 'us-east-1' : 'us-east-2',
              availabilityZone: fault === 'zone' ? 'b' : null,
              presence: 'absent',
              instanceIds: [],
            },
          ],
        }),
      );
      await expect(h.cleanup.run()).rejects.toThrow(
        'foreign or incomplete reservation evidence',
      );
      expect(await h.manifest()).toContain(workloadId);
      expect(h.kernel.trackedWorkloadIds()).toEqual([workloadId]);
    },
  );
});

// The SDK acknowledges a real stored request, the real optimizer owns the
// verdict, and the existing strict database/kernel/native owners read it back.
async function invalidAdmissionHarness() {
  resetPersistence();
  const id = 'azure-invalid-owned';
  const vmType = 'Standard_ND96isr_MI300X_v5';
  const image =
    'mirror.gcr.io/nvidia/cuda@sha256:8767a245ed2c481eb245d8f6c625accc3788e1fb8612403d6b4cd4645a4f09c7';
  const credential = {
    cloudProvider: CloudType.Azure,
    applicationId: 'original-app',
    secret: 'private-original-azure-secret',
    directoryId: 'original-directory',
    subscriptionId: 'original-subscription',
  } as const;
  const credentialId = hashCredential(cloudCredentialSchema.parse(credential));
  const profile: VmProfile = {
    slug: 'azure',
    provider: CloudType.Azure,
    credentialName: 'original-azure',
    credential,
    vmTypes: [vmType],
    region: 'eastus2',
  };
  await getCredentialSecretStore().saveNamedCredential(
    profile.credentialName,
    credentialId,
    await encryptCredential(credential),
    CloudType.Azure,
  );
  const body: WorkloadCreateBody = {
    id,
    image,
    workloadType: 'job',
    credentialName: profile.credentialName,
    cloudConfig: { cloudProvider: CloudType.Azure, vmType, region: 'eastus2' },
  };
  const directory = await mkdtemp(path.join(tmpdir(), 'pre-provision-owner-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const artifacts = new Map<string, unknown>();
  let posts = 0;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/workloads')
        throw new Error('Unexpected test request');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(body);
      posts += 1;
      await createWorkload(getDB(), {
        id,
        userId: 'test-user',
        workloadType: 'job',
        image,
        imageRuntime: ImageRuntime.Cuda,
        region: 'eastus2',
        vmType,
        credentialId,
        requestedComputeProvider: CloudType.Azure,
        dockerCommand: 'docker run fixture',
        sshPrivateKey: 'fixture-key',
      });
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id }));
    } catch (error) {
      response.writeHead(500);
      response.end(error instanceof Error ? error.message : 'Fixture error');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing loopback endpoint');
  const endpoint = new ControllerEndpoint(`http://127.0.0.1:${address.port}`);
  const redactor = new Redactor();
  const api = new ApiClient(
    endpoint,
    'fixture-token',
    new ArtifactStore(path.join(directory, 'api'), redactor),
    redactor,
  );
  const cleanup = new CleanupStack();
  const wait = new SingleProbeWaiter();
  let incompleteEvents = false;
  const run = vi.fn(async (args: readonly string[]) => {
    if (args[0] === 'terminate') {
      await getWorkloadOutcomes().markCleanupComplete(id);
      return receipt(args, {});
    }
    const sql = args.at(-1)!;
    const rows = await getDB().query<Record<string, unknown>>(sql);
    return receipt(args, {
      rows,
      rowCount: rows.length,
      truncated: incompleteEvents && sql.includes('FROM workload_events'),
    });
  });
  const lookupStatus = async () => {
    const row = await queries().getWorkload(id);
    if (!row) return { kind: 'absent' as const };
    const status: StatusResponse = {
      workload: persistentVmWorkload(id, {
        workloadType: 'job',
        cloudProvider: CloudType.Azure,
        state: row.state,
        completedAt: row.completedAt,
        cleanedAt: row.cleanedAt,
        vmCount: 0,
      }),
      events: [],
      vms: [],
      status: WorkloadHealthStatus.Up,
    };
    native.recordAdmissionStatus(id, status);
    return { kind: 'found' as const, status };
  };
  const cli = { run, runWithTransientRetries: run };
  const kernel = new TrackedWorkloadKernel(
    { lookupStatus },
    cli,
    cleanup,
    wait,
    directory,
  );
  const observe = vi.fn(async () => {
    throw new Error('Invalid admission must not ask a provider');
  });
  const native = new PersistentVmCleanup({
    kernel,
    endpoint,
    database: new CliDatabase(cli),
    profiles: { vm: () => profile },
    hosts: { create: () => ({ observe, observeReservations: observe }) },
    http: { get: vi.fn() },
    wait,
    signal: new AbortController().signal,
    artifacts: {
      json: async (name, value) => {
        artifacts.set(name, structuredClone(value));
        return path.join(directory, `${name}.json`);
      },
    },
  });
  const ref = await native.reserve('azure', id, 1_000);
  await native.creationStarted(ref, {
    observeAdmissionRejection: true,
    invalidRequest: body,
  });
  const mutations = new WorkloadMutationTransport(kernel, api, cli);
  const acknowledgement = await mutations.createWithApi(ref, body);
  const stored = await queries().getWorkload(id);
  if (!stored) throw new Error('Acknowledged Workload was not stored');
  const makeGateway = vi.fn(() => makeMockCloudCompute());
  const guard = await resolveProvisioningTarget(
    stored,
    {
      cloudProvider: CloudType.Azure,
      credentials: credential,
      region: 'eastus2',
      vmType,
    },
    queries(),
    makeGateway,
    credentialId,
  );
  expect(guard.state).toBe(WorkloadState.Invalid);
  expect(makeGateway).not.toHaveBeenCalled();
  if (guard.state !== WorkloadState.Invalid)
    throw new Error('Named guard did not reject');
  expect(
    await getWorkloadOutcomes().publishTerminalOutcome(
      id,
      guard.state,
      WorkloadState.Queued,
      {
        metadata: { message: guard.message },
      },
    ),
  ).not.toBeNull();
  return {
    id,
    credentialId,
    vmType,
    body,
    endpoint,
    acknowledgement,
    native,
    kernel,
    cleanup,
    ref,
    artifacts,
    observe,
    setIncompleteEvents() {
      incompleteEvents = true;
    },
    record: () => native.recordAdmissionInvalid(ref, acknowledgement),
    posts: () => posts,
  };
}

describe('Shared pre-provision admission through the real guard and cleanup owner', () => {
  test('releases only the acknowledged Queued-to-Invalid Azure image guard after strict cleanup recheck', async () => {
    const h = await invalidAdmissionHarness();
    await h.record();
    await h.cleanup.run();
    expect(h.posts()).toBe(1);
    expect(h.kernel.trackedWorkloadIds()).toEqual([]);
    expect(h.observe).not.toHaveBeenCalled();
    expect(h.artifacts.get(`vm-${h.id}-native-cleanup`)).toMatchObject({
      completed: true,
      nonCreationVerifiedAt: expect.any(Number),
      attemptHistory: [],
      preProvisionAdmission: {
        workloadHistory: {
          events: [
            {
              state: WorkloadState.Invalid,
              guardMessage: expect.stringContaining('CUDA GPU runtime'),
            },
          ],
        },
      },
    });
    expect(JSON.stringify([...h.artifacts.values()])).not.toContain(
      'private-original-azure-secret',
    );
  });

  test('does not turn an unacknowledged or lost reply into absence despite the guarded Invalid row', async () => {
    const h = await invalidAdmissionHarness();
    await expect(
      h.native.recordAdmissionRejection(h.ref, new TypeError('lost reply')),
    ).rejects.toThrow('declared admission rejection');
    await expect(h.cleanup.run()).rejects.toThrow(
      'no complete native identity inventory',
    );
    expect(h.kernel.trackedWorkloadIds()).toEqual([h.id]);
    expect(h.observe).not.toHaveBeenCalled();
  });

  test.each([
    'arbitrary Invalid',
    'Provisioning',
    'Retrying',
    'missing Invalid event',
    'ended reservation',
    'ended native attempt',
  ])(
    'retains the obligation for %s despite an empty current VM set',
    async (contradiction) => {
      const h = await invalidAdmissionHarness();
      if (contradiction === 'arbitrary Invalid') {
        await getDB().query(
          'UPDATE workload_events SET metadata = ? WHERE workload_id = ? AND state = ?',
          [
            JSON.stringify({ message: 'private arbitrary failure' }),
            h.id,
            WorkloadState.Invalid,
          ],
        );
      } else if (contradiction === 'missing Invalid event') {
        await getDB().query(
          'DELETE FROM workload_events WHERE workload_id = ? AND state = ?',
          [h.id, WorkloadState.Invalid],
        );
      } else if (
        contradiction === 'Provisioning' ||
        contradiction === 'Retrying'
      ) {
        await getDB().query(
          'INSERT INTO workload_events (workload_id, state, created_at) VALUES (?, ?, ?)',
          [
            h.id,
            contradiction === 'Provisioning'
              ? WorkloadState.Provisioning
              : WorkloadState.Retrying,
            Date.now(),
          ],
        );
      } else {
        await getDB().query(
          'INSERT INTO vms (workload_id, credential_id, cloud_id, region, vm_type, created_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [
            h.id,
            h.credentialId,
            contradiction === 'ended reservation' ? `${h.id}-1` : 'native-vm',
            'eastus2',
            h.vmType,
            Date.now(),
            Date.now(),
          ],
        );
      }
      await expect(h.record()).rejects.toThrow(
        /Pre-provision admission remains unresolved/,
      );
      await expect(h.cleanup.run()).rejects.toThrow();
      await h.native.recordObservations();
      expect(h.kernel.trackedWorkloadIds()).toEqual([h.id]);
      expect(h.observe).not.toHaveBeenCalled();
      if (contradiction.startsWith('ended'))
        expect(h.artifacts.get(`vm-${h.id}-native-identities`)).toMatchObject({
          attemptHistory: [
            expect.objectContaining({ endedAt: expect.any(Number) }),
          ],
        });
      expect(JSON.stringify([...h.artifacts.values()])).not.toContain(
        'private arbitrary failure',
      );
    },
  );

  test('preserves earlier validated events when the cleanup event inventory becomes partial', async () => {
    const h = await invalidAdmissionHarness();
    await h.record();
    h.setIncompleteEvents();
    await expect(h.cleanup.run()).rejects.toThrow('incomplete or invalid');
    expect(h.artifacts.get(`vm-${h.id}-native-cleanup`)).toMatchObject({
      completed: false,
      preProvisionAdmission: {
        historyIncomplete: true,
        workloadHistory: {
          complete: false,
          events: [{ state: WorkloadState.Invalid }],
        },
      },
    });
    expect(h.kernel.trackedWorkloadIds()).toEqual([h.id]);
  });

  test('refuses replacement of the original controller even at the same URL', async () => {
    const h = await invalidAdmissionHarness();
    h.endpoint.attach(h.endpoint.snapshot()!.url);
    await expect(h.record()).rejects.toThrow('changed generation');
    expect(h.kernel.trackedWorkloadIds()).toEqual([h.id]);
    expect(h.observe).not.toHaveBeenCalled();
  });

  test('requires cleanup confirmation and rejects a later attempt after the initial guard observation', async () => {
    const h = await invalidAdmissionHarness();
    await h.record();
    await getDB().query(
      'INSERT INTO vms (workload_id, credential_id, cloud_id, region, vm_type, created_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        h.id,
        h.credentialId,
        `${h.id}-2`,
        'eastus2',
        h.vmType,
        Date.now(),
        Date.now(),
      ],
    );
    await expect(h.cleanup.run()).rejects.toThrow('retained native history');
    expect(h.kernel.trackedWorkloadIds()).toEqual([h.id]);
    expect(h.observe).not.toHaveBeenCalled();
  });

  test.each(['credential row', 'runtime', 'VM type', 'terminal timestamp'])(
    'refuses a guard message whose stored %s no longer matches',
    async (field) => {
      const h = await invalidAdmissionHarness();
      if (field === 'credential row') {
        await getDB().query(
          'INSERT INTO credentials (id, encrypted_data, cloud_provider) VALUES (?, ?, ?)',
          ['foreign-credential', '', CloudType.Azure],
        );
        await getDB().query(
          'UPDATE workloads SET credential_id = ? WHERE id = ?',
          ['foreign-credential', h.id],
        );
      } else if (field === 'runtime') {
        await getDB().query(
          'UPDATE workloads SET image_runtime = ? WHERE id = ?',
          [ImageRuntime.Unknown, h.id],
        );
      } else if (field === 'VM type') {
        await getDB().query('UPDATE workloads SET vm_type = ? WHERE id = ?', [
          'Standard_D2s_v5',
          h.id,
        ]);
      } else {
        await getDB().query(
          'UPDATE workloads SET completed_at = completed_at - 1 WHERE id = ?',
          [h.id],
        );
      }
      await expect(h.record()).rejects.toThrow();
      expect(h.kernel.trackedWorkloadIds()).toEqual([h.id]);
      expect(h.observe).not.toHaveBeenCalled();
    },
  );

  test('keeps a valid Invalid observation pending until its original Workload cleanup is confirmed', async () => {
    const h = await invalidAdmissionHarness();
    await h.record();
    await expect(h.native.verify(h.ref, 1_000)).rejects.toThrow(
      'terminal outcome, or cleanup',
    );
    expect(h.kernel.trackedWorkloadIds()).toEqual([h.id]);
    expect(h.observe).not.toHaveBeenCalled();
  });
});
