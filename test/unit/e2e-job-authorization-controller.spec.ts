import { createHash } from 'node:crypto';
import { createServer, type RequestListener } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { CloudType } from '../../src/shared/cloud.js';
import { ApiClient } from '../integration/e2e/internal/api.js';
import { ControllerEndpoint } from '../integration/e2e/internal/controller-session.js';
import {
  ArtifactStore,
  Redactor,
} from '../integration/e2e/internal/artifacts.js';

const material = {
  name: 'job-owned',
  cloudProvider: CloudType.AWS,
  accessKeyId: 'new-access-id',
  secretAccessKey: 'newly-issued-private-value',
} as const;

const absent = (name: string = material.name) => ({
  defined: true,
  code: 'CREDENTIAL_NOT_FOUND',
  status: 404,
  message: 'Credential not found',
  data: { name },
});

async function withApi(
  listener: RequestListener,
  use: (world: {
    api: ApiClient;
    redactor: Redactor;
    artifacts: ArtifactStore;
    readArtifacts: () => Promise<string>;
    url: string;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'job-credential-api-'));
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Test API address missing');
    const redactor = new Redactor();
    const artifacts = new ArtifactStore(directory, redactor);
    const url = `http://127.0.0.1:${address.port}`;
    await use({
      api: new ApiClient(url, 'test-token', artifacts, redactor),
      redactor,
      artifacts,
      url,
      readArtifacts: async () =>
        (
          await Promise.all(
            (await readdir(directory)).map((name) =>
              readFile(path.join(directory, name), 'utf8'),
            ),
          )
        ).join('\n'),
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
}

import { JobAuthorization } from '../integration/e2e/internal/job-authorization.js';
import { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import { JobPrivateCommands } from '../integration/e2e/internal/transports/job-command.js';

describe('Job authorization controller lifetime', () => {
  test('retains ownership without deleting from a new controller incarnation at the same URL', async () => {
    const name = 'lambda-test';
    const borrowed = {
      cloudProvider: CloudType.Lambda,
      apiKey: 'offline-review-token',
    } as const;
    const recordId = createHash('sha256')
      .update(JSON.stringify(borrowed))
      .digest('hex');
    let present = false;
    const mutations: Array<{ method: string; generation: number }> = [];
    let endpoint: ControllerEndpoint;
    await withApi(
      (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        if (request.method === 'PUT') {
          present = true;
          mutations.push({
            method: 'PUT',
            generation: endpoint.snapshot()!.generation,
          });
          response.statusCode = 204;
          response.end();
        } else if (request.method === 'DELETE') {
          mutations.push({
            method: 'DELETE',
            generation: endpoint.snapshot()!.generation,
          });
          present = false;
          response.statusCode = 204;
          response.end();
        } else if (request.url === `/v1/credentials/${name}`) {
          response.statusCode = present ? 200 : 404;
          response.end(
            JSON.stringify(
              present
                ? { name, cloudProvider: CloudType.Lambda }
                : absent(name),
            ),
          );
        } else
          response.end(
            JSON.stringify(
              present ? [{ name, cloudProvider: CloudType.Lambda }] : [],
            ),
          );
      },
      async ({ url, artifacts, redactor }) => {
        endpoint = new ControllerEndpoint();
        endpoint.attach(url);
        const api = new ApiClient(
          endpoint,
          'offline-token',
          artifacts,
          redactor,
        );
        const database = {
          queryComplete: async () =>
            present
              ? [{ id: recordId, name, cloud_provider: CloudType.Lambda }]
              : [],
        };
        const commands = new JobPrivateCommands(
          {
            run: async () => {
              throw new Error('no native commands allowed');
            },
          },
          new AbortController().signal,
        );
        const cleanup = new CleanupStack();
        const authorization = new JobAuthorization(
          {
            api,
            cleanupApi: api,
            database,
            cleanupDatabase: database,
            commands,
            cleanupCommands: commands,
            cleanup,
            cli: {
              run: async () => {
                throw new Error('no CLI allowed');
              },
            },
            artifacts,
            redactor,
            files: {
              directory: async () => '/unused',
              privateText: async () => '/unused',
              remove: async () => undefined,
            },
          },
          {
            name,
            profile: {
              slug: 'lambda',
              provider: CloudType.Lambda,
              credentialName: name,
              credential: borrowed,
              vmTypes: ['cpu_4x_general'],
            },
            mode: 'bootstrap',
            cleanupMs: 30000,
            dependentsAbsent: () => undefined,
          },
        );
        const binding = await authorization.create(Date.now() + 10000);
        endpoint.detach();
        endpoint.attach(url);
        // A restarted/replaced controller has a matching hash and material, while
        // the owner is still bound to the first incarnation's acknowledged import.
        expect(endpoint.snapshot()!.generation).toBe(2);
        await expect(
          authorization.release(binding, Date.now() + 10000),
        ).rejects.toThrow('original API endpoint or generation');
        expect(mutations).toEqual([{ method: 'PUT', generation: 1 }]);
        expect(present).toBe(true);
        expect(cleanup.observations()[0].completed).toBe(false);
      },
    );
  });
});
