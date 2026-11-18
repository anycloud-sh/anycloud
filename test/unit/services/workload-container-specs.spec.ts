import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getWorkloadLifecycle,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queryStore,
  getWorkloadOutcomes,
  getWorkloadSpendStore,
} from '../../../src/api/services/persistence.js';
import config from '../../../src/api/config.js';
import { WorkloadState, WorkloadType } from '../../../src/shared/workload.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { decryptSecret } from '../../../src/api/services/secret-crypto.js';
import { resetPersistence } from '../../../src/api/services/persistence.js';
import {
  WorkloadLifecycleStore,
  type BeginServiceUpgradeInput,
} from '../../../src/api/services/repositories/workload-lifecycle.js';
import { DockerManager } from '../../../src/api/services/docker.js';
import { walkToState } from '../../helpers/workload-store.js';
import {
  createWorkload,
  type CreateWorkloadInput,
} from '../../../src/api/services/repositories/workload-creation.js';

const ownerScope = { kind: 'api' } as const;

function admission(
  overrides: Partial<CreateWorkloadInput> = {},
): CreateWorkloadInput {
  return {
    id: 'owned-container',
    userId: 'OriginalName',
    ownerUserId: 'owner-id',
    workloadType: WorkloadType.Job,
    image: 'ghcr.io/example/work:admitted',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    command: ['sh', '-c', 'echo hello'],
    env: { ADMITTED_VALUE: 'environment-canary' },
    githubToken: 'registry-token-canary',
    dockerOptions: { shmSize: '2g' },
    dockerCommand: 'admitted diagnostic',
    sshPrivateKey: 'ssh-key-canary',
    requestedComputeProvider: CloudType.Local,
    ...overrides,
  };
}

function upgrade(
  overrides: Partial<BeginServiceUpgradeInput> = {},
): BeginServiceUpgradeInput {
  return {
    id: 'owned-container',
    scope: ownerScope,
    image: 'ghcr.io/example/work:upgraded',
    previousImage: 'ghcr.io/example/work:admitted',
    imageDigest: `sha256:${'b'.repeat(64)}`,
    dockerCommand: 'replacement diagnostic',
    command: ['replacement'],
    env: { UPGRADE_VALUE: 'replacement-canary' },
    githubToken: 'replacement-token-canary',
    ...overrides,
  };
}

