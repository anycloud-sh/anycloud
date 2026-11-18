import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { StatusWorkloadMetadata } from '../../src/shared/api-contract/workload-management-schemas.js';
import { CloudType } from '../../src/shared/cloud.js';
import { WorkloadState, WorkloadType } from '../../src/shared/workload.js';
import { WorkloadHealthStatus } from '../../src/shared/runtime.js';
import { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import { ServeBaselineContract } from '../integration/e2e/internal/contracts/serve-baseline.js';
import {
  acceptedUpgradeCheckpoint,
  ServeUpgradeContract,
} from '../integration/e2e/internal/contracts/serve-upgrade.js';
import type { TrackedWorkloadRef } from '../integration/e2e/internal/workloads.js';
import { EnvironmentProbeFixture } from '../integration/e2e/internal/probes/environment.js';
import { NamedSecretProbeFixture } from '../integration/e2e/internal/probes/named-secret.js';
import { PublicCloudServeAdapter } from '../integration/e2e/internal/targets/public-cloud-serve.js';
import { ServeTargetFactory } from '../integration/e2e/internal/targets/serve.js';
import type {
  PublicCloudServeProfile,
  ServeBackingHost,
  ServeDnsAbsenceObservation,
  ServeHostAbsence,
  ServeSubmission,
  ServeTarget,
  ServeTargetAdapter,
} from '../integration/e2e/internal/targets/serve-types.js';
import type { VmProvider } from '../integration/e2e/internal/profiles.js';
import type { CliRunOptions } from '../integration/e2e/internal/cli.js';
import type { StatusResponse } from '../integration/e2e/internal/types.js';
import type { VmLedgerSnapshot } from '../integration/e2e/internal/vm-ledger.js';
import { snapshotStatusVmLedger } from '../integration/e2e/internal/vm-ledger.js';
import type { WaitOptions } from '../integration/e2e/internal/wait.js';
import {
  cleanupRecordedForTest,
  substrateAbsentForTest,
  trackedWorkloadRefForTest,
  vmLedgerClearedForTest,
} from './helpers/e2e.js';

const CLOUD_ID = 'i-serve-host-1';
const REPLACEMENT_CLOUD_ID = 'i-serve-host-2';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function workload(
  id: string,
  state: WorkloadState,
  dnsRecordId: string | null,
  cleanedAt: number | null,
): StatusWorkloadMetadata {
  return {
    id,
    userId: 'e2e-user',
    deploymentId: null,
    submissionRevision: 0,
    claimDeadlineAt: null,
    claimed: false,
    workloadType: WorkloadType.Service,
    image: 'python:3.12-alpine',
    cloudProvider: CloudType.AWS,
    region: 'us-east-1',
    vmType: 't3.small',
    gpuType: null,
    spot: false,
    state,
    startedAt: 1,
    completedAt: state === WorkloadState.Terminated ? 100 : null,
    cleanedAt,
    endReason: null,
    lastAttemptEndReason: null,
    version: '1.0.0',
    dockerCommand: '',
    inputBucket: null,
    outputBucket: null,
    checkpointBucket: null,
    diskSizeGb: 50,
    diskTier: null,
    diskIops: null,
    diskThroughputMibps: null,
    regions: null,
    dockerOptions: null,
    availabilityZone: 'b',
    vmCount: 1,
    inputStorageRegion: null,
    outputStorageRegion: null,
    checkpointStorageRegion: null,
    command: null,
    imageDigest: null,
    vmDurationMs: null,
    awaitingReleaseMs: null,
    totalCost: null,
    costSource: null,
    dnsRecordId,
    secretNames: null,
    session: null,
    agent: null,
    sessionLabel: null,
    publicEndpoint: null,
  };
}

function status(
  id: string,
  state: WorkloadState,
  events: StatusResponse['events'],
  {
    cleanedAt = null,
    cloudId = CLOUD_ID,
    dnsRecordId = 'dns-1',
    live = true,
  }: {
    cleanedAt?: number | null;
    cloudId?: string;
    dnsRecordId?: string | null;
    live?: boolean;
  } = {},
): StatusResponse {
  return {
    workload: workload(id, state, dnsRecordId, cleanedAt),
    events,
    status: WorkloadHealthStatus.Up,
    vms: [
      {
        cloudId,
        ip: '203.0.113.7',
        region: 'us-east-1',
        availabilityZone: 'b',
        endedAt: live ? null : 200,
      },
    ],
  };
}

/** Probes up to `attempts` times without sleeping; one by default. */
class ProbeWaiter {
  constructor(private readonly attempts = 1) {}

  async for<T>(
    label: string,
    probe: (deadlineAt: number) => Promise<T>,
    options: WaitOptions<T>,
  ): Promise<T> {
    let unmet: string | undefined;
    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      const value = await probe(Date.now() + options.timeoutMs);
      const rejection = options.reject?.(value);
      if (rejection) throw new Error(`${label}: ${rejection}`);
      unmet = options.unmet(value);
      if (unmet === undefined) return value;
    }
    throw new Error(`${label}: observation was not accepted (${unmet})`);
  }
}

interface HarnessOptions {
  readonly absence?: readonly ServeHostAbsence[];
  readonly dnsRecordId?: string | null;
  readonly dns?: (hostname: string) => ServeDnsAbsenceObservation;
  readonly secretDelete?: () => Promise<void>;
  readonly kernelRelease?: () => Promise<void>;
  readonly cleanupTime?: number;
  readonly responseBody?: (markers: readonly string[]) => string;
  /** Simulates an upgrade that lands back on the original host. */
  readonly reuseHostOnUpgrade?: boolean;
  readonly upgradeChangesDns?: boolean;
  /** A plain upgrade never leaves Recovering. */
  readonly upgradeStalls?: boolean;
  /** The product keeps the previous image through an upgrade. */
  readonly upgradeKeepsImage?: boolean;
  /** Endpoint answers per probe; the last one repeats. */
  readonly statusCode?: number | readonly number[];
  /** Harness clock per read; the last one repeats. */
  readonly now?: number | readonly number[];
  /** Product time from the `starting` event to the `running` event. */
  readonly dwellMs?: number;
  readonly probeAttempts?: number;
  readonly publicationPending?: boolean;
  readonly upgradeRecordsTransition?: boolean;
  readonly restartFails?: boolean;
  readonly restartChangesContainer?: boolean;
  readonly forceCleanup?: boolean;
  readonly nativeVerify?: () => Promise<void>;
  readonly artifact?: (name: string, value: unknown) => Promise<void>;
  readonly bucketRelease?: () => Promise<void>;
  readonly holdRelease?: () => Promise<void>;
}

