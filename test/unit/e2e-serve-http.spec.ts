import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, onTestFinished, test } from 'vitest';

import { CloudType } from '../../src/shared/cloud.js';
import {
  ArtifactStore,
  Redactor,
} from '../integration/e2e/internal/artifacts.js';
import { TargetHttpClient } from '../integration/e2e/internal/transports/http.js';
import { PublicCloudServeTransport } from '../integration/e2e/internal/transports/public-cloud-serve.js';

function endpointTransport(directory: string): PublicCloudServeTransport {
  const redactor = new Redactor();
  const artifacts = new ArtifactStore(directory, redactor);
  const http = new TargetHttpClient(artifacts, redactor);
  return new PublicCloudServeTransport({
    credentials: {
      save: async () => {
        throw new Error('Unexpected credential mutation');
      },
    },
    dns: {
      observe: async () => {
        throw new Error('Unexpected DNS observation');
      },
    },
    presence: {
      observe: async () => {
        throw new Error('Unexpected native observation');
      },
    },
    profile: {
      slug: 'aws',
      provider: CloudType.AWS,
      credentialName: 'unit',
      credential: {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'unused',
        secretAccessKey: 'unused',
      },
      vmTypes: ['g6e.xlarge'],
    },
    http,
  });
}

describe('Service endpoint response identity', () => {
  test.each([200, 301, 302, 307, 308])(
    'accepts only a direct success (HTTP %i)',
    async (status) => {
      const directory = await mkdtemp(path.join(tmpdir(), 'service-http-'));
      const requests: string[] = [];
      const body = 'marker\nGPU 0: Test A10 (UUID: GPU-test)\n';
      const server = createServer((request, response) => {
        requests.push(request.url ?? '');
        if (request.url === '/service' && status !== 200) {
          response.writeHead(status, { Location: '/foreign' });
          response.end('redirect');
        } else {
          response.writeHead(200, { 'Content-Type': 'text/plain' });
          response.end(body);
        }
      });
      onTestFinished(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(directory, { force: true, recursive: true });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('No loopback server');
      const transport = endpointTransport(directory);
      const observed = await transport.observeEndpoint(
        `http://127.0.0.1:${String(address.port)}/service`,
      );
      expect(observed).toEqual(
        status === 200
          ? { statusCode: 200, responseBody: body }
          : {
              error: 'aws-serve-endpoint rejected an HTTP redirect',
              statusCode: 0,
              responseBody: '',
            },
      );
      expect(requests).toEqual(['/service']);
    },
  );

  test("records a failure's status, body and edge headers in its artifact", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'target-http-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const server = createServer((_request, response) => {
      response.writeHead(500, { server: 'cloudflare', 'cf-ray': 'ray-1' });
      response.end('origin unreachable');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    onTestFinished(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const { port } = server.address() as { port: number };
    const redactor = new Redactor();
    const http = new TargetHttpClient(
      new ArtifactStore(directory, redactor),
      redactor,
    );
    await expect(
      http.get(
        'hosted-api-version',
        new URL(`http://127.0.0.1:${port}/v1/version`),
      ),
    ).resolves.toMatchObject({ status: 500 });
    const [artifact] = (await readdir(directory)).filter((name) =>
      name.endsWith('hosted-api-version.json'),
    );
    expect(
      JSON.parse(await readFile(path.join(directory, artifact!), 'utf8')),
    ).toMatchObject({
      status: 500,
      server: 'cloudflare',
      cfRay: 'ray-1',
      body: 'origin unreachable',
    });
  });

  test('records why no HTTP answer reached the probe', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'service-http-'));
    onTestFinished(() => rm(directory, { force: true, recursive: true }));
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No loopback server');
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await expect(
      endpointTransport(directory).observeEndpoint(
        `http://127.0.0.1:${String(address.port)}/service`,
      ),
    ).resolves.toEqual({
      error: 'aws-serve-endpoint request failed: fetch failed (ECONNREFUSED)',
      responseBody: '',
      statusCode: 0,
    });
  });
});
