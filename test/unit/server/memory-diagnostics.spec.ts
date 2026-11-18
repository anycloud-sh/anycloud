import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../../src/api/server.js';
import { testAuthenticate } from '../../helpers/test-authentication.js';

const originalIsTest = process.env.IS_TEST;

async function withServer<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const app = createApp({ authenticate: testAuthenticate });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });

  try {
    const address = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe('test memory diagnostics', () => {
  afterEach(() => {
    if (originalIsTest === undefined) delete process.env.IS_TEST;
    else process.env.IS_TEST = originalIsTest;
  });

  it('is not mounted outside IS_TEST mode', async () => {
    delete process.env.IS_TEST;

    await withServer(async (url) => {
      const response = await fetch(`${url}/__test/memory`);

      expect(response.status).toBe(404);
    });
  });

  it('returns process memory usage in IS_TEST mode', async () => {
    process.env.IS_TEST = 'true';

    await withServer(async (url) => {
      const response = await fetch(`${url}/__test/memory`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        timestampMs: expect.any(Number),
        uptimeSec: expect.any(Number),
        rssBytes: expect.any(Number),
        heapTotalBytes: expect.any(Number),
        heapUsedBytes: expect.any(Number),
        externalBytes: expect.any(Number),
        arrayBuffersBytes: expect.any(Number),
      });
      expect(body.rssBytes).toBeGreaterThan(0);
      expect(body.heapTotalBytes).toBeGreaterThan(0);
      expect(body.heapUsedBytes).toBeGreaterThan(0);
      expect(
        body.cgroupMemoryBytes === null ||
          (typeof body.cgroupMemoryBytes === 'number' &&
            body.cgroupMemoryBytes >= 0),
      ).toBe(true);
    });
  });
});
