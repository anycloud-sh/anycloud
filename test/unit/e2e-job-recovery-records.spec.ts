import { describe, expect, test } from 'vitest';
import { CloudType } from '../../src/shared/cloud.js';
import { WorkloadHealthStatus } from '../../src/shared/runtime.js';
import { WorkloadState, WorkloadType } from '../../src/shared/workload.js';
import { Redactor } from '../integration/e2e/internal/artifacts.js';
import { Environment } from '../integration/e2e/internal/environment.js';
import { jobMemberProfile } from '../integration/e2e/internal/contracts/job-policy.js';
import {
  JobRecords,
  type JobRecoveryBefore,
  type JobRecoveryFault,
  type JobHostRecoveryFault,
  type JobHydrationObservation,
  type JobHydrationBefore,
  type JobHydrationHealthy,
  type JobHydrationFault,
} from '../integration/e2e/internal/contracts/job-records.js';
import type {
  JobNativeAttempt,
  JobRecoveryIdentity,
  JobMember,
} from '../integration/e2e/internal/targets/job-types.js';
import type { StatusResponse } from '../integration/e2e/internal/types.js';
import {
  liveStatusVmEntries,
  snapshotStatusVmLedger,
} from '../integration/e2e/internal/vm-ledger.js';
import { trackedWorkloadRefForTest } from './helpers/e2e.js';
import { persistentVmWorkload } from './helpers/persistent-vm-fixture.js';

function fixture(member: JobMember = { kind: 'bucket-sync', target: 'aws' }) {
  const ref = trackedWorkloadRefForTest('recovery-job');
  const profile = jobMemberProfile(member, new Environment({}, new Redactor()));
  const records = new JobRecords({
    snapshot: (ref, status) => snapshotStatusVmLedger(ref.id, status),
    liveEntries: liveStatusVmEntries,
  });
  const run = records.begin(ref, profile, 1);
  const attempt: JobNativeAttempt = {
    ref,
    rowId: 1,
    createdAt: 10,
    endedAt: null,
    cloudId:
      profile.computeProvider === CloudType.AWS
        ? 'i-0123456789abcdef0'
        : 'original-vm',
    ip: '192.0.2.3',
    cloudProvider: profile.computeProvider,
    credentialId: 'a'.repeat(64),
    region: profile.storageRegion,
    availabilityZone: '1a',
    vmType: profile.vmTypes.find((type) => !type.startsWith('totally_fake'))!,
  };
  const identity: JobRecoveryIdentity = {
    cloudId: attempt.cloudId,
    vmId: attempt.cloudId,
    osDiskId: 'vol-0123456789abcdef0',
    region: attempt.region,
    zone: 'us-east-1a',
    vmType: attempt.vmType,
  };
  const status = (recovered: boolean): StatusResponse => ({
    status: WorkloadHealthStatus.Up,
    workload: persistentVmWorkload(ref.id, {
      workloadType: WorkloadType.Job,
      state:
        member.kind === 'input-hydration-recovery'
          ? WorkloadState.Syncing
          : WorkloadState.Running,
      cloudProvider: profile.computeProvider,
      region: profile.computeRegion || null,
      vmType: [...profile.vmTypes],
    }),
    vms: [
      {
        cloudId: attempt.cloudId,
        region: attempt.region,
        availabilityZone: attempt.availabilityZone,
        endedAt: recovered ? 20 : null,
        ip: '192.0.2.3',
      },
      ...(recovered
        ? [
            {
              cloudId: attempt.cloudId,
              region: attempt.region,
              availabilityZone: attempt.availabilityZone,
              endedAt: null,
              ip: '192.0.2.3',
            },
          ]
        : []),
    ],
    events: [
      {
        id: 1,
        workloadId: ref.id,
        createdAt: 10,
        state: WorkloadState.Running,
        metadata: null,
      },
      ...(recovered
        ? [
            {
              id: 2,
              workloadId: ref.id,
              createdAt: 20,
              state: WorkloadState.Recovering,
              metadata: null,
            },
            {
              id: 3,
              workloadId: ref.id,
              createdAt: 30,
              state: WorkloadState.Running,
              metadata: null,
            },
          ]
        : []),
    ],
  });
  const beforeObservation = { status: status(false), attempts: [attempt] };
  const afterObservation = {
    status: status(true),
    attempts: [
      { ...attempt, endedAt: 20 },
      { ...attempt, rowId: 2, createdAt: 30 },
    ],
  };
  const progress = records.progress(run, beforeObservation);
  const prepare = () =>
    records.beforeRecovery(run, progress, beforeObservation, identity, 3);
  return {
    records,
    run,
    ref,
    profile,
    attempt,
    identity,
    progress,
    beforeObservation,
    afterObservation,
    prepare,
  };
}

