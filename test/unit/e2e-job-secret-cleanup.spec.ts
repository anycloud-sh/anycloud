import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { ApiClient } from '../integration/e2e/internal/api.js';
import {
  ArtifactStore,
  Redactor,
} from '../integration/e2e/internal/artifacts.js';
import { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import { SecretManager } from '../integration/e2e/internal/secrets.js';

describe('named secret cleanup readback', () => {
  test.each([
    { label: 'absent', status: 200, body: [], success: true },
    {
      label: 'still present',
      status: 200,
      body: [{ name: 'job-owned', createdAt: 1, updatedAt: 1 }],
      success: false,
    },
    { label: 'authentication failure', status: 401, body: {}, success: false },
    {
      label: 'malformed inventory',
      status: 200,
      body: { secrets: [] },
      success: false,
    },
    {
      label: 'secret-bearing malformed response',
      status: 200,
      body: [
        {
          name: 'job-owned',
          createdAt: 1,
          updatedAt: 1,
          value: 'private-job-value',
        },
      ],
      success: false,
    },
  ])(
    'requires independent absence after delete: $label',
    async ({ status, body, success }) => {
      const directory = await mkdtemp(path.join(tmpdir(), 'job-secret-'));
      const requests: string[] = [];
      const server = createServer((request, response) => {
        requests.push(`${request.method ?? ''} ${request.url ?? ''}`);
        response.setHeader('Content-Type', 'application/json');
        if (request.method === 'GET') {
          response.statusCode = status;
          response.end(JSON.stringify(body));
        } else {
          response.statusCode = 204;
          response.end();
        }
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      try {
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('Test API address missing');
        const redactor = new Redactor();
        const artifacts = new ArtifactStore(directory, redactor);
        const api = new ApiClient(
          `http://127.0.0.1:${address.port}`,
          'test-token',
          artifacts,
          redactor,
        );
        const cleanup = new CleanupStack();
        const secrets = new SecretManager(api, cleanup, api);
        await secrets.create('job-owned', { JOB_VALUE: 'private-job-value' });
        if (success) await secrets.delete('job-owned');
        else await expect(secrets.delete('job-owned')).rejects.toThrow();
        expect(cleanup.observations()[0].completed).toBe(success);
        expect(requests).toEqual([
          'PUT /v1/secrets/job-owned',
          'DELETE /v1/secrets/job-owned?force=true',
          'GET /v1/secrets',
        ]);
        const recorded = (
          await Promise.all(
            (await readdir(directory)).map((file) =>
              readFile(path.join(directory, file), 'utf8'),
            ),
          )
        ).join('\n');
        expect(recorded).not.toContain('private-job-value');
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
