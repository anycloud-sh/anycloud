import forge from 'node-forge';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './index.js';
import { certificateOwners, type Env } from './testing.js';
import {
  BridgeRule,
  MAX_EXPRESSION_LENGTH,
  bridgeExpression,
  revokeCertificates,
  bridgeHosts,
  csrSubjectAltNames,
  type ApiTlsEnv,
} from './api-tls.js';

const HOST = 'api-1-abcd.anycloud.sh';
const SUBDOMAIN = 'api-1-abcd';
const keys = forge.pki.rsa.generateKeyPair(1024);

function csr(altNames: { type: number; value?: string; ip?: string }[]) {
  // @types/node-forge types a CSR as a Certificate, without setAttributes.
  const request =
    forge.pki.createCertificationRequest() as forge.pki.Certificate & {
      setAttributes(attributes: unknown[]): void;
    };
  request.publicKey = keys.publicKey;
  request.setSubject([{ name: 'commonName', value: HOST }]);
  if (altNames.length > 0) {
    request.setAttributes([
      {
        name: 'extensionRequest',
        extensions: [{ name: 'subjectAltName', altNames }],
      },
    ]);
  }
  request.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificationRequestToPem(request);
}

/** A stateful stand-in for the Cloudflare and GitHub APIs the Worker calls. */
class FakeCloudflare {
  records: {
    id: string;
    type: string;
    name: string;
    comment: string;
    content?: string;
  }[] = [{ id: 'rec-1', type: 'A', name: HOST, comment: 'owner' }];
  certificates: {
    id: string;
    hostnames: string[];
    certificate: string;
    expires_on: string;
    revoked_at?: string;
  }[] = [
    {
      id: 'old',
      hostnames: [HOST],
      certificate: 'OLD',
      expires_on: '2040-01-01T00:00:00Z',
    },
    {
      id: 'wide',
      hostnames: ['*.anycloud.sh'],
      certificate: 'WIDE',
      expires_on: '2030-01-01T00:00:00Z',
    },
  ];
  /** Expiry Origin CA gives the next certificate (Origin CA's own format). */
  nextExpiry = '2041-10-09 12:00:00 +0000 UTC';
  originPulls = new Map<string, boolean | null>();
  rule = {
    id: 'rule-1',
    action: 'set_config',
    action_parameters: { ssl: 'strict' },
    expression: '(http.host in {"api-0-prod.anycloud.sh"})',
    enabled: true,
  };
  calls: string[] = [];
  bodies: unknown[] = [];
  /** Delays every ruleset read, widening any read-modify-write race. */
  readDelayMs = 0;
  /** Status for certificate listing (the token's Origin CA rights). */
  certificateListStatus = 200;
  ruleEditStatus = 200;
  user = { login: 'owner', id: 1 };

  fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = new URL(input);
    const path = url.pathname.replace('/client/v4', '');
    this.calls.push(`${method} ${path}`);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    this.bodies.push(body);
    const ok = (result: unknown) => Response.json({ success: true, result });
    const fail = (status: number) =>
      Response.json({ success: false, errors: [{ code: status }] }, { status });
    if (url.hostname === 'api.github.com') {
      return Response.json(this.user);
    }
    if (path.endsWith('/dns_records') && method === 'GET') {
      const type = url.searchParams.get('type');
      return ok(this.records.filter((r) => !type || r.type === type));
    }
    if (path.endsWith('/dns_records') && method === 'POST') {
      const created = {
        id: `rec-${this.records.length + 2}`,
        type: 'A',
        name: body.name,
        comment: body.comment,
        content: body.content,
      };
      this.records.push(created);
      return ok(created);
    }
    if (path.includes('/dns_records/')) {
      const id = path.split('/').at(-1);
      const record = this.records.find((r) => r.id === id);
      if (method === 'DELETE')
        this.records = this.records.filter((r) => r.id !== id);
      return record ? ok(record) : fail(404);
    }
    if (path === '/certificates' && method === 'POST') {
      const issued = {
        id: 'new',
        hostnames: body.hostnames,
        certificate: 'NEW',
        expires_on: this.nextExpiry,
      };
      this.certificates.push(issued);
      return ok(issued);
    }
    if (path === '/certificates') {
      if (this.certificateListStatus !== 200)
        return fail(this.certificateListStatus);
      return ok(this.certificates);
    }
    if (path === '/certificates/vanished' && method === 'GET') return fail(404);
    if (path === '/certificates/unreadable' && method === 'GET') {
      return new Response('read down', { status: 503 });
    }
    if (
      ['/certificates/vanished', '/certificates/unreadable'].includes(path) &&
      method === 'DELETE'
    ) {
      return Response.json(
        {
          success: false,
          errors: [{ message: 'certificate cannot be revoked' }],
        },
        { status: 400 },
      );
    }
    if (path.startsWith('/certificates/') && method === 'GET') {
      const cert = this.certificates.find(
        (c) => c.id === path.split('/').at(-1),
      );
      return cert ? ok(cert) : fail(404);
    }
    if (path === '/certificates/locked' && method === 'DELETE') {
      return Response.json(
        {
          success: false,
          errors: [{ message: 'certificate cannot be revoked' }],
        },
        { status: 400 },
      );
    }
    // Revocation marks a certificate; the listing keeps showing it.
    if (path.startsWith('/certificates/') && method === 'DELETE') {
      const cert = this.certificates.find(
        (c) => c.id === path.split('/').at(-1),
      );
      if (!cert) return fail(404);
      if (cert.revoked_at) {
        return Response.json(
          {
            success: false,
            errors: [{ message: 'certificate already revoked' }],
          },
          { status: 400 },
        );
      }
      cert.revoked_at = '2026-10-09T12:00:00Z';
      return ok({ id: cert.id });
    }
    if (
      path.endsWith('/origin_tls_client_auth/hostnames') &&
      method === 'PUT'
    ) {
      for (const entry of body.config)
        this.originPulls.set(entry.hostname, entry.enabled);
      return ok([]);
    }
    if (path.includes('/origin_tls_client_auth/hostnames/')) {
      const hostname = path.split('/').at(-1)!;
      return this.originPulls.has(hostname)
        ? ok({ hostname, enabled: this.originPulls.get(hostname) })
        : fail(404);
    }
    if (path.endsWith('/rulesets/rs-1') && method === 'GET') {
      const snapshot = { ...this.rule };
      await new Promise((resolve) => setTimeout(resolve, this.readDelayMs));
      return ok({ rules: [snapshot] });
    }
    if (path.endsWith('/rulesets/rs-1/rules/rule-1') && method === 'PATCH') {
      if (this.ruleEditStatus !== 200) return fail(this.ruleEditStatus);
      this.rule = { ...this.rule, expression: body.expression };
      return ok({});
    }
    return new Response('not mocked', { status: 500 });
  });

  /** Ids of the certificates not revoked. */
  live(): string[] {
    return this.certificates.filter((c) => !c.revoked_at).map((c) => c.id);
  }

  edits(prefix: string): number {
    return this.calls.filter((c) => c.startsWith(prefix)).length;
  }
}

let cf: FakeCloudflare;

function env(overrides: Partial<ApiTlsEnv> = {}): Env {
  const base = {
    CERTIFICATE_OWNER: certificateOwners(),
    CLOUDFLARE_API_TOKEN: 'cf-token',
    CLOUDFLARE_ZONE_ID: 'zone-1',
    ...overrides,
    BRIDGE_RULE: {
      idFromName: () => 'bridge',
      get: () => ({
        fetch: (input, init) => instance.fetch(new Request(input, init)),
      }),
    },
  };
  const instance = new BridgeRule(null, base);
  return base;
}

const CONFIGURED = {
  API_TLS_BRIDGE_RULE: 'rs-1/rule-1',
  ORIGIN_PULL_CERT_ID: 'aop-1',
  ORIGIN_PULL_CA: 'CA PEM',
};

