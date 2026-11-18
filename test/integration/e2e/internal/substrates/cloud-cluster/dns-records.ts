import { Resolver } from 'node:dns/promises';

/**
 * A cluster's bootstrap publishes `<installation id>.anycloud.sh` through the
 * DNS Worker and destroy removes it; a refused or failed destroy leaves the
 * record. The Worker offers no read, only the same-owner `DELETE …?subdomain=`
 * of `src/shared/dns-worker.ts`, mirrored here exactly. Its 2xx is idempotent
 * (`cleared` says nothing about a record having existed); `resolveDnsRecord` is the guard.
 */
const DNS_WORKER_URL = 'https://dns.anycloud.sh';
const DNS_CLEAN_CODES = new Set(['ENOTFOUND', 'ENODATA']);

export interface DnsRecordSweepOutcome {
  subdomain: string;
  outcome: 'cleared' | 'absent' | 'failed';
  reason?: string;
}

export type DnsResolution =
  | { outcome: 'clean' }
  | { outcome: 'leftover'; addresses: string[] }
  | { outcome: 'unverified'; reason: string };
export interface DnsResolutionOptions {
  resolve?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Does `<subdomain>.anycloud.sh` still resolve at Cloudflare (a proxied record answers with edge IPs)? Polls through the Worker's propagation. */
export async function resolveDnsRecord(
  subdomain: string,
  options: DnsResolutionOptions = {},
): Promise<DnsResolution> {
  const resolver = new Resolver();
  resolver.setServers(['1.1.1.1', '1.0.0.1']);
  const resolve = options.resolve ?? ((host) => resolver.resolve4(host));
  const sleep =
    options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  // eslint-disable-next-line local/no-hand-written-retry-loops -- returns a leftover/unverified outcome instead of failing at the deadline
  for (;;) {
    let addresses: string[];
    try {
      addresses = await resolve(`${subdomain}.anycloud.sh`);
    } catch (error) {
      const code = (error as { code?: string }).code ?? String(error);
      return DNS_CLEAN_CODES.has(code)
        ? { outcome: 'clean' }
        : { outcome: 'unverified', reason: code };
    }
    if (Date.now() >= deadline) return { outcome: 'leftover', addresses };
    await sleep(options.intervalMs ?? 5_000);
  }
}

export async function sweepDnsRecords(
  subdomains: readonly string[],
  options: { token: string; fetch?: typeof fetch },
): Promise<DnsRecordSweepOutcome[]> {
  const call = options.fetch ?? fetch;
  const outcomes: DnsRecordSweepOutcome[] = [];
  for (const subdomain of new Set(subdomains)) {
    try {
      const query = new URLSearchParams({ subdomain });
      const res = await call(`${DNS_WORKER_URL}/v1/dns-records?${query}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${options.token}`,
          'Content-Type': 'application/json',
        },
      });
      const body = res.ok
        ? ''
        : (await res.text()).replace(/\s+/g, ' ').slice(0, 200);
      outcomes.push(
        res.status === 404
          ? { subdomain, outcome: 'absent' }
          : res.ok
            ? { subdomain, outcome: 'cleared' }
            : {
                subdomain,
                outcome: 'failed',
                reason: `HTTP ${res.status}${body && `: ${body}`}`,
              },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      outcomes.push({ subdomain, outcome: 'failed', reason });
    }
  }
  return outcomes;
}
