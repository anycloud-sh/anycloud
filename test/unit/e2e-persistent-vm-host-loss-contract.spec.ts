import type { TrackedWorkloadRef } from '../integration/e2e/internal/workloads.js';
import { describe, expect, test } from 'vitest';

import type {
  WorkloadStatusResponse as StatusResponse,
  StatusWorkloadMetadata,
} from '../../src/shared/api-contract/workload-management-schemas.js';
import { WorkloadState } from '../../src/shared/workload.js';
import { WorkloadHealthStatus } from '../../src/shared/runtime.js';
import type { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import {
  PERSISTENT_VM_HOST_LOSS_REASON,
  PersistentVmHostLossContract,
  type PersistentVmHostLossContractDependencies,
} from '../integration/e2e/internal/contracts/persistent-vm-host-loss.js';
import {
  assertVmLedgerUnchanged,
  snapshotStatusVmLedger,
  statusVmEntriesForCloudId,
} from '../integration/e2e/internal/vm-ledger.js';
import {
  cleanupRecordedForTest,
  vmLedgerClearedForTest,
} from './helpers/e2e.js';
import {
  createPersistentVmFixture,
  persistentVmWorkload,
} from './helpers/persistent-vm-fixture.js';

type ForcedFailure =
  | 'native-evidence'
  | 'assertion'
  | 'cleanup'
  | 'deletion'
  | 'provider-delay'
  | 'teardown-budget';

interface HostLossHarness {
  readonly calls: string[];
  readonly cleanup: CleanupStack;
  readonly contract: PersistentVmHostLossContract;
}

function workload(
  id: string,
  state: WorkloadState,
  cleanedAt = 110,
): StatusWorkloadMetadata {
  const terminal = state === WorkloadState.Failed;
  return persistentVmWorkload(id, {
    state,
    completedAt: terminal ? 100 : null,
    cleanedAt: terminal ? cleanedAt : null,
    availabilityZone: 'a',
    vmCount: terminal ? 0 : 1,
  });
}

function runningStatus(id: string): StatusResponse {
  return {
    workload: workload(id, WorkloadState.Running),
    events: [
      {
        id: 1,
        workloadId: id,
        state: WorkloadState.Running,
        metadata: null,
        createdAt: 10,
      },
    ],
    status: WorkloadHealthStatus.Up,
    vms: [
      {
        cloudId: 'capacity-retry-1',
        endedAt: 20,
        ip: '127.0.0.8',
      },
      {
        cloudId: 'capacity-retry-2',
        endedAt: 30,
        ip: '127.0.0.9',
      },
      {
        cloudId: 'cloud-vm-1',
        endedAt: null,
        ip: '127.0.0.1',
        region: 'us-east-2',
        sshHost: '127.0.0.1',
        sshPort: 2222,
      },
    ],
  };
}

function failedStatus(
  id: string,
  replacement = false,
  cleanedAt = 110,
): StatusResponse {
  return {
    workload: workload(id, WorkloadState.Failed, cleanedAt),
    events: [
      ...runningStatus(id).events,
      {
        id: 2,
        workloadId: id,
        state: WorkloadState.Failed,
        metadata: {
          cloudId: 'cloud-vm-1',
          reason: PERSISTENT_VM_HOST_LOSS_REASON,
        },
        createdAt: 100,
      },
      ...(replacement
        ? [
            {
              id: 3,
              workloadId: id,
              state: WorkloadState.Provisioning,
              metadata: null,
              createdAt: 101,
            },
          ]
        : []),
    ],
    status: WorkloadHealthStatus.Down,
    vms: [
      {
        cloudId: 'capacity-retry-1',
        endedAt: 20,
        ip: '127.0.0.8',
      },
      {
        cloudId: 'capacity-retry-2',
        endedAt: 30,
        ip: '127.0.0.9',
      },
      {
        cloudId: 'cloud-vm-1',
        endedAt: 110,
        ip: '127.0.0.1',
        region: 'us-east-2',
        sshHost: '127.0.0.1',
        sshPort: 2222,
      },
      ...(replacement
        ? [
            {
              cloudId: 'replacement-vm',
              endedAt: null,
              ip: '127.0.0.2',
            },
          ]
        : []),
    ],
  };
}

function createHostLossHarness(forcedFailure?: ForcedFailure): HostLossHarness {
  const {
    calls,
    cleanup,
    dependencies: common,
  } = createPersistentVmFixture('vm-host-loss-aws-run');
  let liveCountProbe = 0;

  const dependencies: PersistentVmHostLossContractDependencies = {
    ...common,
    nativeCleanup: {
      ...common.nativeCleanup,
      verify: async (...args) => {
        if (forcedFailure === 'native-evidence')
          throw new Error('Native host absence is unavailable');
        return common.nativeCleanup.verify(...args);
      },
    },
    kernel: {
      ...common.kernel,
      eventsSince: async (ref, baseline) => {
        calls.push('events-since');
        return failedStatus(
          ref.id,
          forcedFailure === 'assertion',
        ).events.filter((event) => event.createdAt > baseline);
      },
      waitForCleanupRecorded: async (ref) => {
        calls.push('wait-cleanup');
        if (forcedFailure === 'cleanup') {
          throw new Error('forced cleanup observation failure');
        }
        return cleanupRecordedForTest(
          ref,
          failedStatus(
            ref.id,
            forcedFailure === 'assertion',
            // completedAt is 100 against a 1_000 budget: cleanup landed, far
            // later than a host that was already gone can justify.
            forcedFailure === 'teardown-budget' ? 5_000 : 110,
          ),
        );
      },
      waitForState: async (ref, state) => {
        calls.push(`wait-${state}`);
        if (
          state === WorkloadState.Failed &&
          forcedFailure === 'provider-delay'
        ) {
          throw new Error('forced provider confirmation timeout');
        }
        return state === WorkloadState.Running
          ? runningStatus(ref.id)
          : failedStatus(ref.id);
      },
    },
    vmLedger: {
      ...common.vmLedger,
      assertUnchangedSince: (ref, baseline, status) => {
        const current = snapshotStatusVmLedger(ref.id, status);
        assertVmLedgerUnchanged(baseline, current);
        return current;
      },
      entriesForCloudId: statusVmEntriesForCloudId,
      assertCleared: async (ref: TrackedWorkloadRef) => {
        calls.push(`live-count-${String((liveCountProbe += 1))}`);
        return vmLedgerClearedForTest(ref);
      },
      liveVmCount: async () => {
        liveCountProbe += 1;
        calls.push(`live-count-${String(liveCountProbe)}`);
        return liveCountProbe === 1 ? 1 : 0;
      },
    },
    targets: {
      ...common.targets,
      deleteHost: async () => {
        calls.push('delete-host');
        if (forcedFailure === 'deletion') {
          throw new Error('forced host deletion failure');
        }
      },
    },
  };

  return {
    calls,
    cleanup,
    contract: new PersistentVmHostLossContract(dependencies),
  };
}

describe('persistent VM host-loss contract', () => {
  test('host deletion and a cleared API ledger cannot replace native absence', async () => {
    const harness = createHostLossHarness('native-evidence');
    await expect(harness.contract.run('aws')).rejects.toThrow(
      'Native host absence is unavailable',
    );
    expect(harness.calls).toContain('delete-host');
    expect(harness.calls).not.toContain('substrate-absence');
    expect(harness.calls).not.toContain('release');
    expect(harness.calls).not.toContain(
      'artifact-persistent-vm-host-loss-result',
    );
    expect(harness.cleanup.observations()).toContainEqual({
      label: 'workload:vm-host-loss-aws-run',
      completed: false,
    });
  });
  test('owns deletion, terminal failure, ledger, event, and cleanup order', async () => {
    const harness = createHostLossHarness();

    await expect(harness.contract.run('aws')).resolves.toEqual({
      contract: 'persistent-vm-host-loss',
      qualification: 'conclusive',
      target: 'aws',
      satisfied: true,
    });
    expect(harness.calls).toEqual([
      'secret-create',
      'reserve',
      'submit',
      'credential',
      'cli-wait',
      'cli-exec',
      'wait-running',
      'capture-native-identities',
      'live-metadata',
      'live-count-1',
      'observe-running',
      'inspect',
      'ssh-container',
      'fixture-probe',
      'host-docker',
      'ssh-snapshot',
      'workspace-marker',
      'delete-host',
      'wait-failed',
      'wait-cleanup',
      'events-since',
      'live-count-2',
      'capture-native-identities',
      'substrate-absence',
      'secret-delete',
      'release',
      'artifact-persistent-vm-host-loss-result',
    ]);

    await harness.cleanup.run();
    expect(harness.calls).not.toContain('cleanup-workload');
    expect(harness.calls).not.toContain('cleanup-secret');
  });

  test('fails a host-loss cleanup that overruns the teardown budget', async () => {
    // Nothing else about the outcome is wrong here: the workload failed, the
    // cleanup record exists, its timestamps are ordered. Only the gap between
    // them is — and on a host the provider already deleted, there is nothing
    // left to wait for.
    const harness = createHostLossHarness('teardown-budget');

    await expect(harness.contract.run('aws')).rejects.toThrow(
      'host-loss cleanup must retire the workload within the teardown budget',
    );
  });

  test.each([
    ['deletion', 'forced host deletion failure'],
    ['provider-delay', 'forced provider confirmation timeout'],
    ['assertion', 'VM ledger gained or lost a row after its baseline'],
    ['cleanup', 'forced cleanup observation failure'],
    ['teardown-budget', 'within the teardown budget'],
  ] as const)(
    'keeps fixture cleanup armed after a %s failure',
    async (stage, message) => {
      const harness = createHostLossHarness(stage);

      await expect(harness.contract.run('aws')).rejects.toThrow(message);
      await harness.cleanup.run();

      expect(harness.calls.slice(-2)).toEqual([
        'cleanup-workload',
        'cleanup-secret',
      ]);
    },
  );
});