function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const cleanup = new CleanupStack();
  const submissions: (readonly string[])[] = [];
  const observedHosts: ServeBackingHost[][] = [];
  const dnsChecks: { hostname: string; state: WorkloadState | undefined }[] =
    [];
  const events: StatusResponse['events'] = [];
  let current: StatusResponse | undefined;
  let markers: readonly string[] = [];
  let initialMarkers: readonly string[] = [];
  let upgradedMarkers: readonly string[] | undefined;
  let cloudId = CLOUD_ID;
  let containerCommand: readonly string[] | null = null;
  let checkpointBucket: string | null = null;
  let checkpointStorageRegion: string | null = null;
  let activeProfile: PublicCloudServeProfile | undefined;
  let submittedImage = 'python:3.12-alpine';
  let submittedGpus: string | undefined;
  let submittedRuntime: string | undefined;
  const cloudTypes = {
    aws: CloudType.AWS,
    azure: CloudType.Azure,
    gcp: CloudType.GCP,
    lambda: CloudType.Lambda,
  };
  const applyContainer = (): void => {
    if (current)
      Object.assign(current.workload, {
        command: containerCommand,
        checkpointBucket,
        checkpointStorageRegion,
        image: submittedImage,
        dockerOptions: {
          ...(submittedGpus ? { gpus: submittedGpus } : {}),
          ...(submittedRuntime ? { runtime: submittedRuntime } : {}),
        },
        ...(activeProfile
          ? {
              cloudProvider: cloudTypes[activeProfile.provider],
              vmType: activeProfile.vmTypes[0],
              diskSizeGb: activeProfile.diskSizeGb ?? 50,
              region: activeProfile.region ?? 'us-east-1',
            }
          : {}),
      });
  };

  const sequence = (
    values: number | readonly number[] | undefined,
    fallback: number,
  ) => {
    let index = 0;
    return (): number => {
      if (values === undefined) return fallback;
      if (typeof values === 'number') return values;
      return values[Math.min(index++, values.length - 1)] ?? fallback;
    };
  };
  const nextStatusCode = sequence(options.statusCode, 200);
  let endpointProbes = 0;
  const nextNow = sequence(options.now, 0);
  const advance = (ref: TrackedWorkloadRef, state: WorkloadState): void => {
    // The fake product starts the container, dwells, then reports running.
    if (state === WorkloadState.Running) {
      record(ref.id, WorkloadState.Starting);
      record(ref.id, state, null, options.dwellMs ?? 30_500);
    } else record(ref.id, state);
    current = status(ref.id, state, [...events], {
      cloudId,
      dnsRecordId:
        options.dnsRecordId === undefined ? 'dns-1' : options.dnsRecordId,
      live: state !== WorkloadState.Terminated,
    });
    applyContainer();
  };
  const completeUpgrade = (): void => {
    if (!options.reuseHostOnUpgrade) cloudId = REPLACEMENT_CLOUD_ID;
    if (!current) throw new Error('no Service');
    record(current.workload.id, WorkloadState.Running);
    current = status(current.workload.id, WorkloadState.Running, [...events], {
      cloudId,
      dnsRecordId: options.upgradeChangesDns ? 'foreign-dns' : 'dns-1',
    });
    applyContainer();
    markers = upgradedMarkers ?? markers;
  };
  const record = (
    workloadId: string,
    state: WorkloadState,
    metadata: Record<string, unknown> | null = null,
    afterMs = 1,
  ): void => {
    events.push({
      id: events.length + 1,
      workloadId,
      state,
      metadata,
      createdAt: (events.at(-1)?.createdAt ?? 99) + afterMs,
    });
  };

  const files = {
    remove: async (name: string) => {
      calls.push(`remove-file:${name}`);
    },
    text: async (name: string) => {
      calls.push(`write-file:${name}`);
      return `/workspace/${name}`;
    },
  };
  const secrets = {
    create: async (name: string) => {
      calls.push(`secret-create:${name}`);
    },
    delete: async (name: string) => {
      calls.push(`secret-delete:${name}`);
      await options.secretDelete?.();
    },
  };
  const redacted: string[] = [];
  const kernel = {
    reserve: async (id: string): Promise<TrackedWorkloadRef> => {
      calls.push(`reserve:${id}`);
      // Each Service starts on the first host with its v1 markers.
      cloudId = CLOUD_ID;
      markers = initialMarkers;
      record(id, WorkloadState.Queued);
      current = status(id, WorkloadState.Queued, [...events], {
        dnsRecordId: null,
      });
      return trackedWorkloadRefForTest(id);
    },
    status: async (ref: TrackedWorkloadRef) => {
      calls.push(`status:${ref.id}`);
      if (!current) throw new Error('no status');
      // The fake product runs a submitted Service by its first status read;
      // the contract must read the endpoint in the same pass.
      if (
        submissions.length > 0 &&
        current.workload.state === WorkloadState.Queued
      ) {
        advance(
          ref,
          options.publicationPending
            ? WorkloadState.Starting
            : WorkloadState.Running,
        );
      }
      return structuredClone(current);
    },
    waitForState: async (ref: TrackedWorkloadRef, state: WorkloadState) => {
      calls.push(`wait:${state}`);
      advance(ref, state);
      if (!current) throw new Error('no status');
      return structuredClone(current);
    },
    requestTermination: async (ref: TrackedWorkloadRef) => {
      calls.push(`terminate:${ref.id}`);
    },
    waitForCleanupRecorded: async (ref: TrackedWorkloadRef) => {
      calls.push(`cleanup:${ref.id}`);
      current = status(ref.id, WorkloadState.Terminated, [...events], {
        cleanedAt: options.cleanupTime ?? 110,
        cloudId,
        live: false,
      });
      return cleanupRecordedForTest(ref, current);
    },
    recordSubstrateAbsence: (ref: TrackedWorkloadRef) => {
      calls.push(`substrate:${ref.id}`);
      return substrateAbsentForTest(ref);
    },
    release: async () => {
      await options.kernelRelease?.();
      calls.push('release');
    },
  };
  const mutations = {
    runCliCreateWithTransientRetries: async (
      _ref: TrackedWorkloadRef,
      args: readonly string[],
      _cliOptions?: CliRunOptions,
    ): Promise<void> => {
      submissions.push(args);
      const separator = args.indexOf('--');
      submittedImage = args[separator - 1]!;
      const flag = (name: string): string | undefined => {
        const index = args.indexOf(name);
        return index >= 0 ? args[index + 1] : undefined;
      };
      submittedGpus = flag('--gpus');
      submittedRuntime = flag('--runtime');
      containerCommand = separator >= 0 ? args.slice(separator + 1) : null;
      const checkpoint = args.indexOf('--checkpoint-bucket');
      checkpointBucket = checkpoint >= 0 ? args[checkpoint + 1]! : null;
      const checkpointRegion = args.indexOf('--checkpoint-storage-region');
      checkpointStorageRegion =
        checkpointRegion >= 0 ? args[checkpointRegion + 1]! : null;
      applyContainer();
    },
    runCliUpgrade: async (
      ref: TrackedWorkloadRef,
      args: readonly string[],
      _cliOptions?: CliRunOptions,
    ): Promise<void> => {
      submissions.push(args);
      calls.push(`upgrade:${ref.id}`);
      if (!options.upgradeKeepsImage)
        submittedImage = args[args.indexOf('--') - 1]!;
      containerCommand = args.slice(args.indexOf('--') + 1);
      if (options.upgradeRecordsTransition !== false) {
        record(ref.id, WorkloadState.Recovering, {
          reason: 'serve-upgrade',
        });
      }
      current = status(ref.id, WorkloadState.Recovering, [...events], {
        cloudId,
      });
      applyContainer();
      // Only a checkpoint hold keeps the old VM; a plain upgrade replaces it.
      if (!checkpointBucket && !options.upgradeStalls) completeUpgrade();
    },
  };
  const transport = {
    ensureCredential: async () => {
      calls.push('credential');
    },
    observeEndpoint: async () => {
      endpointProbes += 1;
      return {
        responseBody:
          options.responseBody?.(markers) ??
          [
            ...markers,
            'secret-ok',
            ...(submittedGpus ? ['GPU 0: NVIDIA A10 (UUID: GPU-fixture)'] : []),
            'environment-svup-aws',
            ...(markers === upgradedMarkers ? ['checkpoint-marker'] : []),
          ].join('\n'),
        statusCode: nextStatusCode(),
      };
    },
    observeDns: async (hostname: string) => {
      dnsChecks.push({ hostname, state: current?.workload.state });
      return (
        options.dns?.(hostname) ?? {
          hostname,
          authorities: ['one.ns.example', 'two.ns.example'],
          answers: ['one.ns.example', 'two.ns.example'].map((authority) => ({
            authority,
            address: '192.0.2.53',
            diagnostic: 'queryA ENOTFOUND',
            presence: 'absent' as const,
          })),
        }
      );
    },
    observeHosts: async (hosts: readonly ServeBackingHost[]) => {
      observedHosts.push([...hosts]);
      return (
        options.absence ??
        hosts.map((host) => ({
          cloudId: host.cloudId,
          diagnostic: 'terminated',
          presence: 'absent' as const,
        }))
      );
    },
  };
  const createAdapter = (
    provider: VmProvider,
    gpu: boolean,
  ): PublicCloudServeAdapter => {
    const gpuProfiles = {
      aws: { vmTypes: ['g6e.xlarge'], diskSizeGb: 100 },
      azure: { vmTypes: ['Standard_NC4as_T4_v3'], diskSizeGb: 50 },
      gcp: {
        vmTypes: ['g2-standard-4'],
        diskSizeGb: 50,
        region: 'us-east4',
        runtime: 'nvidia' as const,
      },
      lambda: { vmTypes: ['gpu_1x_a10'], diskSizeGb: 50 },
    };
    activeProfile = {
      credentialName: `${provider}-test`,
      provider,
      ...(gpu
        ? { ...gpuProfiles[provider], gpus: 'all' as const }
        : { diskSizeGb: 50, region: 'us-east-1', vmTypes: ['t3.small'] }),
    };
    return new PublicCloudServeAdapter({
      mutations,
      profile: activeProfile,
      transport,
    });
  };
  const targets = new ServeTargetFactory({
    create: (provider) => createAdapter(provider, false),
    createGpu: (provider) => createAdapter(provider, true),
  });

  const members = {
    artifacts: {
      json: async (name: string, value: unknown) => {
        calls.push(`artifact:${name}`);
        await options.artifact?.(name, value);
        return `/tmp/${name}.json`;
      },
    },
    environment: {
      milliseconds: (_name: string, fallbackSeconds: number) =>
        fallbackSeconds * 1_000,
      optional: (name: string, fallback = '') =>
        name === 'E2E_SERVE_FORCE_FAILURE_BEFORE_FINALIZE' &&
        options.forceCleanup
          ? '1'
          : fallback,
    },
    kernel,
    nativeCleanup: {
      reserve: async (
        _target: ServeTarget,
        _profile: ServeTargetAdapter['profile'],
        id: string,
      ) => kernel.reserve(id),
      capture: async () => undefined,
      verify: async (ref: TrackedWorkloadRef) => {
        await options.nativeVerify?.();
        return kernel.recordSubstrateAbsence(ref);
      },
    },
    names: { workload: (prefix: string) => `d-${prefix}` },
    targets,
    vmLedger: {
      liveEntries: (snapshot: VmLedgerSnapshot) =>
        snapshot.workloadId === current?.workload.id
          ? (current.vms ?? []).filter((vm) => vm.endedAt === null)
          : [],
      assertCleared: async (ref: TrackedWorkloadRef) => {
        const live = (current?.vms ?? []).filter((vm) => vm.endedAt === null);
        calls.push(`live-vms:${ref.id}:${String(live.length)}`);
        if (live.length !== 0) throw new Error('live VM rows remain');
        return vmLedgerClearedForTest(ref);
      },
      liveVmCount: async (ref: TrackedWorkloadRef) => {
        const live = (current?.vms ?? []).filter((vm) => vm.endedAt === null);
        calls.push(`live-vms:${ref.id}:${String(live.length)}`);
        return live.length;
      },
      snapshot: (ref: TrackedWorkloadRef) => {
        if (!current) throw new Error('no status');
        return snapshotStatusVmLedger(ref.id, current);
      },
    },
    wait: new ProbeWaiter(options.probeAttempts),
    now: nextNow,
  };
  const contract = new ServeBaselineContract({
    ...members,
    probes: {
      environment: new EnvironmentProbeFixture(cleanup, files),
      namedSecret: new NamedSecretProbeFixture({
        names: { secret: (prefix: string) => `s-${prefix}` },
        redactor: {
          add: (value: string | undefined) => {
            if (value) redacted.push(value);
          },
        },
        secrets,
        sha256,
      }),
    },
  });
  const upgradeContract = new ServeUpgradeContract({
    ...members,
    faults: {
      restart: async () => {
        calls.push('restart-api');
        if (options.restartFails) throw new Error('API restart failed');
        return {
          identityBefore: 'api-container',
          identityAfter: options.restartChangesContainer
            ? 'another-api-container'
            : 'api-container',
        };
      },
    },
    recovery: {
      create: async () => ({
        bucketName: 'serve-checkpoint',
        region: 'us-east-1',
        marker: 'checkpoint-marker',
        releaseBucket: async () => {
          calls.push('bucket-release');
          await options.bucketRelease?.();
        },
        hold: async () => {
          let released = false;
          calls.push('hold-checkpoint');
          return {
            vmId: 42,
            cloudId: CLOUD_ID,
            checkpointHostPath: '/mnt/checkpoint',
            assertHeld: async () => {
              calls.push('checkpoint-held');
            },
            release: async () => {
              if (released) return;
              await options.holdRelease?.();
              released = true;
              calls.push('release-checkpoint');
              completeUpgrade();
            },
          };
        },
      }),
    },
  });

  return {
    calls,
    cleanup,
    contract,
    upgradeContract,
    observedHosts,
    dnsChecks,
    redacted,
    submissions,
    endpointProbes: () => endpointProbes,
    changeStatus: (change: (record: StatusResponse) => void) => {
      if (!current) throw new Error('no Service');
      change(current);
    },
    setMarkers: (values: readonly string[]) => {
      markers = initialMarkers = values;
    },
    setUpgradedMarkers: (values: readonly string[]) => {
      upgradedMarkers = values;
    },
  };
}

