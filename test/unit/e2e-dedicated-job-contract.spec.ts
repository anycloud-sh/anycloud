import { describe, expect, test } from 'vitest';
import { CloudType } from '../../src/shared/cloud.js';
import { WorkloadHealthStatus } from '../../src/shared/runtime.js';
import { WorkloadState, WorkloadType } from '../../src/shared/workload.js';
import {
  DedicatedJobContract,
  type DedicatedJobDependencies,
} from '../integration/e2e/internal/contracts/dedicated-job.js';
import { jobMemberProfile } from '../integration/e2e/internal/contracts/job-policy.js';
import { Environment } from '../integration/e2e/internal/environment.js';
import { Redactor } from '../integration/e2e/internal/artifacts.js';
import type {
  LocalJobConfiguration,
  LocalJobFixture,
} from '../integration/e2e/internal/targets/job-types.js';
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

function harness(
  options: {
    readonly configuration?: Partial<
      Record<keyof LocalJobConfiguration, boolean | undefined>
    >;
    readonly forced?: boolean;
    readonly nativeFailure?: boolean;
    readonly lateInputPresent?: boolean;
    readonly terminalBeforeActive?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const ref = trackedWorkloadRefForTest('job-held-contract');
  const member = { kind: 'local-held', target: 'local-smolvm' } as const;
  const environment = new Environment(
    { E2E_JOB_FORCE_CLEANUP: options.forced ? '1' : '' },
    new Redactor(),
  );
  const profile = jobMemberProfile(member, environment);
  const fixture: LocalJobFixture = {
    ref,
    profile,
    inputBucket: 'input',
    outputBucket: 'output',
    checkpointBucket: 'checkpoint',
    secretName: 'job-secret',
    secretDigest: 'digest',
    environmentFile: '/fixture/env',
    fileValue: 'file',
    overrideValue: 'override',
    stdoutMarker: 'out',
    stderrMarker: 'err',
  };
  let terminal = options.terminalBeforeActive ?? false;
  const status = () => ({
    status: WorkloadHealthStatus.Up,
    workload: persistentVmWorkload(ref.id, {
      workloadType: WorkloadType.Job,
      cloudProvider: CloudType.Local,
      region: 'local',
      vmType: 'local',
      state: terminal ? WorkloadState.Terminated : WorkloadState.Running,
      dockerCommand: 'docker run --env-file /run/anycloud-secrets/env',
      cleanedAt: terminal ? 3 : null,
    }),
    events: [
      {
        id: 1,
        workloadId: ref.id,
        createdAt: 1,
        state: WorkloadState.Syncing,
        metadata: null,
      },
    ],
    vms: [
      {
        cloudId: `ac-local-${ref.id}-0`,
        endedAt: terminal ? 3 : null,
        ip: 'localhost',
        sshHost: 'localhost',
        sshPort: 2222,
      },
    ],
  });
  const dependencies: DedicatedJobDependencies = {
    now: () => Date.now(),
    environment,
    names: { workload: () => ref.id },
    artifacts: { json: async (name) => name },
    vmLedger: {
      snapshot: (reference, value) =>
        snapshotStatusVmLedger(reference.id, value),
      liveEntries: liveStatusVmEntries,
    },
    wait: {
      for: async (_label, probe, settings) => {
        const value = await probe(Date.now() + settings.timeoutMs);
        const unmet = settings.unmet(value);
        if (unmet) throw new Error(unmet);
        return value;
      },
    },
    kernel: {
      status: async () => status(),
      requestTermination: async () => {
        calls.push('terminate');
        terminal = true;
      },
      waitForState: async () => status(),
      waitForCleanupRecorded: async () => {
        calls.push('persisted-cleanup');
        return cleanupRecordedForTest(ref, status());
      },
      recordLedgerCleared: (reference, count) => {
        expect(count).toBe(0);
        calls.push('ledger');
        return vmLedgerClearedForTest(reference);
      },
      release: async () => {
        calls.push('release');
      },
    },
    target: {
      prepareTerminal: async () => {
        throw new Error('Unexpected terminal member');
      },
      submitTerminal: async () => {
        throw new Error('Unexpected terminal member');
      },
      firstGenerationAbsence: async () => {
        throw new Error('Unexpected resubmission');
      },
      resubmit: async () => {
        throw new Error('Unexpected resubmission');
      },
      prepare: async () => {
        calls.push('prepare');
        return fixture;
      },
      submit: async () => {
        calls.push('submit');
      },
      attempts: async () => [
        {
          ref,
          rowId: 1,
          createdAt: 1,
          endedAt: terminal ? 3 : null,
          cloudId: `ac-local-${ref.id}-0`,
          ip: 'localhost',
          cloudProvider: CloudType.Local,
          credentialId: null,
          region: 'local',
          availabilityZone: null,
          vmType: 'local',
        },
      ],
      configuration: async () => {
        const observation = {
          workloadExec: true,
          environment: true,
          runtimeSecretFile: true,
          labels: true,
          dockerOptions: true,
          stdoutLogs: true,
          stderrLogs: true,
          hostExec: true,
          liveSecretFile: true,
          ...options.configuration,
        };
        return observation as LocalJobConfiguration;
      },
      storage: async () => ({
        output: `output-${ref.id}`,
        checkpoint: `checkpoint-${ref.id}`,
      }),
      lateInputRemainsAbsent: async () => !options.lateInputPresent,
      completedByCli: async () => ({
        waitSucceeded: true,
        statusFinished: true,
      }),
      nativeAbsence: async () => {
        calls.push('native-cleanup');
        if (options.nativeFailure)
          throw new Error('native inventory unavailable');
        return substrateAbsentForTest(ref);
      },
      releaseResources: async () => {
        calls.push('resources');
      },
    },
  };
  return { contract: new DedicatedJobContract(dependencies), calls, member };
}

describe('Local held Job family completion', () => {
  test('completes only after persisted cleanup, strict ledger and native absence, release, then resource cleanup', async () => {
    const world = harness();
    expect(await world.contract.run(world.member)).toEqual({
      contract: 'dedicated-job',
      member: world.member,
      target: 'local-smolvm',
      qualification: 'conclusive',
      satisfied: true,
    });
    expect(world.calls).toEqual([
      'prepare',
      'submit',
      'terminate',
      'persisted-cleanup',
      'native-cleanup',
      'ledger',
      'release',
      'resources',
    ]);
  });

  test.each([
    'workloadExec',
    'environment',
    'runtimeSecretFile',
    'labels',
    'dockerOptions',
    'stdoutLogs',
    'stderrLogs',
    'hostExec',
    'liveSecretFile',
  ] as const)(
    'missing %s evidence cannot reach the finalizer',
    async (name) => {
      const world = harness({ configuration: { [name]: undefined } });
      await expect(world.contract.run(world.member)).rejects.toThrow(name);
      expect(world.calls).toEqual(['prepare', 'submit']);
    },
  );

  test('terminal-only progress cannot satisfy live Local extensions', async () => {
    const world = harness({ terminalBeforeActive: true });
    await expect(world.contract.run(world.member)).rejects.toThrow(
      'require a live Job',
    );
    expect(world.calls).not.toContain('release');
  });

  test('continued input synchronization fails without authorizing completion', async () => {
    const world = harness({ lateInputPresent: true });
    await expect(world.contract.run(world.member)).rejects.toThrow(
      'continued synchronizing',
    );
    expect(world.calls).not.toContain('release');
  });

  test('the named forced failure leaves the live reference and resources for automatic teardown', async () => {
    const world = harness({ forced: true });
    await expect(world.contract.run(world.member)).rejects.toThrow(
      'E2E_JOB_FORCED_CLEANUP',
    );
    expect(world.calls).toEqual(['prepare', 'submit']);
  });

  test('native read errors cannot release either the reference or its resources', async () => {
    const world = harness({ nativeFailure: true });
    await expect(world.contract.run(world.member)).rejects.toThrow(
      'native inventory unavailable',
    );
    expect(world.calls).not.toContain('release');
    expect(world.calls).not.toContain('resources');
  });
});
