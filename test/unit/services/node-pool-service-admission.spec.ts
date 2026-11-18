import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../../../src/api/services/entities.js';
import type { StoredNodePool } from '../../../src/api/services/cluster-store.js';
import {
  getPersistence,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import {
  assertNodePoolServiceShape,
  submitNodePoolService,
  type NodePoolServiceAdmissionDependencies,
  type NodePoolServiceAdmissionInput,
} from '../../../src/api/services/node-pool-service-admission.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { persistNodePoolServiceWorkload } from '../../../src/api/services/workload-admission-persistence.js';
import { CloudType } from '../../../src/shared/cloud.js';
import {
  InvalidAnycloudConfigError,
  WorkloadIdExistsError,
  GithubSignInRequiredError,
} from '../../../src/shared/errors.js';
import { ImageRuntime, ImageVerdict } from '../../../src/shared/image.js';
import { NodePoolState } from '../../../src/shared/node-pools.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import { requireTestWorkload } from '../../helpers/workload-store.js';

const actor: User = {
  id: 'owner-1',
  username: 'alice',
  token: 'github-token',
};

const nodePool: StoredNodePool = {
  id: 'node-pool-aws',
  clusterId: 'cluster-a',
  ownerUserId: 'owner-1',
  name: 'aws-east',
  state: NodePoolState.Ready,
  computeCredentialId: 'compute-aws',
  cloudProvider: CloudType.AWS,
  region: 'us-east-1',
  zone: null,
  clusterRegion: null,
  vmTypes: ['t3.small'],
  minVmCount: 1,
  maxVmCount: 1,
  osDiskSizeGb: null,
  osDiskTier: null,
  spot: false,
  allowPrivilegedJobs: false,
  userNamespaceJobs: false,
  requireNestedVirtualization: false,
  lastError: null,
  provisioningFailures: 0,
  provisioningFailedAt: null,
  ingressEntryVmId: null,
  ingressEntryChangedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

function input(
  overrides: Partial<NodePoolServiceAdmissionInput> = {},
): NodePoolServiceAdmissionInput {
  return {
    image: 'ghcr.io/acme/api:v1',
    cloudConfig: {},
    workloadType: 'service',
    nodePool: 'aws-east',
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<NodePoolServiceAdmissionDependencies> = {},
): NodePoolServiceAdmissionDependencies {
  return {
    nodePools: {
      getForScope: vi.fn(async (id: string) =>
        id === nodePool.id ? nodePool : null,
      ),
      getByNameForScope: vi.fn(async (name: string) =>
        name === nodePool.name ? nodePool : null,
      ),
    },
    resolveScope: vi.fn(async () => ({ kind: 'api' }) as const),
    observeCapacity: vi.fn(async () => ({
      readyVmCount: 1,
      startingVmCount: 0,
      drainingVmCount: 0,
      locations: [],
    })),
    assertClusterCompatible: vi.fn(async () => undefined),
    inspectImage: vi.fn(async () => ({
      verdict: ImageVerdict.Ok,
      amd64Digest: 'sha256:' + 'a'.repeat(64),
      imageRuntime: ImageRuntime.Unknown,
      compressedLayerBytes: null,
    })),
    preflightSecrets: vi.fn(async () => undefined),
    validateId: vi.fn(async (id: string) => id),
    persist: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('node pool Service admission shape', () => {
  it('accepts a Service with only image, command, env, Secrets and Docker runtime options', () => {
    expect(() =>
      assertNodePoolServiceShape(
        input({
          command: ['node', 'server.js'],
          env: { PORT: '9000' },
          secrets: ['api-keys'],
          dockerOptions: { memory: '2g', cpus: '1' },
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    [{ workloadType: 'vm' as const }, 'Only Services and Jobs'],
    [{ image: 'ghcr.io/anycloud-sh/api:1.0.0' }, 'system installation'],
    [{ credentialName: 'my-aws' }, 'compute credentials'],
    [{ cloudConfig: { cloudProvider: CloudType.AWS } }, 'cloudProvider'],
    [{ cloudConfig: { region: 'us-east-1' } }, '--region'],
    [{ cloudConfig: { vmType: 't3.small' } }, '--vm-type'],
    [{ gpuType: 'h100' }, '--gpu-type'],
    [{ cloudConfig: { spot: true } }, '--spot'],
    [{ cloudConfig: { availabilityZone: 'us-east-1a' } }, '--zone'],
    [{ cloudConfig: { diskSizeGb: 100 } }, '--disk-size'],
    [{ cloudConfig: { minVmCount: 1 } }, 'VM counts'],
    [{ cloudConfig: { outputBucket: 'out' } }, 'input/output buckets'],
    [
      { inputStorageCredentialName: 'store' },
      'input/output storage credentials',
    ],
    [{ cloudConfig: { checkpointBucket: 'state' } }, 'checkpoint storage'],
    [{ checkpointStorageCredentialName: 'store' }, 'checkpoint storage'],
    [{ env: { PORT: 'http' } }, 'PORT must be an integer'],
    [
      { nodes: 2 },
      'A Service on a node pool does not accept nodes 2 (--nodes)',
    ],
    [
      { gpusPerNode: 1 },
      'A Service on a node pool does not accept gpusPerNode 1 (--gpus-per-node) yet.',
    ],
    [{ timeLimit: 60 }, 'A Service on a node pool does not accept timeLimit'],
  ])('rejects %j before any lookup', (overrides, message) => {
    expect(() => assertNodePoolServiceShape(input(overrides))).toThrow(message);
    expect(() => assertNodePoolServiceShape(input(overrides))).toThrow(
      InvalidAnycloudConfigError,
    );
  });
});

describe('node pool Service admission', () => {
  it('resolves the node pool by name, verifies capacity and cluster, and persists the Service intent', async () => {
    const deps = dependencies();
    const result = await submitNodePoolService(deps, actor, {
      ...input({
        id: 'svc-a',
        command: ['node', 'server.js'],
        env: { MODE: 'prod' },
        secrets: ['api-keys'],
        session: ' s1 ',
      }),
    });
    expect(result).toEqual({ id: 'svc-a', url: 'https://svc-a.anycloud.sh' });
    expect(deps.observeCapacity).toHaveBeenCalledWith(nodePool.id);
    expect(deps.assertClusterCompatible).toHaveBeenCalledWith(
      nodePool.clusterId,
      undefined,
    );
    expect(deps.preflightSecrets).toHaveBeenCalledWith(['api-keys']);
    expect(deps.inspectImage).toHaveBeenCalledWith(
      'ghcr.io/acme/api:v1',
      'github-token',
    );
    expect(deps.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'svc-a',
        userId: 'alice',
        ownerUserId: 'owner-1',
        workloadType: 'service',
        image: 'ghcr.io/acme/api:v1',
        imageDigest: 'sha256:' + 'a'.repeat(64),
        nodePoolId: nodePool.id,
        dockerCommand: '',
        sshPrivateKey: '',
        command: ['node', 'server.js'],
        env: { MODE: 'prod' },
        secretNames: ['api-keys'],
        githubToken: 'github-token',
        session: 's1',
      }),
    );
    const persisted = vi.mocked(deps.persist).mock.calls[0][0];
    expect(persisted.region).toBeUndefined();
    expect(persisted.vmType).toBeUndefined();
    expect(persisted.credentialId).toBeUndefined();
    expect(persisted.requestedComputeProvider).toBeUndefined();
  });

  it('refuses an unknown, provisioning, failed or deleting node pool before touching the image or storing anything', async () => {
    // Each is a 400 admission rejection; a 409 would reach clients as a
    // Workload ID conflict.
    // The caller's identifier differs from the pool's name: missing and
    // deleted pools echo the identifier, the others name the pool.
    const cases: Array<[Partial<StoredNodePool> | null, string]> = [
      [null, 'Node pool "pool-alias" not found'],
      [{ state: NodePoolState.Deleted }, 'Node pool "pool-alias" not found'],
      [
        { state: NodePoolState.Creating },
        'Node pool "aws-east" is still provisioning; retry once it is running',
      ],
      [
        { state: NodePoolState.Failed, lastError: 'join preconditions' },
        'Node pool "aws-east" has failed: join preconditions',
      ],
      [
        { state: NodePoolState.Deleting },
        'Node pool "aws-east" is terminated and does not accept Services',
      ],
    ];
    for (const [overrides, message] of cases) {
      const current = overrides ? { ...nodePool, ...overrides } : null;
      const deps = dependencies({
        nodePools: {
          getForScope: vi.fn(async () => null),
          getByNameForScope: vi.fn(async () => current),
        },
      });
      const attempt = submitNodePoolService(
        deps,
        actor,
        input({ nodePool: 'pool-alias' }),
      );
      await expect(attempt).rejects.toBeInstanceOf(InvalidAnycloudConfigError);
      await expect(attempt).rejects.toMatchObject({ message });
      expect(deps.inspectImage).not.toHaveBeenCalled();
      expect(deps.persist).not.toHaveBeenCalled();
    }
  });

  function onVmType(vmType: string) {
    return dependencies({
      nodePools: {
        getForScope: vi.fn(async () => null),
        getByNameForScope: vi.fn(async () => ({
          ...nodePool,
          vmTypes: [vmType],
        })),
      },
    });
  }

  it.each([
    ['t3.small', undefined, undefined, undefined],
    ['g4dn.12xlarge', undefined, '4', 4],
    ['g4dn.12xlarge', 'all', '4', 4],
    ['g4dn.12xlarge', '1', '1', 4],
  ])(
    'stores the resolved GPU count on %s with --gpus %s',
    async (vmType, gpus, stored, nodePoolGpuBound) => {
      const deps = onVmType(vmType);
      await submitNodePoolService(
        deps,
        actor,
        input({ dockerOptions: { memory: '2g', ...(gpus ? { gpus } : {}) } }),
      );
      expect(deps.persist).toHaveBeenCalledWith(
        expect.objectContaining({
          dockerOptions: { memory: '2g', ...(stored ? { gpus: stored } : {}) },
          nodePoolGpuBound,
        }),
      );
    },
  );

  it.each([
    ['g6e.xlarge', { gpus: '2' }, 'exceeds the 1 GPU'],
    ['t3.small', { gpus: '1' }, 'require an NVIDIA CUDA VM'],
    ['g6e.xlarge', { runtime: 'runc' }, '--runtime runc is unsupported'],
    ['zz.unknown', {}, 'GPU capacity cannot be verified'],
    [
      'trn1.2xlarge',
      {},
      'Services on a node pool require verified CPU or NVIDIA CUDA capacity',
    ],
  ] as const)(
    'refuses %s with %j before checking capacity',
    async (vmType, dockerOptions, message) => {
      const deps = onVmType(vmType);
      const attempt = submitNodePoolService(
        deps,
        actor,
        input({ dockerOptions }),
      );
      await expect(attempt).rejects.toBeInstanceOf(InvalidAnycloudConfigError);
      await expect(attempt).rejects.toThrow(message);
      expect(deps.observeCapacity).not.toHaveBeenCalled();
      expect(deps.persist).not.toHaveBeenCalled();
    },
  );

  it('stops a caller without a GitHub sign-in before reading the node pool', async () => {
    const deps = dependencies();
    await expect(
      submitNodePoolService(deps, { ...actor, token: null }, input()),
    ).rejects.toBeInstanceOf(GithubSignInRequiredError);
    expect(deps.observeCapacity).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it('refuses a ROCm image on an NVIDIA node pool as Deployments do', async () => {
    const deps = {
      ...onVmType('g6e.xlarge'),
      inspectImage: vi.fn(async () => ({
        verdict: ImageVerdict.Ok,
        amd64Digest: 'sha256:' + 'a'.repeat(64),
        imageRuntime: ImageRuntime.Rocm,
        compressedLayerBytes: null,
      })),
    };
    const attempt = submitNodePoolService(deps, actor, input());
    await expect(attempt).rejects.toBeInstanceOf(InvalidAnycloudConfigError);
    await expect(attempt).rejects.toThrow(
      'Image requires a ROCM GPU runtime incompatible with node pool VM type "g6e.xlarge".',
    );
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it('RFC 0049 C32 refuses a privileged Service on a --user-namespace-jobs pool, before the image', async () => {
    const deps = dependencies({
      nodePools: {
        getForScope: vi.fn(async () => null),
        getByNameForScope: vi.fn(async () => ({
          ...nodePool,
          userNamespaceJobs: true,
        })),
      },
    });
    const attempt = submitNodePoolService(
      deps,
      actor,
      input({ dockerOptions: { privileged: true } }),
    );
    await expect(attempt).rejects.toThrow(
      'Node pool "aws-east" runs user-namespace Jobs, so its Services do not accept --privileged',
    );
    expect(deps.inspectImage).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it('requires one ready VM and a verifiable cluster, reporting a fixed cluster message', async () => {
    const noCapacity = dependencies({
      observeCapacity: vi.fn(async () => ({
        readyVmCount: 0,
        startingVmCount: 1,
        drainingVmCount: 0,
        locations: [],
      })),
    });
    const noCapacityAttempt = submitNodePoolService(noCapacity, actor, input());
    await expect(noCapacityAttempt).rejects.toBeInstanceOf(
      InvalidAnycloudConfigError,
    );
    await expect(noCapacityAttempt).rejects.toThrow(
      'has no ready capacity (1 VM(s) starting)',
    );
    expect(noCapacity.persist).not.toHaveBeenCalled();

    const badCluster = dependencies({
      assertClusterCompatible: vi.fn(async () => {
        throw new Error('https://cluster.example:6443 rejected the token');
      }),
    });
    const attempt = submitNodePoolService(badCluster, actor, input());
    await expect(attempt).rejects.toBeInstanceOf(InvalidAnycloudConfigError);
    await expect(attempt).rejects.toThrow(
      'its cluster could not be verified for Service admission',
    );
    await expect(attempt).rejects.not.toThrow('cluster.example');
    expect(badCluster.persist).not.toHaveBeenCalled();
  });

  it('maps an identity collision and a lost node-pool-readiness race to their public errors', async () => {
    const collision = dependencies({
      persist: vi.fn(async () => {
        throw new Error('UNIQUE constraint failed: workloads.id');
      }),
    });
    await expect(
      submitNodePoolService(collision, actor, input({ id: 'svc-a' })),
    ).rejects.toBeInstanceOf(WorkloadIdExistsError);

    const race = dependencies({
      persist: vi.fn(async () => {
        throw new Error('node pool does not accept Services');
      }),
    });
    const attempt = submitNodePoolService(race, actor, input());
    await expect(attempt).rejects.toBeInstanceOf(InvalidAnycloudConfigError);
    await expect(attempt).rejects.toThrow('stopped accepting Services');

    const reserved = onVmType('g4dn.12xlarge');
    vi.mocked(reserved.persist).mockRejectedValue(
      new Error('node pool GPU capacity is reserved'),
    );
    const refusal = submitNodePoolService(reserved, actor, input());
    await expect(refusal).rejects.toBeInstanceOf(InvalidAnycloudConfigError);
    await expect(refusal).rejects.toThrow(
      'ready GPU capacity is reserved by its Deployments and Services; this Service needs 4 GPU(s)',
    );
  });
});

describe('node pool Service admission persistence', () => {
  beforeEach(async () => {
    resetPersistence();
    await getDB().query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider, name, created_at, last_used_at)
       VALUES ('compute-aws', 'opaque', 'AWS', 'aws-compute', 1, 1)`,
    );
    await getPersistence().clusters.recordSelf({
      id: 'cluster-a',
      ownerUserId: 'owner-1',
      name: 'production',
      kubernetesIdentity: 'uid-cluster-a',
      connection:
        '{"apiVersion":"v1","kind":"Config","current-context":"cluster"}',
    });
    await getPersistence().nodePools.create({
      id: nodePool.id,
      clusterId: 'cluster-a',
      ownerUserId: 'owner-1',
      name: nodePool.name,
      computeCredentialId: 'compute-aws',
      region: 'us-east-1',
      zone: null,
      vmTypes: ['t3.small'],
      minVmCount: 1,
      maxVmCount: 1,
    });
  });

  it('stores a queued Service with its node pool target through the admission writer', async () => {
    await getPersistence().nodePools.markReady(nodePool.id);
    const deps = dependencies({
      nodePools: getPersistence().nodePools,
      persist: persistNodePoolServiceWorkload,
    });
    const { id } = await submitNodePoolService(
      deps,
      actor,
      input({ id: 'svc-a', env: { MODE: 'prod' } }),
    );
    const stored = await requireTestWorkload(id);
    expect(stored).toMatchObject({
      id: 'svc-a',
      workloadType: 'service',
      state: WorkloadState.Queued,
      nodePoolId: nodePool.id,
      nodePoolName: nodePool.name,
      deploymentId: null,
      cloudProvider: CloudType.AWS,
      image: 'ghcr.io/acme/api:v1',
      env: { MODE: 'prod' },
      registryUsername: 'x-access-token',
      githubToken: 'github-token',
      credentialId: null,
      vmCount: 0,
    });
  });

  it('is refused by the database when the node pool stopped being ready after the check', async () => {
    const deps = dependencies({
      nodePools: {
        getForScope: async () => nodePool,
        getByNameForScope: async () => nodePool,
      },
      persist: persistNodePoolServiceWorkload,
    });
    await expect(
      submitNodePoolService(deps, actor, input({ id: 'svc-a' })),
    ).rejects.toThrow('stopped accepting Services');
    await expect(requireTestWorkload('svc-a')).rejects.toThrow();
  });
});
