import { beforeEach, describe, expect, it } from 'vitest';
import {
  DeploymentStore,
  type CreateDeploymentInput,
} from '../../../src/api/services/deployment-store.js';
import { getDB, type DB } from '../../../src/api/services/repositories/db.js';
import {
  getDeploymentStore,
  getPersistence,
  resetPersistence,
  getWorkloadQueryStore as queries,
  getWorkloadSpendStore,
} from '../../../src/api/services/persistence.js';
import {
  computeSpend,
  currentBurnRate,
} from '../../../src/api/services/spend-controls.js';
import { getWorkloadAdmissionWriter } from '../../../src/api/services/workload-admission-writer.js';
import { encryptSecret } from '../../../src/api/services/secret-crypto.js';
import { makeContainerSpec } from '../helpers/fixtures.js';
import { WorkloadType } from '../../../src/shared/workload.js';
import { seedReadyNodePool } from '../helpers/node-pool-seed.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';

const scope = { kind: 'api' } as const;

function input(): CreateDeploymentInput & { secretNames: string[] } {
  return {
    secretNames: [],
    id: 'deployment-a',
    ownerUserId: 'deployment-owner',
    name: 'model',
    nodePoolId: 'node-pool-a',
    config: makeContainerSpec({ image: 'example/deployment:latest' }),
    gpuCount: 0,
    maxConcurrentJobsPerReplica: 1,
  };
}

