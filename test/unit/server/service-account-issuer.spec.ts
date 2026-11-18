import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { KubeConfig } from '@kubernetes/client-node';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../../../src/api/server.js';
import { createServiceAccountIssuerDocuments } from '../../../src/api/services/kubernetes/service-account-issuer.js';
import { createRoleSetupDocuments } from '../../../src/api/services/role-connection-setup-templates.js';
import { testAuthenticate } from '../../helpers/test-authentication.js';

const ISSUER = 'https://c-1.anycloud.sh';
const DISCOVERY = {
  issuer: ISSUER,
  jwks_uri: `${ISSUER}/openid/v1/jwks`,
  response_types_supported: ['id_token'],
  subject_types_supported: ['public'],
  id_token_signing_alg_values_supported: ['RS256'],
};
const JWKS = {
  keys: [
    { use: 'sig', kty: 'RSA', kid: 'k1', alg: 'RS256', n: 'AQ', e: 'AQAB' },
  ],
};

const listeners: Server[] = [];
afterEach(async () => {
  await Promise.all(
    listeners
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

async function listen(server: Server): Promise<string> {
  listeners.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A Kubernetes API answering as kube-apiserver does, with its content types. */
async function kubernetes(keys: () => object): Promise<KubeConfig> {
  const server = await listen(
    createServer((req, res) => {
      if (req.url === '/.well-known/openid-configuration') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(DISCOVERY));
      } else if (req.url === '/openid/v1/jwks') {
        res.setHeader('Content-Type', 'application/jwk-set+json');
        res.end(JSON.stringify(keys()));
      } else {
        res.statusCode = 404;
        res.end();
      }
    }),
  );
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromOptions({
    clusters: [{ name: 'c', server, skipTLSVerify: true }],
    users: [{ name: 'u' }],
    contexts: [{ name: 'x', cluster: 'c', user: 'u' }],
    currentContext: 'x',
  });
  return kubeConfig;
}

it("serves the cluster's discovery document and current JWKS without authentication or caching", async () => {
  let keys: object = JWKS;
  const api = await listen(
    createServer(
      createApp({
        authenticate: testAuthenticate,
        serviceAccountIssuer: createServiceAccountIssuerDocuments(
          await kubernetes(() => keys),
        ),
      }),
    ),
  );

  const discovery = await fetch(`${api}/.well-known/openid-configuration`);
  expect(discovery.status).toBe(200);
  expect(discovery.headers.get('content-type')).toMatch(/^application\/json/);
  expect(discovery.headers.get('cache-control')).toBe('no-store');
  expect(await discovery.json()).toEqual(DISCOVERY);

  const jwks = await fetch(`${api}/openid/v1/jwks`);
  expect(jwks.headers.get('content-type')).toMatch(
    /^application\/jwk-set\+json/,
  );
  expect(jwks.headers.get('cache-control')).toBe('no-store');
  expect(await jwks.json()).toEqual(JWKS);

  // A rotated key is served on the next read.
  keys = { keys: [{ ...JWKS.keys[0], kid: 'k2' }] };
  expect(await (await fetch(`${api}/openid/v1/jwks`)).json()).toEqual(keys);
});

it('fails without a document when the cluster does not answer, and serves nothing on a local API', async () => {
  const unreachable = new KubeConfig();
  unreachable.loadFromOptions({
    clusters: [
      { name: 'c', server: 'http://127.0.0.1:1', skipTLSVerify: true },
    ],
    users: [{ name: 'u' }],
    contexts: [{ name: 'x', cluster: 'c', user: 'u' }],
    currentContext: 'x',
  });
  const hosted = await listen(
    createServer(
      createApp({
        authenticate: testAuthenticate,
        serviceAccountIssuer: createServiceAccountIssuerDocuments(unreachable),
      }),
    ),
  );
  expect((await fetch(`${hosted}/openid/v1/jwks`)).status).toBe(500);

  const local = await listen(
    createServer(createApp({ authenticate: testAuthenticate })),
  );
  expect(
    (await fetch(`${local}/.well-known/openid-configuration`)).status,
  ).toBe(404);
});

it("serves each cloud's role setup template trusting the issuer the cluster reports", async () => {
  const issuer = createServiceAccountIssuerDocuments(
    await kubernetes(() => JWKS),
  );
  const thumbprinted: string[] = [];
  const api = await listen(
    createServer(
      createApp({
        authenticate: testAuthenticate,
        serviceAccountIssuer: issuer,
        roleSetup: createRoleSetupDocuments({
          issuer,
          subject: 'system:serviceaccount:anycloud-system:anycloud-api',
          thumbprint: async (host) => {
            thumbprinted.push(host);
            return 'b'.repeat(40);
          },
        }),
      }),
    ),
  );

  for (const [path, contentType] of [
    ['/role-setup/aws.json', /^application\/json/],
    ['/role-setup/gcp.sh', /^text\/x-shellscript/],
    ['/role-setup/azure.json', /^application\/json/],
  ] as const) {
    const response = await fetch(`${api}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(contentType);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain(ISSUER);
  }
  expect(thumbprinted).toEqual([ISSUER]);

  const local = await listen(
    createServer(createApp({ authenticate: testAuthenticate })),
  );
  expect((await fetch(`${local}/role-setup/aws.json`)).status).toBe(404);
});
