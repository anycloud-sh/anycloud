import { getPersistence } from '../../../src/api/services/persistence.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { CloudType } from '../../../src/shared/cloud.js';

export interface SeededNodePool {
  nodePoolId: string;
  clusterId: string;
  credentialId: string;
}

/**
 * Seed the durable owner chain a Deployment record needs: a compute
 * credential, a cluster and a Ready node pool on it. Idempotent, so
 * one test can seed sibling node pools or call it per Deployment.
 */
export async function seedReadyNodePool(
  overrides: {
    nodePoolId?: string;
    clusterId?: string;
    ownerUserId?: string;
    name?: string;
    vmType?: string;
    cloudProvider?: CloudType;
    minVmCount?: number;
    maxVmCount?: number;
    ready?: boolean;
  } = {},
): Promise<SeededNodePool> {
  const nodePoolId = overrides.nodePoolId ?? 'node-pool-id';
  const clusterId = overrides.clusterId ?? 'cluster-a';
  const ownerUserId = overrides.ownerUserId ?? 'owner';
  const credentialId = 'cred-a';
  const persistence = getPersistence();
  const db = getDB();
  if (await persistence.nodePools.getForScope(nodePoolId, { kind: 'api' })) {
    return { nodePoolId, clusterId, credentialId };
  }
  const credential = await db.query<{ id: string }>(
    'SELECT id FROM credentials WHERE id = ?',
    [credentialId],
  );
  if (credential.length === 0) {
    await db.query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider) VALUES (?, 'x', ?)`,
      [credentialId, overrides.cloudProvider ?? CloudType.AWS],
    );
  }
  if (
    !(await persistence.clusterRecords.getForScope(clusterId, { kind: 'api' }))
  ) {
    await persistence.clusters.recordSelf({
      id: clusterId,
      ownerUserId,
      name: `${clusterId}-root`,
      kubernetesIdentity: `uid-${clusterId}`,
      connection: '{"stored":true}',
    });
  }
  await persistence.nodePools.create({
    id: nodePoolId,
    clusterId,
    ownerUserId,
    name: overrides.name ?? nodePoolId,
    computeCredentialId: credentialId,
    region: 'us-east-1',
    zone: null,
    vmTypes: [overrides.vmType ?? 't3.small'],
    minVmCount: overrides.minVmCount ?? 1,
    maxVmCount: overrides.maxVmCount ?? 1,
  });
  if (overrides.ready !== false)
    await persistence.nodePools.markReady(nodePoolId);
  return { nodePoolId, clusterId, credentialId };
}
