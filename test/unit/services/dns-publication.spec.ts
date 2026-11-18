import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dns = vi.hoisted(() => ({
  names: ['one.ns.example', 'two.ns.example'],
  queries: [] as Array<{ server: string; hostname: string; type: number }>,
  answer: (_server: string, _type: number): Promise<string[]> =>
    Promise.resolve(['104.21.31.223']),
  discoveryError: undefined as Error | undefined,
  cancellations: 0,
  cancelQueries: undefined as (() => void) | undefined,
}));
vi.mock('node:dns/promises', () => ({
  Resolver: class {
    server = 'recursive';
    cancel() {
      dns.cancellations += 1;
      dns.cancelQueries?.();
    }
    setServers(addresses: string[]) {
      this.server = addresses[0]!;
    }
    async resolveNs() {
      if (dns.discoveryError) throw dns.discoveryError;
      return dns.names;
    }
    async resolve4(hostname: string) {
      if (hostname.endsWith('.ns.example'))
        return [hostname === 'one.ns.example' ? '192.0.2.1' : '192.0.2.2'];
      return this.query(hostname, 4);
    }
    resolve6(hostname: string) {
      return this.query(hostname, 6);
    }
    query(hostname: string, type: number) {
      dns.queries.push({ server: this.server, hostname, type });
      return dns.answer(this.server, type);
    }
  },
}));

import {
  DNSAuthoritiesUnreachableError,
  waitForDNSPublication,
} from '../../../src/api/services/dns-publication.js';

const hostname = 'service-1.anycloud.sh';
function negative(code = 'ENOTFOUND') {
  return Object.assign(new Error(`${code} queryA ${hostname}`), { code });
}

describe('authoritative DNS publication', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    dns.names = ['one.ns.example', 'two.ns.example'];
    dns.queries = [];
    dns.discoveryError = undefined;
    dns.cancellations = 0;
    dns.cancelQueries = undefined;
    dns.answer = async (_server, type) =>
      type === 4 ? ['104.21.31.223'] : ['2606:4700::1'];
  });
  afterEach(() => vi.useRealTimers());

  it('queries A and AAAA directly at every authority, never the endpoint through recursive DNS', async () => {
    await waitForDNSPublication(hostname);
    expect(dns.queries).toEqual(
      ['192.0.2.1', '192.0.2.2'].flatMap((server) =>
        [4, 6].map((type) => ({ server, hostname, type })),
      ),
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(dns.cancellations).toBe(3);
  });

  it('waits for both authorities after delayed or partial publication', async () => {
    let published = false;
    dns.answer = async (server) => {
      if (server === '192.0.2.2' && !published) throw negative();
      return ['104.21.31.223'];
    };
    let ready = false;
    const result = waitForDNSPublication(hostname).then(() => {
      ready = true;
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ready).toBe(false);
    published = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await result;
    expect(ready).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not accept a stale negative AAAA answer when A is already published', async () => {
    dns.answer = async (_server, type) => {
      if (type === 6) throw negative();
      return ['104.21.31.223'];
    };
    const result = waitForDNSPublication(hostname).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toMatchObject({
      cause: { errors: expect.any(Array) },
    });
    expect(
      dns.queries.filter((query) => query.type === 6).length,
    ).toBeGreaterThan(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts NODATA for a hostname without IPv6', async () => {
    dns.answer = async (_server, type) => {
      if (type === 6) throw negative('ENODATA');
      return ['104.21.31.223'];
    };
    await expect(waitForDNSPublication(hostname)).resolves.toBeUndefined();
  });

  it.each(['ENOTFOUND', 'ESERVFAIL'])(
    'retains %s and authority diagnostics on timeout',
    async (code) => {
      const cause = negative(code);
      dns.answer = async () => {
        throw cause;
      };
      const result = waitForDNSPublication(hostname).catch(
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(60_000);
      const error = await result;
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        cause: {
          errors: [
            expect.objectContaining({ cause }),
            expect.objectContaining({ cause }),
          ],
        },
      });
      expect(error).toHaveProperty(
        'message',
        expect.stringContaining('one.ns.example'),
      );
      expect(error).toHaveProperty(
        'message',
        expect.stringContaining('two.ns.example'),
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['ETIMEOUT', 'ECONNREFUSED'])(
    'fails fast naming port 53 and both authorities when neither answers (%s)',
    async (code) => {
      dns.answer = async () => {
        throw negative(code);
      };
      const result = waitForDNSPublication(hostname).catch(
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(2_000);
      const error = await result;
      // Unwrapped, so the Starting step classifies it as terminal.
      expect(error).toBeInstanceOf(DNSAuthoritiesUnreachableError);
      for (const part of ['port 53', 'one.ns.example', 'two.ns.example'])
        expect(error).toHaveProperty('message', expect.stringContaining(part));
      expect(dns.queries).toHaveLength(12);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('keeps waiting while one authority answers negatively and the other is unreachable', async () => {
    dns.answer = async (server) => {
      throw negative(server === '192.0.2.1' ? 'ENOTFOUND' : 'ETIMEOUT');
    };
    const result = waitForDNSPublication(hostname).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toHaveProperty(
      'message',
      expect.stringContaining('timed out after 60s'),
    );
  });

  it('cancels outstanding DNS queries when the overall deadline expires', async () => {
    const pending: Array<(error: Error) => void> = [];
    dns.answer = () => new Promise((_resolve, reject) => pending.push(reject));
    dns.cancelQueries = () =>
      pending.forEach((reject) => reject(negative('ECANCELLED')));
    const result = waitForDNSPublication(hostname).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toBeInstanceOf(Error);
    expect(dns.cancellations).toBeGreaterThanOrEqual(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects incomplete delegation without querying the endpoint', async () => {
    dns.names = ['one.ns.example', 'one.ns.example'];
    await expect(waitForDNSPublication(hostname)).rejects.toBeInstanceOf(Error);
    expect(dns.queries).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves discovery failures without probing an undiscovered authority', async () => {
    const cause = negative('ESERVFAIL');
    dns.discoveryError = cause;
    await expect(waitForDNSPublication(hostname)).rejects.toMatchObject({
      cause,
    });
    expect(dns.queries).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not accept an empty A answer', async () => {
    dns.answer = async () => [];
    const result = waitForDNSPublication(hostname).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toBeInstanceOf(Error);
  });
});
