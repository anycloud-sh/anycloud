/**
 * Cloudflare Worker for DNS record management.
 * Proxies DNS create/delete requests to the Cloudflare API so that
 * individual conductors never need Cloudflare credentials.
 *
 * Auth: validates the caller's GitHub token against the GitHub API.
 */

import {
  BridgeRuleFullError,
  CloudflareApiError,
  SupersededCertificateError,
  bridgeFullMessage,
  bridge,
  certificatesFor,
  csrSubjectAltNames,
  issueCertificate,
  revokeCertificates,
  setOriginPulls,
  type ApiTlsEnv,
} from './api-tls.js';

export { BridgeRule } from './api-tls.js';

type Env = ApiTlsEnv & {
  /** The {@link CertificateOwner} Durable Object namespace, one per subdomain. */
  CERTIFICATE_OWNER: ApiTlsEnv['BRIDGE_RULE'];
};

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const WORKLOAD_ID_MAX_LENGTH = 28;
const WORKLOAD_ID_RE = new RegExp(
  `^[a-z\\d](?:[a-z\\d-]{0,${WORKLOAD_ID_MAX_LENGTH - 2}}[a-z\\d])?$`,
);

type DnsRecord = {
  id: string;
  type?: string;
  name?: string;
  /** An A record's address. */
  content?: string;
  comment: string | null;
};

/**
 * A hostname awaiting its management VM's bootstrap (RFC 0049 C26 (e)):
 * published by the CLI with the user's GitHub token, so the VM, which holds
 * no token, may ask for its origin certificate from the record's address.
 */
interface BootstrapMarker {
  ip: string;
  username: string;
  userId: number;
  /** Epoch ms after which the bootstrap is over unused. */
  expiresAt: number;
}

/**
 * How long a VM may take to ask, from the publish: past create's own wait for
 * the cluster, a stale marker would let a later holder of the IP get a
 * certificate.
 */
const BOOTSTRAP_TTL_MS = 2 * 60 * 60_000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function cloudflareError(error: CloudflareApiError): Response {
  return json({ error: error.message }, 502);
}

function validateSubdomain(subdomain: string): Response | null {
  if (WORKLOAD_ID_RE.test(subdomain)) return null;
  return json(
    {
      error: `Invalid subdomain: must match workload ID format (lowercase letters, digits, hyphens, max ${WORKLOAD_ID_MAX_LENGTH} chars)`,
    },
    400,
  );
}

/** Validate GitHub token and return the authenticated username and user ID. */
async function authorize(
  request: Request,
): Promise<{ username: string; userId: number } | Response> {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const token = auth.slice(7);
  const headers = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'anycloud-dns-worker',
  };

  // Try /user first (works for PATs and OAuth tokens)
  const userRes = await fetch('https://api.github.com/user', { headers });
  if (userRes.ok) {
    const user = (await userRes.json()) as { login: string; id: unknown };
    // The ID, unlike the login, is never renamed or reassigned.
    if (!Number.isSafeInteger(user.id)) {
      return json(
        { error: 'Unauthorized: GitHub user has no numeric id' },
        401,
      );
    }
    return { username: user.login, userId: user.id as number };
  }

  return json({ error: 'Unauthorized: invalid GitHub token' }, 401);
}

/** Look up existing A records (or, with `anyType`, every record) for a subdomain. */
async function findExistingRecords(
  env: Env,
  subdomain: string,
  anyType = false,
): Promise<DnsRecord[]> {
  const name = `${subdomain}.anycloud.sh`;
  const type = anyType ? '' : 'type=A&';
  const res = await fetch(
    `${CLOUDFLARE_API}/zones/${env.CLOUDFLARE_ZONE_ID}/dns_records?${type}name=${encodeURIComponent(name)}`,
    {
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
    },
  );
  if (!res.ok) {
    throw new CloudflareApiError(
      'listing DNS records',
      res.status,
      await res.text(),
    );
  }
  const data = (await res.json()) as {
    result: DnsRecord[];
  };
  return data.result;
}

/** Cloudflare's "Record does not exist" (HTTP 404, error code 81044). */
function recordMissing(status: number, body: string): boolean {
  if (status !== 404) return false;
  try {
    const { errors } = JSON.parse(body) as { errors?: { code?: number }[] };
    return errors?.some((error) => error.code === 81044) ?? false;
  } catch {
    return false;
  }
}

