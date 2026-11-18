import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../../../src/api/services/entities.js';
import { ClusterNotFoundError } from '../../../src/api/services/cluster-errors.js';
import { NodePoolAgentSkewError } from '../../../src/api/services/kubernetes/node-pool-join.js';
import { ClusterPermissionError } from '../../../src/api/services/kubernetes/cluster-runtime.js';
import {
  assertNodePoolZone,
  createNodePoolsDomain,
  type NodePoolDomainDependencies,
  type NodePoolRuntime,
} from '../../../src/api/services/node-pools-domain.js';
import {
  ClusterNotAcceptingError,
  NodePoolAlreadyExistsError,
  NodePoolNotFoundError,
  NodePoolCredentialNotFoundError,
  NodePoolReferencedError,
  NodePoolZoneInvalidError,
  NodePoolsUnavailableError,
} from '../../../src/api/services/node-pool-errors.js';
import {
  getPersistence,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { seedTestWorkload } from '../../helpers/workload-store.js';
import { CloudType, DiskTier } from '../../../src/shared/cloud.js';
import { ClusterState } from '../../../src/shared/clusters.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import { storageOnlyComputeMessage } from '../../../src/shared/providers.js';

const actor: User = {
  id: 'owner-1',
  username: 'owner',
  token: 'token',
};

const createRequest = {
  name: 'aws-east',
  credentialName: 'aws-compute',
  region: 'us-east-1',
  vmTypes: ['t3.small'],
  minVmCount: 1,
  maxVmCount: 1,
  osDiskSizeGb: 200,
  osDiskTier: DiskTier.High,
  spot: true,
  allowPrivilegedJobs: false,
  userNamespaceJobs: true,
  requireNestedVirtualization: true,
};

async function recordCluster(id: string, name: string): Promise<void> {
  await getPersistence().clusters.recordSelf({
    id,
    ownerUserId: actor.id,
    name,
    kubernetesIdentity: `uid-${id}`,
    connection: `{"cluster":"${id}"}`,
  });
}

describe('node pools domain', () => {
  let runtime: NodePoolRuntime;
  let observeCapacity: ReturnType<
    typeof vi.fn<NodePoolRuntime['observeCapacity']>
  >;
  let assertClusterCompatible: ReturnType<
    typeof vi.fn<NodePoolRuntime['assertClusterCompatible']>
  >;
  let schedule: ReturnType<typeof vi.fn<NodePoolRuntime['schedule']>>;
  let hasLiveReferences: ReturnType<
    typeof vi.fn<NodePoolDomainDependencies['references']['hasLiveReferences']>
  >;
  let validateTarget: ReturnType<
    typeof vi.fn<NodePoolDomainDependencies['validateTarget']>
  >;
  let domain: ReturnType<typeof createNodePoolsDomain>;

  beforeEach(async () => {
    resetPersistence();
    await getDB().query(
      `INSERT INTO credentials (
         id, encrypted_data, cloud_provider, name, created_at, last_used_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      ['compute-aws', 'opaque', CloudType.AWS, 'aws-compute', 1, 1],
    );
    await getDB().query(
      `INSERT INTO credentials (
         id, encrypted_data, cloud_provider, name, created_at, last_used_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      ['compute-lambda', 'opaque', CloudType.Lambda, 'lambda-compute', 1, 1],
    );
    schedule = vi
      .fn<NodePoolRuntime['schedule']>()
      .mockResolvedValue(undefined);
    observeCapacity = vi
      .fn<NodePoolRuntime['observeCapacity']>()
      .mockResolvedValue({
        readyVmCount: 0,
        startingVmCount: 0,
        drainingVmCount: 0,
        locations: [],
      });
    assertClusterCompatible = vi
      .fn<NodePoolRuntime['assertClusterCompatible']>()
      .mockResolvedValue(undefined);
    assertClusterCompatible = vi
      .fn<NodePoolRuntime['assertClusterCompatible']>()
      .mockResolvedValue(undefined);
    runtime = {
      schedule,
      runners: vi.fn(async () => null),
      observeCapacity,
      assertClusterCompatible,
      ingress: vi.fn(async () => ({ entryIp: null, release: null })),
    };
    hasLiveReferences = vi
      .fn<NodePoolDomainDependencies['references']['hasLiveReferences']>()
      .mockResolvedValue(false);
    validateTarget = vi
      .fn<NodePoolDomainDependencies['validateTarget']>()
      .mockImplementation(async (input) => ({
        region: input.region ?? null,
        zone: input.zone ?? null,
        vmTypes: input.vmTypes,
        minVmCount: input.minVmCount,
        maxVmCount: input.maxVmCount,
        osDiskSizeGb: input.osDiskSizeGb,
        osDiskTier: input.osDiskTier,
        spot: input.spot,
      }));
    domain = createNodePoolsDomain({
      nodePools: getPersistence().nodePools,
      clusterRecords: getPersistence().clusterRecords,
      credentials: getPersistence().credentialSecrets,
      references: {
        hasLiveReferences,
        countLiveReferences: async (id) =>
          (await hasLiveReferences(id)) ? 1 : 0,
      },
      generateId: (name) => `node-pool-${name}`,
      resolveScope: async () => ({ kind: 'api' }),
      runtime,
      validateTarget,
    });
  });

  it('places into the single cluster and accepts an explicit selector that resolves to it', async () => {
    await expect(domain.create(actor, createRequest)).rejects.toBeInstanceOf(
      NodePoolsUnavailableError,
    );
    expect(validateTarget).not.toHaveBeenCalled();

    await recordCluster('cluster-a', 'production');
    const { nodePool } = await domain.create(actor, createRequest);
    expect(nodePool).toEqual({
      id: 'node-pool-aws-east',
      name: 'aws-east',
      clusterId: 'cluster-a',
      state: WorkloadState.Provisioning,
      releasing: false,
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      zone: null,
      vmTypes: ['t3.small'],
      minVmCount: 1,
      maxVmCount: 1,
      osDiskSizeGb: 200,
      osDiskTier: DiskTier.High,
      spot: true,
      allowPrivilegedJobs: false,
      userNamespaceJobs: true,
      requireNestedVirtualization: true,
      capacity: {
        readyVmCount: 0,
        startingVmCount: 0,
        drainingVmCount: 0,
        locations: [],
      },
      liveReferences: 0,
      ingressEntryIp: null,
      ingress: { entryIp: null, release: null },
      lastError: null,
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    expect(schedule).toHaveBeenCalledWith('node-pool-aws-east');
    expect(observeCapacity).toHaveBeenCalledWith('node-pool-aws-east');
    expect(validateTarget).toHaveBeenCalledWith(
      createRequest,
      expect.objectContaining({ id: 'compute-aws' }),
    );

    await expect(
      domain.create(actor, {
        ...createRequest,
        name: 'aws-west',
        cluster: 'production',
        zone: 'us-east-1a',
      }),
    ).resolves.toMatchObject({
      nodePool: { clusterId: 'cluster-a', zone: 'us-east-1a' },
    });
    await expect(
      domain.create(actor, {
        ...createRequest,
        name: 'gcp-central',
        cluster: 'missing',
      }),
    ).rejects.toBeInstanceOf(ClusterNotFoundError);
  });

  it('validates the immutable zone against the credential provider before any durable write', async () => {
    await recordCluster('cluster-a', 'production');

    for (const zone of [
      'us-west-2a',
      'us-east-1',
      'US-EAST-1A',
      'us-east-1a/x',
    ]) {
      await expect(
        domain.create(actor, { ...createRequest, zone }),
      ).rejects.toBeInstanceOf(NodePoolZoneInvalidError);
    }
    await expect(
      domain.create(actor, {
        ...createRequest,
        name: 'lambda-east',
        credentialName: 'lambda-compute',
        zone: 'us-east-1a',
      }),
    ).rejects.toBeInstanceOf(NodePoolZoneInvalidError);
    for (const osDisk of [
      { osDiskSizeGb: 200 },
      { osDiskTier: DiskTier.High },
    ]) {
      await expect(
        domain.create(actor, {
          name: 'lambda-east',
          credentialName: 'lambda-compute',
          vmTypes: ['gpu_1x_a10'],
          minVmCount: 1,
          maxVmCount: 1,
          ...osDisk,
        }),
      ).rejects.toThrow(
        'Lambda node pools boot with a fixed OS disk; omit --disk-size and --disk-tier',
      );
    }
    expect(validateTarget).not.toHaveBeenCalled();
    await expect(domain.list(actor, undefined)).resolves.toEqual({
      nodePools: [],
    });

    expect(() =>
      assertNodePoolZone(CloudType.GCP, 'us-central1', 'us-central1-a'),
    ).not.toThrow();
    expect(() =>
      assertNodePoolZone(CloudType.GCP, 'us-central1', 'us-central1'),
    ).toThrow(NodePoolZoneInvalidError);
    expect(() =>
      assertNodePoolZone(CloudType.Azure, 'eastus', '2'),
    ).not.toThrow();
    expect(() =>
      assertNodePoolZone(CloudType.Azure, 'eastus', 'eastus-2'),
    ).toThrow(NodePoolZoneInvalidError);
    expect(() =>
      assertNodePoolZone(CloudType.Lambda, 'us-east-1', undefined),
    ).not.toThrow();
    expect(() =>
      assertNodePoolZone(CloudType.GCP, undefined, undefined),
    ).not.toThrow();
    expect(() =>
      assertNodePoolZone(CloudType.GCP, undefined, 'us-central1-a'),
    ).toThrow('--zone requires --region');
  });

  it('refuses admission when the cluster is incompatible, without echoing upstream detail', async () => {
    await recordCluster('cluster-a', 'production');
    assertClusterCompatible.mockRejectedValueOnce(
      new NodePoolAgentSkewError('v1.31.2+k3s1'),
    );
    await expect(domain.create(actor, createRequest)).rejects.toMatchObject({
      name: 'NodePoolClusterIncompatibleError',
      message: expect.stringContaining('v1.31.2+k3s1'),
    });
    assertClusterCompatible.mockRejectedValueOnce(
      new ClusterPermissionError('cluster-a', ['delete nodes']),
    );
    await expect(domain.create(actor, createRequest)).rejects.toMatchObject({
      name: 'NodePoolClusterIncompatibleError',
      message: expect.stringContaining('delete nodes'),
    });
    assertClusterCompatible.mockRejectedValueOnce(
      new Error('401 bearer SECRET-TOKEN rejected by https://cluster'),
    );
    await expect(domain.create(actor, createRequest)).rejects.toMatchObject({
      name: 'NodePoolClusterIncompatibleError',
      message: 'cluster could not be verified for node pool admission',
    });
    expect(validateTarget).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    await expect(domain.list(actor, undefined)).resolves.toEqual({
      nodePools: [],
    });
  });

  it('refuses a storage-only Cloudflare credential before validating a target', async () => {
    await recordCluster('cluster-a', 'production');
    await getDB().query(
      `INSERT INTO credentials (
         id, encrypted_data, cloud_provider, name, created_at, last_used_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      ['storage-r2', 'opaque', CloudType.Cloudflare, 'r2', 1, 1],
    );

    await expect(
      domain.create(actor, { ...createRequest, credentialName: 'r2' }),
    ).rejects.toThrow(storageOnlyComputeMessage(CloudType.Cloudflare));
    expect(validateTarget).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('rejects unknown credentials, duplicate names and clusterRecords that stopped accepting node pools', async () => {
    await recordCluster('cluster-a', 'production');
    await domain.create(actor, createRequest);

    await expect(
      domain.create(actor, {
        ...createRequest,
        name: 'AWS-EAST',
        maxVmCount: createRequest.maxVmCount + 1,
      }),
    ).rejects.toThrow('already exists with other settings');
    // Another pool's id is not a re-run of that pool's create.
    await expect(
      domain.create(actor, { ...createRequest, name: 'node-pool-aws-east' }),
    ).rejects.toBeInstanceOf(NodePoolAlreadyExistsError);
    await expect(
      domain.create(actor, {
        ...createRequest,
        name: 'aws-west',
        credentialName: 'missing',
      }),
    ).rejects.toBeInstanceOf(NodePoolCredentialNotFoundError);

    await getPersistence().nodePools.requestDeletion('node-pool-aws-east', {
      kind: 'api',
    });
    await getPersistence().nodePools.markDeleted('node-pool-aws-east');
    await getPersistence().clusters.setState(
      'cluster-a',
      ClusterState.Destroying,
    );
    await expect(
      domain.create(actor, { ...createRequest, name: 'aws-west' }),
    ).rejects.toBeInstanceOf(ClusterNotAcceptingError);
    // The create and the two duplicates, which compare the validated target;
    // the refused one never reaches it.
    expect(validateTarget).toHaveBeenCalledTimes(3);

    await getPersistence().clusters.setState(
      'cluster-a',
      ClusterState.Destroyed,
    );
    await expect(
      domain.create(actor, { ...createRequest, name: 'aws-west' }),
    ).rejects.toBeInstanceOf(NodePoolsUnavailableError);
  });

  it('answers a re-run of the same create or delete with the pool it made or deleted', async () => {
    await recordCluster('cluster-a', 'production');
    const { nodePool } = await domain.create(actor, createRequest);
    schedule.mockClear();

    await expect(
      domain.create(actor, { ...createRequest, name: 'AWS-EAST' }),
    ).resolves.toMatchObject({ nodePool: { id: nodePool.id } });
    for (const changed of [
      { region: 'us-west-2' },
      { vmTypes: ['t3.small', 'm5.large'] },
      { spot: false },
      { userNamespaceJobs: false },
      { osDiskSizeGb: 100 },
    ]) {
      await expect(
        domain.create(actor, { ...createRequest, ...changed }),
        JSON.stringify(changed),
      ).rejects.toBeInstanceOf(NodePoolAlreadyExistsError);
    }
    expect(
      await getPersistence().nodePools.listForScope({ kind: 'api' }),
    ).toHaveLength(1);
    expect(schedule).not.toHaveBeenCalled();

    await getDB().query(`UPDATE node_pools SET state = 'failed' WHERE id = ?`, [
      nodePool.id,
    ]);
    await expect(domain.create(actor, createRequest)).rejects.toThrow(
      'failed; delete it, then create it again',
    );
    await domain.delete(actor, 'aws-east');
    await expect(domain.create(actor, createRequest)).rejects.toThrow(
      'is being deleted',
    );
    await expect(domain.delete(actor, 'aws-east')).resolves.toMatchObject({
      nodePool: { id: nodePool.id, releasing: true },
    });
    await getPersistence().nodePools.markDeleted(nodePool.id);
    for (const identifier of ['aws-east', nodePool.id]) {
      await expect(domain.delete(actor, identifier)).resolves.toMatchObject({
        nodePool: {
          id: nodePool.id,
          state: WorkloadState.Terminated,
          releasing: false,
        },
      });
    }
    await expect(domain.delete(actor, 'aws-west')).rejects.toBeInstanceOf(
      NodePoolNotFoundError,
    );
  });

  it('refuses a concurrent cluster destroy race after validation', async () => {
    await recordCluster('cluster-a', 'production');
    validateTarget.mockImplementationOnce(async (input) => {
      await getPersistence().clusters.setState(
        'cluster-a',
        ClusterState.Destroying,
      );
      return {
        region: input.region ?? null,
        zone: null,
        vmTypes: input.vmTypes,
        minVmCount: input.minVmCount,
        maxVmCount: input.maxVmCount,
      };
    });

    await expect(domain.create(actor, createRequest)).rejects.toBeInstanceOf(
      ClusterNotAcceptingError,
    );
    await expect(domain.list(actor, undefined)).resolves.toEqual({
      nodePools: [],
    });
    expect(schedule).not.toHaveBeenCalled();
  });

  it('lists and resolves node pools by cluster and by ID or name within scope', async () => {
    await recordCluster('cluster-a', 'production');
    await domain.create(actor, { ...createRequest, cluster: 'production' });
    await domain.create(actor, { ...createRequest, name: 'aws-west' });

    await expect(domain.list(actor, 'production')).resolves.toMatchObject({
      nodePools: [{ name: 'aws-east' }, { name: 'aws-west' }],
    });
    await expect(domain.list(actor, 'cluster-a')).resolves.toMatchObject({
      nodePools: [{ name: 'aws-east' }, { name: 'aws-west' }],
    });
    await expect(domain.list(actor, undefined)).resolves.toMatchObject({
      nodePools: [{ name: 'aws-east' }, { name: 'aws-west' }],
    });
    await expect(domain.list(actor, 'missing')).rejects.toBeInstanceOf(
      ClusterNotFoundError,
    );
    await expect(domain.get(actor, 'AWS-East')).resolves.toMatchObject({
      nodePool: { id: 'node-pool-aws-east' },
    });
  });

  it('reports the store trigger as the same conflict when a Service is admitted after the reference check', async () => {
    await recordCluster('cluster-a', 'production');
    await domain.create(actor, createRequest);
    await getPersistence().nodePools.markReady('node-pool-aws-east');
    // The domain saw no references; a Service lands before the write.
    hasLiveReferences.mockImplementationOnce(async () => {
      await seedTestWorkload({
        id: 'svc-race',
        userId: actor.username,
        ownerUserId: actor.id,
        workloadType: 'service',
        image: 'ghcr.io/acme/api:v1',
        dockerCommand: '',
        nodePoolId: 'node-pool-aws-east',
        state: WorkloadState.Queued,
      });
      return false;
    });
    await expect(domain.delete(actor, 'aws-east')).rejects.toBeInstanceOf(
      NodePoolReferencedError,
    );
    await expect(domain.get(actor, 'aws-east')).resolves.toMatchObject({
      nodePool: { state: WorkloadState.Running },
    });
  });

  it('refuses deletion while live references remain and otherwise leaves teardown to the runtime', async () => {
    await recordCluster('cluster-a', 'production');
    await domain.create(actor, createRequest);
    await domain.create(actor, { ...createRequest, name: 'aws-west' });
    schedule.mockClear();

    hasLiveReferences.mockResolvedValueOnce(true);
    await expect(domain.delete(actor, 'aws-east')).rejects.toBeInstanceOf(
      NodePoolReferencedError,
    );
    expect(hasLiveReferences).toHaveBeenCalledWith('node-pool-aws-east');
    await expect(domain.get(actor, 'aws-east')).resolves.toMatchObject({
      nodePool: { state: WorkloadState.Provisioning },
    });
    expect(schedule).not.toHaveBeenCalled();

    // The store's own fence (a Deployment admitted after the pre-check) maps
    // to the same conflict; the node pool stays where it was.
    const requestDeletion = vi
      .spyOn(getPersistence().nodePools, 'requestDeletion')
      .mockResolvedValueOnce('referenced');
    await expect(domain.delete(actor, 'aws-east')).rejects.toBeInstanceOf(
      NodePoolReferencedError,
    );
    requestDeletion.mockRestore();
    expect(schedule).not.toHaveBeenCalled();
    const { nodePool } = await domain.delete(actor, 'aws-east');
    expect(nodePool).toMatchObject({
      state: WorkloadState.Terminated,
      releasing: true,
    });
    expect(schedule).toHaveBeenCalledWith('node-pool-aws-east');
    await expect(
      domain.delete(actor, 'node-pool-aws-east'),
    ).resolves.toMatchObject({
      nodePool: { state: WorkloadState.Terminated, releasing: true },
    });
    await getPersistence().nodePools.markDeleted('node-pool-aws-east');
    await expect(
      domain.get(actor, 'node-pool-aws-east'),
    ).resolves.toMatchObject({
      nodePool: { state: WorkloadState.Terminated, releasing: false },
    });

    await expect(domain.get(actor, 'aws-west')).resolves.toMatchObject({
      nodePool: { state: WorkloadState.Provisioning },
    });
    await expect(
      getPersistence().clusterRecords.getForScope('cluster-a', { kind: 'api' }),
    ).resolves.toMatchObject({ state: ClusterState.Ready });
  });

  it('reports the controller failure diagnostic and live capacity on status', async () => {
    await recordCluster('cluster-a', 'production');
    await domain.create(actor, createRequest);
    await getPersistence().nodePools.markFailed(
      'node-pool-aws-east',
      'quota exceeded for AKIA1234567890SECRET',
    );
    observeCapacity.mockResolvedValueOnce({
      readyVmCount: 1,
      startingVmCount: 2,
      drainingVmCount: 0,
      locations: [],
    });

    const { nodePool } = await domain.get(actor, 'aws-east');
    expect(nodePool).toMatchObject({
      state: WorkloadState.Failed,
      capacity: {
        readyVmCount: 1,
        startingVmCount: 2,
        drainingVmCount: 0,
        locations: [],
      },
    });
    expect(nodePool.lastError).toContain('quota exceeded');
  });
});
