import { describe, expect, it, vi } from 'vitest';
import type { User } from '../../../src/api/services/entities.js';
import { createHostedNodePoolInventory } from '../../../src/api/services/cluster-hosted-pools.js';
import { HostedApiAccessError } from '../../../src/api/services/cluster-errors.js';
import type { StoredCluster } from '../../../src/api/services/cluster-installer-store.js';

const API_TOKEN = `acapi_${'t'.repeat(43)}`;
const actor = {
  id: '4242',
  username: 'owner',
  token: 'gh-token',
} satisfies User;
// Only the id is read: it names the hostname the installer asks.
const installation: Pick<StoredCluster, 'id'> = {
  id: 'install-production-1',
};
const pool = (
  id: string,
  liveReferences: number,
  state = 'running',
  releasing = false,
) => ({
  id,
  name: `pool-${id}`,
  clusterId: 'cluster-1',
  state,
  releasing,
  cloudProvider: 'AWS',
  region: 'us-east-2',
  zone: null,
  vmTypes: ['t3.small'],
  minVmCount: 1,
  maxVmCount: 1,
  osDiskSizeGb: null,
  osDiskTier: null,
  spot: false,
  allowPrivilegedJobs: false,
  userNamespaceJobs: false,
  requireNestedVirtualization: false,
  capacity: {
    readyVmCount: 1,
    startingVmCount: 0,
    drainingVmCount: 0,
    locations: [],
  },
  liveReferences,
  ingressEntryIp: null,
  ingress: { entryIp: null, release: null },
  lastError: null,
  createdAt: 1,
  updatedAt: 1,
});

function inventory(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: init?.headers as Record<string, string>,
      });
      const next = responses.shift();
      if (!next) throw new Error('no response scripted');
      if (next instanceof Error) throw next;
      return next;
    },
  );
  return {
    calls,
    source: createHostedNodePoolInventory({
      clientVersion: '0.1.64',
      fetch: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1_000,
    }),
  };
}

