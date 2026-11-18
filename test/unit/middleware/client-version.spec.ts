import type { Server } from 'node:http';
import express from 'express';
import { describe, expect, it } from 'vitest';
import config from '../../../src/api/config.js';
import { requireCompatibleClientVersion } from '../../../src/api/middleware/client-version.js';
import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../../../src/shared/api-version.js';

describe('native client version check', () => {
  it('admits the previous release to workload logs and exec, and only this release to bucket content', async () => {
    const app = express();
    app.use('/v1', requireCompatibleClientVersion, (_req, res) => {
      res.status(204).end();
    });
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected an ephemeral TCP address');
      }
      const status = async (method: string, path: string, version: string) =>
        (
          await fetch(`http://127.0.0.1:${address.port}/v1${path}`, {
            method,
            headers: { [ANYCLOUD_CLIENT_VERSION_HEADER]: version },
          })
        ).status;

      for (const [method, path] of [
        ['GET', '/workloads/w-1/logs'],
        ['POST', '/workloads/w-1/exec'],
      ] as const) {
        expect(await status(method, path, config.currVersion)).toBe(204);
        expect(await status(method, path, config.previousVersion)).toBe(204);
        expect(await status(method, path, '0.0.0-incompatible')).toBe(400);
      }
      // Only the inventory's routes: another method or path stays exact.
      expect(
        await status('DELETE', '/workloads/w-1/logs', config.previousVersion),
      ).toBe(400);
      const bucket = '/credentials/prod/buckets/b/object-content';
      expect(await status('GET', bucket, config.currVersion)).toBe(204);
      expect(await status('GET', bucket, config.previousVersion)).toBe(400);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
