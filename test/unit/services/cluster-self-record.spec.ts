import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HostedClusterRefusedError,
  hostedClusterEnvironment,
  recordHostedCluster,
} from '../../../src/api/services/cluster-self-record.js';
import {
  parseClusterConnection,
  type ClusterConnectionDocument,
} from '../../../src/api/services/kubernetes/cluster-connection.js';
import {
  getPersistence,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { ClusterState } from '../../../src/shared/clusters.js';

const CA = Buffer.from('ca').toString('base64');
const env = {
  name: 'production',
  kubernetesIdentity: 'uid-production',
  joinEndpoint: 'https://203.0.113.5:6443',
  certificateAuthorityData: CA,
};

const RECORD = {
  cloudProvider: CloudType.AWS,
  cloudAccount: '123456789012',
  region: 'us-east-1',
  zone: 'us-east-1a',
  vmType: 't3.medium',
  managementVmId: 'i-0123456789abcdef0',
  networkScope: 'anycloud-cluster-install-1',
  k3s: { version: 'v1.35.5+k3s1', sha256: 'a'.repeat(64) },
  checkpointBucket: { name: 'install-1', managed: true },
};

describe('hosted API cluster self-record', () => {
  beforeEach(() => {
    resetPersistence();
  });

  it('requires every chart-set value and an https join endpoint', () => {
    expect(hostedClusterEnvironment(env)).toEqual({
      name: 'production',
      kubernetesIdentity: 'uid-production',
      joinEndpoint: 'https://203.0.113.5:6443',
      certificateAuthorityData: CA,
      record: null,
    });
    for (const key of Object.keys(env) as Array<keyof typeof env>) {
      expect(() =>
        hostedClusterEnvironment({ ...env, [key]: undefined }),
      ).toThrow(`cluster.${key} is not set`);
    }
    expect(() =>
      hostedClusterEnvironment({
        ...env,
        joinEndpoint: 'http://203.0.113.5:6443',
      }),
    ).toThrow(HostedClusterRefusedError);
  });

  it('reads the cluster record and refuses one that is malformed or carries anything else', () => {
    expect(
      hostedClusterEnvironment({ ...env, record: JSON.stringify(RECORD) })
        .record,
    ).toEqual(RECORD);
    for (const record of [
      '{',
      JSON.stringify({ ...RECORD, region: '' }),
      JSON.stringify({ ...RECORD, cloudProvider: 'Cloudflare' }),
      // Secrets never travel in the record.
      JSON.stringify({ ...RECORD, sshPrivateKey: 'key' }),
      JSON.stringify({ ...RECORD, k3s: { ...RECORD.k3s, token: 't' } }),
    ]) {
      expect(
        () => hostedClusterEnvironment({ ...env, record }),
        record,
      ).toThrow(HostedClusterRefusedError);
    }
  });

  it("keeps the record on its row, immutable but for an adoption, which takes the new cluster's", async () => {
    const input = {
      clusterId: 'install-1',
      ownerUserId: '42',
      environment: hostedClusterEnvironment({
        ...env,
        record: JSON.stringify(RECORD),
      }),
      installations: getPersistence().clusters,
      observeKubernetesIdentity: async () => 'uid-production',
    };
    await expect(recordHostedCluster(input)).resolves.toBe('recorded');
    const read = () =>
      getPersistence().clusterRecords.getForScope('install-1', { kind: 'api' });
    await expect(read()).resolves.toMatchObject({ record: RECORD });
    for (const sql of [
      `region = 'us-west-2'`,
      `cloud_account = '999999999999'`,
      `management_vm_id = 'i-other'`,
      `network_scope = 'other'`,
      // Delete acts on the managed flag: a user's bucket is never deleted.
      'checkpoint_bucket_managed = 0',
    ]) {
      await expect(
        getDB().query(`UPDATE clusters SET ${sql} WHERE id = 'install-1'`),
        sql,
      ).rejects.toThrow(/Cluster identity is immutable/);
    }

    const restored = {
      ...RECORD,
      region: 'us-west-2',
      zone: null,
      managementVmId: 'i-restored',
      checkpointBucket: { name: 'my-api-state', managed: false },
    };
    await expect(
      recordHostedCluster({
        ...input,
        environment: hostedClusterEnvironment({
          ...env,
          kubernetesIdentity: 'uid-restored',
          record: JSON.stringify(restored),
        }),
        observeKubernetesIdentity: async () => 'uid-restored',
      }),
    ).resolves.toBe('adopted');
    await expect(read()).resolves.toMatchObject({ record: restored });
  });

  it('records the in-cluster connection under the installation id once, then finds it again', async () => {
    const observe = vi.fn<
      (connection: ClusterConnectionDocument) => Promise<string>
    >(async () => 'uid-production');
    const input = {
      clusterId: 'install-1',
      ownerUserId: '42',
      environment: hostedClusterEnvironment(env),
      installations: getPersistence().clusters,
      observeKubernetesIdentity: observe,
    };
    await expect(recordHostedCluster(input)).resolves.toBe('recorded');
    expect(observe.mock.calls[0][0]).toEqual({
      kind: 'in-cluster',
      server: 'https://203.0.113.5:6443',
      certificateAuthorityData: CA,
    });
    await expect(recordHostedCluster(input)).resolves.toBe('exists');

    const clusterRecords = getPersistence().clusterRecords;
    await expect(
      clusterRecords.getForScope('install-1', { kind: 'api' }),
    ).resolves.toMatchObject({
      name: 'production',
      state: ClusterState.Ready,
      kubernetesIdentity: 'uid-production',
    });
    const stored = await clusterRecords.getConnection('install-1');
    expect(stored?.kind).toBe('in-cluster');
    expect(parseClusterConnection(stored!.connection)).toEqual(
      observe.mock.calls[0][0],
    );
  });

  it('refuses to start against a control plane other than the one bootstrap observed', async () => {
    const installations = getPersistence().clusters;
    const base = {
      clusterId: 'install-1',
      ownerUserId: '42',
      environment: hostedClusterEnvironment(env),
      installations,
    };
    await expect(
      recordHostedCluster({
        ...base,
        observeKubernetesIdentity: async () => 'uid-other',
      }),
    ).rejects.toThrow(
      'runs in cluster uid-other but was installed for uid-production',
    );
    await expect(installations.listForScope({ kind: 'api' })).resolves.toEqual(
      [],
    );
  });

  it('refuses to start when the restored record cannot adopt the new identity', async () => {
    await expect(
      recordHostedCluster({
        clusterId: 'install-1',
        ownerUserId: '42',
        environment: hostedClusterEnvironment(env),
        installations: {
          recordSelf: async () => 'identity-mismatch',
          adoptSelf: async () => false,
        },
        observeKubernetesIdentity: async () => 'uid-production',
      }),
    ).rejects.toThrow(HostedClusterRefusedError);
  });

  it('adopts the new cluster when a restored database records another identity', async () => {
    const installations = getPersistence().clusters;
    const record = (id: string) =>
      installations.recordSelf({
        id,
        ownerUserId: '42',
        name: `${id}-root`,
        kubernetesIdentity: `uid-${id}`,
        connection: '{"stored":true}',
      });
    await record('install-other');
    await getDB().query(
      `UPDATE clusters SET state = 'destroyed', encrypted_connection = NULL WHERE id = 'install-other'`,
    );
    await record('install-1');
    await getDB().query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider) VALUES ('cred-a', 'x', 'AWS')`,
    );
    await getDB().query(
      `INSERT INTO workloads (id, user_id, workload_type, state, started_at,
         submitted_at, docker_command, ssh_private_key)
       VALUES ('workload-1', '42', 'vm', 'running', 1, 1, 'cmd', '')`,
    );
    await getDB().query(
      `INSERT INTO vms (workload_id, cloud_id, created_at, credential_id, ended_at)
       VALUES ('workload-1', 'i-workload', 1, 'cred-a', NULL)`,
    );
    const input = {
      clusterId: 'install-1',
      ownerUserId: '42',
      environment: hostedClusterEnvironment(env),
      installations,
      observeKubernetesIdentity: async () => 'uid-production',
    };
    await expect(recordHostedCluster(input)).resolves.toBe('adopted');
    await expect(
      getPersistence().clusterRecords.getConnection('install-1'),
    ).resolves.toMatchObject({
      kubernetesIdentity: 'uid-production',
      connectionRevision: 2,
    });
    // A Workload VM stays unclaimed.
    await expect(
      getDB().query(
        `SELECT cloud_id FROM vms WHERE removal_requested_at IS NOT NULL`,
      ),
    ).resolves.toEqual([]);
    await expect(recordHostedCluster(input)).resolves.toBe('exists');
    // Only adoption moves the identity, by exactly one generation, to a
    // non-NULL new identity.
    const rewrite = (sql: string) =>
      getDB().query(`UPDATE clusters SET ${sql} WHERE id = 'install-1'`);
    for (const sql of [
      `kubernetes_identity = 'uid-raw'`,
      `kubernetes_identity = 'uid-raw', identity_generation = identity_generation + 2`,
      'identity_generation = identity_generation + 5',
      'identity_generation = identity_generation + 1',
      'kubernetes_identity = NULL, identity_generation = identity_generation + 1',
      `kubernetes_identity = 'uid-raw', identity_generation = identity_generation - 1`,
    ])
      await expect(rewrite(sql), sql).rejects.toThrow(
        /Cluster identity is immutable/,
      );
  });
});
