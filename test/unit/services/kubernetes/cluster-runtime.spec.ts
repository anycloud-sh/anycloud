import { describe, expect, it, vi } from 'vitest';
import type { KubeConfig } from '@kubernetes/client-node';
import type { ClusterConnection } from '../../../../src/api/services/cluster-store.js';
import { InvalidClusterConnectionError } from '../../../../src/api/services/kubernetes/cluster-connection.js';
import {
  createClusterRuntimeResolver,
  DEPLOYMENT_CLUSTER_PERMISSIONS,
  CLUSTER_PERMISSIONS,
  ClusterIdentityChangedError,
  ClusterPermissionError,
  NODE_POOL_CLUSTER_PERMISSIONS,
  SERVICE_CLUSTER_PERMISSIONS,
  CLUSTER_RUNTIME_REVERIFY_MS,
} from '../../../../src/api/services/kubernetes/cluster-runtime.js';
import { makeClusterKubernetesClientFixture } from '../../helpers/fixtures.js';

const CA = Buffer.from('ca').toString('base64');
const stored = (revision = 1): ClusterConnection => ({
  clusterId: 'cluster-a',
  kubernetesIdentity: 'uid-a',
  kind: 'installer',
  connectionRevision: revision,
  connection: JSON.stringify({
    kind: 'installer',
    server: 'https://cluster.example:6443',
    certificateAuthorityData: CA,
    credential: { kind: 'token', token: 'secret-token' },
  }),
});

function fakeClients(
  uid: string | undefined,
  denied: ReadonlySet<string> = new Set(),
) {
  const readNamespace = vi.fn(async () => ({ metadata: { uid } }));
  const createSelfSubjectAccessReview = vi.fn(
    async ({
      body,
    }: {
      body: {
        spec?: {
          resourceAttributes?: {
            verb?: string;
            resource?: string;
            namespace?: string;
          };
        };
      };
    }) => {
      const attributes = body.spec?.resourceAttributes ?? {};
      const key = `${attributes.verb} ${attributes.resource}${attributes.namespace ? ` in ${attributes.namespace}` : ''}`;
      return { status: { allowed: !denied.has(key) } };
    },
  );
  const createClients = vi.fn((kubeConfig: KubeConfig) =>
    makeClusterKubernetesClientFixture({
      kubeConfig,
      core: { readNamespace },
      authorization: { createSelfSubjectAccessReview },
    }),
  );
  const readServerVersion = vi.fn(async () => ({
    major: 1,
    minor: 35,
    gitVersion: 'v1.35.5+k3s1',
  }));
  return {
    readNamespace,
    createSelfSubjectAccessReview,
    createClients,
    readServerVersion,
  };
}

