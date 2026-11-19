import { describe, expect, test, vi } from 'vitest';
import { buildMaceReport } from '../integration/helpers/mace-report.js';
import { WorkloadHealthStatus } from '../../src/shared/runtime.js';
import { WorkloadState, WorkloadType } from '../../src/shared/workload.js';
import { Redactor } from '../integration/e2e/internal/artifacts.js';
import {
  DedicatedJobContract,
  type DedicatedJobDependencies,
} from '../integration/e2e/internal/contracts/dedicated-job.js';
import { Environment } from '../integration/e2e/internal/environment.js';
import { JOB_BUCKET_MOLECULES } from '../integration/e2e/internal/targets/job-profiles.js';
import type {
  CloudJobFixture,
  JobFixture,
  JobMember,
  JobNativeAttempt,
  JobRecoveryIdentity,
} from '../integration/e2e/internal/targets/job-types.js';
import {
  jobGroupSize,
  JobResultNotJson,
  submittedVmTypes,
} from '../integration/e2e/internal/targets/job-types.js';
import type { StatusResponse } from '../integration/e2e/internal/types.js';
import { JobPrivateCommands } from '../integration/e2e/internal/transports/job-command.js';
import {
  liveStatusVmEntries,
  snapshotStatusVmLedger,
} from '../integration/e2e/internal/vm-ledger.js';
import {
  cleanupRecordedForTest,
  substrateAbsentForTest,
  trackedWorkloadRefForTest,
  vmLedgerClearedForTest,
} from './helpers/e2e.js';
import { persistentVmWorkload } from './helpers/persistent-vm-fixture.js';

