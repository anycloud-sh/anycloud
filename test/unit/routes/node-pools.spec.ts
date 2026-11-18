import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import packageJson from '../../../package.json' with { type: 'json' };
import type { Server } from 'node:http';
import { createApiRpcMiddleware } from '../../../src/api/rpc/express.js';
import { createApiRpcDomains } from '../../../src/api/composition.js';
import type { User } from '../../../src/api/services/entities.js';
import {
  createNodePoolsDomain,
  type NodePoolDomainDependencies,
  type NodePoolRuntime,
} from '../../../src/api/services/node-pools-domain.js';
import {
  getPersistence,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../../../src/shared/api-version.js';
import { NODE_POOL_BOUNDS_REASON } from '../../../src/shared/api-contract/node-pools-schemas.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import { getAnycloudVersion } from '../../../src/shared/services/api-client/runtime.js';

const actor: User = {
  id: 'test-user',
  username: 'test-user',
  token: 'test-token',
};
const auth = {
  Authorization: 'Bearer test-token',
  [ANYCLOUD_CLIENT_VERSION_HEADER]: getAnycloudVersion(),
};
const CA = Buffer.from('certificate-authority').toString('base64');
const SECRET = 'SECRET-TOKEN-VALUE-abcdef';

/** The hosted API's own record, as it is written on start. */
async function recordCluster(): Promise<void> {
  const result = await getPersistence().clusters.recordSelf({
    id: 'cluster-production',
    ownerUserId: actor.id,
    name: 'production',
    kubernetesIdentity: 'uid-production',
    connection: JSON.stringify({
      kind: 'installer',
      server: 'https://cluster.example:6443',
      certificateAuthorityData: CA,
      credential: { kind: 'token', token: SECRET },
    }),
  });
  expect(result).toBe('recorded');
}

describe('cluster and node pool routes', () => {
  let server: Server;
  let baseUrl: string;
  let runtime: NodePoolRuntime;
  let hasLiveReferences: ReturnType<
    typeof vi.fn<NodePoolDomainDependencies['references']['hasLiveReferences']>
  >;

  beforeEach(async () => {
    resetPersistence();
    await getDB().query(
      `INSERT INTO credentials (
         id, encrypted_data, cloud_provider, name, created_at, last_used_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      ['compute-1', 'opaque', CloudType.AWS, 'aws-compute', 1, 1],
    );
    runtime = {
      ingress: vi.fn().mockResolvedValue({ entryIp: null, release: null }),
      schedule: vi.fn().mockResolvedValue(undefined),
      runners: vi.fn().mockResolvedValue(null),
      observeCapacity: vi.fn().mockResolvedValue({
        readyVmCount: 0,
        startingVmCount: 0,
        drainingVmCount: 0,
        locations: [],
      }),
      assertClusterCompatible: vi.fn().mockResolvedValue(undefined),
    };
    hasLiveReferences = vi
      .fn<NodePoolDomainDependencies['references']['hasLiveReferences']>()
      .mockResolvedValue(false);

    const persistence = getPersistence();
    const nodePools = createNodePoolsDomain({
      nodePools: persistence.nodePools,
      clusterRecords: persistence.clusterRecords,
      credentials: persistence.credentialSecrets,
      references: {
        hasLiveReferences,
        countLiveReferences: async (id) =>
          (await hasLiveReferences(id)) ? 1 : 0,
      },
      generateId: (name) => `node-pool-${name}`,
      resolveScope: async () => ({ kind: 'api' }),
      runtime,
      validateTarget: async (input) => ({
        region: input.region ?? null,
        zone: input.zone ?? null,
        vmTypes: input.vmTypes,
        minVmCount: input.minVmCount,
        maxVmCount: input.maxVmCount,
      }),
    });
    const app = express();
    app.use(
      createApiRpcMiddleware({
        authenticate: vi.fn(async (token) => {
          if (token !== actor.token) throw new Error('Invalid access token');
          return actor;
        }),
        domains: createApiRpcDomains({
          overrides: { nodePools },
        }),
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        baseUrl = `http://127.0.0.1:${port}/v1`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  function request(path: string, options: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      ...options,
      headers: { ...auth, ...options.headers },
    });
  }

  function post(path: string, body: unknown): Promise<Response> {
    return request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  const nodePoolBody = {
    name: 'aws-east',
    credentialName: 'aws-compute',
    region: 'us-east-1',
    vmTypes: ['t3.small'],
    minVmCount: 1,
    maxVmCount: 1,
  };

  it('lists and reads the hosted API record under /clusters without creation facts or connection material', async () => {
    await expect(request('/clusters').then((r) => r.json())).resolves.toEqual({
      clusters: [],
    });
    await recordCluster();
    const listed = await request('/clusters');
    expect(listed.status).toBe(200);
    const body = await listed.json();
    expect(body).toEqual({
      clusters: [
        {
          id: 'cluster-production',
          name: 'production',
          state: WorkloadState.Running,
          releasing: false,
          cloudProvider: null,
          cloudAccount: null,
          region: null,
          zone: null,
          vmType: null,
          k3sVersion: null,
          managementVmId: null,
          networkScope: null,
          checkpointBucket: null,
          // What the API knows of itself: its endpoint's host, its version
          // and its URL.
          apiVersion: packageJson.version,
          apiImage: null,
          chartVersion: null,
          connected: true,
          kubernetesIdentity: 'uid-production',
          connectionRevision: 1,
          activeNodePoolCount: 0,
          address: 'cluster.example',
          managementApiUrl: 'https://cluster-production.anycloud.sh',
          release: null,
          lastError: null,
          createdAt: expect.any(Number),
          updatedAt: expect.any(Number),
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(JSON.stringify(body)).not.toContain(CA);
    await expect(
      (await request('/clusters/production')).json(),
    ).resolves.toMatchObject({ cluster: { id: 'cluster-production' } });
    await expect(request('/clusters/missing')).resolves.toMatchObject({
      status: 404,
    });
    // The retired root surface is gone.
    for (const path of ['/roots', '/root-installations']) {
      expect((await request(path)).status).toBe(404);
    }
  });

  it('creates node pools in the implied cluster, filters by cluster and protects deletion', async () => {
    await recordCluster();

    const created = await post('/node-pools', nodePoolBody);
    expect(created.status).toBe(202);
    await expect(created.json()).resolves.toMatchObject({
      nodePool: {
        id: 'node-pool-aws-east',
        clusterId: 'cluster-production',
        state: WorkloadState.Provisioning,
        cloudProvider: CloudType.AWS,
        zone: null,
      },
    });
    expect(runtime.schedule).toHaveBeenCalledWith('node-pool-aws-east');

    await expect(
      (await request('/node-pools?cluster=production')).json(),
    ).resolves.toMatchObject({ nodePools: [{ name: 'aws-east' }] });
    await expect(request('/node-pools?cluster=missing')).resolves.toMatchObject(
      {
        status: 404,
      },
    );
    await expect(
      (await request('/node-pools/AWS-EAST')).json(),
    ).resolves.toMatchObject({ nodePool: { id: 'node-pool-aws-east' } });

    hasLiveReferences.mockResolvedValueOnce(true);
    const referenced = await request('/node-pools/aws-east', {
      method: 'DELETE',
    });
    expect(referenced.status).toBe(409);
    await expect(referenced.json()).resolves.toMatchObject({
      code: 'NODE_POOL_REFERENCED',
    });

    const deleting = await request('/node-pools/aws-east', {
      method: 'DELETE',
    });
    expect(deleting.status).toBe(202);
    await expect(deleting.json()).resolves.toMatchObject({
      nodePool: { state: WorkloadState.Terminated, releasing: true },
    });
    await expect(
      request('/node-pools/missing', { method: 'DELETE' }),
    ).resolves.toMatchObject({ status: 404 });
  });

  it('maps node pool admission failures to declared statuses', async () => {
    const noCluster = await post('/node-pools', nodePoolBody);
    expect(noCluster.status).toBe(400);
    await expect(noCluster.json()).resolves.toMatchObject({
      code: 'NODE_POOLS_UNAVAILABLE',
    });

    await recordCluster();
    const badCredential = await post('/node-pools', {
      ...nodePoolBody,
      credentialName: 'missing',
    });
    expect(badCredential.status).toBe(400);
    await expect(badCredential.json()).resolves.toMatchObject({
      code: 'NODE_POOL_CREDENTIAL_NOT_FOUND',
    });

    const unknownCluster = await post('/node-pools', {
      ...nodePoolBody,
      cluster: 'missing',
    });
    expect(unknownCluster.status).toBe(404);

    const inverted = await post('/node-pools', {
      ...nodePoolBody,
      minVmCount: 3,
      maxVmCount: 2,
    });
    expect(inverted.status).toBe(400);
    await expect(inverted.text()).resolves.toContain(NODE_POOL_BOUNDS_REASON);

    const badZone = await post('/node-pools', {
      ...nodePoolBody,
      zone: 'us-west-2a',
    });
    expect(badZone.status).toBe(400);
    await expect(badZone.json()).resolves.toMatchObject({
      code: 'NODE_POOL_INVALID',
    });

    expect((await post('/node-pools', nodePoolBody)).status).toBe(202);
    // The same create again answers with the pool; other settings conflict.
    expect((await post('/node-pools', nodePoolBody)).status).toBe(202);
    const duplicate = await post('/node-pools', {
      ...nodePoolBody,
      maxVmCount: nodePoolBody.maxVmCount + 1,
    });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({
      code: 'NODE_POOL_ALREADY_EXISTS',
    });
  });
});