describe('workload-owned container specifications', () => {
  beforeEach(() => {
    resetPersistence();
    config.cipherKey = 'a'.repeat(64);
  });

  it.each([WorkloadType.Job, WorkloadType.Service, WorkloadType.Vm])(
    'test:0036/S18 stores %s configuration only in its independently encrypted child',
    async (workloadType) => {
      await createWorkload(getDB(), admission({ workloadType }));
      const [parent] = await getDB().query<Record<string, unknown>>(
        'SELECT * FROM workloads',
      );
      for (const column of [
        'image',
        'image_digest',
        'command',
        'env',
        'github_token',
        'docker_options',
        'submitted_image',
        'submitted_image_digest',
        'submitted_command',
        'submitted_docker_options',
      ]) {
        expect(parent).not.toHaveProperty(column);
      }
      expect(parent).toMatchObject({
        user_id: 'OriginalName',
      });
      const [spec] = await getDB().query<Record<string, string>>(
        'SELECT * FROM container_specs',
      );
      expect(spec).toMatchObject({
        workload_id: 'owned-container',
        image: 'ghcr.io/example/work:admitted',
      });
      expect(JSON.stringify(spec)).not.toContain('environment-canary');
      expect(JSON.stringify(spec)).not.toContain('registry-token-canary');
      expect(JSON.stringify(spec)).not.toContain('x-access-token');
      expect(await decryptSecret(spec.registry_username)).toBe(
        'x-access-token',
      );
      expect(await decryptSecret(spec.registry_token)).toBe(
        'registry-token-canary',
      );
      expect(JSON.parse(await decryptSecret(spec.env))).toEqual({
        ADMITTED_VALUE: 'environment-canary',
      });
      expect(await queryStore().getWorkload('owned-container')).toMatchObject({
        workloadType,
        image: 'ghcr.io/example/work:admitted',
        registryUsername: 'x-access-token',
        env: { ADMITTED_VALUE: 'environment-canary' },
        githubToken: 'registry-token-canary',
      });
    },
  );

  it('test:0036/S4 rolls back the admitted parent when its spec insert fails', async () => {
    await getDB()
      .query(`CREATE TRIGGER reject_test_spec BEFORE INSERT ON container_specs
      BEGIN SELECT RAISE(ABORT, 'test spec failure'); END`);
    await expect(createWorkload(getDB(), admission())).rejects.toThrow(
      'test spec failure',
    );
    expect(await getDB().query('SELECT * FROM workloads')).toEqual([]);
    expect(await getDB().query('SELECT * FROM container_specs')).toEqual([]);
  });

  it('rolls back a non-Queued fixture when its initial event insert fails', async () => {
    await getDB()
      .query(`CREATE TRIGGER reject_test_event BEFORE INSERT ON workload_events
      BEGIN SELECT RAISE(ABORT, 'test event failure'); END`);
    await expect(
      createWorkload(getDB(), admission(), {
        initialState: WorkloadState.Running,
      }),
    ).rejects.toThrow('test event failure');
    expect(await getDB().query('SELECT * FROM workloads')).toEqual([]);
    expect(await getDB().query('SELECT * FROM container_specs')).toEqual([]);
    expect(await getDB().query('SELECT * FROM workload_events')).toEqual([]);
  });

  it('retains the exact admitted Job spec across an authorized resubmission', async () => {
    await createWorkload(getDB(), admission());
    const before = await getDB().query('SELECT * FROM container_specs');
    await getDB().query(
      "UPDATE workloads SET state = 'errored', completed_at = 100, cleaned_at = 100",
    );
    await expect(
      getWorkloadOutcomes().resubmitWorkloadForScope(
        'owned-container',
        ownerScope,
      ),
    ).resolves.toBe(true);
    expect(await getDB().query('SELECT * FROM container_specs')).toEqual(
      before,
    );
    expect((await queryStore().getWorkload('owned-container'))?.state).toBe(
      WorkloadState.Queued,
    );
    await expect(
      getDB().query(
        "UPDATE container_specs SET image = 'changed' WHERE workload_id = 'owned-container'",
      ),
    ).rejects.toThrow('immutable');
  });

  it('test:0036/S8 test:0036/S13 commits Service replacement without re-reading preserved configuration', async () => {
    await createWorkload(
      getDB(),
      admission({
        workloadType: WorkloadType.Service,
        region: 'kept-region',
      }),
    );
    await walkToState('owned-container', WorkloadState.Running);
    const [before] = await getDB().query<Record<string, unknown>>(
      'SELECT * FROM container_specs',
    );
    const db = getDB();
    // Observe both entry points: transaction reads bypass db.query.
    const writeOnlyStore = new WorkloadLifecycleStore({
      read: () => Promise.reject(new Error('unexpected read')),
      query(sql, params) {
        expect(sql).toMatch(/^\s*(UPDATE|INSERT)\b/i);
        return db.query(sql, params);
      },
      transaction: (run) =>
        db.transaction((tx) =>
          run({
            query(sql, params) {
              expect(sql).toMatch(/^\s*(UPDATE|INSERT)\b/i);
              return tx.query(sql, params);
            },
          }),
        ),
    });
    await expect(writeOnlyStore.beginServiceUpgrade(upgrade())).resolves.toBe(
      true,
    );
    const after = await queryStore().getWorkload('owned-container');
    expect(after).toMatchObject({
      state: WorkloadState.Recovering,
      image: 'ghcr.io/example/work:upgraded',
      command: ['replacement'],
      env: { UPGRADE_VALUE: 'replacement-canary' },
      registryUsername: 'x-access-token',
      userId: 'OriginalName',
      region: 'kept-region',
      githubToken: 'replacement-token-canary',
      dockerOptions: { shmSize: '2g' },
      dockerCommand: 'replacement diagnostic',
    });
    const [afterRow] = await getDB().query<Record<string, unknown>>(
      'SELECT * FROM container_specs',
    );
    expect(afterRow).toMatchObject({
      workload_id: before.workload_id,
      registry_username: before.registry_username,
      docker_options: before.docker_options,
    });
    expect(await eventLog().getWorkloadEvents('owned-container')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: WorkloadState.Recovering,
          metadata: expect.stringContaining('"reason":"serve-upgrade"'),
        }),
      ]),
    );
  });

  it('test:0036/S8 accepts exactly one competing Service upgrade with consistent parent, spec and event', async () => {
    const store = getWorkloadLifecycle();
    await createWorkload(
      getDB(),
      admission({ workloadType: WorkloadType.Service }),
    );
    await walkToState('owned-container', WorkloadState.Running);
    const first = upgrade({
      image: 'ghcr.io/example/work:first',
      imageDigest: `sha256:${'c'.repeat(64)}`,
      command: ['first'],
      env: { WINNER: 'first' },
      githubToken: 'first-token',
      dockerCommand: 'first diagnostic',
      dockerOptions: { memory: '2g', binds: ['first:/data'] },
    });
    const second = upgrade({
      image: 'ghcr.io/example/work:second',
      imageDigest: `sha256:${'d'.repeat(64)}`,
      command: ['second'],
      env: { WINNER: 'second' },
      githubToken: 'second-token',
      dockerCommand: 'second diagnostic',
      dockerOptions: { memory: '4g', binds: ['second:/data'] },
    });

    const results = await Promise.all([
      store.beginServiceUpgrade(first),
      store.beginServiceUpgrade(second),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results[0] ? first : second;
    const loser = results[0] ? second : first;
    const parents = await getDB().query<Record<string, unknown>>(
      'SELECT * FROM workloads',
    );
    const specs = await getDB().query<Record<string, unknown>>(
      'SELECT * FROM container_specs',
    );
    const events = await getDB().query<{
      state: string;
      metadata: string;
      created_at: number;
    }>('SELECT * FROM workload_events');

    expect(parents).toEqual([
      expect.objectContaining({
        state: WorkloadState.Recovering,
        docker_command: winner.dockerCommand,
      }),
    ]);
    expect(specs).toEqual([
      expect.objectContaining({
        image: winner.image,
        image_digest: winner.imageDigest,
        command: JSON.stringify(winner.command),
      }),
    ]);
    expect(await queryStore().getWorkload('owned-container')).toMatchObject({
      state: WorkloadState.Recovering,
      image: winner.image,
      imageDigest: winner.imageDigest,
      command: winner.command,
      env: winner.env,
      githubToken: winner.githubToken,
      dockerCommand: winner.dockerCommand,
      registryUsername: 'x-access-token',
      dockerOptions: winner.dockerOptions,
    });
    const upgradeEvents = events.filter(
      (event) => event.state === WorkloadState.Recovering,
    );
    expect(upgradeEvents).toHaveLength(1);
    expect(JSON.parse(upgradeEvents[0].metadata)).toEqual({
      reason: 'serve-upgrade',
      previousImage: winner.previousImage,
      image: winner.image,
    });
    expect(upgradeEvents[0].created_at).toBe(parents[0].started_at);

    await expect(store.beginServiceUpgrade(loser)).resolves.toBe(false);
    expect(await getDB().query('SELECT * FROM workloads')).toEqual(parents);
    expect(await getDB().query('SELECT * FROM container_specs')).toEqual(specs);
    expect(await getDB().query('SELECT * FROM workload_events')).toEqual(
      events,
    );
  });

  it.each(['spec', 'event'])(
    'test:0036/S8 rolls back Service state, diagnostics, spec and event when the %s write fails',
    async (failure) => {
      const store = getWorkloadLifecycle();
      await createWorkload(
        getDB(),
        admission({ workloadType: WorkloadType.Service }),
      );
      await walkToState('owned-container', WorkloadState.Running);
      const parents = await getDB().query('SELECT * FROM workloads');
      const specs = await getDB().query('SELECT * FROM container_specs');
      const events = await getDB().query('SELECT * FROM workload_events');
      await getDB().query(
        failure === 'spec'
          ? `CREATE TRIGGER reject_test_upgrade BEFORE UPDATE ON container_specs BEGIN SELECT RAISE(ABORT, 'test upgrade failure'); END`
          : `CREATE TRIGGER reject_test_upgrade BEFORE INSERT ON workload_events BEGIN SELECT RAISE(ABORT, 'test upgrade failure'); END`,
      );
      await expect(
        store.beginServiceUpgrade(
          upgrade({
            dockerOptions: { memory: '2g', binds: ['replacement:/data'] },
          }),
        ),
      ).rejects.toThrow('test upgrade failure');
      expect(await getDB().query('SELECT * FROM workloads')).toEqual(parents);
      expect(await getDB().query('SELECT * FROM container_specs')).toEqual(
        specs,
      );
      expect(await getDB().query('SELECT * FROM workload_events')).toEqual(
        events,
      );
    },
  );

  it('rolls back a Service upgrade whose spec child is missing', async () => {
    await createWorkload(
      getDB(),
      admission({ workloadType: WorkloadType.Service }),
    );
    await walkToState('owned-container', WorkloadState.Running);
    await getDB().query('DROP TRIGGER container_specs_no_detach');
    await getDB().query(
      "DELETE FROM container_specs WHERE workload_id = 'owned-container'",
    );
    const parents = await getDB().query('SELECT * FROM workloads');
    const events = await getDB().query('SELECT * FROM workload_events');
    await expect(
      getWorkloadLifecycle().beginServiceUpgrade(upgrade()),
    ).rejects.toThrow('container spec ownership is incomplete');
    expect(parents).toEqual([
      expect.objectContaining({ state: WorkloadState.Running }),
    ]);
    expect(await getDB().query('SELECT * FROM workloads')).toEqual(parents);
    expect(await getDB().query('SELECT * FROM workload_events')).toEqual(
      events,
    );
  });

  it('test:0036/S8 authorizes mutable spec writes for a legacy row without an owner id', async () => {
    const store = getWorkloadLifecycle();
    await createWorkload(
      getDB(),
      admission({
        workloadType: WorkloadType.Service,
        ownerUserId: undefined,
      }),
    );
    await walkToState('owned-container', WorkloadState.Running);
    await expect(
      store.beginServiceUpgrade(
        upgrade({
          scope: { kind: 'api' },
        }),
      ),
    ).resolves.toBe(true);
    expect(await getDB().query('SELECT owner_user_id FROM workloads')).toEqual([
      { owner_user_id: null },
    ]);
  });

  it('test:0036/S19 searches the canonical spec image before limiting and fails loudly for a missing child', async () => {
    await createWorkload(
      getDB(),
      admission({ id: 'match', image: 'search-canary' }),
    );
    await createWorkload(
      getDB(),
      admission({ id: 'newer', image: 'other-image' }),
    );
    const result = await queryStore().listWorkloads(ownerScope, 1, {
      search: 'search-canary',
      limitExplicit: true,
    });
    expect(result.map((item) => item.id)).toEqual(['match']);
    expect(
      (
        await getWorkloadSpendStore().listWorkloadCostsForId(
          ownerScope,
          'match',
        )
      )[0]?.image,
    ).toBe('search-canary');
    await getDB().query('DROP TRIGGER container_specs_no_detach');
    await getDB().query(
      "DELETE FROM container_specs WHERE workload_id = 'match'",
    );
    await expect(queryStore().getWorkload('match')).rejects.toThrow(
      'ownership is incomplete',
    );
    await expect(queryStore().listWorkloads(ownerScope)).rejects.toThrow(
      'ownership is incomplete',
    );
    await expect(
      getWorkloadSpendStore().listWorkloadCostsForId(ownerScope, 'match'),
    ).rejects.toThrow('ownership is incomplete');
  });

  it('test:0036/S25 lists public fields without selecting or decrypting secret columns', async () => {
    await createWorkload(getDB(), admission());
    const queries = vi.spyOn(getDB(), 'query');
    // Values encrypted under the admitted key cannot be decrypted under this key.
    config.cipherKey = 'b'.repeat(64);
    const listed = await queryStore().listWorkloads(ownerScope);
    expect(listed).toMatchObject([
      {
        id: 'owned-container',
        image: 'ghcr.io/example/work:admitted',
        command: ['sh', '-c', 'echo hello'],
        dockerOptions: { shmSize: '2g' },
      },
    ]);
    for (const key of [
      'env',
      'githubToken',
      'registryUsername',
      'sshPrivateKey',
    ]) {
      expect(listed[0]).not.toHaveProperty(key);
    }
    for (const { value } of queries.mock.results) {
      for (const row of await value) {
        for (const column of [
          'ssh_private_key',
          'registry_username',
          'registry_token',
          'env',
        ]) {
          expect(row).not.toHaveProperty(column);
        }
      }
    }
    queries.mockRestore();
    await expect(queryStore().getWorkload('owned-container')).rejects.toThrow();
  });

  it('test:0036/S18 uses captured registry identity for Docker auth context but parent identity for labels', async () => {
    await createWorkload(getDB(), admission());
    const workload = (await queryStore().getWorkload('owned-container'))!;
    const command = DockerManager.getCommand({
      ...workload,
      userId: 'DisplayIdentity',
    });
    expect(command).not.toContain('OriginalName');
    expect(command).toContain('DisplayIdentity');
    expect(command).not.toContain('registry-token-canary');
    expect(() =>
      DockerManager.getCommand({
        ...workload,
        registryUsername: null,
      }),
    ).toThrow('VM-host container configuration is required');
  });
});