function hostFixture() {
  const w = fixture({ kind: 'host-recovery', target: 'azure' });
  w.afterObservation.attempts[1] = {
    ...w.afterObservation.attempts[1],
    cloudId: 'replacement-vm',
  };
  w.afterObservation.status.vms![1].cloudId = 'replacement-vm';
  w.afterObservation.status.events[1].metadata = {
    reason: 'VM terminated (cloud confirmed)',
  };
  const replacement = {
    ...w.identity,
    cloudId: 'replacement-vm',
    vmId: 'replacement-native-id',
    osDiskId: 'replacement-disk-id',
  };
  const checkpoint = `checkpoint-${w.ref.id}`;
  const prepareHost = (uploaded: string | undefined = checkpoint) =>
    w.records.beforeHostRecovery(
      w.run,
      w.progress,
      w.beforeObservation,
      w.identity,
      uploaded,
    );
  return { ...w, replacement, checkpoint, prepareHost };
}

describe('recovery requested and native placement', () => {
  const corruptions = [
    'requested-region',
    'requested-type',
    'resolved-region',
    'resolved-zone',
    'missing-resolved-zone',
    'foreign-cloud-id',
    'missing-live',
    'duplicate-live',
  ] as const;
  function corrupt(status: StatusResponse, kind: (typeof corruptions)[number]) {
    if (kind === 'requested-region') status.workload.region = 'foreign-request';
    if (kind === 'requested-type') status.workload.vmType = ['foreign-type'];
    const live = status.vms!.find((vm) => vm.endedAt === null)!;
    if (kind === 'resolved-region') live.region = 'foreign-region';
    if (kind === 'resolved-zone') live.availabilityZone = 'foreign-zone';
    if (kind === 'missing-resolved-zone') delete live.availabilityZone;
    if (kind === 'foreign-cloud-id') live.cloudId = 'foreign-host';
    if (kind === 'missing-live') status.vms = [];
    if (kind === 'duplicate-live')
      status.vms!.push({ ...live, cloudId: 'extra-host' });
  }
  test.each(corruptions)('rejects %s before host deletion', (kind) => {
    const w = hostFixture();
    corrupt(w.beforeObservation.status, kind);
    expect(() => w.prepareHost()).toThrow('requested or native placement');
  });
  test.each(corruptions)('rejects %s on the replacement host', (kind) => {
    const w = hostFixture();
    const before = w.prepareHost();
    const fault = w.records.hostRecoveryFault(w.run, before);
    corrupt(w.afterObservation.status, kind);
    expect(() =>
      w.records.hostRecovered(
        w.run,
        before,
        fault,
        w.afterObservation,
        w.replacement,
        w.checkpoint,
      ),
    ).toThrow('requested or native placement');
  });
  test.each(corruptions)('rejects %s in the hydration baseline', (kind) => {
    const w = hydrationFixture();
    corrupt(w.baseline.status, kind);
    expect(() => w.prepareHydration()).toThrow('requested or native placement');
  });
  test('permits an unpinned host replacement in its actually observed different region', () => {
    const w = hostFixture();
    const before = w.prepareHost();
    const fault = w.records.hostRecoveryFault(w.run, before);
    w.afterObservation.attempts[1] = {
      ...w.afterObservation.attempts[1],
      region: 'westus2',
      availabilityZone: '2',
    };
    Object.assign(w.afterObservation.status.vms![1], {
      region: 'westus2',
      availabilityZone: '2',
    });
    expect(
      w.records.hostRecovered(
        w.run,
        before,
        fault,
        w.afterObservation,
        { ...w.replacement, region: 'westus2', zone: 'westus2/2' },
        w.checkpoint,
      ).kind,
    ).toBe('host-recovery');
  });
});

