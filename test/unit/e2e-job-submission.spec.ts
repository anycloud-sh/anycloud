import { describe, expect, test, vi } from 'vitest';
import { CloudType } from '../../src/shared/cloud.js';
import {
  submitJob,
  resubmitJob,
} from '../integration/e2e/internal/job-submission.js';
import { JobNativeCleanup } from '../integration/e2e/internal/job-native-cleanup.js';
import type { JobNativeAttempt } from '../integration/e2e/internal/targets/job-types.js';
import { Waiter } from '../integration/e2e/internal/wait.js';
import type { WorkloadMutationTransport } from '../integration/e2e/internal/workload-mutations.js';
import {
  commandResultForTest,
  trackedWorkloadRefForTest,
} from './helpers/e2e.js';

describe('Job creation inventory fence', () => {
  test('cannot send until the independent pre-send inventory resolves', async () => {
    const calls: string[] = [];
    let resolveFence: () => void = () => {
      throw new Error('Fence not installed');
    };
    const fence = new Promise<void>((resolve) => {
      resolveFence = resolve;
    });
    const ref = trackedWorkloadRefForTest('job-fence');
    const submission = submitJob(ref, ['job', '--id', ref.id, 'busybox:1.36'], {
      native: {
        creationStarted: async () => {
          calls.push('fence');
          await fence;
        },
        capture: async () => {
          calls.push('capture');
          return [];
        },
      },
      mutations: {
        runCliCreate: async () => {
          calls.push('send');
          return commandResultForTest();
        },
      },
    });
    expect(calls).toEqual(['fence']);
    resolveFence();
    await submission;
    expect(calls).toEqual(['fence', 'send', 'capture']);
  });

  test('a failed inventory cannot send any mutation', async () => {
    let sent = false;
    await expect(
      submitJob(trackedWorkloadRefForTest('job-fence'), [], {
        native: {
          creationStarted: async () => {
            throw new Error('inventory unavailable');
          },
          capture: async () => [],
        },
        mutations: {
          runCliCreate: async () => {
            sent = true;
            return commandResultForTest();
          },
        },
      }),
    ).rejects.toThrow('inventory unavailable');
    expect(sent).toBe(false);
  });

  test('lost replies retain the post-send inventory and do not trigger another send', async () => {
    const calls: string[] = [];
    const primary = new Error('lost response');
    const secondary = new Error('inventory read failed');
    const execution = submitJob(trackedWorkloadRefForTest('job-lost'), [], {
      native: {
        creationStarted: async () => {
          calls.push('fence');
        },
        capture: async () => {
          calls.push('capture');
          throw secondary;
        },
      },
      mutations: {
        runCliCreate: async () => {
          calls.push('send');
          throw primary;
        },
      },
    });
    await expect(execution).rejects.toMatchObject({
      errors: [primary, secondary],
    });
    expect(calls).toEqual(['fence', 'send', 'capture']);
  });
});

async function resubmissionWorld() {
  const ref = trackedWorkloadRefForTest('job-resubmission');
  let rows: readonly JobNativeAttempt[] = [];
  let barrier: Promise<void> | undefined;
  const calls: string[] = [];
  const artifacts: unknown[] = [];
  const first: JobNativeAttempt = {
    ref,
    rowId: 1,
    createdAt: 100,
    endedAt: 200,
    cloudId: `ac-local-${ref.id}-0`,
    ip: 'localhost',
    cloudProvider: CloudType.Local,
    credentialId: null,
    region: 'local',
    availabilityZone: null,
    vmType: 'local',
  };
  const native = new JobNativeCleanup({
    kernel: {
      assertActive: (reference) => {
        if (reference !== ref) throw new Error('another reference');
      },
    },
    ledger: {
      read: async () => {
        calls.push('inventory');
        await barrier;
        return rows;
      },
      observations: () => rows,
    },
    wait: new Waiter(new AbortController().signal),
    artifacts: {
      json: async (name, value) => {
        artifacts.push(value);
        return name;
      },
    },
  });
  native.register(
    ref,
    {
      provider: CloudType.Local,
      credentialId: null,
      controller: { url: 'http://job-controller.invalid', generation: 1 },
    },
    {
      observe: async (row) => ({
        cloudId: row.cloudId,
        provider: row.cloudProvider,
        presence: 'absent',
        diagnostic: 'exact absence',
      }),
    },
  );
  await submitJob(ref, ['job', '--id', ref.id, 'busybox:1.36'], {
    native,
    mutations: {
      runCliCreate: async () => {
        rows = [first];
        return commandResultForTest();
      },
    },
  });
  const absence = await native.generationAbsence(ref, 1, 1_000);
  calls.length = 0;
  return {
    ref,
    native,
    absence,
    calls,
    artifacts,
    blockInventory: (value: Promise<void>) => {
      barrier = value;
    },
    sent: () => {
      calls.push('resubmit');
      rows = [
        first,
        {
          ...first,
          rowId: 2,
          createdAt: 300,
          endedAt: 400,
          cloudId: `ac-local-${ref.id}-1`,
        },
      ];
    },
  };
}

