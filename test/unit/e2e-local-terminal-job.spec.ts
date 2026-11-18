import { describe, expect, test } from 'vitest';

import { CloudType } from '../../src/shared/cloud.js';
import { WorkloadHealthStatus } from '../../src/shared/runtime.js';
import { WorkloadState, WorkloadType } from '../../src/shared/workload.js';
import { Redactor } from '../integration/e2e/internal/artifacts.js';
import {
  DedicatedJobContract,
  type DedicatedJobDependencies,
} from '../integration/e2e/internal/contracts/dedicated-job.js';
import { Environment } from '../integration/e2e/internal/environment.js';
import type {
  JobFixture,
  JobNativeAttempt,
} from '../integration/e2e/internal/targets/job-types.js';
import type { StatusResponse } from '../integration/e2e/internal/types.js';
import {
  cleanupRecordedForTest,
  substrateAbsentForTest,
  trackedWorkloadRefForTest,
  vmLedgerClearedForTest,
} from './helpers/e2e.js';
import { persistentVmWorkload } from './helpers/persistent-vm-fixture.js';

function harness(
  kind: 'local-completed' | 'local-resubmitted',
  options: {
    terminalBeforeActive?: boolean;
    forced?: boolean;
    wrongExit?: boolean;
    missingTimestamp?: boolean;
    firstNativeFailure?: boolean;
    finalNativeFailure?: boolean;
    overwriteCompletion?: boolean;
    missingFirstHistory?: boolean;
    missingSecondHistory?: boolean;
    missingSecondEvent?: boolean;
    duplicateResubmission?: boolean;
    missingResubmission?: boolean;
    foreignResubmission?: boolean;
    earlyResubmission?: boolean;
    firstCleanupFailure?: boolean;
    resubmitFailure?: boolean;
    secondTerminalBeforeActive?: boolean;
    changedFirstHistory?: boolean;
    endedSecondAttempt?: boolean;
    multipleSecondAttempts?: boolean;
    staleFirstObservation?: boolean;
    secondWaitFailure?: 'timeout' | 'cancelled';
    forcedArtifactFailure?: boolean;
  } = {},
) {
  const ref = trackedWorkloadRefForTest('local-terminal-job');
  const member = { kind, target: 'local-smolvm' } as const;
  const calls: string[] = [];
  const budgets: { label: string; timeoutMs: number }[] = [];
  const records = new Map<string, unknown>();
  let generation = 1;
  let terminal = options.terminalBeforeActive ?? false;
  let cleaned = false;
  let released = false;
  let overwritten = false;
  const outcome =
    kind === 'local-completed'
      ? WorkloadState.Completed
      : WorkloadState.Errored;
  const status = (): StatusResponse => ({
    status: WorkloadHealthStatus.Up,
    workload: persistentVmWorkload(ref.id, {
      workloadType: WorkloadType.Job,
      cloudProvider: CloudType.Local,
      state: overwritten
        ? WorkloadState.Terminated
        : terminal || (generation === 2 && options.staleFirstObservation)
          ? outcome
          : WorkloadState.Running,
      completedAt:
        terminal && !options.missingTimestamp ? generation * 10 : null,
      cleanedAt: cleaned ? generation * 10 + 1 : null,
    }),
    events: [
      ...Array.from(
        {
          length:
            generation === 2 && options.staleFirstObservation
              ? 1
              : terminal
                ? generation -
                  (options.missingSecondEvent && generation === 2 ? 1 : 0)
                : generation - 1,
        },
        (_, index) => ({
          id: index + 1,
          workloadId: ref.id,
          createdAt: (index + 1) * 10,
          state: outcome,
          metadata: {
            exitCode: options.wrongExit
              ? 9
              : kind === 'local-completed'
                ? 0
                : 3,
          },
        }),
      ),
      ...Array.from(
        {
          length:
            generation === 2 && !options.missingResubmission
              ? options.duplicateResubmission
                ? 2
                : 1
              : 0,
        },
        (_, index) => ({
          id: 50 + index,
          workloadId: options.foreignResubmission ? 'foreign-job' : ref.id,
          createdAt: options.earlyResubmission ? 5 : 15 + index,
          state: WorkloadState.Queued,
          metadata: { reason: 'resubmitted' },
        }),
      ),
    ],
  });
  const attempts = (): JobNativeAttempt[] =>
    Array.from(
      {
        length:
          generation === 2 && options.multipleSecondAttempts ? 3 : generation,
      },
      (_, index): JobNativeAttempt => ({
        ref,
        rowId: index + 1,
        createdAt: index * 10 + 1,
        endedAt:
          index < generation - 1 ||
          cleaned ||
          (generation === 2 && index === 1 && options.endedSecondAttempt)
            ? (index + 1) * 10 + 1
            : null,
        cloudId: `ac-local-${ref.id}-${index}`,
        ip: 'localhost',
        cloudProvider: CloudType.Local,
        credentialId: null,
        region: 'local',
        availabilityZone: null,
        vmType:
          generation === 2 && index === 0 && options.changedFirstHistory
            ? 'changed'
            : 'local',
      }),
    ).filter(
      (attempt) =>
        !(
          generation === 2 &&
          ((options.missingFirstHistory && attempt.rowId === 1) ||
            ((options.missingSecondHistory || options.staleFirstObservation) &&
              attempt.rowId === 2))
        ),
    );
  const check = (fixture: JobFixture): void => {
    expect(fixture.ref).toBe(ref);
    expect(released).toBe(false);
  };
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected held-member operation');
  };
  const dependencies: DedicatedJobDependencies = {
    now: () => Date.now(),
    environment: new Environment(
      { E2E_JOB_FORCE_CLEANUP: options.forced ? '1' : '' },
      new Redactor(),
    ),
    names: { workload: () => ref.id },
    artifacts: {
      json: async (name, value) => {
        if (
          name.endsWith('-forced-resubmission') &&
          options.forcedArtifactFailure
        )
          throw new Error('resubmission evidence unavailable');
        records.set(name, value);
        return name;
      },
    },
    vmLedger: {
      snapshot: () => {
        throw new Error('Terminal policy does not require a live status VM');
      },
      liveEntries: () => [],
    },
    wait: {
      for: async (label, probe, settings) => {
        budgets.push({ label, timeoutMs: settings.timeoutMs });
        if (label === 'same-ID Job second errored generation') {
          if (options.secondWaitFailure)
            throw new Error(`second-generation ${options.secondWaitFailure}`);
          if (!options.forced) terminal = true;
        }
        const value = await probe(Date.now() + settings.timeoutMs);
        const unmet = settings.unmet(value);
        if (unmet) throw new Error(unmet);
        return value;
      },
    },
    kernel: {
      status: async () => status(),
      waitForState: async () => {
        terminal = true;
        return status();
      },
      requestTermination: async () => {
        calls.push('terminate-completed');
        overwritten = options.overwriteCompletion ?? false;
      },
      waitForCleanupRecorded: async () => {
        expect(released).toBe(false);
        calls.push(`cleanup-${generation}`);
        if (generation === 1 && options.firstCleanupFailure)
          throw new Error('first persisted cleanup unavailable');
        cleaned = true;
        return cleanupRecordedForTest(ref, status());
      },
      recordLedgerCleared: (reference, count) => {
        expect(reference).toBe(ref);
        expect(count).toBe(0);
        return vmLedgerClearedForTest(ref);
      },
      release: async () => {
        expect(released).toBe(false);
        released = true;
        calls.push('release');
      },
    },
    target: {
      prepare: unexpected,
      submit: unexpected,
      configuration: unexpected,
      storage: unexpected,
      lateInputRemainsAbsent: unexpected,
      completedByCli: async (fixture) => {
        check(fixture);
        calls.push('cli-completion');
        return { waitSucceeded: true, statusFinished: true };
      },
      prepareTerminal: async (_id, profile) => {
        calls.push('reserve');
        return { ref, profile };
      },
      submitTerminal: async (fixture) => {
        check(fixture);
        calls.push('submit');
      },
      attempts: async (fixture) => {
        check(fixture);
        return attempts();
      },
      firstGenerationAbsence: async (fixture) => {
        check(fixture);
        expect(cleaned).toBe(true);
        calls.push('native-generation-1');
        if (options.firstNativeFailure)
          throw new Error('first native inventory unavailable');
      },
      resubmit: async (fixture) => {
        check(fixture);
        expect(calls.at(-1)).toBe('native-generation-1');
        calls.push('resubmit');
        if (options.resubmitFailure) throw new Error('resubmission reply lost');
        generation = 2;
        terminal =
          options.secondTerminalBeforeActive ??
          options.terminalBeforeActive ??
          false;
        cleaned = false;
      },
      nativeAbsence: async (fixture) => {
        check(fixture);
        calls.push('native-final');
        if (options.finalNativeFailure)
          throw new Error('final native inventory unavailable');
        return substrateAbsentForTest(ref);
      },
      releaseResources: async (fixture) => {
        expect(fixture.ref).toBe(ref);
        expect(released).toBe(true);
        calls.push('resources');
      },
    },
  };
  return {
    contract: new DedicatedJobContract(dependencies),
    member,
    calls,
    budgets,
    records,
  };
}

