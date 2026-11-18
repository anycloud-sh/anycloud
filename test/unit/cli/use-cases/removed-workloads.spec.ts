import { describe, expect, it, vi } from 'vitest';
import {
  remainingRemovedWorkloads,
  removedWorkloadsRefusal,
} from '../../../../src/cli/use-cases/removed-workloads.js';

const API = 'https://api-1.anycloud.sh';

function served(routes: Record<string, unknown>) {
  return vi.fn(async (url: string | URL | Request) => {
    const path = String(url).slice(`${API}/v1`.length).split('?')[0]!;
    return path in routes
      ? Response.json(routes[path])
      : new Response('', { status: 404 });
  });
}

describe('remainingRemovedWorkloads', () => {
  it('names live node pool Services, user Deployments and node pools, read as the served release', async () => {
    const fetch = served({
      '/workloads': [
        { id: 'svc-pool', nodePoolId: 'np-1' },
        { id: 'svc-vm', nodePoolId: null },
        { id: 'svc-old' },
      ],
      '/deployments': {
        deployments: [
          { id: 'dep-1', name: 'web', managed: false, deletedAt: null },
          { id: 'dep-2', name: 'gone', managed: false, deletedAt: 1 },
          { id: 'dep-3', name: 'pool-jobs', managed: true, deletedAt: null },
        ],
      },
      '/node-pools': {
        nodePools: [
          { id: 'np-1', name: 'gpu', state: 'running', releasing: false },
          { id: 'np-2', name: 'old', state: 'terminated', releasing: true },
          { id: 'np-3', name: 'done', state: 'terminated', releasing: false },
        ],
      },
    });

    await expect(
      remainingRemovedWorkloads(API, '0.1.78', 'token', fetch),
    ).resolves.toEqual([
      { kind: 'node pool Service', id: 'svc-pool', name: 'svc-pool' },
      { kind: 'Deployment', id: 'dep-1', name: 'web' },
      { kind: 'node pool', id: 'np-1', name: 'gpu' },
      { kind: 'node pool', id: 'np-2', name: 'old' },
    ]);
    const [url, init] = fetch.mock.calls.find(([u]) =>
      String(u).includes('/workloads'),
    ) as unknown as [string, RequestInit];
    expect(url).toBe(
      `${API}/v1/workloads?workloadType=service&stateClass=terminatable&limit=1000`,
    );
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer token',
      'AnyCloud-Client-Version': '0.1.78',
    });
  });

  it('finds nothing on an API that serves none of the removed routes', async () => {
    await expect(
      remainingRemovedWorkloads(API, '0.1.40', 'token', served({})),
    ).resolves.toEqual([]);
  });

  it('fails rather than passing when a listing fails', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 503 }));
    await expect(
      remainingRemovedWorkloads(API, '0.1.78', 'token', fetch),
    ).rejects.toThrow(`Could not list node-pools on ${API} (HTTP 503).`);
  });
});

describe('removedWorkloadsRefusal', () => {
  it('names each one and its replacement', () => {
    const refusal = removedWorkloadsRefusal([
      { kind: 'node pool Service', id: 'svc-1', name: 'svc-1' },
      { kind: 'node pool', id: 'np-1', name: 'gpu' },
    ]);
    expect(refusal.code).toBe('REMOVED_WORKLOADS_REMAIN');
    expect(refusal.message).toBe(
      [
        'This release removes node pools, Kubernetes Deployments and node pool Services, and these remain:',
        '  node pool Service svc-1',
        '  node pool gpu (np-1)',
        'Remove them on the current release first: "anycloud terminate <id>" for each Service, "anycloud deployment delete <name>", then "anycloud node-pool delete <name>". Run Jobs as VM Jobs ("anycloud job"), and long-running processes on a VM ("anycloud vm") or as a VM Service ("anycloud service").',
      ].join('\n'),
    );
  });
});
