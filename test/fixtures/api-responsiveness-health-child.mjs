import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';

// Exercise the shared driver's lifecycle with requests queued behind synchronous
// work. Closing before the driver drains them would create connection resets.
const server = createServer((_request, response) => response.end('ok'));
const receive = () =>
  new Promise((resolve) => process.once('message', resolve));
const send = (message) =>
  new Promise((resolve, reject) =>
    process.send(message, (error) => (error ? reject(error) : resolve())),
  );
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const start = receive();
await send({ kind: 'ready', port: server.address().port });
assert.equal((await start).kind, 'start');
const go = receive();
await send({ kind: 'started' });
assert.equal((await go).kind, 'go');
const busyUntil = performance.now() + 350;
while (performance.now() < busyUntil) {
  // Deliberately block the server while the independent driver offers requests.
}
const drained = receive();
await send({ kind: 'work-finished' });
assert.equal((await drained).kind, 'health-drained');
server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
await send({ kind: 'result', result: {} });
process.stdout.write('Health drained before shutdown\n');
process.disconnect();
