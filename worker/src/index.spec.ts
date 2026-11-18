import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from './index.js';
import { certificateOwners, type Env } from './testing.js';

const ENV: Env = {
  BRIDGE_RULE: undefined as never,
  CERTIFICATE_OWNER: certificateOwners(),
  CLOUDFLARE_API_TOKEN: 'cf-token',
  CLOUDFLARE_ZONE_ID: 'zone-123',
};

const GITHUB_USER = 'testuser';
const GITHUB_USER_ID = 1001;
const INVALID_SUBDOMAINS = [
  '*',
  '*.dep',
  'Dep-1',
  '-dep',
  'dep-',
  'a'.repeat(29),
];
const MAX_LENGTH_SUBDOMAIN = 'a'.repeat(28);
// Track all fetch calls so tests can assert on them
let fetchCalls: { url: string; init?: RequestInit }[];

function mockFetch(
  handlers: [pattern: string, handler: (init?: RequestInit) => Response][],
) {
  fetchCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchCalls.push({ url, init });
      // Ownership across record types and certificate revocation on release
      // (api-tls.spec.ts covers both): the same records, and no certificates.
      if (url.includes('dns_records?name=')) {
        const typed = handlers.find(([p]) => p === 'dns_records?type=A');
        if (typed) {
          const res = typed[1](init);
          if (!res.ok) return res;
          const { result } = (await res.json()) as { result: object[] };
          return Response.json({
            result: result.map((record) => ({ type: 'A', ...record })),
          });
        }
      }
      if (url.includes('/certificates?')) return Response.json({ result: [] });
      for (const [pattern, handler] of handlers) {
        if (url.includes(pattern)) return handler(init);
      }
      return new Response('Not mocked', { status: 500 });
    }),
  );
}

function ghAuthOk(): Response {
  return Response.json({ login: GITHUB_USER, id: GITHUB_USER_ID });
}

function ghAuth401(): Response {
  return new Response('Bad credentials', { status: 401 });
}

function cfCreateOk(id = 'rec-1'): Response {
  return Response.json({ result: { id } });
}

function cfListRecords(
  records: { id: string; comment: string | null }[],
): Response {
  return Response.json({ result: records });
}

function cfGetRecord(record: { id: string; comment: string | null }): Response {
  return Response.json({ result: record });
}

function cfRecordMissing(): Response {
  return Response.json(
    {
      success: false,
      errors: [{ code: 81044, message: 'Record does not exist.' }],
    },
    { status: 404 },
  );
}

function cfDeleteOk(): Response {
  return Response.json({ success: true });
}

