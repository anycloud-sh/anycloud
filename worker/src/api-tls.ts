/**
 * Origin TLS for hosted APIs (the API-TLS rollout's steps 1 and 1b): per-installation Origin
 * CA certificates signed from the installation's CSR, the temporary bridge
 * Configuration Rule that sets Full (strict) for installation hostnames, and
 * per-hostname authenticated origin pulls with anycloud's client certificate.
 */

export interface ApiTlsEnv {
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ZONE_ID: string;
  /** `<ruleset id>/<rule id>` of the bridge rule; unset leaves the rule alone. */
  API_TLS_BRIDGE_RULE?: string;
  /** Per-hostname origin pull certificate id; unset skips origin pulls. */
  ORIGIN_PULL_CERT_ID?: string;
  /** PEM of the CA that signed that client certificate; origins verify it. */
  ORIGIN_PULL_CA?: string;
  /** The {@link BridgeRule} Durable Object namespace. */
  BRIDGE_RULE: {
    idFromName(name: string): unknown;
    get(id: unknown): {
      fetch(input: string, init: RequestInit): Promise<Response>;
    };
  };
}

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
/** Origin CA's longest validity, so issued certificates need no renewal. */
const CERTIFICATE_VALIDITY_DAYS = 5475;

export class CloudflareApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`Cloudflare API error (${status}) while ${operation}: ${body}`);
  }
}

export async function cloudflare<T>(
  env: ApiTlsEnv,
  operation: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${CLOUDFLARE_API}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) {
    throw new CloudflareApiError(operation, res.status, await res.text());
  }
  return ((await res.json()) as { result: T }).result;
}

// --- CSR inspection --------------------------------------------------------

interface Tlv {
  tag: number;
  start: number;
  end: number;
}

function readTlv(der: Uint8Array, offset: number): Tlv {
  const tag = der[offset];
  let length = der[offset + 1];
  let start = offset + 2;
  if (length & 0x80) {
    const bytes = length & 0x7f;
    length = 0;
    for (let i = 0; i < bytes; i++) length = length * 256 + der[start + i];
    start += bytes;
  }
  if (tag === undefined || start + length > der.length) {
    throw new Error('truncated DER');
  }
  return { tag, start, end: start + length };
}

function children(der: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let at = parent.start; at < parent.end; at = out.at(-1)!.end) {
    out.push(readTlv(der, at));
  }
  return out;
}