describe('same-ID Job mutation composition', () => {
  test('awaits a new complete fence and carries the original generation receipt through one resubmit send', async () => {
    const world = await resubmissionWorld();
    let release: (() => void) | undefined;
    world.blockInventory(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const send = vi.fn<WorkloadMutationTransport['runCliResubmit']>(
      async (ref, args, options) => {
        expect(ref).toBe(world.ref);
        expect(args).toEqual(['resubmit', world.ref.id]);
        expect(options).toMatchObject({
          recordArtifact: false,
          timeoutMs: 300_000,
        });
        world.sent();
        return commandResultForTest({
          combined: `Workload ${world.ref.id} resubmitted`,
        });
      },
    );
    const pending = resubmitJob(world.ref, world.absence, {
      native: world.native,
      mutations: { runCliResubmit: send },
    });
    expect(world.calls).toEqual(['inventory']);
    expect(send).not.toHaveBeenCalled();
    release?.();
    await pending;
    expect(send).toHaveBeenCalledTimes(1);
    expect(world.calls).toEqual(['inventory', 'resubmit', 'inventory']);
    await world.native.verify(world.ref, 1_000);
    expect(world.artifacts.at(-1)).toMatchObject({
      authorizedCreates: 2,
      completed: true,
      currentAttempts: [
        expect.objectContaining({ rowId: 1 }),
        expect.objectContaining({ rowId: 2 }),
      ],
    });
  });

  test('retains the later generation after a lost resubmit reply without recreating or releasing the original reference', async () => {
    const world = await resubmissionWorld();
    const primary = new Error('later reply lost');
    const send = vi.fn(async () => {
      world.sent();
      throw primary;
    });
    await expect(
      resubmitJob(world.ref, world.absence, {
        native: world.native,
        mutations: { runCliResubmit: send },
      }),
    ).rejects.toBe(primary);
    expect(send).toHaveBeenCalledTimes(1);
    expect(world.calls).toEqual(['inventory', 'resubmit', 'inventory']);
    await world.native.verify(world.ref, 1_000);
    expect(world.artifacts.at(-1)).toMatchObject({
      authorizedCreates: 2,
      completed: true,
      creations: [
        expect.objectContaining({ ordinal: 1, resolvedRowIds: [1] }),
        expect.objectContaining({ ordinal: 2, resolvedRowIds: [2] }),
      ],
      observations: [
        expect.objectContaining({
          cloudId: `ac-local-${world.ref.id}-0`,
          presence: 'absent',
        }),
        expect.objectContaining({
          cloudId: `ac-local-${world.ref.id}-1`,
          presence: 'absent',
        }),
      ],
    });
  });

  test.each([
    '',
    'Workload foreign resubmitted',
    'Failed to resubmit workload',
  ])(
    'a zero process exit without the exact accepted Workload response is still a failure: %s',
    async (combined) => {
      const world = await resubmissionWorld();
      const send = vi.fn(async () => {
        world.sent();
        return commandResultForTest({ combined });
      });
      await expect(
        resubmitJob(world.ref, world.absence, {
          native: world.native,
          mutations: { runCliResubmit: send },
        }),
      ).rejects.toThrow('did not confirm the original Workload');
      expect(send).toHaveBeenCalledTimes(1);
      expect(world.calls).toEqual(['inventory', 'resubmit', 'inventory']);
    },
  );
});