/** Read one record; null when Cloudflare reports it does not exist. */
async function getCloudflareRecord(
  env: Env,
  recordId: string,
): Promise<DnsRecord | null> {
  const res = await fetch(
    `${CLOUDFLARE_API}/zones/${env.CLOUDFLARE_ZONE_ID}/dns_records/${recordId}`,
    {
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
    },
  );
  if (!res.ok) {
    const text = await res.text();
    if (recordMissing(res.status, text)) return null;
    throw new CloudflareApiError('reading DNS record', res.status, text);
  }
  const data = (await res.json()) as { result: DnsRecord };
  return data.result;
}

async function deleteCloudflareRecord(
  env: Env,
  recordId: string,
  operation = 'deleting DNS record',
): Promise<void> {
  const res = await fetch(
    `${CLOUDFLARE_API}/zones/${env.CLOUDFLARE_ZONE_ID}/dns_records/${recordId}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
    },
  );
  if (!res.ok) {
    const text = await res.text();
    // A concurrent publish or delete may have removed it first.
    if (recordMissing(res.status, text)) return;
    throw new CloudflareApiError(operation, res.status, text);
  }
}

async function updateCloudflareRecord(
  env: Env,
  recordId: string,
  subdomain: string,
  ip: string,
  username: string,
  proxied: boolean,
): Promise<void> {
  const res = await fetch(
    `${CLOUDFLARE_API}/zones/${env.CLOUDFLARE_ZONE_ID}/dns_records/${recordId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'A',
        name: `${subdomain}.anycloud.sh`,
        content: ip,
        ttl: 1,
        proxied,
        comment: username,
      }),
    },
  );
  if (!res.ok) {
    throw new CloudflareApiError(
      'updating existing DNS record',
      res.status,
      await res.text(),
    );
  }
}

async function createCloudflareRecord(
  env: Env,
  subdomain: string,
  ip: string,
  username: string,
  proxied: boolean,
): Promise<string> {
  const res = await fetch(
    `${CLOUDFLARE_API}/zones/${env.CLOUDFLARE_ZONE_ID}/dns_records`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'A',
        name: `${subdomain}.anycloud.sh`,
        content: ip,
        ttl: 1, // auto
        proxied,
        comment: username,
      }),
    },
  );
  if (!res.ok) {
    throw new CloudflareApiError(
      'creating DNS record',
      res.status,
      await res.text(),
    );
  }
  const data = (await res.json()) as { result: { id: string } };
  return data.result.id;
}

/**
 * The caller owns a hostname when every record for it, of any type, carries
 * their name; `requireRecord` also asks for at least one (a hostname nobody
 * holds can be torn down by anyone, since anyone could claim it first).
 */
async function owned(
  env: Env,
  subdomain: string,
  username: string,
  requireRecord: boolean,
): Promise<Response | null> {
  const records = await findExistingRecords(env, subdomain, true);
  if (records.some((record) => record.comment !== username)) {
    return json({ error: 'Subdomain owned by another user' }, 403);
  }
  if (requireRecord && records.length === 0) {
    return json({ error: 'Publish the DNS record first' }, 409);
  }
  return null;
}

/**
 * The GitHub user ID that first got an Origin CA certificate for a subdomain,
 * kept forever: a hosted API serves its OIDC issuer at `<id>.anycloud.sh` and
 * cloud roles may still trust it, so, as EKS never reuses an issuer, no other
 * account may claim it again. Service hostnames never get a certificate and
 * stay reusable.
 */
export class CertificateOwner {
  constructor(
    private readonly state: {
      storage: {
        get(key: string): Promise<unknown>;
        put(key: string, value: unknown): Promise<void>;
        delete(key: string): Promise<unknown>;
      };
    },
  ) {}