describe('Serve resource probes', () => {
  test('resolves the direct value over the env-file value and cleans up once', async () => {
    const cleanup = new CleanupStack();
    const written = new Map<string, string>();
    const removed: string[] = [];
    const fixture = new EnvironmentProbeFixture(cleanup, {
      remove: async (name) => {
        removed.push(name);
      },
      text: async (name, contents) => {
        written.set(name, contents);
        return `/workspace/${name}`;
      },
    });

    const probe = await fixture.create('serve-aws');

    expect(probe.expected).toEqual({
      SERVE_ENV_FILE_MARKER: 'env-file-serve-aws',
      SERVE_ENV_OVERRIDE: 'env-override-from-flag-serve-aws',
      SERVE_MARKER: 'anycloud-serve-serve-aws',
    });
    expect(probe.directEnvironment.SERVE_ENV_OVERRIDE).toBe(
      'env-override-from-flag-serve-aws',
    );
    expect([...written.values()][0]).toContain(
      'SERVE_ENV_OVERRIDE=env-override-from-file-serve-aws',
    );
    expect(probe.markers).toEqual([
      'anycloud-serve-serve-aws',
      'env-file-serve-aws',
      'env-override-from-flag-serve-aws',
    ]);

    await probe.release();
    await cleanup.run();
    expect(removed).toEqual(['environment-probe/serve-aws.env']);
  });

  test('removes an env file left behind when a later stage fails', async () => {
    const cleanup = new CleanupStack();
    const removed: string[] = [];
    const fixture = new EnvironmentProbeFixture(cleanup, {
      remove: async (name) => {
        removed.push(name);
      },
      text: async (name) => `/workspace/${name}`,
    });

    await fixture.create('serve-gcp');
    await cleanup.run();

    expect(removed).toEqual(['environment-probe/serve-gcp.env']);
  });

  test('redacts the secret value before it can be created', async () => {
    const order: string[] = [];
    const fixture = new NamedSecretProbeFixture({
      names: { secret: (prefix) => `s-${prefix}` },
      redactor: {
        add: (value) => {
          order.push(`redact:${String(value)}`);
        },
      },
      secrets: {
        create: async (name, values) => {
          order.push(`create:${name}:${Object.keys(values).join(',')}`);
        },
        delete: async (name) => {
          order.push(`delete:${name}`);
        },
      },
      sha256,
    });

    const probe = await fixture.create('serve-aws');
    await probe.release();

    expect(order).toEqual([
      'redact:anycloud-serve-secret-s-serve-aws',
      'create:s-serve-aws:SERVE_SECRET_TOKEN',
      'delete:s-serve-aws',
    ]);
    expect(probe.digest).toBe(sha256('anycloud-serve-secret-s-serve-aws'));
  });
});