describe('Job host-loss evidence ownership', () => {
  test('requires its exact upload, deletion, distinct replacement and restored contents before one finalizer claim', () => {
    const w = hostFixture();
    const before = w.prepareHost();
    const fault = w.records.hostRecoveryFault(w.run, before);
    const extension = w.records.hostRecovered(
      w.run,
      before,
      fault,
      w.afterObservation,
      w.replacement,
      w.checkpoint,
    );
    expect(extension.kind).toBe('host-recovery');
    expect(() =>
      w.records.hostRecovered(
        w.run,
        before,
        fault,
        w.afterObservation,
        w.replacement,
        w.checkpoint,
      ),
    ).toThrow('exactly once');
    const terminal = w.records.terminal(w.run, {
      ...w.afterObservation.status,
      workload: {
        ...w.afterObservation.status.workload,
        state: WorkloadState.Terminated,
      },
    });
    expect(() => w.records.claim(w.run, w.progress, [], terminal)).toThrow(
      'missing',
    );
    w.records.claim(w.run, w.progress, [extension], terminal);
    expect(() =>
      w.records.claim(w.run, w.progress, [extension], terminal),
    ).toThrow('single use');
  });

  test.each([undefined, 'foreign-marker'])(
    'rejects missing or wrong pre-deletion upload %j',
    (checkpoint) => {
      const w = hostFixture();
      expect(() =>
        w.records.beforeHostRecovery(
          w.run,
          w.progress,
          w.beforeObservation,
          w.identity,
          checkpoint,
        ),
      ).toThrow('uploaded checkpoint');
    },
  );

  test('rejects copied, missing, reused and foreign run records, including the general extension shortcut', () => {
    const w = hostFixture();
    const before = w.prepareHost();
    expect(() => w.prepareHost()).toThrow('exactly once');
    expect(() => w.records.hostRecoveryFault(w.run, { ...before })).toThrow(
      'copied',
    );
    const foreign = w.records.begin(
      trackedWorkloadRefForTest(w.ref.id),
      w.profile,
      1,
    );
    expect(() => w.records.hostRecoveryFault(foreign, before)).toThrow(
      'mismatched',
    );
    const missing: unknown = {};
    expect(() =>
      w.records.hostRecovered(
        w.run,
        before,
        missing as JobHostRecoveryFault,
        w.afterObservation,
        w.replacement,
        w.checkpoint,
      ),
    ).toThrow('missing');
    const fault = w.records.hostRecoveryFault(w.run, before);
    expect(() => w.records.hostRecoveryFault(w.run, before)).toThrow(
      'exactly once',
    );
    expect(() =>
      w.records.hostRecovered(
        w.run,
        before,
        { ...fault },
        w.afterObservation,
        w.replacement,
        w.checkpoint,
      ),
    ).toThrow('copied');
    expect(() =>
      w.records.hostRecovered(
        foreign,
        before,
        fault,
        w.afterObservation,
        w.replacement,
        w.checkpoint,
      ),
    ).toThrow('mismatched');
    expect(() =>
      w.records.extension(w.run, w.progress, 'host-recovery'),
    ).toThrow('pre/fault/post');
  });

  test.each([
    'lost-original',
    'original-live',
    'original-changed',
    'replacement-early',
    'same-host',
    'same-native-id',
    'foreign-credential',
    'foreign-attempt',
    'stale-event',
    'wrong-reason',
    'missing-marker',
  ] as const)('rejects invalid post-deletion evidence: %s', (kind) => {
    const w = hostFixture();
    const before = w.prepareHost();
    const fault = w.records.hostRecoveryFault(w.run, before);
    let observation = w.afterObservation;
    let identity = w.replacement;
    let checkpoint: string | undefined = w.checkpoint;
    const rows = observation.attempts;
    if (kind === 'lost-original')
      observation = { ...observation, attempts: rows.slice(1) };
    if (kind === 'original-live')
      observation = {
        ...observation,
        attempts: [{ ...rows[0], endedAt: null }, rows[1]],
      };
    if (kind === 'original-changed')
      observation = {
        ...observation,
        attempts: [{ ...rows[0], region: 'rewritten' }, rows[1]],
      };
    if (kind === 'replacement-early')
      observation = {
        ...observation,
        attempts: [rows[0], { ...rows[1], createdAt: 1 }],
      };
    if (kind === 'same-host')
      observation = {
        ...observation,
        attempts: [rows[0], { ...rows[1], cloudId: rows[0].cloudId }],
      };
    if (kind === 'same-native-id')
      identity = { ...identity, vmId: w.identity.vmId };
    if (kind === 'foreign-credential')
      observation = {
        ...observation,
        attempts: [rows[0], { ...rows[1], credentialId: 'b'.repeat(64) }],
      };
    if (kind === 'foreign-attempt')
      observation = {
        ...observation,
        attempts: [
          rows[0],
          { ...rows[1], ref: trackedWorkloadRefForTest(w.ref.id) },
        ],
      };
    if (kind === 'stale-event') observation.status.events[1].createdAt = 1;
    if (kind === 'wrong-reason')
      observation.status.events[1].metadata = { reason: 'SSH unreachable' };
    if (kind === 'missing-marker') checkpoint = undefined;
    expect(() =>
      w.records.hostRecovered(
        w.run,
        before,
        fault,
        observation,
        identity,
        checkpoint,
      ),
    ).toThrow();
  });

  test('rejects host deletion after a terminal record', () => {
    const w = hostFixture();
    const before = w.prepareHost();
    w.records.terminal(w.run, {
      ...w.afterObservation.status,
      workload: {
        ...w.afterObservation.status.workload,
        state: WorkloadState.Terminated,
      },
    });
    expect(() => w.records.hostRecoveryFault(w.run, before)).toThrow(
      'exactly once',
    );
  });
});

