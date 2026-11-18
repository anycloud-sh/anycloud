import { describe, expect, test } from 'vitest';

import { CloudType } from '../../src/shared/cloud.js';
import { WorkloadHealthStatus } from '../../src/shared/runtime.js';
import { WorkloadState, WorkloadType } from '../../src/shared/workload.js';
import { Redactor } from '../integration/e2e/internal/artifacts.js';
import { Environment } from '../integration/e2e/internal/environment.js';
import { jobMemberProfile } from '../integration/e2e/internal/contracts/job-policy.js';
import {
  JobRecords,
  type JobTerminal,
} from '../integration/e2e/internal/contracts/job-records.js';
import type { StatusResponse } from '../integration/e2e/internal/types.js';
import type { JobNativeAttempt } from '../integration/e2e/internal/targets/job-types.js';
import {
  liveStatusVmEntries,
  snapshotStatusVmLedger,
} from '../integration/e2e/internal/vm-ledger.js';
import { trackedWorkloadRefForTest } from './helpers/e2e.js';
import { persistentVmWorkload } from './helpers/persistent-vm-fixture.js';

function harness(
  kind: 'local-held' | 'local-resubmitted' | 'invalid-admission' = 'local-held',
) {
  const records = new JobRecords({
    snapshot: (ref, status) => snapshotStatusVmLedger(ref.id, status),
    liveEntries: liveStatusVmEntries,
  });
  const ref = trackedWorkloadRefForTest('record-job');
  const profile = jobMemberProfile(
    kind === 'invalid-admission'
      ? { kind, target: 'aws' }
      : { kind, target: 'local-smolvm' },
    new Environment({}, new Redactor()),
  );
  const status = (state: WorkloadState): StatusResponse => ({
    status: WorkloadHealthStatus.Up,
    workload: persistentVmWorkload(ref.id, {
      workloadType: WorkloadType.Job,
      state,
    }),
    events: [],
  });
  const attempt: JobNativeAttempt = {
    ref,
    rowId: 1,
    createdAt: 1,
    endedAt: null,
    cloudId: `ac-local-${ref.id}-0`,
    ip: 'localhost',
    cloudProvider: CloudType.Local,
    credentialId: null,
    region: 'local',
    availabilityZone: null,
    vmType: 'local',
  };
  const run = records.begin(ref, profile, 1);
  const active = () =>
    records.progress(run, {
      status: status(WorkloadState.Running),
      attempts: [attempt],
    });
  return { records, ref, profile, status, attempt, run, active };
}

