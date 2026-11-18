import { beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../../../src/api/services/entities.js';
import {
  createClustersDomain,
  type ClusterDomainDependencies,
} from '../../../src/api/services/clusters-domain.js';
import { ClusterNotFoundError } from '../../../src/api/services/cluster-errors.js';
import { serializeClusterConnection } from '../../../src/api/services/kubernetes/cluster-connection.js';
import {
  getPersistence,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { ClusterReleaseState } from '../../../src/shared/clusters.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import {
  SYSTEM_RELEASE_HELM_JOB_IMAGE,
  SYSTEM_RELEASE_K3S_SHA256,
  SYSTEM_RELEASE_K3S_VERSION,
} from '../../../src/shared/system-release.js';

const actor: User = {
  id: '4242',
  username: 'owner',
  token: 'github-token',
};
const IMAGE = `ghcr.io/anycloud-sh/api:0.1.64@sha256:${'a'.repeat(64)}`;

const hostedConnection = serializeClusterConnection({
  kind: 'in-cluster',
  server: 'https://198.51.100.9:6443',
  certificateAuthorityData: 'Y2E=',
});

describe('kubernetes clusters domain', () => {
  function domain(overrides: Partial<ClusterDomainDependencies> = {}) {
    const persistence = getPersistence();
    return createClustersDomain({
      installations: persistence.clusters,
      clusterRecords: persistence.clusterRecords,
      resolveScope: async () => ({ kind: 'api' }),
      apiVersion: '0.1.64',
      ownApiImage: null,
      ...overrides,
    });
  }

  beforeEach(() => {
    resetPersistence();
  });

  it("fills the hosted API's own record with its address, version and URL", async () => {
    await getPersistence().clusters.recordSelf({
      id: 'cluster-hosted',
      ownerUserId: actor.id,
      name: 'hosted',
      kubernetesIdentity: 'uid-hosted',
      connection: hostedConnection,
    });

    const { clusters } = await domain().list(actor);
    const { cluster } = await domain().get(actor, 'hosted');
    for (const summary of [clusters[0], cluster]) {
      expect(summary).toMatchObject({
        id: 'cluster-hosted',
        address: '198.51.100.9',
        apiVersion: '0.1.64',
        managementApiUrl: 'https://cluster-hosted.anycloud.sh',
        // A record from before 0.1.74 carries no creation facts.
        cloudProvider: null,
        region: null,
        vmType: null,
      });
    }
  });

  it('reports the cluster record the hosted API keeps on its own row', async () => {
    const record = {
      cloudProvider: CloudType.GCP,
      cloudAccount: 'my-project',
      region: 'us-central1',
      zone: 'us-central1-a',
      vmType: 'e2-standard-2',
      managementVmId: 'anycloud-cluster-cluster-hosted',
      networkScope: 'anycloud-cluster-cluster-hosted',
      k3s: { version: SYSTEM_RELEASE_K3S_VERSION, sha256: 'b'.repeat(64) },
      checkpointBucket: { name: 'my-api-state', managed: false },
    };
    await getPersistence().clusters.recordSelf({
      id: 'cluster-hosted',
      ownerUserId: actor.id,
      name: 'hosted',
      kubernetesIdentity: 'uid-hosted',
      connection: hostedConnection,
      record,
    });

    const { cluster } = await domain({ ownApiImage: IMAGE }).get(
      actor,
      'hosted',
    );
    // The release it runs, digest-pinned, as an installer's record reports it.
    expect(cluster).toMatchObject({
      apiVersion: '0.1.64',
      apiImage: IMAGE,
      chartVersion: '0.1.64',
      release: {
        apiVersion: '0.1.64',
        apiImage: IMAGE,
        chartVersion: '0.1.64',
      },
      cloudProvider: CloudType.GCP,
      cloudAccount: 'my-project',
      region: 'us-central1',
      zone: 'us-central1-a',
      vmType: 'e2-standard-2',
      k3sVersion: SYSTEM_RELEASE_K3S_VERSION,
      managementVmId: 'anycloud-cluster-cluster-hosted',
      networkScope: 'anycloud-cluster-cluster-hosted',
      checkpointBucket: { name: 'my-api-state', managed: false },
    });
  });

  it('reports a cluster an earlier installer recorded with its management VM and release', async () => {
    const db = getDB();
    await db.query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider, name, created_at, last_used_at)
       VALUES ('cred-aws', 'opaque', 'AWS', 'aws-compute', 1, 1)`,
    );
    await db.query(
      `INSERT INTO clusters (
         id, owner_user_id, name, state, step, compute_credential_id, region,
         zone, vm_type, k3s_version, k3s_sha256, helm_job_image, api_version,
         api_image, chart_version, chart_sha256, checkpoint_bucket,
         checkpoint_bucket_managed, restore_from_backup, encrypted_server_token,
         ssh_public_key, encrypted_ssh_private_key, created_at, updated_at
       ) VALUES ('install-a', ?, 'production', 'ready', 'release', 'cred-aws',
         'us-east-1', NULL, 't3.medium', ?, ?, ?, '0.1.64', ?, '0.1.64', ?,
         'install-a', 1, 0, 'token', 'ssh-ed25519 AAAA', 'key', 1, 2)`,
      [
        actor.id,
        SYSTEM_RELEASE_K3S_VERSION,
        SYSTEM_RELEASE_K3S_SHA256,
        SYSTEM_RELEASE_HELM_JOB_IMAGE,
        IMAGE,
        'c'.repeat(64),
      ],
    );
    await db.query(
      `INSERT INTO vms (
         cluster_id, cloud_id, ip, created_at, region, credential_id, vm_type
       ) VALUES ('install-a', 'i-management', '203.0.113.7', 1, 'us-east-1',
         'cred-aws', 't3.medium')`,
    );
    await db.query(
      `INSERT INTO cluster_releases (
         cluster_id, revision, operation_id, api_version, api_image,
         chart_version, chart_sha256, values_sha256, state, created_at,
         updated_at
       ) VALUES ('install-a', 1, 'op-1', '0.1.64', ?, '0.1.64', ?, ?, ?, 1, 1)`,
      [IMAGE, 'c'.repeat(64), 'd'.repeat(64), ClusterReleaseState.Seeded],
    );

    const { clusters } = await domain().list(actor);
    const { cluster } = await domain().get(actor, 'PRODUCTION');
    expect(clusters).toEqual([cluster]);
    expect(cluster).toMatchObject({
      id: 'install-a',
      state: WorkloadState.Running,
      releasing: false,
      cloudProvider: CloudType.AWS,
      cloudAccount: null,
      region: 'us-east-1',
      vmType: 't3.medium',
      k3sVersion: SYSTEM_RELEASE_K3S_VERSION,
      managementVmId: 'i-management',
      address: '203.0.113.7',
      checkpointBucket: { name: 'install-a', managed: true },
      connected: false,
      managementApiUrl: 'https://install-a.anycloud.sh',
      release: {
        apiVersion: '0.1.64',
        apiImage: IMAGE,
        chartVersion: '0.1.64',
      },
      lastError: null,
    });
  });

  it('refuses an unknown cluster', async () => {
    await expect(domain().get(actor, 'missing')).rejects.toBeInstanceOf(
      ClusterNotFoundError,
    );
  });
});