describe('Job recovery evidence ordering and original ownership', () => {
  test('authorizes exactly one complete pre/fault/post recovery and requires it for finalization', () => {
    const w = fixture();
    const before = w.prepare();
    const fault = w.records.recoveryFault(w.run, before);
    const storage = w.records.extension(w.run, w.progress, 'bucket-storage');
    const recovered = w.records.recovered(
      w.run,
      before,
      fault,
      w.afterObservation,
      w.identity,
      4,
    );
    expect(recovered.kind).toBe('in-place-recovery');
    expect(() =>
      w.records.recovered(
        w.run,
        before,
        fault,
        w.afterObservation,
        w.identity,
        4,
      ),
    ).toThrow('exactly once');
    const terminalStatus = {
      ...w.afterObservation.status,
      workload: {
        ...w.afterObservation.status.workload,
        state: WorkloadState.Completed,
      },
    };
    const terminal = w.records.terminal(w.run, terminalStatus);
    expect(() =>
      w.records.claim(w.run, w.progress, [storage], terminal),
    ).toThrow('missing required');
    w.records.claim(w.run, w.progress, [storage, recovered], terminal);
    expect(() =>
      w.records.claim(w.run, w.progress, [storage, recovered], terminal),
    ).toThrow('single use');
  });

  test('rejects copied, missing, foreign-run and reused pre/fault records', () => {
    const w = fixture();
    const missing: unknown = {};
    const before = w.prepare();
    expect(() => w.prepare()).toThrow('exactly once');
    expect(() => w.records.recoveryFault(w.run, { ...before })).toThrow(
      'copied',
    );
    const otherRun = w.records.begin(
      trackedWorkloadRefForTest(w.ref.id),
      w.profile,
      1,
    );
    expect(() => w.records.recoveryFault(otherRun, before)).toThrow(
      'mismatched',
    );
    expect(() =>
      w.records.recovered(
        w.run,
        before,
        missing as JobRecoveryFault,
        w.afterObservation,
        w.identity,
        4,
      ),
    ).toThrow('missing');
    const fault = w.records.recoveryFault(w.run, before);
    expect(() => w.records.recoveryFault(w.run, before)).toThrow(
      'exactly once',
    );
    expect(() =>
      w.records.recovered(
        w.run,
        missing as JobRecoveryBefore,
        fault,
        w.afterObservation,
        w.identity,
        4,
      ),
    ).toThrow('missing');
    expect(() =>
      w.records.recovered(
        w.run,
        before,
        { ...fault },
        w.afterObservation,
        w.identity,
        4,
      ),
    ).toThrow('copied');
    expect(() =>
      w.records.recovered(
        otherRun,
        before,
        fault,
        w.afterObservation,
        w.identity,
        4,
      ),
    ).toThrow('mismatched');
    expect(() =>
      w.records.extension(w.run, w.progress, 'in-place-recovery'),
    ).toThrow('pre/fault/post');
  });

  test.each([0, 10, 1.5, NaN])(
    'cannot arm recovery with an empty, finished or malformed checkpoint count: %s',
    (count) => {
      const w = fixture();
      expect(() =>
        w.records.beforeRecovery(
          w.run,
          w.progress,
          w.beforeObservation,
          w.identity,
          count,
        ),
      ).toThrow('unfinished checkpoint');
    },
  );

  test.each([
    'vmId',
    'osDiskId',
    'cloudId',
    'region',
    'zone',
    'vmType',
  ] as const)('rejects a changed exact native %s after recovery', (field) => {
    const w = fixture();
    const before = w.prepare();
    const fault = w.records.recoveryFault(w.run, before);
    expect(() =>
      w.records.recovered(
        w.run,
        before,
        fault,
        w.afterObservation,
        { ...w.identity, [field]: 'replacement' },
        4,
      ),
    ).toThrow('exact VM or boot-disk');
  });

  test.each([
    'original-missing',
    'original-live',
    'original-rewritten',
    'new-early',
    'new-foreign-credential',
    'new-foreign-provider',
    'foreign-reference',
    'old-event',
    'foreign-event',
    'duplicate-event',
    'lost-checkpoint',
  ] as const)('rejects invalid recovery history: %s', (kind) => {
    const w = fixture();
    const before = w.prepare();
    const fault = w.records.recoveryFault(w.run, before);
    let attempts = w.afterObservation.attempts;
    let events = w.afterObservation.status.events;
    if (kind === 'original-missing') attempts = attempts.slice(1);
    if (kind === 'original-live') attempts = [w.attempt, attempts[1]];
    if (kind === 'original-rewritten')
      attempts = [{ ...attempts[0], region: 'us-west-2' }, attempts[1]];
    if (kind === 'new-early')
      attempts = [attempts[0], { ...attempts[1], createdAt: 15 }];
    if (kind === 'new-foreign-credential')
      attempts = [
        attempts[0],
        { ...attempts[1], credentialId: 'b'.repeat(64) },
      ];
    if (kind === 'new-foreign-provider')
      attempts = [
        attempts[0],
        { ...attempts[1], cloudProvider: CloudType.Azure },
      ];
    if (kind === 'foreign-reference')
      attempts = attempts.map((attempt) => ({
        ...attempt,
        ref: trackedWorkloadRefForTest(w.ref.id),
      }));
    if (kind === 'old-event') events = w.beforeObservation.status.events;
    if (kind === 'foreign-event')
      events = events.map((event) => ({
        ...event,
        workloadId: 'different-job',
      }));
    if (kind === 'duplicate-event') events = [...events, events[0]];
    const observation = {
      status: { ...w.afterObservation.status, events },
      attempts,
    };
    expect(() =>
      w.records.recovered(
        w.run,
        before,
        fault,
        observation,
        w.identity,
        kind === 'lost-checkpoint' ? 2 : 4,
      ),
    ).toThrow();
  });

  test('rejects a pre-fault record after terminal evidence and a recovery with no live baseline', () => {
    const w = fixture();
    const before = w.prepare();
    w.records.terminal(w.run, {
      ...w.afterObservation.status,
      workload: {
        ...w.afterObservation.status.workload,
        state: WorkloadState.Completed,
      },
    });
    expect(() => w.records.recoveryFault(w.run, before)).toThrow(
      'exactly once',
    );
    const other = fixture();
    const ref = trackedWorkloadRefForTest('terminal-only');
    const run = other.records.begin(ref, other.profile, 1);
    const status = {
      ...other.beforeObservation.status,
      workload: {
        ...other.beforeObservation.status.workload,
        id: ref.id,
        state: WorkloadState.Completed,
      },
      events: [],
    };
    const progress = other.records.progress(run, { status, attempts: [] });
    expect(() =>
      other.records.beforeRecovery(
        run,
        progress,
        { status, attempts: [] },
        other.identity,
        3,
      ),
    ).toThrow('live original baseline');
  });
});

