import { writeFile } from 'fs/promises';
import { createServer as createHttpsServer } from 'https';
import type { AddressInfo } from 'net';
import { join } from 'path';
import forge from 'node-forge';

import { AZURE_EXPIRED_CLIENT_SECRET } from '../credentials-onboarding/personas.js';
import { readRequestBody, respondJson, respondUnhandled } from './support.js';

export interface FakeAzureAuthority {
  url: string;
  /** PEM path for NODE_EXTRA_CA_CERTS in the spawned API's environment. */
  certificatePath: string;
  calls: string[];
  close: () => Promise<void>;
}

/**
 * Fake Entra authority over HTTPS (MSAL refuses plain HTTP): serves OIDC
 * discovery and a token endpoint that rejects the client-credentials grant
 * with the expired-secret dialect. Deploy-time Azure validation dies at the
 * token, so no ARM surface is served — an ARM request would mean the token
 * unexpectedly succeeded, and fails loudly.
 */
export async function startFakeAzureAuthority(
  directory: string,
  /** The only client-credential pair the token endpoint acknowledges. */
  expected: { clientId: string; clientSecret: string },
): Promise<FakeAzureAuthority> {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1_000);
  certificate.setSubject([{ name: 'commonName', value: '127.0.0.1' }]);
  certificate.setIssuer([{ name: 'commonName', value: '127.0.0.1' }]);
  certificate.setExtensions([
    { name: 'basicConstraints', cA: true },
    {
      name: 'keyUsage',
      keyCertSign: true,
      digitalSignature: true,
      keyEncipherment: true,
    },
    { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
  ]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  const certificatePem = forge.pki.certificateToPem(certificate);
  const certificatePath = join(directory, 'fake-azure-authority-ca.pem');
  await writeFile(certificatePath, certificatePem, { mode: 0o600 });

  const calls: string[] = [];
  let baseUrl = '';
  const server = createHttpsServer(
    { key: forge.pki.privateKeyToPem(keys.privateKey), cert: certificatePem },
    (request, response) => {
      const url = new URL(request.url ?? '/', 'https://127.0.0.1');
      calls.push(`${request.method} ${url.pathname}`);
      const handle = async (): Promise<void> => {
        if (
          request.method === 'GET' &&
          url.pathname.endsWith('/v2.0/.well-known/openid-configuration')
        ) {
          const tenant = url.pathname.split('/')[1];
          respondJson(response, 200, {
            issuer: `${baseUrl}/${tenant}/v2.0`,
            token_endpoint: `${baseUrl}/${tenant}/oauth2/v2.0/token`,
            authorization_endpoint: `${baseUrl}/${tenant}/oauth2/v2.0/authorize`,
            jwks_uri: `${baseUrl}/${tenant}/discovery/v2.0/keys`,
          });
          return;
        }
        if (
          request.method === AZURE_EXPIRED_CLIENT_SECRET.method &&
          url.pathname.endsWith(AZURE_EXPIRED_CLIENT_SECRET.pathSuffix)
        ) {
          const body = new URLSearchParams(await readRequestBody(request));
          if (
            body.get('client_id') !== expected.clientId ||
            body.get('client_secret') !== expected.clientSecret
          ) {
            respondUnhandled(
              response,
              'Token request without the pinned client credentials',
            );
            return;
          }
          respondJson(
            response,
            AZURE_EXPIRED_CLIENT_SECRET.httpStatus,
            AZURE_EXPIRED_CLIENT_SECRET.body,
          );
          return;
        }
        respondUnhandled(response, `Azure ${request.method} ${url.pathname}`);
      };
      void handle().catch((error) => {
        respondUnhandled(response, (error as Error).message);
      });
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  baseUrl = `https://127.0.0.1:${address.port}`;
  return {
    url: baseUrl,
    certificatePath,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}
