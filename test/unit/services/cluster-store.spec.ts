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
  });
});