function hydrationFixture() {
  const w = fixture({ kind: 'input-hydration-recovery', target: 'aws' });
  const apiContainerId = 'c'.repeat(64);
  const seedSha256 = 'd'.repeat(64);
  const worker = {
    observedAt: 1_000_000,
    active: true,
    invocation: 'a'.repeat(32),
    pid: 40,
    identity: 'e'.repeat(64),
    logBytes: 100,
  };
  const observation = (
    observedAt: number,
    logBytes = 200,
  ): JobHydrationObservation => ({
    ...w.beforeObservation,
    worker: { ...worker, observedAt, logBytes },
  });
  const baseline = observation(worker.observedAt, worker.logBytes);
  const disk = {
    id: w.identity.osDiskId,
    type: 'gp3',
    sizeGb: 350,
    iops: 3000,
    throughput: 125,
  };
  const restart = {
    identityBefore: apiContainerId,
    identityAfter: apiContainerId,
  };
  const logs = { launched: 1, adopted: 1 };
  const adopted = observation(1_010_000);
  const samples = Array.from({ length: 15 }, (_, index) =>
    observation(
      adopted.worker.observedAt + (index + 1) * 60_000,
      300 + index * 100,
    ),
  );
  const preFault = observation(2_000_000, 2000);
  const activity = {
    observedAt: 2_000_001,
    visibleBytes: 0,
    hiddenBytes: 2000,
  };
  const hidden = {
    ...activity,
    observedAt: activity.observedAt + 75_000,
    hiddenBytes: 2500,
  };
  const retry: JobHydrationObservation = {
    ...observation(activity.observedAt + 900_000, 0),
    status: {
      ...w.beforeObservation.status,
      workload: {
        ...w.beforeObservation.status.workload,
        state: WorkloadState.Retrying,
      },
      events: [
        ...w.beforeObservation.status.events,
        {
          id: 2,
          workloadId: w.ref.id,
          createdAt: activity.observedAt + 900_000,
          state: WorkloadState.Retrying,
          metadata: {
            reason: 'input hydration produced no output within 15 min',
          },
        },
      ],
    },
  };
  const resumed: JobHydrationObservation = {
    ...observation(retry.worker.observedAt + 30_000, 10),
    worker: {
      ...worker,
      observedAt: retry.worker.observedAt + 30_000,
      invocation: 'b'.repeat(32),
      pid: 41,
      logBytes: 10,
    },
  };
  const manifest = {
    count: '2048',
    bytes: '274877906944',
    first: seedSha256,
    middle: seedSha256,
    last: seedSha256,
  };
  const prepareHydration = () =>
    w.records.beforeHydration(
      w.run,
      w.progress,
      baseline,
      w.identity,
      { launched: 1, adopted: 0 },
      disk,
      { apiContainerId, seedSha256 },
    );
  const prepareHealthy = () => {
    const before = prepareHydration();
    const healthy = w.records.hydrationHealthy(
      w.run,
      before,
      restart,
      adopted,
      logs,
      samples,
    );
    return { before, healthy };
  };
  const prepareFault = () => {
    const { before, healthy } = prepareHealthy();
    const fault = w.records.hydrationFault(w.run, healthy, preFault, activity);
    return { before, healthy, fault };
  };
  return {
    ...w,
    apiContainerId,
    seedSha256,
    baseline,
    disk,
    restart,
    logs,
    adopted,
    samples,
    preFault,
    activity,
    hidden,
    retry,
    resumed,
    manifest,
    prepareHydration,
    prepareHealthy,
    prepareFault,
  };
}

