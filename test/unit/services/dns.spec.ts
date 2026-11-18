import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteDNSRecord,
  deleteDNSRecordBySubdomain,
  publicARecordExists,
  removeApiTls,
  upsertDNSRecord,
} from '../../../src/shared/dns-worker';

describe('deleteDNSRecord', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('treats an already-absent record as successful cleanup', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 404 })),
    );

    await expect(
      deleteDNSRecord('already-gone', 'github-token'),
    ).resolves.toBeUndefined();
  });

  it('still surfaces retryable worker failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 })),
    );

    await expect(deleteDNSRecord('retry-me', 'github-token')).rejects.toThrow(
      'DNS record delete failed (503): unavailable',
    );
  });
});

describe('raw DNS records', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests an unproxied record explicitly', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ recordId: 'raw-1', proxied: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetch);

    await upsertDNSRecord('mk8-cluster', '1.2.3.4', 'github-token', {
      proxied: false,
      recordId: 'raw-1',
    });

    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({
      subdomain: 'mk8-cluster',
      ip: '1.2.3.4',
      proxied: false,
      recordId: 'raw-1',
    });
  });

  it('rejects a Worker too old to confirm the raw record mode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ recordId: 'proxied-raw-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(
      upsertDNSRecord('mk8-cluster', '1.2.3.4', 'github-token', {
        proxied: false,
      }),
    ).rejects.toThrow('did not confirm proxied=false');
  });

  it('deletes a deterministic subdomain idempotently', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ deleted: 0 }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetch);

    await deleteDNSRecordBySubdomain('mk8-cluster', 'github-token');

    expect(fetch).toHaveBeenCalledWith(
      'https://dns.anycloud.sh/v1/dns-records?subdomain=mk8-cluster',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

describe('removeApiTls', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces a failed teardown so delete retries it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('down', { status: 502 })),
    );
    await expect(removeApiTls('api-1', 'github-token')).rejects.toThrow(
      'DNS Worker DELETE /v1/api-tls failed (502): down',
    );
  });
});

describe('publicARecordExists', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const answer = (body: object) =>
    vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

  it('asks 1.1.1.1 over DNS over HTTPS and finds an A record behind a CNAME', async () => {
    const fetch = answer({
      Status: 0,
      Answer: [
        { name: 'id.anycloud.sh', type: 5, data: 'edge.example.' },
        { name: 'id.anycloud.sh', type: 1, data: '172.67.180.7' },
      ],
    });
    vi.stubGlobal('fetch', fetch);

    await expect(publicARecordExists('id.anycloud.sh')).resolves.toBe(true);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://1.1.1.1/dns-query?name=id.anycloud.sh&type=A');
    expect(init.headers).toEqual({ accept: 'application/dns-json' });
  });

  it('answers false for NXDOMAIN and throws when the resolver fails', async () => {
    vi.stubGlobal('fetch', answer({ Status: 3 }));
    await expect(publicARecordExists('id.anycloud.sh')).resolves.toBe(false);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 502 })),
    );
    await expect(publicARecordExists('id.anycloud.sh')).rejects.toThrow(
      '1.1.1.1 answered HTTP 502',
    );
  });
});
