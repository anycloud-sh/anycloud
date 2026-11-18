import { describe, expect, it } from 'vitest';
import { replicaSize } from '../../../src/api/services/kubernetes/pod-options.js';
import {
  nodesNeeded,
  type Resources,
} from '../../../src/api/services/pool-fit.js';
import {
  estimatedPoolNodeRoom,
  poolNodeRoom,
  targetVmCount,
} from '../../../src/api/services/pool-scaling.js';

const GI = 2 ** 30;
const MI = 2 ** 20;

describe('pool scaling policy', () => {
  it.each([
    ['holds the minimum with no demand', { live: 0, needed: 0 }, 2],
    ['adds the Nodes demand needs', { live: 2, needed: 3 }, 5],
    ['clamps a burst to the maximum', { live: 2, needed: 40 }, 6],
    [
      'offsets demand with in-flight VMs',
      { live: 4, needed: 3, inFlight: 2 },
      5,
    ],
    [
      'never lets in-flight VMs shrink the count',
      { live: 4, needed: 0, inFlight: 3 },
      4,
    ],
    ['counts a busy lost VM as one Node', { live: 2, needed: 0, lost: 1 }, 3],
    ['clamps a pool above its maximum down to it', { live: 8, needed: 0 }, 6],
    ['removes the idle Nodes', { live: 5, needed: 0, idle: 2 }, 3],
    [
      'removes only idle Nodes that demand leaves over',
      { live: 5, needed: 1, idle: 2 },
      4,
    ],
    ['never goes below the minimum', { live: 3, needed: 0, idle: 3 }, 2],
  ])('0048 invariant 1: %s', (_, counts, desired) => {
    expect(
      targetVmCount({
        lost: 0,
        inFlight: 0,
        idle: 0,
        min: 2,
        max: 6,
        ...counts,
      }),
    ).toBe(desired);
  });

  it('packs onto the smallest catalog value of each resource, with reserved read from the reference Node', () => {
    // A pool of a 4 vCPU/32 GiB type and an 8 vCPU/16 GiB type; the Node
    // read is the second type.
    const allocatable: Resources = {
      cpu: 7_800,
      memory: 15 * GI,
      'nvidia.com/gpu': 1,
      'ephemeral-storage': 90 * GI,
    };
    const { shape, reserved } = poolNodeRoom(
      [
        { cpu: 4_000, memory: 32 * GI, 'nvidia.com/gpu': 1 },
        { cpu: 8_000, memory: 16 * GI, 'nvidia.com/gpu': 1 },
      ],
      {
        catalog: { cpu: 8_000, memory: 16 * GI, 'nvidia.com/gpu': 1 },
        allocatable,
        daemonSets: [
          { cpu: 100, memory: GI, 'nvidia.com/gpu': 0, 'ephemeral-storage': 0 },
        ],
      },
    );
    expect(shape).toEqual({
      cpu: 4_000,
      memory: 16 * GI,
      'nvidia.com/gpu': 1,
      'ephemeral-storage': 90 * GI,
    });
    expect(reserved).toEqual({
      cpu: 300,
      memory: 2 * GI,
      'nvidia.com/gpu': 0,
      'ephemeral-storage': 0,
    });
  });

  it('0049/C22: estimates a pool with no Node from the catalog, keeping back kernel memory and the eviction threshold', () => {
    const { shape, reserved } = estimatedPoolNodeRoom([
      { cpu: 4_000, memory: 32 * GI, 'nvidia.com/gpu': 1 },
      {
        cpu: 8_000,
        memory: 16 * GI,
        'nvidia.com/gpu': 1,
        'ephemeral-storage': 90 * GI,
      },
    ]);
    expect(shape).toEqual({
      cpu: 4_000,
      memory: 16 * GI,
      'nvidia.com/gpu': 1,
      'ephemeral-storage': 90 * GI,
    });
    expect(reserved).toEqual({
      cpu: 0,
      memory: Math.ceil(16 * GI * 0.03) + 100 * MI,
      'nvidia.com/gpu': 0,
      'ephemeral-storage': 0,
    });
    // A 1 GiB type keeps back at least the kernel's 256 MiB.
    expect(
      estimatedPoolNodeRoom([{ cpu: 1_000, memory: GI, 'nvidia.com/gpu': 0 }])
        .reserved.memory,
    ).toBe(356 * MI);
  });

  it('0049/C22: an unknown catalog value packs every Pod onto one Node, which the next pass reads', () => {
    const { shape, reserved } = estimatedPoolNodeRoom([
      { 'nvidia.com/gpu': 0 },
    ]);
    const pod = {
      cpu: 1_000,
      memory: GI,
      'nvidia.com/gpu': 0,
      'ephemeral-storage': 0,
    };
    expect(nodesNeeded(shape, reserved, [pod, pod, pod])).toBe(1);
  });

  // Typical shapes: replicas sized as the API sizes them, by default or with
  // --cpus, on CPU and GPU types. A real Node's memory is the catalog value
  // less a kernel gap; 0–5% brackets the gap (inference), and its allocatable
  // omits the 100 MiB eviction threshold.
  it.each([
    ['t2.micro default replicas', 1, 1, 0, undefined, 0, 3],
    ['t3.large default replicas', 2, 8, 0, undefined, 0, 7],
    ['m5.xlarge default replicas', 4, 16, 0, undefined, 0, 10],
    ['c5.2xlarge --cpus 2 replicas', 8, 16, 0, '2', 0, 9],
    ['g6.xlarge 1-GPU replicas', 4, 16, 1, undefined, 1, 3],
    ['g5.12xlarge 1-GPU replicas', 48, 192, 4, undefined, 1, 6],
    ['g5.12xlarge 2-GPU replicas', 48, 192, 4, undefined, 2, 5],
  ] as const)(
    '0049/C22: a burst of %s from zero buys in one pass what real Nodes need, over-buying by at most one',
    (_, vCPUs, memoryGiB, gpusPerNode, cpus, gpus, burst) => {
      const size = replicaSize({ vCPUs, memoryGiB }, gpusPerNode, gpus, cpus);
      const replica: Resources = {
        cpu: Number(size.cpus) * 1000,
        memory: parseInt(size.memory, 10) * MI,
        'nvidia.com/gpu': gpus,
        'ephemeral-storage': 0,
      };
      const catalog = {
        cpu: vCPUs * 1000,
        memory: memoryGiB * GI,
        'nvidia.com/gpu': gpusPerNode,
      };
      const pods = Array.from({ length: burst }, () => replica);
      const realNodes = (kernelGap: number) => {
        const { shape, reserved } = poolNodeRoom([catalog], {
          catalog,
          allocatable: {
            ...catalog,
            memory: memoryGiB * GI * (1 - kernelGap) - 100 * MI,
            'ephemeral-storage': 90 * GI,
          },
          daemonSets: [],
        });
        return nodesNeeded(shape, reserved, pods);
      };
      const { shape, reserved } = estimatedPoolNodeRoom([catalog]);
      const estimated = nodesNeeded(shape, reserved, pods);
      expect(estimated).toBeGreaterThanOrEqual(realNodes(0.05));
      expect(estimated).toBeLessThanOrEqual(realNodes(0) + 1);
    },
  );
});
