import { createServer, type RequestListener } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
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
/** What the API returns for a credential: never its secret. */
const redacted = {
  name: material.name,
  cloudProvider: material.cloudProvider,
  accessKeyId: material.accessKeyId,
} as const;
const isReadback = (url: string | undefined) =>
  url === `/v1/credentials/${material.name}`;

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

describe('Job exact bucket API ownership readbacks', () => {
  test.each([
    {
      label: 'exact presence',
      status: 200,
      body: { name: 'job-bucket' },
      presence: 'present',
    },
    {
      label: 'declared absence',
      status: 404,
      body: {
        defined: true,
        code: 'BUCKET_NOT_FOUND',
        status: 404,
        message: 'Bucket not found',
      },
      presence: 'absent',
    },
    {
      label: 'generic 404',
      status: 404,
      body: { message: 'unvalidated-private-detail' },
      presence: undefined,
    },
    {
      label: 'credential absence',
      status: 404,
      body: absent(),
      presence: undefined,
    },
    {
      label: 'foreign bucket',
      status: 200,
      body: { name: 'another-bucket' },
      presence: undefined,
    },
    {
      label: 'unknown fields',
      status: 200,
      body: { name: 'job-bucket', debug: 'unvalidated-private-detail' },
      presence: undefined,
    },
    {
      label: 'authentication failure',
      status: 403,
      body: { message: 'unvalidated-private-detail' },
      presence: undefined,
    },
  ])(
    '$label retains its exact bucket, credential and region binding',
    async ({ status, body, presence }) => {
      let requested = '';
      await withApi(
        (request, response) => {
          requested = request.url ?? '';
          response.writeHead(status, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(body));
        },
        async ({ api, url, readArtifacts }) => {
          const observation = api.bucketPresence(
            'job-bucket',
            material.name,
            'us-east-1',
            Date.now() + 5_000,
          );
          if (presence)
            await expect(observation).resolves.toMatchObject({
              name: 'job-bucket',
              credentialName: material.name,
              region: 'us-east-1',
              presence,
              controller: { url },
            });
          else await expect(observation).rejects.toThrow('exact presence');
          expect(requested).toContain(
            `/credentials/${material.name}/buckets/job-bucket`,
          );
          expect(requested).toContain('region=us-east-1');
          expect(await readArtifacts()).not.toContain(
            'unvalidated-private-detail',
          );
        },
      );
    },
  );

  test.each([
    {
      label: 'a declared denial',
      status: 403,
      body: {
        defined: true,
        code: 'BUCKET_ACCESS_DENIED',
        status: 403,
        message:
          'Access denied: credential "job-owned" cannot check bucket job-bucket',
      },
      deadlineMs: 5_000,
      failure: {
        code: 'BUCKET_ACCESS_DENIED',
        status: 403,
        defined: true,
        message:
          'Access denied: credential "job-owned" cannot check bucket job-bucket',
      },
    },
    {
      label: 'an undeclared error',
      status: 400,
      body: {
        defined: false,
        code: 'BAD_REQUEST',
        status: 400,
        message: 'Bad request',
      },
      deadlineMs: 5_000,
      failure: { code: 'BAD_REQUEST', status: 400, defined: false },
    },
    {
      label: 'an expired harness deadline',
      status: 200,
      body: { name: 'job-bucket' },
      deadlineMs: -1,
      failure: {
        name: 'Error',
        message: 'API operation deadline expired or is invalid',
      },
    },
  ])(
    'records why an unknown presence failed for $label',
    async ({ status, body, deadlineMs, failure }) => {
      await withApi(
        (_request, response) => {
          response.writeHead(status, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(body));
        },
        async ({ api, readArtifacts }) => {
          await expect(
            api.bucketPresence(
              'job-bucket',
              material.name,
              'us-east-1',
              Date.now() + deadlineMs,
            ),
          ).rejects.toThrow('exact presence');
          expect(JSON.parse(await readArtifacts())).toMatchObject({
            presence: 'unknown',
            failure,
            elapsedMs: expect.any(Number),
            deadlineRemainingMs: expect.any(Number),
          });
        },
      );
    },
  );

  test('records the dropped connection behind a readback that ran out of time', async () => {
    let requests = 0;
    await withApi(
      (request) => {
        requests += 1;
        request.socket.destroy();
      },
      async ({ api, readArtifacts }) => {
        await expect(
          api.bucketPresence(
            'job-bucket',
            material.name,
            'us-east-1',
            Date.now() + 1_500,
          ),
        ).rejects.toThrow('exact presence');
        // The client retries a dropped connection as an API restart until
        // the deadline, so the call itself ends in a timeout.
        expect(requests).toBeGreaterThan(1);
        expect(JSON.parse(await readArtifacts())).toMatchObject({
          presence: 'unknown',
          failure: { name: 'TimeoutError' },
          lastTransportFailure: {
            name: 'TypeError',
            causeCode: 'UND_ERR_SOCKET',
          },
        });
      },
    );
  });

  test('does not attribute an earlier transport failure to a later readback', async () => {
    let drop = true;
    await withApi(
      (request, response) => {
        if (drop) {
          request.socket.destroy();
          return;
        }
        response.writeHead(403, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            defined: true,
            code: 'BUCKET_ACCESS_DENIED',
            status: 403,
            message: 'Access denied',
          }),
        );
      },
      async ({ api, readArtifacts }) => {
        await expect(
          api.bucketPresence(
            'job-bucket',
            material.name,
            'us-east-1',
            Date.now() + 700,
          ),
        ).rejects.toThrow('exact presence');
        drop = false;
        await expect(
          api.bucketPresence(
            'job-bucket',
            material.name,
            'us-east-1',
            Date.now() + 5_000,
          ),
        ).rejects.toThrow('exact presence');
        const artifacts = (await readArtifacts())
          .split(/\n(?=\{)/u)
          .map((text) => JSON.parse(text) as Record<string, unknown>);
        expect(artifacts[0]).toMatchObject({
          presence: 'unknown',
          lastTransportFailure: { causeCode: 'UND_ERR_SOCKET' },
        });
        const denied = artifacts.find(
          (artifact) =>
            (artifact.failure as { code?: string } | undefined)?.code ===
            'BUCKET_ACCESS_DENIED',
        );
        expect(denied).toBeDefined();
        expect(denied).not.toHaveProperty('lastTransportFailure');
      },
    );
  });

  test('does not join a bucket response across a same-URL controller replacement', async () => {
    let endpoint: ControllerEndpoint;
    await withApi(
      (_request, response) => {
        endpoint.attach(endpoint.snapshot()!.url);
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            defined: true,
            code: 'BUCKET_NOT_FOUND',
            status: 404,
            message: 'Bucket not found',
          }),
        );
      },
      async ({ url, redactor, artifacts }) => {
        endpoint = new ControllerEndpoint(url);
        const api = new ApiClient(endpoint, 'test-token', artifacts, redactor);
        await expect(
          api.bucketPresence(
            'job-bucket',
            material.name,
            'us-east-1',
            Date.now() + 5_000,
          ),
        ).rejects.toThrow('exact presence');
      },
    );
  });
});

