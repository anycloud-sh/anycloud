import { describe, expect, it, vi } from 'vitest';
import {
  PatchStrategy,
  type KubernetesObject,
  type V1Namespace,
  type V1Pod,
} from '@kubernetes/client-node';
import {
  buildNodePoolEgressPolicy,
  buildNodePoolNamespace,
  deleteNodePoolNamespace,
  ensureNodePoolNamespace,
  NodePoolNamespaceOwnershipError,
  NodePoolNamespaceTerminatingError,
} from '../../../../src/api/services/kubernetes/node-pool-namespace.js';
import { nodePoolNamespace } from '../../../../src/api/services/kubernetes/node-pool-scheduling.js';
import { ANYCLOUD_POD_FINALIZER } from '../../../../src/api/services/kubernetes/pool-objects.js';

const identity = { clusterId: 'cluster-a', nodePoolId: 'node-pool-aws-east' };
const name = nodePoolNamespace(identity.nodePoolId);

function fakeNamespaces(seed: V1Namespace[] = [], pods: V1Pod[] = []) {
  const store = new Map(seed.map((ns) => [ns.metadata!.name!, ns]));
  const notFound = () => Object.assign(new Error('not found'), { code: 404 });
  const core = {
    listNamespacedPod: vi.fn(async () => ({ items: pods })),
    patchNamespacedPod: vi.fn(),
    readNamespace: vi.fn(async ({ name }: { name: string }) => {
      const current = store.get(name);
      if (!current) throw notFound();
      return current;
    }),
    createNamespace: vi.fn(async ({ body }: { body: V1Namespace }) => {
      const key = body.metadata!.name!;
      if (store.has(key)) {
        throw Object.assign(new Error('exists'), { code: 409 });
      }
      const stored = { ...body, metadata: { ...body.metadata, uid: 'u1' } };
      store.set(key, stored);
      return stored;
    }),
    deleteNamespace: vi.fn(
      async ({
        name,
        body,
      }: {
        name: string;
        body?: { preconditions?: { uid?: string } };
      }) => {
        const current = store.get(name);
        if (!current) throw notFound();
        if (body?.preconditions?.uid !== current.metadata?.uid) {
          throw Object.assign(new Error('conflict'), { code: 409 });
        }
        store.delete(name);
        return {};
      },
    ),
  };
  const applied: unknown[][] = [];
  const objects = {
    patch: <T extends KubernetesObject>(body: T, ...rest: unknown[]) => {
      applied.push([body, ...rest]);
      return Promise.resolve(body);
    },
  };
  return { store, core, applied, cluster: { core, objects } };
}