describe('cluster runtime resolver', () => {
  it('connects through the allow-listed document, preflights permissions and caches per connection revision', async () => {
    const getConnection = vi.fn(async () => stored(1));
    const fakes = fakeClients('uid-a');
    const resolver = createClusterRuntimeResolver({
      connections: { getConnection },
      createClusterClient: fakes.createClients,
      readServerVersion: fakes.readServerVersion,
    });

    const runtime = await resolver.resolve('cluster-a');
    expect(runtime).toMatchObject({
      clusterId: 'cluster-a',
      kubernetesIdentity: 'uid-a',
      connectionRevision: 1,
      connection: {
        server: 'https://cluster.example:6443',
        certificateAuthorityData: CA,
        credential: { kind: 'token', token: 'secret-token' },
      },
      serverVersion: { major: 1, minor: 35, gitVersion: 'v1.35.5+k3s1' },
    });
    expect(
      fakes.createClients.mock.calls[0][0].getCurrentCluster(),
    ).toMatchObject({
      server: 'https://cluster.example:6443',
      skipTLSVerify: false,
    });
    expect(fakes.readNamespace).toHaveBeenCalledWith(
      { name: 'kube-system' },
      undefined,
    );
    expect(fakes.createSelfSubjectAccessReview).toHaveBeenCalledTimes(
      CLUSTER_PERMISSIONS.length,
    );
    expect(
      fakes.createSelfSubjectAccessReview.mock.calls.map(
        ([{ body }]) => body.spec?.resourceAttributes,
      ),
    ).toEqual(
      expect.arrayContaining([
        { verb: 'list', group: '', resource: 'nodes' },
        { verb: 'delete', group: '', resource: 'nodes' },
        {
          verb: 'create',
          group: '',
          resource: 'secrets',
          namespace: 'kube-system',
        },
        // Cluster-scoped add-ons extend the same preflight.
        { verb: 'create', group: 'node.k8s.io', resource: 'runtimeclasses' },
        {
          verb: 'update',
          group: 'apps',
          resource: 'daemonsets',
          namespace: 'kube-system',
        },
      ]),
    );
    expect(NODE_POOL_CLUSTER_PERMISSIONS.map((rule) => rule.label)).toContain(
      'delete daemonsets in kube-system',
    );

    await expect(resolver.resolve('cluster-a')).resolves.toBe(runtime);
    expect(fakes.createClients).toHaveBeenCalledTimes(1);
    expect(fakes.readServerVersion).toHaveBeenCalledTimes(1);

    getConnection.mockResolvedValue(stored(2));
    const rotated = await resolver.resolve('cluster-a');
    expect(rotated).not.toBe(runtime);
    expect(rotated.connectionRevision).toBe(2);
    expect(fakes.createClients).toHaveBeenCalledTimes(2);
  });

  it('re-reads identity, permissions and version after the cache window or when admission asks', async () => {
    const clock = { now: 1_000_000 };
    const getConnection = vi.fn(async () => stored(1));
    const fakes = fakeClients('uid-a');
    const resolver = createClusterRuntimeResolver({
      connections: { getConnection },
      createClusterClient: fakes.createClients,
      readServerVersion: fakes.readServerVersion,
      now: () => clock.now,
    });

    const first = await resolver.resolve('cluster-a');
    expect(first.verifiedAt).toBe(1_000_000);
    clock.now += CLUSTER_RUNTIME_REVERIFY_MS - 1;
    await expect(resolver.resolve('cluster-a')).resolves.toBe(first);
    expect(fakes.readServerVersion).toHaveBeenCalledTimes(1);

    fakes.readServerVersion.mockResolvedValueOnce({
      major: 1,
      minor: 39,
      gitVersion: 'v1.39.0+k3s1',
    });
    clock.now += 1;
    const reverified = await resolver.resolve('cluster-a');
    expect(reverified).not.toBe(first);
    expect(reverified.serverVersion.minor).toBe(39);
    expect(reverified.verifiedAt).toBe(clock.now);
    expect(fakes.createSelfSubjectAccessReview).toHaveBeenCalledTimes(
      2 * CLUSTER_PERMISSIONS.length,
    );

    await expect(resolver.resolve('cluster-a')).resolves.toBe(reverified);
    const fresh = await resolver.resolve('cluster-a', undefined, {
      maxAgeMs: 0,
    });
    expect(fresh).not.toBe(reverified);
    expect(fakes.readServerVersion).toHaveBeenCalledTimes(3);
  });

  it('fails closed when the control plane reports another identity or the record is gone', async () => {
    const getConnection = vi.fn(async () => stored(1));
    const fakes = fakeClients('uid-foreign');
    const resolver = createClusterRuntimeResolver({
      connections: { getConnection },
      createClusterClient: fakes.createClients,
      readServerVersion: fakes.readServerVersion,
    });
    await expect(resolver.resolve('cluster-a')).rejects.toBeInstanceOf(
      ClusterIdentityChangedError,
    );
    expect(fakes.createSelfSubjectAccessReview).not.toHaveBeenCalled();

    getConnection.mockResolvedValue(null as never);
    await expect(resolver.resolve('cluster-a')).rejects.toThrow(
      /no usable connection/,
    );
  });

  it('names every missing permission and does not cache a denied identity', async () => {
    const fakes = fakeClients(
      'uid-a',
      new Set([
        'delete nodes',
        'list secrets in kube-system',
        'create runtimeclasses',
      ]),
    );
    const resolver = createClusterRuntimeResolver({
      connections: { getConnection: async () => stored(1) },
      createClusterClient: fakes.createClients,
      readServerVersion: fakes.readServerVersion,
    });
    let caught: unknown;
    try {
      await resolver.resolve('cluster-a');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ClusterPermissionError);
    expect((caught as ClusterPermissionError).missing).toEqual([
      'delete nodes',
      'list secrets in kube-system',
      'create runtimeclasses',
    ]);
    expect((caught as Error).message).toContain('delete nodes');
    expect(fakes.readServerVersion).not.toHaveBeenCalled();
    await expect(resolver.resolve('cluster-a')).rejects.toBeInstanceOf(
      ClusterPermissionError,
    );
    expect(fakes.createClients).toHaveBeenCalledTimes(2);
  });

  it('re-checks the stored document shape before building a client', async () => {
    const tampered = {
      ...stored(1),
      connection: JSON.stringify({
        kind: 'installer',
        server: 'http://127.0.0.1:9',
        certificateAuthorityData: CA,
        credential: { kind: 'exec', command: '/bin/sh' },
      }),
    };
    const fakes = fakeClients('uid-a');
    const resolver = createClusterRuntimeResolver({
      connections: { getConnection: async () => tampered },
      createClusterClient: fakes.createClients,
      readServerVersion: fakes.readServerVersion,
    });
    await expect(resolver.resolve('cluster-a')).rejects.toBeInstanceOf(
      InvalidClusterConnectionError,
    );
    expect(fakes.createClients).not.toHaveBeenCalled();
  });
  it('preflights the Service permissions cluster-wide beside the node pool ones', async () => {
    const fakes = fakeClients('uid-a');
    const resolver = createClusterRuntimeResolver({
      connections: { getConnection: async () => stored(1) },
      createClusterClient: fakes.createClients,
      readServerVersion: fakes.readServerVersion,
    });
    await resolver.resolve('cluster-a');
    const reviewed = fakes.createSelfSubjectAccessReview.mock.calls.map(
      ([{ body }]) => body.spec?.resourceAttributes,
    );
    expect(reviewed).toEqual(
      expect.arrayContaining([
        { verb: 'create', group: '', resource: 'namespaces' },
        { verb: 'delete', group: '', resource: 'namespaces' },
        { verb: 'patch', group: 'apps', resource: 'deployments' },
        { verb: 'delete', group: '', resource: 'services' },
        { verb: 'list', group: '', resource: 'pods' },
        { verb: 'get', group: '', resource: 'pods', subresource: 'log' },
      ]),
    );
    // Each Service owns a namespace, so none of its rules is namespaced.
    expect(SERVICE_CLUSTER_PERMISSIONS.every((rule) => !rule.namespace)).toBe(
      true,
    );
    expect(SERVICE_CLUSTER_PERMISSIONS.map((rule) => rule.label)).toContain(
      'create deployments.apps in Service namespaces',
    );
  });

  it('joins the Deployment-record rules to the same union, deduplicated by verb, group, resource and subresource', () => {
    expect(
      DEPLOYMENT_CLUSTER_PERMISSIONS.every((rule) => !rule.namespace),
    ).toBe(true);
    expect(DEPLOYMENT_CLUSTER_PERMISSIONS.map((rule) => rule.label)).toEqual(
      expect.arrayContaining([
        'create namespaces',
        'delete namespaces',
        'watch pods',
        'get pods/log in node pool namespaces',
        'get pods/exec in node pool namespaces',
        'create pods/exec in node pool namespaces',
        'create serviceaccounts in node pool namespaces',
        'patch deployments.apps in node pool namespaces',
        'create tokenreviews.authentication.k8s.io',
      ]),
    );
    const keys = CLUSTER_PERMISSIONS.map(
      (rule) =>
        `${rule.verb} ${rule.group} ${rule.resource}/${rule.subresource ?? ''} ${rule.namespace ?? ''}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    // Rules shared with Services (namespaces, secrets, deployments) appear once.
    expect(keys.filter((key) => key === 'create  namespaces/ ')).toHaveLength(
      1,
    );
    for (const list of [
      NODE_POOL_CLUSTER_PERMISSIONS,
      SERVICE_CLUSTER_PERMISSIONS,
      DEPLOYMENT_CLUSTER_PERMISSIONS,
    ]) {
      for (const rule of list) {
        expect(keys).toContain(
          `${rule.verb} ${rule.group} ${rule.resource}/${rule.subresource ?? ''} ${rule.namespace ?? ''}`,
        );
      }
    }
  });
});