describe('public-cloud Serve submission', () => {
  test('submits one Service with its placement, env file, direct env, and secret', async () => {
    const world = harness();
    world.setMarkers([
      'anycloud-serve-serve-aws',
      'env-file-serve-aws',
      'env-override-from-flag-serve-aws',
    ]);

    await world.contract.run('aws');

    const [args] = world.submissions;
    expect(args?.slice(0, 5)).toEqual([
      'service',
      '--id',
      'd-serve-aws',
      '--credentials',
      'aws-test',
    ]);
    expect(args).toContain('--vm-type');
    expect(args).toContain('t3.small');
    expect(args).toContain('--disk-size');
    expect(args).toContain('50');
    expect(args).toContain('--env-file');
    expect(args).toContain('/workspace/environment-probe/serve-aws.env');
    expect(args).toContain('--secret');
    expect(args).toContain('s-serve-aws');
    expect(args).toContain('SERVE_MARKER=anycloud-serve-serve-aws');
    expect(args?.at(-3)).toBe('sh');
  });

  test('rejects a target the adapter was not built for', async () => {
    const world = harness();
    const create = () =>
      new PublicCloudServeAdapter({
        mutations: {
          runCliCreateWithTransientRetries: async () => undefined,
          runCliUpgrade: async () => undefined,
        },
        profile: {
          credentialName: 'aws-test',
          provider: 'aws',
          vmTypes: ['t3.small'],
        },
        transport: {
          ensureCredential: async () => undefined,
          observeEndpoint: async () => ({
            responseBody: '',
            statusCode: 200,
          }),
          observeHosts: async () => [],
          observeDns: async (hostname) => ({
            hostname,
            authorities: [],
            answers: [],
          }),
        },
      });
    const adapter = new ServeTargetFactory({
      create,
      createGpu: create,
    }).adapter('aws');

    await expect(
      adapter.observeReady(trackedWorkloadRefForTest('d-x'), {
        kind: 'local-smolvm',
      }),
    ).rejects.toThrow('received a different target');
    expect(world.submissions).toEqual([]);
  });
});

