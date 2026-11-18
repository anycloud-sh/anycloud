import { describe, expect, test, vi } from 'vitest';

import { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import { JobCloudStorage } from '../integration/e2e/internal/job-cloud-storage.js';
import type {
  JobBucketIdentity,
  JobNativeBucketObservation,
} from '../integration/e2e/internal/transports/job-bucket-native.js';
import { Waiter } from '../integration/e2e/internal/wait.js';

const bucketName = 'job-owned-bucket';
const scope = '123456789012';
const ownerApi = 'a'.repeat(32);

function fixture() {
  const cleanup = new CleanupStack();
  const records: unknown[] = [];
  const commands: readonly string[][] = [];
  const mutableCommands = commands as string[][];
  const state = {
    identity: undefined as JobBucketIdentity | undefined,
    nativeReads: 0,
    afterNative: undefined as (() => void) | undefined,
    children: false,
    lostCreate: false,
    nativeScope: scope,
    apiPresence: undefined as 'present' | 'absent' | undefined,
    generation: 1,
    deleteCount: 0,
    failRecord: false,
    list: [] as unknown[],
    metadataFailure: false,
    afterCreate: undefined as (() => Promise<void>) | undefined,
    onRecord: undefined as ((body: unknown) => void) | undefined,
  };
  const native = {
    initialize: async () => undefined,
    observe: async (name: string): Promise<JobNativeBucketObservation> => {
      state.nativeReads++;
      if (state.metadataFailure) throw new Error('native-schema-failed');
      const observation: JobNativeBucketObservation = state.identity
        ? { presence: 'present', identity: state.identity }
        : { presence: 'absent', name, scope: state.nativeScope };
      state.afterNative?.();
      return observation;
    },
    prepareInput: async () => undefined,
  };
  const api = {
    get controller() {
      return { url: 'http://original.invalid', generation: state.generation };
    },
    bucketPresence: async (
      name: string,
      credentialName: string,
      region: string,
    ) => ({
      name,
      credentialName,
      region,
      controller: {
        url: 'http://original.invalid',
        generation: state.generation,
      },
      presence:
        state.apiPresence ??
        (state.identity ? ('present' as const) : ('absent' as const)),
    }),
  };
  const cli = {
    run: async (args: readonly string[]) => {
      mutableCommands.push([...args]);
      let stdout = '';
      if (args[1] === 'create') {
        expect(cleanup.observations()).toEqual([
          { label: `job-bucket-${bucketName}`, completed: false },
        ]);
        state.identity = {
          name: bucketName,
          scope,
          provider: 'aws',
          nativeId: `arn:aws:s3:::${bucketName}`,
          region: 'us-east-1',
          ownerApi,
          ownerUser: 'test-user',
          workloadId: `cli-test-user-${Date.now()}`,
          createdAt: Date.now(),
        };
        if (state.lostCreate)
          throw new Error('lost-create-with-private-diagnostic');
        await state.afterCreate?.();
        stdout = `Bucket ${bucketName} ready`;
      } else if (args[1] === 'delete') {
        state.deleteCount++;
        state.identity = undefined;
      } else if (args[1] === 'list')
        stdout = JSON.stringify({
          entries: state.list,
          truncated: false,
          nextCursor: null,
        });
      return {
        executable: 'anycloud',
        args: [...args],
        exitCode: 0,
        signal: null,
        stdout,
        stderr: '',
        combined: stdout,
        durationMs: 1,
        aborted: false,
        timedOut: false,
        outputTruncated: false,
      };
    },
  };
  const wait = new Waiter(new AbortController().signal);
  const storage = new JobCloudStorage(
    {
      cli,
      cleanupCli: cli,
      api,
      cleanupApi: api,
      native,
      cleanup,
      wait,
      cleanupWait: wait,
      files: { text: async () => '/unused-fixture-file' },
      artifacts: {
        json: async (_name, body) => {
          state.onRecord?.(body);
          if (state.failRecord) throw new Error('secondary-record-failed');
          records.push(body);
          return '';
        },
      },
    },
    {
      credentialName: 'aws-test',
      region: 'us-east-1',
      ownerApi,
      cleanupMs: 10_000,
      childrenAbsent: () => {
        if (state.children) throw new Error('native children remain');
      },
    },
  );
  return { storage, cleanup, records, commands, state };
}

describe('Job cloud storage lifetime and exact readback', () => {
  test('reobserves an automatic bucket created between native absence and API presence without releasing intent', async () => {
    const world = fixture();
    const ref = await world.storage.reserve(
      bucketName,
      'automatic',
      ['job-1'],
      Date.now() + 10_000,
    );
    await world.storage.beginAutomatic(ref, Date.now() + 10_000);
    world.state.nativeReads = 0;
    world.state.afterNative = () => {
      world.state.identity ??= {
        name: bucketName,
        scope,
        provider: 'aws',
        nativeId: `arn:aws:s3:::${bucketName}`,
        region: 'us-east-1',
        ownerApi,
        ownerUser: 'test-user',
        workloadId: 'job-1',
        createdAt: Date.now(),
      };
    };
    await expect(
      world.storage.observe(ref, Date.now() + 10_000),
    ).resolves.toMatchObject({ presence: 'present' });
    expect(world.state.nativeReads).toBe(2);
    expect(world.records).toContainEqual(
      expect.objectContaining({
        state: 'readback-disagreement',
        native: { presence: 'absent', name: bucketName, scope },
        api: expect.objectContaining({ presence: 'present' }),
        absent: false,
      }),
    );
    expect(world.records.at(-1)).toMatchObject({
      state: 'observed',
      native: { presence: 'present' },
      api: { presence: 'present' },
    });
    expect(world.cleanup.observations()[0].completed).toBe(false);
    expect(world.commands).toEqual([]);
  });

  test('does not start its creation reread after the original deadline', async () => {
    vi.useFakeTimers();
    try {
      const world = fixture();
      const deadline = Date.now() + 10_000;
      const ref = await world.storage.reserve(
        bucketName,
        'automatic',
        ['job-1'],
        deadline,
      );
      await world.storage.beginAutomatic(ref, deadline);
      world.state.nativeReads = 0;
      world.state.afterNative = () => {
        world.state.apiPresence = 'present';
        vi.setSystemTime(deadline);
      };
      await expect(world.storage.observe(ref, deadline)).rejects.toThrow(
        'deadline expired',
      );
      expect(world.state.nativeReads).toBe(1);
      expect(world.cleanup.observations()[0].completed).toBe(false);
      expect(world.records.at(-1)).toMatchObject({
        state: 'incomplete',
        absent: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('preserves a native read failure together with its secondary recording failure', async () => {
    const world = fixture();
    const ref = await world.storage.reserve(
      bucketName,
      'automatic',
      ['job-1'],
      Date.now() + 10_000,
    );
    await world.storage.beginAutomatic(ref, Date.now() + 10_000);
    world.state.metadataFailure = true;
    world.state.failRecord = true;
    await expect(
      world.storage.observe(ref, Date.now() + 10_000),
    ).rejects.toMatchObject({
      errors: [
        new Error('native-schema-failed'),
        new Error('secondary-record-failed'),
      ],
    });
    expect(world.cleanup.observations()[0].completed).toBe(false);
    expect(world.commands).toEqual([]);
  });

  test('retains both pairs and its registration when one complete reread still disagrees', async () => {
    const world = fixture();
    const ref = await world.storage.reserve(
      bucketName,
      'automatic',
      ['job-1'],
      Date.now() + 10_000,
    );
    await world.storage.beginAutomatic(ref, Date.now() + 10_000);
    world.state.apiPresence = 'present';
    world.state.nativeReads = 0;
    await expect(
      world.storage.observe(ref, Date.now() + 10_000),
    ).rejects.toThrow('presence disagree');
    expect(world.state.nativeReads).toBe(2);
    expect(
      world.records.filter(
        (record) =>
          typeof record === 'object' &&
          record !== null &&
          'state' in record &&
          record.state === 'readback-disagreement',
      ),
    ).toHaveLength(2);
    expect(world.records.at(-1)).toMatchObject({
      state: 'incomplete',
      absent: false,
    });
    expect(world.cleanup.observations()[0].completed).toBe(false);
    expect(world.commands).toEqual([]);
  });

  test('does not adopt a foreign bucket appearing during the one allowed creation reread', async () => {
    const world = fixture();
    const ref = await world.storage.reserve(
      bucketName,
      'automatic',
      ['job-1'],
      Date.now() + 10_000,
    );
    await world.storage.beginAutomatic(ref, Date.now() + 10_000);
    world.state.afterNative = () => {
      world.state.identity ??= {
        name: bucketName,
        scope,
        provider: 'aws',
        nativeId: `arn:aws:s3:::${bucketName}`,
        region: 'us-east-1',
        ownerApi: 'f'.repeat(32),
        ownerUser: 'test-user',
        workloadId: 'job-1',
        createdAt: Date.now(),
      };
    };
    await expect(
      world.storage.observe(ref, Date.now() + 10_000),
    ).rejects.toThrow('foreign creation');
    expect(world.records.at(-1)).toMatchObject({
      state: 'incomplete',
      absent: false,
    });
    expect(world.cleanup.observations()[0].completed).toBe(false);
    expect(world.commands).toEqual([]);
  });

  test.each(['cleanup', 'adopted', 'explicit'] as const)(
    'does not apply the automatic creation reread to %s observations',
    async (caseName) => {
      const world = fixture();
      const deadline = Date.now() + 10_000;
      const ref = await world.storage.reserve(
        bucketName,
        caseName === 'explicit' ? 'explicit' : 'automatic',
        ['job-1'],
        deadline,
      );
      if (caseName === 'explicit') await world.storage.create(ref, deadline);
      else await world.storage.beginAutomatic(ref, deadline);
      const identity: JobBucketIdentity = world.state.identity ?? {
        name: bucketName,
        scope,
        provider: 'aws',
        nativeId: `arn:aws:s3:::${bucketName}`,
        region: 'us-east-1',
        ownerApi,
        ownerUser: 'test-user',
        workloadId: 'job-1',
        createdAt: Date.now(),
      };
      if (caseName === 'adopted') {
        world.state.identity = identity;
        await world.storage.observe(ref, deadline);
      }
      world.state.identity = undefined;
      world.state.nativeReads = 0;
      world.state.apiPresence = 'present';
      world.state.afterNative = () => {
        world.state.identity = identity;
      };
      await expect(
        world.storage.observe(ref, deadline, caseName === 'cleanup'),
      ).rejects.toThrow('presence disagree');
      expect(world.state.nativeReads).toBe(1);
      expect(world.cleanup.observations()[0].completed).toBe(false);
      expect(world.records.at(-1)).toMatchObject({
        state: 'incomplete',
        absent: false,
      });
    },
  );

  test('fences controller replacement during the last collision observation before download', async () => {
    const world = fixture();
    const ref = await world.storage.reserve(
      bucketName,
      'explicit',
      ['job-1'],
      Date.now() + 10_000,
    );
    await world.storage.create(ref, Date.now() + 10_000);
    world.state.onRecord = (body) => {
      if (
        typeof body === 'object' &&
        body !== null &&
        'state' in body &&
        body.state === 'observed'
      )
        world.state.generation++;
    };
    await expect(
      world.storage.rejectsFileDirectoryCollision(
        ref,
        'collision/',
        '/unused-destination',
        Date.now() + 10_000,
      ),
    ).rejects.toThrow('original controller');
    expect(world.commands.map((args) => args[1])).toEqual(['create']);
    expect(world.state.identity?.name).toBe(bucketName);
    expect(world.cleanup.observations()[0].completed).toBe(false);
  });

  test('fences controller replacement after the pre-create artifact before the CLI sends', async () => {
    const world = fixture();
    const ref = await world.storage.reserve(
      bucketName,
      'explicit',
      ['job-1'],
      Date.now() + 10_000,
    );
    world.state.onRecord = (body) => {
      if (
        typeof body === 'object' &&
        body !== null &&
        'state' in body &&
        body.state === 'create-sending'
      )
        world.state.generation++;
    };
    await expect(
      world.storage.create(ref, Date.now() + 10_000),
    ).rejects.toThrow('original controller');
    expect(world.commands).toEqual([]);
    await world.cleanup.run();
    expect(world.state.identity).toBeUndefined();
    expect(world.cleanup.observations()[0].completed).toBe(true);
  });

  test.each(['explicit', 'automatic'] as const)(
    'rejects %s creation after its original registration closes',
    async (mode) => {
      const world = fixture();
      const ref = await world.storage.reserve(
        bucketName,
        mode,
        ['job-1'],
        Date.now() + 10_000,
      );
      await world.storage.remove(ref, Date.now() + 10_000);
      await expect(
        mode === 'explicit'
          ? world.storage.create(ref, Date.now() + 10_000)
          : world.storage.beginAutomatic(ref, Date.now() + 10_000),
      ).rejects.toThrow('begun cleanup');
      await world.cleanup.run();
      expect(world.commands).toEqual([]);
      expect(world.state.identity).toBeUndefined();
      expect(() => world.storage.assertAbsent()).not.toThrow();
    },
  );

  test('waits for an already sent creation before disposing its native resource', async () => {
    const world = fixture();
    let didSend!: () => void;
    let acknowledge!: () => void;
    const sent = new Promise<void>((resolve) => {
      didSend = resolve;
    });
    const reply = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    world.state.afterCreate = async () => {
      didSend();
      await reply;
    };
    const ref = await world.storage.reserve(
      bucketName,
      'explicit',
      ['job-1'],
      Date.now() + 10_000,
    );
    const create = world.storage.create(ref, Date.now() + 10_000);
    await sent;
    const dispose = world.cleanup.run();
    expect(world.cleanup.observations()[0].completed).toBe(false);
    expect(() => world.storage.assertAbsent()).toThrow('unresolved');
    acknowledge();
    await expect(create).rejects.toThrow('begun cleanup');
    await dispose;
    expect(world.state.deleteCount).toBe(1);
    expect(world.state.identity).toBeUndefined();
    expect(world.cleanup.observations()[0].completed).toBe(true);
  });

  test('arms intent before creation and completes only after matching native/API absence', async () => {
    const world = fixture();
    const ref = await world.storage.reserve(
      bucketName,
      'explicit',
      ['job-1'],
      Date.now() + 10_000,
    );
    await world.storage.create(ref, Date.now() + 10_000);
    expect(world.records).toContainEqual(
      expect.objectContaining({
        state: 'created',
        identity: expect.objectContaining({ scope }),
      }),
    );
    await world.storage.release(Date.now() + 10_000);
    expect(world.state.deleteCount).toBe(1);
    expect(world.cleanup.observations()[0].completed).toBe(true);
    expect(() => world.storage.assertAbsent()).not.toThrow();
    expect(world.records.at(-1)).toMatchObject({
      state: 'cleanup-absent',
      absent: true,
      native: { presence: 'absent' },
      api: { presence: 'absent' },
    });
  });

  test('preserves uncertain creation replies and never adopts a same-name native bucket', async () => {
    const world = fixture();
    world.state.lostCreate = true;
    const ref = await world.storage.reserve(
      bucketName,
      'explicit',
      ['job-1'],
      Date.now() + 10_000,
    );
    await expect(
      world.storage.create(ref, Date.now() + 10_000),
    ).rejects.toThrow('did not complete');
    await expect(world.cleanup.run()).rejects.toThrow(
      'reply remains unresolved',
    );
    expect(world.state.deleteCount).toBe(0);
    expect(world.state.identity).toBeDefined();
    expect(world.cleanup.observations()[0].completed).toBe(false);
    expect(JSON.stringify(world.records)).not.toContain('private-diagnostic');
  });

  test.each([
    'owner',
    'creation',
    'scope',
    'controller',
    'children',
    'schema',
  ] as const)(
    'retains ownership when %s changes before cleanup',
    async (failure) => {
      const world = fixture();
      const ref = await world.storage.reserve(
        bucketName,
        'explicit',
        ['job-1'],
        Date.now() + 10_000,
      );
      await world.storage.create(ref, Date.now() + 10_000);
      if (failure === 'owner')
        world.state.identity = {
          ...world.state.identity!,
          ownerApi: 'b'.repeat(32),
        };
      if (failure === 'creation')
        world.state.identity = { ...world.state.identity!, createdAt: 1 };
      if (failure === 'scope')
        world.state.identity = {
          ...world.state.identity!,
          scope: '999999999999',
        };
      if (failure === 'controller') world.state.generation = 2;
      if (failure === 'children') world.state.children = true;
      if (failure === 'schema') world.state.metadataFailure = true;
      await expect(world.cleanup.run()).rejects.toThrow();
      expect(world.state.deleteCount).toBe(0);
      expect(world.cleanup.observations()[0].completed).toBe(false);
      expect(world.records.at(-1)).toMatchObject({
        state: 'incomplete',
        absent: false,
      });
    },
  );

  test('rejects a foreign absence scope and conflicting API absence', async () => {
    for (const kind of ['scope', 'API'] as const) {
      const world = fixture();
      const ref = await world.storage.reserve(
        bucketName,
        'explicit',
        ['job-1'],
        Date.now() + 10_000,
      );
      await world.storage.create(ref, Date.now() + 10_000);
      if (kind === 'scope') {
        world.state.identity = undefined;
        world.state.nativeScope = 'foreign';
      } else world.state.apiPresence = 'absent';
      await expect(world.cleanup.run()).rejects.toThrow();
      expect(world.cleanup.observations()[0].completed).toBe(false);
    }
  });

  test('rescue deletion cannot erase a failed automatic-checkpoint assertion', async () => {
    vi.useFakeTimers();
    try {
      const world = fixture();
      const ref = await world.storage.reserve(
        bucketName,
        'automatic',
        ['job-1'],
        Date.now() + 10_000,
      );
      await world.storage.beginAutomatic(ref, Date.now() + 10_000);
      world.state.identity = {
        name: bucketName,
        scope,
        provider: 'aws',
        nativeId: `arn:aws:s3:::${bucketName}`,
        region: 'us-east-1',
        ownerApi,
        ownerUser: 'test-user',
        workloadId: 'job-1',
        createdAt: Date.now(),
      };
      const absence = expect(
        world.storage.requireAutomaticAbsence(ref, 10),
      ).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(10);
      await absence;
      expect(world.records.at(-1)).toMatchObject({
        automaticCleanup: false,
        absent: false,
      });
      expect(world.state.deleteCount).toBe(0);
      expect(world.cleanup.observations()[0].completed).toBe(false);
      await world.cleanup.run();
      expect(world.state.deleteCount).toBe(1);
      expect(world.records.at(-1)).toMatchObject({
        automaticCleanup: false,
        absent: true,
      });
      expect(world.cleanup.observations()[0].completed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('rejects copied references, repeated creates and incomplete object inventories', async () => {
    const world = fixture();
    const ref = await world.storage.reserve(
      bucketName,
      'explicit',
      ['job-1'],
      Date.now() + 10_000,
    );
    await world.storage.create(ref, Date.now() + 10_000);
    await expect(
      world.storage.create(ref, Date.now() + 10_000),
    ).rejects.toThrow('cannot be replayed');
    await expect(
      world.storage.observe({ ...ref }, Date.now() + 10_000),
    ).rejects.toThrow('copied');
    world.state.list = [{ kind: 'object', key: 'prefix/file' }];
    await expect(
      world.storage.entries(ref, 'prefix/', true, Date.now() + 10_000),
    ).rejects.toThrow('inventory is malformed');
    expect(world.commands.at(-1)).toContain('--all');
    expect(world.commands.at(-1)).toContain('--json');
    expect(world.state.deleteCount).toBe(0);
  });
});
