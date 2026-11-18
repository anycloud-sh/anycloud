/**
 * DNS record management via the anycloud DNS Worker.
 * The Worker validates the user's GitHub token and proxies to the Cloudflare API,
 * so neither an API nor the CLI ever needs Cloudflare credentials. Shared: the
 * CLI publishes a cluster's record (RFC 0049 C26 (e)), and an API its
 * workloads'. Callers log; this module doesn't.
 */

/** The DNS Worker's base URL; the management VM asks it for its origin certificate. */
export const DNS_WORKER_URL = 'https://dns.anycloud.sh';

function getHeaders(githubToken: string | null): Record<string, string> {
  if (!githubToken) {
    throw new Error('GitHub token required for DNS record management');
  }
  return {
    Authorization: `Bearer ${githubToken}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Create or update an A record: {subdomain}.anycloud.sh -> ip
 *
 * The record id is the ownership token: the Worker updates in place only the
 * record whose id `recordId` names. Otherwise it creates a new record and
 * removes the old ones, so a previous holder's delete-by-id no longer reaches
 * this hostname.
 * @returns The Cloudflare DNS record ID (used for cleanup on termination)
 */
export async function upsertDNSRecord(
  subdomain: string,
  ip: string,
  githubToken: string | null,
  options: {
    proxied?: boolean;
    recordId?: string | null;
    /**
     * A cluster's record whose management VM will ask for its own origin
     * certificate: the Worker marks it awaiting bootstrap (RFC 0049 C26 (e)).
     */
    bootstrap?: boolean;
  } = {},
): Promise<string> {
  const proxied = options.proxied ?? true;

  const res = await fetch(`${DNS_WORKER_URL}/v1/dns-records`, {
    method: 'POST',
    headers: getHeaders(githubToken),
    body: JSON.stringify({
      subdomain,
      ip,
      proxied,
      recordId: options.recordId,
      ...(options.bootstrap ? { bootstrap: true } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    const fix =
      res.status === 401
        ? '; run `anycloud login` (`anycloud login <api-url>` on a hosted API)'
        : '';
    throw new Error(`DNS record publish failed (${res.status}): ${body}${fix}`);
  }

  const data = (await res.json()) as {
    recordId: string;
    proxied?: boolean;
  };
  if (options.proxied !== undefined && data.proxied !== proxied) {
    throw new Error(
      `DNS record publish did not confirm proxied=${String(proxied)}; deploy a DNS Worker that supports explicit proxy mode`,
    );
  }
  return data.recordId;
}

/** Delete every same-owner A record for a deterministic subdomain. */
export async function deleteDNSRecordBySubdomain(
  subdomain: string,
  githubToken: string | null,
): Promise<void> {
  const query = new URLSearchParams({ subdomain });
  const res = await fetch(`${DNS_WORKER_URL}/v1/dns-records?${query}`, {
    method: 'DELETE',
    headers: getHeaders(githubToken),
  });

  if (res.status === 404) return;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`DNS subdomain cleanup failed (${res.status}): ${body}`);
  }
}

/**
 * Delete a DNS record by ID.
 */
export async function deleteDNSRecord(
  recordId: string,
  githubToken: string | null,
): Promise<void> {
  const res = await fetch(`${DNS_WORKER_URL}/v1/dns-records/${recordId}`, {
    method: 'DELETE',
    headers: getHeaders(githubToken),
  });

  // DELETE is a reconciliation primitive: a prior attempt may have succeeded
  // before its local completion marker committed.
  if (res.status === 404) {
    return;
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`DNS record delete failed (${res.status}): ${body}`);
  }
}

async function apiTlsRequest<T>(
  method: 'POST' | 'DELETE',
  path: string,
  githubToken: string | null,
  body?: object,
): Promise<T> {
  const res = await fetch(`${DNS_WORKER_URL}${path}`, {
    method,
    headers: getHeaders(githubToken),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(
      `DNS Worker ${method} ${path.split('?')[0]} failed (${res.status}): ${await res.text()}`,
    );
  }
  return (await res.json()) as T;
}

/**
 * Sign the installation's CSR as a Cloudflare Origin CA certificate for
 * `{subdomain}.anycloud.sh`; the caller must hold its DNS record.
 */
export function issueOriginCertificate(
  subdomain: string,
  csr: string,
  githubToken: string | null,
): Promise<{ certificate: string; originPullCa: string | null }> {
  return apiTlsRequest('POST', '/v1/api-tls/certificates', githubToken, {
    subdomain,
    csr,
  });
}

/** Once the origin serves its certificate: origin pulls, then Full (strict). */
export async function activateApiTls(
  subdomain: string,
  githubToken: string | null,
): Promise<void> {
  const result = await apiTlsRequest<{ strict: boolean; originPulls: boolean }>(
    'POST',
    '/v1/api-tls/activate',
    githubToken,
    { subdomain },
  );
}

/** Undo activation and revoke the hostname's certificates (idempotent). */
export async function removeApiTls(
  subdomain: string,
  githubToken: string | null,
): Promise<void> {
  const query = new URLSearchParams({ subdomain });
  await apiTlsRequest('DELETE', `/v1/api-tls?${query}`, githubToken);
}

const PUBLIC_RESOLVER_URL = 'https://1.1.1.1/dns-query';
const PUBLIC_RESOLVER_TIMEOUT_MS = 5_000;
const DNS_TYPE_A = 1;

/**
 * Whether 1.1.1.1 answers an A record for a hostname, over DNS over HTTPS:
 * false while the name doesn't resolve (NXDOMAIN or no A record). Throws when
 * the resolver can't be asked.
 */
export async function publicARecordExists(
  hostname: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const query = new URLSearchParams({ name: hostname, type: 'A' });
  const res = await fetch(`${PUBLIC_RESOLVER_URL}?${query}`, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.any([
      AbortSignal.timeout(PUBLIC_RESOLVER_TIMEOUT_MS),
      ...(signal ? [signal] : []),
    ]),
  });
  if (!res.ok) throw new Error(`1.1.1.1 answered HTTP ${res.status}`);
  const body = (await res.json()) as {
    Answer?: Array<{ type: number }>;
  };
  return (body.Answer ?? []).some((answer) => answer.type === DNS_TYPE_A);
}
