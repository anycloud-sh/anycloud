import { describe, expect, it, vi } from 'vitest';
import {
  createDeploymentRuntimeResolver,
  createNodePoolRuntimeResolver,
  NodePoolRuntimeUnavailableError,
} from '../../../../src/api/services/kubernetes/deployment-runtime.js';
import { nodePoolNamespace } from '../../../../src/api/services/kubernetes/node-pool-scheduling.js';
import type { ClusterRuntime } from '../../../../src/api/services/kubernetes/cluster-runtime.js';
import type { StoredNodePool } from '../../../../src/api/services/cluster-store.js';
import { deploymentTarget } from '../../../../src/api/services/deployment-store.js';
import { CloudType } from '../../../../src/shared/cloud.js';
import { NodePoolState } from '../../../../src/shared/node-pools.js';
import { makeClusterKubernetesClientFixture } from '../../helpers/fixtures.js';

function nodePool(overrides: Partial<StoredNodePool> = {}): StoredNodePool {
  return {
    id: 'node-pool-aws-east',
    clusterId: 'cluster-a',
    ownerUserId: 'owner',
    name: 'aws-east',
    state: NodePoolState.Ready,
    computeCredentialId: 'cred',
    cloudProvider: CloudType.AWS,
    region: 'us-east-1',
    zone: null,
    clusterRegion: null,
    vmTypes: ['t3.large'],
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
    ...overrides,
  };
}

const clusterRuntime: ClusterRuntime = {
  clusterId: 'cluster-a',
  kubernetesIdentity: 'uid',
  connectionRevision: 1,
  serverVersion: { major: 1, minor: 36, gitVersion: 'v1.36.0' },
  verifiedAt: 0,
  connection: {
    kind: 'installer',
    server: 'https://cluster:6443',
    certificateAuthorityData: 'Y2E=',
    credential: { kind: 'token', token: 't' },
  },
  cluster: makeClusterKubernetesClientFixture({}),
};

describe('Deployment target runtime', () => {
  it('derives an immutable target from the record', () => {
    expect(deploymentTarget({ id: 'd', nodePoolId: 'p' })).toEqual({
      kind: 'nodePool',
      nodePoolId: 'p',
    });
    expect(() => deploymentTarget({ id: 'd', nodePoolId: '' })).toThrow(
      /no node pool target/,
    );
  });

  it('resolves a node pool to its cluster connection scoped to the node pool namespace', async () => {
    const stored = nodePool();
    const resolve = vi.fn(async () => clusterRuntime);
    const resolver = createNodePoolRuntimeResolver({
      nodePools: { getForScope: vi.fn(async () => stored) },
      clusterRuntime: { resolve },
    });
    const signal = new AbortController().signal;
    const runtime = await resolver.resolve(stored.id, signal);
    expect(runtime.config).toEqual({
      namespace: nodePoolNamespace(stored.id),
    });
    expect(runtime.cluster).toBe(clusterRuntime.cluster);
    expect(runtime.nodePool).toEqual({
      clusterId: 'cluster-a',
      nodePoolId: stored.id,
      nvidiaGpusPerNode: 0,
      // t3.large's catalog size, which a CPU replica's default memory divides.
      nodeSize: { vCPUs: 2, memoryGiB: 8 },
    });
    // A GPU node pool carries the catalog's devices per Node for the Pod rule.
    const gpu = createNodePoolRuntimeResolver({
      nodePools: {
        getForScope: vi.fn(async () => nodePool({ vmTypes: ['g6.xlarge'] })),
      },
      clusterRuntime: { resolve },
    });
    await expect(gpu.resolve(stored.id)).resolves.toMatchObject({
      nodePool: { nvidiaGpusPerNode: 1 },
    });
    expect(resolve).toHaveBeenCalledWith('cluster-a', signal);
    // A CPU pool with a disk divides its Node by the largest known vCPU
    // count, so a mixed pool's fractions sum to at most any one Node.
    const mixed = createNodePoolRuntimeResolver({
      nodePools: {
        getForScope: vi.fn(async () =>
          nodePool({
            vmTypes: ['t3.small', 'm5.2xlarge', 'unknown.type'],
            osDiskSizeGb: 100,
          }),
        ),
      },
      clusterRuntime: { resolve },
    });
    await expect(mixed.resolve(stored.id)).resolves.toMatchObject({
      nodePool: { ephemeralStorage: { allocatableGi: 65, vCPUs: 8 } },
    });
  });

  it('still resolves failed and deleting node pools so Deployments can drain, but never a deleted or missing one', async () => {
    for (const state of [
      NodePoolState.Creating,
      NodePoolState.Failed,
      NodePoolState.Deleting,
    ]) {
      const resolver = createNodePoolRuntimeResolver({
        nodePools: { getForScope: async () => nodePool({ state }) },
        clusterRuntime: { resolve: async () => clusterRuntime },
      });
      await expect(
        resolver.resolve('node-pool-aws-east'),
      ).resolves.toMatchObject({
        nodePool: { nodePoolId: 'node-pool-aws-east' },
      });
    }
    const deleted = createNodePoolRuntimeResolver({
      nodePools: {
        getForScope: async () => nodePool({ state: NodePoolState.Deleted }),
      },
      clusterRuntime: { resolve: vi.fn() },
    });
    await expect(deleted.resolve('node-pool-aws-east')).rejects.toBeInstanceOf(
      NodePoolRuntimeUnavailableError,
    );
    const missing = createNodePoolRuntimeResolver({
      nodePools: { getForScope: async () => null },
      clusterRuntime: { resolve: vi.fn() },
    });
    await expect(missing.resolve('nope')).rejects.toThrow(/does not exist/);
  });

  it('dispatches Deployment targets to the node pool resolver', async () => {
    const nodePools = {
      resolve: vi.fn(async () => ({
        config: { namespace: 'p-ns' },
        cluster: makeClusterKubernetesClientFixture({}),
        nodePool: {
          clusterId: 'cluster-a',
          nodePoolId: 'p',
          nvidiaGpusPerNode: 0,
        },
      })),
    };
    const resolver = createDeploymentRuntimeResolver({ nodePools });
    const signal = new AbortController().signal;
    await expect(
      resolver.resolve({ kind: 'nodePool', nodePoolId: 'p' }, signal),
    ).resolves.toMatchObject({ config: { namespace: 'p-ns' } });
    expect(nodePools.resolve).toHaveBeenCalledWith('p', signal);
  });
});
