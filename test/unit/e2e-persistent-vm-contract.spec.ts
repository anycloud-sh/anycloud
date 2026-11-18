import type { TrackedWorkloadRef } from '../integration/e2e/internal/workloads.js';
import { describe, expect, test } from 'vitest';

import type {
  WorkloadEvent,
  WorkloadStatusResponse as StatusResponse,
} from '../../src/shared/api-contract/workload-management-schemas.js';
import { CloudType } from '../../src/shared/cloud.js';
import { WorkloadState } from '../../src/shared/workload.js';
import { WorkloadHealthStatus } from '../../src/shared/runtime.js';
import {
  PersistentVmContract,
  type PersistentVmContractDependencies,
} from '../integration/e2e/internal/contracts/persistent-vm.js';
import type { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import type { PersistentVmRunningContext } from '../integration/e2e/internal/targets/persistent-vm-types.js';
import type { LiveVmMetadata } from '../integration/e2e/internal/types.js';
import {
  cleanupRecordedForTest,
  vmLedgerClearedForTest,
} from './helpers/e2e.js';
import {
  createPersistentVmFixture,
  persistentVmWorkload,
} from './helpers/persistent-vm-fixture.js';

interface ContractHarness {
  readonly calls: string[];
  readonly cleanup: CleanupStack;
  readonly contract: PersistentVmContract;
  readonly observedRunningContexts: PersistentVmRunningContext[];
}

function runningEvent(workloadId: string): WorkloadEvent {
  return {
    id: 1,
    workloadId,
    state: WorkloadState.Running,
    metadata: null,
    createdAt: 1,
  };
}

function runningStatus(
  workloadId: string,
  sshPort: number | null = 2222,
  availabilityZone?: string,
): StatusResponse {
  return {
    workload: persistentVmWorkload(workloadId),
    events: [runningEvent(workloadId)],
    status: WorkloadHealthStatus.Up,
    vms: [
      {
        cloudId: 'cloud-vm-1',
        endedAt: null,
        ip: '127.0.0.1',
        sshHost: '127.0.0.1',
        ...(sshPort === null ? {} : { sshPort }),
        ...(availabilityZone === undefined ? {} : { availabilityZone }),
      },
    ],
  };
}

function terminatedStatus(
  workloadId: string,
  sshPort: number | null = 2222,
  availabilityZone?: string,
  cleanedAt = 110,
): StatusResponse {
  const running = runningStatus(workloadId, sshPort, availabilityZone);
  return {
    ...running,
    workload: {
      ...running.workload,
      cleanedAt,
      completedAt: 100,
      state: WorkloadState.Terminated,
      vmCount: 0,
    },
    events: [
      ...running.events,
      {
        id: 2,
        workloadId,
        state: WorkloadState.Terminated,
        metadata: null,
        createdAt: 100,
      },
    ],
    vms: running.vms?.map((vm) => ({ ...vm, endedAt: cleanedAt })),
  };
}

type ForcedFailure =
  | 'exec-after-wait'
  | 'wait-not-ready'
  | 'host-release'
  | 'mismatched-vm-metadata'
  | 'missing-secret'
  | 'runtime'
  | 'stopped-container'
  | 'submission'
  | 'teardown-budget'
  | 'teardown-budget-unset'
  | 'inconclusive-termination'
  | 'termination-observation';

function createContractHarness({
  forcedFailure,
  omitDefaultSshFields = false,
  activeAvailabilityZone,
  target = 'aws',
  metadata,
  repairedMetadata,
  inspection,
  ghcrFiles,
}: {
  /** GHCR credential files the host reports at each check; enables GHCR auth. */
  readonly ghcrFiles?: string[][];
  readonly forcedFailure?: ForcedFailure;
  readonly omitDefaultSshFields?: boolean;
  readonly activeAvailabilityZone?: string;
  readonly target?: 'aws' | 'local-smolvm';
  readonly metadata?: Partial<LiveVmMetadata>;
  readonly repairedMetadata?: Partial<LiveVmMetadata>;
  readonly inspection?: Parameters<typeof createPersistentVmFixture>[1];
} = {}): ContractHarness {
  const workloadId = `vm-${target}-run`;
  const cloudId =
    target === 'local-smolvm' ? `ac-local-${workloadId}-0` : 'cloud-vm-1';
  const sshHost = target === 'local-smolvm' ? 'localhost' : '127.0.0.1';
  const provider = {
    aws: CloudType.AWS,
    'local-smolvm': CloudType.Local,
  }[target];
  const forTarget = (status: StatusResponse): StatusResponse => ({
    ...status,
    workload: { ...status.workload, cloudProvider: provider },
    vms: status.vms?.map((vm) => ({ ...vm, cloudId, ip: sshHost, sshHost })),
  });
  const {
    calls,
    cleanup,
    dependencies: common,
    observedRunningContexts,
  } = createPersistentVmFixture(workloadId, {
    sshHost,
    sshDefaults: omitDefaultSshFields ? {} : undefined,
    inspection: { running: forcedFailure !== 'stopped-container' },
    fixtureObservation: {
      secretPresent: forcedFailure !== 'missing-secret',
      secretDigestMatches: forcedFailure !== 'missing-secret',
    },
    liveVmMetadata: {
      cloudId:
        forcedFailure === 'mismatched-vm-metadata'
          ? 'unrelated-cloud-vm'
          : cloudId,
      baseImageId: null,
      ...metadata,
    },
    ...inspection,
  });
  let liveCountProbe = 0;
  let metadataProbe = 0;
  let hostReleaseProbe = 0;
  const { teardownMaxMs, ...timeouts } = common.policy('aws');

  const dependencies: PersistentVmContractDependencies = {
    ...common,
    environment: {
      optional: (name, fallback = '') =>
        ghcrFiles && name === 'ANYCLOUD_E2E_GHCR_AUTH' ? 'true' : fallback,
    },
    vmReadyByCli: async (id, timeoutMs) => {
      const ready = await common.vmReadyByCli(id, timeoutMs);
      if (forcedFailure === 'wait-not-ready') {
        return { waitReady: false, execAfterWait: false };
      }
      return forcedFailure === 'exec-after-wait'
        ? { ...ready, execAfterWait: false }
        : ready;
    },
    hostIdentity: {
      capture: async (_label, endpoint) => {
        calls.push('capture-host-identity');
        return {
          version: 1,
          endpoint,
          fingerprints: ['ssh-ed25519 SHA256:original'],
          capturedAt: 1,
        };
      },
      observe: async () => {
        hostReleaseProbe += 1;
        calls.push('release-host-identity');
        if (forcedFailure === 'host-release') {
          throw new Error('forced host release failure');
        }
        return {
          kind: 'unreachable',
          reason: 'connection-refused',
          observedAt: hostReleaseProbe + 1,
        };
      },
    },
    kernel: {
      ...common.kernel,
      requestTermination: async () => {
        calls.push('request-termination');
      },
      status: async (ref) => {
        calls.push('status');
        return forTarget(
          runningStatus(
            ref.id,
            omitDefaultSshFields ? null : 2222,
            activeAvailabilityZone,
          ),
        );
      },
      waitForCleanupRecorded: async (ref) => {
        calls.push('wait-cleanup');
        return cleanupRecordedForTest(
          ref,
          forTarget(
            terminatedStatus(
              ref.id,
              omitDefaultSshFields ? null : 2222,
              activeAvailabilityZone,
              // completedAt is 100 and the budget is 1_000, so this is a teardown
              // that finished — just far too late to call the VM released.
              forcedFailure === 'teardown-budget' ||
                forcedFailure === 'teardown-budget-unset'
                ? 5_000
                : 110,
            ),
          ),
        );
      },
      waitForState: async (ref, state) => {
        calls.push(`wait-${state}`);
        return forTarget(
          state === WorkloadState.Running
            ? runningStatus(
                ref.id,
                omitDefaultSshFields ? null : 2222,
                activeAvailabilityZone,
              )
            : terminatedStatus(
                ref.id,
                omitDefaultSshFields ? null : 2222,
                activeAvailabilityZone,
              ),
        );
      },
    },
    vmLedger: {
      ...common.vmLedger,
      liveVmMetadata: async (ref) => {
        const current = await common.vmLedger.liveVmMetadata(ref);
        metadataProbe += 1;
        return metadataProbe === 1
          ? current
          : { ...current, ...repairedMetadata };
      },
      assertCleared: async (ref: TrackedWorkloadRef) => {
        calls.push(`live-count-${String((liveCountProbe += 1))}`);
        return vmLedgerClearedForTest(ref);
      },
      liveVmCount: async () => {
        liveCountProbe += 1;
        calls.push(`live-count-${String(liveCountProbe)}`);
        return liveCountProbe < 3 ? 1 : 0;
      },
    },
    targets: {
      ...common.targets,
      profile: () => ({
        target,
        provider,
        ...(target === 'aws' ? { credentialName: 'aws-test' } : {}),
      }),
      observeRunning: async (...args) => {
        const observed = await common.targets.observeRunning(...args);
        if (target === 'local-smolvm')
          return {
            kind: 'observed',
            observation: {
              kind: 'local-smolvm',
              machineCount: 1,
              machineName: cloudId,
              machineState: 'running',
              portCount: 1,
              sshGuestPort: 22,
              sshHostPort: omitDefaultSshFields ? 22 : 2222,
            },
          };
        return observed;
      },
      observeTerminated: async () => {
        calls.push('observe-terminated');
        if (target === 'local-smolvm')
          return {
            kind: 'observed',
            observation: { kind: 'local-smolvm', remainingMachineCount: 0 },
          };
        return {
          kind: 'observed',
          observation: {
            kind: 'provider-api',
            // A host the provider still reports is a hard rejection, not a
            // retryable answer: polling it would bill a leaked VM until the
            // deadline and then report the run as merely inconclusive.
            outcome:
              forcedFailure === 'termination-observation'
                ? 'present'
                : forcedFailure === 'inconclusive-termination'
                  ? 'inconclusive'
                  : 'terminated',
            provider: CloudType.AWS,
          },
        };
      },
    },
    submitPersistentVm: async (...args) => {
      await common.submitPersistentVm(...args);
      if (forcedFailure === 'submission') {
        throw new Error('forced submission failure');
      }
    },
    vm: {
      ...common.vm,
      inspectWorkload: async (...args) => {
        const inspection = await common.vm.inspectWorkload(...args);
        if (forcedFailure === 'runtime') {
          throw new Error('forced runtime failure');
        }
        return inspection;
      },
      removeWorkload: async () => {
        calls.push('remove-workload');
      },
      ghcrCredentialFiles: async () => {
        calls.push('ghcr-files');
        return ghcrFiles?.shift() ?? [];
      },
      seedLegacyGhcrLoginAndRemoveWorkload: async () => {
        calls.push('seed-legacy-ghcr-and-remove-workload');
      },
      waitForRepair: async () => {
        calls.push('repair');
        return 'new-container-id';
      },
      workloadContainerId: async () => {
        calls.push('container-id');
        return 'old-container-id';
      },
    },
    policy: () => ({
      ...timeouts,
      ...(forcedFailure === 'teardown-budget-unset' ? {} : { teardownMaxMs }),
      ...(target === 'local-smolvm'
        ? {}
        : {
            terminatedObservation: {
              intervalMs: 1,
              timeoutMs:
                forcedFailure === 'inconclusive-termination' ? 10 : 1_000,
            },
          }),
    }),
  };

  return {
    calls,
    cleanup,
    contract: new PersistentVmContract(dependencies),
    observedRunningContexts,
  };
}

describe('persistent VM contract runner', () => {
  test('accepts matching fresh local-smolvm database and native metadata at both checkpoints', async () => {
    const target = 'local-smolvm';
    const harness = createContractHarness({
      target,
      omitDefaultSshFields: true,
    });
    await expect(harness.contract.run(target)).resolves.toMatchObject({
      satisfied: true,
    });
    expect(
      harness.calls.filter((call) => call === 'live-metadata'),
    ).toHaveLength(2);
    expect(harness.observedRunningContexts).toHaveLength(2);
    await harness.cleanup.run();
    expect(harness.calls).not.toContain('cleanup-workload');
  });

  const databaseDrifts = [
    {
      field: 'SSH host',
      metadata: { sshHost: 'foreign.example.test' },
    },
    { field: 'SSH port', metadata: { sshPort: 2200 } },
    { field: 'SSH username', metadata: { sshUsername: 'nobody' } },
  ].map((drift) => ({ ...drift, target: 'local-smolvm' as const }));
  test.each(
    databaseDrifts.flatMap((drift) => [
      { ...drift, phase: 'initial' as const },
      { ...drift, phase: 'repair' as const },
    ]),
  )(
    'rejects independent $target database $field drift at $phase and retains cleanup',
    async ({ target, metadata, phase }) => {
      const harness = createContractHarness({
        target,
        ...(phase === 'initial'
          ? { metadata }
          : { repairedMetadata: metadata }),
      });
      // API status and native observations remain unchanged in this fixture.
      await expect(harness.contract.run(target)).rejects.toThrow(
        'database SSH metadata',
      );
      expect(harness.calls).not.toContain('release');
      expect(harness.calls).not.toContain('substrate-absence');
      expect(harness.calls).not.toContain('artifact-persistent-vm-result');
      expect(
        harness.calls.filter((call) => call === 'live-metadata'),
      ).toHaveLength(phase === 'initial' ? 1 : 2);
      expect(harness.cleanup.observations()).toContainEqual({
        label: `workload:vm-${target}-run`,
        completed: false,
      });
      await harness.cleanup.run();
      expect(harness.calls.slice(-2)).toEqual([
        'cleanup-workload',
        'cleanup-secret',
      ]);
    },
  );

  test.each([
    {
      inspection: { args: ['-c', 'exit 0'] },
      message: 'entrypoint and arguments are incorrect',
    },
    { inspection: { user: 'nobody' }, message: 'image-default user' },
    {
      inspection: { publishedPortCount: 1 },
      message: 'publish no workload ports',
    },
  ])(
    'rejects valid but incorrect inspection $inspection',
    async ({ inspection, message }) => {
      const harness = createContractHarness({ inspection: { inspection } });
      await expect(harness.contract.run('aws')).rejects.toThrow(message);
      await harness.cleanup.run();
      expect(harness.calls.slice(-2)).toEqual([
        'cleanup-workload',
        'cleanup-secret',
      ]);
    },
  );

  test('inconclusive termination cannot mint an absence proof or release tracking', async () => {
    const harness = createContractHarness({
      forcedFailure: 'inconclusive-termination',
    });
    await expect(harness.contract.run('aws')).rejects.toThrow(
      'inconclusive termination cannot establish native absence or release tracking',
    );
    expect(harness.calls).not.toContain('substrate-absence');
    expect(harness.calls).not.toContain('release');
    expect(harness.calls).not.toContain('artifact-persistent-vm-result');
    expect(harness.cleanup.observations()).toContainEqual({
      label: 'workload:vm-aws-run',
      completed: false,
    });
  });
  test('owns the common lifecycle order and returns one typed completion result', async () => {
    const harness = createContractHarness();

    await expect(harness.contract.run('aws')).resolves.toEqual({
      contract: 'persistent-vm',
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
      'container-id',
      'remove-workload',
      'repair',
      'inspect',
      'fixture-probe',
      'status',
      'capture-native-identities',
      'live-metadata',
      'live-count-2',
      'observe-running',
      'capture-host-identity',
      'request-termination',
      'wait-terminated',
      'wait-cleanup',
      'live-count-3',
      'observe-terminated',
      'artifact-aws-terminated-observation',
      'capture-native-identities',
      'substrate-absence',
      'release-host-identity',
      'release-host-identity',
      'artifact-vm-aws-run-ssh-host-release',
      'secret-delete',
      'release',
      'artifact-persistent-vm-result',
    ]);

    await harness.cleanup.run();
    expect(harness.calls).not.toContain('cleanup-workload');
    expect(harness.calls).not.toContain('cleanup-secret');
  });

  test.each([
    {
      failure: 'wait-not-ready',
      message: 'anycloud wait did not report the VM ready',
      lastStep: 'capture-native-identities',
    },
    {
      failure: 'exec-after-wait',
      message: 'anycloud exec failed right after anycloud wait returned',
      lastStep: 'capture-native-identities',
    },
    {
      failure: 'mismatched-vm-metadata',
      message: 'live VM metadata must identify the active VM',
      lastStep: 'live-metadata',
    },
    {
      failure: 'stopped-container',
      message: 'workload container is not running',
      lastStep: 'inspect',
    },
    {
      failure: 'missing-secret',
      message: 'workload did not preserve its environment and named secret',
      lastStep: 'fixture-probe',
    },
  ] as const)(
    'rejects $failure observations before later steps and keeps cleanup armed',
    async ({ failure, message, lastStep }) => {
      const harness = createContractHarness({ forcedFailure: failure });
      const provisioningSteps = [
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
      ];
      const expectedSteps = provisioningSteps.slice(
        0,
        provisioningSteps.indexOf(lastStep) + 1,
      );

      await expect(harness.contract.run('aws')).rejects.toThrow(
        `Persistent VM contract: ${message}`,
      );
      expect(harness.calls).toEqual(expectedSteps);
      expect(harness.cleanup.observations()).toEqual([
        { label: 'secret:vm-aws-secret-run', completed: false },
        { label: 'workload:vm-aws-run', completed: false },
      ]);

      await harness.cleanup.run();

      expect(harness.calls).toEqual([
        ...expectedSteps,
        'cleanup-workload',
        'cleanup-secret',
      ]);
      expect(harness.cleanup.observations()).toEqual([
        { label: 'secret:vm-aws-secret-run', completed: true },
        { label: 'workload:vm-aws-run', completed: true },
      ]);
    },
  );

  test('checks for GHCR credentials around a repair that re-pulls a private image', async () => {
    const harness = createContractHarness({ ghcrFiles: [[], []] });

    await expect(harness.contract.run('aws')).resolves.toMatchObject({
      satisfied: true,
    });
    const repair = harness.calls.indexOf('repair');
    expect(harness.calls.slice(repair - 3, repair + 2)).toEqual([
      'container-id',
      'ghcr-files',
      'seed-legacy-ghcr-and-remove-workload',
      'repair',
      'ghcr-files',
    ]);
  });

  test.each([
    [[['/root/.docker/config.json']], 'the private GHCR pull'],
    [[[], ['/root/.docker/config.json']], 'the repair pull'],
  ])(
    'fails when a GHCR credential remains on the host',
    async (files, pull) => {
      const harness = createContractHarness({ ghcrFiles: files });

      await expect(harness.contract.run('aws')).rejects.toThrow(
        `${pull} left a GHCR credential on the host: /root/.docker/config.json`,
      );
    },
  );

  test('normalizes omitted SSH port and username to product defaults', async () => {
    const harness = createContractHarness({ omitDefaultSshFields: true });

    await expect(harness.contract.run('aws')).resolves.toMatchObject({
      contract: 'persistent-vm',
      qualification: 'conclusive',
      target: 'aws',
      satisfied: true,
    });
  });

  test("uses the active VM's concrete availability zone", async () => {
    const harness = createContractHarness({ activeAvailabilityZone: 'b' });

    await expect(harness.contract.run('aws')).resolves.toMatchObject({
      satisfied: true,
    });
    expect(harness.observedRunningContexts).toHaveLength(2);
    expect(
      harness.observedRunningContexts.map(
        (context) => context.availabilityZone,
      ),
    ).toEqual(['b', 'b']);
  });

  test('leaves automatic cleanup armed in LIFO order when submission fails', async () => {
    const harness = createContractHarness({ forcedFailure: 'submission' });

    await expect(harness.contract.run('aws')).rejects.toThrow(
      'forced submission failure',
    );
    await harness.cleanup.run();

    expect(harness.calls).toEqual([
      'secret-create',
      'reserve',
      'submit',
      'cleanup-workload',
      'cleanup-secret',
    ]);
  });

  test('fails a teardown that completes but overruns the budget', async () => {
    // Everything the contract already checked still holds here — terminal
    // outcome recorded, cleanup recorded, timestamps ordered, no live VM rows.
    // Only the gap between them is wrong, which is exactly the shape of the
    // Lambda regression: teardown that arrives, minutes of billed GPU late.
    const harness = createContractHarness({ forcedFailure: 'teardown-budget' });

    await expect(harness.contract.run('aws')).rejects.toThrow(
      'termination must release the provider VM within the teardown budget',
    );
  });

  test('ignores an overrun on a target that opted out of the budget', async () => {
    // Same slow teardown as above, with teardownMaxMs absent. cleanedAt lands
    // after networking teardown, so a bound meaningful on Lambda is a false
    // failure on providers whose firewall and VNet deletion retries for
    // minutes — absent has to mean unasserted, not zero.
    const harness = createContractHarness({
      forcedFailure: 'teardown-budget-unset',
    });

    await expect(harness.contract.run('aws')).resolves.toMatchObject({
      satisfied: true,
    });
  });

  test.each([
    ['runtime', 'forced runtime failure'],
    ['termination-observation', 'aws still reports cloud-vm-1 present'],
    ['host-release', 'forced host release failure'],
  ] as const)(
    'keeps workload and secret cleanup armed after a %s failure',
    async (stage, message) => {
      const harness = createContractHarness({ forcedFailure: stage });

      await expect(harness.contract.run('aws')).rejects.toThrow(message);
      await harness.cleanup.run();

      expect(harness.calls.slice(-2)).toEqual([
        'cleanup-workload',
        'cleanup-secret',
      ]);
    },
  );
});