describe('Serve baseline contract', () => {
  test('fails a Service that reports running while its endpoint still refuses', async () => {
    const world = harness({ statusCode: 503 });
    await expect(world.contract.run('aws')).rejects.toThrow(
      /Service d-serve-aws reported running while its endpoint still refused \(.*503/u,
    );
    expect(world.calls.some((call) => call.startsWith('terminate:'))).toBe(
      false,
    );
  });

  test('fails a Service whose running event lands without the startup dwell', async () => {
    // The container start began and `running` landed two seconds apart.
    const world = harness({ dwellMs: 2_000 });
    await expect(world.contract.run('aws')).rejects.toThrow(
      /reached running 2000ms after its container start began; the startup dwell is 30000ms/u,
    );
  });

  test('accepts running while the hostname does not resolve yet, then the endpoint answering', async () => {
    // Ten seconds of no answer at the edge (HTTP 0, then a Cloudflare 521)
    // after the product's `running`, then 200; the record was landing.
    const world = harness({
      statusCode: [0, 521, 200],
      now: [0, 5_000, 10_000],
      probeAttempts: 3,
    });
    world.setMarkers([
      'anycloud-serve-serve-aws',
      'env-file-serve-aws',
      'env-override-from-flag-serve-aws',
    ]);
    await expect(world.contract.run('aws')).resolves.toMatchObject({
      satisfied: true,
    });
    expect(
      world.calls.filter((call) => call === 'status:d-serve-aws').length,
    ).toBeGreaterThanOrEqual(3);
  });

  test('fails a Service whose endpoint stays unreachable past the publication window', async () => {
    const world = harness({
      statusCode: 0,
      now: [0, 60_000, 120_001],
      probeAttempts: 3,
    });
    await expect(world.contract.run('aws')).rejects.toThrow(
      /running for 120001ms while its endpoint stayed unreachable \(.*HTTP 0\); the publication window is 120000ms/u,
    );
  });

  test('provisions, proves the public endpoint, then terminates and releases', async () => {
    const world = harness();
    world.setMarkers([
      'anycloud-serve-serve-aws',
      'env-file-serve-aws',
      'env-override-from-flag-serve-aws',
    ]);

    await expect(world.contract.run('aws')).resolves.toEqual({
      contract: 'serve',
      qualification: 'conclusive',
      satisfied: true,
      target: 'aws',
    });

    expect(world.calls).toEqual([
      'secret-create:s-serve-aws',
      'write-file:environment-probe/serve-aws.env',
      'reserve:d-serve-aws',
      'credential',
      'status:d-serve-aws',
      'status:d-serve-aws',
      'live-vms:d-serve-aws:1',
      'artifact:service-finalization-boundary',
      'terminate:d-serve-aws',
      'wait:terminated',
      'cleanup:d-serve-aws',
      'live-vms:d-serve-aws:0',
      'substrate:d-serve-aws',
      'remove-file:environment-probe/serve-aws.env',
      'secret-delete:s-serve-aws',
      'release',
      'artifact:serve-result',
    ]);
    expect(world.observedHosts).toEqual([
      [{ availabilityZone: 'b', cloudId: CLOUD_ID, region: 'us-east-1' }],
    ]);

    await world.cleanup.run();
    expect(
      world.calls.filter((call) => call.startsWith('remove-file')),
    ).toEqual(['remove-file:environment-probe/serve-aws.env']);
  });

  test('fails when the public response omits a resolved environment marker', async () => {
    const world = harness({ responseBody: () => 'secret-ok\n' });
    world.setMarkers(['anycloud-serve-serve-aws']);

    await expect(world.contract.run('aws')).rejects.toThrow(
      'response omitted anycloud-serve-serve-aws',
    );
    expect(world.calls).not.toContain('release');
  });

  test('fails when the workload cannot prove the injected named secret', async () => {
    const world = harness({
      responseBody: (markers) => [...markers, 'secret-missing'].join('\n'),
    });
    world.setMarkers([
      'anycloud-serve-serve-aws',
      'env-file-serve-aws',
      'env-override-from-flag-serve-aws',
    ]);

    await expect(world.contract.run('aws')).rejects.toThrow(
      'response omitted secret-ok',
    );
    expect(world.calls).not.toContain('release');
  });

  test('does not probe a persisted DNS identity while authoritative publication is still starting', async () => {
    const world = harness({ publicationPending: true, probeAttempts: 2 });
    world.setMarkers(['anycloud-serve-serve-aws']);
    await expect(world.contract.run('aws')).rejects.toThrow();
    expect(world.endpointProbes()).toBe(0);
    expect(world.calls).not.toContain('release');
  });

  test('never probes the endpoint before status carries its DNS record', async () => {
    // A lookup before the record exists caches the NXDOMAIN on the resolver.
    const world = harness({
      dnsRecordId: null,
      now: [0, 120_001],
      probeAttempts: 2,
    });
    world.setMarkers(['anycloud-serve-serve-aws']);

    await expect(world.contract.run('aws')).rejects.toThrow(
      /running for 120001ms while its endpoint stayed unreachable \(no DNS record persisted\)/u,
    );
    expect(world.endpointProbes()).toBe(0);
    expect(world.calls).not.toContain('release');
  });

  test('keeps cleanup armed when a recorded host is not provably gone', async () => {
    const world = harness({
      absence: [
        { cloudId: CLOUD_ID, diagnostic: 'throttled', presence: 'unknown' },
      ],
    });
    world.setMarkers([
      'anycloud-serve-serve-aws',
      'env-file-serve-aws',
      'env-override-from-flag-serve-aws',
    ]);

    await expect(world.contract.run('aws')).rejects.toThrow('target absence');
    expect(world.calls).not.toContain('release');
    expect(world.calls).not.toContain('secret-delete:s-serve-aws');
  });

  test('rejects an absence answer that skips a recorded host', async () => {
    const world = harness({ absence: [] });
    world.setMarkers([
      'anycloud-serve-serve-aws',
      'env-file-serve-aws',
      'env-override-from-flag-serve-aws',
    ]);

    await expect(world.contract.run('aws')).rejects.toThrow(
      'did not cover every recorded backing host',
    );
    expect(world.calls).not.toContain('release');
  });
});

describe('Serve upgrade contract', () => {
  const v1 = 'anycloud-serve-upgrade-svup-aws-v1';
  const v2 = 'anycloud-serve-upgrade-svup-aws-v2';

  test('preserves the restart error when releasing the checkpoint hold also fails', async () => {
    const secondary = new Error('checkpoint unmask unavailable');
    const world = harness({
      restartFails: true,
      holdRelease: async () => {
        throw secondary;
      },
    });
    world.setMarkers([v1]);
    world.setUpgradedMarkers([v2]);
    const failure = await world.upgradeContract
      .checkpointed('aws')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      errors: [new Error('API restart failed'), secondary],
    });
    expect(world.calls).not.toContain('bucket-release');
    expect(world.calls).not.toContain('release');
  });

  test('preserves the public URL while replacing the backing host', async () => {
    const world = harness();
    world.setMarkers([v1]);
    world.setUpgradedMarkers([v2]);

    await expect(world.upgradeContract.checkpointed('aws')).resolves.toEqual({
      contract: 'serve-upgrade',
      qualification: 'conclusive',
      satisfied: true,
      target: 'aws',
    });

    expect(world.dnsChecks).toEqual([
      { hostname: 'd-svup-aws.anycloud.sh', state: WorkloadState.Terminated },
    ]);

    expect(world.submissions.at(-1)?.slice(0, 4)).toEqual([
      'service',
      'upgrade',
      'd-svup-aws',
      'python:3.12-alpine',
    ]);
    expect(world.submissions[0]).toContain('--checkpoint-bucket');
    expect(world.submissions[0]).toContain('serve-checkpoint');
    expect(world.submissions[0]).toContain('--checkpoint-storage-region');
    expect(world.submissions.at(-1)?.at(-1)).toContain(
      'cat /mnt/checkpoint/rfc0036-checkpoint-marker',
    );
    expect(world.observedHosts).toEqual([
      [{ availabilityZone: 'b', cloudId: CLOUD_ID, region: 'us-east-1' }],
      [
        { availabilityZone: 'b', cloudId: CLOUD_ID, region: 'us-east-1' },
        {
          availabilityZone: 'b',
          cloudId: REPLACEMENT_CLOUD_ID,
          region: 'us-east-1',
        },
      ],
    ]);
    expect(world.calls.indexOf('hold-checkpoint')).toBeLessThan(
      world.calls.indexOf('restart-api'),
    );
    expect(world.calls.indexOf('restart-api')).toBeLessThan(
      world.calls.indexOf('release-checkpoint'),
    );
    expect(world.calls.indexOf('bucket-release')).toBeLessThan(
      world.calls.indexOf('release'),
    );
    expect(world.calls.at(-1)).toBe('artifact:serve-upgrade-result');
  });

  describe('without a checkpoint bucket', () => {
    const plain = (options: HarnessOptions = {}) => {
      const world = harness(options);
      world.setMarkers([
        'anycloud-serve-upgrade-svpl-aws-v1',
        'environment-svpl-aws',
      ]);
      world.setUpgradedMarkers([
        'anycloud-serve-upgrade-svpl-aws-v2',
        'environment-svpl-aws',
      ]);
      return world;
    };

    test('moves to the new image on a replacement host after the old VM is gone', async () => {
      const world = plain();
      await expect(world.upgradeContract.plain('aws')).resolves.toEqual({
        contract: 'serve-upgrade',
        qualification: 'conclusive',
        satisfied: true,
        target: 'aws',
      });
      expect(world.submissions[0]).not.toContain('--checkpoint-bucket');
      expect(world.submissions.at(-1)?.slice(0, 4)).toEqual([
        'service',
        'upgrade',
        'd-svpl-aws',
        'python:3.13-alpine',
      ]);
      expect(world.observedHosts[0]).toEqual([
        { availabilityZone: 'b', cloudId: CLOUD_ID, region: 'us-east-1' },
      ]);
      expect(world.calls).not.toContain('hold-checkpoint');
      expect(world.calls).not.toContain('restart-api');
      expect(world.calls).toContain(
        'artifact:serve-upgrade-plain-service-finalization-boundary',
      );
      expect(world.calls.at(-1)).toBe('artifact:serve-upgrade-plain-result');
    });

    test('runs before the checkpointed journey in the member', async () => {
      const world = plain();
      world.setMarkers([
        'anycloud-serve-upgrade-svpl-aws-v1',
        'environment-svpl-aws',
        'anycloud-serve-upgrade-svup-aws-v1',
      ]);
      world.setUpgradedMarkers([
        'anycloud-serve-upgrade-svpl-aws-v2',
        'environment-svpl-aws',
        'anycloud-serve-upgrade-svup-aws-v2',
      ]);
      await expect(world.upgradeContract.run('aws')).resolves.toMatchObject({
        satisfied: true,
      });
      expect(
        world.calls.filter((call) =>
          call.startsWith('artifact:serve-upgrade-'),
        ),
      ).toEqual([
        'artifact:serve-upgrade-plain-service-finalization-boundary',
        'artifact:serve-upgrade-plain-result',
        'artifact:serve-upgrade-before-restart',
        'artifact:serve-upgrade-after-restart',
        'artifact:serve-upgrade-result',
      ]);
    });

    test.each([
      { upgradeStalls: true, error: 'upgrade to record Running' },
      { reuseHostOnUpgrade: true, error: 'reused the original backing VM' },
      {
        upgradeKeepsImage: true,
        error: 'upgrade did not persist the replacement image',
      },
      {
        absence: [
          {
            cloudId: CLOUD_ID,
            diagnostic: 'running',
            presence: 'present' as const,
          },
        ],
        error: 'original VM absence is not confirmed',
      },
    ])(
      'rejects an upgrade that keeps the old capacity: $error',
      async ({ error, ...options }) => {
        const world = plain(options);
        await expect(world.upgradeContract.plain('aws')).rejects.toThrow(error);
        expect(world.calls).not.toContain('release');
      },
    );
  });

  test('rejects an upgrade that lands back on the original host', async () => {
    const world = harness({ reuseHostOnUpgrade: true });
    world.setMarkers([v1]);
    world.setUpgradedMarkers([v2]);

    await expect(world.upgradeContract.checkpointed('aws')).rejects.toThrow(
      'reused the original backing VM',
    );
    expect(world.calls).not.toContain('release');
  });

  test('requires the durable serve-upgrade transition', async () => {
    const world = harness({ upgradeRecordsTransition: false });
    world.setMarkers([v1]);
    world.setUpgradedMarkers([v2]);

    await expect(world.upgradeContract.checkpointed('aws')).rejects.toThrow(
      'durable serve-upgrade transition',
    );
    expect(world.calls).not.toContain('release');
    expect(world.calls).toContain('release-checkpoint');
    expect(world.calls).not.toContain('restart-api');
  });

  test('rejects an upgrade that changes the persisted DNS identity', async () => {
    const world = harness({ upgradeChangesDns: true });
    world.setMarkers([v1]);
    world.setUpgradedMarkers([v2]);
    await expect(world.upgradeContract.checkpointed('aws')).rejects.toThrow(
      'persisted Service DNS identity',
    );
    expect(world.calls).not.toContain('release');
  });

  test.each([
    { restartFails: true, error: 'API restart failed' },
    { restartChangesContainer: true, error: 'instead of restarting it' },
  ])(
    'unblocks exact-host cleanup after a restart failure: $error',
    async (options) => {
      const world = harness(options);
      world.setMarkers([v1]);
      world.setUpgradedMarkers([v2]);

      await expect(world.upgradeContract.checkpointed('aws')).rejects.toThrow(
        options.error,
      );
      expect(
        world.calls.filter((call) => call === 'release-checkpoint'),
      ).toHaveLength(1);
      expect(world.calls).not.toContain('bucket-release');
      expect(world.calls).not.toContain('release');
    },
  );
});