describe('hosted node pool inventory (installer → hosted API)', () => {
  it("exchanges the owner's sign-in for its API token, never rotating it, and reports live pools with their references", async () => {
    const { source, calls } = inventory([
      Response.json({ token: API_TOKEN }),
      Response.json({
        nodePools: [
          pool('a', 2),
          pool('b', 0, 'terminated', true),
          pool('gone', 0, 'terminated'),
        ],
      }),
    ]);
    await expect(source.inventory(installation, actor)).resolves.toEqual({
      kind: 'pools',
      pools: [
        { id: 'a', name: 'pool-a', liveReferences: 2 },
        { id: 'b', name: 'pool-b', liveReferences: 0 },
      ],
    });
    expect(calls).toEqual([
      {
        url: 'https://install-production-1.anycloud.sh/v1/api-token',
        headers: {
          Authorization: 'Bearer gh-token',
          'AnyCloud-Client-Version': '0.1.64',
        },
      },
      {
        url: 'https://install-production-1.anycloud.sh/v1/node-pools',
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
          'AnyCloud-Client-Version': '0.1.64',
        },
      },
    ]);
  });

  it('sends the sign-in itself to a hosted API older than API tokens', async () => {
    const { source, calls } = inventory([
      new Response('Cannot POST /v1/api-token', { status: 404 }),
      Response.json({ nodePools: [pool('a', 1)] }),
    ]);
    await expect(source.inventory(installation, actor)).resolves.toEqual({
      kind: 'pools',
      pools: [{ id: 'a', name: 'pool-a', liveReferences: 1 }],
    });
    expect(calls[1]?.headers.Authorization).toBe('Bearer gh-token');
  });

  it('is unreachable on a network failure, a timeout or a 5xx after one retry', async () => {
    const { source, calls } = inventory([
      new Error('fetch failed: ECONNREFUSED'),
      new Response('upstream down', { status: 502 }),
    ]);
    await expect(source.inventory(installation, actor)).resolves.toEqual({
      kind: 'unreachable',
      reason: 'HTTP 502: upstream down',
    });
    expect(calls).toHaveLength(2);
  });

  it('treats 401/403 and a version mismatch as hard errors that name the fix', async () => {
    await expect(
      inventory([new Response('', { status: 403 })]).source.inventory(
        installation,
        actor,
      ),
    ).rejects.toThrow(
      new HostedApiAccessError('https://install-production-1.anycloud.sh', 403),
    );
  });

  it("reports the exchange's refusal of the owner's sign-in as it is", async () => {
    const refusal =
      'This API exchanges only a GitHub OAuth sign-in, not a personal access token or a CI token.';
    const { source } = inventory([
      Response.json(
        { defined: true, code: 'UNAUTHORIZED', status: 401, message: refusal },
        { status: 401 },
      ),
    ]);
    await expect(source.inventory(installation, actor)).rejects.toThrow(
      `shows what it admits): ${refusal}`,
    );
  });

  it('keeps the server text of a 400 that is not a version refusal', async () => {
    const { source, calls } = inventory([
      Response.json(
        { code: 'BAD_REQUEST', message: 'limit must be a number' },
        { status: 400 },
      ),
    ]);
    await expect(source.inventory(installation, actor)).rejects.toThrow(
      'rejected the node pool check (HTTP 400: {"code":"BAD_REQUEST","message":"limit must be a number"})',
    );
    expect(calls).toHaveLength(1);
  });

  it.each([
    [
      '0.1.65',
      "refused this CLI's version: this CLI (0.1.64) is older than the hosted API (0.1.65); run anycloud update, then run anycloud api delete again",
    ],
    [
      '0.1.63',
      "refused this CLI's version: the hosted API (0.1.63) is older than this CLI (0.1.64); upgrade it (anycloud api use https://install-production-1.anycloud.sh, anycloud api upgrade, then anycloud api use local) or install anycloud 0.1.63 (curl -fsSL https://get.anycloud.sh | sh -s -- --version 0.1.63), then run anycloud api delete again",
    ],
    [
      null,
      "refused this CLI's version: run anycloud update if this CLI (0.1.64) is the older side, or upgrade the hosted API (anycloud api use https://install-production-1.anycloud.sh, anycloud api upgrade, then anycloud api use local) if the hosted API is older, then run anycloud api delete again",
    ],
  ])(
    'names the side behind when the hosted API serves %s',
    async (hosted, message) => {
      const { source, calls } = inventory([
        Response.json(
          { code: 'CLIENT_VERSION_MISMATCH', message: 'mismatch' },
          { status: 400 },
        ),
        hosted
          ? Response.json({ version: hosted })
          : new Response('', { status: 502 }),
      ]);
      await expect(source.inventory(installation, actor)).rejects.toThrow(
        message,
      );
      expect(calls[1]?.url).toBe(
        'https://install-production-1.anycloud.sh/v1/version',
      );
    },
  );
});

describe('final backup (installer → hosted API, RFC 0049 C28)', () => {
  it("asks the hosted API for a backup with the owner's API token and returns its manifest time", async () => {
    const { source, calls } = inventory([
      Response.json({ token: API_TOKEN }),
      Response.json({ backedUpAt: '2026-11-04T18:12:03.000Z' }),
    ]);
    await expect(source.backup(installation, actor)).resolves.toEqual({
      backedUpAt: '2026-11-04T18:12:03.000Z',
    });
    expect(calls.map((call) => call.url)).toEqual([
      'https://install-production-1.anycloud.sh/v1/api-token',
      'https://install-production-1.anycloud.sh/v1/system-release/backup',
    ]);
    expect(calls[1].headers.Authorization).toBe(`Bearer ${API_TOKEN}`);
  });

  it('rejects once, naming the status and message, so delete reports it and goes on', async () => {
    const { source, calls } = inventory([
      Response.json({ token: API_TOKEN }),
      Response.json(
        { code: 'SYSTEM_RELEASE_UNAVAILABLE', message: 'no backup bucket' },
        { status: 503 },
      ),
    ]);
    await expect(source.backup(installation, actor)).rejects.toThrow(
      'the hosted API answered HTTP 503: no backup bucket',
    );
    expect(calls).toHaveLength(2);
  });
});
