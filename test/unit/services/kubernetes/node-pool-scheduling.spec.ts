import { describe, expect, it } from 'vitest';
import type { V1PodSpec } from '@kubernetes/client-node';
import {
  applyNodePoolScheduling,
  assertNodePoolCapability,
  assertNodePoolScheduling,
  MANAGEMENT_NODE_TAINT,
  MANAGEMENT_TAINT_KEY,
  NODE_POOL_MEMBER_LABEL,
  NODE_POOL_NODE_LABEL,
  nodePoolNamespace,
  nodePoolNodeLabels,
  nodePoolNodeName,
  nodePoolNodeTaints,
  nodePoolPodScheduling,
  CLUSTER_NODE_LABEL,
} from '../../../../src/api/services/kubernetes/node-pool-scheduling.js';
import { CloudType } from '../../../../src/shared/cloud.js';

const clusterId = 'cluster-production-1712345678901-ab12';
const nodePoolId = 'node-pool-aws-east-1712345678901-cd34';

describe('node pool scheduling constraints', () => {
  it('derives deterministic DNS-safe namespace and Node names', () => {
    const namespace = nodePoolNamespace(nodePoolId);
    expect(namespace).toMatch(/^anycloud-node-pool-[a-z0-9-]+-[0-9a-f]{10}$/);
    expect(namespace.length).toBeLessThanOrEqual(63);
    expect(nodePoolNamespace(nodePoolId)).toBe(namespace);
    expect(nodePoolNamespace('Other Node pool!')).not.toBe(namespace);
    expect(nodePoolNamespace('x'.repeat(200)).length).toBeLessThanOrEqual(63);

    expect(nodePoolNodeName(nodePoolId, 7)).toBe(`anycloud-${nodePoolId}-7`);
    expect(nodePoolNodeName('p'.repeat(200), 12).length).toBeLessThanOrEqual(
      63,
    );
    expect(() => nodePoolNodeName(nodePoolId, 0)).toThrow(/positive integer/);
    expect(() => nodePoolNodeName(nodePoolId, 1.5)).toThrow(/positive integer/);
  });

  it('labels and taints node pool Nodes and reserves management capacity', () => {
    expect(
      nodePoolNodeLabels({
        clusterId,
        nodePoolId,
        cloudProvider: CloudType.GCP,
        vmRowId: 3,
      }),
    ).toEqual({
      [CLUSTER_NODE_LABEL]: clusterId,
      [NODE_POOL_NODE_LABEL]: nodePoolId,
      'anycloud.sh/provider': 'gcp',
      'anycloud.sh/attempt': '3',
      'anycloud.sh/join-revision': '4',
    });
    expect(nodePoolNodeTaints(nodePoolId)).toEqual([
      { key: NODE_POOL_NODE_LABEL, value: nodePoolId, effect: 'NoSchedule' },
    ]);
    expect(MANAGEMENT_NODE_TAINT).toEqual({
      key: MANAGEMENT_TAINT_KEY,
      value: 'true',
      effect: 'NoSchedule',
    });
  });

  it('requires the node pool and cluster on user Pods and tolerates only that node pool', () => {
    const scheduling = nodePoolPodScheduling(clusterId, nodePoolId);
    expect(scheduling.nodeSelector).toEqual({
      [NODE_POOL_MEMBER_LABEL]: nodePoolId,
    });
    expect(
      scheduling.affinity.nodeAffinity
        ?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms,
    ).toEqual([
      {
        matchExpressions: [
          {
            key: NODE_POOL_MEMBER_LABEL,
            operator: 'In',
            values: [nodePoolId],
          },
          { key: CLUSTER_NODE_LABEL, operator: 'In', values: [clusterId] },
        ],
      },
    ]);
    expect(scheduling.tolerations).toEqual([
      {
        key: NODE_POOL_NODE_LABEL,
        operator: 'Equal',
        value: nodePoolId,
        effect: 'NoSchedule',
      },
    ]);
    expect(
      scheduling.tolerations.some((t) => t.key === MANAGEMENT_TAINT_KEY),
    ).toBe(false);
  });

  it('applies constraints to a Pod spec and strips tolerations that could spill elsewhere', () => {
    const spec: V1PodSpec = {
      containers: [{ name: 'app', image: 'example/app' }],
      nodeSelector: { 'kubernetes.io/os': 'linux' },
      tolerations: [
        { key: MANAGEMENT_TAINT_KEY, operator: 'Exists', effect: 'NoSchedule' },
        { operator: 'Exists' },
        { key: NODE_POOL_NODE_LABEL, operator: 'Exists' },
        {
          key: NODE_POOL_NODE_LABEL,
          operator: 'Equal',
          value: 'node-pool-other',
          effect: 'NoSchedule',
        },
        {
          key: 'node.kubernetes.io/not-ready',
          operator: 'Exists',
          effect: 'NoExecute',
          tolerationSeconds: 300,
        },
      ],
    };
    const constrained = applyNodePoolScheduling(spec, clusterId, nodePoolId);
    expect(spec.tolerations).toHaveLength(5);
    expect(constrained.nodeSelector).toEqual({
      [NODE_POOL_MEMBER_LABEL]: nodePoolId,
    });
    expect(constrained.tolerations).toEqual([
      {
        key: 'node.kubernetes.io/not-ready',
        operator: 'Exists',
        effect: 'NoExecute',
        tolerationSeconds: 300,
      },
      {
        key: NODE_POOL_NODE_LABEL,
        operator: 'Equal',
        value: nodePoolId,
        effect: 'NoSchedule',
      },
    ]);
    expect(() =>
      assertNodePoolScheduling(constrained, clusterId, nodePoolId),
    ).not.toThrow();
  });

  it('rejects specs that could schedule onto management or sibling capacity', () => {
    const good = applyNodePoolScheduling(
      { containers: [] },
      clusterId,
      nodePoolId,
    );
    expect(() =>
      assertNodePoolScheduling({ containers: [] }, clusterId, nodePoolId),
    ).toThrow(/does not select node pool/);
    expect(() =>
      assertNodePoolScheduling(
        { ...good, affinity: undefined },
        clusterId,
        nodePoolId,
      ),
    ).toThrow(/does not require node pool/);
    expect(() =>
      assertNodePoolScheduling(good, 'cluster-other', nodePoolId),
    ).toThrow(/does not require node pool/);
    expect(() =>
      assertNodePoolScheduling(
        {
          ...good,
          tolerations: [
            ...good.tolerations!,
            { key: MANAGEMENT_TAINT_KEY, operator: 'Exists' },
          ],
        },
        clusterId,
        nodePoolId,
      ),
    ).toThrow(/tolerates capacity outside/);
    expect(() =>
      assertNodePoolScheduling(
        {
          ...good,
          tolerations: [...good.tolerations!, { operator: 'Exists' }],
        },
        clusterId,
        nodePoolId,
      ),
    ).toThrow(/wildcard/);
    expect(() =>
      assertNodePoolScheduling(
        { ...good, tolerations: [] },
        clusterId,
        nodePoolId,
      ),
    ).toThrow(/does not tolerate node pool/);
    // The Node sets NODE_POOL_NODE_LABEL itself, so selecting it isn't enough.
    expect(() =>
      assertNodePoolScheduling(
        { ...good, nodeSelector: { [NODE_POOL_NODE_LABEL]: nodePoolId } },
        clusterId,
        nodePoolId,
      ),
    ).toThrow(/does not select node pool/);
    expect(() =>
      assertNodePoolScheduling(good, clusterId, 'node-pool-other'),
    ).toThrow(/does not select node pool node-pool-other/);
    expect(() =>
      assertNodePoolScheduling(
        { ...good, nodeName: 'management-node' },
        clusterId,
        nodePoolId,
      ),
    ).toThrow(/names Node management-node directly/);
    expect(() =>
      assertNodePoolScheduling(
        { ...good, schedulerName: 'custom-scheduler' },
        clusterId,
        nodePoolId,
      ),
    ).toThrow(/selects scheduler custom-scheduler/);
    expect(() =>
      assertNodePoolScheduling(
        { ...good, schedulerName: 'default-scheduler' },
        clusterId,
        nodePoolId,
      ),
    ).not.toThrow();
  });

  it('requires GPU Pods to request whole devices under the nvidia runtime and keeps them off CPU node pools', () => {
    const base = applyNodePoolScheduling(
      { containers: [{ name: 'main', image: 'x' }] },
      clusterId,
      nodePoolId,
    );
    const gpu: V1PodSpec = {
      ...base,
      runtimeClassName: 'nvidia',
      containers: [
        {
          name: 'main',
          image: 'x',
          resources: { limits: { 'nvidia.com/gpu': '2' } },
        },
      ],
    };

    expect(() =>
      assertNodePoolScheduling(gpu, clusterId, nodePoolId, { nvidiaGpus: 4 }),
    ).not.toThrow();
    expect(() =>
      assertNodePoolScheduling(base, clusterId, nodePoolId, { nvidiaGpus: 0 }),
    ).not.toThrow();
    // Without a capability the slice-2 scheduling rules alone apply.
    expect(() =>
      assertNodePoolScheduling(gpu, clusterId, nodePoolId),
    ).not.toThrow();

    expect(() => assertNodePoolCapability(base, { nvidiaGpus: 4 })).toThrow(
      /requests no nvidia.com\/gpu/,
    );
    expect(() => assertNodePoolCapability(gpu, { nvidiaGpus: 1 })).toThrow(
      /requests 2 nvidia.com\/gpu but each node pool Node advertises 1/,
    );
    expect(() =>
      assertNodePoolCapability(
        { ...gpu, runtimeClassName: undefined },
        { nvidiaGpus: 4 },
      ),
    ).toThrow(/must run under the nvidia runtime class/);
    expect(() =>
      assertNodePoolCapability(
        {
          ...gpu,
          containers: [
            {
              name: 'main',
              image: 'x',
              resources: { limits: { 'nvidia.com/gpu': '0.5' } },
            },
          ],
        },
        { nvidiaGpus: 4 },
      ),
    ).toThrow(/whole devices only/);
    expect(() => assertNodePoolCapability(gpu, { nvidiaGpus: 0 })).toThrow(
      /requests 2 nvidia.com\/gpu but the node pool has CPU capacity only/,
    );
    expect(() =>
      assertNodePoolCapability(
        { ...base, runtimeClassName: 'nvidia' },
        { nvidiaGpus: 0 },
      ),
    ).toThrow(/selects the nvidia runtime on a CPU node pool/);
    // Init containers run one at a time before the regular ones, so the Pod's
    // effective request is max(largest init, sum of regular), as the
    // scheduler computes it.
    const withInit = (init: string): V1PodSpec => ({
      ...gpu,
      initContainers: [
        {
          name: 'warm',
          image: 'x',
          resources: { requests: { 'nvidia.com/gpu': init } },
        },
      ],
    });
    expect(() =>
      assertNodePoolCapability(withInit('3'), { nvidiaGpus: 4 }),
    ).not.toThrow();
    expect(() =>
      assertNodePoolCapability(withInit('5'), { nvidiaGpus: 4 }),
    ).toThrow(
      /requests 5 nvidia.com\/gpu but each node pool Node advertises 4/,
    );
    expect(() =>
      assertNodePoolCapability(
        {
          ...withInit('1'),
          containers: [
            {
              name: 'main',
              image: 'x',
              resources: { limits: { 'nvidia.com/gpu': '1' } },
            },
          ],
        },
        { nvidiaGpus: 1 },
      ),
    ).not.toThrow();
    expect(() =>
      assertNodePoolCapability(withInit('0.5'), { nvidiaGpus: 4 }),
    ).toThrow(/whole devices only/);
  });
});
