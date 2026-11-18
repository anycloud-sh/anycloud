import { describe, expect, it, vi } from 'vitest';
import type { V1Node } from '@kubernetes/client-node';
import {
  cordonNodePoolNode,
  deleteNodePoolNode,
  drainNodePoolNode,
  evictNodePods,
  labelNodePoolNode,
  observeNodePoolNodes,
  stampNodePoolNodeScaleIn,
} from '../../../../src/api/services/kubernetes/node-pool-nodes.js';
import {
  nodePoolNodeLabels,
  nodePoolNodeName,
} from '../../../../src/api/services/kubernetes/node-pool-scheduling.js';
import { CloudType } from '../../../../src/shared/cloud.js';

const clusterId = 'cluster-a';
const nodePoolId = 'node-pool-a';

function node(input: {
  vmRowId: number;
  name?: string;
  labels?: Record<string, string> | null;
  ready?: boolean;
  transition?: string;
  gpus?: string;
  accelerator?: string;
  uid?: string | null;
  annotations?: Record<string, string>;
}): V1Node {
  return {
    metadata: {
      name: input.name ?? nodePoolNodeName(nodePoolId, input.vmRowId),
      annotations: input.annotations,
      uid:
        input.uid === null ? undefined : (input.uid ?? `uid-${input.vmRowId}`),
      ...(input.labels === null
        ? {}
        : {
            labels: input.labels ?? {
              ...nodePoolNodeLabels({
                clusterId,
                nodePoolId,
                cloudProvider: CloudType.AWS,
                vmRowId: input.vmRowId,
                ...(input.accelerator
                  ? { accelerator: input.accelerator as 'nvidia' }
                  : {}),
              }),
            },
          }),
    },
    status: {
      conditions: [
        {
          type: 'Ready',
          status: input.ready === false ? 'False' : 'True',
          ...(input.transition
            ? { lastTransitionTime: new Date(input.transition) }
            : {}),
        },
      ],
      ...(input.gpus !== undefined
        ? { allocatable: { 'nvidia.com/gpu': input.gpus } }
        : {}),
    },
  };
}

