import { describe, expect, it } from 'vitest';
import {
  nodesNeeded,
  podRequests,
  podShare,
  quantity,
  share,
  type Resources,
} from '../../../src/api/services/pool-fit.js';

const GI = 2 ** 30;
const ZERO = { cpu: 0, memory: 0, 'nvidia.com/gpu': 0, 'ephemeral-storage': 0 };
const vector = (r: Partial<Resources>): Resources => ({ ...ZERO, ...r });
const cpu = (millicores: number, memory = 0) =>
  vector({ cpu: millicores, memory });
const gpu = vector({ cpu: 1000, memory: 4 * GI, 'nvidia.com/gpu': 1 });

// A 4-GPU Node; after reservations it has 7.5 cores, 30 GiB and 90 GB of disk.
const SHAPE = vector({
  cpu: 8000,
  memory: 32 * GI,
  'nvidia.com/gpu': 4,
  'ephemeral-storage': 100e9,
});
const RESERVED = vector({
  cpu: 500,
  memory: 2 * GI,
  'ephemeral-storage': 10e9,
});

describe('nodesNeeded', () => {
  // Each count is worked by hand from the room above.
  it.each([
    ['four 1-GPU replicas share one Node', Array(4).fill(gpu), 1],
    [
      'reservations leave room for one 4-core replica',
      [cpu(4000), cpu(4000)],
      2,
    ],
    [
      'disk decides: two 40 GB replicas per Node',
      Array(3).fill(vector({ 'ephemeral-storage': 40e9 })),
      2,
    ],
    [
      'CPU-heavy and memory-heavy share a Node',
      [cpu(6000, 4 * GI), cpu(1000, 24 * GI)],
      1,
    ],
    // In arrival order, or largest bytes first, first fit opens three Nodes.
    [
      'largest share first packs into two Nodes',
      [cpu(2500, 2 * GI), cpu(2500, 2 * GI), cpu(5000, GI), cpu(5000, GI)],
      2,
    ],
    [
      'a replica no empty Node holds adds no Node',
      [vector({ 'nvidia.com/gpu': 8 }), gpu],
      1,
    ],
  ] as const)('%s', (_, requests, nodes) => {
    expect(nodesNeeded(SHAPE, RESERVED, requests)).toBe(nodes);
  });
});

describe('podRequests, quantity and share', () => {
  it('sums the containers of a Pod', () => {
    const requests: Record<string, string>[] = [
      { cpu: '500m', memory: '1Gi', 'nvidia.com/gpu': '1' },
      { cpu: '1.5', memory: '512Mi', 'ephemeral-storage': '10G' },
    ];
    const containers = requests.map((r) => ({
      name: 'c',
      resources: { requests: r },
    }));
    expect(podRequests({ spec: { containers } })).toEqual(
      vector({
        cpu: 2000,
        memory: 1.5 * GI,
        'nvidia.com/gpu': 1,
        'ephemeral-storage': 10e9,
      }),
    );
  });

  it('reads decimal and binary quantities and refuses others', () => {
    expect([quantity('250m', 1000), quantity('2Gi'), quantity('64M')]).toEqual([
      250,
      2 * GI,
      64e6,
    ]);
    expect(() => quantity('1Zi')).toThrow('Unknown Kubernetes quantity 1Zi');
  });

  it('takes the largest share: 1 of 4 GPUs beats 1 of 8 cores', () => {
    expect(share(gpu, SHAPE)).toBe(0.25);
  });
});

describe('podShare', () => {
  const node = (allocatable: Record<string, string>) => ({
    status: { allocatable },
  });
  const pod = (...requests: Array<Record<string, string>>) => ({
    spec: {
      containers: requests.map((r, i) => ({
        name: `c${i}`,
        resources: { requests: r },
      })),
    },
  });
  const h100 = node({
    cpu: '208',
    memory: '1843Gi',
    'nvidia.com/gpu': '8',
  });

  it('takes the largest fraction of the Node a Pod requests', () => {
    // One of eight GPUs outweighs 26 of 208 CPUs and 100Gi of 1843Gi.
    expect(
      podShare(
        pod({ cpu: '26', memory: '100Gi', 'nvidia.com/gpu': '1' }),
        h100,
      ),
    ).toEqual({ share: 0.125, gpus: 1 });
    // Without GPUs, 104 of 208 CPUs is half the Node.
    expect(podShare(pod({ cpu: '104000m', memory: '1Gi' }), h100)).toEqual({
      share: 0.5,
      gpus: 0,
    });
  });

  it('sums every container and reads binary and decimal quantities', () => {
    const share = podShare(
      pod({ cpu: '500m', memory: '512Mi' }, { cpu: '1', memory: '1536Mi' }),
      node({ cpu: '6', memory: '4Gi' }),
    );
    expect(share).toEqual({ share: 0.5, gpus: 0 });
    expect(
      podShare(pod({ memory: '1G' }), node({ cpu: '2', memory: '4G' })).share,
    ).toBe(0.25);
  });

  it('takes no GPU share on a Node without GPUs', () => {
    expect(podShare(pod({ cpu: '1' }), node({ cpu: '4' }))).toEqual({
      share: 0.25,
      gpus: 0,
    });
  });
});
