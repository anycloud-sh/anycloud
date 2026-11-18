import { createServer } from 'node:http';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import packageJson from '../../package.json' with { type: 'json' };

export async function startFixture() {
  const root = resolve(import.meta.dirname, '../..');
  const evidence = join(root, '.context/ctrl-c-diagnosis');
  mkdirSync(evidence, { recursive: true });
  const directory = mkdtempSync(join(evidence, 'fixture-'));
  const configDirectory = join(directory, 'config');
  mkdirSync(configDirectory);
  const catalogs = join(homedir(), '.anycloud/catalogs');
  if (existsSync(catalogs)) {
    cpSync(catalogs, join(configDirectory, 'catalogs'), { recursive: true });
  }
  writeFileSync(
    join(configDirectory, 'version-cache.json'),
    JSON.stringify({ latestVersion: '0.1.62', lastCheck: Date.now() }),
  );
  process.env.IS_TEST = 'true';
  process.env.SQLITE_PATH = join(directory, 'api.db');
  process.env.CIPHER_KEY = 'a'.repeat(64);
  process.env.ANYCLOUD_DIR = configDirectory;
  const { createApp } = await import('../../src/api/server.js');
  const { getDB } = await import('../../src/api/services/repositories/db.js');
  const { seedTestWorkload, requireTestWorkload } = await import(
    '../../test/helpers/workload-store.js'
  );
  await getDB().init?.();
  const id = 'ctrl-c-diagnosis-job';
  await seedTestWorkload({
    id,
    userId: 'anycloud-test',
    image: 'busybox:latest',
    region: 'us-east-1',
  });
  const initial = await requireTestWorkload(id);
  const { testAuthenticate } = await import(
    '../../test/helpers/test-authentication.js'
  );
  const app = createApp({ authenticate: testAuthenticate });
  const events: Array<Record<string, unknown>> = [];
  let holdStatus = false;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const record = {
      at: Date.now(),
      event: 'request',
      method: request.method,
      pathname,
      version: request.headers['anycloud-client-version'],
    };
    events.push(record);
    response.on('close', () => {
      events.push({ at: Date.now(), event: 'response.close', pathname });
    });
    if (request.method !== 'GET') {
      response.writeHead(405);
      response.end('Diagnostic fixture accepts only reads.');
      return;
    }
    if (holdStatus && pathname === `/v1/workloads/${id}`) return;
    if (pathname === `/v1/workloads/${id}/logs`) {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      let sequence = 0;
      const send = () => {
        const data = Buffer.from(`DIAG_LOG ${++sequence}\n`).toString('base64');
        response.write(JSON.stringify({ type: 'stdout', data }) + '\n');
      };
      send();
      const interval = setInterval(send, 75);
      response.on('close', () => clearInterval(interval));
      return;
    }
    // This lets the installed 0.1.62 CLI reach the current fixture's read routes.
    // Such runs qualify terminal/cancellation behavior, not API compatibility.
    request.headers['anycloud-client-version'] = packageJson.version;
    app(request, response);
  });
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing fixture port');
  const url = `http://127.0.0.1:${address.port}`;
  const env = {
    API_URL: url,
    ANYCLOUD_DIR: configDirectory,
    GITHUB_TOKEN: 'test-token:anycloud-test',
    IS_TEST: 'true',
    CI: 'false',
  };
  return {
    id,
    url,
    env,
    directory,
    events,
    setMode(mode: { holdStatus?: boolean }) {
      holdStatus = mode.holdStatus === true;
    },
    async checkState() {
      const current = await requireTestWorkload(id);
      return {
        initialState: initial.state,
        currentState: current.state,
        unchanged: JSON.stringify(current) === JSON.stringify(initial),
      };
    },
    async close() {
      writeFileSync(
        join(directory, 'requests.json'),
        JSON.stringify(events, null, 2) + '\n',
      );
      await new Promise<void>((accept, reject) => {
        server.close((error) => (error ? reject(error) : accept()));
        server.closeAllConnections();
      });
    },
  };
}