describe('Job evidence ownership and finalizer authority', () => {
  test('admission records retain their original case and reference and allow one finalizer', () => {
    const w = harness('invalid-admission');
    const admissionCase = w.profile.admissionCases![1];
    const observation = {
      ref: w.ref,
      kind: 'rejected' as const,
      message: 'VM type "totally_fake_nonexistent_vm" is not available on AWS',
    };
    expect(() =>
      w.records.admission(w.run, { ...admissionCase }, observation),
    ).toThrow('original case');
    expect(() =>
      w.records.admission(w.run, admissionCase, {
        ...observation,
        ref: trackedWorkloadRefForTest(w.ref.id),
      }),
    ).toThrow('original case');
    expect(() =>
      w.records.admission(w.run, admissionCase, {
        ...observation,
        kind: 'invalid',
      }),
    ).toThrow('original case');
    expect(() =>
      w.records.admission(w.run, admissionCase, {
        ...observation,
        message: 'authentication denied',
      }),
    ).toThrow('different reason');
    const record = w.records.admission(w.run, admissionCase, observation);
    expect(() =>
      w.records.admission(w.run, admissionCase, observation),
    ).toThrow('single generation');
    expect(() => w.records.claimAdmission(w.run, { ...record })).toThrow(
      'copied',
    );
    const other = w.records.begin(
      trackedWorkloadRefForTest('other-admission'),
      w.profile,
      1,
    );
    expect(() => w.records.claimAdmission(other, record)).toThrow('mismatched');
    w.records.claimAdmission(w.run, record);
    expect(() => w.records.claimAdmission(w.run, record)).toThrow('single use');
  });

  test('does not substitute a foreign bucket failure for the selected reserved bucket', () => {
    const w = harness('invalid-admission');
    const admissionCase = w.profile.admissionCases![0];
    expect(() =>
      w.records.admission(w.run, admissionCase, {
        ref: w.ref,
        kind: 'rejected',
        message: 'Input bucket "someone-else" not found',
      }),
    ).toThrow('different reason');
    const record = w.records.admission(w.run, admissionCase, {
      ref: w.ref,
      kind: 'rejected',
      message: `Input bucket "sthree-reserved-test-${w.ref.id}" not found`,
    });
    expect(record.kind).toBe('invalid-admission');
  });

  test('requires the rejected Azure GPU message to name its original AMD VM', () => {
    const w = harness();
    const profile = jobMemberProfile(
      { kind: 'invalid-admission', target: 'azure' },
      new Environment({}, new Redactor()),
    );
    const ref = trackedWorkloadRefForTest('gpu-admission');
    const run = w.records.begin(ref, profile, 1);
    const admissionCase = profile.admissionCases![2];
    expect(() =>
      w.records.admission(run, admissionCase, {
        ref,
        kind: 'rejected',
        message: 'Docker GPU options require an NVIDIA CUDA VM: "foreign-vm"',
      }),
    ).toThrow('different reason');
    expect(
      w.records.admission(run, admissionCase, {
        ref,
        kind: 'rejected',
        message:
          'Docker GPU options require an NVIDIA CUDA VM: "Standard_ND96isr_MI300X_v5"',
      }).kind,
    ).toBe('invalid-admission');
  });

  test('a terminal record cannot be followed by non-creation admission evidence', () => {
    const w = harness('invalid-admission');
    w.records.progress(w.run, {
      status: w.status(WorkloadState.Invalid),
      attempts: [],
    });
    w.records.terminal(w.run, w.status(WorkloadState.Invalid));
    expect(() =>
      w.records.admission(w.run, w.profile.admissionCases![0], {
        ref: w.ref,
        kind: 'rejected',
        message: 'Invalid bucket name',
      }),
    ).toThrow('original case');
  });

  test('requires all original extensions and permits only one finalizer claim', () => {
    const { records, run, status, active } = harness();
    const progress = active();
    const storage = records.extension(run, progress, 'local-storage');
    const config = records.extension(run, progress, 'local-configuration');
    const terminal = records.terminal(run, status(WorkloadState.Terminated));
    expect(() => records.claim(run, progress, [storage], terminal)).toThrow(
      'missing required',
    );
    expect(() =>
      records.claim(run, progress, [storage, storage], terminal),
    ).toThrow('repeats an extension');
    expect(() =>
      records.claim(run, progress, [storage, { ...config }], terminal),
    ).toThrow('copied');
    records.claim(run, progress, [storage, config], terminal);
    expect(() =>
      records.claim(run, progress, [storage, config], terminal),
    ).toThrow('single use');
  });

  test('rejects copied baselines, cross-run records, and repeated extensions', () => {
    const world = harness();
    const progress = world.active();
    expect(() =>
      world.records.extension(world.run, { ...progress }, 'local-storage'),
    ).toThrow('copied');
    const other = world.records.begin(
      trackedWorkloadRefForTest(world.ref.id),
      world.profile,
      1,
    );
    expect(() =>
      world.records.extension(other, progress, 'local-storage'),
    ).toThrow('mismatched');
    world.records.extension(world.run, progress, 'local-storage');
    expect(() =>
      world.records.extension(world.run, progress, 'local-storage'),
    ).toThrow('reused');
  });

  test('does not let a later same-ID generation reuse an earlier baseline', () => {
    const world = harness('local-resubmitted');
    const progress = world.active();
    expect(() => world.records.begin(world.ref, world.profile, 2)).toThrow(
      'original cleaned',
    );
    const status = world.status(WorkloadState.Errored);
    status.workload.cleanedAt = 3;
    const terminal = world.records.terminal(world.run, status);
    const previous = world.records.prepareResubmission(
      world.run,
      progress,
      terminal,
      {
        status,
        attempts: [{ ...world.attempt, endedAt: 3 }],
      },
    );
    expect(() =>
      world.records.begin(world.ref, world.profile, 2, { ...previous }),
    ).toThrow('original cleaned');
    const next = world.records.begin(world.ref, world.profile, 2, previous);
    expect(() =>
      world.records.extension(world.run, progress, 'local-storage'),
    ).toThrow('stale');
    expect(() =>
      world.records.extension(next, progress, 'local-storage'),
    ).toThrow('mismatched');
    expect(() => world.records.begin(world.ref, world.profile, 2)).toThrow(
      'reused or skipped',
    );
  });

  test('resubmission completion requires the same original pre/post records, including terminal-only progress', () => {
    const world = harness('local-resubmitted');
    const status = world.status(WorkloadState.Errored);
    status.workload.cleanedAt = 3;
    const progress = world.records.progress(world.run, {
      status,
      attempts: [],
    });
    const terminal = world.records.terminal(world.run, status);
    const observation = {
      status,
      attempts: [{ ...world.attempt, endedAt: 3 }],
    };
    const previous = world.records.prepareResubmission(
      world.run,
      progress,
      terminal,
      observation,
    );
    expect(() =>
      world.records.prepareResubmission(
        world.run,
        progress,
        terminal,
        observation,
      ),
    ).toThrow('exactly once');
    const second = world.records.begin(world.ref, world.profile, 2, previous);
    const secondProgress = world.records.progress(second, observation);
    expect(() =>
      world.records.resubmitted(second, secondProgress, { ...previous }),
    ).toThrow('original pre/post');
    expect(() =>
      world.records.resubmitted(second, { ...secondProgress }, previous),
    ).toThrow('copied');
    const extension = world.records.resubmitted(
      second,
      secondProgress,
      previous,
    );
    expect(() =>
      world.records.resubmitted(second, secondProgress, previous),
    ).toThrow('reused');
    const secondTerminal = world.records.terminal(second, status);
    world.records.claim(second, secondProgress, [extension], secondTerminal);
    expect(() =>
      world.records.claim(second, secondProgress, [extension], secondTerminal),
    ).toThrow('single use');
  });

  test('cannot prepare a new generation from an early, live, foreign, or uncleaned observation', () => {
    const world = harness('local-resubmitted');
    const progress = world.active();
    const status = world.status(WorkloadState.Errored);
    const terminal = world.records.terminal(world.run, status);
    const observations = [
      { status, attempts: [{ ...world.attempt, endedAt: 3 }] },
      {
        status: { ...status, workload: { ...status.workload, cleanedAt: 3 } },
        attempts: [world.attempt],
      },
      {
        status: {
          ...status,
          workload: { ...status.workload, id: 'foreign', cleanedAt: 3 },
        },
        attempts: [{ ...world.attempt, endedAt: 3 }],
      },
      {
        status: { ...status, workload: { ...status.workload, cleanedAt: 3 } },
        attempts: [],
      },
      {
        status: { ...status, workload: { ...status.workload, cleanedAt: 3 } },
        attempts: [
          {
            ...world.attempt,
            ref: trackedWorkloadRefForTest(world.ref.id),
            endedAt: 3,
          },
        ],
      },
    ];
    for (const observation of observations)
      expect(() =>
        world.records.prepareResubmission(
          world.run,
          progress,
          terminal,
          observation,
        ),
      ).toThrow('persisted cleanup');
    expect(() =>
      world.records.prepareResubmission(
        world.run,
        progress,
        { ...terminal },
        observations[0],
      ),
    ).toThrow('copied');
    expect(() =>
      world.records.extension(world.run, progress, 'same-id-resubmission'),
    ).toThrow('after terminal');
    const other = harness('local-resubmitted');
    const otherProgress = other.active();
    expect(() =>
      other.records.extension(other.run, otherProgress, 'same-id-resubmission'),
    ).toThrow('generation transition');
  });

  test('a transition cannot authorize a different reference or changed member profile', () => {
    const world = harness('local-resubmitted');
    const progress = world.active();
    const status = world.status(WorkloadState.Errored);
    status.workload.cleanedAt = 3;
    const terminal = world.records.terminal(world.run, status);
    const previous = world.records.prepareResubmission(
      world.run,
      progress,
      terminal,
      {
        status,
        attempts: [{ ...world.attempt, endedAt: 3 }],
      },
    );
    expect(() =>
      world.records.begin(world.ref, { ...world.profile }, 2, previous),
    ).toThrow('original cleaned');
    const otherRef = trackedWorkloadRefForTest(world.ref.id);
    world.records.begin(otherRef, world.profile, 1);
    expect(() =>
      world.records.begin(otherRef, world.profile, 2, previous),
    ).toThrow('original cleaned');
    expect(() =>
      world.records.begin(
        trackedWorkloadRefForTest('third'),
        world.profile,
        1,
        previous,
      ),
    ).toThrow('cannot use a predecessor');
  });

  test('records short completion without pretending live extensions executed', () => {
    const { records, run, status } = harness();
    const terminalOnly = records.progress(run, {
      status: status(WorkloadState.Terminated),
      attempts: [],
    });
    expect(terminalOnly.kind).toBe('terminal-before-active');
    expect(() => records.extension(run, terminalOnly, 'local-storage')).toThrow(
      'active baseline',
    );
  });

  test('rejects early, foreign, and incorrect terminal observations', () => {
    const { records, run, status, active } = harness();
    expect(() =>
      records.terminal(run, status(WorkloadState.Terminated)),
    ).toThrow('one baseline');
    const progress = active();
    const missingTerminal = Object.freeze({});
    expect(() =>
      records.claim(run, progress, [], missingTerminal as JobTerminal),
    ).toThrow('copied');
    expect(() => records.terminal(run, status(WorkloadState.Errored))).toThrow(
      'unexpected terminal',
    );
    const foreign = status(WorkloadState.Terminated);
    foreign.workload.id = 'foreign';
    expect(() => records.terminal(run, foreign)).toThrow('another Workload');
    records.terminal(run, status(WorkloadState.Terminated));
    expect(() => records.extension(run, progress, 'local-storage')).toThrow(
      'after terminal',
    );
  });

  test('requires an owned, live attempt for active evidence', () => {
    const { records, run, status, attempt } = harness();
    expect(() =>
      records.progress(run, {
        status: status(WorkloadState.Queued),
        attempts: [],
      }),
    ).toThrow('has not reached');
    expect(() =>
      records.progress(run, {
        status: status(WorkloadState.Running),
        attempts: [],
      }),
    ).toThrow('one live attempt');
    expect(() =>
      records.progress(run, {
        status: status(WorkloadState.Running),
        attempts: [{ ...attempt, ref: trackedWorkloadRefForTest('foreign') }],
      }),
    ).toThrow('foreign attempts');
  });
});
