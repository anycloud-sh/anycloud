import { beforeAll, afterAll } from 'vitest';
import { createApp } from '../../../src/api/server.js';
import { createApiRpcDomains } from '../../../src/api/composition.js';
import type { Server } from 'http';
import packageJson from '../../../package.json' with { type: 'json' };
import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../../../src/shared/api-version.js';
import { testAuthenticate } from '../../helpers/test-authentication.js';

let testServer: Server | null = null;
// Bind an ephemeral port (0) per test file. A fixed port collides when route
// specs run concurrently across vitest workers in the full suite, which surfaces
// as "fetch failed" / wrong-status cascades even though each file passes alone.
let testPort = 0;

export function getTestApiUrl(): string {
  if (testPort === 0) {
    throw new Error('Test API server is not listening');
  }
  return `http://localhost:${testPort}`;
}

beforeAll(async () => {
  const app = createApp({
    authenticate: testAuthenticate,
    resolveRpcDomains: createApiRpcDomains,
  });
  return new Promise<void>((resolve) => {
    testServer = app.listen(0, () => {
      const address = testServer!.address();
      testPort = typeof address === 'object' && address ? address.port : 0;
      // keepAliveTimeout=0 ensures connections close after each request so
      // server.close() resolves immediately in afterAll.
      testServer!.keepAliveTimeout = 0;
      resolve();
    });
  });
});

afterAll(async () => {
  if (testServer) {
    return new Promise<void>((resolve, reject) => {
      testServer!.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

/** Make an HTTP request to the in-process test server. */
export async function callApi(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const { pathname, search } = new URL(url);
  const headers = new Headers(options.headers);
  if (!headers.has(ANYCLOUD_CLIENT_VERSION_HEADER)) {
    headers.set(ANYCLOUD_CLIENT_VERSION_HEADER, packageJson.version);
  }
  return fetch(`${getTestApiUrl()}${pathname}${search}`, {
    ...options,
    headers,
  });
}