  /**
   * `GET` reads the owner; `PUT` records `userId` unless one is recorded.
   * Under `/bootstrap`, the hostname's {@link BootstrapMarker}: `GET`, `PUT`
   * and `DELETE`.
   */
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/bootstrap') {
      if (request.method === 'PUT')
        await this.state.storage.put('bootstrap', await request.json());
      if (request.method === 'DELETE')
        await this.state.storage.delete('bootstrap');
      return Response.json({
        marker: (await this.state.storage.get('bootstrap')) ?? null,
      });
    }
    // Read the body first: only storage calls hold the input gate, so
    // awaiting it between the read and the write would let a second PUT in.
    const claim =
      request.method === 'PUT'
        ? ((await request.json()) as { userId: number }).userId
        : null;
    let userId =
      ((await this.state.storage.get('userId')) as number | undefined) ?? null;
    if (claim !== null && userId === null) {
      userId = claim;
      await this.state.storage.put('userId', userId);
    }
    return Response.json({ userId });
  }
}

async function callCertificateOwner(
  env: Env,
  subdomain: string,
  init: RequestInit,
): Promise<number | null> {
  const stub = env.CERTIFICATE_OWNER.get(
    env.CERTIFICATE_OWNER.idFromName(subdomain),
  );
  const res = await stub.fetch('https://certificate-owner/', init);
  if (!res.ok) {
    throw new CloudflareApiError(
      `${init.method === 'PUT' ? 'recording' : 'reading'} the certificate owner`,
      res.status,
      await res.text(),
    );
  }
  return ((await res.json()) as { userId: number | null }).userId;
}

/** The user ID that owns a subdomain's certificates, if any was issued. */
function certificateOwner(env: Env, subdomain: string): Promise<number | null> {
  return callCertificateOwner(env, subdomain, { method: 'GET' });
}

/** Record `userId` as the certificate owner unless one is; return the owner. */
function recordCertificateOwner(
  env: Env,
  subdomain: string,
  userId: number,
): Promise<number> {
  return callCertificateOwner(env, subdomain, {
    method: 'PUT',
    body: JSON.stringify({ userId }),
  }) as Promise<number>;
}

/** The hostname's bootstrap marker; `PUT` sets it, `DELETE` clears it. */
async function bootstrapMarker(
  env: Env,
  subdomain: string,
  init: RequestInit = { method: 'GET' },
): Promise<BootstrapMarker | null> {
  const stub = env.CERTIFICATE_OWNER.get(
    env.CERTIFICATE_OWNER.idFromName(subdomain),
  );
  const res = await stub.fetch('https://certificate-owner/bootstrap', init);
  if (!res.ok) {
    throw new CloudflareApiError(
      'reading the bootstrap marker',
      res.status,
      await res.text(),
    );
  }
  return ((await res.json()) as { marker: BootstrapMarker | null }).marker;
}

/** Refuse a hostname whose certificates another user ID owns. */
function certifiedToAnother(
  hostname: string,
  owner: number | null,
  userId: number,
): Response | null {
  if (owner === null || owner === userId) return null;
  return json(
    {
      error: `${hostname} carried another account's API certificate and is never reassigned: cloud roles may still trust its OIDC issuer. Choose another name`,
    },
    409,
  );
}

/**
 * Revoke a hostname's Origin CA certificates for the user ID releasing it.
 * One certified before owners were recorded gets that user ID as its owner
 * first, so its release keeps the hostname from other accounts too.
 */
async function releaseCertificates(
  env: Env,
  subdomain: string,
  userId: number,
): Promise<number> {
  const hostname = `${subdomain}.anycloud.sh`;
  if ((await certificatesFor(env, hostname)).length > 0) {
    await recordCertificateOwner(env, subdomain, userId);
  }
  return revokeCertificates(env, hostname);
}

/**
 * Before the last records for a hostname are deleted, revoke its Origin CA
 * certificates: they are valid for 15 years and must not outlive ownership.
 * Revoking first keeps a failed revocation retryable.
 */
async function revokeOnRelease(
  env: Env,
  subdomain: string,
  releasing: DnsRecord[],
  userId: number,
): Promise<void> {
  const ids = new Set(releasing.map((record) => record.id));
  const all = await findExistingRecords(env, subdomain, true);
  if (all.every((record) => ids.has(record.id))) {
    await releaseCertificates(env, subdomain, userId);
  }
}

/**
 * Full (strict) for a hostname whose origin serves its certificate: origin
 * pulls first, so Full (strict) never reaches an origin that wants a client
 * certificate Cloudflare does not send yet. All or nothing: a full rule is
 * refused before any change, and a failed add voids the origin pulls.
 */