describe('node pool Node observation', () => {
  it('counts only Nodes whose name, cluster, node pool and attempt match a live owned VM', async () => {
    const items: V1Node[] = [
      node({ vmRowId: 1, transition: '2026-09-25T00:00:00Z' }),
      // Joined with an older join script, still tainted not-ready,
      // stamped by scale-in, and already made a member by the controller
      {
        ...node({
          vmRowId: 2,
          ready: false,
          gpus: '4',
          annotations: { 'anycloud.sh/scale-in': '1790294400000' },
          labels: {
            ...nodePoolNodeLabels({
              clusterId,
              nodePoolId,
              cloudProvider: CloudType.AWS,
              vmRowId: 2,
              accelerator: 'nvidia',
            }),
            'anycloud.sh/join-revision': '0',
            'node-restriction.kubernetes.io/anycloud-node-pool': nodePoolId,
          },
        }),
        spec: {
          taints: [
            { key: 'node.kubernetes.io/not-ready', effect: 'NoSchedule' },
          ],
        },
      },
      // Wrong cluster
      node({
        vmRowId: 3,
        labels: {
          ...nodePoolNodeLabels({
            clusterId: 'cluster-other',
            nodePoolId,
            cloudProvider: CloudType.AWS,
            vmRowId: 3,
          }),
        },
      }),
      // Attempt this node pool never provisioned
      node({ vmRowId: 99 }),
      // Name does not match the attempt label
      node({ vmRowId: 4, name: 'impostor' }),
      // No attempt label at all
      node({ vmRowId: 5, labels: { 'anycloud.sh/node-pool': nodePoolId } }),
      // No UID
      node({ vmRowId: 6, uid: null }),
      // Unrelated Node (management, another node pool): ignored
      node({ vmRowId: 7, name: 'management-node', labels: null }),
    ];
    const listNode = vi.fn(async () => ({ items }));

    const observed = await observeNodePoolNodes(
      { listNode },
      {
        clusterId,
        nodePoolId,
        liveVmRowIds: new Set([1, 2, 3, 4, 5, 6]),
        endedVmRowIds: new Set(),
      },
    );
    expect(listNode).toHaveBeenCalledWith({}, undefined);
    expect(observed.nodes).toEqual([
      {
        name: nodePoolNodeName(nodePoolId, 1),
        vmRowId: 1,
        ready: true,
        readyTransitionAt: Date.parse('2026-09-25T00:00:00Z'),
        allocatableGpus: 0,
        allocatable: {
          cpu: 0,
          memory: 0,
          'nvidia.com/gpu': 0,
          'ephemeral-storage': 0,
        },
        notReadyTaint: false,
        accelerator: null,
        member: false,
        ingressEntry: false,
        outdated: false,
        unusableGpu: false,
        scaleInStamp: null,
        uid: 'uid-1',
      },
      {
        name: nodePoolNodeName(nodePoolId, 2),
        vmRowId: 2,
        ready: false,
        readyTransitionAt: null,
        allocatableGpus: 4,
        allocatable: {
          cpu: 0,
          memory: 0,
          'nvidia.com/gpu': 4,
          'ephemeral-storage': 0,
        },
        notReadyTaint: true,
        accelerator: 'nvidia',
        member: true,
        ingressEntry: false,
        outdated: true,
        unusableGpu: false,
        scaleInStamp: 1790294400000,
        uid: 'uid-2',
      },
    ]);
    expect(observed.stale).toEqual([]);
    expect(observed.foreign).toEqual([
      nodePoolNodeName(nodePoolId, 3),
      nodePoolNodeName(nodePoolId, 99),
      'impostor',
      nodePoolNodeName(nodePoolId, 5),
      nodePoolNodeName(nodePoolId, 6),
    ]);
  });

  it('sees an unlabelled Node registered under a bootstrap name the node pool issued as foreign', async () => {
    const listNode = vi.fn(async () => ({
      items: [
        node({ vmRowId: 1, labels: null }),
        node({
          vmRowId: 1,
          labels: { 'kubernetes.io/os': 'linux' },
          uid: 'other',
        }),
      ],
    }));
    const observed = await observeNodePoolNodes(
      { listNode },
      {
        clusterId,
        nodePoolId,
        liveVmRowIds: new Set([1]),
        endedVmRowIds: new Set(),
      },
    );
    expect(observed.nodes).toEqual([]);
    expect(observed.foreign).toEqual([
      nodePoolNodeName(nodePoolId, 1),
      nodePoolNodeName(nodePoolId, 1),
    ]);
  });

  it("ignores another pool's Node that claims this pool by label alone, and still fails on any other claim", async () => {
    const otherPool = (vmRowId: number, member: boolean) =>
      node({
        vmRowId,
        name: nodePoolNodeName('node-pool-b', vmRowId),
        labels: {
          ...nodePoolNodeLabels({
            clusterId,
            nodePoolId: 'node-pool-b',
            cloudProvider: CloudType.AWS,
            vmRowId,
          }),
          ...(member
            ? {
                'node-restriction.kubernetes.io/anycloud-node-pool':
                  'node-pool-b',
              }
            : {}),
          // What its kubelet may set on its own Node.
          'anycloud.sh/node-pool': nodePoolId,
        },
      });
    const listNode = vi.fn(async () => ({
      items: [
        node({ vmRowId: 1 }),
        otherPool(7, true),
        // Joined pool B, not yet made a member: its name says whose it is.
        otherPool(8, false),
        // Neither another pool's member nor its bootstrap name.
        node({
          vmRowId: 9,
          name: 'rogue',
          labels: { 'anycloud.sh/node-pool': nodePoolId },
        }),
        // This pool's bootstrap name with another pool's membership.
        node({
          vmRowId: 99,
          labels: {
            'anycloud.sh/node-pool': nodePoolId,
            'node-restriction.kubernetes.io/anycloud-node-pool': 'node-pool-b',
          },
        }),
      ],
    }));
    const observed = await observeNodePoolNodes(
      { listNode },
      {
        clusterId,
        nodePoolId,
        liveVmRowIds: new Set([1]),
        endedVmRowIds: new Set(),
      },
    );
    expect(observed.nodes.map((n) => n.name)).toEqual([
      nodePoolNodeName(nodePoolId, 1),
    ]);
    expect(observed.ignored).toEqual([
      nodePoolNodeName('node-pool-b', 7),
      nodePoolNodeName('node-pool-b', 8),
    ]);
    expect(observed.foreign).toEqual([
      'rogue',
      nodePoolNodeName(nodePoolId, 99),
    ]);
  });

  it('classifies a Node left by an ended attempt as stale-owned instead of foreign', async () => {
    const listNode = vi.fn(async () => ({
      items: [
        node({ vmRowId: 3 }),
        node({ vmRowId: 4, labels: null, uid: 'uid-unlabelled-4' }),
        node({ vmRowId: 5 }),
      ],
    }));
    const observed = await observeNodePoolNodes(
      { listNode },
      {
        clusterId,
        nodePoolId,
        liveVmRowIds: new Set([5]),
        endedVmRowIds: new Set([3, 4]),
      },
    );
    expect(observed.nodes.map((n) => n.vmRowId)).toEqual([5]);
    expect(observed.stale).toEqual([
      { name: nodePoolNodeName(nodePoolId, 3), uid: 'uid-3' },
      { name: nodePoolNodeName(nodePoolId, 4), uid: 'uid-unlabelled-4' },
    ]);
    expect(observed.foreign).toEqual([]);
  });

  it('classifies an out-of-range attempt label as foreign instead of throwing', async () => {
    const listNode = vi.fn(async () => ({
      items: [
        node({
          vmRowId: 1,
          labels: {
            ...nodePoolNodeLabels({
              clusterId,
              nodePoolId,
              cloudProvider: CloudType.AWS,
              vmRowId: 1,
            }),
            'anycloud.sh/attempt': '1000000000000',
          },
        }),
        node({
          vmRowId: 1,
          name: `${nodePoolNodeName(nodePoolId, 1)}000000000000`,
          labels: null,
        }),
      ],
    }));
    const observed = await observeNodePoolNodes(
      { listNode },
      {
        clusterId,
        nodePoolId,
        liveVmRowIds: new Set([1]),
        endedVmRowIds: new Set(),
      },
    );
    expect(observed.nodes).toEqual([]);
    expect(observed.foreign).toEqual([
      nodePoolNodeName(nodePoolId, 1),
      `${nodePoolNodeName(nodePoolId, 1)}000000000000`,
    ]);
  });

  it('fails closed on an unparseable GPU allocatable value', async () => {
    const listNode = vi.fn(async () => ({
      items: [node({ vmRowId: 1, gpus: 'many' })],
    }));
    await expect(
      observeNodePoolNodes(
        { listNode },
        {
          clusterId,
          nodePoolId,
          liveVmRowIds: new Set([1]),
          endedVmRowIds: new Set(),
        },
      ),
    ).rejects.toThrow(/invalid nvidia.com\/gpu allocatable/);
  });

  it('cordons, uncordons and stamps with merge patches and deletes by exact UID, tolerating an already-gone Node', async () => {
    const patchNode = vi.fn().mockResolvedValue({});
    await cordonNodePoolNode({ patchNode }, 'anycloud-node-pool-a-1');
    await cordonNodePoolNode({ patchNode }, 'anycloud-node-pool-a-1', false);
    const stamped = { name: 'anycloud-node-pool-a-1', uid: 'uid-1' };
    await stampNodePoolNodeScaleIn({ patchNode }, stamped, 1790294400000);
    await stampNodePoolNodeScaleIn({ patchNode }, stamped, null);
    expect(patchNode.mock.calls.map(([request]) => request)).toEqual([
      {
        name: 'anycloud-node-pool-a-1',
        body: { spec: { unschedulable: true } },
      },
      {
        name: 'anycloud-node-pool-a-1',
        body: { spec: { unschedulable: false } },
      },
      ...['1790294400000', null].map((stamp) => ({
        name: 'anycloud-node-pool-a-1',
        body: {
          metadata: {
            uid: 'uid-1',
            annotations: { 'anycloud.sh/scale-in': stamp },
          },
        },
      })),
    ]);
    expect(patchNode).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ middleware: expect.any(Array) }),
    );
    await labelNodePoolNode(
      { patchNode },
      { name: 'anycloud-node-pool-a-1', uid: 'uid-1' },
      { 'anycloud.sh/accelerator': 'nvidia' },
    );
    expect(patchNode).toHaveBeenLastCalledWith(
      {
        name: 'anycloud-node-pool-a-1',
        body: {
          metadata: {
            uid: 'uid-1',
            labels: { 'anycloud.sh/accelerator': 'nvidia' },
          },
        },
      },
      expect.objectContaining({ middleware: expect.any(Array) }),
    );

    const calls: string[] = [];
    const deleteNode = vi.fn();
    const pods = [
      { metadata: { namespace: 'serve-a', name: 'a-1', uid: 'pa' } },
      { metadata: { namespace: 'kube-system', name: 'traefik-x', uid: 'pt' } },
    ];
    const core = {
      deleteNode: deleteNode.mockImplementation(async () => {
        calls.push('node');
        return {};
      }),
      listPodForAllNamespaces: vi.fn(async () => ({ items: pods })),
      deleteNamespacedPod: vi.fn(async ({ name }: { name: string }) => {
        calls.push(`pod ${name}`);
        return {};
      }),
    };
    // Pods bound to the Node go first, by UID and without grace (the VM is
    // gone), so their controllers replace them before the Node disappears.
    await deleteNodePoolNode(core, { name: 'n', uid: 'u' });
    expect(calls).toEqual(['pod a-1', 'pod traefik-x', 'node']);
    expect(core.listPodForAllNamespaces).toHaveBeenCalledWith(
      { fieldSelector: 'spec.nodeName=n', labelSelector: undefined },
      undefined,
    );
    expect(core.deleteNamespacedPod).toHaveBeenCalledWith(
      {
        name: 'a-1',
        namespace: 'serve-a',
        gracePeriodSeconds: 0,
        body: { preconditions: { uid: 'pa' } },
      },
      undefined,
    );
    expect(deleteNode).toHaveBeenCalledWith(
      { name: 'n', body: { preconditions: { uid: 'u' } } },
      undefined,
    );
    deleteNode.mockImplementation(async () => {
      throw Object.assign(new Error('gone'), { code: 404 });
    });
    await expect(
      deleteNodePoolNode(core, { name: 'n', uid: 'u' }),
    ).resolves.toBeUndefined();
    deleteNode.mockImplementation(async () => {
      throw Object.assign(new Error('conflict'), { code: 409 });
    });
    await expect(
      deleteNodePoolNode(core, { name: 'n', uid: 'u' }),
    ).rejects.toThrow('conflict');
  });

  it('evicts only the selected Pods of a Node that stays, gracefully and tolerating ones already gone', async () => {
    const deleteNamespacedPod = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 404 }));
    const listPodForAllNamespaces = vi.fn(async () => ({
      items: [
        { metadata: { namespace: 'serve-a', name: 'a-1', uid: 'pa' } },
        { metadata: { namespace: 'serve-b', name: 'b-1', uid: 'pb' } },
      ],
    }));
    await expect(
      evictNodePods({ listPodForAllNamespaces, deleteNamespacedPod }, 'n', {
        labelSelector: 'app.kubernetes.io/component=kubernetes-serve',
      }),
    ).resolves.toEqual(['serve-a/a-1']);
    expect(listPodForAllNamespaces).toHaveBeenCalledWith(
      {
        fieldSelector: 'spec.nodeName=n',
        labelSelector: 'app.kubernetes.io/component=kubernetes-serve',
      },
      undefined,
    );
    expect(deleteNamespacedPod.mock.calls[0][0]).toMatchObject({
      name: 'a-1',
      gracePeriodSeconds: undefined,
    });
  });

  it('drains through the Eviction API, leaving DaemonSet, mirror and finished Pods and counting refused or terminating ones', async () => {
    const pod = (name: string, extra: object = {}) => ({
      metadata: { namespace: 'pool', name, uid: `${name}-uid`, ...extra },
    });
    const listPodForAllNamespaces = vi.fn(async () => ({
      items: [
        pod('replica'),
        pod('guarded'),
        pod('gone'),
        pod('stopping', { deletionTimestamp: new Date() }),
        pod('plugin', {
          ownerReferences: [
            { apiVersion: 'apps/v1', kind: 'DaemonSet', name: 'p', uid: 'd' },
          ],
        }),
        pod('static', {
          annotations: { 'kubernetes.io/config.mirror': 'hash' },
        }),
        { ...pod('done'), status: { phase: 'Succeeded' } },
      ],
    }));
    const createNamespacedPodEviction = vi.fn(
      async ({ name }: { name: string }) => {
        if (name === 'guarded') {
          throw Object.assign(new Error('budget'), { code: 429 });
        }
        if (name === 'gone') {
          throw Object.assign(new Error('gone'), { code: 404 });
        }
        return {};
      },
    );
    await expect(
      drainNodePoolNode(
        { listPodForAllNamespaces, createNamespacedPodEviction },
        'n',
      ),
    ).resolves.toBe(3);
    expect(createNamespacedPodEviction.mock.calls.map(([r]) => r)).toEqual(
      ['replica', 'guarded', 'gone'].map((name) => ({
        name,
        namespace: 'pool',
        body: {
          apiVersion: 'policy/v1',
          kind: 'Eviction',
          metadata: { name, namespace: 'pool' },
          deleteOptions: { preconditions: { uid: `${name}-uid` } },
        },
      })),
    );
  });
});
