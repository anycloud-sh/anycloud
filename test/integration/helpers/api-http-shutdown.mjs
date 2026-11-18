import { readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const [apiUrl, container, version, anycloudDir] = process.argv.slice(2);
assert(
  apiUrl && container && version && anycloudDir,
  'Expected API URL, container, version, ANYCLOUD_DIR',
);
// The local API's own token, as the CLI on this machine would send it.
const token = readFileSync(
  path.join(anycloudDir, 'local-api-token'),
  'utf8',
).trim();

async function docker(args, timeoutMs) {
  const result = await exec('docker', args, {
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  return result.stdout;
}

async function main() {
  const initialRestarts = Number(
    await docker(
      ['inspect', '--format', '{{.RestartCount}}', container],
      5_000,
    ),
  );
  assert.equal(initialRestarts, 0, 'Expected a freshly started API container');
  const request = httpRequest(
    new URL('/v1/workloads/shutdown-probe/exec', apiUrl),
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'AnyCloud-Client-Version': version,
        'content-type': 'application/json',
        'content-length': '1024',
        expect: '100-continue',
      },
    },
  );
  let requestClosed = false;
  request.on('close', () => {
    requestClosed = true;
  });
  // Closing the listener may reset the request; retain a listener throughout
  // shutdown so that expected connection reset cannot crash the probe.
  request.on('error', () => {});

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error('API did not acknowledge the incomplete request')),
        5_000,
      );
      const fail = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      request.once('error', fail);
      request.once('response', (response) => {
        response.resume();
        fail(
          new Error(`Incomplete request returned HTTP ${response.statusCode}`),
        );
      });
      request.once('continue', () => {
        // The server's 100 Continue proves its HTTP listener accepted this
        // request. Leave its native-route JSON body incomplete across SIGTERM.
        request.write('{"command":', (error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        });
      });
      request.flushHeaders();
    });
    assert(!requestClosed, 'Incomplete request closed before SIGTERM');

    const startedAt = performance.now();
    const signalledAt = Math.floor(Date.now() / 1000);
    const deadline = startedAt + 30_000;
    const remaining = () => {
      const timeoutMs = Math.floor(deadline - performance.now());
      assert(
        timeoutMs > 0,
        'API did not shut down and restart within 30 seconds',
      );
      return timeoutMs;
    };
    await docker(['exec', container, 'sh', '-c', 'kill -TERM 1'], remaining());
    for (;;) {
      const state = JSON.parse(
        await docker(
          [
            'inspect',
            '--format',
            '{"running":{{.State.Running}},"restarts":{{.RestartCount}}}',
            container,
          ],
          remaining(),
        ),
      );
      assert(state.restarts <= 1, 'API restarted more than once');
      if (state.restarts === 1 && state.running) {
        let healthy = false;
        try {
          const response = await fetch(new URL('/health', apiUrl), {
            signal: AbortSignal.timeout(Math.min(1_000, remaining())),
          });
          healthy = response.status === 200 && (await response.text()) === 'ok';
        } catch {
          // The container can be running before its listener becomes ready.
        }
        if (healthy) {
          // tini passes on node's exit code. Only the SIGTERM handler exits 0,
          // after shutdown completes; an unhandled SIGTERM exits 143 and a
          // failed shutdown 1.
          const exits = await docker(
            [
              'events',
              '--since',
              String(signalledAt),
              '--until',
              String(Math.ceil(Date.now() / 1000)),
              '--filter',
              `container=${container}`,
              '--filter',
              'event=die',
              '--format',
              '{{.Actor.Attributes.exitCode}}',
            ],
            remaining(),
          );
          const codes = exits.trim().split('\n');
          assert.deepEqual(
            codes,
            ['0'],
            `SIGTERM exits ${JSON.stringify(codes)}, not one graceful exit 0`,
          );
          assert(
            requestClosed,
            'Server restart left the incomplete request open',
          );
          console.log(
            `Incomplete native request released; API shut down and restarted in ${Math.round(performance.now() - startedAt)}ms`,
          );
          return;
        }
      }
      await delay(Math.min(200, remaining()));
    }
  } finally {
    // Only release our socket after the shutdown assertions have succeeded or
    // failed. Releasing it earlier would hide the server.close() regression.
    request.destroy();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