async function activate(env: Env, hostname: string): Promise<Response> {
  const state = await bridge(env, 'check', hostname);
  if (state && !state.present && !state.fits) {
    return json({ error: bridgeFullMessage(state.hosts) }, 409);
  }
  const originPulls = await setOriginPulls(env, hostname, true);
  if (state && !state.present) {
    try {
      await bridge(env, 'add', hostname);
    } catch (error) {
      if (originPulls) await setOriginPulls(env, hostname, null);
      throw error;
    }
  }
  return json({ strict: state !== null, originPulls });
}

/**
 * The management VM's own origin TLS (RFC 0049 C26 (e)), with no token: the
 * request must come from the address the hostname's A record names, while
 * the record awaits bootstrap. Activation ends the bootstrap, so neither route
 * answers again for the hostname until a new publish asks for one.
 */
async function bootstrapTls(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  let body: { subdomain?: string; csr?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'Body must be JSON' }, 400);
  }
  if (!body || typeof body !== 'object')
    return json({ error: 'Body must be a JSON object' }, 400);
  if (!body.subdomain) return json({ error: 'Missing subdomain' }, 400);
  const subdomainError = validateSubdomain(body.subdomain);
  if (subdomainError) return subdomainError;
  const hostname = `${body.subdomain}.anycloud.sh`;
  const refused = json(
    { error: `${hostname} is not awaiting bootstrap from this address` },
    403,
  );
  // The marker and caller first: an unauthenticated caller reaches the zone's
  // Cloudflare API only for a hostname awaiting it from that address.
  const marker = await bootstrapMarker(env, body.subdomain);
  const caller = request.headers.get('CF-Connecting-IP');
  if (!marker || !caller || caller !== marker.ip) return refused;
  if (Date.now() > marker.expiresAt) {
    await bootstrapMarker(env, body.subdomain, { method: 'DELETE' });
    return refused;
  }
  const records = await findExistingRecords(env, body.subdomain, true);
  if (
    records.length !== 1 ||
    records[0]!.type !== 'A' ||
    records[0]!.content !== marker.ip ||
    records[0]!.comment !== marker.username
  ) {
    return refused;
  }
  if (url.pathname === '/v1/api-tls/bootstrap/certificates') {
    if (!body.csr) return json({ error: 'Missing csr' }, 400);
    let names: (string | null)[];
    try {
      names = csrSubjectAltNames(body.csr);
    } catch {
      return json({ error: 'csr is not a PEM certificate request' }, 400);
    }
    if (names.length !== 1 || names[0] !== hostname) {
      return json(
        {
          error: `csr must name exactly ${hostname} as its subject alternative name`,
        },
        400,
      );
    }
    const denied = certifiedToAnother(
      hostname,
      await recordCertificateOwner(env, body.subdomain, marker.userId),
      marker.userId,
    );
    return denied ?? json(await issueCertificate(env, hostname, body.csr));
  }
  const activated = await activate(env, hostname);
  if (activated.ok)
    await bootstrapMarker(env, body.subdomain, { method: 'DELETE' });
  return activated;
}