function call(method: string, path: string, body?: object) {
  return new Request(`https://dns.anycloud.sh${path}`, {
    method,
    headers: { Authorization: 'Bearer gh' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  cf = new FakeCloudflare();
  vi.stubGlobal('fetch', cf.fetch);
});

describe('csrSubjectAltNames', () => {
  it('reads DNS names and marks any other name type', () => {
    expect(csrSubjectAltNames(csr([{ type: 2, value: HOST }]))).toEqual([HOST]);
    expect(
      csrSubjectAltNames(
        csr([
          { type: 2, value: HOST },
          { type: 7, ip: '10.0.0.1' },
        ]),
      ),
    ).toEqual([HOST, null]);
    expect(csrSubjectAltNames(csr([]))).toEqual([]);
  });
});

describe('POST /v1/api-tls/certificates', () => {
  it('signs a CSR for the owned hostname and revokes only its older certificates', async () => {
    const pem = csr([{ type: 2, value: HOST }]);
    const res = await worker.fetch(
      call('POST', '/v1/api-tls/certificates', {
        subdomain: SUBDOMAIN,
        csr: pem,
      }),
      env(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      certificate: 'NEW',
      originPullCa: null,
    });
    const issue = cf.bodies[cf.calls.indexOf('POST /certificates')];
    expect(issue).toEqual({
      csr: pem,
      hostnames: [HOST],
      request_type: 'origin-rsa',
      requested_validity: 5475,
    });
    expect(cf.live()).toEqual(['wide', 'new']);
  });

  it('hands origins the client CA once origin pulls are configured', async () => {
    const res = await worker.fetch(
      call('POST', '/v1/api-tls/certificates', {
        subdomain: SUBDOMAIN,
        csr: csr([{ type: 2, value: HOST }]),
      }),
      env(CONFIGURED),
    );
    expect(await res.json()).toMatchObject({ originPullCa: 'CA PEM' });
  });

  it.each([
    ['another hostname', [{ type: 2, value: 'other.anycloud.sh' }]],
    [
      'a second name',
      [
        { type: 2, value: HOST },
        { type: 2, value: 'x.anycloud.sh' },
      ],
    ],
    ['an IP name', [{ type: 7, ip: '10.0.0.1' }]],
    ['no names', []],
  ])('refuses a CSR with %s', async (_label, altNames) => {
    const res = await worker.fetch(
      call('POST', '/v1/api-tls/certificates', {
        subdomain: SUBDOMAIN,
        csr: csr(altNames),
      }),
      env(),
    );
    expect(res.status).toBe(400);
    expect(cf.calls).not.toContain('POST /certificates');
  });

  it.each([
    [
      'held by another user',
      [{ id: 'rec-1', type: 'A', name: HOST, comment: 'someone' }],
      403,
    ],
    ['not published yet', [], 409],
  ])('refuses a hostname %s', async (_label, records, status) => {
    cf.records = records;
    const res = await worker.fetch(
      call('POST', '/v1/api-tls/certificates', {
        subdomain: SUBDOMAIN,
        csr: csr([{ type: 2, value: HOST }]),
      }),
      env(),
    );
    expect(res.status).toBe(status);
    expect(cf.calls).not.toContain('POST /certificates');
  });
});

describe('certificate owner', () => {
  const issue = (env: Env) =>
    worker.fetch(
      call('POST', '/v1/api-tls/certificates', {
        subdomain: SUBDOMAIN,
        csr: csr([{ type: 2, value: HOST }]),
      }),
      env,
    );
  const publish = (env: Env) =>
    worker.fetch(
      call('POST', '/v1/dns-records', { subdomain: SUBDOMAIN, ip: '1.2.3.4' }),
      env,
    );
  const refusal = `${HOST} carried another account's API certificate and is never reassigned`;

  it.each([`/v1/dns-records?subdomain=${SUBDOMAIN}`, '/v1/dns-records/rec-1'])(
    'after DELETE %s, only the certificate owner claims the hostname again',
    async (path) => {
      const e = env();
      expect((await issue(e)).status).toBe(200);
      expect((await worker.fetch(call('DELETE', path), e)).status).toBe(200);

      // The login renamed, then taken by another account.
      cf.user = { login: 'owner', id: 2 };
      const refused = await publish(e);
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: string }).error).toContain(
        refusal,
      );
      expect(cf.calls).not.toContain('POST /zones/zone-1/dns_records');

      // Restore after destroy: the certificate owner.
      cf.user = { login: 'owner', id: 1 };
      expect((await publish(e)).status).toBe(200);
      expect((await issue(e)).status).toBe(200);
    },
  );

  it.each([
    `/v1/api-tls?subdomain=${SUBDOMAIN}`,
    `/v1/dns-records?subdomain=${SUBDOMAIN}`,
    '/v1/dns-records/rec-1',
  ])(
    'DELETE %s records the releaser of a certificate issued before owners were',
    async (path) => {
      // `old` predates the owner record.
      const e = env();
      expect((await worker.fetch(call('DELETE', path), e)).status).toBe(200);
      expect(cf.live()).toEqual(['wide']);
      cf.records = [];

      cf.user = { login: 'someone-else', id: 2 };
      const refused = await publish(e);
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: string }).error).toContain(
        refusal,
      );
      cf.user = { login: 'owner', id: 1 };
      expect((await publish(e)).status).toBe(200);
    },
  );

  it('records no owner when tearing down a hostname nobody holds', async () => {
    cf.records = [];
    const e = env();
    cf.user = { login: 'someone-else', id: 2 };
    expect(
      (
        await worker.fetch(
          call('DELETE', `/v1/api-tls?subdomain=${SUBDOMAIN}`),
          e,
        )
      ).status,
    ).toBe(200);
    cf.user = { login: 'owner', id: 1 };
    expect((await publish(e)).status).toBe(200);
  });

  it('refuses a certificate to another user ID with the same login', async () => {
    const e = env();
    expect((await issue(e)).status).toBe(200);
    const issued = cf.edits('POST /certificates');

    cf.user = { login: 'owner', id: 2 };
    const refused = await issue(e);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain(
      refusal,
    );
    expect(cf.edits('POST /certificates')).toBe(issued);
  });
});