describe('Deployment container spec persistence', () => {
  beforeEach(async () => {
    resetPersistence();
    await seedReadyNodePool({
      nodePoolId: 'node-pool-a',
      ownerUserId: 'deployment-owner',
      name: 'training',
    });
  });

  it('0036/S18 round-trips one owned spec with encrypted environment and registry identity', async () => {
    const original = input();
    original.config = makeContainerSpec({
      image: 'ghcr.io/private/image:latest',
      imageDigest: 'sha256:original',
      command: ['python', 'deployment.py'],
      dockerOptions: { cpus: '2', memory: '4g' },
      env: { PRIVATE: 'environment-canary' },
      registryUsername: 'registry-user-canary',
      registryToken: 'token-canary',
    });
    await expect(getDeploymentStore().create(original, scope)).resolves.toBe(
      true,
    );
    await expect(
      getDeploymentStore().getById(original.id),
    ).resolves.toMatchObject({
      ...original,
      generation: 1,
    });
    const rows = await getDB().query<Record<string, unknown>>(
      'SELECT * FROM container_specs WHERE deployment_id = ?',
      [original.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workload_id: null,
      deployment_id: original.id,
    });
    for (const canary of [
      'environment-canary',
      'registry-user-canary',
      'token-canary',
    ]) {
      expect(JSON.stringify(rows)).not.toContain(canary);
    }
    expect(await getDeploymentStore().listForReconciliation()).toHaveLength(1);
    expect(await getDeploymentStore().listForScope(scope)).toHaveLength(1);
  });

  it('0036/S4 rolls back the Deployment when child creation fails', async () => {
    await getDB()
      .query(`CREATE TRIGGER fail_deployment_spec BEFORE INSERT ON container_specs
      BEGIN SELECT RAISE(ABORT, 'injected child failure'); END`);
    await expect(getDeploymentStore().create(input(), scope)).rejects.toThrow(
      'injected child failure',
    );
    expect(await getDB().query('SELECT * FROM deployments')).toEqual([]);
    expect(await getDB().query('SELECT * FROM container_specs')).toEqual([]);
  });

  it('stores probe changes in the generation CAS, preserving omissions and clearing null', async () => {
    const store = getDeploymentStore();
    const original = input();
    const probe = {
      exec: { command: ['test', '-f', '/ready'] },
      periodSeconds: 1,
    };
    expect(
      await store.create({ ...original, readinessProbe: probe }, scope),
    ).toBe(true);
    expect(await store.getById(original.id)).toMatchObject({
      generation: 1,
      readinessProbe: probe,
    });
    expect(
      await store.update({ ...original, expectedGeneration: 1 }, scope),
    ).toBe(2);
    expect(await store.getById(original.id)).toMatchObject({
      generation: 2,
      readinessProbe: probe,
    });
    const replacement = { exec: { command: ['true'] }, failureThreshold: 2 };
    expect(
      await store.update(
        { ...original, readinessProbe: replacement, expectedGeneration: 2 },
        scope,
      ),
    ).toBe(3);
    expect(
      await store.update(
        { ...original, readinessProbe: null, expectedGeneration: 2 },
        scope,
      ),
    ).toBeNull();
    expect(await store.getById(original.id)).toMatchObject({
      generation: 3,
      readinessProbe: replacement,
    });
    expect(await store.getById(original.id)).toMatchObject({
      generation: 3,
      readinessProbe: replacement,
    });
    expect(
      await store.update(
        { ...original, readinessProbe: null, expectedGeneration: 3 },
        scope,
      ),
    ).toBe(4);
    expect(await store.getById(original.id)).toMatchObject({
      generation: 4,
      readinessProbe: null,
    });
  });

  it('stores Secret names in the generation CAS and clears them to NULL', async () => {
    const store = getDeploymentStore();
    await store.create({ ...input(), secretNames: ['db', 'tracking'] }, scope);
    expect((await store.getById(input().id))?.secretNames).toEqual([
      'db',
      'tracking',
    ]);
    await store.update({ ...input(), expectedGeneration: 1 }, scope);
    expect((await store.getById(input().id))?.secretNames).toEqual([]);
    expect(await getDB().query('SELECT secret_names FROM deployments')).toEqual(
      [{ secret_names: null }],
    );
  });

  it('defaults the grace to 30 s and keeps it until an update sets it', async () => {
    const store = getDeploymentStore();
    await store.create(input(), scope);
    expect((await store.getById(input().id))?.gracePeriodSeconds).toBe(30);
    await store.update(
      { ...input(), gracePeriodSeconds: 600, expectedGeneration: 1 },
      scope,
    );
    await store.update({ ...input(), expectedGeneration: 2 }, scope);
    expect(await store.getById(input().id)).toMatchObject({
      generation: 3,
      gracePeriodSeconds: 600,
    });
  });

  it('leaves unconfigured Deployments without a readiness probe', async () => {
    await getDeploymentStore().create(input(), scope);
    expect(await getDeploymentStore().getById(input().id)).toMatchObject({
      readinessProbe: null,
    });
    expect(
      await getDB().query('SELECT readiness_probe FROM deployments'),
    ).toEqual([{ readiness_probe: null }]);
  });

  it('persists privileged runtime volumes and an explicit privilege removal', async () => {
    const original = input();
    original.config.dockerOptions = {
      privileged: true,
      binds: ['/runtime', '/control'],
      cpus: '6',
      memory: '24g',
    };
    const store = getDeploymentStore();
    await expect(store.create(original, scope)).resolves.toBe(true);
    await expect(store.getById(original.id)).resolves.toMatchObject({
      config: original.config,
      generation: 1,
    });
    const config = {
      ...original.config,
      dockerOptions: { ...original.config.dockerOptions, privileged: false },
    };
    await expect(
      store.update({ ...original, config, expectedGeneration: 1 }, scope),
    ).resolves.toBe(2);
    await expect(store.getById(original.id)).resolves.toMatchObject({
      config,
      generation: 2,
    });
  });

  it('combines the exact node pool filter with ownership and deletion filters', async () => {
    const store = getDeploymentStore();
    await store.create(input(), scope);
    await store.create(
      { ...input(), id: 'deployment-deleted', name: 'deleted' },
      scope,
    );
    await store.requestDeletion('deployment-deleted', scope);
    await store.markDeleted('deployment-deleted');
    await seedReadyNodePool({
      nodePoolId: 'node-pool-b',
      ownerUserId: 'deployment-owner',
      name: 'second',
    });
    await store.create(
      {
        ...input(),
        id: 'deployment-b',
        name: 'second',
        nodePoolId: 'node-pool-b',
      },
      scope,
    );

    expect(
      (await store.listForScope(scope, { nodePoolId: 'node-pool-a' })).map(
        (deployment) => deployment.id,
      ),
    ).toEqual(['deployment-a']);
    expect(
      (await store.listForScope(scope)).map((deployment) => deployment.id),
    ).toEqual(['deployment-a', 'deployment-b']);
    expect(await store.listForScope(scope, { nodePoolId: 'missing' })).toEqual(
      [],
    );
  });

  it('0036/S24 0036/S15 preserves scoped name resolution and ID-only lifecycle reads for metadata', async () => {
    const store = getDeploymentStore();
    await store.create(input(), scope);
    await store.create(
      { ...input(), id: 'deployment-b', name: 'deployment-a' },
      scope,
    );
    await expect(
      store.getMetadataForScope(' MODEL ', scope),
    ).resolves.toMatchObject({ id: 'deployment-a' });
    await expect(
      store.getMetadataForScope('deployment-a', scope),
    ).resolves.toMatchObject({ id: 'deployment-a' });
    await expect(store.getMetadataById('model')).resolves.toBeNull();

    await store.requestDeletion('deployment-a', scope);
    await expect(
      store.getMetadataForScope('model', scope),
    ).resolves.toMatchObject({
      deletionRequestedAt: expect.any(Number),
      deletedAt: null,
    });
    await store.markDeleted('deployment-a');
    await expect(store.getMetadataForScope('model', scope)).resolves.toBeNull();
    await expect(
      store.getMetadataForScope('deployment-a', scope),
    ).resolves.toMatchObject({ id: 'deployment-b' });
    await expect(store.getMetadataById('deployment-a')).resolves.toMatchObject({
      id: 'deployment-a',
      deletedAt: expect.any(Number),
    });
  });

  it('0036/S6 commits exactly one concurrency-only update with its winning value', async () => {
    const original = input();
    await getDeploymentStore().create(original, scope);
    const before = await getDB().query(
      'SELECT deployment_id, workload_id FROM container_specs WHERE deployment_id = ?',
      [original.id],
    );
    const update = {
      ...original,
      expectedGeneration: 1,
      maxConcurrentJobsPerReplica: 2,
    };
    const results = await Promise.all([
      getDeploymentStore().update(update, scope),
      getDeploymentStore().update(
        { ...update, maxConcurrentJobsPerReplica: 3 },
        scope,
      ),
    ]);
    expect(results.filter((value) => value === 2)).toHaveLength(1);
    expect(results.filter((value) => value === null)).toHaveLength(1);
    expect(
      await getDB().query(
        'SELECT deployment_id, workload_id FROM container_specs WHERE deployment_id = ?',
        [original.id],
      ),
    ).toEqual(before);
    await expect(
      getDeploymentStore().getById(original.id),
    ).resolves.toMatchObject({
      generation: 2,
      maxConcurrentJobsPerReplica: results[0] === 2 ? 2 : 3,
      config: original.config,
    });
  });

  it('0036/S6 checks ownership and deletion in the same update transaction', async () => {
    const original = input();
    await getDeploymentStore().create(original, scope);
    const update = {
      ...original,
      expectedGeneration: 1,
      config: makeContainerSpec({ image: 'wrong:image' }),
    };
    await getDeploymentStore().requestDeletion(original.id, scope);
    await expect(
      getDeploymentStore().update(update, scope),
    ).resolves.toBeNull();
    await expect(
      getDeploymentStore().getById(original.id),
    ).resolves.toMatchObject({
      generation: 1,
      config: original.config,
    });
  });

  it('RT10 advances the generation for a new Pod template only from the generation it saw, and not once deletion is requested', async () => {
    const original = input();
    const store = getDeploymentStore();
    await store.create(original, scope);
    await expect(store.advanceGeneration(original.id, 2)).resolves.toBe(false);
    await expect(store.advanceGeneration(original.id, 1)).resolves.toBe(true);
    await expect(store.getById(original.id)).resolves.toMatchObject({
      generation: 2,
      config: original.config,
    });
    await store.requestDeletion(original.id, scope);
    await expect(store.advanceGeneration(original.id, 2)).resolves.toBe(false);
    await expect(store.getById(original.id)).resolves.toMatchObject({
      generation: 2,
    });
  });

  it('0036/S6 advances generation for a GPU-only update and preserves container configuration', async () => {
    const original = input();
    await getDeploymentStore().create(original, scope);
    await expect(
      getDeploymentStore().update(
        { ...original, expectedGeneration: 1, gpuCount: 2 },
        scope,
      ),
    ).resolves.toBe(2);
    await expect(
      getDeploymentStore().getById(original.id),
    ).resolves.toMatchObject({
      generation: 2,
      gpuCount: 2,
      maxConcurrentJobsPerReplica: 1,
      config: original.config,
    });
  });

  it('0036/S6 rolls back generation and parent controls if the spec update fails', async () => {
    const original = input();
    await getDeploymentStore().create(original, scope);
    const before = await getDeploymentStore().getById(original.id);
    await getDB()
      .query(`CREATE TRIGGER fail_deployment_spec_update BEFORE UPDATE ON container_specs
      BEGIN SELECT RAISE(ABORT, 'injected child update failure'); END`);
    await expect(
      getDeploymentStore().update(
        { ...original, expectedGeneration: 1, gpuCount: 2 },
        scope,
      ),
    ).rejects.toThrow('injected child update failure');
    expect(await getDeploymentStore().getById(original.id)).toEqual(before);
  });

  it('0036/S5 rejects a missing child and rolls back the attempted generation advance', async () => {
    const original = input();
    await getDeploymentStore().create(original, scope);
    // Deliberately emulate a corrupt database, bypassing the production no-detach guard.
    await getDB().query('DROP TRIGGER container_specs_no_detach');
    await getDB().query('DELETE FROM container_specs WHERE deployment_id = ?', [
      original.id,
    ]);
    await expect(getDeploymentStore().getById(original.id)).rejects.toThrow(
      'Deployment deployment-a: missing container spec',
    );
    await expect(
      getDeploymentStore().getMetadataById(original.id),
    ).rejects.toThrow('Deployment deployment-a: missing container spec');
    await expect(
      getDeploymentStore().getMetadataForScope(original.id, scope),
    ).rejects.toThrow('Deployment deployment-a: missing container spec');
    await expect(
      getDeploymentStore().update(
        { ...original, expectedGeneration: 1 },
        scope,
      ),
    ).rejects.toThrow('expected exactly one container spec update');
    expect(
      await getDB().query('SELECT generation FROM deployments WHERE id = ?', [
        original.id,
      ]),
    ).toEqual([{ generation: 1 }]);
  });

  it('0036/S7 decodes one captured joined snapshot even if another update commits before decryption', async () => {
    const original = input();
    await getDeploymentStore().create(original, scope);
    const database = getDB();
    let reads = 0;
    const racingDatabase: DB = {
      transaction: database.transaction.bind(database),
      read: database.read.bind(database),
      async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
        const rows = await database.query<T>(sql, params);
        reads += 1;
        await getDeploymentStore().update(
          {
            ...original,
            expectedGeneration: 1,
            gpuCount: 2,
            maxConcurrentJobsPerReplica: 3,
            config: makeContainerSpec({
              image: 'new:image',
              env: { VERSION: 'new' },
            }),
          },
          scope,
        );
        return rows;
      },
    };
    const snapshot = await new DeploymentStore(racingDatabase).getById(
      original.id,
    );
    expect(reads).toBe(1);
    expect(snapshot).toMatchObject({
      generation: 1,
      gpuCount: 0,
      maxConcurrentJobsPerReplica: 1,
      config: original.config,
    });
    await expect(
      getDeploymentStore().getById(original.id),
    ).resolves.toMatchObject({
      generation: 2,
      gpuCount: 2,
      maxConcurrentJobsPerReplica: 3,
      config: { image: 'new:image' },
    });
  });

  it('0036/S26 discovers only live Deployment IDs without decoding their container configuration', async () => {
    for (const id of ['deployment-a', 'deployment-b', 'deployment-c']) {
      await getDeploymentStore().create({ ...input(), id, name: id }, scope);
    }
    await getDeploymentStore().requestDeletion('deployment-b', scope);
    await getDeploymentStore().requestDeletion('deployment-c', scope);
    await expect(
      getDeploymentStore().markDeleted('deployment-c'),
    ).resolves.toBe(true);
    await getDB().query('UPDATE deployments SET created_at = 1');
    await getDB().query('UPDATE container_specs SET env = ?', [
      'unreadable-secret-ciphertext',
    ]);

    await expect(getDeploymentStore().listForReconciliation()).resolves.toEqual(
      ['deployment-a', 'deployment-b'],
    );
    await expect(getDeploymentStore().getById('deployment-a')).rejects.toThrow(
      'Deployment deployment-a: invalid env',
    );
  });

  it.each([
    { field: 'command', column: 'command', value: '[7]' },
    { field: 'dockerOptions', column: 'docker_options', value: '{"cpus":7}' },
    {
      field: 'dockerOptions',
      column: 'docker_options',
      value: '{"privileged":"true"}',
    },
    {
      field: 'registryUsername',
      column: 'registry_username',
      value: 'sensitive-invalid-ciphertext',
    },
    {
      field: 'registryToken',
      column: 'registry_token',
      value: 'sensitive-invalid-ciphertext',
    },
  ])(
    '0036/S18 identifies Deployment and $field without exposing stored values',
    async ({ field, column, value }) => {
      await getDeploymentStore().create(input(), scope);
      await getDB().query(
        `UPDATE container_specs SET ${column} = ? WHERE deployment_id = ?`,
        [value, 'deployment-a'],
      );
      await expect(
        getDeploymentStore().getById('deployment-a'),
      ).rejects.toMatchObject({
        message: `Deployment deployment-a: invalid ${field}`,
      });
    },
  );

  it('0036/S18 rejects a decrypted environment with non-string values', async () => {
    await getDeploymentStore().create(input(), scope);
    await getDB().query(
      'UPDATE container_specs SET env = ? WHERE deployment_id = ?',
      [await encryptSecret('{"sensitive-canary":7}'), 'deployment-a'],
    );
    await expect(
      getDeploymentStore().getById('deployment-a'),
    ).rejects.toMatchObject({
      message: 'Deployment deployment-a: invalid env',
    });
  });

  it.each([-1, 1.5, Number.NaN])(
    'rejects invalid GPU count %s before either owner row is written',
    async (gpuCount) => {
      await expect(
        getDeploymentStore().create({ ...input(), gpuCount }, scope),
      ).rejects.toThrow(
        'Deployment deployment-a gpuCount must be a nonnegative integer',
      );
      expect(await getDB().query('SELECT * FROM deployments')).toEqual([]);
    },
  );

  it.each([
    { gpus: 'all', gpuCount: 4 },
    { gpus: '2', gpuCount: 2 },
  ])(
    '0036/S18 round-trips raw GPU intent beside resolved count: %j',
    async ({ gpus, gpuCount }) => {
      const original = input();
      const config = {
        ...original.config,
        dockerOptions: { gpus, runtime: 'nvidia' },
      };
      await getDeploymentStore().create(
        { ...original, config, gpuCount, reservation: { maxGpus: gpuCount } },
        scope,
      );
      await expect(
        getDeploymentStore().getById(original.id),
      ).resolves.toMatchObject({
        gpuCount,
        config,
      });
      await getDeploymentStore().update(
        {
          ...original,
          config,
          gpuCount,
          expectedGeneration: 1,
          maxConcurrentJobsPerReplica: 2,
        },
        scope,
      );
      await expect(
        getDeploymentStore().getById(original.id),
      ).resolves.toMatchObject({
        generation: 2,
        gpuCount,
        config,
      });
    },
  );

  it('0036/S18 rejects malformed stored GPU intent without coercing it', async () => {
    await getDeploymentStore().create(input(), scope);
    await getDB().query(
      'UPDATE container_specs SET docker_options = ? WHERE deployment_id = ?',
      ['{"gpus":1}', 'deployment-a'],
    );
    await expect(
      getDeploymentStore().getById('deployment-a'),
    ).rejects.toMatchObject({
      message: 'Deployment deployment-a: invalid dockerOptions',
    });
  });

  it('rejects malformed stored GPU count without coercing it', async () => {
    await getDeploymentStore().create(input(), scope);
    await getDB().query('PRAGMA ignore_check_constraints = ON');
    await getDB().query('UPDATE deployments SET gpu_count = -1 WHERE id = ?', [
      'deployment-a',
    ]);
    await getDB().query('PRAGMA ignore_check_constraints = OFF');
    await expect(
      getDeploymentStore().getById('deployment-a'),
    ).rejects.toMatchObject({
      message: 'Deployment deployment-a gpuCount must be a nonnegative integer',
    });
  });

  describe('targeting a node pool', () => {
    const nodePoolId = 'node-pool-aws-east';

    async function seedNodePool(
      id = nodePoolId,
      ready = true,
      ownerUserId = 'deployment-owner',
    ): Promise<void> {
      await seedReadyNodePool({
        nodePoolId: id,
        ownerUserId,
        vmType: 'g6.xlarge',
        minVmCount: 2,
        maxVmCount: 2,
        ready,
      });
    }

    function nodePoolInput(
      overrides: Partial<CreateDeploymentInput> = {},
    ): CreateDeploymentInput {
      return {
        ...input(),
        nodePoolId,
        ...overrides,
      };
    }

    it('admits only against a Ready node pool the scope may use and records the immutable target', async () => {
      await seedNodePool('node-pool-creating', false);
      await expect(
        getDeploymentStore().create(
          nodePoolInput({ nodePoolId: 'node-pool-creating' }),
          scope,
        ),
      ).resolves.toBe(false);
      await seedNodePool();
      await expect(
        getDeploymentStore().create(nodePoolInput(), scope),
      ).resolves.toBe(true);
      await expect(
        getDeploymentStore().getById('deployment-a'),
      ).resolves.toMatchObject({ nodePoolId });
      await expect(
        getDeploymentStore().getMetadataById('deployment-a'),
      ).resolves.toEqual({
        id: 'deployment-a',
        nodePoolId,
        managed: false,
        deletionRequestedAt: null,
        deletedAt: null,
      });
      await expect(
        getDB().query(
          `UPDATE deployments SET node_pool_id = 'node-pool-other' WHERE id = 'deployment-a'`,
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        getDB().query(
          `INSERT INTO deployments (id, owner_user_id, name, node_pool_id, gpu_count, created_at, updated_at)
           VALUES ('untargeted', 'deployment-owner', 'untargeted', NULL, 0, 1, 1)`,
        ),
      ).rejects.toThrow(/NOT NULL constraint failed/);
    });

    it('reserves gpu_count × max replicas at create and when an update raises the maximum', async () => {
      await seedNodePool();
      const store = getDeploymentStore();
      const create = (id: string, gpuCount: number, replicas: number) =>
        store.create(
          nodePoolInput({
            id,
            name: id,
            gpuCount,
            minReplicas: 1,
            maxReplicas: replicas,
            reservation: { maxGpus: 4 },
          }),
          scope,
        );
      // Four devices: two replicas of one GPU, then one of two, fill them.
      await expect(create('two', 1, 2)).resolves.toBe(true);
      await expect(create('too-many', 1, 3)).resolves.toBe(false);
      await expect(create('fits', 2, 1)).resolves.toBe(true);
      expect((await store.getById('two'))?.maxReplicas).toBe(2);
      // The pool is full: adding a replica is refused, and keeping the
      // count (omitted) while changing nothing else still fits.
      const current = (await store.getById('two'))!;
      const update = {
        id: 'two',
        expectedGeneration: current.generation,
        config: current.config,
        secretNames: [],
        gpuCount: 1,
        maxConcurrentJobsPerReplica: 1,
        reservation: { maxGpus: 4 },
      };
      await expect(
        store.update({ ...update, maxReplicas: 3 }, scope),
      ).resolves.toBe('gpu-reserved');
      await expect(store.update(update, scope)).resolves.toBe(2);
      expect((await store.getById('two'))?.maxReplicas).toBe(2);
    });

    it('admits only one concurrent create when each needs the remaining two GPUs', async () => {
      await seedNodePool();
      const store = getDeploymentStore();
      const results = await Promise.all(
        ['first', 'second'].map((id) =>
          store.create(
            nodePoolInput({
              id,
              name: id,
              gpuCount: 1,
              maxReplicas: 2,
              reservation: { maxGpus: 2 },
            }),
            scope,
          ),
        ),
      );
      expect(results.sort()).toEqual([false, true]);
      const rows = await store.listForScope(scope);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ gpuCount: 1, maxReplicas: 2 });
    });

    it('fences GPU reservations against the bound observed at admission', async () => {
      await seedNodePool();
      const store = getDeploymentStore();
      // Two ready g6.xlarge Nodes: 2 devices in total.
      await expect(
        store.create(
          nodePoolInput({
            id: 'gpu-1',
            name: 'gpu-1',
            gpuCount: 1,
            reservation: { maxGpus: 2 },
          }),
          scope,
        ),
      ).resolves.toBe(true);
      await expect(
        store.create(
          nodePoolInput({
            id: 'gpu-2',
            name: 'gpu-2',
            gpuCount: 2,
            reservation: { maxGpus: 2 },
          }),
          scope,
        ),
      ).resolves.toBe(false);
      await expect(
        store.create(
          nodePoolInput({
            id: 'gpu-3',
            name: 'gpu-3',
            gpuCount: 1,
            reservation: { maxGpus: 2 },
          }),
          scope,
        ),
      ).resolves.toBe(true);
      // CPU Deployments reserve no devices and need no bound.
      await expect(
        store.create(nodePoolInput({ id: 'cpu', name: 'cpu' }), scope),
      ).resolves.toBe(true);
      await expect(
        store.create(
          nodePoolInput({ id: 'gpu-4', name: 'gpu-4', gpuCount: 1 }),
          scope,
        ),
      ).rejects.toThrow(/requires a reservation bound/);
      // Released reservations free their devices.
      await store.requestDeletion('gpu-1', scope);
      await store.markDeleted('gpu-1');
      await expect(
        store.create(
          nodePoolInput({
            id: 'gpu-5',
            name: 'gpu-5',
            gpuCount: 1,
            reservation: { maxGpus: 2 },
          }),
          scope,
        ),
      ).resolves.toBe(true);
    });

    function createGpuService(
      id: string,
      gpus: number,
      pool = nodePoolId,
    ): Promise<void> {
      return createWorkload(getDB(), {
        id,
        userId: 'owner',
        ownerUserId: 'deployment-owner',
        workloadType: WorkloadType.Service,
        image: 'example/service:latest',
        dockerCommand: '',
        sshPrivateKey: '',
        nodePoolId: pool,
        dockerOptions: gpus > 0 ? { gpus: String(gpus) } : undefined,
        nodePoolGpuBound: gpus > 0 ? 2 : undefined,
      });
    }

    it('reserves node pool GPUs across Deployments and Services', async () => {
      await seedNodePool();
      const store = getDeploymentStore();
      const gpuDeployment = (id: string, gpuCount: number, pool = nodePoolId) =>
        store.create(
          nodePoolInput({
            id,
            name: id,
            nodePoolId: pool,
            gpuCount,
            reservation: { maxGpus: 2 },
          }),
          scope,
        );
      // Two ready g6.xlarge Nodes: 2 devices in total.
      await createGpuService('service-1', 1);
      await expect(gpuDeployment('gpu-2', 2)).resolves.toBe(false);
      await expect(gpuDeployment('gpu-1', 1)).resolves.toBe(true);
      await expect(createGpuService('service-2', 1)).rejects.toThrow(
        /GPU capacity is reserved/,
      );
      await expect(queries().getWorkload('service-2')).resolves.toBeNull();
      // CPU Services reserve nothing; a cleaned-up Service frees its devices.
      await expect(createGpuService('cpu-service', 0)).resolves.toBeUndefined();
      await getDB().query(
        `UPDATE workloads SET cleaned_at = 1 WHERE id = 'service-1'`,
      );
      await expect(createGpuService('service-3', 1)).resolves.toBeUndefined();

      // Concurrent admissions for the last devices: exactly one is stored.
      await seedNodePool('node-pool-race');
      const results = await Promise.allSettled([
        createGpuService('race-service', 2, 'node-pool-race'),
        gpuDeployment('race-deployment', 2, 'node-pool-race'),
      ]);
      const stored =
        (results[0].status === 'fulfilled' ? 1 : 0) +
        (results[1].status === 'fulfilled' && results[1].value ? 1 : 0);
      expect(stored).toBe(1);
    });

    it('fences a raised GPU count against the node pool reservation on update', async () => {
      await seedNodePool();
      const store = getDeploymentStore();
      // Two ready g6.xlarge Nodes: 2 devices; a Service holds one of them.
      await createGpuService('service-1', 1);
      const created = nodePoolInput({
        gpuCount: 1,
        reservation: { maxGpus: 2 },
      });
      await expect(store.create(created, scope)).resolves.toBe(true);
      const raise = {
        ...created,
        secretNames: [],
        expectedGeneration: 1,
        gpuCount: 2,
      };
      await expect(
        store.update({ ...raise, reservation: { maxGpus: 2 } }, scope),
      ).resolves.toBe('gpu-reserved');
      // A stale request is a generation conflict, not a capacity refusal.
      await expect(
        store.update(
          { ...raise, expectedGeneration: 0, reservation: { maxGpus: 2 } },
          scope,
        ),
      ).resolves.toBeNull();
      await expect(store.getById(created.id)).resolves.toMatchObject({
        gpuCount: 1,
        generation: 1,
      });
      // The Deployment's own devices count once: 1 held by it + 1 by the Service.
      await expect(
        store.update(
          { ...raise, gpuCount: 1, reservation: { maxGpus: 2 } },
          scope,
        ),
      ).resolves.toBe(2);
      await getDB().query(
        `UPDATE workloads SET cleaned_at = 1 WHERE id = 'service-1'`,
      );
      await expect(
        store.update(
          { ...raise, expectedGeneration: 2, reservation: { maxGpus: 2 } },
          scope,
        ),
      ).resolves.toBe(3);
    });

    it('counts live references and filters listings by node pool', async () => {
      await seedNodePool();
      await seedNodePool('node-pool-sibling');
      const store = getDeploymentStore();
      await store.create(nodePoolInput(), scope);
      await store.create(
        nodePoolInput({
          id: 'deployment-b',
          name: 'other',
          nodePoolId: 'node-pool-sibling',
        }),
        scope,
      );
      await store.create(
        { ...input(), id: 'deployment-c', name: 'first-pool' },
        scope,
      );
      await expect(store.countLiveForNodePool(nodePoolId)).resolves.toBe(1);
      expect(
        (await store.listForScope(scope, { nodePoolId })).map((d) => d.id),
      ).toEqual(['deployment-a']);
      expect(
        (await store.listForScope(scope, { nodePoolId: 'node-pool-a' })).map(
          (d) => d.id,
        ),
      ).toEqual(['deployment-c']);
      expect((await store.listForScope(scope)).map((d) => d.id)).toEqual([
        'deployment-a',
        'deployment-b',
        'deployment-c',
      ]);
      await store.requestDeletion('deployment-a', scope);
      await expect(store.countLiveForNodePool(nodePoolId)).resolves.toBe(1);
      await store.markDeleted('deployment-a');
      await expect(store.countLiveForNodePool(nodePoolId)).resolves.toBe(0);
      await expect(
        store.countLiveForNodePool('node-pool-sibling'),
      ).resolves.toBe(1);
    });

    it('C11 lists the live managed Deployments on the pool, latest Job first, with whether each holds a pull token', async () => {
      await seedNodePool();
      await seedNodePool('node-pool-sibling');
      const store = getDeploymentStore();
      const deployments: Array<[string, Partial<CreateDeploymentInput>]> = [
        ['public', {}],
        [
          'private',
          {
            config: makeContainerSpec({
              image: 'ghcr.io/org/private:latest',
              imageDigest: 'sha256:private',
              registryToken: 'gho_member',
            }),
          },
        ],
        ['draining', {}],
        ['sibling', { nodePoolId: 'node-pool-sibling' }],
        ['unmanaged', {}],
      ];
      for (const [index, [id, overrides]] of deployments.entries()) {
        await store.create(
          nodePoolInput({
            id,
            name: id,
            config: makeContainerSpec({
              image: 'example/public:latest',
              imageDigest: 'sha256:public',
            }),
            ...overrides,
          }),
          scope,
        );
        await getDB().query(
          'UPDATE deployments SET created_at = ? WHERE id = ?',
          [index, id],
        );
      }
      await getDB().query(
        "UPDATE deployments SET managed = 1 WHERE id != 'unmanaged'",
      );
      await store.requestDeletion('draining', scope);
      // The oldest Deployment ran the latest Job, so it ranks before a newer
      // one with no Job yet.
      await getDB().query(
        `INSERT INTO workloads (id, user_id, workload_type, state, started_at,
           submitted_at, docker_command, ssh_private_key, deployment_id)
         VALUES ('job', 'owner', 'job', 'completed', 10, 10, '', '', 'public')`,
      );
      await expect(store.listLiveManagedImages(nodePoolId)).resolves.toEqual([
        {
          image: 'example/public:latest',
          imageDigest: 'sha256:public',
          registryToken: false,
        },
        {
          image: 'ghcr.io/org/private:latest',
          imageDigest: 'sha256:private',
          registryToken: true,
        },
      ]);
    });
  });
});

