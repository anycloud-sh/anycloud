import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JobSpecInput } from '../../../src/shared/api-contract/workload-admission-schemas.js';
import type { DeploymentMetadata } from '../../../src/api/services/deployment-store.js';
import {
  getDeploymentStore,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import * as secretCrypto from '../../../src/api/services/secret-crypto.js';
import { persistTargetedWorkload } from '../../../src/api/services/workload-admission-persistence.js';
import {
  submitTargetedJob,
  type TargetedJobAdmissionDependencies,
} from '../../../src/api/services/targeted-job-admission.js';
import type { User } from '../../../src/api/services/entities.js';
import {
  InvalidAnycloudConfigError,
  WorkloadIdExistsError,
} from '../../../src/shared/errors.js';
import { makeContainerSpec } from '../helpers/fixtures.js';
import { seedReadyNodePool } from '../helpers/node-pool-seed.js';

const actor: User = {
  id: 'user-id',
  username: 'user',
  token: 'github-token',
};

const deploymentName = 'deployment';
const target: DeploymentMetadata = {
  id: 'deployment-id',
  nodePoolId: 'node-pool-id',
  managed: false,
  deletionRequestedAt: null,
  deletedAt: null,
};

function dependencies(): TargetedJobAdmissionDependencies {
  return {
    deployments: {
      getMetadataForScope: vi.fn(async () => target),
    },
    persist: vi.fn(async () => true),
    resolveScope: vi.fn(async () => ({ kind: 'api' }) as const),
    validateId: vi.fn(async (id) => id),
    now: () => 1000,
  };
}

describe('targeted Job admission', () => {
  afterEach(() => vi.restoreAllMocks());
  it('0036/S24 persists only target identity and attribution for an explicit Job ID', async () => {
    const deps = dependencies();
    const result = await submitTargetedJob(deps, actor, {
      deployment: deploymentName,
      id: 'job-id',
      session: ' session-id ',
      agent: ' agent-name ',
      sessionLabel: ' session label ',
    });

    expect(result).toEqual({
      id: 'job-id',
      submissionRevision: 0,
      claimDeadlineAt: null,
    });
    expect(deps.deployments.getMetadataForScope).toHaveBeenCalledWith(
      deploymentName,
      {
        kind: 'api',
      },
    );
    expect(deps.validateId).toHaveBeenCalledWith('job-id');
    expect(deps.persist).toHaveBeenCalledExactlyOnceWith({
      id: 'job-id',
      userId: actor.username,
      ownerUserId: actor.id,
      deploymentId: target.id,
      claimDeadlineAt: null,
      session: 'session-id',
      agent: 'agent-name',
      sessionLabel: 'session label',
    });
  });

  it('0046/S20 admits default Job spec fields', async () => {
    const deps = dependencies();
    await expect(
      submitTargetedJob(deps, actor, {
        deployment: deploymentName,
        id: 'job-id',
        nodes: 1,
        launch: 'single',
        mounts: [],
        resumable: false,
      }),
    ).resolves.toEqual({
      id: 'job-id',
      submissionRevision: 0,
      claimDeadlineAt: null,
    });
    expect(deps.persist).toHaveBeenCalledOnce();
  });

  it.each<[JobSpecInput, string]>([
    [{ nodes: 2 }, 'nodes 2 \\(--nodes\\)'],
    [{ launch: 'distributed' }, 'launch distributed'],
    [{ mounts: [{ name: 'state', path: '/state' }] }, 'mounts'],
    [{ timeLimit: 60 }, 'timeLimit'],
    [{ resumable: true }, 'resumable'],
    [{ gpusPerNode: 4 }, 'gpusPerNode 4 \\(--gpus-per-node\\) yet'],
  ])(
    '0046/S21 refuses %j on a Deployment before storing anything',
    async (spec, flag) => {
      const deps = dependencies();
      const refusal = submitTargetedJob(deps, actor, {
        deployment: deploymentName,
        ...spec,
      });
      await expect(refusal).rejects.toThrow(InvalidAnycloudConfigError);
      await expect(refusal).rejects.toThrow(
        new RegExp(`^A Job on a Deployment .*${flag}`),
      );
      expect(deps.validateId).not.toHaveBeenCalled();
      expect(deps.persist).not.toHaveBeenCalled();
    },
  );

  it('starts the deadline before admission dependencies and returns its receipt', async () => {
    const deps = dependencies();
    let now = 1000;
    deps.now = () => now;
    vi.mocked(deps.validateId).mockImplementation(async (id) => {
      now += 2000;
      return id;
    });
    await expect(
      submitTargetedJob(deps, actor, {
        deployment: deploymentName,
        id: 'job-timed',
        timeout: 3,
      }),
    ).resolves.toEqual({
      id: 'job-timed',
      submissionRevision: 0,
      claimDeadlineAt: 4000,
    });
    expect(deps.persist).toHaveBeenCalledWith(
      expect.objectContaining({ claimDeadlineAt: 4000 }),
    );
  });

  it('does not persist when cancellation wins during validation', async () => {
    const deps = dependencies();
    const controller = new AbortController();
    const reason = new Error('request cancelled');
    vi.mocked(deps.validateId).mockImplementation(async (id) => {
      controller.abort(reason);
      return id;
    });
    await expect(
      submitTargetedJob(
        deps,
        actor,
        {
          deployment: deploymentName,
          id: 'job-cancelled',
          timeout: 0,
        },
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it('0036/S24 admits a generated ID through the real repository without selecting or decrypting Deployment configuration', async () => {
    resetPersistence();
    await seedReadyNodePool({
      nodePoolId: target.nodePoolId,
      ownerUserId: actor.id,
    });
    await getDeploymentStore().create(
      {
        id: target.id,
        name: deploymentName,
        ownerUserId: actor.id,
        nodePoolId: target.nodePoolId,
        config: makeContainerSpec({
          env: { PRIVATE: 'environment-canary' },
          registryUsername: 'registry-user',
          registryToken: 'registry-canary',
        }),
        gpuCount: 0,
        maxConcurrentJobsPerReplica: 1,
      },
      { kind: 'api' },
    );
    const decrypt = vi
      .spyOn(secretCrypto, 'decryptSecret')
      .mockRejectedValue(
        new Error(
          'Deployment configuration must not be decrypted for admission',
        ),
      );
    const query = vi.spyOn(getDB(), 'query');
    const deps = dependencies();
    deps.deployments = getDeploymentStore();
    deps.persist = persistTargetedWorkload;

    const result = await submitTargetedJob(deps, actor, {
      deployment: deploymentName,
    });

    expect(result.id).toMatch(/^job-\d{13}-[a-z0-9]{4}$/);
    expect(deps.validateId).toHaveBeenCalledWith(result.id);
    expect(decrypt).not.toHaveBeenCalled();
    const deploymentRead = query.mock.calls.find(([sql]) =>
      sql.includes('FROM deployments w'),
    );
    expect(deploymentRead).toBeDefined();
    expect(deploymentRead![0]).not.toMatch(
      /\*|\b(?:image|command|docker_options|env|registry_username|registry_token)\b/,
    );
    expect(
      await getDB().query(
        'SELECT id, deployment_id, owner_user_id FROM workloads',
      ),
    ).toEqual([
      { id: result.id, deployment_id: target.id, owner_user_id: actor.id },
    ]);
    expect(
      await getDB().query(
        'SELECT workload_id FROM container_specs WHERE workload_id = ?',
        [result.id],
      ),
    ).toEqual([]);
  });

  it('preserves explicit-ID validation failures before persistence', async () => {
    const deps = dependencies();
    const failure = new Error('invalid workload ID');
    vi.mocked(deps.validateId).mockRejectedValue(failure);
    await expect(
      submitTargetedJob(deps, actor, {
        deployment: deploymentName,
        id: 'INVALID',
      }),
    ).rejects.toBe(failure);
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it('rejects a draining target before and at insertion, not as an ID conflict', async () => {
    const draining = dependencies();
    vi.mocked(draining.deployments.getMetadataForScope).mockResolvedValue({
      ...target,
      deletionRequestedAt: 1,
    });
    const atInsertion = dependencies();
    vi.mocked(atInsertion.persist).mockResolvedValue(false);
    for (const deps of [draining, atInsertion]) {
      const attempt = submitTargetedJob(deps, actor, {
        deployment: deploymentName,
        id: 'job-id',
      });
      await expect(attempt).rejects.toBeInstanceOf(InvalidAnycloudConfigError);
      await expect(attempt).rejects.toThrow('is draining');
    }
    expect(draining.persist).not.toHaveBeenCalled();
  });

  it('refuses a managed Deployment, whose Jobs come from job --node-pool', async () => {
    const deps = dependencies();
    vi.mocked(deps.deployments.getMetadataForScope).mockResolvedValue({
      ...target,
      managed: true,
    });
    await expect(
      submitTargetedJob(deps, actor, { deployment: deploymentName }),
    ).rejects.toThrow('--node-pool');
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it('maps an insertion-time ID collision to the declared conflict', async () => {
    const deps = dependencies();
    vi.mocked(deps.persist).mockRejectedValue(
      new Error('UNIQUE constraint failed: workloads.id'),
    );

    await expect(
      submitTargetedJob(deps, actor, {
        deployment: deploymentName,
        id: 'job-id',
      }),
    ).rejects.toBeInstanceOf(WorkloadIdExistsError);
  });

  it('does not disguise unrelated persistence failures as ID conflicts', async () => {
    const deps = dependencies();
    const failure = new Error('database unavailable');
    vi.mocked(deps.persist).mockRejectedValue(failure);

    await expect(
      submitTargetedJob(deps, actor, {
        deployment: deploymentName,
        id: 'job-id',
      }),
    ).rejects.toBe(failure);
  });
});