describe('accepted Service upgrade restart checkpoint', () => {
  function boundary() {
    const id = 'd-svup-aws';
    const events: StatusResponse['events'] = [
      {
        id: 11,
        workloadId: id,
        state: WorkloadState.Provisioning,
        metadata: null,
        createdAt: 11,
      },
      {
        id: 12,
        workloadId: id,
        state: WorkloadState.Running,
        metadata: null,
        createdAt: 12,
      },
    ];
    const previous = status(id, WorkloadState.Running, events);
    const replacement: ServeSubmission = {
      target: { kind: 'public-cloud', provider: 'aws' },
      image: 'python:3.12-alpine',
      command: ['sh', '-c', 'replacement'],
      environment: { SERVICE_RESTART_MARKER: 'inherited' },
      checkpointBucket: 'owned-bucket',
      checkpointStorageRegion: 'us-east-1',
    };
    const current = status(id, WorkloadState.Recovering, [
      ...events,
      {
        id: 13,
        workloadId: id,
        state: WorkloadState.Recovering,
        metadata: { reason: 'serve-upgrade' },
        createdAt: 13,
      },
    ]);
    Object.assign(current.workload, {
      command: [...replacement.command!],
      checkpointBucket: replacement.checkpointBucket,
      checkpointStorageRegion: replacement.checkpointStorageRegion,
    });
    return {
      current,
      expected: { previous, replacement, cloudId: CLOUD_ID, vmId: 42 },
    };
  }

  test('records accepted config and actual old attempt/event identities', () => {
    const { current, expected } = boundary();
    expect(acceptedUpgradeCheckpoint(current, expected)).toEqual({
      workloadId: 'd-svup-aws',
      vmId: 42,
      cloudId: CLOUD_ID,
      image: 'python:3.12-alpine',
      command: ['sh', '-c', 'replacement'],
      imageDigest: null,
      checkpointBucket: 'owned-bucket',
      checkpointStorageRegion: 'us-east-1',
      dnsRecordId: 'dns-1',
      upgradeEventId: 13,
      runningEventId: 12,
      provisioningEventId: 11,
    });
  });

  test.each([
    [
      'state',
      (current: StatusResponse) => {
        current.workload.state = WorkloadState.Queued;
      },
    ],
    [
      'command',
      (current: StatusResponse) => {
        current.workload.command = ['old-command'];
      },
    ],
    [
      'checkpoint region',
      (current: StatusResponse) => {
        current.workload.checkpointStorageRegion = 'us-west-2';
      },
    ],
    [
      'DNS identity',
      (current: StatusResponse) => {
        current.workload.dnsRecordId = 'new-dns';
      },
    ],
    [
      'old execution event',
      (current: StatusResponse) => {
        current.events[1]!.id = 99;
      },
    ],
  ] as const)('rejects a changed %s at the held boundary', (_name, mutate) => {
    const { current, expected } = boundary();
    // The previous response is an independent pre-upgrade snapshot.
    expected.previous = structuredClone(expected.previous);
    mutate(current);
    expect(() => acceptedUpgradeCheckpoint(current, expected)).toThrow(
      'Serve contract:',
    );
  });
});

