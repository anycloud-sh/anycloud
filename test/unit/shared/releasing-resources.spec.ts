import { describe, expect, it } from 'vitest';

import {
  WorkloadState,
  isReleasingResources,
} from '../../../src/shared/workload.js';

describe('isReleasingResources', () => {
  // Cleanup lives on its own axis, so a terminal state alone says nothing
  // about whether the provider VM — and the bill — is gone.
  it.each([
    WorkloadState.Terminated,
    WorkloadState.Completed,
    WorkloadState.Errored,
    WorkloadState.Failed,
    WorkloadState.Invalid,
  ])('flags %s while a VM is still live', (state) => {
    expect(isReleasingResources({ state, cleanedAt: null, vmCount: 1 })).toBe(
      true,
    );
  });

  it('clears once teardown is committed', () => {
    expect(
      isReleasingResources({
        state: WorkloadState.Terminated,
        cleanedAt: 1_700_000_000_000,
        vmCount: 0,
      }),
    ).toBe(false);
  });

  // cleanedAt is optional on responses from older APIs, so the live VM count
  // is the authority — absent must not read as "already cleaned".
  it('flags a live VM when cleanedAt is absent', () => {
    expect(
      isReleasingResources({
        state: WorkloadState.Terminated,
        vmCount: 1,
      }),
    ).toBe(true);
  });

  // A committed cleanup wins over a stale VM count so the marker cannot stick.
  it('trusts a committed cleanup over a stale VM count', () => {
    expect(
      isReleasingResources({
        state: WorkloadState.Terminated,
        cleanedAt: 1_700_000_000_000,
        vmCount: 1,
      }),
    ).toBe(false);
  });

  it('never flags a workload that has not reached an outcome', () => {
    expect(
      isReleasingResources({
        state: WorkloadState.Running,
        cleanedAt: null,
        vmCount: 1,
      }),
    ).toBe(false);
  });
});
