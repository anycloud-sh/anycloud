import { beforeEach, describe, expect, it } from 'vitest';
import { getWorkloadOutcomes } from '../../../src/api/services/persistence.js';
import {
  getCredentialSecretStore,
  getPersistence,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import { getDB, type DB } from '../../../src/api/services/repositories/db.js';
import {
  NodePoolStore,
  SCALE_OUT_CAP_BLOCK_PREFIX,
} from '../../../src/api/services/cluster-store.js';
import { makeContainerSpec } from '../helpers/fixtures.js';
import { decryptSecret } from '../../../src/api/services/secret-crypto.js';
import {
  nodeDeleted,
  nodeNotObserved,
} from '../../../src/api/services/node-detachment.js';
import { seedTestWorkload } from '../../helpers/workload-store.js';
import {
  CloudFailureDiagnosis,
  CloudType,
  DiskTier,
} from '../../../src/shared/cloud.js';
import { FailureDisposition } from '../../../src/api/services/provisioning-failure.js';
import { ClusterState } from '../../../src/shared/clusters.js';
import { NodePoolState } from '../../../src/shared/node-pools.js';
import { WorkloadState } from '../../../src/shared/workload.js';

const owner = { kind: 'api' } as const;

const baseCluster = {
  id: 'cluster-a',
  ownerUserId: 'owner-1',
  name: 'production',
  kubernetesIdentity: 'uid-cluster-a',
  connection: JSON.stringify({
    kind: 'in-cluster',
    // service-terminology-ok: kubeconfig's own field name for the API endpoint
    server: 'https://203.0.113.5:6443',
    certificateAuthorityData: 'Y2E=',
  }),
};

/** A picked launch target. */
const target = {
  region: 'us-east-1',
  availabilityZone: 'us-east-1a',
  vmType: 't3.small',
};

const baseNodePool = {
  id: 'node-pool-aws',
  clusterId: baseCluster.id,
  ownerUserId: 'owner-1',
  name: 'aws-east',
  computeCredentialId: 'compute-aws',
  region: 'us-east-1',
  zone: null,
  vmTypes: ['t3.small'],
  minVmCount: 1,
  maxVmCount: 1,
};

function clusterRecords() {
  return getPersistence().clusterRecords;
}

function clusters() {
  return getPersistence().clusters;
}

/** The hosted API's own record: ready, bound, in-cluster connection. */
function recordCluster(overrides: Partial<typeof baseCluster> = {}) {
  return clusters().recordSelf({ ...baseCluster, ...overrides });
}

async function destroyCluster(id = baseCluster.id): Promise<void> {
  await clusters().setState(id, ClusterState.Destroying);
  await clusters().setState(id, ClusterState.Destroyed);
}

function nodePools() {
  return getPersistence().nodePools;
}

function nodePoolVms() {
  return getPersistence().nodePoolVms;
}

async function deleteNodePool(id: string): Promise<void> {
  await nodePools().requestDeletion(id, { kind: 'api' });
  await nodePools().markDeleted(id);
}

describe('cluster and node pool persistence', () => {
  beforeEach(async () => {
    resetPersistence();
    await getDB().query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider, name, created_at, last_used_at)
       VALUES ('compute-aws', 'opaque', 'AWS', 'aws-compute', 1, 1),
              ('compute-gcp', 'opaque', 'GCP', 'gcp-compute', 1, 1)`,
    );
  });

  describe('cluster identity', () => {
    it('records the cluster as ready with its bound identity and an encrypted connection', async () => {
      await expect(recordCluster()).resolves.toBe('recorded');

      await expect(
        clusterRecords().getForScope(baseCluster.id, owner),
      ).resolves.toEqual({
        id: baseCluster.id,
        ownerUserId: 'owner-1',
        name: 'production',
        state: ClusterState.Ready,
        kubernetesIdentity: 'uid-cluster-a',
        connectionRevision: 1,
        record: null,
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      });
      await expect(
        clusterRecords().getByNameForScope('PRODUCTION', owner),
      ).resolves.toMatchObject({ id: baseCluster.id });

      const [stored] = await getDB().query<{ encrypted_connection: string }>(
        'SELECT encrypted_connection FROM clusters WHERE id = ?',
        [baseCluster.id],
      );
      expect(stored.encrypted_connection).not.toContain('in-cluster');
      await expect(decryptSecret(stored.encrypted_connection)).resolves.toBe(
        baseCluster.connection,
      );
      await expect(
        clusterRecords().getConnection(baseCluster.id),
      ).resolves.toEqual({
        clusterId: baseCluster.id,
        kubernetesIdentity: 'uid-cluster-a',
        kind: 'in-cluster',
        connection: baseCluster.connection,
        connectionRevision: 1,
      });
    });

    it('is idempotent for the same identity and refuses another', async () => {
      await recordCluster();
      await expect(recordCluster()).resolves.toBe('exists');
      await expect(
        recordCluster({ kubernetesIdentity: 'uid-foreign' }),
      ).resolves.toBe('identity-mismatch');
      await expect(
        clusterRecords().listForScope({ kind: 'api' }),
      ).resolves.toHaveLength(1);
    });

    it('allows exactly one active cluster regardless of owner, name or identity', async () => {
      await recordCluster();

      await expect(
        getDB().query(
          `INSERT INTO clusters (
             id, owner_user_id, name, state, step, kubernetes_identity,
             encrypted_connection, created_at, updated_at
           ) VALUES ('cluster-raw', 'owner-2', 'raw', 'ready', 'release', 'uid-raw', 'x', 1, 1)`,
        ),
      ).rejects.toThrow(/idx_clusters_single_active/);
      await expect(
        clusterRecords().listForScope({ kind: 'api' }),
      ).resolves.toHaveLength(1);
    });

    it('never rebinds a bound identity, rewinds the connection revision or changes the connection kind', async () => {
      await recordCluster();

      for (const [column, value] of [
        ['kubernetes_identity', 'uid-foreign'],
        ['name', 'renamed'],
        ['connection_kind', 'installer'],
      ]) {
        await expect(
          getDB().query(`UPDATE clusters SET ${column} = ? WHERE id = ?`, [
            value,
            baseCluster.id,
          ]),
        ).rejects.toThrow(/Cluster identity is immutable/);
      }
      await expect(
        getDB().query(
          'UPDATE clusters SET connection_revision = 0 WHERE id = ?',
          [baseCluster.id],
        ),
      ).rejects.toThrow(/immutable|CHECK constraint failed/);
    });

    it('stores the installer connection once the identity is observed and refuses another identity', async () => {
      await clusters().record({
        id: 'install-a',
        ownerUserId: 'owner-1',
        name: 'production',
        computeCredentialId: 'compute-aws',
        region: 'us-east-1',
        zone: null,
        vmType: 't3.small',
        k3sVersion: 'v1.35.5+k3s1',
        k3sSha256: 'a'.repeat(64),
        helmJobImage: 'rancher/klipper-helm:v0.9.4-build20250113',
        apiVersion: '0.1.65',
        apiImage: `ghcr.io/anycloud-sh/api:0.1.65@sha256:${'b'.repeat(64)}`,
        chartVersion: '0.3.0',
        chartSha256: 'c'.repeat(64),
        checkpointBucket: { name: 'bucket', managed: true },
        restoreFromBackup: false,
        serverToken: 'token',
        sshPublicKey: 'ssh-ed25519 AAAA',
        sshPrivateKey: 'key\n',
      });
      await expect(
        clusterRecords().getConnection('install-a'),
      ).resolves.toBeNull();
      await expect(
        clusterRecords().getForScope('install-a', owner),
      ).resolves.toMatchObject({
        state: ClusterState.Bootstrapping,
        kubernetesIdentity: null,
      });

      const connection = { ...baseCluster, kind: 'installer' as const };
      await expect(
        clusterRecords().storeConnection({
          ...connection,
          clusterId: 'install-a',
        }),
      ).resolves.toBe('stored');
      await expect(
        clusterRecords().storeConnection({
          ...connection,
          clusterId: 'install-a',
          kubernetesIdentity: 'uid-foreign',
        }),
      ).resolves.toBe('identity-mismatch');
      await expect(
        clusterRecords().storeConnection({
          ...connection,
          clusterId: 'missing',
        }),
      ).resolves.toBe('not-found');
      await expect(
        clusterRecords().getConnection('install-a'),
      ).resolves.toMatchObject({
        kind: 'installer',
        kubernetesIdentity: 'uid-cluster-a',
        connectionRevision: 2,
      });
    });
  });

  describe('cluster destroy safety', () => {
    it('destroying clears the connection, bumps the revision and frees the singleton slot', async () => {
      await recordCluster();
      await destroyCluster();

      await expect(
        getDB().query<{ encrypted_connection: string | null }>(
          'SELECT encrypted_connection FROM clusters WHERE id = ?',
          [baseCluster.id],
        ),
      ).resolves.toEqual([{ encrypted_connection: null }]);
      await expect(
        clusterRecords().getConnection(baseCluster.id),
      ).resolves.toBeNull();
      await expect(
        clusterRecords().getByNameForScope('production', owner),
      ).resolves.toBeNull();
      await expect(clusterRecords().listForScope(owner)).resolves.toEqual([]);
      await expect(
        clusterRecords().listForScope(owner, { includeDeleted: true }),
      ).resolves.toMatchObject([
        {
          state: ClusterState.Destroyed,
          connectionRevision: 2,
        },
      ]);
      await expect(
        getDB().query('UPDATE clusters SET state = ? WHERE id = ?', [
          ClusterState.Ready,
          baseCluster.id,
        ]),
      ).rejects.toThrow(/Cluster identity is immutable/);

      await expect(recordCluster({ id: 'cluster-a2' })).resolves.toBe(
        'recorded',
      );
      await expect(
        clusterRecords().getByNameForScope('production', owner),
      ).resolves.toMatchObject({
        id: 'cluster-a2',
        kubernetesIdentity: 'uid-cluster-a',
      });
      // The re-recorded control plane can find the records that bound it
      // before; the active record and other control planes are not listed.
      await expect(
        clusterRecords().listDestroyedClusterIds('uid-cluster-a'),
      ).resolves.toEqual([baseCluster.id]);
      await expect(
        clusterRecords().listDestroyedClusterIds('uid-other'),
      ).resolves.toEqual([]);
    });

    it('refuses destruction while any node pool is not deleted, even through raw SQL', async () => {
      await recordCluster();
      await expect(nodePools().create(baseNodePool)).resolves.toBe('created');

      await expect(
        getDB().query('UPDATE clusters SET state = ? WHERE id = ?', [
          ClusterState.Destroying,
          baseCluster.id,
        ]),
      ).rejects.toThrow(/Cluster still has node pools/);
      await expect(
        clusterRecords().countActiveNodePools(baseCluster.id),
      ).resolves.toBe(1);

      await nodePools().requestDeletion(baseNodePool.id, owner);
      await expect(
        clusters().setState(baseCluster.id, ClusterState.Destroying),
      ).rejects.toThrow(/Cluster still has node pools/);
      await nodePools().markDeleted(baseNodePool.id);
      await expect(
        clusterRecords().countActiveNodePools(baseCluster.id),
      ).resolves.toBe(0);
      await expect(destroyCluster()).resolves.toBeUndefined();
    });
  });

  describe('node pool associations', () => {
    it('creates a node pool under the active cluster with its own credential, region, zone, VM type, OS disk, spot mode and user-namespace Jobs', async () => {
      await recordCluster();

      await expect(
        nodePools().create({
          ...baseNodePool,
          id: 'node-pool-gcp',
          name: 'gcp-central',
          computeCredentialId: 'compute-gcp',
          region: 'us-central1',
          zone: 'us-central1-a',
          vmTypes: ['e2-standard-2'],
          osDiskSizeGb: 200,
          osDiskTier: DiskTier.Ultra,
          spot: true,
          userNamespaceJobs: true,
          requireNestedVirtualization: true,
        }),
      ).resolves.toBe('created');
      await expect(nodePools().create(baseNodePool)).resolves.toBe('created');
      await expect(
        nodePools().getForScope(baseNodePool.id, owner),
      ).resolves.toMatchObject({
        osDiskSizeGb: null,
        osDiskTier: null,
        spot: false,
        allowPrivilegedJobs: false,
        userNamespaceJobs: false,
        requireNestedVirtualization: false,
      });

      await expect(
        nodePools().getForScope('node-pool-gcp', owner),
      ).resolves.toEqual({
        id: 'node-pool-gcp',
        clusterId: baseCluster.id,
        ownerUserId: 'owner-1',
        name: 'gcp-central',
        state: NodePoolState.Creating,
        computeCredentialId: 'compute-gcp',
        cloudProvider: 'GCP',
        region: 'us-central1',
        zone: 'us-central1-a',
        clusterRegion: null,
        vmTypes: ['e2-standard-2'],
        minVmCount: 1,
        maxVmCount: 1,
        osDiskSizeGb: 200,
        osDiskTier: DiskTier.Ultra,
        spot: true,
        allowPrivilegedJobs: false,
        userNamespaceJobs: true,
        requireNestedVirtualization: true,
        lastError: null,
        provisioningFailures: 0,
        provisioningFailedAt: null,
        ingressEntryVmId: null,
        ingressEntryChangedAt: null,
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      });
      await expect(
        nodePools().getByNameForScope('GCP-Central', owner),
      ).resolves.toMatchObject({ id: 'node-pool-gcp' });
    });

    it('refuses node pools for unknown, deleting or deleted clusterRecords', async () => {
      await expect(
        nodePools().create({ ...baseNodePool, clusterId: 'missing' }),
      ).resolves.toBe('cluster-not-accepting');

      await recordCluster();
      await clusters().setState(baseCluster.id, ClusterState.Destroying);
      await expect(nodePools().create(baseNodePool)).resolves.toBe(
        'cluster-not-accepting',
      );
      await expect(
        getDB().query(
          `INSERT INTO node_pools (
             id, cluster_id, owner_user_id, name, state, compute_credential_id,
             region, vm_type, min_vm_count, max_vm_count, created_at, updated_at
           ) VALUES (?, ?, 'owner-1', 'raw', 'creating', 'compute-aws',
             'us-east-1', 't3.small', 1, 1, 1, 1)`,
          ['node-pool-raw', baseCluster.id],
        ),
      ).rejects.toThrow(/Cluster does not accept node pools/);

      await clusters().setState(baseCluster.id, ClusterState.Destroyed);
      await expect(nodePools().create(baseNodePool)).resolves.toBe(
        'cluster-not-accepting',
      );
      await expect(nodePools().listForScope({ kind: 'api' })).resolves.toEqual(
        [],
      );
    });

    it('keeps the cluster association and owned provider facts immutable', async () => {
      await recordCluster();
      await nodePools().create(baseNodePool);

      for (const [column, value] of [
        ['cluster_id', 'cluster-b'],
        ['compute_credential_id', 'compute-gcp'],
        ['region', 'us-west-2'],
        ['zone', 'us-east-1a'],
        ['vm_type', 't3.large'],
        ['name', 'renamed'],
        ['owner_user_id', 'owner-2'],
      ] as const) {
        await expect(
          getDB().query(`UPDATE node_pools SET ${column} = ? WHERE id = ?`, [
            value,
            baseNodePool.id,
          ]),
        ).rejects.toThrow(/Node pool association is immutable/);
      }
      await expect(
        getDB().query('UPDATE node_pools SET max_vm_count = 0 WHERE id = ?', [
          baseNodePool.id,
        ]),
      ).rejects.toThrow(/CHECK constraint failed/);
      await expect(
        nodePools().getForScope(baseNodePool.id, owner),
      ).resolves.toMatchObject({
        clusterId: baseCluster.id,
        region: 'us-east-1',
      });
    });

    it('rejects duplicate active names and non-integer VM counts', async () => {
      await recordCluster();
      await nodePools().create(baseNodePool);

      await expect(
        nodePools().create({
          ...baseNodePool,
          id: 'node-pool-dup',
          name: 'AWS-East',
        }),
      ).rejects.toThrow(/UNIQUE constraint failed: node_pools\.name/);
      await expect(
        nodePools().create({
          ...baseNodePool,
          id: 'node-pool-frac',
          name: 'fractional',
          minVmCount: 1.5,
        }),
      ).rejects.toThrow(/safe integers/);
      await expect(
        nodePools().create({
          ...baseNodePool,
          id: 'node-pool-bounds',
          name: 'bounds',
          minVmCount: 2,
          maxVmCount: 1,
        }),
      ).rejects.toThrow(/CHECK constraint failed/);
      await expect(
        nodePools().getForScope('node-pool-bounds', owner),
      ).resolves.toBeNull();
    });
  });

  describe('node pool credentials', () => {
    it('blocks removing a credential an active node pool uses and unnames it once the node pool is deleted', async () => {
      await recordCluster();
      await nodePools().create(baseNodePool);
      const credentials = getCredentialSecretStore();

      await expect(
        credentials.deleteNamedCredentialIfNotReferenced('aws-compute', false),
      ).resolves.toEqual({ deleted: false, blocking: [baseNodePool.id] });
      await expect(
        getDB().query<{ name: string | null }>(
          `SELECT name FROM credentials WHERE id = 'compute-aws'`,
        ),
      ).resolves.toEqual([{ name: 'aws-compute' }]);

      await expect(
        credentials.deleteNamedCredentialIfNotReferenced('aws-compute', true),
      ).resolves.toEqual({ deleted: true, blocking: [] });
      await expect(
        getDB().query<{ name: string | null }>(
          `SELECT name FROM credentials WHERE id = 'compute-aws'`,
        ),
      ).resolves.toEqual([{ name: null }]);
      await expect(
        nodePools().getForScope(baseNodePool.id, owner),
      ).resolves.toMatchObject({
        computeCredentialId: 'compute-aws',
        cloudProvider: 'AWS',
      });

      await getDB().query(
        `UPDATE credentials SET name = 'aws-compute' WHERE id = 'compute-aws'`,
      );
      await deleteNodePool(baseNodePool.id);
      await expect(
        credentials.deleteNamedCredentialIfNotReferenced('aws-compute', false),
      ).resolves.toEqual({ deleted: true, blocking: [] });
      await expect(
        getDB().query<{ name: string | null }>(
          `SELECT name FROM credentials WHERE id = 'compute-aws'`,
        ),
      ).resolves.toEqual([{ name: null }]);
      await expect(
        getDB().query("DELETE FROM credentials WHERE id = 'compute-aws'"),
      ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    });

    it('lets a credential rotation unname the referenced row instead of failing', async () => {
      await recordCluster();
      await nodePools().create(baseNodePool);

      await expect(
        getCredentialSecretStore().saveNamedCredential(
          'aws-compute',
          'compute-aws-rotated',
          'rotated-material',
          CloudType.AWS,
          { overwrite: true },
        ),
      ).resolves.toBe('compute-aws-rotated');
      await expect(
        getDB().query<{ id: string; name: string | null }>(
          `SELECT id, name FROM credentials
           WHERE id IN ('compute-aws', 'compute-aws-rotated') ORDER BY id`,
        ),
      ).resolves.toEqual([
        { id: 'compute-aws', name: null },
        { id: 'compute-aws-rotated', name: 'aws-compute' },
      ]);
      await expect(
        nodePools().getForScope(baseNodePool.id, owner),
      ).resolves.toMatchObject({ computeCredentialId: 'compute-aws' });
    });
  });

  describe('node pool deletion preserves siblings and the cluster', () => {
    it('deletes one node pool while the sibling node pool and cluster stay usable', async () => {
      await recordCluster();
      await nodePools().create(baseNodePool);
      await nodePools().create({
        ...baseNodePool,
        id: 'node-pool-gcp',
        name: 'gcp-central',
        computeCredentialId: 'compute-gcp',
        region: 'us-central1',
        zone: 'us-central1-a',
        vmTypes: ['e2-standard-2'],
      });

      await expect(
        nodePools().requestDeletion(baseNodePool.id, owner),
      ).resolves.toBe('requested');
      await expect(
        nodePools().requestDeletion(baseNodePool.id, owner),
      ).resolves.toBe('already-deleting');
      await expect(nodePools().markDeleted(baseNodePool.id)).resolves.toBe(
        true,
      );
      await expect(nodePools().markDeleted(baseNodePool.id)).resolves.toBe(
        false,
      );
      await expect(
        nodePools().requestDeletion(baseNodePool.id, owner),
      ).resolves.toBe('already-deleted');
      await expect(
        getDB().query('UPDATE node_pools SET state = ? WHERE id = ?', [
          NodePoolState.Creating,
          baseNodePool.id,
        ]),
      ).rejects.toThrow(/Node pool association is immutable/);

      await expect(
        nodePools().getForScope('node-pool-gcp', owner),
      ).resolves.toMatchObject({ state: NodePoolState.Creating });
      await expect(
        clusterRecords().getForScope(baseCluster.id, owner),
      ).resolves.toMatchObject({
        state: ClusterState.Ready,
        connectionRevision: 1,
      });
      await expect(
        nodePools().listForScope(owner, { clusterId: baseCluster.id }),
      ).resolves.toMatchObject([{ id: 'node-pool-gcp' }]);
      await expect(
        nodePools().listForScope(owner, { includeDeleted: true }),
      ).resolves.toHaveLength(2);
      await expect(
        nodePools().getByNameForScope('aws-east', owner),
      ).resolves.toBeNull();

      await expect(
        nodePools().create({ ...baseNodePool, id: 'node-pool-aws-2' }),
      ).resolves.toBe('created');
      // Unpinned: the cluster's region is read with the pool.
      await expect(
        nodePools().create({
          ...baseNodePool,
          id: 'node-pool-unpinned',
          name: 'unpinned',
          region: null,
        }),
      ).resolves.toBe('created');
      await expect(
        nodePools().getForScope('node-pool-unpinned', owner),
      ).resolves.toMatchObject({ region: null, clusterRegion: null });
    });
    it("reads the cluster's region with an unpinned pool only when the pool is on the cluster's cloud", async () => {
      // A record of a cluster provisioned on AWS, which a hosted API's own
      // record is not.
      await getDB().query(
        `INSERT INTO clusters (
           id, owner_user_id, name, state, step, compute_credential_id, region,
           kubernetes_identity, connection_kind, created_at, updated_at
         ) VALUES (?, 'owner-1', 'production', 'ready', 'release', 'compute-aws',
           'us-east-2', 'uid-cluster-a', 'in-cluster', 1, 1)`,
        [baseCluster.id],
      );
      await nodePools().create({ ...baseNodePool, region: null });
      await nodePools().create({
        ...baseNodePool,
        id: 'node-pool-gcp',
        name: 'gcp',
        computeCredentialId: 'compute-gcp',
        region: null,
        vmTypes: ['e2-standard-2'],
      });
      await expect(
        nodePools().getForScope(baseNodePool.id, owner),
      ).resolves.toMatchObject({ clusterRegion: 'us-east-2' });
      // An AWS region name is no GCP region.
      await expect(
        nodePools().getForScope('node-pool-gcp', owner),
      ).resolves.toMatchObject({ clusterRegion: null });
    });

    it('reads its own classified launch failures in the window, with disposition from its pins and spot mode', async () => {
      await recordCluster();
      // A GCP region pin without a zone fails over between zones.
      const pool = {
        ...baseNodePool,
        id: 'node-pool-gcp',
        name: 'gcp-central',
        computeCredentialId: 'compute-gcp',
        region: 'us-central1',
        vmTypes: ['e2-standard-2'],
        spot: true,
      };
      await nodePools().create(pool);
      await nodePools().create({ ...baseNodePool, region: null });
      const attempt = (nodePoolId: string, cloudId: string) =>
        nodePoolVms().beginVmAttempt(nodePoolId, {
          cloudId,
          vmType: nodePoolId === pool.id ? 'e2-standard-2' : 't3.small',
          region: 'us-central1',
          availabilityZone: cloudId,
          desiredVmCount: 5,
        });
      const capacity = { diagnosis: CloudFailureDiagnosis.CapacityExhausted };
      const since = Date.now();
      for (const [nodePoolId, cloudId] of [
        [pool.id, 'a'],
        [pool.id, 'b'],
        [baseNodePool.id, 'c'],
      ]) {
        const ref = await attempt(nodePoolId, cloudId);
        await nodePoolVms().recordLaunchFailure(nodePoolId, ref!, {
          ...capacity,
          regionDenied: null,
        });
      }
      await attempt(pool.id, 'launched');
      await getDB().query(
        "UPDATE vms SET created_at = ? WHERE availability_zone = 'a'",
        [since - 1],
      );

      await expect(
        nodePoolVms().listLaunchFailures(pool.id, since),
      ).resolves.toEqual([
        {
          credentialId: 'compute-gcp',
          vmType: 'e2-standard-2',
          region: 'us-central1',
          availabilityZone: 'b',
          ...capacity,
          disposition: FailureDisposition.FailoverTarget,
          regionDenied: null,
          // A spot pool's failures match its spot targets.
          spot: true,
          createdAt: expect.any(Number),
          vmRowId: expect.any(Number),
        },
      ]);
      // An on-demand pool's failures match its on-demand targets.
      expect(
        (await nodePoolVms().listLaunchFailures(baseNodePool.id, since)).map(
          (failure) => failure.spot,
        ),
      ).toEqual([false]);
    });
  });

  describe('node pool VM attempts', () => {
    it('records attempts with the picked target, fences the live count and confirms release before ending', async () => {
      await recordCluster();
      await nodePools().create(baseNodePool);

      const first = await nodePoolVms().beginVmAttempt(baseNodePool.id, {
        cloudId: 'node-pool-aws-vm-1',
        ...target,
        pricePerHour: 0.5,
        desiredVmCount: 1,
      });
      expect(first).toMatchObject({ cloudId: 'node-pool-aws-vm-1' });
      await expect(
        nodePoolVms().beginVmAttempt(baseNodePool.id, {
          cloudId: 'node-pool-aws-vm-2',
          ...target,
          desiredVmCount: 1,
        }),
      ).resolves.toBeNull();
      await expect(
        nodePoolVms().beginVmAttempt('missing', {
          cloudId: 'x',
          ...target,
          desiredVmCount: 1,
        }),
      ).resolves.toBeNull();
      await expect(
        nodePoolVms().beginVmAttempt(baseNodePool.id, {
          cloudId: 'x',
          ...target,
          desiredVmCount: 1.5,
        }),
      ).rejects.toThrow(/non-negative integer/);

      const [row] = await getDB().query<Record<string, unknown>>(
        'SELECT * FROM vms WHERE id = ?',
        [first!.vmRowId],
      );
      expect(row).toMatchObject({
        node_pool_id: baseNodePool.id,
        workload_id: null,
        cluster_id: null,
        credential_id: 'compute-aws',
        region: 'us-east-1',
        availability_zone: 'us-east-1a',
        vm_type: 't3.small',
        price_per_hour: 0.5,
        ip: null,
      });

      await expect(
        nodePoolVms().completeVmAttempt(baseNodePool.id, first!, {
          cloudId: 'i-0abc',
          ip: '203.0.113.10',
          privateIp: '10.0.0.10',
          createdAt: first!.createdAt + 5,
        }),
      ).resolves.toEqual({
        vmRowId: first!.vmRowId,
        cloudId: 'i-0abc',
        createdAt: first!.createdAt + 5,
      });
      // A replayed completion for the same provider identity is idempotent.
      await expect(
        nodePoolVms().completeVmAttempt(baseNodePool.id, first!, {
          cloudId: 'i-0abc',
          ip: '203.0.113.10',
        }),
      ).resolves.toMatchObject({ cloudId: 'i-0abc' });
      await expect(
        nodePoolVms().completeVmAttempt(baseNodePool.id, first!, {
          cloudId: 'i-other',
          ip: '203.0.113.11',
        }),
      ).rejects.toThrow(/missing or already completed/);
      await expect(
        nodePoolVms().listVms(baseNodePool.id),
      ).resolves.toMatchObject([
        {
          id: first!.vmRowId,
          cloudId: 'i-0abc',
          ip: '203.0.113.10',
          endedAt: null,
        },
      ]);

      // The node pool cannot finish deleting while the attempt is live.
      await nodePools().requestDeletion(baseNodePool.id, owner);
      await expect(nodePools().markDeleted(baseNodePool.id)).resolves.toBe(
        false,
      );
      const claimed = await nodePoolVms().claimVmRemoval(
        baseNodePool.id,
        first!.vmRowId,
      );
      expect(claimed?.removalRequestedAt).toEqual(expect.any(Number));
      await expect(nodePools().markDeleted(baseNodePool.id)).resolves.toBe(
        false,
      );
      await expect(
        nodePoolVms().endVm(baseNodePool.id, first!.vmRowId, nodeDeleted()),
      ).resolves.toBe(true);
      await expect(
        nodePoolVms().endVm(baseNodePool.id, first!.vmRowId, nodeNotObserved()),
      ).resolves.toBe(false);
      await expect(
        nodePoolVms().claimVmRemoval(baseNodePool.id, first!.vmRowId),
      ).resolves.toBeNull();
      await expect(nodePools().markDeleted(baseNodePool.id)).resolves.toBe(
        true,
      );
    });

    it('scopes attempts to their node pool and never lets another node pool end them', async () => {
      await recordCluster();
      await nodePools().create(baseNodePool);
      await nodePools().create({
        ...baseNodePool,
        id: 'node-pool-gcp',
        name: 'gcp-central',
        computeCredentialId: 'compute-gcp',
        region: 'us-central1',
        vmTypes: ['e2-standard-2'],
      });
      const aws = await nodePoolVms().beginVmAttempt(baseNodePool.id, {
        cloudId: 'aws-vm',
        ...target,
        desiredVmCount: 1,
      });
      const gcp = await nodePoolVms().beginVmAttempt('node-pool-gcp', {
        cloudId: 'gcp-vm',
        vmType: 'e2-standard-2',
        region: 'us-central1',
        availabilityZone: null,
        desiredVmCount: 1,
      });

      await expect(
        nodePoolVms().listVms(baseNodePool.id),
      ).resolves.toHaveLength(1);
      await expect(
        nodePoolVms().listVms('node-pool-gcp'),
      ).resolves.toMatchObject([
        {
          id: gcp!.vmRowId,
          credentialId: 'compute-gcp',
          region: 'us-central1',
        },
      ]);
      await expect(
        nodePoolVms().claimVmRemoval('node-pool-gcp', aws!.vmRowId),
      ).resolves.toBeNull();
      await expect(
        nodePoolVms().endVm('node-pool-gcp', aws!.vmRowId, nodeNotObserved()),
      ).resolves.toBe(false);
    });

    it('counts consecutive provisioning failures durably', async () => {
      await recordCluster();
      await nodePools().create(baseNodePool);

      await expect(
        nodePools().recordProvisioningFailure(baseNodePool.id, 1_000),
      ).resolves.toBe(1);
      await expect(
        nodePools().recordProvisioningFailure(baseNodePool.id, 2_000),
      ).resolves.toBe(2);
      await expect(
        nodePools().getForScope(baseNodePool.id, owner),
      ).resolves.toMatchObject({
        provisioningFailures: 2,
        provisioningFailedAt: 2_000,
      });
      await nodePools().resetProvisioningFailures(baseNodePool.id);
      await expect(
        nodePools().getForScope(baseNodePool.id, owner),
      ).resolves.toMatchObject({
        provisioningFailures: 0,
        provisioningFailedAt: null,
        ingressEntryVmId: null,
        ingressEntryChangedAt: null,
      });
      const entry = await nodePoolVms().beginVmAttempt(baseNodePool.id, {
        cloudId: 'vm-entry',
        ...target,
        desiredVmCount: 1,
      });
      await expect(
        nodePools().setIngressEntry(baseNodePool.id, entry!.vmRowId, 4_000),
      ).resolves.toBe(true);
      await expect(
        nodePools().setIngressEntry(baseNodePool.id, entry!.vmRowId, 5_000),
      ).resolves.toBe(false);
      await expect(
        nodePools().getForScope(baseNodePool.id, owner),
      ).resolves.toMatchObject({
        ingressEntryVmId: entry!.vmRowId,
        ingressEntryChangedAt: 4_000,
      });
      await expect(
        nodePools().setIngressEntry(baseNodePool.id, null, 6_000),
      ).resolves.toBe(true);
      await expect(
        nodePools().setIngressEntry(baseNodePool.id, 999_999, 7_000),
      ).rejects.toThrow(/FOREIGN KEY constraint failed/);
      await expect(
        nodePools().recordProvisioningFailure('missing', 1),
      ).resolves.toBe(0);
      await expect(
        getDB().query(
          'UPDATE node_pools SET provisioning_failures = -1 WHERE id = ?',
          [baseNodePool.id],
        ),
      ).rejects.toThrow(/CHECK constraint failed/);
    });

    it("fences deletion against a Deployment admitted between the caller's check and the request", async () => {
      await recordCluster();
      await nodePools().create(baseNodePool);
      await nodePools().markReady(baseNodePool.id);
      const deployments = getPersistence().deployments;
      const admit = (id: string) =>
        deployments.create(
          {
            id,
            ownerUserId: 'owner-1',
            name: id,
            nodePoolId: baseNodePool.id,
            config: makeContainerSpec(),
            gpuCount: 0,
            maxConcurrentJobsPerReplica: 1,
          },
          owner,
        );

      // The caller's pre-check saw no references; an admission commits just
      // before the request's transaction opens.
      expect(await deployments.countLiveForNodePool(baseNodePool.id)).toBe(0);
      const inner = getDB();
      let interleaved = false;
      const racing: DB = {
        query: (sql, params) => inner.query(sql, params),
        read: (fn) => inner.read(fn),
        async transaction(fn) {
          if (!interleaved) {
            interleaved = true;
            expect(await admit('dep-racing')).toBe(true);
          }
          return inner.transaction(fn);
        },
      };
      await expect(
        new NodePoolStore(racing).requestDeletion(baseNodePool.id, owner),
      ).resolves.toBe('referenced');
      await expect(
        nodePools().getForScope(baseNodePool.id, owner),
      ).resolves.toMatchObject({ state: NodePoolState.Ready });

      // Releasing the record lets the request through.
      await deployments.requestDeletion('dep-racing', owner);
      await expect(
        nodePools().requestDeletion(baseNodePool.id, owner),
      ).resolves.toBe('referenced');
      await deployments.markDeleted('dep-racing');
      await expect(
        nodePools().requestDeletion(baseNodePool.id, owner),
      ).resolves.toBe('requested');
      // A Deployment cannot be admitted onto a deleting node pool.
      expect(await admit('dep-late')).toBe(false);
    });

    it('fences deletion on a live node pool Service until its cleanup confirms removal', async () => {
      await recordCluster();
      await nodePools().create(baseNodePool);
      await nodePools().markReady(baseNodePool.id);
      await seedTestWorkload({
        id: 'svc-live',
        userId: 'alice',
        ownerUserId: 'owner-1',
        workloadType: 'service',
        image: 'ghcr.io/acme/api:v1',
        dockerCommand: '',
        nodePoolId: baseNodePool.id,
        state: WorkloadState.Terminated,
      });
      const workloads = getPersistence().nodePoolServices;
      // A terminated Service whose native objects are not yet confirmed
      // removed still references the node pool — that definition, read
      // through the same predicate text the fence renders.
      await expect(
        workloads.hasLiveNodePoolReferences(baseNodePool.id),
      ).resolves.toBe(true);
      await expect(
        workloads.countLiveNodePoolReferences(baseNodePool.id),
      ).resolves.toBe(1);
      await expect(
        nodePools().requestDeletion(baseNodePool.id, owner),
      ).resolves.toBe('referenced');
      await expect(
        nodePools().getForScope(baseNodePool.id, owner),
      ).resolves.toMatchObject({ state: NodePoolState.Ready });

      expect(
        await getWorkloadOutcomes().markCleanupComplete('svc-live', {}),
      ).toBe(true);
      await expect(
        workloads.hasLiveNodePoolReferences(baseNodePool.id),
      ).resolves.toBe(false);
      await expect(
        workloads.countLiveNodePoolReferences(baseNodePool.id),
      ).resolves.toBe(0);
      await expect(
        nodePools().requestDeletion(baseNodePool.id, owner),
      ).resolves.toBe('requested');
    });

    it('reads a pool as published at an IP once every live Service record there points at it', async () => {
      await recordCluster();
      await nodePools().create(baseNodePool);
      await nodePools().markReady(baseNodePool.id);
      const service = async (id: string, state: WorkloadState) => {
        await seedTestWorkload({
          id,
          userId: 'alice',
          ownerUserId: 'owner-1',
          workloadType: 'service',
          image: 'ghcr.io/acme/api:v1',
          dockerCommand: '',
          nodePoolId: baseNodePool.id,
          state,
        });
      };
      const endpoint = (id: string, ip: string, state = 'published') =>
        getDB().query(
          `UPDATE workloads SET dns_record_id = 'rec', public_endpoint_ip = ?,
             public_endpoint_state = ? WHERE id = ?`,
          [ip, state, id],
        );
      await service('svc-a', WorkloadState.Running);
      await service('svc-unpublished', WorkloadState.Running);
      await service('svc-ended', WorkloadState.Terminated);
      await endpoint('svc-a', '198.51.100.1');
      await endpoint('svc-ended', '198.51.100.1');
      const published = (ip: string) =>
        getPersistence().nodePoolServices.publishedAt(baseNodePool.id, ip);
      await expect(published('198.51.100.2')).resolves.toBe(false);
      await endpoint('svc-a', '198.51.100.2', 'repointing');
      await expect(published('198.51.100.2')).resolves.toBe(false);
      await endpoint('svc-a', '198.51.100.2');
      await expect(published('198.51.100.2')).resolves.toBe(true);
    });

    it('tracks controller readiness, failure and deletion diagnostics', async () => {
      await recordCluster();
      await nodePools().create(baseNodePool);

      await expect(nodePools().listForReconciliation()).resolves.toMatchObject([
        { id: baseNodePool.id, state: NodePoolState.Creating },
      ]);
      await expect(
        nodePools().markFailed(baseNodePool.id, 'quota exceeded'),
      ).resolves.toBe(true);
      await expect(
        nodePools().getForScope(baseNodePool.id, owner),
      ).resolves.toMatchObject({
        state: NodePoolState.Failed,
        lastError: 'quota exceeded',
      });
      await expect(nodePools().markReady(baseNodePool.id)).resolves.toBe(true);
      await expect(
        nodePools().getForScope(baseNodePool.id, owner),
      ).resolves.toMatchObject({
        state: NodePoolState.Ready,
        lastError: null,
      });
      await nodePools().recordError(baseNodePool.id, 'backing off');
      await expect(
        nodePools().getForScope(baseNodePool.id, owner),
      ).resolves.toMatchObject({
        state: NodePoolState.Ready,
        lastError: 'backing off',
      });
      // A cap block's reason outlives readiness until a purchase clears it.
      const blocked = `${SCALE_OUT_CAP_BLOCK_PREFIX}blocked by throttle`;
      await nodePools().recordError(baseNodePool.id, blocked);
      await nodePools().markReady(baseNodePool.id);
      await expect(
        nodePools().getForScope(baseNodePool.id, owner),
      ).resolves.toMatchObject({ lastError: blocked });
      await nodePools().clearError(baseNodePool.id, SCALE_OUT_CAP_BLOCK_PREFIX);

      await nodePools().recordDeletionError(baseNodePool.id, 'ignored');
      await expect(
        nodePools().getForScope(baseNodePool.id, owner),
      ).resolves.toMatchObject({ lastError: null });
      await nodePools().requestDeletion(baseNodePool.id, owner);
      await nodePools().recordDeletionError(baseNodePool.id, 'node stuck');
      await expect(
        nodePools().getForScope(baseNodePool.id, owner),
      ).resolves.toMatchObject({
        state: NodePoolState.Deleting,
        lastError: 'node stuck',
      });
      await expect(nodePools().markReady(baseNodePool.id)).resolves.toBe(false);
      await nodePools().markDeleted(baseNodePool.id);
      await expect(nodePools().listForReconciliation()).resolves.toEqual([]);
    });
  });
});