describe('Job credential API ownership readbacks', () => {
  test.each(['read', 'list', 'delete', 'save'] as const)(
    'keeps an unknown private API diagnostic out of thrown %s errors and their causes',
    async (operation) => {
      const privateValue = 'unknown-api-private-diagnostic';
      await withApi(
        (_request, response) => {
          response.writeHead(500, { 'Content-Type': 'application/json' });
          response.end(
            JSON.stringify({
              defined: false,
              code: 'INTERNAL_SERVER_ERROR',
              status: 500,
              message: privateValue,
              data: { leaked: privateValue },
            }),
          );
        },
        async ({ api, readArtifacts }) => {
          const deadline = Date.now() + 5_000;
          const failure: unknown = await (
            operation === 'read'
              ? api.readCredential(material.name, deadline)
              : operation === 'list'
                ? api.listCredentials(deadline)
                : operation === 'delete'
                  ? api.deleteCredential(material.name, deadline)
                  : api.saveCredential(
                      material.name,
                      {
                        cloudProvider: material.cloudProvider,
                        accessKeyId: material.accessKeyId,
                        secretAccessKey: material.secretAccessKey,
                      },
                      { overwrite: false, deadlineAt: deadline },
                    )
          ).catch((error: unknown) => error);
          expect(failure).toBeInstanceOf(Error);
          expect(failure).not.toHaveProperty('cause');
          expect(inspect(failure, { depth: 10 })).not.toContain(privateValue);
          expect(await readArtifacts()).not.toContain(privateValue);
        },
      );
    },
  );

  test('retains deletion uncertainty when its controller is replaced at the same URL', async () => {
    let endpoint: ControllerEndpoint;
    const methods: string[] = [];
    await withApi(
      (request, response) => {
        methods.push(request.method ?? '');
        endpoint.attach(endpoint.snapshot()!.url);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ success: true }));
      },
      async ({ artifacts, redactor, url, readArtifacts }) => {
        endpoint = new ControllerEndpoint(url);
        const api = new ApiClient(endpoint, 'test-token', artifacts, redactor);
        await expect(
          api.deleteCredential(material.name, Date.now() + 5_000),
        ).rejects.toThrow('deletion failed');
        expect(methods).toEqual(['DELETE']);
        expect(await readArtifacts()).toContain('unknown');
        expect(await readArtifacts()).not.toContain('absent');
      },
    );
  });

  test('rejects absence from a material read that crossed a controller replacement', async () => {
    let endpoint: ControllerEndpoint;
    await withApi(
      (_request, response) => {
        endpoint.attach(endpoint.snapshot()!.url);
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(absent()));
      },
      async ({ artifacts, redactor, url }) => {
        endpoint = new ControllerEndpoint(url);
        const api = new ApiClient(endpoint, 'test-token', artifacts, redactor);
        await expect(
          api.readCredential(material.name, Date.now() + 5_000),
        ).rejects.toThrow('readback failed');
      },
    );
  });

  test('reads the redacted record and retains successive observations', async () => {
    await withApi(
      (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(isReadback(request.url) ? redacted : []));
      },
      async ({ api, readArtifacts }) => {
        const captured = await api.readCredential(
          material.name,
          Date.now() + 5_000,
        );
        expect(captured).toEqual(redacted);
        expect(Object.isFrozen(captured)).toBe(true);
        await api.listCredentials(Date.now() + 5_000);
        const retained = await readArtifacts();
        expect(retained).not.toContain(material.accessKeyId);
        expect(retained).toContain('present');
        expect(retained).toContain('identities');
      },
    );
  });

  test.each([
    {
      label: 'foreign name',
      status: 200,
      body: { ...redacted, name: 'foreign' },
    },
    {
      label: 'unknown private field',
      status: 200,
      body: { ...redacted, diagnostic: 'unregistered-sensitive-body' },
    },
    {
      label: 'authentication',
      status: 401,
      body: { message: 'unregistered-sensitive-body' },
    },
    {
      label: 'generic not found',
      status: 404,
      body: { message: 'unregistered-sensitive-body' },
    },
    { label: 'foreign declared absence', status: 404, body: absent('foreign') },
  ])(
    'retains uncertainty and suppresses unvalidated output: $label',
    async ({ status, body }) => {
      await withApi(
        (_request, response) => {
          response.statusCode = status;
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify(body));
        },
        async ({ api, readArtifacts }) => {
          await expect(
            api.readCredential(material.name, Date.now() + 5_000),
          ).rejects.toThrow('Credential readback failed');
          const retained = await readArtifacts();
          expect(retained).toContain('unknown');
          expect(retained).not.toContain(material.secretAccessKey);
          expect(retained).not.toContain('unregistered-sensitive-body');
        },
      );
    },
  );

  test.each([
    {
      label: 'absent',
      list: [],
      readback: absent(),
      readbackStatus: 404,
      success: true,
    },
    {
      label: 'list still names owner',
      list: [{ name: material.name, cloudProvider: CloudType.AWS }],
      readback: absent(),
      readbackStatus: 404,
      success: false,
    },
    {
      label: 'record still exists',
      list: [],
      readback: redacted,
      readbackStatus: 200,
      success: false,
    },
    {
      label: 'inventory malformed',
      list: { credentials: [] },
      readback: absent(),
      readbackStatus: 404,
      success: false,
    },
    {
      label: 'duplicate identities',
      list: [
        { name: 'foreign', cloudProvider: CloudType.AWS },
        { name: 'foreign', cloudProvider: CloudType.AWS },
      ],
      readback: absent(),
      readbackStatus: 404,
      success: false,
    },
    {
      label: 'private inventory extension',
      list: [
        {
          name: 'foreign',
          cloudProvider: CloudType.AWS,
          diagnostic: 'unregistered-sensitive-body',
        },
      ],
      readback: absent(),
      readbackStatus: 404,
      success: false,
    },
  ])(
    'requires complete inventory and exact absence after delete: $label',
    async ({ list, readback, readbackStatus, success }) => {
      const calls: string[] = [];
      await withApi(
        (request, response) => {
          calls.push(`${request.method} ${request.url}`);
          response.setHeader('Content-Type', 'application/json');
          if (request.method === 'DELETE') {
            response.statusCode = 204;
            response.end();
          } else if (isReadback(request.url)) {
            response.statusCode = readbackStatus;
            response.end(JSON.stringify(readback));
          } else response.end(JSON.stringify(list));
        },
        async ({ api, readArtifacts }) => {
          const deletion = api.deleteCredential(
            material.name,
            Date.now() + 5_000,
          );
          if (success) await deletion;
          else await expect(deletion).rejects.toThrow();
          expect(calls[0]).toBe('DELETE /v1/credentials/job-owned?force=true');
          expect(calls[1]).toBe('GET /v1/credentials');
          if (success) expect(calls[2]).toBe('GET /v1/credentials/job-owned');
          const retained = await readArtifacts();
          expect(retained).not.toContain(material.secretAccessKey);
          expect(retained).not.toContain('unregistered-sensitive-body');
        },
      );
    },
  );

  test('does not follow an API redirect to manufacture credential absence', async () => {
    let forwarded = 0;
    await withApi(
      (request, response) => {
        if (request.url === '/elsewhere') {
          forwarded += 1;
          response.setHeader('Content-Type', 'application/json');
          response.end('[]');
        } else {
          response.statusCode = 302;
          response.setHeader('Location', '/elsewhere');
          response.end();
        }
      },
      async ({ api }) => {
        await expect(api.listCredentials(Date.now() + 2_000)).rejects.toThrow();
        expect(forwarded).toBe(0);
      },
    );
  });

  test('bounds stalled response bodies and pre-expired cleanup without a send', async () => {
    let sent = 0;
    await withApi(
      (_request, response) => {
        sent += 1;
        response.setHeader('Content-Type', 'application/json');
        response.write('[');
      },
      async ({ api }) => {
        await expect(api.listCredentials(Date.now() + 50)).rejects.toThrow();
        expect(sent).toBe(1);
        await expect(
          api.deleteCredential(material.name, Date.now() - 1),
        ).rejects.toThrow();
        expect(sent).toBe(1);
      },
    );
  });

  test('the independent cleanup client works after foreground cancellation', async () => {
    await withApi(
      (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        if (request.method === 'DELETE') {
          response.statusCode = 204;
          response.end();
        } else if (isReadback(request.url)) {
          response.statusCode = 404;
          response.end(JSON.stringify(absent()));
        } else response.end('[]');
      },
      async ({ api, artifacts, redactor, url }) => {
        const foreground = new AbortController();
        foreground.abort();
        const cancelled = new ApiClient(
          url,
          'test-token',
          artifacts,
          redactor,
          foreground.signal,
        );
        await expect(
          cancelled.listCredentials(Date.now() + 5_000),
        ).rejects.toThrow();
        await expect(
          api.deleteCredential(material.name, Date.now() + 5_000),
        ).resolves.toBeUndefined();
      },
    );
  });

  test('can require create-only credential import without changing existing callers', async () => {
    let requestUrl: string | undefined;
    await withApi(
      (request, response) => {
        requestUrl = request.url;
        response.statusCode = 204;
        response.end();
      },
      async ({ api }) => {
        await api.saveCredential(
          material.name,
          {
            cloudProvider: material.cloudProvider,
            accessKeyId: material.accessKeyId,
            secretAccessKey: material.secretAccessKey,
          },
          { overwrite: false, deadlineAt: Date.now() + 5_000 },
        );
        expect(requestUrl).toBe('/v1/credentials/job-owned?overwrite=false');
      },
    );
  });
});
