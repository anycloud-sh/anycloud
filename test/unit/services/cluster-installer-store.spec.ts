import { beforeEach, describe, expect, it } from 'vitest';
import {
  getCredentialSecretStore,
  getPersistence,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import {
  ClusterState,
  ClusterStep,
  ClusterReleaseState,
} from '../../../src/shared/clusters.js';
import {
  SYSTEM_RELEASE_HELM_JOB_IMAGE,
  SYSTEM_RELEASE_K3S_SHA256,
  SYSTEM_RELEASE_K3S_VERSION,
} from '../../../src/shared/system-release.js';

const owner = { kind: 'api' } as const;
const DIGEST = `sha256:${'a'.repeat(64)}`;

const intent = {
  id: 'install-a',
  ownerUserId: 'owner-1',
  name: 'production',
  computeCredentialId: 'compute-aws',
  region: 'us-east-1',
  zone: null,
  vmType: 't3.medium',
  k3sVersion: SYSTEM_RELEASE_K3S_VERSION,
  k3sSha256: SYSTEM_RELEASE_K3S_SHA256,
  helmJobImage: SYSTEM_RELEASE_HELM_JOB_IMAGE,
  apiVersion: '0.1.64',
  apiImage: `ghcr.io/anycloud-sh/api:0.1.64@${DIGEST}`,
  chartVersion: '0.1.0',
  chartSha256: 'c'.repeat(64),
  checkpointBucket: { name: 'api-state', managed: false },
  restoreFromBackup: false,
  serverToken: 'server-token-secret',
  sshPublicKey: 'ssh-ed25519 AAAA anycloud',
  sshPrivateKey:
    '-----BEGIN OPENSSH PRIVATE KEY-----\nPRIVATE-KEY-SECRET\n-----END OPENSSH PRIVATE KEY-----\n',
};

function store() {
  return getPersistence().clusters;
}

describe('kubernetes cluster persistence', () => {
  beforeEach(async () => {
    resetPersistence();
    await getDB().query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider, name, created_at, last_used_at)
       VALUES ('compute-aws', 'opaque', 'AWS', 'aws-compute', 1, 1)`,
    );
  });

  it('records intent once with encrypted secrets', async () => {
    await expect(store().record(intent)).resolves.toBe('recorded');
    await expect(store().record({ ...intent, id: 'install-b' })).resolves.toBe(
      'installation-exists',
    );
    await expect(
      store().record({ ...intent, id: 'install-c', name: 'PRODUCTION' }),
    ).resolves.toBe('installation-exists');

    const stored = await store().getForScope('install-a', owner);
    expect(stored).toMatchObject({
      id: 'install-a',
      state: ClusterState.Bootstrapping,
      step: ClusterStep.Intent,
      cloudProvider: 'AWS',
      k3sSha256: SYSTEM_RELEASE_K3S_SHA256,
      checkpointBucket: { name: 'api-state', managed: false },
      connectionId: null,
      kubernetesIdentity: null,
    });
    await expect(
      store().getByNameForScope('Production', owner),
    ).resolves.toMatchObject({
      id: 'install-a',
    });
    const [row] = await getDB().query<{
      encrypted_server_token: string;
      encrypted_ssh_private_key: string;
    }>(
      'SELECT encrypted_server_token, encrypted_ssh_private_key FROM clusters',
    );
    expect(row.encrypted_server_token).not.toContain('server-token-secret');
    expect(row.encrypted_ssh_private_key).not.toContain('PRIVATE-KEY-SECRET');
    await expect(store().getBootstrapSecrets('install-a')).resolves.toEqual({
      serverToken: 'server-token-secret',
      sshPublicKey: 'ssh-ed25519 AAAA anycloud',
      // Byte-identical, trailing newline included: OpenSSH refuses a trimmed key.
      sshPrivateKey:
        '-----BEGIN OPENSSH PRIVATE KEY-----\nPRIVATE-KEY-SECRET\n-----END OPENSSH PRIVATE KEY-----\n',
    });
  });

  it('keeps recorded intent immutable even against raw SQL', async () => {
    await store().record(intent);
    for (const column of [
      'region',
      'vm_type',
      'k3s_sha256',
      'api_image',
      'chart_sha256',
    ]) {
      await expect(
        getDB().query(`UPDATE clusters SET ${column} = 'x' WHERE id = ?`, [
          'install-a',
        ]),
      ).rejects.toThrow('identity is immutable');
    }
    await store().recordKubernetesIdentity('install-a', 'uid-1');
    await expect(
      getDB().query(
        `UPDATE clusters SET kubernetes_identity = 'uid-2' WHERE id = ?`,
        ['install-a'],
      ),
    ).rejects.toThrow('identity is immutable');
  });

  it('records one live management VM attempt per installation and adopts it on resume', async () => {
    await store().record(intent);
    const first = await store().beginManagementVmAttempt(
      'install-a',
      'anycloud-cluster-install-a',
    );
    const again = await store().beginManagementVmAttempt(
      'install-a',
      'anycloud-cluster-install-a',
    );
    expect(again).toEqual(first);

    const rows = await getDB().query<{
      cluster_id: string;
      ip: string | null;
      credential_id: string;
      vm_type: string;
    }>('SELECT cluster_id, ip, credential_id, vm_type FROM vms');
    expect(rows).toEqual([
      {
        cluster_id: 'install-a',
        ip: null,
        credential_id: 'compute-aws',
        vm_type: 't3.medium',
      },
    ]);

    await store().completeManagementVmAttempt('install-a', first, {
      cloudId: 'i-0123',
      ip: '203.0.113.1',
      createdAt: 5,
    });
    await expect(store().getManagementVm('install-a')).resolves.toMatchObject({
      id: first.vmRowId,
      cloudId: 'i-0123',
      ip: '203.0.113.1',
      credentialId: 'compute-aws',
    });
    // Completing again with the same VM is a no-op; a different VM is refused.
    await store().completeManagementVmAttempt('install-a', first, {
      cloudId: 'i-0123',
      ip: '203.0.113.1',
    });
    await expect(
      store().completeManagementVmAttempt('install-a', first, {
        cloudId: 'i-9999',
        ip: '203.0.113.2',
      }),
    ).rejects.toThrow('already completed');
    const resumed = await store().beginManagementVmAttempt(
      'install-a',
      'anycloud-cluster-install-a',
    );
    expect(resumed).toEqual({
      vmRowId: first.vmRowId,
      cloudId: 'i-0123',
      createdAt: 5,
    });

    await expect(store().hasReleasedManagementVm('install-a')).resolves.toBe(
      false,
    );
    await store().endManagementVm('install-a', first.vmRowId);
    await expect(store().getManagementVm('install-a')).resolves.toBeNull();
    await expect(store().hasReleasedManagementVm('install-a')).resolves.toBe(
      true,
    );
    await store().setState(
      'install-a',
      ClusterState.DestroyFailed,
      'release not confirmed',
    );
    await expect(
      store().getForScope('install-a', owner),
    ).resolves.toMatchObject({
      state: ClusterState.DestroyFailed,
      lastError: 'release not confirmed',
    });
  });

  it('refuses a management VM row without exactly one owner', async () => {
    await store().record(intent);
    await expect(
      getDB().query(
        `INSERT INTO vms (cluster_id, workload_id, cloud_id, created_at) VALUES ('install-a', 'workload-x', 'x', 1)`,
      ),
    ).rejects.toThrow('CHECK constraint failed');
    await expect(
      getDB().query(`INSERT INTO vms (cloud_id, created_at) VALUES ('x', 1)`),
    ).rejects.toThrow('CHECK constraint failed');
  });

  it('seeds release intent once and only ever accepts a higher revision', async () => {
    await store().record(intent);
    const seed = {
      installationId: 'install-a',
      revision: 1,
      operationId: 'op-1',
      apiVersion: '0.1.64',
      apiImage: intent.apiImage,
      chartVersion: '0.1.0',
      chartSha256: intent.chartSha256,
      valuesSha256: 'v'.repeat(64),
    };
    await expect(store().seedReleaseIntent(seed)).resolves.toBe('seeded');
    await expect(
      store().seedReleaseIntent({ ...seed, operationId: 'op-1b' }),
    ).resolves.toBe('exists');
    await expect(
      store().seedReleaseIntent({ ...seed, revision: 0, operationId: 'op-0' }),
    ).resolves.toBe('exists');
    await expect(
      store().seedReleaseIntent({ ...seed, revision: 2, operationId: 'op-2' }),
    ).resolves.toBe('seeded');
    await expect(
      store().currentReleaseIntent('install-a'),
    ).resolves.toMatchObject({
      revision: 2,
      operationId: 'op-2',
      state: ClusterReleaseState.Seeded,
    });
    await store().setReleaseIntentState(
      'install-a',
      2,
      ClusterReleaseState.Applied,
    );
    await expect(
      store().currentReleaseIntent('install-a'),
    ).resolves.toMatchObject({
      state: ClusterReleaseState.Applied,
    });
    await expect(
      getDB().query(
        `UPDATE cluster_releases SET api_image = 'ghcr.io/x@sha256:${'0'.repeat(64)}' WHERE revision = 2`,
      ),
    ).rejects.toThrow('release intent is immutable');
  });

  it('advances steps, binds the connection and blocks credential removal while live', async () => {
    await store().record(intent);
    await store().completeStep('install-a', ClusterStep.ManagementVm);
    await store().recordKubernetesIdentity('install-a', 'uid-1');
    await expect(
      getPersistence().clusterRecords.storeConnection({
        clusterId: 'install-a',
        kubernetesIdentity: 'uid-1',
        kind: 'installer',
        connection: '{"kind":"installer"}',
      }),
    ).resolves.toBe('stored');
    await store().setState('install-a', ClusterState.Failed, 'boom');
    await expect(
      store().getForScope('install-a', owner),
    ).resolves.toMatchObject({
      step: ClusterStep.ManagementVm,
      connectionId: 'install-a',
      state: ClusterState.Failed,
      lastError: 'boom',
    });

    await expect(
      getCredentialSecretStore().deleteNamedCredentialIfNotReferenced(
        'aws-compute',
        false,
      ),
    ).resolves.toEqual({ deleted: false, blocking: ['install-a'] });

    await store().setState('install-a', ClusterState.Destroyed);
    // Destroyed installations no longer block removal, but the credential row
    // stays (unnamed) because the historical intent still references it.
    await expect(
      getCredentialSecretStore().deleteNamedCredentialIfNotReferenced(
        'aws-compute',
        false,
      ),
    ).resolves.toEqual({ deleted: true, blocking: [] });
    await expect(
      getDB().query<{ name: string | null }>(
        `SELECT name FROM credentials WHERE id = 'compute-aws'`,
      ),
    ).resolves.toEqual([{ name: null }]);
    await expect(store().listForScope(owner)).resolves.toEqual([]);
    await expect(
      store().listForScope(owner, { includeDestroyed: true }),
    ).resolves.toHaveLength(1);
  });
});
