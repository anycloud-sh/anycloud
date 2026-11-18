import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { BOUNDED_CURL } from '../../../src/api/runtime-artifacts.js';

const run = promisify(execFile);

describe('BOUNDED_CURL', () => {
  it('gives up on a download that stalls, instead of hanging', async () => {
    // Sends its headers and a first chunk, then nothing.
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Length': String(100 * 1024 * 1024) });
      res.write(Buffer.alloc(1024));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    const started = Date.now();
    try {
      // One attempt: the stall check alone, not its retries.
      await expect(
        run('bash', [
          '-c',
          `${BOUNDED_CURL} --retry 0 http://127.0.0.1:${port}/archive -o /dev/null`,
        ]),
      ).rejects.toMatchObject({ code: 28 }); // curl's operation timeout
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }, 30_000);
});