// Drive the native promise timer with the test clock; keep the real wait checks.
vi.mock('node:timers/promises', () => ({
  setTimeout: (milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
}));

/** When the fake early Spot instance launched. */
const SPOT_LAUNCHED_AT = 1_000_000;

function harness(
  member: JobMember,
  options: {
    forced?: boolean;
    terminalEarly?: boolean;
    wrongDisk?: boolean;
    lostOriginal?: boolean;
    changedCheckpoint?: boolean;
    lostChild?: boolean;
    lostChildAfterTermination?: boolean;
    incompleteFinal?: boolean;
    unparsedResults?: 'transient' | 'final-never';
    cleanupFailure?: boolean;
    badRuntime?: boolean;
    logsKeepStreaming?: boolean;
    truncatedCheckpointHealth?: boolean;
    retainedMismatch?: boolean;
    zeroByteCheckpointReads?: number;
    badTransfer?: boolean;
    badImageDigest?: boolean;
    nativeZone?: string | null;
    omitStatusZone?: boolean;
    baselineFailure?:
      | 'requested-region'
      | 'requested-types'
      | 'missing-live'
      | 'duplicate-live'
      | 'foreign-cloud-id'
      | 'resolved-region'
      | 'resolved-zone';
    sharedReleaseFailure?: 'storage' | 'credential';
    missingHostUpload?: boolean;
    wrongRestoredCheckpoint?: boolean;
    sameHost?: boolean;
    wrongHostReason?: boolean;
    explicitCheckpointCleanupFailure?: boolean;
    hydrationFailure?:
      | 'new-controller'
      | 'relaunched-worker'
      | 'early-watchdog'
      | 'late-watchdog'
      | 'lost-input'
      | 'bad-shard';
    spotFailure?:
      | 'not-persistent'
      | 'foreign-request'
      | 'replacement'
      | 'reopened'
      | 'uncancelled'
      | 'early-reopened'
      | 'control-missing'
      | 'filter-found'
      | 'filter-before-cancel'
      | 'late-instance';
    spotReadMs?: number;
    runtimeSecretFailure?:
      | 'environment'
      | 'override'
      | 'mode'
      | 'owner'
      | 'filesystem'
      | 'after-environment'
      | 'container'
      | 'started'
      | 'missing-attempt'
      | 'credential'
      | 'status-zone'
      | 'requested-region'
      | 'git'
      | 'git-control'
      | 'file-mode'
      | 'file-unreadable'
      | 'file-update'
      | 'file-restore'
      | 'file-deleted';
    runtimeChildren?: 'missing' | 'duplicate' | 'wrong-order';
    /** The unpinned restricted-credential case lands in a region its key may not use. */
    restrictedDeniedRegion?: boolean;
    admissionFailure?:
      | 'accepted'
      | 'lost-reply'
      | 'wrong-message'
      | 'foreign'
      | 'runtime'
      | 'missing-case';
    ghcrBaseline?: boolean;
    ghcrFailure?:
      | 'image'
      | 'fingerprint'
      | 'verdict'
      | 'host'
      | 'start'
      | 'poll'
      | 'exit'
      | 'capture'
      | 'visibility'
      | 'support'
      | 'cleanup'
      | 'baseline-missing'
      | 'baseline-cached'
      | 'baseline-slower'
      | 'status-missing';
    maceFailure?:
      | 'arm-foreign'
      | 'preobserved'
      | 'observer-foreign'
      | 'marker-foreign'
      | 'cpu'
      | 'energy'
      | 'early'
      | 'changed-arm'
      | 'digest'
      | 'delivery'
      | 'transfer-fallback'
      | 'process'
      | 'failed';
    maceFallback?: boolean;
    gpuErrored?: boolean;
    gpuFreshVm?: boolean;
    /** The A100 quota gate: armed (quota 0) or skipped. */
    launchFailover?: 'armed' | 'unarmed' | 'armed-no-failover';
    eviction?:
      | 'sync-won'
      | 'sync-won-late'
      | 'failed'
      | 'lost-original'
      | 'short-payload'
      | 'exit-reclaimed'
      | 'exit-graced';
    diskFailure?:
      | 'foreign-ref'
      | 'foreign-row'
      | 'foreign-vm'
      | 'type'
      | 'size'
      | 'iops'
      | 'throughput'
      | 'missing-case';
  } = {},
) {
  const calls: string[] = [];
  const spotCommands = new JobPrivateCommands(
    {
      run: async () => {
        throw new Error('Unexpected native command in the Spot family fixture');
      },
    },
    new AbortController().signal,
  );
  const waits: { label: string; timeoutMs: number }[] = [];
  const unparsed = new Set<string>();
  const artifacts: { name: string; body: unknown }[] = [];
  const models = new Map<
    string,
    {
      fixture: CloudJobFixture;
      fault: boolean;
      detected: boolean;
      terminal: boolean;
      cleanup: boolean;
      native: boolean;
      outputReads: number;
      checkpointReads: number;
      identityReads: number;
    }
  >();
  let sequence = 0;
  // Like FixtureNames, one name per prefix within a run: a member that reuses
  // a prefix gets the same identity back instead of a fresh one.
  const allocatedNames = new Map<string, string>();
  let stableReads = 0;
  let checkpointReads = 0;
  let spotRequestReads = 0;
  let spotEarlyReads = 0;
  let spotFilterReads = 0;
  let spotEarlyActive = false;
  let runtimeSecretDeleted = false;
  let secretFile: 'newest' | 'stale' | 'missing' = 'newest';
  let hydrationTime = 1_000_000;
  let hydrationRestarted = false;
  let hydrationFaultAt: number | undefined;
  let hydrationRetried = false;
  let hydrationResumed = false;
  const evictionReads = new Map<string, number>();
  const model = (fixture: JobFixture) => {
    const found = models.get(fixture.ref.id);
    if (!found) throw new Error('unknown fixture');
    return found;
  };
  const status = (id: string, state?: WorkloadState): StatusResponse => {
    const m = models.get(id)!;
    if (member.kind === 'invalid-admission')
      return {
        status: WorkloadHealthStatus.Up,
        workload: persistentVmWorkload(id, {
          workloadType: WorkloadType.Job,
          state:
            options.admissionFailure === 'runtime'
              ? WorkloadState.Provisioning
              : WorkloadState.Invalid,
          completedAt: 5,
          cleanedAt: m.cleanup ? 6 : null,
          vmCount: 0,
        }),
        vms: [],
        events: [
          {
            id: 1,
            workloadId: id,
            createdAt: 5,
            state: WorkloadState.Invalid,
            metadata: {
              message: m.fixture.admissionCase!.expectedMessages[0],
            },
          },
        ],
      };
    const current =
      state ??
      (m.terminal || options.terminalEarly
        ? m.fixture.profile.expectedTerminalState
        : member.kind === 'input-hydration-recovery'
          ? WorkloadState.Syncing
          : WorkloadState.Running);
    const vms = attempts(m.fixture).map((attempt) => ({
      cloudId:
        options.baselineFailure === 'foreign-cloud-id'
          ? 'foreign-host'
          : attempt.cloudId,
      region:
        options.baselineFailure === 'resolved-region'
          ? 'foreign-region'
          : attempt.region,
      availabilityZone: options.omitStatusZone
        ? undefined
        : options.baselineFailure === 'resolved-zone' ||
            (runtimeSecretDeleted &&
              options.runtimeSecretFailure === 'status-zone')
          ? 'foreign-zone'
          : attempt.availabilityZone,
      endedAt: attempt.endedAt,
      ip: '192.0.2.10',
      vmType: attempt.vmType,
    }));
    return {
      status: WorkloadHealthStatus.Up,
      workload: persistentVmWorkload(id, {
        workloadType: WorkloadType.Job,
        state: current,
        cloudProvider: m.fixture.profile.computeProvider,
        region:
          options.baselineFailure === 'requested-region' ||
          (runtimeSecretDeleted &&
            options.runtimeSecretFailure === 'requested-region')
            ? 'foreign-request'
            : m.fixture.restrictedCredentialCase
              ? (m.fixture.restrictedCredentialCase.region ?? null)
              : m.fixture.profile.computeRegion || null,
        vmType:
          options.baselineFailure === 'requested-types'
            ? ['foreign-type']
            : [...submittedVmTypes(m.fixture)],
        imageDigest:
          member.kind === 'mace-full-pull'
            ? options.maceFailure === 'digest'
              ? `sha256:${'f'.repeat(64)}`
              : m.fixture.profile.image.split('@')[1]
            : null,
        availabilityZone: m.fixture.profile.computeZone ?? null,
        endReason:
          current !== WorkloadState.Completed
            ? null
            : options.eviction === 'exit-reclaimed' &&
                m.fixture.concurrentIndex === 1
              ? 'reclaimed'
              : 'exited',
        regions: m.fixture.profile.computeRegions
          ? [...m.fixture.profile.computeRegions]
          : null,
        // The spot-exit sibling's realistic clean-exit timing: a 28 s margin
        // under the 150 s grace, or waiting out the grace.
        completedAt: !m.terminal
          ? null
          : member.kind === 'spot-eviction' && m.fixture.concurrentIndex === 1
            ? options.eviction === 'exit-graced'
              ? 1 + (600 + 151) * 1000
              : 1 + 628_000
            : 5,
        cleanedAt: m.cleanup ? 6 : null,
      }),
      vms:
        options.baselineFailure === 'missing-live'
          ? []
          : options.baselineFailure === 'duplicate-live'
            ? [...vms, { ...vms[0], cloudId: 'extra-host' }]
            : vms,
      events: [
        // The refused head type fails over at once.
        ...(options.launchFailover === 'armed'
          ? [
              [WorkloadState.Provisioning, { untriedTargets: 3 }],
              [
                WorkloadState.Retrying,
                { disposition: 'failover-target', launchFailover: true },
              ],
              [WorkloadState.Provisioning, { untriedTargets: 2 }],
            ].map(([state, metadata], index) => ({
              id: index - 3,
              workloadId: id,
              createdAt: index * 1_000 - 3_000,
              state: state as WorkloadState,
              metadata: metadata as Record<string, unknown>,
            }))
          : []),
        {
          id: 1,
          workloadId: id,
          createdAt: 1,
          state: WorkloadState.Running,
          metadata: null,
        },
        ...(m.fault
          ? [
              {
                id: 2,
                workloadId: id,
                createdAt: 2,
                state: WorkloadState.Recovering,
                metadata:
                  member.kind === 'host-recovery'
                    ? {
                        reason: options.wrongHostReason
                          ? 'SSH unreachable'
                          : 'VM terminated (cloud confirmed)',
                      }
                    : null,
              },
            ]
          : []),
        ...(hydrationRetried
          ? [
              {
                id: 2,
                workloadId: id,
                createdAt: hydrationTime,
                state: WorkloadState.Retrying,
                metadata: {
                  reason: 'input hydration produced no output within 15 min',
                },
              },
            ]
          : []),
        ...(m.terminal
          ? [
              {
                id: 3,
                workloadId: id,
                createdAt: 5,
                state: current,
                metadata: { exitCode: 0 },
              },
            ]
          : []),
      ],
    };
  };
  const attempts = (fixture: JobFixture): JobNativeAttempt[] => {
    const m = model(fixture);
    const first: JobNativeAttempt = {
      ref: fixture.ref,
      rowId: 1,
      createdAt: 1,
      endedAt: m.fault ? 2 : m.terminal ? 5 : null,
      cloudId: `original-${fixture.ref.id}`,
      ip: '192.0.2.10',
      cloudProvider: fixture.profile.computeProvider,
      credentialId: (runtimeSecretDeleted &&
      options.runtimeSecretFailure === 'credential'
        ? 'b'
        : 'a'
      ).repeat(64),
      region: m.fixture.restrictedCredentialCase
        ? (m.fixture.restrictedCredentialCase.region ??
          (options.restrictedDeniedRegion ? 'ap-south-1' : 'us-east-2'))
        : fixture.profile.computeRegion ||
          fixture.profile.computeRegions?.[0] ||
          fixture.profile.storageRegion ||
          'observed-region',
      availabilityZone:
        options.nativeZone === undefined
          ? (fixture.profile.computeZone ?? 'a')
          : options.nativeZone,
      vmType: m.fixture.launchFailover
        ? fixture.profile.vmTypes.at(-1)!
        : (m.fixture.diskTierCase?.vmType ??
          m.fixture.restrictedCredentialCase?.vmType ??
          fixture.profile.vmTypes.find(
            (type) => !type.startsWith('totally_fake'),
          )!),
    };
    return [
      ...(((options.lostOriginal || options.eviction === 'lost-original') &&
        m.fault) ||
      (runtimeSecretDeleted &&
        options.runtimeSecretFailure === 'missing-attempt')
        ? []
        : [first]),
      ...(m.fault
        ? [
            {
              ...first,
              rowId: 2,
              createdAt: 3,
              endedAt: m.terminal ? 5 : null,
              cloudId:
                (member.kind === 'host-recovery' && !options.sameHost) ||
                options.gpuFreshVm
                  ? `replacement-${fixture.ref.id}`
                  : first.cloudId,
            },
          ]
        : []),
    ];
  };
  const unsupported = () =>
    Promise.reject(
      new Error('Local target must not execute for cloud members'),
    );
  const dependencies: DedicatedJobDependencies = {
    now: () => Date.now(),
    environment: new Environment(
      {
        E2E_JOB_FORCE_CLEANUP: options.forced ? '1' : '',
        PROBE_MEASURE_BASELINE: options.ghcrBaseline ? '1' : '0',
      },
      new Redactor(),
    ),
    names: {
      workload: (prefix) => {
        const existing = allocatedNames.get(prefix);
        if (existing) return existing;
        const allocated = `${prefix}-${++sequence}`;
        allocatedNames.set(prefix, allocated);
        return allocated;
      },
    },
    artifacts: {
      json: async (name, body) => {
        artifacts.push({ name, body });
        calls.push(`artifact:${name}`);
        return name;
      },
    },
    vmLedger: {
      snapshot: (ref, value) => snapshotStatusVmLedger(ref.id, value),
      liveEntries: liveStatusVmEntries,
    },
    wait: {
      for: async (label, probe, settings) => {
        waits.push({ label, timeoutMs: settings.timeoutMs });
        if (label === 'Job production inactivity watchdog') {
          hydrationTime =
            hydrationFaultAt! +
            (options.hydrationFailure === 'early-watchdog'
              ? 899_999
              : options.hydrationFailure === 'late-watchdog'
                ? 1_080_001
                : 900_000);
          hydrationRetried = true;
        }
        if (label === 'Job same-VM hydration worker replacement')
          hydrationResumed = true;
        // Like Waiter, re-probe only through an error its policy retries.
        let value = await probe(Date.now() + settings.timeoutMs).catch(
          (error: unknown) => {
            if (
              settings.probeError === 'fail' ||
              !settings.probeError.retry(error)
            )
              throw error;
            return probe(Date.now() + settings.timeoutMs);
          },
        );
        if (
          label === 'GHCR detached containerd pull' &&
          options.ghcrFailure === 'status-missing'
        ) {
          value = await probe(Date.now() + settings.timeoutMs);
          value = await probe(Date.now() + settings.timeoutMs);
        }
        // These poll until their condition holds, as Waiter does.
        for (
          let poll = 0;
          [
            'Job checkpoint health in CLI status',
            'Job early Spot request cancelled',
          ].includes(label) &&
          poll < 5 &&
          settings.unmet(value);
          poll++
        )
          value = await probe(Date.now() + settings.timeoutMs);
        const rejected = settings.reject?.(value);
        if (rejected) throw new Error(rejected);
        const unmet = settings.unmet(value);
        if (unmet) throw new Error(unmet);
        return value;
      },
    },
    target: {
      prepare: unsupported,
      prepareTerminal: unsupported,
      submit: unsupported,
      submitTerminal: unsupported,
      attempts: unsupported,
      configuration: unsupported,
      storage: unsupported,
      lateInputRemainsAbsent: unsupported,
      completedByCli: unsupported,
      nativeAbsence: unsupported,
      releaseResources: unsupported,
      firstGenerationAbsence: unsupported,
      resubmit: unsupported,
    },
    kernel: {
      status: async (ref) => {
        const m = models.get(ref.id)!;
        // The second child is the clean exit, which is never evicted.
        if (
          member.kind === 'spot-eviction' &&
          m.fixture.concurrentIndex === 0
        ) {
          // Running, then Finalizing; the eviction's restart adds its event.
          const reads = (evictionReads.get(ref.id) ?? 0) + 1;
          evictionReads.set(ref.id, reads);
          const won =
            (options.eviction === 'sync-won' && reads > 1) ||
            (options.eviction === 'sync-won-late' && m.fault);
          if (won) m.terminal = true;
          const current = won
            ? WorkloadState.Completed
            : reads === 1
              ? WorkloadState.Running
              : m.fault && options.eviction === 'failed'
                ? WorkloadState.Failed
                : WorkloadState.Finalizing;
          const observed = status(ref.id, current);
          return {
            ...observed,
            events: [
              ...observed.events.filter(
                (event) => event.state !== WorkloadState.Recovering,
              ),
              ...(m.fault && !won && options.eviction !== 'failed'
                ? [
                    {
                      id: 4,
                      workloadId: ref.id,
                      createdAt: 4,
                      state: WorkloadState.Finalizing,
                      metadata: { reason: 'final-bucket-sync-vm-restarted' },
                    },
                  ]
                : []),
            ],
          };
        }
        // The evicted GPU Job runs to its end on its own after the restart.
        if (member.kind === 'gpu-spot-eviction' && m.fault) m.terminal = true;
        if (m.fault && !m.detected && !m.terminal) {
          m.detected = true;
          return status(ref.id, WorkloadState.Recovering);
        }
        return status(
          ref.id,
          m.terminal && options.gpuErrored ? WorkloadState.Errored : undefined,
        );
      },
      requestTermination: async (ref) => {
        calls.push(`terminate:${ref.id}`);
        models.get(ref.id)!.terminal = true;
      },
      waitForState: async (ref, state) => {
        models.get(ref.id)!.terminal = true;
        return status(ref.id, state);
      },
      waitForCleanupRecorded: async (ref) => {
        calls.push(`cleanup:${ref.id}`);
        models.get(ref.id)!.cleanup = true;
        return cleanupRecordedForTest(ref, status(ref.id));
      },
      recordLedgerCleared: (ref, count) => {
        if (count !== 0) throw new Error('live ledger released');
        return vmLedgerClearedForTest(ref);
      },
      release: async ({ cleanup }) => {
        if (!models.get(cleanup.ref.id)!.native)
          throw new Error('native proof missing');
        calls.push(`release:${cleanup.ref.id}`);
      },
    },
    cloud: {
      ghcr: (fixture) => ({
        prepare: async () => {
          calls.push(`ghcr-prepare:${fixture.ref.id}`);
          return {
            image:
              options.ghcrFailure === 'image'
                ? 'wrong-image'
                : fixture.profile.ghcr!.image,
            layerDigest: `sha256:${'d'.repeat(64)}`,
            imageBytes: 1_000_000,
            resolution: 'runner',
          };
        },
        bind: async (attempt) => {
          calls.push(`ghcr-bind:${fixture.ref.id}:${attempt.rowId}`);
          if (options.ghcrFailure === 'host')
            throw new Error('foreign pinned host');
        },
        throughput: async () =>
          [
            options.ghcrFailure === 'fingerprint'
              ? ''
              : 'PROBE fingerprint kernel=linux nproc=4',
            options.ghcrFailure === 'verdict'
              ? ''
              : 'PROBE verdict PER_CONNECTION_CAP ratio=2.0 note=parallel',
          ].join('\n'),
        startPull: async () => {
          calls.push(`ghcr-start:${fixture.ref.id}`);
          if (options.ghcrFailure === 'start')
            throw new Error('unknown detached start');
        },
        poll: async () => {
          calls.push(`ghcr-poll:${fixture.ref.id}`);
          if (options.ghcrFailure === 'poll')
            throw new Error('unreadable pull status');
          return options.ghcrFailure === 'status-missing'
            ? { state: 'inactive' }
            : {
                state: 'done',
                exitCode: options.ghcrFailure === 'exit' ? 1 : 0,
              };
        },
        capture: async () => {
          calls.push(`ghcr-capture:${fixture.ref.id}`);
          if (options.ghcrFailure === 'capture')
            throw new Error('pull output unavailable');
          return [
            options.ghcrFailure === 'visibility'
              ? ''
              : 'PARALLEL_PULL docker_visibility PASS inspect=ok',
            options.ghcrFailure === 'support'
              ? ''
              : 'PARALLEL_PULL verdict SUPPORTED fallback=not_needed',
            options.ghcrFailure === 'cleanup'
              ? ''
              : 'PARALLEL_PULL cleanup PASS daemons=absent',
            'PARALLEL_PULL pull mib_per_second=10',
            !options.ghcrBaseline || options.ghcrFailure === 'baseline-missing'
              ? ''
              : options.ghcrFailure === 'baseline-cached'
                ? 'PARALLEL_PULL baseline error=cached_layers'
                : `PARALLEL_PULL baseline mib_per_second=${options.ghcrFailure === 'baseline-slower' ? 11 : 5}`,
          ].join('\n');
        },
        finish: async () => {
          calls.push(`ghcr-finish:${fixture.ref.id}`);
        },
      }),
      mace: (fixture) => {
        let armedAt = 0;
        let observed = false;
        return {
          start: async (timeoutMs) => {
            calls.push(`mace-arm:${fixture.ref.id}:${timeoutMs}`);
            armedAt = Date.now();
          },
          observation: async () => {
            const afterSubmit = observed;
            observed = true;
            calls.push(`mace-observe:${fixture.ref.id}:${afterSubmit}`);
            return {
              schemaVersion: 2,
              observationSource: 'ci-api-log-stream',
              workloadId: (
                afterSubmit
                  ? options.maceFailure === 'observer-foreign'
                  : options.maceFailure === 'arm-foreign'
              )
                ? 'foreign'
                : fixture.ref.id,
              runId: `${fixture.ref.id}-run`,
              phase:
                options.maceFailure === 'preobserved'
                  ? 'observed'
                  : afterSubmit
                    ? options.maceFailure === 'failed'
                      ? 'failed'
                      : 'observed'
                    : 'armed',
              observerArmedAtMs:
                armedAt +
                (afterSubmit && options.maceFailure === 'changed-arm' ? 1 : 0),
              firstInferenceLogObservedAtMs: afterSubmit
                ? options.maceFailure === 'early'
                  ? armedAt - 1
                  : Date.now()
                : null,
              marker: afterSubmit
                ? {
                    payload: {
                      name: 'first_inference_done',
                      runId:
                        options.maceFailure === 'marker-foreign'
                          ? 'foreign-run'
                          : `${fixture.ref.id}-run`,
                      device: options.maceFailure === 'cpu' ? 'cpu' : 'cuda',
                      energy:
                        options.maceFailure === 'energy' ? Infinity : -12.3,
                    },
                  }
                : null,
            };
          },
          finish: async () => {
            calls.push(`mace-finish:${fixture.ref.id}`);
            if (options.maceFailure === 'process')
              throw new Error('observer process failed');
          },
          writeReport: async (status, observer, deliveryPath) => {
            await dependencies.artifacts.json(
              `job-${fixture.ref.id}-mace-report`,
              buildMaceReport(status ?? null, observer ?? null, {
                generatedAt: new Date().toISOString(),
                cloud: fixture.profile.member.target,
                workloadId: fixture.ref.id,
                image: fixture.profile.image,
                vmType: fixture.profile.vmTypes[0],
                deliveryPath,
              }),
            );
          },
          pullLogMessages: async () =>
            options.maceFailure === 'delivery'
              ? ['Image pulled successfully']
              : options.maceFailure === 'transfer-fallback'
                ? [
                    'Containerd transfer pull failed; retrying with Docker',
                    'Image pulled successfully',
                  ]
                : options.maceFallback
                  ? [
                      'Containerd transfer unavailable; using Docker pull',
                      'Image pulled successfully',
                    ]
                  : ['Image pulled successfully with containerd transfer'],
        };
      },
      diskTier: async (fixture, attempt) => {
        calls.push(`disk:${fixture.ref.id}`);
        const diskCase = fixture.diskTierCase!;
        return {
          ref:
            options.diskFailure === 'foreign-ref'
              ? trackedWorkloadRefForTest(fixture.ref.id)
              : fixture.ref,
          rowId:
            options.diskFailure === 'foreign-row'
              ? attempt.rowId + 1
              : attempt.rowId,
          identity: {
            cloudId:
              options.diskFailure === 'foreign-vm'
                ? 'other-vm'
                : attempt.cloudId,
            vmId: '123456',
            osDiskId: '987654',
            region: attempt.region,
            zone: `${attempt.region}-${attempt.availabilityZone}`,
            vmType: attempt.vmType,
          },
          diskType:
            options.diskFailure === 'type'
              ? 'wrong-type'
              : diskCase.expectedType,
          sizeGb: options.diskFailure === 'size' ? 10 : 100,
          provisionedIops:
            options.diskFailure === 'iops' ? 4_000 : diskCase.expectedIops,
          provisionedThroughput:
            options.diskFailure === 'throughput' ? 500 : 1_000,
        };
      },
      submitAdmission: async (fixture) => {
        calls.push(`admission:${fixture.ref.id}`);
        if (options.admissionFailure === 'lost-reply')
          throw new Error('unknown admission response');
        return options.admissionFailure === 'accepted' ||
          fixture.admissionCase!.outcome === 'invalid'
          ? 'accepted'
          : 'rejected';
      },
      admissionStatus: async (fixture) => status(fixture.ref.id).workload.state,
      admissionOutcome: async (fixture) => {
        const selected = fixture.admissionCase!;
        return {
          ref:
            options.admissionFailure === 'foreign'
              ? trackedWorkloadRefForTest('foreign')
              : fixture.ref,
          kind: selected.outcome,
          message:
            options.admissionFailure === 'wrong-message'
              ? 'authentication failed'
              : selected.expectedMessages[0].replace(
                  '{bucket}',
                  `${selected.bucketPrefix ?? ''}${fixture.ref.id}`,
                ) +
                (selected.kind === 'docker-gpu' ? ` "${selected.vmType}"` : ''),
        };
      },
      releaseUncreated: async (fixture, proof) => {
        expect(proof.ref).toBe(fixture.ref);
        if (!model(fixture).native) throw new Error('native proof missing');
        calls.push(`release-uncreated:${fixture.ref.id}`);
      },
      runtimeSecretFacts: async (fixture) => {
        calls.push(`runtime-secrets:${fixture.ref.id}:${runtimeSecretDeleted}`);
        const primary = fixture.concurrentIndex === 0;
        return {
          environment:
            (primary
              ? options.runtimeSecretFailure !== 'environment'
              : options.runtimeSecretFailure !== 'override') &&
            !(
              runtimeSecretDeleted &&
              options.runtimeSecretFailure === 'after-environment'
            ),
          containerId: (runtimeSecretDeleted &&
          options.runtimeSecretFailure === 'container'
            ? 'c'
            : primary
              ? 'a'
              : 'b'
          ).repeat(64),
          startedAt:
            runtimeSecretDeleted && options.runtimeSecretFailure === 'started'
              ? '2026-09-22T01:01:00Z'
              : '2026-09-22T01:00:00Z',
          mode: options.runtimeSecretFailure === 'mode' ? '644' : '600',
          uid: options.runtimeSecretFailure === 'owner' ? 1000 : 0,
          fileSystem:
            options.runtimeSecretFailure === 'filesystem' ? 'ext4' : 'tmpfs',
          ...(!runtimeSecretDeleted && {
            privateGit:
              options.runtimeSecretFailure !==
              (primary ? 'git' : 'git-control'),
          }),
        };
      },
      runtimeSecretFile: async () => ({
        value: secretFile,
        mode: options.runtimeSecretFailure === 'file-mode' ? '644' : '444',
        uid: 0,
        nobodyReads: options.runtimeSecretFailure !== 'file-unreadable',
        fileSystem: 'tmpfs',
      }),
      updateRuntimeSecret: async () => {
        calls.push('update-runtime-secret');
        secretFile =
          options.runtimeSecretFailure === 'file-update' ? 'stale' : 'newest';
      },
      clearRuntimeSecretFiles: async () => {
        calls.push('clear-runtime-secret-files');
        secretFile =
          options.runtimeSecretFailure === 'file-restore'
            ? 'missing'
            : 'newest';
      },
      forceDeleteRuntimeSecret: async () => {
        calls.push('force-delete-runtime-secret');
        runtimeSecretDeleted = true;
        if (options.runtimeSecretFailure === 'file-deleted')
          secretFile = 'missing';
      },
      spot: (fixture) => ({
        now: () => Date.now(),
        active: async (attempt) => {
          calls.push('spot-active');
          return {
            id: 'sir-original',
            region: attempt.region,
            instanceId: attempt.cloudId,
            type: (options.spotFailure === 'not-persistent'
              ? 'one-time'
              : 'persistent') as 'persistent',
            state: 'active',
          };
        },
        launched: async (attempt) => {
          calls.push(`spot-launched:${fixture.ref.id}`);
          return {
            request: {
              id: 'sir-original',
              region: attempt.region,
              instanceId: attempt.cloudId,
              type: 'persistent',
              state: 'active',
            },
            launchedAt: SPOT_LAUNCHED_AT,
          };
        },
        // The old lookup misses up to the cancel and finds it in the guard.
        instanceFilter: async () =>
          (
            spotEarlyActive
              ? options.spotFailure === 'filter-before-cancel'
              : ++spotFilterReads === 1
                ? options.spotFailure === 'filter-found'
                : options.spotFailure !== 'control-missing'
          )
            ? [
                {
                  id: 'sir-original',
                  region: fixture.profile.storageRegion,
                  instanceId: `original-${fixture.ref.id}`,
                  type: 'persistent' as const,
                  state: 'cancelled' as const,
                },
              ]
            : [],
        request: async () => {
          calls.push('spot-request');
          spotRequestReads++;
          // Reverted: the early Job's request reopens.
          const early = fixture.ref.id.includes('j-spot-early');
          const earlyReads = early ? ++spotEarlyReads : 0;
          const state: 'active' | 'cancelled' =
            options.spotFailure === 'uncancelled' ||
            (options.spotFailure === 'early-reopened' && early) ||
            (options.spotFailure === 'filter-before-cancel' &&
              earlyReads === 1) ||
            (options.spotFailure === 'reopened' && spotRequestReads > 1)
              ? 'active'
              : 'cancelled';
          spotEarlyActive = early && state === 'active';
          return {
            id:
              options.spotFailure === 'foreign-request'
                ? 'sir-foreign'
                : 'sir-original',
            region: fixture.profile.storageRegion,
            // AWS may name the instance on its request only after a while.
            instanceId:
              options.spotFailure === 'late-instance' && earlyReads === 1
                ? undefined
                : `original-${fixture.ref.id}`,
            ...(early && {
              statusCode: 'request-canceled-and-instance-running',
              updatedAt: SPOT_LAUNCHED_AT + 20_000,
            }),
            type: 'persistent',
            state,
          };
        },
        liveInstances: async (deadlineAt) => {
          calls.push('spot-guard');
          // Like the bounded native command, a read is killed at its deadline.
          const readMs = options.spotReadMs ?? 0;
          if (readMs > 0) {
            const allowedMs = Math.max(0, deadlineAt - Date.now());
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(readMs, allowedMs)),
            );
            if (readMs > allowedMs)
              throw new Error('Spot replacement read reached its deadline');
          }
          return options.spotFailure === 'replacement'
            ? ['untracked-replacement']
            : [];
        },
        pause: async (milliseconds, deadlineAt) => {
          calls.push(`spot-pause:${milliseconds}`);
          await spotCommands.wait(milliseconds, deadlineAt);
        },
      }),
      hydration: () => ({
        snapshot: async () => ({
          observedAt: hydrationTime,
          active: true,
          invocation: (hydrationResumed ? 'b' : 'a').repeat(32),
          pid: hydrationResumed ? 41 : 40,
          identity: (hydrationResumed &&
          options.hydrationFailure === 'lost-input'
            ? 'f'
            : 'e'
          ).repeat(64),
          logBytes: hydrationFaultAt === undefined ? hydrationTime : 0,
        }),
        apiLogs: async () => ({
          launched:
            hydrationRestarted &&
            options.hydrationFailure === 'relaunched-worker'
              ? 2
              : 1,
          adopted: hydrationRestarted ? 1 : 0,
        }),
        restart: async () => {
          calls.push('restart-hydration-api');
          hydrationRestarted = true;
          return {
            identityBefore: 'c'.repeat(64),
            identityAfter: (options.hydrationFailure === 'new-controller'
              ? 'f'
              : 'c'
            ).repeat(64),
          };
        },
        disk: async () => ({
          id: 'original-boot-disk',
          type: 'gp3',
          sizeGb: 350,
          iops: 3000,
          throughput: 125,
        }),
        hideActivity: async () => {
          calls.push('hide-hydration-activity');
          hydrationFaultAt = hydrationTime;
          return {
            observedAt: hydrationTime,
            visibleBytes: 0,
            hiddenBytes: hydrationTime,
          };
        },
        activity: async () => ({
          observedAt: hydrationTime,
          visibleBytes: 0,
          hiddenBytes: hydrationTime,
        }),
        pause: async (milliseconds) => {
          calls.push(`hydration-pause:${milliseconds}`);
          hydrationTime += milliseconds;
        },
        manifest: async () =>
          `count=2048\nbytes=274877906944\nfirst=${'d'.repeat(64)}\nmiddle=${(options.hydrationFailure === 'bad-shard' ? 'f' : 'd').repeat(64)}\nlast=${'d'.repeat(64)}\n`,
      }),
      prepare: async (ids, profile) => {
        // The real transport admits exactly this group (see its guard test).
        if (ids.length !== jobGroupSize(profile))
          throw new Error('Cloud Job group has an invalid member or identity');
        const writes = ids.map((id, index) => ({
          key: `job-${index + 1}/output.txt`,
          contents: `content-${id}`,
        }));
        const fixtures = ids.map((id, index) => {
          const fixture: CloudJobFixture = {
            ref: trackedWorkloadRefForTest(id),
            profile,
            admissionCase: profile.admissionCases?.[index],
            diskTierCase: profile.diskTierCases?.[index],
            restrictedCredentialCase:
              profile.restrictedCredential?.cases[index],
            credentialName: 'test-original',
            storageCredentialName: 'storage-original',
            inputBucket: member.kind === 'host-recovery' ? undefined : 'input',
            outputBucket:
              member.kind === 'host-recovery' ||
              (profile.restrictedCredential &&
                profile.restrictedCredential.cases[index]?.key !== 'output')
                ? undefined
                : 'shared-output',
            checkpointBucket:
              profile.spot || profile.explicitCheckpoint ? id : undefined,
            runLabel: ids[0],
            concurrentIndex: index,
            concurrentWrites: writes,
            launchFailover: options.launchFailover && {
              quotas: { 'us-east1': { NVIDIA_A100_GPUS: 0 } },
              armed: options.launchFailover !== 'unarmed',
            },
            hydration:
              member.kind === 'input-hydration-recovery'
                ? {
                    seedSha256: 'd'.repeat(64),
                    apiContainerId: 'c'.repeat(64),
                    command: 'fixed-shared-payload',
                    objects: 2049,
                    bytes: 2049 * 128 * 1024 * 1024,
                  }
                : undefined,
          };
          models.set(id, {
            fixture,
            fault: false,
            detected: false,
            terminal: false,
            cleanup: false,
            native: false,
            outputReads: 0,
            checkpointReads: 0,
            identityReads: 0,
          });
          return fixture;
        });
        if (options.runtimeChildren === 'missing') return fixtures.slice(0, 1);
        if (options.admissionFailure === 'missing-case')
          return fixtures.slice(0, 1);
        if (options.diskFailure === 'missing-case') return fixtures.slice(0, 5);
        if (options.runtimeChildren === 'duplicate')
          return [fixtures[0], fixtures[0]];
        if (options.runtimeChildren === 'wrong-order')
          return fixtures.reverse();
        return fixtures;
      },
      submit: async (fixture) => {
        calls.push(`submit:${fixture.ref.id}`);
      },
      attempts: async (fixture) => attempts(fixture),
      imageConfigDigest: async () =>
        options.badImageDigest ? 'nginx:alpine' : `sha256:${'d'.repeat(64)}`,
      transfers: async () => ({
        listedBucket: true,
        rootObject: true,
        nestedPrefix: true,
        literalPrefix: true,
        recursiveObjects: true,
        recursive: {
          rootContents: true,
          nestedContents: true,
          hiddenContents: true,
          existingMode: !options.badTransfer,
          newMode: true,
          singleContents: true,
          singleMode: true,
          collisions: true,
          deletedPrefix: true,
          retainedSibling: true,
        },
      }),
      bucketReady: async () => true,
      results: async (fixture, role) => {
        if (fixture.restrictedCredentialCase)
          return { marker: fixture.runLabel };
        if (member.kind === 'gpu-spot-eviction')
          return {
            [role === 'output' ? 'resumed' : 'started']: fixture.ref.id,
          };
        const m = model(fixture);
        const read = `${fixture.ref.id}:${role}:${m.terminal}`;
        if (
          options.unparsedResults === 'final-never'
            ? m.terminal
            : options.unparsedResults && !unparsed.has(read)
        ) {
          unparsed.add(read);
          throw new JobResultNotJson(17);
        }
        const count = m.terminal
          ? options.incompleteFinal
            ? 9
            : 10
          : role === 'output'
            ? ++m.outputReads
            : ++m.checkpointReads < 3
              ? 3
              : 4;
        const molecules = Object.fromEntries(
          JOB_BUCKET_MOLECULES.slice(0, count).map((name, index) => [
            name,
            -index - 1,
          ]),
        );
        if (options.changedCheckpoint && m.fault && role === 'checkpoint')
          molecules.H2O = 999;
        return { run_label: fixture.runLabel, molecules };
      },
      runtime: async () => ({
        inputReadOnly: true,
        lateInputAbsent: !options.badRuntime,
        environment: true,
        logsFollower: true,
        gpus: [],
      }),
      logs: async () => 'actual container logs',
      statusCheckpoint: async (fixture) => {
        if (!fixture.checkpointBucket) return undefined;
        checkpointReads += 1;
        // The supervisor's `.rclone-keep` probe lists before any checkpoint.
        const markerOnly =
          checkpointReads <= (options.zeroByteCheckpointReads ?? 0);
        return {
          bucket: fixture.checkpointBucket,
          mount: '/mnt/checkpoint',
          retained:
            Boolean(fixture.profile.explicitCheckpoint) !==
            (options.retainedMismatch === true),
          health: {
            objects: 1,
            bytes: markerOnly ? 0 : 10,
            lastModifiedAt: 1,
            truncated: options.truncatedCheckpointHealth === true,
          },
        };
      },
      logsStopWithTheirReader: async () => ({
        matched: true,
        cliExitedZero: !options.logsKeepStreaming,
      }),
      completedByCli: async (fixture) => {
        calls.push(`cli-completion:${fixture.ref.id}`);
        return { waitSucceeded: true, statusFinished: true };
      },
      writeConcurrent: async (fixture) => {
        calls.push(`write:${fixture.ref.id}`);
      },
      concurrentContents: async (fixture) => {
        stableReads++;
        const contents = fixture.concurrentWrites.map(
          (write) => write.contents,
        );
        if (
          (stableReads > 1 && options.lostChild) ||
          (options.lostChildAfterTermination &&
            [...models.values()].every((m) => m.terminal))
        )
          contents[1] = 'lost';
        calls.push(
          `contents:${[...models.values()].every((m) => m.terminal) ? 'terminated' : 'active'}`,
        );
        return contents;
      },
      evictionOutput: async (fixture) => ({
        marker: `spot-eviction-${fixture.ref.id}`,
        payloadBytes:
          options.eviction === 'short-payload' ? 1 : 24_576 * 1024 * 1024,
      }),
      syncCycle: async () => {
        calls.push('sync-70-seconds');
      },
      verificationRetry: async () => {
        calls.push('retry-30-seconds');
      },
      recoveryIdentity: async (
        fixture,
        attempt,
      ): Promise<JobRecoveryIdentity> => {
        const m = model(fixture);
        m.identityReads++;
        return {
          cloudId: attempt.cloudId,
          region: attempt.region,
          zone: 'native-zone-a',
          vmType: attempt.vmType,
          vmId:
            member.kind === 'host-recovery' && m.fault
              ? 'replacement-native-vm'
              : 'original-native-vm',
          osDiskId:
            options.wrongDisk && m.identityReads > 1
              ? 'replacement-boot-disk'
              : 'original-boot-disk',
        };
      },
      stop: async (fixture) => {
        calls.push('native-stop');
        model(fixture).fault = true;
      },
      deleteHost: async (fixture) => {
        calls.push('native-delete');
        model(fixture).fault = true;
      },
      injectGpuXid: async (fixture, pci, code) => {
        calls.push(`inject-gpu-xid:${fixture.ref.id}`);
        return {
          line: `<3>NVRM: Xid (PCI:${pci}): ${code}, pid=0, name=test, GPU has fallen off the bus.`,
          journalConfirmed: true,
        };
      },
      writeHostCheckpoint: async () => {
        calls.push('write-host-checkpoint');
      },
      hostCheckpoint: async (fixture, source) => {
        calls.push(`host-checkpoint:${source}`);
        if (source === 'bucket' && options.missingHostUpload) return undefined;
        if (source === 'container' && options.wrongRestoredCheckpoint)
          return 'wrong-checkpoint';
        return `checkpoint-${fixture.ref.id}`;
      },
      nativeAbsence: async (fixture) => {
        calls.push(`native-absence:${fixture.ref.id}`);
        if (options.cleanupFailure)
          throw new Error('native inventory uncertain');
        model(fixture).native = true;
        return substrateAbsentForTest(fixture.ref);
      },
      // Like the real storage owner: one check per group's one automatic
      // bucket, once every child is natively absent.
      automaticCheckpointAbsence: async (fixture) => {
        calls.push(`automatic-checkpoint-absence:${fixture.ref.id}`);
        if (
          calls.filter((call) =>
            call.startsWith('automatic-checkpoint-absence:'),
          ).length > 1
        )
          throw new Error(
            'automatic cleanup assertion is unavailable or reused',
          );
        if ([...models.values()].some((child) => !child.native))
          throw new Error('Job group still owns an unresolved native child');
      },
      releaseResources: async (fixture) => {
        calls.push(`release-resources:${fixture.ref.id}`);
        if (options.explicitCheckpointCleanupFailure)
          throw new Error('explicit checkpoint absence unproved');
        if (
          options.sharedReleaseFailure &&
          model(fixture).fixture.concurrentIndex === models.size - 1
        )
          throw new Error(
            `shared ${options.sharedReleaseFailure} absence unproved`,
          );
      },
    },
  };
  return {
    run: () => new DedicatedJobContract(dependencies).run(member),
    calls,
    waits,
    artifacts,
    models,
  };
}

