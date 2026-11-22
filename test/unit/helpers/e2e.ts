import type {
  CleanupRecorded,
  WorkloadReleaseEvidence,
  SubstrateAbsent,
  TrackedWorkloadRef,
  VmLedgerCleared,
} from '../../integration/e2e/internal/workloads.js';
import type {
  CommandResult,
  StatusResponse,
} from '../../integration/e2e/internal/types.js';

export function commandResultForTest(
  overrides: Partial<CommandResult> = {},
): CommandResult {
  return {
    aborted: false,
    args: [],
    combined: '',
    durationMs: 1,
    executable: 'anycloud',
    exitCode: 0,
    outputTruncated: false,
    signal: null,
    stderr: '',
    stdout: '',
    timedOut: false,
    ...overrides,
  };
}

export function trackedWorkloadRefForTest(id: string): TrackedWorkloadRef {
  const shape: Readonly<{ readonly id: string }> = Object.freeze({ id });
  return shape as TrackedWorkloadRef;
}

export function cleanupRecordedForTest(
  ref: TrackedWorkloadRef,
  status: StatusResponse,
): CleanupRecorded {
  const shape: Readonly<{
    readonly ref: TrackedWorkloadRef;
    readonly status: StatusResponse;
  }> = Object.freeze({ ref, status });
  return shape as CleanupRecorded;
}

export function vmLedgerClearedForTest(
  ref: TrackedWorkloadRef,
): VmLedgerCleared {
  return Object.freeze({ ref }) as VmLedgerCleared;
}

export function substrateAbsentForTest(
  ref: TrackedWorkloadRef,
): SubstrateAbsent {
  return Object.freeze({ ref }) as SubstrateAbsent;
}

export function releaseEvidenceForTest(
  cleanup: CleanupRecorded,
): WorkloadReleaseEvidence {
  return {
    cleanup,
    ledger: vmLedgerClearedForTest(cleanup.ref),
    substrate: substrateAbsentForTest(cleanup.ref),
  };
}