describe('Local terminal Job family', () => {
  test.each([false, true])(
    'preserves natural completion and rejects an outcome change after termination (terminal before active: %s)',
    async (terminalBeforeActive) => {
      const world = harness('local-completed', { terminalBeforeActive });
      expect(await world.contract.run(world.member)).toMatchObject({
        satisfied: true,
        member: world.member,
      });
      expect(world.calls).toEqual([
        'reserve',
        'submit',
        'cleanup-1',
        'native-final',
        'cli-completion',
        'terminate-completed',
        'release',
        'resources',
      ]);
      expect(world.records.get('dedicated-job-result')).toMatchObject({
        generation: 1,
      });
    },
  );

  test.each([
    ['wrongExit', 'exitCode 0'],
    ['missingTimestamp', 'outcome timestamp'],
    ['overwriteCompletion', 'exitCode 0'],
    ['finalNativeFailure', 'final native inventory'],
  ] as const)(
    'keeps fallback cleanup armed after %s',
    async (option, message) => {
      const world = harness('local-completed', { [option]: true });
      await expect(world.contract.run(world.member)).rejects.toThrow(message);
      expect(world.calls).not.toContain('release');
      expect(world.records.has('dedicated-job-result')).toBe(false);
    },
  );

  test.each([false, true])(
    'retains one reference through both errored generations (terminal before active: %s)',
    async (terminalBeforeActive) => {
      const world = harness('local-resubmitted', { terminalBeforeActive });
      await expect(world.contract.run(world.member)).resolves.toMatchObject({
        satisfied: true,
      });
      expect(world.calls).toEqual([
        'reserve',
        'submit',
        'cleanup-1',
        'native-generation-1',
        'resubmit',
        'cleanup-2',
        'native-final',
        'release',
        'resources',
      ]);
      expect(
        world.records.get('job-local-terminal-job-pre-resubmission'),
      ).toMatchObject({ generation: 1, referenceReleased: false });
      expect(
        world.records.get('job-local-terminal-job-post-resubmission'),
      ).toMatchObject({
        generation: 2,
        erroredEvents: 2,
        resubmittedEvents: 1,
      });
      expect(world.records.get('dedicated-job-result')).toMatchObject({
        generation: 2,
      });
    },
  );

  test('does not send resubmit or release when first-generation native cleanup fails', async () => {
    const world = harness('local-resubmitted', { firstNativeFailure: true });
    await expect(world.contract.run(world.member)).rejects.toThrow(
      'first native inventory',
    );
    expect(world.calls).not.toContain('resubmit');
    expect(world.calls).not.toContain('release');
  });

  test.each([
    ['missingFirstHistory', 'both native attempt generations'],
    ['missingSecondHistory', 'both native attempt generations'],
    ['missingSecondEvent', 'second errored event missing'],
    ['duplicateResubmission', 'exactly one resubmission'],
    ['finalNativeFailure', 'final native inventory'],
  ] as const)('cannot complete after %s', async (option, message) => {
    const world = harness('local-resubmitted', { [option]: true });
    await expect(world.contract.run(world.member)).rejects.toThrow(message);
    expect(world.calls).not.toContain('release');
    expect(world.records.has('dedicated-job-result')).toBe(false);
  });

  test('forces completed cleanup only with live resources', async () => {
    const world = harness('local-completed', { forced: true });
    await expect(world.contract.run(world.member)).rejects.toThrow(
      'E2E_JOB_FORCED_CLEANUP',
    );
    expect(world.calls).toEqual(['reserve', 'submit']);
    const ended = harness('local-completed', {
      forced: true,
      terminalBeforeActive: true,
    });
    await expect(ended.contract.run(ended.member)).rejects.toThrow(
      'requires a live Job',
    );
    expect(ended.calls).not.toContain('release');
  });

  test.each([false, true])(
    'forces resubmission cleanup only after a live second generation (first terminal before active: %s)',
    async (terminalBeforeActive) => {
      const world = harness('local-resubmitted', {
        forced: true,
        terminalBeforeActive,
        secondTerminalBeforeActive: false,
      });
      await expect(world.contract.run(world.member)).rejects.toThrow(
        'E2E_JOB_FORCED_CLEANUP: local-resubmitted after second-generation active baseline',
      );
      expect(world.calls).toEqual([
        'reserve',
        'submit',
        'cleanup-1',
        'native-generation-1',
        'resubmit',
      ]);
      expect(world.budgets).toContainEqual({
        label: 'same-ID Job second errored generation',
        timeoutMs: 300_000,
      });
      expect(
        world.records.get('job-local-terminal-job-forced-resubmission'),
      ).toMatchObject({
        generation: 2,
        previousGeneration: 1,
        expectedFailure: true,
        point: 'second-generation-active-before-finalization',
        progress: { kind: 'active', state: WorkloadState.Running },
        originalAttempts: [{ rowId: 1, endedAt: 11 }],
        currentAttempts: [
          { rowId: 1, endedAt: 11 },
          { rowId: 2, endedAt: null },
        ],
        liveAttempt: { rowId: 2, endedAt: null },
        resubmissionEvent: {
          workloadId: 'local-terminal-job',
          id: 50,
          createdAt: 15,
        },
        referenceReleased: false,
      });
      expect(
        world.records.has('job-local-terminal-job-post-resubmission'),
      ).toBe(false);
      expect(world.records.has('dedicated-job-result')).toBe(false);
    },
  );

  test.each([
    ['missingFirstHistory', 'original ended history'],
    ['changedFirstHistory', 'original ended history'],
    ['missingSecondHistory', 'requires a live Job'],
    ['endedSecondAttempt', 'exactly one live attempt'],
    ['multipleSecondAttempts', 'exactly one live attempt'],
    ['missingResubmission', 'exactly one own resubmission event'],
    ['duplicateResubmission', 'exactly one own resubmission event'],
    ['foreignResubmission', 'exactly one own resubmission event'],
    ['earlyResubmission', 'exactly one own resubmission event'],
    ['staleFirstObservation', 'second errored event missing'],
    ['secondTerminalBeforeActive', 'requires a live Job'],
    ['forcedArtifactFailure', 'resubmission evidence unavailable'],
  ] as const)(
    'does not certify a forced resubmission after %s',
    async (option, message) => {
      const world = harness('local-resubmitted', {
        forced: true,
        [option]: true,
      });
      await expect(world.contract.run(world.member)).rejects.toThrow(message);
      expect(world.calls.filter((call) => call === 'resubmit')).toHaveLength(1);
      expect(world.calls).not.toContain('release');
      expect(
        world.records.has('job-local-terminal-job-forced-resubmission'),
      ).toBe(false);
      expect(world.records.has('dedicated-job-result')).toBe(false);
    },
  );

  test.each([
    ['firstCleanupFailure', 'first persisted cleanup unavailable'],
    ['firstNativeFailure', 'first native inventory unavailable'],
    ['resubmitFailure', 'resubmission reply lost'],
  ] as const)(
    'retains the original reference without replay after %s',
    async (option, message) => {
      const world = harness('local-resubmitted', {
        forced: true,
        [option]: true,
      });
      await expect(world.contract.run(world.member)).rejects.toThrow(message);
      expect(world.calls.filter((call) => call === 'resubmit')).toHaveLength(
        option === 'resubmitFailure' ? 1 : 0,
      );
      expect(world.calls).not.toContain('release');
      expect(
        world.records.has('job-local-terminal-job-forced-resubmission'),
      ).toBe(false);
      expect(world.records.has('dedicated-job-result')).toBe(false);
    },
  );

  test.each(['timeout', 'cancelled'] as const)(
    'does not certify a forced resubmission after second-generation %s',
    async (secondWaitFailure) => {
      const world = harness('local-resubmitted', {
        forced: true,
        secondWaitFailure,
      });
      await expect(world.contract.run(world.member)).rejects.toThrow(
        `second-generation ${secondWaitFailure}`,
      );
      expect(world.calls.filter((call) => call === 'resubmit')).toHaveLength(1);
      expect(world.calls).not.toContain('release');
      expect(
        world.records.has('job-local-terminal-job-forced-resubmission'),
      ).toBe(false);
      expect(world.records.has('dedicated-job-result')).toBe(false);
    },
  );
});
