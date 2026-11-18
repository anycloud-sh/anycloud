import { beforeEach, describe, expect, it } from 'vitest';
import {
  getPersistence,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { decryptSecret } from '../../../src/api/services/secret-crypto.js';
import { ClusterState } from '../../../src/shared/clusters.js';

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

describe('cluster persistence', () => {
  beforeEach(async () => {
    resetPersistence();
    await getDB().query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider, name, created_at, last_used_at)
       VALUES ('compute-aws', 'opaque', 'AWS', 'aws-compute', 1, 1)`,
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
  });
});