describe('concrete cloud Job family consumers', () => {
  test('disk-tier proves all six original boot disks serially before one member finalization', async () => {
    const world = harness({ kind: 'disk-tier', target: 'gcp' });
    await expect(world.run()).resolves.toMatchObject({ satisfied: true });
    const submits = world.calls.filter((call) => call.startsWith('submit:'));
    expect(submits).toHaveLength(6);
    expect(world.calls.filter((call) => call.startsWith('disk:'))).toHaveLength(
      6,
    );
    for (let index = 1; index < submits.length; index += 1) {
      const previousId = submits[index - 1].slice('submit:'.length);
      expect(world.calls.indexOf(`native-absence:${previousId}`)).toBeLessThan(
        world.calls.indexOf(submits[index]),
      );
    }
    expect(
      world.calls.filter((call) => call.startsWith('release-resources:')),
    ).toHaveLength(6);
    expect(
      world.calls.findIndex((call) => call.startsWith('release:')),
    ).toBeGreaterThan(
      world.calls.findLastIndex((call) => call.startsWith('disk:')),
    );
    expect(world.waits.map(({ timeoutMs }) => timeoutMs)).toEqual(
      Array(6).fill(1_200_000),
    );
    expect(
      world.artifacts.filter(({ name }) => name === 'dedicated-job-result'),
    ).toHaveLength(1);
  });

  test.each([
    'foreign-ref',
    'foreign-row',
    'foreign-vm',
    'type',
    'size',
    'iops',
    'throughput',
    'missing-case',
  ] as const)(
    'disk-tier %s cannot release or complete the member',
    async (diskFailure) => {
      const world = harness(
        { kind: 'disk-tier', target: 'gcp' },
        { diskFailure },
      );
      await expect(world.run()).rejects.toThrow();
      expect(world.calls.some((call) => call.startsWith('release'))).toBe(
        false,
      );
      expect(
        world.artifacts.some(({ name }) => name === 'dedicated-job-result'),
      ).toBe(false);
    },
  );

  test('disk-tier cleanup uncertainty blocks the next allocation', async () => {
    const world = harness(
      { kind: 'disk-tier', target: 'gcp' },
      { cleanupFailure: true },
    );
    await expect(world.run()).rejects.toThrow('native inventory uncertain');
    expect(
      world.calls.filter((call) => call.startsWith('submit:')),
    ).toHaveLength(1);
    expect(world.calls.some((call) => call.startsWith('release'))).toBe(false);
  });

  test('disk-tier rejects terminal-only evidence before native extension reads', async () => {
    const world = harness(
      { kind: 'disk-tier', target: 'gcp' },
      { terminalEarly: true },
    );
    await expect(world.run()).rejects.toThrow(
      'cloud extensions require a live Job',
    );
    expect(world.calls.some((call) => call.startsWith('disk:'))).toBe(false);
  });

  test.each([false, true])(
    'GHCR preserves explicit baseline=%s, original preparation order and finalizer ownership',
    async (ghcrBaseline) => {
      const world = harness(
        { kind: 'ghcr-probe', target: 'azure' },
        { ghcrBaseline },
      );
      await expect(world.run()).resolves.toMatchObject({ satisfied: true });
      expect(world.calls.indexOf('ghcr-prepare:j-ghcr-1')).toBeLessThan(
        world.calls.indexOf('submit:j-ghcr-1'),
      );
      expect(world.calls.indexOf('ghcr-bind:j-ghcr-1:1')).toBeLessThan(
        world.calls.indexOf('ghcr-start:j-ghcr-1'),
      );
      expect(world.calls.indexOf('ghcr-finish:j-ghcr-1')).toBeLessThan(
        world.calls.indexOf('terminate:j-ghcr-1'),
      );
      expect(world.calls.indexOf('native-absence:j-ghcr-1')).toBeLessThan(
        world.calls.indexOf('release:j-ghcr-1'),
      );
      expect(
        world.artifacts.find(
          ({ name }) => name === 'job-j-ghcr-1-ghcr-extension',
        )?.body,
      ).toMatchObject({
        generation: 1,
        pull: {
          probeCleanup: true,
          baseline: { requested: ghcrBaseline, measured: ghcrBaseline },
        },
      });
      expect(world.waits.map(({ timeoutMs }) => timeoutMs)).toEqual([
        1_800_000,
        ghcrBaseline ? 2_400_000 : 1_200_000,
      ]);
    },
  );

  test.each([
    ['image', 'declared pinned payload'],
    ['fingerprint', 'fingerprint or verdict'],
    ['verdict', 'fingerprint or verdict'],
    ['host', 'foreign pinned host'],
    ['start', 'unknown detached start'],
    ['poll', 'unreadable pull status'],
    ['exit', 'exited nonzero'],
    ['capture', 'pull output unavailable'],
    ['visibility', 'Docker visibility'],
    ['support', 'supported verdict'],
    ['cleanup', 'automatic probe cleanup'],
    ['baseline-missing', 'cold single-stream baseline'],
    ['baseline-cached', 'cold single-stream baseline'],
    ['baseline-slower', 'did not beat'],
    ['status-missing', 'without its original exit record'],
  ] as const)(
    'GHCR %s remains failed and armed for native cleanup',
    async (ghcrFailure, message) => {
      const world = harness(
        { kind: 'ghcr-probe', target: 'azure' },
        { ghcrFailure, ghcrBaseline: true },
      );
      await expect(world.run()).rejects.toThrow(message);
      expect(world.calls.some((call) => call.startsWith('release'))).toBe(
        false,
      );
      expect(
        world.artifacts.some(({ name }) => name === 'dedicated-job-result'),
      ).toBe(false);
      if (['poll', 'exit', 'status-missing'].includes(ghcrFailure))
        expect(world.calls).toContain('ghcr-capture:j-ghcr-1');
    },
  );

  test('GHCR terminal-only evidence never launches probes; forced cleanup retains the live original detached pull', async () => {
    const early = harness(
      { kind: 'ghcr-probe', target: 'azure' },
      { terminalEarly: true },
    );
    await expect(early.run()).rejects.toThrow('require a live Job');
    expect(early.calls).not.toContain('ghcr-start:j-ghcr-1');
    const forced = harness(
      { kind: 'ghcr-probe', target: 'azure' },
      { forced: true },
    );
    await expect(forced.run()).rejects.toThrow('E2E_JOB_FORCED_CLEANUP');
    expect(forced.calls).toContain('ghcr-start:j-ghcr-1');
    expect(
      forced.calls.some(
        (call) => call.startsWith('release') || call.startsWith('terminate'),
      ),
    ).toBe(false);
    expect(forced.models.get('j-ghcr-1')?.terminal).toBe(false);
  });

  test.each(['aws', 'azure', 'gcp', 'lambda'] as const)(
    '%s MACE arms before create, binds CUDA/report data, and releases only through final cleanup',
    async (target) => {
      const world = harness({ kind: 'mace-full-pull', target });
      await expect(world.run()).resolves.toMatchObject({ satisfied: true });
      expect(world.calls.indexOf('mace-arm:j-mace-1:5400000')).toBeLessThan(
        world.calls.indexOf('submit:j-mace-1'),
      );
      expect(world.calls.indexOf('mace-finish:j-mace-1')).toBeLessThan(
        world.calls.indexOf('native-absence:j-mace-1'),
      );
      expect(world.calls.indexOf('native-absence:j-mace-1')).toBeLessThan(
        world.calls.indexOf('release:j-mace-1'),
      );
      expect(
        world.artifacts.find(({ name }) => name === 'job-j-mace-1-mace-report')
          ?.body,
      ).toMatchObject({
        reportType: 'mace-timing',
        schemaVersion: 2,
        cloud: target,
        workloadId: 'j-mace-1',
        deliveryPath: 'containerd-transfer',
        finalState: WorkloadState.Completed,
        firstInference: { device: 'cuda', energy: -12.3 },
      });
      expect(world.waits.slice(0, 2).map(({ timeoutMs }) => timeoutMs)).toEqual(
        [10_000, 5_400_000],
      );
      expect(world.waits[2].timeoutMs).toBeLessThanOrEqual(5_400_000);
      expect(world.calls.at(-1)).toBe('artifact:dedicated-job-result');
    },
  );

  test('MACE accepts Docker only where containerd transfer is unavailable', async () => {
    const world = harness(
      { kind: 'mace-full-pull', target: 'aws' },
      { maceFallback: true },
    );
    await expect(world.run()).resolves.toMatchObject({ satisfied: true });
    expect(
      world.artifacts.find(({ name }) => name === 'job-j-mace-1-mace-report')
        ?.body,
    ).toMatchObject({ deliveryPath: 'docker-fallback' });
  });

  test.each([
    'arm-foreign',
    'preobserved',
    'observer-foreign',
    'marker-foreign',
    'cpu',
    'energy',
    'early',
    'changed-arm',
    'digest',
    'delivery',
    'transfer-fallback',
    'process',
    'failed',
  ] as const)(
    'MACE %s preserves failure evidence without release or completion',
    async (maceFailure) => {
      const world = harness(
        { kind: 'mace-full-pull', target: 'aws' },
        { maceFailure },
      );
      const message = {
        'arm-foreign': 'pre-submission binding',
        preobserved: 'observer ran before its Job submission',
        'observer-foreign': 'MACE inference',
        'marker-foreign': 'MACE inference',
        cpu: 'MACE inference',
        energy: 'MACE inference',
        early: 'MACE inference',
        'changed-arm': 'MACE inference',
        digest: 'original pinned image',
        delivery: 'image delivery path',
        'transfer-fallback': 'image delivery path',
        process: 'observer process failed',
        failed: 'MACE observer failed before CUDA inference',
      }[maceFailure];
      await expect(world.run()).rejects.toThrow(message);
      expect(world.calls.some((call) => call.startsWith('release'))).toBe(
        false,
      );
      expect(
        world.artifacts.some(({ name }) => name === 'dedicated-job-result'),
      ).toBe(false);
      expect(
        world.artifacts.find(({ name }) => name === 'job-j-mace-1-mace-report')
          ?.body,
      ).toMatchObject({ reportType: 'mace-timing', schemaVersion: 2 });
    },
  );

  test('MACE rejects terminal-only evidence and forces cleanup while the original Job is active', async () => {
    const early = harness(
      { kind: 'mace-full-pull', target: 'azure' },
      { terminalEarly: true },
    );
    await expect(early.run()).rejects.toThrow('require a live Job');
    expect(early.calls.some((call) => call.startsWith('release'))).toBe(false);
    const forced = harness(
      { kind: 'mace-full-pull', target: 'gcp' },
      { forced: true },
    );
    await expect(forced.run()).rejects.toThrow('E2E_JOB_FORCED_CLEANUP');
    expect(
      forced.calls.some(
        (call) => call.startsWith('mace-finish') || call.startsWith('release'),
      ),
    ).toBe(false);
    expect(forced.models.get('j-mace-1')?.terminal).toBe(false);
  });

  test('disk-tier forced cleanup retains every reference and the final live child', async () => {
    const world = harness(
      { kind: 'disk-tier', target: 'gcp' },
      { forced: true },
    );
    await expect(world.run()).rejects.toThrow('E2E_JOB_FORCED_CLEANUP');
    expect(world.calls.filter((call) => call.startsWith('disk:'))).toHaveLength(
      6,
    );
    expect(
      world.calls.filter((call) => call.startsWith('terminate:')),
    ).toHaveLength(5);
    expect(world.calls.some((call) => call.startsWith('release'))).toBe(false);
    expect(
      world.artifacts.some(({ name }) => name === 'dedicated-job-result'),
    ).toBe(false);
  });

  test.each([
    { target: 'aws', cases: 2 },
    { target: 'azure', cases: 3 },
    { target: 'gcp', cases: 2 },
  ] as const)(
    '$target verifies every admission case before releasing the group',
    async ({ target, cases }) => {
      const world = harness({ kind: 'invalid-admission', target });
      await expect(world.run()).resolves.toMatchObject({ satisfied: true });
      // Every admission case is its own Workload; the real transport rejects a
      // group with repeated or malformed identities before any API call.
      expect(world.models.size).toBe(cases);
      for (const id of world.models.keys())
        expect(id).toMatch(/^[a-z0-9-]{1,48}$/u);
      expect(
        world.calls.filter((call) => call.startsWith('admission:')),
      ).toHaveLength(cases);
      expect(
        world.calls.filter((call) => call.startsWith('native-absence:')),
      ).toHaveLength(cases);
      expect(
        world.calls.filter((call) => call.startsWith('release-resources:')),
      ).toHaveLength(cases);
      const lastAdmission = world.calls.findLastIndex((call) =>
        call.startsWith('admission:'),
      );
      expect(
        world.calls.findIndex((call) => call.startsWith('native-absence:')),
      ).toBeGreaterThan(lastAdmission);
      expect(
        world.calls.some(
          (call) => call.startsWith('submit:') || call.startsWith('terminate:'),
        ),
      ).toBe(false);
      expect(world.waits.map(({ timeoutMs }) => timeoutMs)).toEqual(
        target === 'azure' ? [120_000] : [],
      );
      expect(
        world.artifacts.find(({ name }) => name === 'dedicated-job-result')
          ?.body,
      ).toMatchObject({ failureCleanup: 'Not applicable' });
    },
  );

  test.each([
    'accepted',
    'lost-reply',
    'wrong-message',
    'foreign',
    'runtime',
    'missing-case',
  ] as const)(
    'admission %s cannot complete or release references',
    async (admissionFailure) => {
      const world = harness(
        { kind: 'invalid-admission', target: 'azure' },
        { admissionFailure },
      );
      await expect(world.run()).rejects.toThrow();
      expect(world.calls.some((call) => call.startsWith('release'))).toBe(
        false,
      );
      expect(
        world.artifacts.some(({ name }) => name === 'dedicated-job-result'),
      ).toBe(false);
    },
  );

  test('unknown native cleanup keeps no-provision completion unresolved', async () => {
    const world = harness(
      { kind: 'invalid-admission', target: 'aws' },
      { cleanupFailure: true },
    );
    await expect(world.run()).rejects.toThrow('native inventory uncertain');
    expect(world.calls.some((call) => call.startsWith('release'))).toBe(false);
    expect(
      world.artifacts.some(({ name }) => name === 'dedicated-job-result'),
    ).toBe(false);
  });

  test('no-provision members reject a forced provisioning-cleanup selection before preparation', async () => {
    const world = harness(
      { kind: 'invalid-admission', target: 'gcp' },
      { forced: true },
    );
    await expect(world.run()).rejects.toThrow('Not applicable');
    expect(world.models.size).toBe(0);
  });
  test('0047/S1 0047/S2 0047/S3 restricted credential reports each case and completes after all three release', async () => {
    const world = harness({ kind: 'restricted-credential', target: 'aws' });
    await expect(world.run()).resolves.toMatchObject({ satisfied: true });
    const report = world.artifacts.find(
      ({ name }) => name === 'job-restricted-credential',
    );
    expect(report?.body).toMatchObject({
      children: [
        { scenario: 'S1', satisfied: true, region: 'us-east-1' },
        { scenario: 'S2', satisfied: true, region: 'us-east-2' },
        {
          scenario: 'S3',
          satisfied: true,
          output: { marker: expect.any(String) },
        },
      ],
    });
    expect(
      world.calls.filter((call) => call.startsWith('release:')),
    ).toHaveLength(3);
  });

  test('0047/S4 0047/S11 the Azure restricted credential places both cases without a region pin', async () => {
    const world = harness({ kind: 'restricted-credential', target: 'azure' });
    await expect(world.run()).resolves.toMatchObject({ satisfied: true });
    expect(
      world.artifacts.find(({ name }) => name === 'job-restricted-credential')
        ?.body,
    ).toMatchObject({
      allowedRegions: null,
      children: [
        { scenario: 'S4', satisfied: true, region: 'us-east-2' },
        {
          scenario: 'S11',
          satisfied: true,
          region: 'us-east-2',
          output: { marker: expect.any(String) },
        },
      ],
    });
  });

  test('restricted credential still reports the other cases when one fails', async () => {
    const world = harness(
      { kind: 'restricted-credential', target: 'aws' },
      { restrictedDeniedRegion: true },
    );
    const error = await world.run().catch((caught: unknown) => caught);
    expect((error as Error).message).toMatch(
      /S1 passed; S2 failed \(.*outside its allowed regions\); S3 passed/u,
    );
    expect(
      world.artifacts.find(({ name }) => name === 'job-restricted-credential')
        ?.body,
    ).toMatchObject({
      children: [
        { scenario: 'S1', satisfied: true },
        { scenario: 'S2', satisfied: false },
        { scenario: 'S3', satisfied: true },
      ],
    });
    expect(world.calls.some((call) => call.startsWith('release:'))).toBe(false);
  });

  test('restricted credential names forced cleanup in its combined failure', async () => {
    const world = harness(
      { kind: 'restricted-credential', target: 'aws' },
      { forced: true },
    );
    await expect(world.run()).rejects.toThrow(
      /S1 failed \(E2E_JOB_FORCED_CLEANUP: restricted-credential/u,
    );
  });

  test('runtime secrets keep two independent Running budgets and complete only after both original children release', async () => {
    const world = harness({ kind: 'runtime-secrets', target: 'aws' });
    await expect(world.run()).resolves.toMatchObject({ satisfied: true });
    expect(world.waits.map(({ timeoutMs }) => timeoutMs)).toEqual([
      900_000, 900_000, 60_000, 60_000,
    ]);
    expect(
      world.calls.filter((call) => call.startsWith('submit:')),
    ).toHaveLength(2);
    expect(world.calls.indexOf('update-runtime-secret')).toBeGreaterThan(
      world.calls.indexOf('runtime-secrets:j-override-2:false'),
    );
    expect(world.calls.indexOf('clear-runtime-secret-files')).toBeGreaterThan(
      world.calls.indexOf('update-runtime-secret'),
    );
    expect(world.calls.indexOf('force-delete-runtime-secret')).toBeGreaterThan(
      world.calls.indexOf('clear-runtime-secret-files'),
    );
    expect(world.calls.indexOf('terminate:j-secret-1')).toBeGreaterThan(
      world.calls.indexOf('runtime-secrets:j-secret-1:true'),
    );
    expect(
      world.calls.filter((call) => call.startsWith('native-absence:')),
    ).toHaveLength(2);
    expect(
      world.calls.filter((call) => call.startsWith('release:')),
    ).toHaveLength(2);
    expect(world.calls.at(-1)).toBe('artifact:dedicated-job-result');
    expect(
      world.artifacts.filter(({ name }) => name === 'dedicated-job-result'),
    ).toEqual([
      {
        name: 'dedicated-job-result',
        body: expect.objectContaining({
          children: [
            { workloadId: 'j-secret-1', generation: 1 },
            { workloadId: 'j-override-2', generation: 1 },
          ],
        }),
      },
    ]);
  });

  test.each([
    'environment',
    'override',
    'mode',
    'owner',
    'filesystem',
    'after-environment',
    'container',
    'started',
    'missing-attempt',
    'credential',
    'status-zone',
    'requested-region',
    'git',
    'git-control',
    'file-mode',
    'file-unreadable',
    'file-update',
    'file-restore',
    'file-deleted',
  ] as const)(
    'runtime-secret %s failure cannot reach release or completion',
    async (runtimeSecretFailure) => {
      const world = harness(
        { kind: 'runtime-secrets', target: 'aws' },
        { runtimeSecretFailure },
      );
      await expect(world.run()).rejects.toThrow();
      expect(world.calls.some((call) => call.startsWith('release:'))).toBe(
        false,
      );
      expect(
        world.artifacts.some(({ name }) => name === 'dedicated-job-result'),
      ).toBe(false);
    },
  );

  test.each(['missing', 'duplicate', 'wrong-order'] as const)(
    'runtime secrets reject %s children before either send',
    async (runtimeChildren) => {
      const world = harness(
        { kind: 'runtime-secrets', target: 'aws' },
        { runtimeChildren },
      );
      await expect(world.run()).rejects.toThrow(
        'both original member children',
      );
      expect(world.calls.some((call) => call.startsWith('submit:'))).toBe(
        false,
      );
    },
  );

  test('runtime-secret forced cleanup leaves both active Jobs and all bundles armed for teardown', async () => {
    const world = harness(
      { kind: 'runtime-secrets', target: 'aws' },
      { forced: true },
    );
    await expect(world.run()).rejects.toThrow(
      'E2E_JOB_FORCED_CLEANUP: runtime-secrets',
    );
    expect(
      world.calls.filter((call) => call.startsWith('runtime-secrets:')),
    ).toHaveLength(2);
    expect(world.calls).not.toContain('force-delete-runtime-secret');
    expect(
      world.calls.some(
        (call) => call.startsWith('terminate:') || call.startsWith('release:'),
      ),
    ).toBe(false);
    expect(
      world.artifacts.some(({ name }) => name === 'dedicated-job-result'),
    ).toBe(false);
  });

  test('terminal-only runtime-secret progress cannot supply injection evidence', async () => {
    const world = harness(
      { kind: 'runtime-secrets', target: 'aws' },
      { terminalEarly: true },
    );
    await expect(world.run()).rejects.toThrow('live Job');
    expect(
      world.calls.some((call) => call.startsWith('runtime-secrets:')),
    ).toBe(false);
    expect(
      world.artifacts.some(({ name }) => name === 'dedicated-job-result'),
    ).toBe(false);
  });

  test('runtime secrets accept an omitted optional zone only when the original zone is null', async () => {
    const world = harness(
      { kind: 'runtime-secrets', target: 'aws' },
      { nativeZone: null, omitStatusZone: true },
    );
    await expect(world.run()).resolves.toMatchObject({ satisfied: true });
    expect(world.calls).toContain('force-delete-runtime-secret');
  });

  test('runtime-secret shared credential release failure prevents completion after both native cleanups', async () => {
    const world = harness(
      { kind: 'runtime-secrets', target: 'aws' },
      { sharedReleaseFailure: 'credential' },
    );
    await expect(world.run()).rejects.toThrow(
      'shared credential absence unproved',
    );
    expect(
      world.calls.filter((call) => call.startsWith('native-absence:')),
    ).toHaveLength(2);
    expect(
      world.artifacts.some(({ name }) => name === 'dedicated-job-result'),
    ).toBe(false);
  });

  test('Spot cancellation preserves the full 90-second guard before the only finalizer releases', async () => {
    vi.useFakeTimers();
    try {
      const world = harness({ kind: 'spot-request-cleanup', target: 'aws' });
      await Promise.all([
        expect(world.run()).resolves.toMatchObject({ satisfied: true }),
        vi.advanceTimersByTimeAsync(180_000),
      ]);
      // The second child is the Job terminated at its launch.
      expect(world.waits.map(({ timeoutMs }) => timeoutMs)).toEqual([
        1_200_000, 60_000, 120_000, 1_200_000, 600_000, 120_000,
      ]);
      expect(
        world.calls.filter((call) => call === 'spot-pause:5000'),
      ).toHaveLength(36);
      const early = world.calls.findIndex((call) =>
        call.startsWith('spot-launched:'),
      );
      expect(world.calls.lastIndexOf('spot-active')).toBeLessThan(early);
      expect(world.calls[early - 1]).toMatch(/^terminate:j-spot-early/u);
      // The old lookup missed at the cancel and found it after the guard.
      const recorded = (suffix: string) =>
        world.artifacts.find(({ name }) => name.endsWith(suffix))?.body;
      expect(recorded('-spot-early-window')).toMatchObject({
        cancelledAt: 1_020_000,
        instanceFilterAtCancel: [],
      });
      // The first guard read already finds it; that is the control.
      expect(recorded('-spot-early-control')).toMatchObject({
        firstMatchAt: expect.any(Number),
        instanceFilterAfterGuard: [{ id: 'sir-original' }],
      });
      expect(world.calls.indexOf('spot-active')).toBeLessThan(
        world.calls.findIndex((call) => call.startsWith('terminate:')),
      );
      expect(world.calls.indexOf('spot-request')).toBeGreaterThan(
        world.calls.findIndex((call) => call.startsWith('cleanup:')),
      );
      expect(
        world.calls.findIndex((call) => call.startsWith('release:')),
      ).toBeGreaterThan(world.calls.lastIndexOf('spot-guard'));
      expect(
        world.artifacts.filter(({ name }) => name === 'dedicated-job-result'),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('Spot guard gives each replacement read its own deadline', async () => {
    vi.useFakeTimers();
    try {
      // 3 s reads after 5 s pauses start the last read 2 s before the guard ends.
      const world = harness(
        { kind: 'spot-request-cleanup', target: 'aws' },
        { spotReadMs: 3_000 },
      );
      await Promise.all([
        expect(world.run()).resolves.toMatchObject({ satisfied: true }),
        vi.advanceTimersByTimeAsync(200_000),
      ]);
      expect(world.calls.filter((call) => call === 'spot-guard')).toHaveLength(
        24,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test.each([
    ['not-persistent', 'Spot request does not belong'],
    ['foreign-request', 'original Spot request identity changed'],
    ['replacement', 'AWS launched or retained a Spot replacement'],
    ['reopened', 'Spot request reopened'],
    ['uncancelled', 'request is active'],
    // Reverted: the request of a Job terminated at launch reopens.
    ['early-reopened', 'request is active'],
  ] as const)(
    'Spot %s never releases or completes',
    async (spotFailure, message) => {
      vi.useFakeTimers();
      try {
        const world = harness(
          { kind: 'spot-request-cleanup', target: 'aws' },
          { spotFailure },
        );
        await Promise.all([
          expect(world.run()).rejects.toThrow(message),
          vi.advanceTimersByTimeAsync(180_000),
        ]);
        expect(world.calls.some((call) => call.startsWith('release:'))).toBe(
          false,
        );
        expect(
          world.artifacts.some(({ name }) => name === 'dedicated-job-result'),
        ).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  // The old instance-id lookup is evidence only: a run where it already finds
  // the request still passes on the cancel and no-replacement checks.
  test.each([
    ['filter-found', { instanceFilterAtCancel: [{ id: 'sir-original' }] }, {}],
    [
      'filter-before-cancel',
      { instanceFilterBeforeCancel: [{ id: 'sir-original' }] },
      {},
    ],
    [
      'control-missing',
      {},
      { firstMatchAt: null, instanceFilterAfterGuard: [] },
    ],
  ] as const)(
    'Spot %s is recorded, not gated',
    async (spotFailure, window, control) => {
      vi.useFakeTimers();
      try {
        const world = harness(
          { kind: 'spot-request-cleanup', target: 'aws' },
          { spotFailure },
        );
        await Promise.all([
          expect(world.run()).resolves.toMatchObject({ satisfied: true }),
          vi.advanceTimersByTimeAsync(180_000),
        ]);
        const recorded = (suffix: string) =>
          world.artifacts.find(({ name }) => name.endsWith(suffix))?.body;
        expect(recorded('-spot-early-window')).toMatchObject(window);
        expect(recorded('-spot-early-control')).toMatchObject(control);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test('an early Spot request that names its instance only after the first read keeps its identity', async () => {
    vi.useFakeTimers();
    try {
      const world = harness(
        { kind: 'spot-request-cleanup', target: 'aws' },
        { spotFailure: 'late-instance' },
      );
      await Promise.all([
        expect(world.run()).resolves.toMatchObject({ satisfied: true }),
        vi.advanceTimersByTimeAsync(180_000),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('forced Spot cleanup requires the original active request and leaves completion to teardown', async () => {
    const world = harness(
      { kind: 'spot-request-cleanup', target: 'aws' },
      { forced: true },
    );
    await expect(world.run()).rejects.toThrow(
      'E2E_JOB_FORCED_CLEANUP: spot-request-cleanup',
    );
    expect(world.calls).toContain('spot-active');
    expect(
      world.calls.some(
        (call) => call.startsWith('terminate:') || call.startsWith('release:'),
      ),
    ).toBe(false);
    expect(
      world.artifacts.some(({ name }) => name === 'dedicated-job-result'),
    ).toBe(false);
  });

  test('terminal-only progress cannot supply a Spot cleanup fault', async () => {
    const world = harness(
      { kind: 'spot-request-cleanup', target: 'aws' },
      { forced: true, terminalEarly: true },
    );
    await expect(world.run()).rejects.toThrow('live Job');
    expect(world.calls).not.toContain('spot-active');
    expect(
      world.artifacts.some(({ name }) => name === 'dedicated-job-result'),
    ).toBe(false);
  });
  test.each([
    { kind: 'concurrent-output', target: 'azure' },
    { kind: 'host-recovery', target: 'azure' },
    { kind: 'bucket-sync', target: 'lambda' },
  ] as const)(
    'accepts an omitted optional status zone only with a null original zone for %j',
    async (member) => {
      const world = harness(member, { nativeZone: null, omitStatusZone: true });
      await expect(world.run()).resolves.toMatchObject({
        member,
        satisfied: true,
      });
      expect(world.calls.some((call) => call.startsWith('release:'))).toBe(
        true,
      );
    },
  );

  test('keeps polling a results file read before it became valid JSON', async () => {
    const world = harness(
      { kind: 'bucket-sync', target: 'gcp' },
      { unparsedResults: 'transient' },
    );
    await expect(world.run()).resolves.toMatchObject({ satisfied: true });
  });

  test('fails a final read whose results file never becomes valid JSON', async () => {
    const world = harness(
      { kind: 'bucket-sync', target: 'gcp' },
      { unparsedResults: 'final-never' },
    );
    await expect(world.run()).rejects.toThrow(
      'Job MACE result is not valid JSON yet (read 17 characters)',
    );
  });

  test('rejects an omitted status zone when its original attempt has a zone', async () => {
    const world = harness(
      { kind: 'bucket-sync', target: 'gcp' },
      { omitStatusZone: true },
    );
    await expect(world.run()).rejects.toThrow('original placement');
    expect(world.calls).not.toContain('native-stop');
    expect(world.calls.some((call) => call.startsWith('release:'))).toBe(false);
  });

  test.each([
    'requested-region',
    'requested-types',
    'missing-live',
    'duplicate-live',
    'foreign-cloud-id',
    'resolved-region',
    'resolved-zone',
  ] as const)(
    'rejects a %s baseline before extending or releasing it',
    async (baselineFailure) => {
      const world = harness(
        { kind: 'bucket-sync', target: 'gcp' },
        { baselineFailure },
      );
      await expect(world.run()).rejects.toThrow('original placement');
      expect(world.calls).not.toContain('native-stop');
      expect(world.calls.some((call) => call.startsWith('release:'))).toBe(
        false,
      );
      expect(
        world.artifacts.some(({ name }) => name === 'dedicated-job-result'),
      ).toBe(false);
    },
  );

  test.each(['aws', 'azure', 'gcp'] as const)(
    '%s host loss retains its original and replacement through native cleanup',
    async (target) => {
      const world = harness({ kind: 'host-recovery', target });
      await expect(world.run()).resolves.toMatchObject({
        member: { kind: 'host-recovery', target },
        satisfied: true,
      });
      expect(world.calls).toContain('native-delete');
      expect(world.calls).not.toContain('native-stop');
      expect(world.waits.map(({ timeoutMs }) => timeoutMs)).toEqual(
        target === 'azure'
          ? [900_000, 180_000, 180_000, 1_200_000, 90_000]
          : [900_000, 180_000, 1_200_000],
      );
      expect(world.calls.indexOf('native-delete')).toBeGreaterThan(
        world.calls.findIndex((call) => call.endsWith('-pre-fault')),
      );
      if (target === 'azure') {
        expect(world.calls.indexOf('host-checkpoint:bucket')).toBeLessThan(
          world.calls.indexOf('native-delete'),
        );
        expect(
          world.calls.indexOf('host-checkpoint:container'),
        ).toBeGreaterThan(world.calls.indexOf('native-delete'));
      } else
        expect(world.calls.some((call) => call.includes('checkpoint'))).toBe(
          false,
        );
      expect(
        world.calls.indexOf('artifact:dedicated-job-result'),
      ).toBeGreaterThan(
        world.calls.findIndex((call) => call.startsWith('release-resources:')),
      );
    },
  );

  test.each(['aws', 'azure', 'gcp'] as const)(
    '%s host forced cleanup retains both hosts after replacement without completion or release',
    async (target) => {
      const world = harness(
        { kind: 'host-recovery', target },
        { forced: true },
      );
      await expect(world.run()).rejects.toThrow('E2E_JOB_FORCED_CLEANUP');
      expect(world.calls).toContain('native-delete');
      expect(world.calls.some((call) => call.endsWith('-post-fault'))).toBe(
        true,
      );
      expect(
        world.calls.some(
          (call) =>
            call.startsWith('release:') || call.startsWith('terminate:'),
        ),
      ).toBe(false);
      expect(
        world.artifacts.some(({ name }) => name === 'dedicated-job-result'),
      ).toBe(false);
    },
  );

  test.each([
    [{ missingHostUpload: true }, 'has not reached storage'],
    [{ wrongRestoredCheckpoint: true }, 'restored checkpoint'],
    [{ sameHost: true }, 'distinct replacement host'],
    [{ wrongHostReason: true }, 'cloud-confirmed'],
    [{ lostOriginal: true }, 'ended original'],
    [{ terminalEarly: true }, 'live Job'],
    [{ cleanupFailure: true }, 'inventory uncertain'],
    [{ explicitCheckpointCleanupFailure: true }, 'checkpoint absence unproved'],
  ] as const)(
    'does not complete Azure host recovery with missing assigned evidence %j',
    async (options, message) => {
      const world = harness(
        { kind: 'host-recovery', target: 'azure' },
        options,
      );
      await expect(world.run()).rejects.toThrow(message);
      if ('missingHostUpload' in options)
        expect(world.calls).not.toContain('native-delete');
      expect(
        world.artifacts.some(({ name }) => name === 'dedicated-job-result'),
      ).toBe(false);
    },
  );

  test.each(['aws', 'azure', 'gcp'] as const)(
    '%s spot eviction during final sync completes after the in-place restart',
    async (target) => {
      const world = harness({ kind: 'spot-eviction', target });
      await expect(world.run()).resolves.toMatchObject({
        member: { kind: 'spot-eviction', target },
        satisfied: true,
      });
      expect(world.calls.indexOf('native-stop')).toBeGreaterThan(
        world.calls.findIndex((call) => call.endsWith('-pre-fault')),
      );
      expect(
        world.calls.indexOf('artifact:dedicated-job-result'),
      ).toBeGreaterThan(
        world.calls.findIndex((call) => call.startsWith('release-resources:')),
      );
    },
  );

  test.each(['aws', 'gcp', 'azure'] as const)(
    'a %s clean spot exit must end before the preemption grace, which Azure keeps',
    async (target) => {
      const world = harness(
        { kind: 'spot-eviction', target },
        { eviction: 'exit-graced' },
      );
      if (target === 'azure')
        await expect(world.run()).resolves.toMatchObject({ satisfied: true });
      else
        await expect(world.run()).rejects.toThrow(
          'not under the 150 s preemption grace',
        );
    },
  );

  test.each([
    ['sync-won', 'inconclusive'],
    ['sync-won-late', 'inconclusive'],
    ['failed', 'without restarting its evicted VM'],
    ['lost-original', 'ended original row'],
    ['short-payload', 'final output is missing or incomplete'],
    // The clean exit of a spot Job with no retries left.
    ['exit-reclaimed', 'clean exit ended reclaimed'],
  ] as const)(
    'does not pass a spot eviction when %s',
    async (eviction, message) => {
      const world = harness(
        { kind: 'spot-eviction', target: 'azure' },
        { eviction },
      );
      await expect(world.run()).rejects.toThrow(message);
      expect(world.calls.includes('native-stop')).toBe(eviction !== 'sync-won');
      expect(
        world.artifacts.some(({ name }) => name === 'dedicated-job-result'),
      ).toBe(false);
    },
  );

  test.each([
    [false, false, 'restarted-vm'],
    [true, false, 'restarted-vm'],
    [false, true, 'fresh-vm'],
  ] as const)(
    'a GPU Job evicted while Running passes only when it completes (errored %s, fresh VM %s)',
    async (gpuErrored, gpuFreshVm, finalVm) => {
      const world = harness(
        { kind: 'gpu-spot-eviction', target: 'azure' },
        { gpuErrored, gpuFreshVm },
      );
      const run = world.run();
      await (gpuErrored
        ? expect(run).rejects.toThrow('the evicted GPU Job ended errored')
        : expect(run).resolves.toMatchObject({ satisfied: true }));
      expect(world.calls).toContain('native-stop');
      expect(
        world.artifacts.find(({ name }) => name.endsWith('-gpu-eviction')),
      ).toMatchObject({ body: { finalVm } });
    },
  );

  test('keeps polling checkpoint health past the zero-byte probe marker, and records what the CLI showed', async () => {
    const world = harness(
      { kind: 'bucket-sync', target: 'aws' },
      { zeroByteCheckpointReads: 2 },
    );
    await expect(world.run()).resolves.toMatchObject({ satisfied: true });
    const observed = world.artifacts.find(({ name }) =>
      name.endsWith('-cli-observations'),
    );
    expect(observed).toBeDefined();
  });

  test.each(['aws', 'azure', 'gcp', 'lambda'] as const)(
    '%s bucket member executes its required capabilities and finalizes after cleanup',
    async (target) => {
      const world = harness({ kind: 'bucket-sync', target });
      await expect(world.run()).resolves.toMatchObject({
        contract: 'dedicated-job',
        member: { kind: 'bucket-sync', target },
        satisfied: true,
      });
      const recovery = ['aws', 'azure', 'gcp'].includes(target);
      expect(world.calls.includes('native-stop')).toBe(recovery);
      if (recovery) {
        expect(world.waits.map((wait) => wait.timeoutMs)).toContain(600_000);
        expect(
          world.waits
            .map((wait) => wait.timeoutMs)
            .filter((value) => value === 2_400_000),
        ).toHaveLength(2);
        expect(
          world.calls.findIndex((call) => call.includes('-pre-fault')),
        ).toBeLessThan(world.calls.indexOf('native-stop'));
        expect(
          world.calls.findIndex((call) => call.includes('-post-fault')),
        ).toBeGreaterThan(world.calls.indexOf('native-stop'));
      }
      expect(
        world.calls.findIndex((call) => call.startsWith('release:')),
      ).toBeGreaterThan(
        world.calls.findIndex((call) => call.startsWith('native-absence:')),
      );
      expect(
        world.artifacts.filter(({ name }) => name === 'dedicated-job-result'),
      ).toHaveLength(1);
      expect(
        world.artifacts.find(({ name }) => name.endsWith('-active-baseline')),
      ).toMatchObject({
        body: { imageConfigDigest: `sha256:${'d'.repeat(64)}` },
      });
    },
  );

  test.each([
    ['armed', undefined],
    ['unarmed', undefined],
    ['armed-no-failover', 'launch failover did not move on at once'],
  ] as const)(
    'gcp concurrent output with an %s A100 quota gate',
    async (launchFailover, failure) => {
      const world = harness(
        { kind: 'concurrent-output', target: 'gcp' },
        { launchFailover },
      );
      if (failure) {
        await expect(world.run()).rejects.toThrow(failure);
        return;
      }
      await expect(world.run()).resolves.toMatchObject({ satisfied: true });
      const records = world.artifacts.filter(({ name }) =>
        name.endsWith('-launch-failover'),
      );
      expect(records).toHaveLength(3);
      for (const { body } of records)
        expect(body).toMatchObject(
          launchFailover === 'unarmed'
            ? { armed: false, skipped: 'an A100 quota is above 0' }
            : { armed: true, untried: [3, 2] },
        );
    },
  );

  test.each(['aws', 'azure', 'gcp'] as const)(
    '%s concurrent member submits three children before independent waits and checks contents after all terminate',
    async (target) => {
      const world = harness({ kind: 'concurrent-output', target });
      await world.run();
      expect(
        world.waits
          .filter(({ label }) => label.includes('active baseline'))
          .map(({ timeoutMs }) => timeoutMs),
      ).toEqual([1_800_000, 1_800_000, 1_800_000]);
      const sends = world.calls.filter((call) => call.startsWith('submit:'));
      expect(sends).toHaveLength(3);
      expect(
        world.calls.findIndex((call) => call.startsWith('write:')),
      ).toBeGreaterThan(world.calls.lastIndexOf(sends[2]));
      expect(world.calls).toContain('sync-70-seconds');
      expect(world.calls.indexOf('contents:terminated')).toBeGreaterThan(
        world.calls.findLastIndex((call) => call.startsWith('terminate:')),
      );
      expect(
        world.calls.findIndex((call) => call.startsWith('release:')),
      ).toBeGreaterThan(world.calls.indexOf('contents:terminated'));
      expect(
        world.artifacts.filter(({ name }) => name === 'dedicated-job-result'),
      ).toEqual([
        expect.objectContaining({
          body: expect.objectContaining({
            satisfied: true,
            children: [...world.models.keys()].map((workloadId) => ({
              workloadId,
              generation: 1,
            })),
          }),
        }),
      ]);
      expect(
        world.calls.indexOf('artifact:dedicated-job-result'),
      ).toBeGreaterThan(
        world.calls.findLastIndex((call) =>
          call.startsWith('release-resources:'),
        ),
      );
    },
  );

  test.each(['storage', 'credential'] as const)(
    'does not retain a conclusive group result when final shared %s release fails',
    async (sharedReleaseFailure) => {
      const world = harness(
        { kind: 'concurrent-output', target: 'aws' },
        { sharedReleaseFailure },
      );
      await expect(world.run()).rejects.toThrow(
        `shared ${sharedReleaseFailure} absence unproved`,
      );
      expect(
        world.calls.filter((call) => call.startsWith('release-resources:')),
      ).toHaveLength(3);
      expect(
        world.artifacts.filter(({ name }) => name === 'dedicated-job-result'),
      ).toEqual([]);
    },
  );

  test.each([
    'terminalEarly',
    'wrongDisk',
    'lostOriginal',
    'changedCheckpoint',
    'incompleteFinal',
    'cleanupFailure',
    'badRuntime',
    'badTransfer',
    'badImageDigest',
    'logsKeepStreaming',
    'truncatedCheckpointHealth',
    'retainedMismatch',
  ] as const)(
    'does not produce completion when %s invalidates the bucket contract',
    async (failure) => {
      const world = harness(
        { kind: 'bucket-sync', target: 'aws' },
        { [failure]: true },
      );
      await expect(world.run()).rejects.toThrow();
      expect(
        world.artifacts.filter(({ name }) => name === 'dedicated-job-result'),
      ).toEqual([]);
      expect(world.calls.some((call) => call.startsWith('release:'))).toBe(
        false,
      );
    },
  );

  test.each(['lostChild', 'lostChildAfterTermination'] as const)(
    'requires all three exact outputs when %s occurs',
    async (failure) => {
      const world = harness(
        { kind: 'concurrent-output', target: 'aws' },
        { [failure]: true },
      );
      await expect(world.run()).rejects.toThrow(/concurrent/iu);
      expect(world.calls.some((call) => call.startsWith('release:'))).toBe(
        false,
      );
      if (failure === 'lostChild')
        expect(
          world.calls.filter((call) => call === 'retry-30-seconds'),
        ).toHaveLength(2);
    },
  );

  test.each(['bucket-sync', 'concurrent-output'] as const)(
    'forced %s cleanup leaves final completion and release unclaimed',
    async (kind) => {
      const world = harness({ kind, target: 'aws' }, { forced: true });
      await expect(world.run()).rejects.toThrow('E2E_JOB_FORCED_CLEANUP');
      expect(world.calls).not.toContain('native-stop');
      expect(world.calls.some((call) => call.startsWith('release:'))).toBe(
        false,
      );
      expect(
        world.artifacts.filter(({ name }) => name === 'dedicated-job-result'),
      ).toEqual([]);
    },
  );
});

describe('real input hydration family consumer', () => {
  test('keeps all original production windows, same-VM recovery and complete manifest before finalization', async () => {
    const world = harness({ kind: 'input-hydration-recovery', target: 'aws' });
    await expect(world.run()).resolves.toMatchObject({
      satisfied: true,
      member: { kind: 'input-hydration-recovery', target: 'aws' },
    });
    expect(
      world.calls.filter((c) => c === 'hydration-pause:60000'),
    ).toHaveLength(15);
    expect(
      world.calls.filter((c) => c === 'hydration-pause:75000'),
    ).toHaveLength(1);
    expect(world.waits).toContainEqual({
      label: 'Job input hydration worker active',
      timeoutMs: 1_200_000,
    });
    expect(world.waits).toContainEqual({
      label: 'Job production inactivity watchdog',
      timeoutMs: 1_005_000,
    });
    expect(world.waits).toContainEqual({
      label: 'Job same-VM hydration worker replacement',
      timeoutMs: 300_000,
    });
    expect(world.calls.indexOf('restart-hydration-api')).toBeGreaterThan(
      world.calls.findIndex((c) => c.endsWith('-pre-fault')),
    );
    expect(world.calls.indexOf('hide-hydration-activity')).toBeGreaterThan(
      world.calls.findIndex((c) => c.endsWith('-hydration-inactivity-before')),
    );
    expect(
      world.calls.indexOf('artifact:dedicated-job-result'),
    ).toBeGreaterThan(
      world.calls.findIndex((c) => c.startsWith('release-resources:')),
    );
    expect(
      world.artifacts.find((a) => a.name.endsWith('-post-fault')),
    ).toMatchObject({
      body: { manifest: { count: '2048', bytes: '274877906944' } },
    });
  });

  test('forced cleanup reaches same-worker API adoption without repeating the long timing windows or completing', async () => {
    const world = harness(
      { kind: 'input-hydration-recovery', target: 'aws' },
      { forced: true },
    );
    await expect(world.run()).rejects.toThrow('E2E_JOB_FORCED_CLEANUP');
    expect(world.calls).toContain('restart-hydration-api');
    expect(world.calls.some((c) => c.endsWith('-hydration-adoption'))).toBe(
      true,
    );
    expect(
      world.calls.some(
        (c) => c.startsWith('hydration-pause:') || c.startsWith('release:'),
      ),
    ).toBe(false);
    expect(world.calls).not.toContain('hide-hydration-activity');
    expect(world.artifacts.some((a) => a.name === 'dedicated-job-result')).toBe(
      false,
    );
  });

  test.each([
    'new-controller',
    'relaunched-worker',
    'early-watchdog',
    'late-watchdog',
    'lost-input',
    'bad-shard',
  ] as const)(
    'retains incomplete hydration when %s breaks the real proof',
    async (hydrationFailure) => {
      const world = harness(
        { kind: 'input-hydration-recovery', target: 'aws' },
        { hydrationFailure },
      );
      await expect(world.run()).rejects.toThrow();
      expect(world.calls.some((c) => c.startsWith('release:'))).toBe(false);
      expect(
        world.artifacts.some((a) => a.name === 'dedicated-job-result'),
      ).toBe(false);
    },
  );

  test.each([
    'wrongDisk',
    'badImageDigest',
    'terminalEarly',
    'cleanupFailure',
  ] as const)('does not issue hydration completion for %s', async (failure) => {
    const world = harness(
      { kind: 'input-hydration-recovery', target: 'aws' },
      { [failure]: true },
    );
    await expect(world.run()).rejects.toThrow();
    expect(world.artifacts.some((a) => a.name === 'dedicated-job-result')).toBe(
      false,
    );
  });
});