function request(
  method: string,
  path: string,
  body?: object,
  token = 'gh-token-123',
): Request {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  return new Request(`https://dns.anycloud.sh${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function jsonBody(res: Response): Promise<any> {
  return res.json();
}

beforeEach(() => {
  vi.restoreAllMocks();
  ENV.CERTIFICATE_OWNER = certificateOwners();
});

describe('POST /v1/dns-records', () => {
  it('creates a proxied A record and returns recordId', async () => {
    mockFetch([
      ['api.github.com/user', ghAuthOk],
      ['dns_records?type=A', () => cfListRecords([])],
      ['dns_records', () => cfCreateOk()],
    ]);

    const res = await worker.fetch(
      request('POST', '/v1/dns-records', { subdomain: 'dep-1', ip: '1.2.3.4' }),
      ENV,
    );

    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({
      recordId: 'rec-1',
      proxied: true,
    });

    // Verify Cloudflare create call
    const createCall = fetchCalls.find(
      (c) => c.url.includes('dns_records') && c.init?.method === 'POST',
    );
    const createBody = JSON.parse(createCall!.init!.body as string);
    expect(createBody).toMatchObject({
      type: 'A',
      name: 'dep-1.anycloud.sh',
      content: '1.2.3.4',
      proxied: true,
      comment: GITHUB_USER,
    });
  });

  it('creates an explicitly unproxied raw-TLS record', async () => {
    mockFetch([
      ['api.github.com/user', ghAuthOk],
      ['dns_records?type=A', () => cfListRecords([])],
      ['dns_records', () => cfCreateOk()],
    ]);

    const res = await worker.fetch(
      request('POST', '/v1/dns-records', {
        subdomain: 'mk8-cluster',
        ip: '1.2.3.4',
        proxied: false,
      }),
      ENV,
    );

    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({
      recordId: 'rec-1',
      proxied: false,
    });
    const createCall = fetchCalls.find(
      (call) =>
        call.url.includes('dns_records') && call.init?.method === 'POST',
    );
    expect(JSON.parse(createCall!.init!.body as string)).toMatchObject({
      name: 'mk8-cluster.anycloud.sh',
      proxied: false,
    });
  });

  it('rejects a non-boolean proxy mode', async () => {
    mockFetch([['api.github.com/user', ghAuthOk]]);
    const res = await worker.fetch(
      request('POST', '/v1/dns-records', {
        subdomain: 'dep-1',
        ip: '1.2.3.4',
        proxied: 'false',
      }),
      ENV,
    );
    expect(res.status).toBe(400);
    expect(await jsonBody(res)).toEqual({ error: 'proxied must be a boolean' });
  });

  it('returns 401 without auth header', async () => {
    mockFetch([['api.github.com/user', ghAuth401]]);

    const req = new Request('https://dns.anycloud.sh/v1/dns-records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subdomain: 'x', ip: '1.2.3.4' }),
    });
    const res = await worker.fetch(req, ENV);

    expect(res.status).toBe(401);
  });

  it('returns 401 with invalid GitHub token', async () => {
    mockFetch([['api.github.com/user', ghAuth401]]);

    const res = await worker.fetch(
      request(
        'POST',
        '/v1/dns-records',
        { subdomain: 'x', ip: '1.2.3.4' },
        'bad-token',
      ),
      ENV,
    );

    expect(res.status).toBe(401);
  });

  it('does not authenticate GitHub Actions tokens via public repo access', async () => {
    mockFetch([
      ['api.github.com/user', ghAuth401],
      ['dns_records?type=A', () => cfListRecords([])],
      ['dns_records', () => cfCreateOk()],
    ]);

    const res = await worker.fetch(
      request('POST', '/v1/dns-records', {
        subdomain: 'dep-1',
        ip: '1.2.3.4',
      }),
      ENV,
    );

    expect(res.status).toBe(401);
    expect(
      fetchCalls.some((c) => c.url.includes('repos/anycloud-sh/anycloud')),
    ).toBe(false);
    expect(
      fetchCalls.some(
        (c) => c.url.includes('dns_records') && c.init?.method === 'POST',
      ),
    ).toBe(false);
  });

  it.each(INVALID_SUBDOMAINS)(
    'returns 400 when subdomain %j is not a workload id',
    async (subdomain) => {
      mockFetch([['api.github.com/user', ghAuthOk]]);

      const res = await worker.fetch(
        request('POST', '/v1/dns-records', {
          subdomain,
          ip: '1.2.3.4',
        }),
        ENV,
      );

      expect(res.status).toBe(400);
      expect(await jsonBody(res)).toMatchObject({
        error: expect.stringContaining('Invalid subdomain'),
      });
      expect(fetchCalls.some((c) => c.url.includes('dns_records'))).toBe(false);
    },
  );

  it('accepts a max-length workload id subdomain', async () => {
    mockFetch([
      ['api.github.com/user', ghAuthOk],
      ['dns_records?type=A', () => cfListRecords([])],
      ['dns_records', () => cfCreateOk()],
    ]);

    const res = await worker.fetch(
      request('POST', '/v1/dns-records', {
        subdomain: MAX_LENGTH_SUBDOMAIN,
        ip: '1.2.3.4',
      }),
      ENV,
    );

    expect(res.status).toBe(200);
    const createCall = fetchCalls.find(
      (c) => c.url.includes('dns_records') && c.init?.method === 'POST',
    );
    const createBody = JSON.parse(createCall!.init!.body as string);
    expect(createBody).toMatchObject({
      name: `${MAX_LENGTH_SUBDOMAIN}.anycloud.sh`,
    });
  });

  it('fails closed when Cloudflare record lookup fails before create', async () => {
    mockFetch([
      ['api.github.com/user', ghAuthOk],
      [
        'dns_records?type=A',
        () => new Response('rate limited', { status: 429 }),
      ],
      ['dns_records', () => cfCreateOk()],
    ]);

    const res = await worker.fetch(
      request('POST', '/v1/dns-records', { subdomain: 'dep-1', ip: '1.2.3.4' }),
      ENV,
    );

    expect(res.status).toBe(502);
    expect(await jsonBody(res)).toMatchObject({
      error: expect.stringContaining('listing DNS records'),
    });
    expect(
      fetchCalls.some(
        (c) => c.url.includes('dns_records') && c.init?.method === 'POST',
      ),
    ).toBe(false);
  });

  it('does not create or delete when updating the held record fails', async () => {
    mockFetch([
      ['api.github.com/user', ghAuthOk],
      [
        'dns_records?type=A',
        () => cfListRecords([{ id: 'rec-old', comment: GITHUB_USER }]),
      ],
      [
        'dns_records/rec-old',
        () => new Response('rate limited', { status: 429 }),
      ],
      ['dns_records', () => cfCreateOk('rec-new')],
    ]);

    const res = await worker.fetch(
      request('POST', '/v1/dns-records', {
        subdomain: 'dep-1',
        ip: '5.6.7.8',
        recordId: 'rec-old',
      }),
      ENV,
    );

    expect(res.status).toBe(502);
    expect(await jsonBody(res)).toMatchObject({
      error: expect.stringContaining('updating existing DNS record'),
    });
    expect(
      fetchCalls.some(
        (c) => c.url.includes('dns_records') && c.init?.method === 'POST',
      ),
    ).toBe(false);
    expect(
      fetchCalls.some(
        (c) => c.url.includes('rec-old') && c.init?.method === 'DELETE',
      ),
    ).toBe(false);
  });

  it('creates records with the authenticated GitHub username as owner', async () => {
    mockFetch([
      ['api.github.com/user', ghAuthOk],
      ['dns_records?type=A', () => cfListRecords([])],
      ['dns_records', () => cfCreateOk()],
    ]);

    const res = await worker.fetch(
      request('POST', '/v1/dns-records', {
        subdomain: 'dep-1',
        ip: '1.2.3.4',
      }),
      ENV,
    );

    expect(res.status).toBe(200);
    const createCall = fetchCalls.find(
      (c) => c.url.includes('dns_records') && c.init?.method === 'POST',
    );
    const createBody = JSON.parse(createCall!.init!.body as string);
    expect(createBody.comment).toBe(GITHUB_USER);
  });

  it('returns 400 when subdomain is missing', async () => {
    mockFetch([['api.github.com/user', ghAuthOk]]);

    const res = await worker.fetch(
      request('POST', '/v1/dns-records', { ip: '1.2.3.4' }),
      ENV,
    );

    expect(res.status).toBe(400);
    expect(await jsonBody(res)).toMatchObject({
      error: 'Missing subdomain or ip',
    });
  });

  it('returns 400 when ip is missing', async () => {
    mockFetch([['api.github.com/user', ghAuthOk]]);

    const res = await worker.fetch(
      request('POST', '/v1/dns-records', { subdomain: 'dep-1' }),
      ENV,
    );

    expect(res.status).toBe(400);
  });

  it('returns 409 when subdomain is owned by a different user', async () => {
    mockFetch([
      ['api.github.com/user', ghAuthOk],
      [
        'dns_records?type=A',
        () => cfListRecords([{ id: 'rec-old', comment: 'other-user' }]),
      ],
    ]);

    const res = await worker.fetch(
      request('POST', '/v1/dns-records', { subdomain: 'dep-1', ip: '1.2.3.4' }),
      ENV,
    );

    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toMatchObject({
      error: 'Subdomain already taken',
    });
  });

  it('returns 409 and does not write when subdomain has no owner comment', async () => {
    mockFetch([
      ['api.github.com/user', ghAuthOk],
      [
        'dns_records?type=A',
        () => cfListRecords([{ id: 'rec-old', comment: null }]),
      ],
      ['dns_records/rec-old', cfDeleteOk],
      ['dns_records', () => cfCreateOk('rec-new')],
    ]);

    const res = await worker.fetch(
      request('POST', '/v1/dns-records', { subdomain: 'dep-1', ip: '1.2.3.4' }),
      ENV,
    );

    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toMatchObject({
      error: 'Subdomain already taken',
    });
    expect(
      fetchCalls.some(
        (c) =>
          c.init?.method === 'POST' ||
          (c.url.includes('rec-old') &&
            (c.init?.method === 'PATCH' || c.init?.method === 'DELETE')),
      ),
    ).toBe(false);
  });

  it('updates the record the caller holds in place', async () => {
    mockFetch([
      ['api.github.com/user', ghAuthOk],
      [
        'dns_records?type=A',
        () => cfListRecords([{ id: 'rec-old', comment: GITHUB_USER }]),
      ],
      ['dns_records/rec-old', () => cfCreateOk('rec-old')],
      ['dns_records', () => cfCreateOk('rec-new')],
    ]);

    const res = await worker.fetch(
      request('POST', '/v1/dns-records', {
        subdomain: 'dep-1',
        ip: '5.6.7.8',
        recordId: 'rec-old',
      }),
      ENV,
    );

    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({
      recordId: 'rec-old',
      proxied: true,
    });

    const updateCall = fetchCalls.find(
      (c) => c.url.includes('rec-old') && c.init?.method === 'PATCH',
    );
    expect(updateCall).toBeDefined();
    expect(JSON.parse(updateCall!.init!.body as string)).toEqual({
      type: 'A',
      name: 'dep-1.anycloud.sh',
      content: '5.6.7.8',
      ttl: 1,
      proxied: true,
      comment: GITHUB_USER,
    });
    expect(
      fetchCalls.some(
        (c) =>
          c.init?.method === 'POST' ||
          (c.url.includes('rec-old') && c.init?.method === 'DELETE'),
      ),
    ).toBe(false);
  });

  it('updates the held record before deleting duplicates', async () => {
    mockFetch([
      ['api.github.com/user', ghAuthOk],
      [
        'dns_records?type=A',
        () =>
          cfListRecords([
            { id: 'rec-primary', comment: GITHUB_USER },
            { id: 'rec-duplicate', comment: GITHUB_USER },
          ]),
      ],
      ['dns_records/rec-primary', cfDeleteOk],
      ['dns_records/rec-duplicate', () => cfCreateOk('rec-duplicate')],
    ]);

    const res = await worker.fetch(
      request('POST', '/v1/dns-records', {
        subdomain: 'dep-1',
        ip: '5.6.7.8',
        recordId: 'rec-duplicate',
      }),
      ENV,
    );

    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({
      recordId: 'rec-duplicate',
      proxied: true,
    });

    const updateIndex = fetchCalls.findIndex(
      (c) => c.url.includes('rec-duplicate') && c.init?.method === 'PATCH',
    );
    const deleteIndex = fetchCalls.findIndex(
      (c) => c.url.includes('rec-primary') && c.init?.method === 'DELETE',
    );
    expect(updateIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeGreaterThan(updateIndex);
  });

  it.each([
    ['sends no id (an older API)', undefined],
    ['sends a stale id', 'rec-stale'],
  ])(
    'creates a new record before deleting the listed ones when the caller %s',
    async (_, recordId) => {
      mockFetch([
        ['api.github.com/user', ghAuthOk],
        [
          'dns_records?type=A',
          () => cfListRecords([{ id: 'rec-old', comment: GITHUB_USER }]),
        ],
        ['dns_records/rec-old', cfDeleteOk],
        ['dns_records', () => cfCreateOk('rec-new')],
      ]);

      const res = await worker.fetch(
        request('POST', '/v1/dns-records', {
          subdomain: 'dep-1',
          ip: '5.6.7.8',
          recordId,
        }),
        ENV,
      );

      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toEqual({
        recordId: 'rec-new',
        proxied: true,
      });
      const writes = fetchCalls
        .filter((c) => c.init?.method && c.init.method !== 'GET')
        .map((c) => `${c.init!.method} ${c.url.split('/dns_records')[1]}`);
      // Only records listed before the create are deleted, so a concurrent
      // publish's new record survives.
      expect(writes).toEqual(['POST ', 'DELETE /rec-old']);
    },
  );

  it('succeeds when a concurrent publish already deleted a replaced record', async () => {
    mockFetch([
      ['api.github.com/user', ghAuthOk],
      [
        'dns_records?type=A',
        () => cfListRecords([{ id: 'rec-old', comment: GITHUB_USER }]),
      ],
      ['dns_records/rec-old', cfRecordMissing],
      ['dns_records', () => cfCreateOk('rec-new')],
    ]);

    const res = await worker.fetch(
      request('POST', '/v1/dns-records', { subdomain: 'dep-1', ip: '5.6.7.8' }),
      ENV,
    );

    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ recordId: 'rec-new', proxied: true });
  });

  it('returns 502 when Cloudflare API fails', async () => {
    mockFetch([
      ['api.github.com/user', ghAuthOk],
      ['dns_records?type=A', () => cfListRecords([])],
      ['dns_records', () => new Response('rate limited', { status: 429 })],
    ]);

    const res = await worker.fetch(
      request('POST', '/v1/dns-records', { subdomain: 'dep-1', ip: '1.2.3.4' }),
      ENV,
    );

    expect(res.status).toBe(502);
  });
});

describe('DELETE /v1/dns-records/:recordId', () => {
  it('returns 404 without deleting when the record is already gone', async () => {
    mockFetch([
      ['api.github.com/user', ghAuthOk],
      ['dns_records/rec-1', cfRecordMissing],
    ]);

    const res = await worker.fetch(
      request('DELETE', '/v1/dns-records/rec-1'),
      ENV,
    );

    expect(res.status).toBe(404);
    expect(fetchCalls.some((c) => c.init?.method === 'DELETE')).toBe(false);
  });

  it('fails closed on a 404 that is not a missing-record error', async () => {
    mockFetch([
      ['api.github.com/user', ghAuthOk],
      [
        'dns_records/rec-1',
        () => Response.json({ errors: [{ code: 7003 }] }, { status: 404 }),
      ],
    ]);

    const res = await worker.fetch(
      request('DELETE', '/v1/dns-records/rec-1'),
      ENV,
    );

    expect(res.status).toBe(502);
    expect(fetchCalls.some((c) => c.init?.method === 'DELETE')).toBe(false);
  });

  it('deletes a DNS record', async () => {
    mockFetch([
      ['api.github.com/user', ghAuthOk],
      [
        'dns_records/rec-1',
        (init) =>
          init?.method === 'DELETE'
            ? cfDeleteOk()
            : cfGetRecord({ id: 'rec-1', comment: GITHUB_USER }),
      ],
    ]);

    const res = await worker.fetch(
      request('DELETE', '/v1/dns-records/rec-1'),
      ENV,
    );

    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ ok: true });
  });

  it('returns 401 without auth', async () => {
    mockFetch([['api.github.com/user', ghAuth401]]);

    const res = await worker.fetch(
      request('DELETE', '/v1/dns-records/rec-1', undefined, 'bad'),
      ENV,
    );

    expect(res.status).toBe(401);
  });

  it('returns 403 and does not delete a record owned by another user', async () => {
    mockFetch([
      ['api.github.com/user', ghAuthOk],
      [
        'dns_records/rec-1',
        (init) =>
          init?.method === 'DELETE'
            ? cfDeleteOk()
            : cfGetRecord({ id: 'rec-1', comment: 'other-user' }),
      ],
    ]);

    const res = await worker.fetch(
      request('DELETE', '/v1/dns-records/rec-1'),
      ENV,
    );

    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toMatchObject({
      error: 'DNS record owned by another user',
    });
    expect(
      fetchCalls.some(
        (c) =>
          c.url.includes('dns_records/rec-1') && c.init?.method === 'DELETE',
      ),
    ).toBe(false);
  });

  it('returns 403 and does not delete a record with no owner comment', async () => {
    mockFetch([
      ['api.github.com/user', ghAuthOk],
      [
        'dns_records/rec-1',
        (init) =>
          init?.method === 'DELETE'
            ? cfDeleteOk()
            : cfGetRecord({ id: 'rec-1', comment: null }),
      ],
    ]);

    const res = await worker.fetch(
      request('DELETE', '/v1/dns-records/rec-1'),
      ENV,
    );

    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toMatchObject({
      error: 'DNS record owned by another user',
    });
    expect(
      fetchCalls.some(
        (c) =>
          c.url.includes('dns_records/rec-1') && c.init?.method === 'DELETE',
      ),
    ).toBe(false);
  });

  it('fails closed when Cloudflare record lookup fails before record-id delete', async () => {
    mockFetch([
      ['api.github.com/user', ghAuthOk],
      [
        'dns_records/rec-1',
        () => new Response('rate limited', { status: 429 }),
      ],
    ]);

    const res = await worker.fetch(
      request('DELETE', '/v1/dns-records/rec-1'),
      ENV,
    );

    expect(res.status).toBe(502);
    expect(await jsonBody(res)).toMatchObject({
      error: expect.stringContaining('reading DNS record'),
    });
    expect(
      fetchCalls.some(
        (c) =>
          c.url.includes('dns_records/rec-1') && c.init?.method === 'DELETE',
      ),
    ).toBe(false);
  });

  it('returns 502 when Cloudflare delete fails', async () => {
    mockFetch([
      ['api.github.com/user', ghAuthOk],
      [
        'dns_records/rec-1',
        (init) =>
          init?.method === 'DELETE'
            ? new Response('internal error', { status: 500 })
            : cfGetRecord({ id: 'rec-1', comment: GITHUB_USER }),
      ],
    ]);

    const res = await worker.fetch(
      request('DELETE', '/v1/dns-records/rec-1'),
      ENV,
    );

    expect(res.status).toBe(502);
  });
});

describe('DELETE /v1/dns-records?subdomain=X', () => {
  it('deletes all records for a subdomain', async () => {
    mockFetch([
      ['api.github.com/user', ghAuthOk],
      [
        'dns_records?type=A',
        () =>
          cfListRecords([
            { id: 'rec-1', comment: GITHUB_USER },
            { id: 'rec-2', comment: GITHUB_USER },
          ]),
      ],
      ['dns_records/rec-1', cfDeleteOk],
      ['dns_records/rec-2', cfDeleteOk],
    ]);

    const res = await worker.fetch(
      request('DELETE', '/v1/dns-records?subdomain=dep-1'),
      ENV,
    );

    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ deleted: 2 });
  });

  it('returns deleted: 0 when no records exist', async () => {
    mockFetch([
      ['api.github.com/user', ghAuthOk],
      ['dns_records?type=A', () => cfListRecords([])],
    ]);

    const res = await worker.fetch(
      request('DELETE', '/v1/dns-records?subdomain=nonexistent'),
      ENV,
    );

    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ deleted: 0 });
  });

  it('returns 403 and does not delete records owned by another user', async () => {
    mockFetch([
      ['api.github.com/user', ghAuthOk],
      [
        'dns_records?type=A',
        () => cfListRecords([{ id: 'rec-other', comment: 'other-user' }]),
      ],
      ['dns_records/rec-other', cfDeleteOk],
    ]);

    const res = await worker.fetch(
      request('DELETE', '/v1/dns-records?subdomain=dep-1'),
      ENV,
    );

    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toMatchObject({
      error: 'Subdomain owned by another user',
    });
    expect(
      fetchCalls.some(
        (c) => c.url.includes('rec-other') && c.init?.method === 'DELETE',
      ),
    ).toBe(false);
  });

  it('returns 403 and does not delete records with no owner comment', async () => {
    mockFetch([
      ['api.github.com/user', ghAuthOk],
      [
        'dns_records?type=A',
        () => cfListRecords([{ id: 'rec-null', comment: null }]),
      ],
      ['dns_records/rec-null', cfDeleteOk],
    ]);

    const res = await worker.fetch(
      request('DELETE', '/v1/dns-records?subdomain=dep-1'),
      ENV,
    );

    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toMatchObject({
      error: 'Subdomain owned by another user',
    });
    expect(
      fetchCalls.some(
        (c) => c.url.includes('rec-null') && c.init?.method === 'DELETE',
      ),
    ).toBe(false);
  });

  it('returns 403 and does not delete any records when ownership is mixed', async () => {
    mockFetch([
      ['api.github.com/user', ghAuthOk],
      [
        'dns_records?type=A',
        () =>
          cfListRecords([
            { id: 'rec-mine', comment: GITHUB_USER },
            { id: 'rec-other', comment: 'other-user' },
          ]),
      ],
      ['dns_records/rec-mine', cfDeleteOk],
      ['dns_records/rec-other', cfDeleteOk],
    ]);

    const res = await worker.fetch(
      request('DELETE', '/v1/dns-records?subdomain=dep-1'),
      ENV,
    );

    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toMatchObject({
      error: 'Subdomain owned by another user',
    });
    expect(
      fetchCalls.some(
        (c) =>
          (c.url.includes('rec-mine') || c.url.includes('rec-other')) &&
          c.init?.method === 'DELETE',
      ),
    ).toBe(false);
  });

  it('fails closed when Cloudflare record lookup fails before delete', async () => {
    mockFetch([
      ['api.github.com/user', ghAuthOk],
      [
        'dns_records?type=A',
        () => new Response('rate limited', { status: 429 }),
      ],
      ['dns_records/rec-1', cfDeleteOk],
    ]);

    const res = await worker.fetch(
      request('DELETE', '/v1/dns-records?subdomain=dep-1'),
      ENV,
    );

    expect(res.status).toBe(502);
    expect(await jsonBody(res)).toMatchObject({
      error: expect.stringContaining('listing DNS records'),
    });
    expect(
      fetchCalls.some(
        (c) =>
          c.url.includes('dns_records/rec-1') && c.init?.method === 'DELETE',
      ),
    ).toBe(false);
  });

  it.each(INVALID_SUBDOMAINS)(
    'returns 400 when delete-by-subdomain receives non-workload id %j',
    async (subdomain) => {
      mockFetch([['api.github.com/user', ghAuthOk]]);

      const res = await worker.fetch(
        request(
          'DELETE',
          `/v1/dns-records?subdomain=${encodeURIComponent(subdomain)}`,
        ),
        ENV,
      );

      expect(res.status).toBe(400);
      expect(await jsonBody(res)).toMatchObject({
        error: expect.stringContaining('Invalid subdomain'),
      });
      expect(fetchCalls.some((c) => c.url.includes('dns_records'))).toBe(false);
    },
  );

  it('returns 401 without auth', async () => {
    mockFetch([['api.github.com/user', ghAuth401]]);

    const res = await worker.fetch(
      request('DELETE', '/v1/dns-records?subdomain=dep-1', undefined, 'bad'),
      ENV,
    );

    expect(res.status).toBe(401);
  });
});

describe('released hostnames', () => {
  it.each(['/v1/dns-records?subdomain=dep-1', '/v1/dns-records/rec-1'])(
    'after DELETE %s, a Service hostname with no certificate is reusable by another account',
    async (path) => {
      let records = [
        { id: 'rec-1', name: 'dep-1.anycloud.sh', comment: GITHUB_USER },
      ];
      let user = { login: GITHUB_USER, id: GITHUB_USER_ID };
      mockFetch([
        ['api.github.com/user', () => Response.json(user)],
        ['dns_records?type=A', () => cfListRecords(records)],
        [
          'dns_records/rec-1',
          (init) => {
            if (init?.method !== 'DELETE') return cfGetRecord(records[0]!);
            records = [];
            return cfDeleteOk();
          },
        ],
        ['dns_records', () => cfCreateOk('rec-2')],
      ]);
      expect((await worker.fetch(request('DELETE', path), ENV)).status).toBe(
        200,
      );

      user = { login: 'someone-else', id: 2002 };
      const res = await worker.fetch(
        request('POST', '/v1/dns-records', {
          subdomain: 'dep-1',
          ip: '1.2.3.4',
        }),
        ENV,
      );
      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toMatchObject({ recordId: 'rec-2' });
    },
  );

  it.each([
    ['a string', '1001'],
    ['missing', undefined],
    ['a fraction', 1.5],
  ])('refuses a GitHub user whose id is %s', async (_label, id) => {
    mockFetch([
      ['api.github.com/user', () => Response.json({ login: GITHUB_USER, id })],
    ]);
    const res = await worker.fetch(
      request('POST', '/v1/dns-records', {
        subdomain: 'dep-1',
        ip: '1.2.3.4',
      }),
      ENV,
    );
    expect(res.status).toBe(401);
    expect(fetchCalls.some((c) => c.url.includes('cloudflare'))).toBe(false);
  });
});

describe('health', () => {
  it('returns ok without auth', async () => {
    const res = await worker.fetch(request('GET', '/v1/health'), ENV);

    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ ok: true });
  });
});

describe('unknown routes', () => {
  it('returns 404 for unmatched paths', async () => {
    const res = await worker.fetch(request('GET', '/v1/unknown'), ENV);

    expect(res.status).toBe(404);
  });

  it('returns 404 for old unversioned paths', async () => {
    mockFetch([['api.github.com/user', ghAuthOk]]);

    const res = await worker.fetch(
      request('POST', '/dns-records', { subdomain: 'x', ip: '1.2.3.4' }),
      ENV,
    );

    expect(res.status).toBe(404);
  });
});