/** Origin TLS for a hosted API's hostname. */
async function apiTls(
  request: Request,
  url: URL,
  env: Env,
  username: string,
  userId: number,
): Promise<Response> {
  const body =
    request.method === 'POST'
      ? ((await request.json()) as { subdomain?: string; csr?: string })
      : { subdomain: url.searchParams.get('subdomain') ?? undefined };
  if (!body.subdomain) return json({ error: 'Missing subdomain' }, 400);
  const subdomainError = validateSubdomain(body.subdomain);
  if (subdomainError) return subdomainError;
  const hostname = `${body.subdomain}.anycloud.sh`;
  const route = `${request.method} ${url.pathname}`;

  if (route === 'POST /v1/api-tls/certificates') {
    if (!body.csr) return json({ error: 'Missing csr' }, 400);
    let names: (string | null)[];
    try {
      names = csrSubjectAltNames(body.csr);
    } catch {
      return json({ error: 'csr is not a PEM certificate request' }, 400);
    }
    if (names.length !== 1 || names[0] !== hostname) {
      return json(
        {
          error: `csr must name exactly ${hostname} as its subject alternative name`,
        },
        400,
      );
    }
    const denied =
      (await owned(env, body.subdomain, username, true)) ??
      certifiedToAnother(
        hostname,
        await recordCertificateOwner(env, body.subdomain, userId),
        userId,
      );
    return denied ?? json(await issueCertificate(env, hostname, body.csr));
  }
  // After the origin serves the certificate on 443: origin pulls first, so
  // Full (strict) never reaches an origin that wants a client certificate
  // Cloudflare does not send yet.
  // All or nothing: a full rule is refused before any change, and a failed
  // add voids the origin pulls it followed.
  if (route === 'POST /v1/api-tls/activate') {
    const denied = await owned(env, body.subdomain, username, true);
    if (denied) return denied;
    return activate(env, hostname);
  }
  // `api delete` and `api delete --skip-cloud`, before the DNS record goes, in the
  // reverse order of activation.
  if (route === 'DELETE /v1/api-tls') {
    const denied = await owned(env, body.subdomain, username, false);
    if (denied) return denied;
    await bridge(env, 'remove', hostname);
    await setOriginPulls(env, hostname, null);
    // Only the holder of the hostname's records becomes its owner; one
    // nobody holds is torn down without one.
    const held = (await findExistingRecords(env, body.subdomain, true)).length;
    return json({
      revoked: held
        ? await releaseCertificates(env, body.subdomain, userId)
        : await revokeCertificates(env, hostname),
    });
  }
  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/v1/health') {
      return json({ ok: true });
    }

    if (
      request.method === 'POST' &&
      (url.pathname === '/v1/api-tls/bootstrap/certificates' ||
        url.pathname === '/v1/api-tls/bootstrap/activate')
    ) {
      try {
        return await bootstrapTls(request, url, env);
      } catch (error) {
        if (error instanceof CloudflareApiError) return cloudflareError(error);
        if (
          error instanceof BridgeRuleFullError ||
          error instanceof SupersededCertificateError
        ) {
          return json({ error: error.message }, 409);
        }
        throw error;
      }
    }

    if (url.pathname.startsWith('/v1/api-tls')) {
      const auth = await authorize(request);
      if (auth instanceof Response) return auth;
      try {
        return await apiTls(request, url, env, auth.username, auth.userId);
      } catch (error) {
        if (error instanceof CloudflareApiError) return cloudflareError(error);
        if (
          error instanceof BridgeRuleFullError ||
          error instanceof SupersededCertificateError
        ) {
          return json({ error: error.message }, 409);
        }
        throw error;
      }
    }

    // POST /v1/dns-records — create or update an A record
    if (request.method === 'POST' && url.pathname === '/v1/dns-records') {
      const auth = await authorize(request);
      if (auth instanceof Response) return auth;

      const body = (await request.json()) as {
        subdomain?: string;
        ip?: string;
        proxied?: boolean;
        recordId?: string | null;
        /** The management VM at `ip` may get its origin certificate itself. */
        bootstrap?: boolean;
      };
      if (!body.subdomain || !body.ip) {
        return json({ error: 'Missing subdomain or ip' }, 400);
      }
      const subdomainError = validateSubdomain(body.subdomain);
      if (subdomainError) return subdomainError;
      if (body.proxied !== undefined && typeof body.proxied !== 'boolean') {
        return json({ error: 'proxied must be a boolean' }, 400);
      }
      const proxied = body.proxied ?? true;
      if (body.bootstrap !== undefined && typeof body.bootstrap !== 'boolean') {
        return json({ error: 'bootstrap must be a boolean' }, 400);
      }

      // The record id is the ownership token. Only the caller that holds
      // the current id updates it in place, with no gap during an upgrade.
      // Any other same-user caller (an older API sends no id) gets a new
      // record, so a stale holder's later delete-by-id finds nothing.
      // Every type once: A records for ownership and replacement, all of them
      // to tell a new claim.
      let all: DnsRecord[];
      try {
        all = await findExistingRecords(env, body.subdomain, true);
      } catch (error) {
        if (error instanceof CloudflareApiError) {
          return cloudflareError(error);
        }
        throw error;
      }
      const existing = all.filter((record) => record.type === 'A');
      for (const record of existing) {
        if (record.comment !== auth.username) {
          return json({ error: 'Subdomain already taken' }, 409);
        }
      }

      const held = existing.find((record) => record.id === body.recordId);
      try {
        // An API hostname goes back only to its certificate owner (a restore
        // after destroy), and a new owner never inherits a certificate issued
        // to a previous one.
        const refused = certifiedToAnother(
          `${body.subdomain}.anycloud.sh`,
          await certificateOwner(env, body.subdomain),
          auth.userId,
        );
        if (refused) return refused;
        if (all.length === 0) {
          await revokeCertificates(env, `${body.subdomain}.anycloud.sh`);
        }
        let recordId: string;
        if (held) {
          await updateCloudflareRecord(
            env,
            held.id,
            body.subdomain,
            body.ip,
            auth.username,
            proxied,
          );
          recordId = held.id;
        } else {
          recordId = await createCloudflareRecord(
            env,
            body.subdomain,
            body.ip,
            auth.username,
            proxied,
          );
        }

        // Publish first so the hostname always has a live record. Delete only
        // records listed before this publish: two concurrent publishes then
        // never delete each other's new record.
        for (const record of existing) {
          if (record.id === recordId) continue;
          await deleteCloudflareRecord(
            env,
            record.id,
            'deleting replaced DNS record',
          );
        }
        await bootstrapMarker(
          env,
          body.subdomain,
          body.bootstrap
            ? {
                method: 'PUT',
                body: JSON.stringify({
                  ip: body.ip,
                  username: auth.username,
                  userId: auth.userId,
                  expiresAt: Date.now() + BOOTSTRAP_TTL_MS,
                } satisfies BootstrapMarker),
              }
            : { method: 'DELETE' },
        );
        return json({ recordId, proxied });
      } catch (error) {
        if (error instanceof CloudflareApiError) {
          return cloudflareError(error);
        }
        throw error;
      }
    }

    // DELETE /v1/dns-records?subdomain=X — delete all A records for a subdomain
    if (
      request.method === 'DELETE' &&
      url.pathname === '/v1/dns-records' &&
      url.searchParams.has('subdomain')
    ) {
      const auth = await authorize(request);
      if (auth instanceof Response) return auth;

      const subdomain = url.searchParams.get('subdomain')!;
      const subdomainError = validateSubdomain(subdomain);
      if (subdomainError) return subdomainError;

      let records: DnsRecord[];
      try {
        records = await findExistingRecords(env, subdomain);
      } catch (error) {
        if (error instanceof CloudflareApiError) {
          return cloudflareError(error);
        }
        throw error;
      }

      if (records.some((record) => record.comment !== auth.username)) {
        return json({ error: 'Subdomain owned by another user' }, 403);
      }

      try {
        await bootstrapMarker(env, subdomain, { method: 'DELETE' });
        await revokeOnRelease(env, subdomain, records, auth.userId);
      } catch (error) {
        if (error instanceof CloudflareApiError) return cloudflareError(error);
        throw error;
      }
      let deleted = 0;
      for (const record of records) {
        try {
          await deleteCloudflareRecord(env, record.id);
          deleted++;
        } catch (error) {
          if (error instanceof CloudflareApiError) {
            return cloudflareError(error);
          }
          throw error;
        }
      }

      return json({ deleted });
    }

    // DELETE /v1/dns-records/:recordId — delete a DNS record by ID
    if (
      request.method === 'DELETE' &&
      url.pathname.startsWith('/v1/dns-records/')
    ) {
      const auth = await authorize(request);
      if (auth instanceof Response) return auth;

      const recordId = url.pathname.split('/v1/dns-records/')[1];
      if (!recordId) {
        return json({ error: 'Missing recordId' }, 400);
      }

      let record: DnsRecord | null;
      try {
        record = await getCloudflareRecord(env, recordId);
      } catch (error) {
        if (error instanceof CloudflareApiError) {
          return cloudflareError(error);
        }
        throw error;
      }
      // A replaced record is already gone; callers treat 404 as deleted.
      if (!record) return json({ error: 'DNS record not found' }, 404);
      if (record.comment !== auth.username) {
        return json({ error: 'DNS record owned by another user' }, 403);
      }

      try {
        const subdomain = record.name?.replace(/\.anycloud\.sh$/, '');
        if (subdomain) {
          await revokeOnRelease(env, subdomain, [record], auth.userId);
        }
        await deleteCloudflareRecord(env, recordId);
      } catch (error) {
        if (error instanceof CloudflareApiError) {
          return cloudflareError(error);
        }
        throw error;
      }

      return json({ ok: true });
    }

    return json({ error: 'Not found' }, 404);
  },
};