describe('Job real input hydration evidence ownership', () => {
  test('binds the original detached worker, real timing windows and 256 GiB contents to one completion', () => {
    const w = hydrationFixture();
    const { before, healthy, fault } = w.prepareFault();
    const complete = () =>
      w.records.hydrated(
        w.run,
        before,
        healthy,
        fault,
        w.hidden,
        w.retry,
        w.resumed,
        w.identity,
        w.manifest,
      );
    const extension = complete();
    expect(extension.kind).toBe('input-hydration-recovery');
    expect(complete).toThrow('exactly once');
    const terminal = w.records.terminal(w.run, {
      ...w.resumed.status,
      workload: {
        ...w.resumed.status.workload,
        state: WorkloadState.Completed,
        completedAt: 3_500_000,
      },
    });
    expect(() => w.records.claim(w.run, w.progress, [], terminal)).toThrow(
      'missing',
    );
    w.records.claim(w.run, w.progress, [extension], terminal);
    expect(() =>
      w.records.claim(w.run, w.progress, [extension], terminal),
    ).toThrow('single use');
  });

  test('rejects copied, missing, foreign and reused pre/healthy/fault records and the generic shortcut', () => {
    const w = hydrationFixture();
    const { before, healthy, fault } = w.prepareFault();
    const empty: unknown = {};
    for (const [b, h, f] of [
      [{ ...before }, healthy, fault],
      [before, { ...healthy }, fault],
      [before, healthy, { ...fault }],
      [empty as JobHydrationBefore, healthy, fault],
      [before, empty as JobHydrationHealthy, fault],
      [before, healthy, empty as JobHydrationFault],
    ] as const)
      expect(() =>
        w.records.hydrated(
          w.run,
          b,
          h,
          f,
          w.hidden,
          w.retry,
          w.resumed,
          w.identity,
          w.manifest,
        ),
      ).toThrow('copied');
    const foreign = w.records.begin(
      trackedWorkloadRefForTest(w.ref.id),
      w.profile,
      1,
    );
    expect(() =>
      w.records.hydrated(
        foreign,
        before,
        healthy,
        fault,
        w.hidden,
        w.retry,
        w.resumed,
        w.identity,
        w.manifest,
      ),
    ).toThrow('mismatched');
    expect(() =>
      w.records.hydrationFault(w.run, healthy, w.preFault, w.activity),
    ).toThrow('exactly once');
    expect(() =>
      w.records.extension(w.run, w.progress, 'input-hydration-recovery'),
    ).toThrow();
  });

  test.each(['type', 'iops', 'throughput', 'sizeGb', 'id'] as const)(
    'requires exact original medium gp3 %s',
    (key) => {
      const w = hydrationFixture();
      const disk = {
        ...w.disk,
        [key]: typeof w.disk[key] === 'number' ? 1 : 'foreign',
      };
      expect(() =>
        w.records.beforeHydration(
          w.run,
          w.progress,
          w.baseline,
          w.identity,
          { launched: 1, adopted: 0 },
          disk,
          w,
        ),
      ).toThrow('real 350 GiB');
    },
  );

  test.each([
    'controller',
    'launched',
    'adoption',
    'invocation',
    'pid',
    'identity',
    'row',
    'terminal',
  ] as const)('rejects broken API restart adoption: %s', (failure) => {
    const w = hydrationFixture();
    const before = w.prepareHydration();
    const restart = { ...w.restart };
    const logs = { ...w.logs };
    const observation = { ...w.adopted, worker: { ...w.adopted.worker } };
    if (failure === 'controller') restart.identityAfter = 'f'.repeat(64);
    if (failure === 'launched') logs.launched++;
    if (failure === 'adoption') logs.adopted = 0;
    if (failure === 'invocation')
      observation.worker.invocation = 'b'.repeat(32);
    if (failure === 'pid') observation.worker.pid++;
    if (failure === 'identity') observation.worker.identity = 'f'.repeat(64);
    if (failure === 'row') observation.attempts = [{ ...w.attempt, rowId: 2 }];
    if (failure === 'terminal')
      observation.status = {
        ...observation.status,
        workload: {
          ...observation.status.workload,
          state: WorkloadState.Completed,
        },
      };
    expect(() =>
      w.records.hydrationAdopted(w.run, before, restart, observation, logs),
    ).toThrow();
  });

  test.each([
    'short',
    'four-growth',
    'backwards-time',
    'lost-log',
    'worker-replaced',
  ] as const)('requires real healthy duration and progress: %s', (failure) => {
    const w = hydrationFixture();
    const before = w.prepareHydration();
    let samples = w.samples.map((s) => ({ ...s, worker: { ...s.worker } }));
    if (failure === 'short') samples = samples.slice(0, 14);
    if (failure === 'four-growth')
      for (const sample of samples.slice(4))
        sample.worker.logBytes = samples[3].worker.logBytes;
    if (failure === 'backwards-time')
      samples[3].worker.observedAt = samples[2].worker.observedAt;
    if (failure === 'lost-log') samples[3].worker.logBytes = 0;
    if (failure === 'worker-replaced') samples[3].worker.pid++;
    expect(() =>
      w.records.hydrationHealthy(
        w.run,
        before,
        w.restart,
        w.adopted,
        w.logs,
        samples,
      ),
    ).toThrow();
  });

  test.each([
    'nonempty-visible',
    'hidden-loss',
    'early',
    'fractional',
    'stale-baseline',
  ] as const)(
    'rejects missing or misordered log-hiding proof: %s',
    (failure) => {
      const w = hydrationFixture();
      const { healthy } = w.prepareHealthy();
      const activity = { ...w.activity };
      const observation = { ...w.preFault, worker: { ...w.preFault.worker } };
      if (failure === 'nonempty-visible') activity.visibleBytes = 1;
      if (failure === 'hidden-loss') activity.hiddenBytes = 1;
      if (failure === 'early')
        activity.observedAt = observation.worker.observedAt - 1;
      if (failure === 'fractional') activity.observedAt += 0.5;
      if (failure === 'stale-baseline')
        observation.worker.observedAt = w.adopted.worker.observedAt;
      expect(() =>
        w.records.hydrationFault(w.run, healthy, observation, activity),
      ).toThrow('hide actual activity');
    },
  );

  test.each([
    'early',
    'late',
    'foreign-event',
    'old-event',
    'wrong-reason',
    'replaced-row',
    'no-hidden-growth',
    'short-hidden-proof',
    'old-worker',
    'changed-input',
    'disk',
    'bytes',
    'middle-hash',
  ] as const)(
    'cannot complete after invalid recovery evidence: %s',
    (failure) => {
      const w = hydrationFixture();
      const { before, healthy, fault } = w.prepareFault();
      const retry = {
        ...w.retry,
        worker: { ...w.retry.worker },
        status: {
          ...w.retry.status,
          events: w.retry.status.events.map((e) => ({ ...e })),
        },
      };
      const resumed = { ...w.resumed, worker: { ...w.resumed.worker } };
      const hidden = { ...w.hidden };
      const identity = { ...w.identity };
      const manifest = { ...w.manifest };
      if (failure === 'early')
        retry.worker.observedAt = w.activity.observedAt + 899_999;
      if (failure === 'late')
        retry.worker.observedAt = w.activity.observedAt + 1_080_001;
      if (failure === 'foreign-event')
        retry.status.events[1].workloadId = 'other-job';
      if (failure === 'old-event')
        retry.status.events[1].createdAt = retry.status.events[0].createdAt;
      if (failure === 'wrong-reason')
        retry.status.events[1].metadata = {
          reason: 'worker failed for another cause',
        };
      if (failure === 'replaced-row')
        retry.attempts = [{ ...w.attempt, rowId: 2 }];
      if (failure === 'no-hidden-growth')
        hidden.hiddenBytes = w.activity.hiddenBytes;
      if (failure === 'short-hidden-proof')
        hidden.observedAt = w.activity.observedAt + 74_999;
      if (failure === 'old-worker')
        resumed.worker.invocation = w.baseline.worker.invocation;
      if (failure === 'changed-input') resumed.worker.identity = 'f'.repeat(64);
      if (failure === 'disk') identity.osDiskId = 'replacement-disk';
      if (failure === 'bytes') manifest.bytes = '134217728';
      if (failure === 'middle-hash') manifest.middle = 'f'.repeat(64);
      expect(() =>
        w.records.hydrated(
          w.run,
          before,
          healthy,
          fault,
          hidden,
          retry,
          resumed,
          identity,
          manifest,
        ),
      ).toThrow();
      expect(() =>
        w.records.extension(w.run, w.progress, 'input-hydration-recovery'),
      ).toThrow();
    },
  );
});
