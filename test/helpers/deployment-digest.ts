import {
  getDeploymentStore,
  getPersistence,
} from '../../src/api/services/persistence.js';
import { getDB } from '../../src/api/services/repositories/db.js';
import { CloudType } from '../../src/shared/cloud.js';
import { WorkloadState } from '../../src/shared/workload.js';
import { getWorkloadAdmissionWriter } from '../../src/api/services/workload-admission-writer.js';

export async function seedDigestDeployment(input: {
  id: string;
  createdAt: number;
  name?: string;
  nodePoolId?: string;
  nodePoolName?: string;
  ownerUserId?: string;
  deletionRequestedAt?: number;
  deletedAt?: number;
}): Promise<void> {
  const nodePoolId = input.nodePoolId ?? 'digest-pool';
  const ownerUserId = input.ownerUserId ?? '77';
  await seedDigestNodePool({
    id: nodePoolId,
    name: input.nodePoolName,
    ownerUserId,
  });
  const created = await getDeploymentStore().create(
    {
      id: input.id,
      name: input.name ?? input.id,
      ownerUserId,
      nodePoolId,
      gpuCount: 0,
      maxConcurrentJobsPerReplica: 4,
      config: {
        image: 'example/model:latest',
        imageDigest: null,
        command: null,
        dockerOptions: null,
        env: null,
        registryUsername: 'digest-owner',
        registryToken: null,
      },
    },
    { kind: 'api' },
  );
  if (!created) throw new Error(`Could not seed Deployment ${input.id}`);
  await getDB().query(
    `UPDATE deployments
     SET created_at = ?, deletion_requested_at = ?, deleted_at = ?
     WHERE id = ?`,
    [
      input.createdAt,
      input.deletionRequestedAt ?? input.deletedAt ?? null,
      input.deletedAt ?? null,
      input.id,
    ],
  );
}

/** A Ready node pool on one shared root; repeated calls reuse both. */
async function seedDigestNodePool(input: {
  id: string;
  name?: string;
  ownerUserId: string;
}): Promise<void> {
  const persistence = getPersistence();
  if (await persistence.nodePools.getForScope(input.id, { kind: 'api' })) {
    return;
  }
  const db = getDB();
  if (
    (await db.query('SELECT id FROM credentials WHERE id = ?', ['digest-cred']))
      .length === 0
  ) {
    await db.query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider) VALUES ('digest-cred', 'x', ?)`,
      [CloudType.AWS],
    );
  }
  if (
    !(await persistence.clusterRecords.getForScope('digest-root', {
      kind: 'api',
    }))
  ) {
    await persistence.clusters.recordSelf({
      id: 'digest-root',
      ownerUserId: input.ownerUserId,
      name: 'digest-root',
      kubernetesIdentity: 'uid-digest-root',
      connection: '{"stored":true}',
    });
  }
  await persistence.nodePools.create({
    id: input.id,
    clusterId: 'digest-root',
    ownerUserId: input.ownerUserId,
    name: input.name ?? input.id,
    computeCredentialId: 'digest-cred',
    region: 'us-east-1',
    zone: null,
    vmTypes: ['t3.small'],
    minVmCount: 1,
    maxVmCount: 1,
  });
  await persistence.nodePools.markReady(input.id);
}

export async function seedDigestNodePoolVm(input: {
  id: string;
  createdAt: number;
  nodePoolId?: string;
  endedAt?: number;
  removalRequestedAt?: number;
  provisioned?: boolean;
}): Promise<void> {
  await getDB().query(
    `INSERT INTO vms
       (node_pool_id, cloud_id, ip, created_at, ended_at, removal_requested_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.nodePoolId ?? 'digest-pool',
      input.id,
      input.provisioned === false ? null : '192.0.2.1',
      input.createdAt,
      input.endedAt ?? null,
      input.removalRequestedAt ?? null,
    ],
  );
}

export async function seedDigestTargetedJob(input: {
  id: string;
  deploymentId: string;
  submittedAt: number;
  userId?: string;
  ownerUserId?: string;
  state?: WorkloadState;
  completedAt?: number;
  resubmittedAt?: number[];
}): Promise<void> {
  const created = await getWorkloadAdmissionWriter().createTargetedWorkload({
    id: input.id,
    deploymentId: input.deploymentId,
    userId: input.userId ?? 'alice',
    ownerUserId: input.ownerUserId ?? '77',
  });
  if (!created) throw new Error(`Could not seed Job ${input.id}`);
  await getDB().query(
    `UPDATE workloads
     SET submitted_at = ?, started_at = ?, state = ?, completed_at = ?
     WHERE id = ?`,
    [
      input.submittedAt,
      input.submittedAt,
      input.state ?? WorkloadState.Queued,
      input.completedAt ?? null,
      input.id,
    ],
  );
  for (const timestamp of input.resubmittedAt ?? []) {
    await getDB().query(
      `INSERT INTO workload_events (workload_id, state, metadata, created_at)
       VALUES (?, 'queued', '{"reason":"resubmitted"}', ?)`,
      [input.id, timestamp],
    );
  }
}
