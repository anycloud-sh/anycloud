import type {
  CleanupRecorded,
  WorkloadReleaseEvidence,
  SubstrateAbsent,
  TrackedWorkloadRef,
  VmLedgerCleared,
} from '../../integration/e2e/internal/workloads.js';
import type {
  NodePoolDeletionRecorded,
  TrackedNodePoolRef,
} from '../../integration/e2e/internal/node-pools.js';
import type {
  DeploymentDeletionRecorded,
  DeploymentSubstrateAbsent,
  TrackedDeploymentRef,
} from '../../integration/e2e/internal/deployments.js';
import type {
  CommandResult,
  NodePoolSummary,
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

export function pythonSdkFailureForTest(
  options: {
    readonly action?: string;
    readonly status?: number;
    readonly exception?: string;
    readonly finalization?: Readonly<Record<string, unknown>>;
    readonly body?: string;
  } = {},
): CommandResult {
  const action = options.action ?? 'get_deployment';
  const exception = options.exception ?? 'ServiceException';
  const receipt = {
    kind: 'python-sdk-finalization',
    action,
    client: 'AsyncClient',
    transportClosed: true,
    pendingTasks: 0,
    errors: [{ phase: 'action', type: exception }],
    ...options.finalization,
  };
  const stderr = `${JSON.stringify(receipt)}\nTraceback:\nanycloud.exceptions.${exception}: (${String(options.status ?? 522)})\nReason: unavailable\nHTTP response body: ${options.body ?? ''}\n`;
  return commandResultForTest({ exitCode: 1, stderr, combined: stderr });
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

export function trackedNodePoolRefForTest(name: string): TrackedNodePoolRef {
  const shape: Readonly<{ readonly name: string }> = Object.freeze({ name });
  return shape as TrackedNodePoolRef;
}

export function trackedDeploymentRefForTest(
  name: string,
  parent: TrackedNodePoolRef,
): TrackedDeploymentRef {
  const shape: Readonly<{
    readonly name: string;
    readonly parent: TrackedNodePoolRef;
  }> = Object.freeze({ name, parent });
  return shape as TrackedDeploymentRef;
}

export function nodePoolDeletionRecordedForTest(
  ref: TrackedNodePoolRef,
  nodePool: NodePoolSummary,
): NodePoolDeletionRecorded {
  const shape: Readonly<{
    readonly ref: TrackedNodePoolRef;
    readonly nodePool: NodePoolSummary;
  }> = Object.freeze({ ref, nodePool });
  return shape as NodePoolDeletionRecorded;
}

export function deploymentDeletionRecordedForTest(
  ref: TrackedDeploymentRef,
  deployment: DeploymentDeletionRecorded['deployment'],
): DeploymentDeletionRecorded {
  return Object.freeze({ ref, deployment }) as DeploymentDeletionRecorded;
}

export function deploymentSubstrateAbsentForTest(
  ref: TrackedDeploymentRef,
  facts: DeploymentSubstrateAbsent['facts'],
): DeploymentSubstrateAbsent {
  return Object.freeze({ ref, facts }) as DeploymentSubstrateAbsent;
}
