/**
 * Real Anycloud API, running in the test process.
 *
 * Integration specs that drive the CLI need something for it to talk to.
 * Standing up the actual app rather than stubbing routes means the request
 * shape, authentication, persistence and encryption are all exercised — a
 * hand-rolled stub only proves that some HTTP request arrived.
 *
 * In-process is the point, not an implementation detail: these suites stub API
 * internals with `vi.spyOn` so the compute picker and credential flows run
 * without touching real clouds, and that only works inside one process. The
 * constrained E2E fixture deliberately does the opposite — it connects to a
 * container started by e2e.sh — so the two are not interchangeable.
 *
 * Callers own any domain stubbing they need on top. This module owns only the
 * environment the API requires before `createApp()`, and the listening socket.
 *
 * Note the singleton constraint: the database and persistence layer are
 * module-level singletons keyed off SQLITE_PATH when first created, so a single
 * process can host exactly one of these.
 */

import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { CreateAppOptions } from '../../src/api/server.js';
import { useTestCatalogs } from './helpers/test-catalogs.js';

export interface StartApiServerOptions {
  /** Forwarded to `createApp()`, e.g. domain overrides. */
  createApp?: Partial<CreateAppOptions>;
  /** Defaults to a file in a fresh temp directory. Pass ':memory:' to opt out. */
  sqlitePath?: string;
}

export interface ApiServer {
  /** Base URL to hand the CLI as API_URL, or to proxy to. */
  url: string;
  port: number;
  /** Temp directory backing the database, even when it is not used for it. */
  stateDir: string;
  close(): Promise<void>;
}

function isAddressInfo(
  value: string | AddressInfo | null,
): value is AddressInfo {
  return value !== null && typeof value !== 'string';
}

/**
 * Stub the environment, initialise the database, and listen on a free port.
 *
 * Must run before `createApp()` so the lazily-initialised database picks the
 * path up. Everything set here goes through `vi.stubEnv`, so it restores in the
 * caller's `afterAll` rather than leaking into the next spec file.
 */
export async function startApiServer(
  options: StartApiServerOptions = {},
): Promise<ApiServer> {
  const stateDir = mkdtempSync(join(tmpdir(), 'anycloud-test-api-'));
  vi.stubEnv('SQLITE_PATH', options.sqlitePath ?? join(stateDir, 'api.db'));
  // Lets a fake bearer token authenticate.
  vi.stubEnv('IS_TEST', 'true');
  // Required wherever the API encrypts at rest — credentials, secrets, and the
  // Slack webhook.
  vi.stubEnv('CIPHER_KEY', process.env.CIPHER_KEY ?? 'a'.repeat(64));
  // The API resolves the cloud catalogs through its ANYCLOUD_DIR.
  useTestCatalogs(join(stateDir, 'anycloud'));

  const { createApp } = await import('../../src/api/server.js');
  const { getDB } = await import('../../src/api/services/repositories/db.js');
  await getDB().init?.();

  const { testAuthenticate } = await import(
    '../helpers/test-authentication.js'
  );
  const app = createApp({
    authenticate: testAuthenticate,
    ...options.createApp,
  });
  const server: Server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });

  const address = server.address();
  if (!isAddressInfo(address)) {
    throw new Error('Test API server did not bind to a TCP socket');
  }
  // Without this a keep-alive socket holds the process open past the suite.
  server.keepAliveTimeout = 0;

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    stateDir,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