describe('active GPU Service stages', () => {
  function gpuHarness(
    provider: VmProvider = 'aws',
    options: HarnessOptions = {},
  ) {
    const world = harness(options);
    world.setMarkers([
      `anycloud-serve-gpu-serve-${provider}`,
      `env-file-gpu-serve-${provider}`,
      `env-override-from-flag-gpu-serve-${provider}`,
    ]);
    return world;
  }

  test.each([
    { provider: 'aws' as const, vmType: 'g6e.xlarge', disk: '100' },
    { provider: 'azure' as const, vmType: 'Standard_NC4as_T4_v3', disk: '50' },
    { provider: 'gcp' as const, vmType: 'g2-standard-4', disk: '50' },
    { provider: 'lambda' as const, vmType: 'gpu_1x_a10', disk: '50' },
  ])(
    'keeps $provider live through GPU evidence and finalizes once',
    async ({ provider, vmType, disk }) => {
      const world = gpuHarness(provider);
      const baseline = await world.contract.beginGpu(provider);
      expect(baseline.ref.id).toBe(`d-gpu-serve-${provider}`);
      expect(world.calls.some((call) => call.startsWith('terminate:'))).toBe(
        false,
      );
      expect(world.calls).not.toContain('release');
      const evidence = await world.contract.qualifyGpu(baseline);
      expect(evidence).toEqual({
        ref: baseline.ref,
        url: `https://${baseline.ref.id}.anycloud.sh`,
        devices: ['GPU 0: NVIDIA A10 (UUID: GPU-fixture)'],
      });
      expect(world.calls).not.toContain('release');
      await expect(world.contract.finish(baseline)).resolves.toEqual({
        contract: 'gpu-serve',
        qualification: 'conclusive',
        satisfied: true,
        target: provider,
      });
      const args = world.submissions[0]!;
      expect(
        args.slice(args.indexOf('--vm-type'), args.indexOf('--vm-type') + 2),
      ).toEqual(['--vm-type', vmType]);
      expect(
        args.slice(
          args.indexOf('--disk-size'),
          args.indexOf('--disk-size') + 2,
        ),
      ).toEqual(['--disk-size', disk]);
      expect(
        args.slice(args.indexOf('--gpus'), args.indexOf('--gpus') + 2),
      ).toEqual(['--gpus', 'all']);
      expect(args).toContain('python:3.12-slim');
      expect(args.at(-1)).toMatch(/^nvidia-smi && /u);
      expect(args.at(-1)).toContain(
        'subprocess.check_output(["nvidia-smi", "-L"]',
      );
      if (provider === 'gcp') {
        expect(
          args.slice(args.indexOf('--region'), args.indexOf('--region') + 2),
        ).toEqual(['--region', 'us-east4']);
        expect(
          args.slice(args.indexOf('--runtime'), args.indexOf('--runtime') + 2),
        ).toEqual(['--runtime', 'nvidia']);
      } else {
        expect(args).not.toContain('--region');
        expect(args).not.toContain('--runtime');
      }
      expect(world.calls.filter((call) => call === 'release')).toHaveLength(1);
      expect(
        world.calls.filter((call) => call === 'artifact:gpu-serve-result'),
      ).toHaveLength(1);
      await expect(world.contract.finish(baseline)).rejects.toThrow(
        'cannot complete twice',
      );
      await expect(world.contract.qualifyGpu(baseline)).rejects.toThrow(
        'owned live baseline',
      );
    },
  );

  test('rejects a copied or early completion without disarming the active Service', async () => {
    const world = gpuHarness();
    const baseline = await world.contract.beginGpu('aws');
    await expect(world.contract.finish({ ...baseline })).rejects.toThrow(
      'owned active baseline',
    );
    await expect(world.contract.qualifyGpu({ ...baseline })).rejects.toThrow(
      'owned live baseline',
    );
    await expect(world.contract.finish(baseline)).rejects.toThrow(
      'omitted required GPU evidence',
    );
    expect(world.calls).not.toContain('release');
    expect(world.calls.some((call) => call.startsWith('terminate:'))).toBe(
      false,
    );
    await world.contract.qualifyGpu(baseline);
    await world.contract.finish(baseline);
    expect(world.calls.filter((call) => call === 'release')).toHaveLength(1);
  });

  test('a copied active Service cannot authorize completion by public ID', async () => {
    const world = harness();
    world.setMarkers([
      'anycloud-serve-serve-aws',
      'env-file-serve-aws',
      'env-override-from-flag-serve-aws',
    ]);
    const baseline = await world.contract.begin('aws');
    await expect(world.contract.finish({ ...baseline })).rejects.toThrow(
      'owned active baseline',
    );
    expect(world.calls).not.toContain('release');
    await world.contract.finish(baseline);
    expect(world.calls.filter((call) => call === 'release')).toHaveLength(1);
  });

  test('CPU completion terminates and publishes only once', async () => {
    const world = harness();
    world.setMarkers([
      'anycloud-serve-serve-aws',
      'env-file-serve-aws',
      'env-override-from-flag-serve-aws',
    ]);
    const baseline = await world.contract.begin('aws');
    await world.contract.finish(baseline);
    await expect(world.contract.finish(baseline)).rejects.toThrow(
      'owned active baseline',
    );
    expect(
      world.calls.filter((call) => call.startsWith('terminate:')),
    ).toHaveLength(1);
    expect(world.calls.filter((call) => call === 'release')).toHaveLength(1);
    expect(
      world.calls.filter((call) => call === 'artifact:serve-result'),
    ).toHaveLength(1);
  });

  test('requires a GPU device in the already-qualified public HTTPS response', async () => {
    const world = gpuHarness('aws', {
      responseBody: (markers) =>
        [...markers, 'secret-ok', 'nvidia-smi missing'].join('\n'),
    });
    const baseline = await world.contract.beginGpu('aws');
    await expect(world.contract.qualifyGpu(baseline)).rejects.toThrow(
      'omitted nvidia-smi -L',
    );
    await expect(world.contract.finish(baseline)).rejects.toThrow(
      'owned active baseline',
    );
    expect(world.calls).not.toContain('release');
  });

  test('GPU evidence is single-use while the qualified Service is still live', async () => {
    const world = gpuHarness();
    const baseline = await world.contract.beginGpu('aws');
    await world.contract.qualifyGpu(baseline);
    await expect(world.contract.qualifyGpu(baseline)).rejects.toThrow(
      'owned live baseline exactly once',
    );
    expect(
      world.calls.filter((call) => call === 'artifact:gpu-serve-evidence'),
    ).toHaveLength(1);
    expect(world.calls).not.toContain('release');
    await world.contract.finish(baseline);
  });

  test.each([
    {
      name: 'stopped Workload',
      change: (status: StatusResponse) => {
        status.workload.state = WorkloadState.Terminated;
      },
      message: 'stopped or foreign',
    },
    {
      name: 'already-cleaned Workload',
      change: (status: StatusResponse) => {
        status.workload.cleanedAt = 110;
      },
      message: 'stopped or foreign',
    },
    {
      name: 'foreign Workload',
      change: (status: StatusResponse) => {
        status.workload.id = 'other';
      },
      message: 'stopped or foreign',
    },
    {
      name: 'changed Workload type',
      change: (status: StatusResponse) => {
        status.workload.workloadType = WorkloadType.Job;
      },
      message: 'stopped or foreign',
    },
    {
      name: 'changed DNS identity',
      change: (status: StatusResponse) => {
        status.workload.dnsRecordId = 'other-dns';
      },
      message: 'active Service DNS identity',
    },
    {
      name: 'replaced native host',
      change: (status: StatusResponse) => {
        if (!status.vms?.[0]) throw new Error('VM missing from fixture');
        status.vms[0].cloudId = 'other-host';
      },
      message: 'active Service backing host',
    },
    {
      name: 'changed native region',
      change: (status: StatusResponse) => {
        if (!status.vms?.[0]) throw new Error('VM missing from fixture');
        status.vms[0].region = 'us-west1';
      },
      message: 'active Service backing host',
    },
    {
      name: 'changed native zone',
      change: (status: StatusResponse) => {
        if (!status.vms?.[0]) throw new Error('VM missing from fixture');
        status.vms[0].availabilityZone = 'changed-zone';
      },
      message: 'active Service backing host',
    },
    {
      name: 'foreign provider',
      change: (status: StatusResponse) => {
        status.workload.cloudProvider = CloudType.AWS;
      },
      message: 'selected provider or placement profile',
    },
    {
      name: 'different VM profile',
      change: (status: StatusResponse) => {
        status.workload.vmType = ['t3.small'];
      },
      message: 'selected provider or placement profile',
    },
    {
      name: 'empty VM profile',
      change: (status: StatusResponse) => {
        status.workload.vmType = [];
      },
      message: 'selected provider or placement profile',
    },
    {
      name: 'different GCP region',
      change: (status: StatusResponse) => {
        status.workload.region = 'us-west1';
      },
      message: 'selected provider or placement profile',
    },
    {
      name: 'different cluster disk',
      change: (status: StatusResponse) => {
        status.workload.diskSizeGb = 1;
      },
      message: 'selected provider or placement profile',
    },
    {
      name: 'missing GPU option',
      change: (status: StatusResponse) => {
        status.workload.dockerOptions = { runtime: 'nvidia' };
      },
      message: 'selected image, command, or GPU runtime',
    },
    {
      name: 'missing NVIDIA runtime',
      change: (status: StatusResponse) => {
        status.workload.dockerOptions = { gpus: 'all' };
      },
      message: 'selected image, command, or GPU runtime',
    },
    {
      name: 'different image',
      change: (status: StatusResponse) => {
        status.workload.image = 'python:3.12-alpine';
      },
      message: 'selected image, command, or GPU runtime',
    },
    {
      name: 'server without successful enumeration',
      change: (status: StatusResponse) => {
        status.workload.command = ['python3', '-m', 'http.server'];
      },
      message: 'selected image, command, or GPU runtime',
    },
  ])('rejects $name before GPU completion', async ({ change, message }) => {
    const world = gpuHarness('gcp');
    const baseline = await world.contract.beginGpu('gcp');
    world.changeStatus(change);
    await expect(world.contract.qualifyGpu(baseline)).rejects.toThrow(message);
    expect(world.calls).not.toContain('release');
    expect(world.calls).not.toContain('artifact:gpu-serve-result');
  });

  test('does not start termination until endpoint assertions pass', async () => {
    const world = gpuHarness('aws', { statusCode: 503 });
    await expect(world.contract.beginGpu('aws')).rejects.toThrow(
      'reported running while its endpoint still refused',
    );
    expect(world.calls.some((call) => call.startsWith('terminate:'))).toBe(
      false,
    );
    expect(world.calls).not.toContain('release');
  });

  test('awaits secret cleanup and prevents a concurrent finalizer', async () => {
    let unblock = (): void => {
      throw new Error('cleanup not started');
    };
    let entered = (): void => {
      throw new Error('observer not armed');
    };
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const world = gpuHarness('aws', {
      secretDelete: async () => {
        entered();
        await blocked;
      },
    });
    const baseline = await world.contract.beginGpu('aws');
    await world.contract.qualifyGpu(baseline);
    const completion = world.contract.finish(baseline);
    await Promise.race([started, completion]);
    expect(world.calls).not.toContain('release');
    expect(world.calls).not.toContain('artifact:gpu-serve-result');
    await expect(world.contract.finish(baseline)).rejects.toThrow(
      'cannot complete twice',
    );
    unblock();
    await completion;
    expect(world.calls.indexOf('secret-delete:s-gpu-serve-aws')).toBeLessThan(
      world.calls.indexOf('release'),
    );
    expect(
      world.calls.filter((call) => call === 'artifact:gpu-serve-result'),
    ).toHaveLength(1);
  });

  test('awaits Workload release before publishing GPU completion', async () => {
    let unblock = (): void => {
      throw new Error('release not armed');
    };
    let entered = (): void => {
      throw new Error('observer not armed');
    };
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const world = gpuHarness('aws', {
      kernelRelease: async () => {
        entered();
        await blocked;
      },
    });
    const baseline = await world.contract.beginGpu('aws');
    await world.contract.qualifyGpu(baseline);
    const completion = world.contract.finish(baseline);
    try {
      await Promise.race([started, completion]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(world.calls).not.toContain('release');
      expect(world.calls).not.toContain('artifact:gpu-serve-result');
    } finally {
      unblock();
      await completion;
    }
    expect(world.calls.indexOf('release')).toBeLessThan(
      world.calls.indexOf('artifact:gpu-serve-result'),
    );
    expect(
      world.calls.filter((call) => call === 'artifact:gpu-serve-result'),
    ).toHaveLength(1);
  });

  test('keeps the Workload registered when secret deletion fails', async () => {
    const world = gpuHarness('aws', {
      secretDelete: async () => {
        throw new Error('secret remains');
      },
    });
    await expect(world.contract.runGpu('aws')).rejects.toThrow(
      'secret remains',
    );
    expect(world.calls).not.toContain('release');
    expect(world.calls).not.toContain('artifact:gpu-serve-result');
  });

  test('cannot use an active record owned by another contract instance', async () => {
    const first = gpuHarness();
    const second = gpuHarness();
    const baseline = await first.contract.beginGpu('aws');
    await expect(second.contract.qualifyGpu(baseline)).rejects.toThrow(
      'owned live baseline',
    );
    await expect(second.contract.finish(baseline)).rejects.toThrow(
      'owned active baseline',
    );
    expect(second.submissions).toEqual([]);
    expect(first.calls).not.toContain('release');
  });

  test('the forced fault occurs after GPU evidence and before normal finalization', async () => {
    const artifacts = new Map<string, unknown>();
    const world = gpuHarness('aws', {
      forceCleanup: true,
      artifact: async (name, value) => {
        artifacts.set(name, value);
      },
    });
    const baseline = await world.contract.beginGpu('aws');
    await world.contract.qualifyGpu(baseline);
    await expect(world.contract.finish(baseline)).rejects.toThrow(
      'Service forced cleanup: before-finalize',
    );
    expect(artifacts.get('service-forced-cleanup')).toMatchObject({
      workloadId: baseline.ref.id,
      fault: 'before-finalize',
      target: { kind: 'public-cloud', provider: 'aws' },
      image: 'python:3.12-slim',
      dnsRecordId: 'dns-1',
      hosts: [{ cloudId: CLOUD_ID }],
      expectedFailure: true,
    });
    expect(world.calls.some((call) => call.startsWith('terminate:'))).toBe(
      false,
    );
    expect(world.calls).not.toContain('release');
    expect(artifacts.has('gpu-serve-result')).toBe(false);
    await expect(world.contract.finish(baseline)).rejects.toThrow(
      'cannot complete twice',
    );
  });

  test('native verification failure leaves both Workload and named bundle cleanup armed', async () => {
    const world = gpuHarness('aws', {
      nativeVerify: async () => {
        throw new Error('historical attempt unresolved');
      },
    });
    await expect(world.contract.runGpu('aws')).rejects.toThrow(
      'historical attempt unresolved',
    );
    expect(world.calls).not.toContain('secret-delete:s-gpu-serve-aws');
    expect(world.calls).not.toContain('release');
    expect(world.calls).not.toContain('artifact:gpu-serve-result');
  });

  test('failed completion artifact remains a failed, single-use finalizer', async () => {
    const world = gpuHarness('aws', {
      artifact: async (name) => {
        if (name === 'gpu-serve-result')
          throw new Error('cannot retain completion');
      },
    });
    const baseline = await world.contract.beginGpu('aws');
    await world.contract.qualifyGpu(baseline);
    await expect(world.contract.finish(baseline)).rejects.toThrow(
      'cannot retain completion',
    );
    await expect(world.contract.finish(baseline)).rejects.toThrow(
      'cannot complete twice',
    );
    expect(world.calls.filter((call) => call === 'release')).toHaveLength(1);
  });

  test('upgrade bucket cleanup failure prevents Workload release and completion', async () => {
    const world = harness({
      bucketRelease: async () => {
        throw new Error('bucket remains');
      },
    });
    world.setMarkers(['anycloud-serve-upgrade-svup-aws-v1']);
    world.setUpgradedMarkers(['anycloud-serve-upgrade-svup-aws-v2']);
    await expect(world.upgradeContract.checkpointed('aws')).rejects.toThrow(
      'bucket remains',
    );
    expect(world.calls).not.toContain('release');
    expect(world.calls).not.toContain('artifact:serve-upgrade-result');
  });

  test.each([Infinity, NaN])(
    'rejects incomplete durable cleanup time %s',
    async (cleanupTime) => {
      const world = gpuHarness('aws', { cleanupTime });
      await expect(world.contract.runGpu('aws')).rejects.toThrow(
        'cleanup timestamps are invalid',
      );
      expect(world.calls).not.toContain('release');
    },
  );

  test.each(['present', 'unknown'] as const)(
    'cannot finish while one authority reports DNS %s',
    async (presence) => {
      const world = gpuHarness('aws', {
        dns: (hostname) => ({
          hostname,
          authorities: ['one.ns.example', 'two.ns.example'],
          answers: [
            {
              authority: 'one.ns.example',
              address: '192.0.2.1',
              diagnostic: 'NXDOMAIN',
              presence: 'absent',
            },
            {
              authority: 'two.ns.example',
              address: '192.0.2.2',
              diagnostic: 'not absent',
              presence,
            },
          ],
        }),
      });
      await expect(world.contract.runGpu('aws')).rejects.toThrow(
        'target absence',
      );
      expect(world.calls).not.toContain('release');
      expect(world.calls).not.toContain('secret-delete:s-gpu-serve-aws');
    },
  );

  test.each(['hostname', 'authority'] as const)(
    'rejects DNS absence for another %s',
    async (changed) => {
      const world = gpuHarness('aws', {
        dns: (hostname) => ({
          hostname: changed === 'hostname' ? 'another.anycloud.sh' : hostname,
          authorities: ['one.ns.example', 'two.ns.example'],
          answers: [
            {
              authority: 'one.ns.example',
              address: '192.0.2.1',
              diagnostic: 'NXDOMAIN',
              presence: 'absent',
            },
            {
              authority:
                changed === 'authority'
                  ? 'foreign.ns.example'
                  : 'two.ns.example',
              address: '192.0.2.2',
              diagnostic: 'NXDOMAIN',
              presence: 'absent',
            },
          ],
        }),
      });
      await expect(world.contract.runGpu('aws')).rejects.toThrow(
        'every delegated authority',
      );
      expect(world.calls).not.toContain('release');
    },
  );
});