describe('node pool namespace', () => {
  it('derives a labelled namespace owned by the node pool and its cluster', () => {
    expect(buildNodePoolNamespace(identity)).toEqual({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name,
        labels: {
          'app.kubernetes.io/managed-by': 'anycloud',
          'anycloud.sh/cluster': 'cluster-a',
          'anycloud.sh/node-pool': 'node-pool-aws-east',
        },
      },
    });
    expect(name).toMatch(
      /^anycloud-node-pool-node-pool-aws-east-[0-9a-f]{10}$/,
    );
  });

  it('keeps DNS through the metadata address open, as GCP Nodes resolve there', () => {
    const egress = buildNodePoolEgressPolicy(identity).spec!.egress!;
    const metadata = { ipBlock: { cidr: '169.254.169.254/32' } };
    expect(egress).toContainEqual({
      to: [metadata],
      ports: [
        { protocol: 'UDP', port: 53 },
        { protocol: 'TCP', port: 53 },
      ],
    });
    // The open rule still excludes it, so no other port is allowed.
    expect(
      egress.find((rule) => rule.to?.[0]?.ipBlock?.cidr === '0.0.0.0/0')
        ?.to?.[0]?.ipBlock?.except,
    ).toContain(metadata.ipBlock.cidr);
  });

  it('creates the namespace once and accepts it as owned afterwards', async () => {
    const fake = fakeNamespaces();
    await expect(ensureNodePoolNamespace(fake.cluster, identity)).resolves.toBe(
      name,
    );
    expect(fake.core.createNamespace).toHaveBeenCalledTimes(1);
    await expect(ensureNodePoolNamespace(fake.cluster, identity)).resolves.toBe(
      name,
    );
    expect(fake.core.createNamespace).toHaveBeenCalledTimes(1);
    // Each ensure applies the default egress policy, so a deleted one returns.
    expect(fake.applied).toHaveLength(2);
    expect(fake.applied[1]).toEqual([
      buildNodePoolEgressPolicy(identity),
      undefined,
      undefined,
      'anycloud-node-pool-namespace',
      true,
      PatchStrategy.ServerSideApply,
    ]);
  });

  it('validates the winner of a create race instead of failing', async () => {
    const fake = fakeNamespaces();
    fake.core.createNamespace.mockImplementationOnce(async () => {
      fake.store.set(name, {
        ...buildNodePoolNamespace(identity),
        metadata: { ...buildNodePoolNamespace(identity).metadata, uid: 'w' },
      });
      throw Object.assign(new Error('exists'), { code: 409 });
    });
    await expect(ensureNodePoolNamespace(fake.cluster, identity)).resolves.toBe(
      name,
    );
  });

  it('fails closed on a namespace it does not own and on one that is terminating', async () => {
    const foreign = fakeNamespaces([
      { metadata: { name, uid: 'f', labels: { team: 'ml' } } },
    ]);
    await expect(
      ensureNodePoolNamespace(foreign.cluster, identity),
    ).rejects.toBeInstanceOf(NodePoolNamespaceOwnershipError);
    // Owned by another node pool or cluster: still foreign.
    const other = fakeNamespaces([
      {
        ...buildNodePoolNamespace({ ...identity, clusterId: 'cluster-b' }),
        metadata: {
          ...buildNodePoolNamespace({ ...identity, clusterId: 'cluster-b' })
            .metadata,
          uid: 'o',
        },
      },
    ]);
    await expect(
      ensureNodePoolNamespace(other.cluster, identity),
    ).rejects.toThrow(/not owned by this node pool/);
    expect(other.core.createNamespace).not.toHaveBeenCalled();
    expect(other.applied).toEqual([]);

    const terminating = fakeNamespaces([
      {
        ...buildNodePoolNamespace(identity),
        metadata: {
          ...buildNodePoolNamespace(identity).metadata,
          uid: 't',
          deletionTimestamp: new Date(),
        },
      },
    ]);
    await expect(
      ensureNodePoolNamespace(terminating.cluster, identity),
    ).rejects.toBeInstanceOf(NodePoolNamespaceTerminatingError);
  });

  it('deletes only an owned namespace by exact UID, after releasing finalizers left on its Pods, and reports foreign or absent ones', async () => {
    const owned = fakeNamespaces(
      [
        {
          ...buildNodePoolNamespace(identity),
          metadata: { ...buildNodePoolNamespace(identity).metadata, uid: 'u' },
        },
      ],
      [
        {
          metadata: {
            name: 'replica',
            namespace: name,
            uid: 'p',
            finalizers: ['other', ANYCLOUD_POD_FINALIZER],
          },
        },
        { metadata: { name: 'plain', namespace: name, uid: 'q' } },
      ],
    );
    await expect(deleteNodePoolNamespace(owned.core, identity)).resolves.toBe(
      'deleted',
    );
    expect(owned.core.patchNamespacedPod).toHaveBeenCalledTimes(1);
    expect(owned.core.patchNamespacedPod.mock.calls[0]![0]).toEqual({
      namespace: name,
      name: 'replica',
      body: [
        { op: 'test', path: '/metadata/uid', value: 'p' },
        {
          op: 'test',
          path: '/metadata/finalizers/1',
          value: ANYCLOUD_POD_FINALIZER,
        },
        { op: 'remove', path: '/metadata/finalizers/1' },
      ],
    });
    expect(owned.core.deleteNamespace).toHaveBeenCalledWith(
      { name, body: { preconditions: { uid: 'u' } } },
      undefined,
    );
    await expect(deleteNodePoolNamespace(owned.core, identity)).resolves.toBe(
      'absent',
    );

    const foreign = fakeNamespaces([{ metadata: { name, uid: 'f' } }]);
    await expect(deleteNodePoolNamespace(foreign.core, identity)).resolves.toBe(
      'foreign',
    );
    expect(foreign.core.deleteNamespace).not.toHaveBeenCalled();
    expect(foreign.store.has(name)).toBe(true);
  });
});