describe('POST /v1/api-tls/activate', () => {
  it('enables origin pulls before adding the hostname to the bridge rule', async () => {
    const res = await worker.fetch(
      call('POST', '/v1/api-tls/activate', { subdomain: SUBDOMAIN }),
      env(CONFIGURED),
    );

    expect(await res.json()).toEqual({ strict: true, originPulls: true });
    const pulls = cf.calls.indexOf(
      'PUT /zones/zone-1/origin_tls_client_auth/hostnames',
    );
    const edit = cf.calls.indexOf(
      'PATCH /zones/zone-1/rulesets/rs-1/rules/rule-1',
    );
    expect(pulls).toBeGreaterThan(-1);
    expect(edit).toBeGreaterThan(pulls);
    expect(cf.bodies[pulls]).toEqual({
      config: [{ hostname: HOST, cert_id: 'aop-1', enabled: true }],
    });
    expect(bridgeHosts(cf.rule.expression)).toEqual([
      'api-0-prod.anycloud.sh',
      HOST,
    ]);
  });

  it('changes nothing in Cloudflare until the bridge is configured', async () => {
    const res = await worker.fetch(
      call('POST', '/v1/api-tls/activate', { subdomain: SUBDOMAIN }),
      env(),
    );
    expect(await res.json()).toEqual({ strict: false, originPulls: false });
    expect(cf.calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
  });

  it('refuses another user', async () => {
    cf.records = [{ id: 'rec-1', type: 'A', name: HOST, comment: 'someone' }];
    const res = await worker.fetch(
      call('POST', '/v1/api-tls/activate', { subdomain: SUBDOMAIN }),
      env(CONFIGURED),
    );
    expect(res.status).toBe(403);
    expect(cf.rule.expression).not.toContain(HOST);
  });
});

describe('DELETE /v1/api-tls', () => {
  it('removes the hostname from the rule, voids origin pulls and revokes its certificates', async () => {
    cf.rule.expression = bridgeExpression(['api-0-prod.anycloud.sh', HOST]);
    cf.originPulls.set(HOST, true);
    const res = await worker.fetch(
      call('DELETE', `/v1/api-tls?subdomain=${SUBDOMAIN}`),
      env(CONFIGURED),
    );

    expect(await res.json()).toEqual({ revoked: 1 });
    expect(bridgeHosts(cf.rule.expression)).toEqual(['api-0-prod.anycloud.sh']);
    const pulls = cf.calls.indexOf(
      'PUT /zones/zone-1/origin_tls_client_auth/hostnames',
    );
    expect(cf.bodies[pulls]).toEqual({
      config: [{ hostname: HOST, cert_id: 'aop-1', enabled: null }],
    });
    expect(cf.live()).toEqual(['wide']);
  });

  it('finishes a teardown whose DNS record is already gone', async () => {
    cf.records = [];
    const res = await worker.fetch(
      call('DELETE', `/v1/api-tls?subdomain=${SUBDOMAIN}`),
      env(),
    );
    expect(await res.json()).toEqual({ revoked: 1 });
  });

  it('refuses another user', async () => {
    cf.records = [{ id: 'rec-1', type: 'A', name: HOST, comment: 'someone' }];
    const res = await worker.fetch(
      call('DELETE', `/v1/api-tls?subdomain=${SUBDOMAIN}`),
      env(CONFIGURED),
    );
    expect(res.status).toBe(403);
    expect(cf.live()).toContain('old');
  });
});

describe('bridge rule host list', () => {
  it('is idempotent and renders an empty list that matches nothing', async () => {
    const configured = env(CONFIGURED);
    const add = () =>
      worker.fetch(
        call('POST', '/v1/api-tls/activate', { subdomain: SUBDOMAIN }),
        configured,
      );
    await add();
    await add();
    expect(
      cf.calls.filter((c) => c.startsWith('PATCH /zones/zone-1/rulesets')),
    ).toHaveLength(1);

    cf.rule.expression = bridgeExpression([HOST]);
    await worker.fetch(
      call('DELETE', `/v1/api-tls?subdomain=${SUBDOMAIN}`),
      configured,
    );
    expect(cf.rule.expression).toBe('(http.host eq "")');
    expect(bridgeHosts(cf.rule.expression)).toEqual([]);
  });

  it('serializes concurrent edits so none is lost', async () => {
    cf.readDelayMs = 5;
    const configured = env(CONFIGURED);
    const subdomains = ['api-a', 'api-b', 'api-c'];
    await Promise.all([
      ...subdomains.map((subdomain) =>
        worker.fetch(
          call('POST', '/v1/api-tls/activate', { subdomain }),
          configured,
        ),
      ),
      worker.fetch(
        call('DELETE', '/v1/api-tls?subdomain=api-0-prod'),
        configured,
      ),
    ]);
    expect(bridgeHosts(cf.rule.expression)).toEqual(
      subdomains.map((subdomain) => `${subdomain}.anycloud.sh`),
    );
  });
});

describe('review fixes', () => {
  const issue = () =>
    worker.fetch(
      call('POST', '/v1/api-tls/certificates', {
        subdomain: SUBDOMAIN,
        csr: csr([{ type: 2, value: HOST }]),
      }),
      env(),
    );

  it('refuses with 409 and revokes its own certificate when an overlapping issuance is newer', async () => {
    // An overlapping issuance for the same hostname finished later.
    cf.certificates.push({
      id: 'later',
      hostnames: [HOST],
      certificate: 'LATER',
      expires_on: '2041-10-09T12:05:00Z',
    });
    const res = await issue();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /newer certificate .* retry/,
    );
    expect(cf.live()).toEqual(['wide', 'later']);
  });

  it('refuses an unrecognized expiry rather than skipping revocation', async () => {
    cf.nextExpiry = 'not a date';
    await expect(
      revokeCertificates(env(), HOST, {
        id: 'new',
        certificate: 'NEW',
        hostnames: [HOST],
        expires_on: 'not a date',
      }),
    ).rejects.toThrow('unrecognized Origin CA expires_on: not a date');
  });

  it('skips revoked certificates and treats an already-revoked one as done', async () => {
    cf.certificates.push({
      id: 'revoked',
      hostnames: [HOST],
      certificate: 'R',
      expires_on: '2039-01-01T00:00:00Z',
      revoked_at: '2026-01-01T00:00:00Z',
    });
    // A listing that lags a revocation: the Worker revokes it again.
    const stale = cf.fetch.getMockImplementation()!;
    cf.fetch.mockImplementation(async (input, init) => {
      const res = await stale(input, init);
      if (!String(input).includes('/certificates?')) return res;
      const body = (await res.json()) as { result: { revoked_at?: string }[] };
      return Response.json({
        result: body.result.map((cert) =>
          cert.revoked_at === '2026-01-01T00:00:00Z'
            ? cert
            : { ...cert, revoked_at: undefined },
        ),
      });
    });
    cf.certificates[0].revoked_at = '2026-10-01T00:00:00Z';
    const res = await worker.fetch(
      call('DELETE', `/v1/api-tls?subdomain=${SUBDOMAIN}`),
      env(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: 1 });
    expect(cf.calls).not.toContain('DELETE /certificates/revoked');
  });

  it('surfaces a token without Origin CA rights instead of reporting nothing revoked', async () => {
    cf.certificateListStatus = 403;
    const res = await worker.fetch(
      call('DELETE', `/v1/api-tls?subdomain=${SUBDOMAIN}`),
      env(),
    );
    expect(res.status).toBe(502);
    expect(cf.live()).toContain('old');
  });

  it('surfaces a refused revocation whose certificate is not revoked', async () => {
    cf.certificates.push({
      id: 'locked',
      hostnames: [HOST],
      certificate: 'L',
      expires_on: '2039-01-01T00:00:00Z',
    });
    const res = await worker.fetch(
      call('DELETE', `/v1/api-tls?subdomain=${SUBDOMAIN}`),
      env(),
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('cannot be revoked');
  });

  it.each([
    ['gone on re-read', 'vanished', 200, null],
    [
      'unreadable on re-read',
      'unreadable',
      502,
      /cannot be revoked.*re-reading it failed \(503\): read down/,
    ],
  ])(
    'a refused revocation whose certificate is %s',
    async (_label, id, status, message) => {
      cf.certificates.push({
        id,
        hostnames: [HOST],
        certificate: 'X',
        expires_on: '2039-01-01T00:00:00Z',
      });
      const res = await worker.fetch(
        call('DELETE', `/v1/api-tls?subdomain=${SUBDOMAIN}`),
        env(),
      );
      expect(res.status).toBe(status);
      if (message) expect(await res.text()).toMatch(message);
    },
  );

  it('voids origin pulls only for a hostname that has them', async () => {
    await worker.fetch(
      call('DELETE', `/v1/api-tls?subdomain=${SUBDOMAIN}`),
      env(CONFIGURED),
    );
    expect(cf.edits('PUT /zones/zone-1/origin_tls_client_auth')).toBe(0);
  });

  it.each(['CNAME', 'AAAA'])(
    "refuses TLS teardown when a %s record for the hostname is not the caller's",
    async (type) => {
      cf.records = [{ id: 'rec-9', type, name: HOST, comment: 'anycloud' }];
      for (const [method, path, body] of [
        ['DELETE', `/v1/api-tls?subdomain=${SUBDOMAIN}`, undefined],
        ['POST', '/v1/api-tls/activate', { subdomain: SUBDOMAIN }],
      ] as const) {
        const res = await worker.fetch(
          call(method, path, body),
          env(CONFIGURED),
        );
        expect(res.status).toBe(403);
      }
      expect(cf.live()).toContain('old');
    },
  );

  it('revokes certificates when the last record is deleted by subdomain', async () => {
    const res = await worker.fetch(
      call('DELETE', `/v1/dns-records?subdomain=${SUBDOMAIN}`),
      env(),
    );
    expect(await res.json()).toEqual({ deleted: 1 });
    expect(cf.live()).toEqual(['wide']);
    // Revocation precedes the deletion, so a failed revoke can be retried.
    expect(cf.calls.indexOf('DELETE /certificates/old')).toBeLessThan(
      cf.calls.indexOf('DELETE /zones/zone-1/dns_records/rec-1'),
    );
  });

  it('revokes certificates when the last record is deleted by id', async () => {
    await worker.fetch(call('DELETE', '/v1/dns-records/rec-1'), env());
    expect(cf.live()).toEqual(['wide']);
  });

  it('keeps certificates while another record still holds the hostname', async () => {
    cf.records.push({
      id: 'rec-9',
      type: 'AAAA',
      name: HOST,
      comment: 'anycloud',
    });
    await worker.fetch(
      call('DELETE', `/v1/dns-records?subdomain=${SUBDOMAIN}`),
      env(),
    );
    expect(cf.live()).toContain('old');
  });

  it("revokes a previous owner's certificates when a new owner claims the name", async () => {
    cf.records = [];
    const res = await worker.fetch(
      call('POST', '/v1/dns-records', { subdomain: SUBDOMAIN, ip: '1.2.3.4' }),
      env(),
    );
    expect(res.status).toBe(200);
    expect(cf.live()).toEqual(['wide']);
  });

  it('refuses activation of a full rule before changing anything', async () => {
    // Just under the cap, so that adding HOST is what crosses it.
    const hosts: string[] = [];
    for (let i = 0; ; i++) {
      const next = `api-${i}-xxxx.anycloud.sh`;
      if (bridgeExpression([...hosts, next]).length > MAX_EXPRESSION_LENGTH)
        break;
      hosts.push(next);
    }
    cf.rule.expression = bridgeExpression(hosts);
    expect(cf.rule.expression.length).toBeLessThanOrEqual(
      MAX_EXPRESSION_LENGTH,
    );
    expect(bridgeExpression([...hosts, HOST].sort()).length).toBeGreaterThan(
      MAX_EXPRESSION_LENGTH,
    );
    const res = await worker.fetch(
      call('POST', '/v1/api-tls/activate', { subdomain: SUBDOMAIN }),
      env(CONFIGURED),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(
      new RegExp(`bridge rule is full \\(${hosts.length} hostnames`),
    );
    expect(cf.originPulls.size).toBe(0);
    expect(cf.edits('PATCH')).toBe(0);
  });

  it('voids the origin pulls it enabled when the rule edit fails', async () => {
    cf.ruleEditStatus = 500;
    const res = await worker.fetch(
      call('POST', '/v1/api-tls/activate', { subdomain: SUBDOMAIN }),
      env(CONFIGURED),
    );
    expect(res.status).toBe(502);
    expect(cf.originPulls.get(HOST)).toBeNull();
    expect(cf.rule.expression).not.toContain(HOST);
  });

  it('re-activates a listed hostname without editing the rule', async () => {
    cf.rule.expression = bridgeExpression([HOST]);
    const res = await worker.fetch(
      call('POST', '/v1/api-tls/activate', { subdomain: SUBDOMAIN }),
      env(CONFIGURED),
    );
    expect(await res.json()).toEqual({ strict: true, originPulls: true });
    expect(cf.edits('PATCH')).toBe(0);
    expect(cf.originPulls.get(HOST)).toBe(true);
  });
});

describe('the management VM’s bootstrap TLS (RFC 0049 C26 (e))', () => {
  const VM = '203.0.113.7';
  const pem = () => csr([{ type: 2, value: HOST }]);
  /** As the CLI publishes: the record with the bootstrap marker. */
  async function published(e: Env, bootstrap = true) {
    cf.records = [];
    const res = await worker.fetch(
      call('POST', '/v1/dns-records', {
        subdomain: SUBDOMAIN,
        ip: VM,
        bootstrap,
      }),
      e,
    );
    expect(res.status).toBe(200);
  }
  /** As the VM asks: no token, from an address Cloudflare reports. */
  const fromVm = (path: string, body: object, ip = VM) =>
    new Request(`https://dns.anycloud.sh${path}`, {
      method: 'POST',
      headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('signs the VM’s CSR from the A record’s address, then activates Full (strict) and closes both routes', async () => {
    const e = env(CONFIGURED);
    await published(e);
    const issued = await worker.fetch(
      fromVm('/v1/api-tls/bootstrap/certificates', {
        subdomain: SUBDOMAIN,
        csr: pem(),
      }),
      e,
    );
    expect(issued.status).toBe(200);
    expect(await issued.json()).toEqual({
      certificate: 'NEW',
      originPullCa: 'CA PEM',
    });
    const activated = await worker.fetch(
      fromVm('/v1/api-tls/bootstrap/activate', { subdomain: SUBDOMAIN }),
      e,
    );
    expect(await activated.json()).toEqual({ strict: true, originPulls: true });
    for (const path of [
      '/v1/api-tls/bootstrap/certificates',
      '/v1/api-tls/bootstrap/activate',
    ]) {
      const again = await worker.fetch(
        fromVm(path, { subdomain: SUBDOMAIN, csr: pem() }),
        e,
      );
      expect(again.status).toBe(403);
    }
  });

  it.each([
    ['another address', () => '198.51.100.9'],
    ['no address', () => ''],
  ])('refuses a request from %s', async (_label, ip) => {
    const e = env(CONFIGURED);
    await published(e);
    const res = await worker.fetch(
      fromVm(
        '/v1/api-tls/bootstrap/certificates',
        { subdomain: SUBDOMAIN, csr: pem() },
        ip(),
      ),
      e,
    );
    expect(res.status).toBe(403);
    expect(cf.calls).not.toContain('POST /certificates');
  });

  it('refuses a hostname published without the marker, re-pointed since, or never published', async () => {
    const plain = env(CONFIGURED);
    await published(plain, false);
    const repointed = env(CONFIGURED);
    await published(repointed);
    cf.records = cf.records.map((r) => ({ ...r, content: '198.51.100.9' }));
    for (const e of [plain, repointed, env(CONFIGURED)]) {
      const res = await worker.fetch(
        fromVm('/v1/api-tls/bootstrap/certificates', {
          subdomain: SUBDOMAIN,
          csr: pem(),
        }),
        e,
      );
      expect(res.status).toBe(403);
    }
    expect(cf.calls).not.toContain('POST /certificates');
  });

  it('refuses a CSR for another hostname, and a hostname certified to another account', async () => {
    const e = env(CONFIGURED);
    await published(e);
    const other = await worker.fetch(
      fromVm('/v1/api-tls/bootstrap/certificates', {
        subdomain: SUBDOMAIN,
        csr: csr([{ type: 2, value: 'other.anycloud.sh' }]),
      }),
      e,
    );
    expect(other.status).toBe(400);
    // Account 2 owned the hostname's certificates before.
    await e.CERTIFICATE_OWNER.get(
      e.CERTIFICATE_OWNER.idFromName(SUBDOMAIN),
    ).fetch('https://certificate-owner/', {
      method: 'PUT',
      body: JSON.stringify({ userId: 2 }),
    });
    cf.user = { login: 'owner', id: 1 };
    const claimed = await worker.fetch(
      fromVm('/v1/api-tls/bootstrap/certificates', {
        subdomain: SUBDOMAIN,
        csr: pem(),
      }),
      e,
    );
    expect(claimed.status).toBe(409);
    expect(cf.calls).not.toContain('POST /certificates');
  });

  it('forgets the marker when the hostname is deleted', async () => {
    const e = env(CONFIGURED);
    await published(e);
    const deleted = await worker.fetch(
      call('DELETE', `/v1/dns-records?subdomain=${SUBDOMAIN}`),
      e,
    );
    expect(deleted.status).toBe(200);
    cf.records = [
      { id: 'rec-9', type: 'A', name: HOST, comment: 'owner', content: VM },
    ];
    const res = await worker.fetch(
      fromVm('/v1/api-tls/bootstrap/certificates', {
        subdomain: SUBDOMAIN,
        csr: pem(),
      }),
      e,
    );
    expect(res.status).toBe(403);
  });

  it('asks Cloudflare nothing for a hostname not awaiting bootstrap from that address', async () => {
    const e = env(CONFIGURED);
    await published(e);
    cf.calls.length = 0;
    for (const ip of ['198.51.100.9', '']) {
      const res = await worker.fetch(
        fromVm(
          '/v1/api-tls/bootstrap/certificates',
          { subdomain: SUBDOMAIN, csr: pem() },
          ip,
        ),
        e,
      );
      expect(res.status).toBe(403);
    }
    const unpublished = await worker.fetch(
      fromVm('/v1/api-tls/bootstrap/certificates', {
        subdomain: 'other-1-abcd',
        csr: pem(),
      }),
      e,
    );
    expect(unpublished.status).toBe(403);
    expect(cf.calls).toEqual([]);
    const garbled = await worker.fetch(
      new Request('https://dns.anycloud.sh/v1/api-tls/bootstrap/certificates', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': VM },
        body: '{',
      }),
      e,
    );
    expect(garbled.status).toBe(400);
    const nothing = await worker.fetch(
      new Request('https://dns.anycloud.sh/v1/api-tls/bootstrap/certificates', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': VM },
        body: 'null',
      }),
      e,
    );
    expect(nothing.status).toBe(400);
  });

  it('ends a bootstrap nobody finished once it expires', async () => {
    const e = env(CONFIGURED);
    await published(e);
    vi.useFakeTimers({ now: Date.now() + 3 * 60 * 60_000, toFake: ['Date'] });
    try {
      const res = await worker.fetch(
        fromVm('/v1/api-tls/bootstrap/certificates', {
          subdomain: SUBDOMAIN,
          csr: pem(),
        }),
        e,
      );
      expect(res.status).toBe(403);
      expect(cf.calls).not.toContain('POST /certificates');
    } finally {
      vi.useRealTimers();
    }
  });
});
