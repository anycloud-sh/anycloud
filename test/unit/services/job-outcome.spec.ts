import { describe, expect, it } from 'vitest';

import {
  batchPolicy,
  RUNNER_REPLICA_POLICY,
  outcomeOf,
  type Cause,
  type Outcome,
} from '../../../src/api/services/job-outcome.js';
import { WorkloadState } from '../../../src/shared/workload.js';

// One row per Cause kind, with the details a classifier supplies.
const rows: [Cause, Outcome][] = [
  [{ kind: 'exit', code: 0, oom: false }, { state: WorkloadState.Completed }],
  [
    { kind: 'exit', code: 3, oom: false },
    { state: WorkloadState.Errored, exitCode: 3, error: 'Exited with code 3' },
  ],
  [
    { kind: 'exit', code: 137, oom: true },
    {
      state: WorkloadState.Errored,
      exitCode: 137,
      error: 'OOMKilled (exit 137)',
    },
  ],
  [
    { kind: 'disrupted', detail: 'EvictionByEvictionAPI: evicting' },
    {
      state: WorkloadState.Retrying,
      reason: 'EvictionByEvictionAPI: evicting',
    },
  ],
  [
    { kind: 'evicted-storage', detail: 'Evicted: storage over its limit' },
    { state: WorkloadState.Invalid, error: 'Evicted: storage over its limit' },
  ],
  [
    { kind: 'deadline', detail: 'TIMEOUT: time limit reached' },
    { state: WorkloadState.Failed, error: 'TIMEOUT: time limit reached' },
  ],
  [
    { kind: 'unrecoverable', detail: 'InvalidImageName: bad name' },
    { state: WorkloadState.Invalid, error: 'InvalidImageName: bad name' },
  ],
  [
    { kind: 'transfer', detail: 'container not found' },
    {
      state: WorkloadState.Failed,
      error: 'Final bucket sync failed: container not found',
    },
  ],
  [
    { kind: 'lost', detail: 'nothing was recorded' },
    {
      state: WorkloadState.Failed,
      error: 'Job outcome lost: nothing was recorded',
    },
  ],
];

describe('batchPolicy', () => {
  const policy = batchPolicy({ resumable: false });

  it.each(rows)('maps %j', (cause, outcome) => {
    expect(outcomeOf(policy, cause)).toEqual(outcome);
  });

  it('0046/S22 retries a deadline only for a resumable Job', () => {
    const resumable = batchPolicy({ resumable: true });
    for (const [cause, outcome] of rows) {
      expect(outcomeOf(resumable, cause)).toEqual(
        cause.kind === 'deadline'
          ? { state: WorkloadState.Retrying, reason: cause.detail }
          : outcome,
      );
    }
  });

  it('covers every Cause kind and adds no substrate words of its own', () => {
    expect(new Set(rows.map(([cause]) => cause.kind))).toEqual(
      new Set(Object.keys(policy)),
    );
    for (const [cause] of rows) {
      expect(JSON.stringify(outcomeOf(policy, cause))).not.toMatch(
        /\b(Pod|Node)\b/u,
      );
    }
  });
});

describe('RUNNER_REPLICA_POLICY', () => {
  it("ends an OOM errored, retries the runner's other exits, and never completes on a kept OOMKilled reason", () => {
    expect(
      outcomeOf(RUNNER_REPLICA_POLICY, { kind: 'exit', code: 137, oom: true }),
    ).toEqual({
      state: WorkloadState.Errored,
      exitCode: 137,
      error: 'OOMKilled (exit 137)',
    });
    for (const cause of [
      { kind: 'exit', code: 137, oom: false },
      { kind: 'exit', code: 0, oom: true },
      { kind: 'exit', code: 0, oom: false },
    ] as const) {
      expect(outcomeOf(RUNNER_REPLICA_POLICY, cause)).toEqual({
        state: WorkloadState.Retrying,
        reason: `runner exited with code ${cause.code}`,
      });
    }
  });
});