describe('pool occupancy (SPEND)', () => {
  const nodePoolId = 'node-pool-a';

  async function seedVm(pricePerHour: number | undefined): Promise<number> {
    const ref = await getPersistence().nodePoolVms.beginVmAttempt(nodePoolId, {
      cloudId: `vm-${pricePerHour}`,
      region: 'us-east-1',
      availabilityZone: null,
      vmType: 'p5.48xlarge',
      pricePerHour,
      desiredVmCount: 2,
    });
    return ref!.vmRowId;
  }

  const rows = () =>
    getDB().query<Record<string, unknown>>(
      `SELECT pod_uid, vm_id, node_pool_id, share, gpus, hourly_usd,
         opened_at, ended_at
       FROM pool_occupancy ORDER BY id`,
    );

  beforeEach(async () => {
    resetPersistence();
    await seedReadyNodePool({ nodePoolId, ownerUserId: 'deployment-owner' });
    await getDeploymentStore().create(input(), scope);
  });

  it('opens a row per held replica at its share of the VM price, once', async () => {
    const vmId = await seedVm(80);
    const uncatalogued = await seedVm(undefined);
    const held = [
      { podUid: 'pod-1', vmId, share: 0.125, gpus: 1 },
      { podUid: 'pod-2', vmId: uncatalogued, share: 0.5, gpus: 4 },
    ];
    const live = held.map((replica) => replica.podUid);
    await getDeploymentStore().recordOccupancy(
      'deployment-a',
      held,
      live,
      1_000,
    );
    await getDeploymentStore().recordOccupancy(
      'deployment-a',
      held,
      live,
      2_000,
    );
    expect(await rows()).toEqual([
      {
        pod_uid: 'pod-1',
        vm_id: vmId,
        node_pool_id: nodePoolId,
        share: 0.125,
        gpus: 1,
        hourly_usd: 10,
        opened_at: 1_000,
        ended_at: null,
      },
      expect.objectContaining({
        pod_uid: 'pod-2',
        hourly_usd: null,
        opened_at: 1_000,
      }),
    ]);
  });

  it('ends the rows of replicas whose Pods are over or gone, and only those', async () => {
    const vmId = await seedVm(80);
    const replica = (podUid: string) => ({
      podUid,
      vmId,
      share: 0.25,
      gpus: 2,
    });
    await getDeploymentStore().recordOccupancy(
      'deployment-a',
      [replica('pod-1'), replica('pod-2')],
      ['pod-1', 'pod-2'],
      1_000,
    );
    // pod-2 is live but its Node didn't resolve this pass: its row stays.
    await getDeploymentStore().recordOccupancy(
      'deployment-a',
      [replica('pod-3')],
      ['pod-2', 'pod-3'],
      2_000,
    );
    await getDeploymentStore().recordOccupancy('deployment-a', [], [], 3_000);
    expect(
      (await rows()).map(({ pod_uid, opened_at, ended_at }) => [
        pod_uid,
        opened_at,
        ended_at,
      ]),
    ).toEqual([
      ['pod-1', 1_000, 2_000],
      ['pod-2', 1_000, 3_000],
      ['pod-3', 2_000, 3_000],
    ]);
  });

  it('reports replica time, busy where an attempt covers it, priced at each share', async () => {
    const vmId = await seedVm(80);
    const h = 3_600_000;
    const replica = (podUid: string) => ({
      podUid,
      vmId,
      share: 0.125,
      gpus: 1,
    });
    const store = getDeploymentStore();
    await store.recordOccupancy(
      'deployment-a',
      [replica('pod-1')],
      ['pod-1'],
      0,
    );
    await store.recordOccupancy(
      'deployment-a',
      [replica('pod-2')],
      ['pod-2'],
      4 * h,
    );
    await createWorkload(getDB(), {
      id: 'job',
      userId: 'owner',
      ownerUserId: 'deployment-owner',
      workloadType: WorkloadType.Job,
      image: 'example/job:latest',
      dockerCommand: '',
      sshPrivateKey: '',
    });
    // Two overlapping Jobs, then one still running when pod-1 ended.
    for (const [n, from, to] of [
      [1, 1 * h, 2 * h],
      [2, 1.5 * h, 2.5 * h],
      [3, 3.5 * h, null],
    ] as const) {
      const [{ id }] = await getDB().query<{ id: number }>(
        `INSERT INTO workload_attempts (workload_id, attempt, execution_id,
           substrate, outcome, opened_at, ended_at)
         VALUES ('job', ?, ?, 'pod', ?, ?, ?) RETURNING id`,
        [n, `execution-${n}`, to === null ? null : 'completed', from, to],
      );
      await getDB().query(
        `INSERT INTO pod_attempts (attempt_id, pod_uid) VALUES (?, 'pod-1')`,
        [id],
      );
    }
    // pod-1 held 0–4 h, 2 h of it busy; pod-2 has held 4–5 h, idle.
    expect(await store.getUsage('deployment-a', 5 * h)).toEqual({
      replicaHours: 5,
      busyHours: 2,
      costUsd: 50,
      busyCostUsd: 20,
    });
  });

  it('charges slot time to the Job session: cost --session always, burn and spend only on managed Deployments', async () => {
    const vmId = await seedVm(80);
    const h = 3_600_000;
    const now = Date.now();
    // The replica holds half an $80/h Node, and each of its 4 slots $10/h.
    await getDB().query(
      `UPDATE deployments SET max_concurrent_jobs_per_replica = 4`,
    );
    await getDeploymentStore().recordOccupancy(
      'deployment-a',
      [{ podUid: 'pod-1', vmId, share: 0.5, gpus: 4 }],
      ['pod-1'],
      now - 4 * h,
    );
    await getWorkloadAdmissionWriter().createTargetedWorkload({
      id: 'job',
      userId: 'owner',
      ownerUserId: 'deployment-owner',
      deploymentId: 'deployment-a',
      session: 's1',
    });
    // One attempt held a slot 1 h; its retry has held one for 1 h so far.
    for (const [n, from, to] of [
      [1, now - 3 * h, now - 2 * h],
      [2, now - h, null],
    ] as const) {
      const [{ id }] = await getDB().query<{ id: number }>(
        `INSERT INTO workload_attempts (workload_id, attempt, execution_id,
           substrate, outcome, opened_at, ended_at)
         VALUES ('job', ?, ?, 'pod', ?, ?, ?) RETURNING id`,
        [n, `execution-${n}`, to === null ? null : 'retrying', from, to],
      );
      await getDB().query(
        `INSERT INTO pod_attempts (attempt_id, pod_uid) VALUES (?, 'pod-1')`,
        [id],
      );
    }
    const report = (session?: string) =>
      getWorkloadSpendStore().getCostReportInWindow(
        scope,
        now - 24 * h,
        now + h,
        session ? { session, sessionExact: true } : undefined,
      );
    const window = { windowStartMs: now - 24 * h, windowEndMs: now + h };
    expect((await report('s1')).totalCost).toBeCloseTo(20, 2);
    // The Node's VM already counts at account scope.
    expect((await report()).totalCost).toBe(0);
    // A user Deployment's slot time never enters burn or spend.
    expect(await currentBurnRate({ sessionFilter: 's1' })).toBe(0);
    expect(
      (await computeSpend({ ...window, sessionFilter: 's1' })).totalUsd,
    ).toBe(0);

    await getDB().query('UPDATE deployments SET managed = 1');
    expect(await currentBurnRate({ sessionFilter: 's1' })).toBe(10);
    expect(
      (await computeSpend({ ...window, sessionFilter: 's1' })).totalUsd,
    ).toBeCloseTo(20, 2);
    // Account burn is the Node's VM alone, which counts while it provisions.
    expect(await currentBurnRate({ sessionFilter: null })).toBe(80);
  });
});