function hex(der: Uint8Array, tlv: Tlv): string {
  return Array.from(der.subarray(tlv.start, tlv.end), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

const EXTENSION_REQUEST_OID = '2a864886f70d01090e'; // 1.2.840.113549.1.9.14
const SUBJECT_ALT_NAME_OID = '551d11'; // 2.5.29.17
const DNS_NAME_TAG = 0x82;

/**
 * The subject alternative names a PKCS#10 request asks for; a non-DNS name
 * comes back as `null` so a caller comparing names refuses it.
 */
export function csrSubjectAltNames(pem: string): (string | null)[] {
  const base64 = pem
    .replace(/-----(BEGIN|END) (NEW )?CERTIFICATE REQUEST-----/g, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const request = readTlv(der, 0);
  const info = children(der, children(der, request)[0]);
  const attributes = info.find((tlv) => tlv.tag === 0xa0);
  if (!attributes) return [];
  for (const attribute of children(der, attributes)) {
    const [oid, values] = children(der, attribute);
    if (hex(der, oid) !== EXTENSION_REQUEST_OID) continue;
    const extensions = children(der, children(der, values)[0]);
    for (const extension of extensions) {
      const parts = children(der, extension);
      if (hex(der, parts[0]) !== SUBJECT_ALT_NAME_OID) continue;
      const names = readTlv(der, parts.at(-1)!.start);
      return children(der, names).map((name) =>
        name.tag === DNS_NAME_TAG
          ? new TextDecoder().decode(der.subarray(name.start, name.end))
          : null,
      );
    }
  }
  return [];
}

// --- Origin CA certificates ------------------------------------------------

interface OriginCertificate {
  id: string;
  certificate: string;
  hostnames: string[];
  expires_on: string;
  revoked_at?: string | null;
}

/** Origin CA has answered both RFC 3339 and `2039-08-02 03:15:00 +0000 UTC`. */
function instant(timestamp: string): number {
  const parsed = Date.parse(
    timestamp.replace(/ \+0000 UTC$/, 'Z').replace(/^(\S+) /, '$1T'),
  );
  // Comparing NaN would silently skip a revocation.
  if (Number.isNaN(parsed)) {
    throw new Error(`unrecognized Origin CA expires_on: ${timestamp}`);
  }
  return parsed;
}

export async function certificatesFor(
  env: ApiTlsEnv,
  hostname: string,
): Promise<OriginCertificate[]> {
  const found: OriginCertificate[] = [];
  for (let page = 1; ; page++) {
    const batch = await cloudflare<OriginCertificate[]>(
      env,
      'listing origin certificates',
      `/certificates?zone_id=${env.CLOUDFLARE_ZONE_ID}&per_page=50&page=${page}`,
    );
    // Only live certificates for exactly this hostname: anything wider is not
    // an installation's and stays, and a revoked one needs nothing more.
    found.push(
      ...batch.filter(
        (cert) =>
          !cert.revoked_at &&
          cert.hostnames.length === 1 &&
          cert.hostnames[0] === hostname,
      ),
    );
    if (batch.length < 50) return found;
  }
}

/**
 * Revoke this hostname's certificates; with `issuedBefore`, only those that
 * expire earlier than it (every one is issued for the same validity), so of
 * two overlapping issuances the later one survives either revocation.
 */
export async function revokeCertificates(
  env: ApiTlsEnv,
  hostname: string,
  issuedBefore?: OriginCertificate,
): Promise<number> {
  let revoked = 0;
  for (const cert of await certificatesFor(env, hostname)) {
    if (
      issuedBefore &&
      !(instant(cert.expires_on) < instant(issuedBefore.expires_on))
    ) {
      continue;
    }
    await revoke(env, cert.id);
    revoked++;
  }
  return revoked;
}

/** Revoke one certificate; one that is gone or reads as revoked counts as done. */
async function revoke(env: ApiTlsEnv, id: string): Promise<void> {
  try {
    await cloudflare(
      env,
      'revoking origin certificate',
      `/certificates/${id}`,
      {
        method: 'DELETE',
      },
    );
  } catch (error) {
    if (!(error instanceof CloudflareApiError) || error.status >= 500) {
      throw error;
    }
    if (error.status === 404) return;
    // Any other refusal counts only once the certificate reads as revoked
    // (or gone); a failed re-read keeps the refusal in its message.
    let cert: OriginCertificate;
    try {
      cert = await cloudflare<OriginCertificate>(
        env,
        'reading origin certificate',
        `/certificates/${id}`,
      );
    } catch (readError) {
      if (!(readError instanceof CloudflareApiError)) throw readError;
      if (readError.status === 404) return;
      throw new CloudflareApiError(
        error.operation,
        readError.status >= 500 ? readError.status : error.status,
        `${error.body}; re-reading it failed (${readError.status}): ${readError.body}`,
      );
    }
    if (!cert.revoked_at) throw error;
  }
}

/** A later issuance for the hostname won; the caller should retry. */
export class SupersededCertificateError extends Error {}

/**
 * Sign the installation's CSR for its hostname. The older certificates for
 * that hostname are revoked once the new one exists: a restore or a resumed
 * create replaces the key, and the old one must stop being trusted.
 */
export async function issueCertificate(
  env: ApiTlsEnv,
  hostname: string,
  csr: string,
): Promise<{ certificate: string; originPullCa: string | null }> {
  const issued = await cloudflare<OriginCertificate>(
    env,
    'issuing origin certificate',
    '/certificates',
    {
      method: 'POST',
      body: {
        csr,
        hostnames: [hostname],
        request_type: 'origin-rsa',
        requested_validity: CERTIFICATE_VALIDITY_DAYS,
      },
    },
  );
  await revokeCertificates(env, hostname, issued);
  // Defense in depth: the installer runs one release step per cluster at a
  // time, so no overlapping issuance is expected. If one finished later
  // anyway, it has revoked this certificate or will, so refuse to hand it out.
  const newer = (await certificatesFor(env, hostname)).some(
    (cert) => instant(cert.expires_on) > instant(issued.expires_on),
  );
  if (newer) {
    await revoke(env, issued.id);
    throw new SupersededCertificateError(
      `a newer certificate for ${hostname} was issued concurrently; retry`,
    );
  }
  return {
    certificate: issued.certificate,
    originPullCa:
      env.ORIGIN_PULL_CERT_ID && env.ORIGIN_PULL_CA ? env.ORIGIN_PULL_CA : null,
  };
}

/**
 * Per-hostname authenticated origin pulls. `null` voids the association, and
 * only where one is enabled: a hostname never activated has nothing to void.
 */
export async function setOriginPulls(
  env: ApiTlsEnv,
  hostname: string,
  enabled: true | null,
): Promise<boolean> {
  if (!env.ORIGIN_PULL_CERT_ID) return false;
  const path = `/zones/${env.CLOUDFLARE_ZONE_ID}/origin_tls_client_auth/hostnames`;
  if (enabled === null) {
    const current = await cloudflare<{ enabled?: boolean | null }>(
      env,
      'reading authenticated origin pulls',
      `${path}/${hostname}`,
    ).catch((error: unknown) => {
      if (error instanceof CloudflareApiError && error.status === 404) {
        return null;
      }
      throw error;
    });
    if (current?.enabled !== true) return false;
  }
  await cloudflare(env, 'configuring authenticated origin pulls', path, {
    method: 'PUT',
    body: {
      config: [{ hostname, cert_id: env.ORIGIN_PULL_CERT_ID, enabled }],
    },
  });
  return true;
}

// --- The bridge rule -------------------------------------------------------

interface Rule {
  id: string;
  action: string;
  action_parameters: unknown;
  expression: string;
  description?: string;
  enabled?: boolean;
}

/** Cloudflare's limit on a rule expression's length. */
export const MAX_EXPRESSION_LENGTH = 4096;
const HOST_RE = /"([a-z\d-]+\.anycloud\.sh)"/g;

export function bridgeHosts(expression: string): string[] {
  return [...expression.matchAll(HOST_RE)].map((match) => match[1]);
}

/** An empty list matches nothing, so the rule never needs disabling. */
export function bridgeExpression(hosts: string[]): string {
  if (hosts.length === 0) return '(http.host eq "")';
  return `(http.host in {${hosts.map((host) => `"${host}"`).join(' ')}})`;
}

type BridgeOp = 'check' | 'add' | 'remove';

/** Whether the hostname is listed, and whether adding it would fit. */
export interface BridgeState {
  present: boolean;
  fits: boolean;
  hosts: number;
}

export class BridgeRuleFullError extends Error {}

export function bridgeFullMessage(hosts: number): string {
  return `the API-TLS bridge rule is full (${hosts} hostnames; one more passes Cloudflare's ${MAX_EXPRESSION_LENGTH}-character expression limit). Origin TLS was left off for this hostname; ask the operator to flip the zone to Full (strict) or split the rule`;
}

export async function editBridgeRule(
  env: ApiTlsEnv,
  op: BridgeOp,
  hostname: string,
): Promise<BridgeState> {
  const [rulesetId, ruleId] = env.API_TLS_BRIDGE_RULE!.split('/');
  const base = `/zones/${env.CLOUDFLARE_ZONE_ID}/rulesets/${rulesetId}`;
  const ruleset = await cloudflare<{ rules: Rule[] }>(
    env,
    'reading the bridge rule',
    base,
  );
  const rule = ruleset.rules.find((candidate) => candidate.id === ruleId);
  if (!rule) throw new Error(`bridge rule ${ruleId} not found`);
  const before = bridgeHosts(rule.expression);
  const present = before.includes(hostname);
  const added = bridgeExpression([...new Set([...before, hostname])].sort());
  const state = {
    present,
    fits: added.length <= MAX_EXPRESSION_LENGTH,
    hosts: before.length,
  };
  if (op === 'check' || present === (op === 'add')) return state;
  if (op === 'add' && !state.fits) {
    throw new BridgeRuleFullError(bridgeFullMessage(before.length));
  }
  await cloudflare(env, 'editing the bridge rule', `${base}/rules/${ruleId}`, {
    method: 'PATCH',
    body: {
      action: rule.action,
      action_parameters: rule.action_parameters,
      description: rule.description,
      enabled: rule.enabled,
      expression:
        op === 'add'
          ? added
          : bridgeExpression(before.filter((host) => host !== hostname)),
    },
  });
  return state;
}

/**
 * One instance serializes every bridge rule edit: the Rulesets API has no
 * precondition, so concurrent read-modify-writes would lose hostnames.
 * Durable Objects interleave requests across awaits, hence the queue.
 */
export class BridgeRule {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    _state: unknown,
    private readonly env: ApiTlsEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const { op, hostname } = (await request.json()) as {
      op: BridgeOp;
      hostname: string;
    };
    const edit = this.queue.then(() => editBridgeRule(this.env, op, hostname));
    this.queue = edit.catch(() => undefined);
    try {
      return Response.json(await edit);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: error instanceof BridgeRuleFullError ? 409 : 502 },
      );
    }
  }
}

/** The bridge rule through its Durable Object; null when unconfigured. */
export async function bridge(
  env: ApiTlsEnv,
  op: BridgeOp,
  hostname: string,
): Promise<BridgeState | null> {
  if (!env.API_TLS_BRIDGE_RULE) return null;
  const stub = env.BRIDGE_RULE.get(env.BRIDGE_RULE.idFromName('bridge'));
  const res = await stub.fetch('https://bridge-rule/', {
    method: 'POST',
    body: JSON.stringify({ op, hostname }),
  });
  if (res.status === 409) {
    throw new BridgeRuleFullError(
      ((await res.json()) as { error: string }).error,
    );
  }
  if (!res.ok) {
    throw new CloudflareApiError(
      `${op} on the bridge rule`,
      res.status,
      await res.text(),
    );
  }
  return (await res.json()) as BridgeState;
}
