import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';

import packageJson from '../../../package.json' with { type: 'json' };
import { redactedCredentialSchema } from '../../../src/shared/api-contract/credentials-schemas.js';
import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../../../src/shared/api-version.js';
import { LOCAL_API_STILL_STARTING_EXIT_CODE } from '../../../src/shared/local-api-container.js';
import { LOCAL_API_STOP_ADVICE } from '../../../src/cli/services/local-api-update.js';
import { Waiter } from '../e2e/internal/wait.js';
import {
  apiProcessMemberSchema,
  apiProcessModeSchema,
  containerAbsenceTargets,
  processReceiptSchema,
  readProcessReceipts,
  validateOwnedContainerNames,
  verifyProcessReceipts,
  type ProcessReceipt,
} from './api-process-receipts.js';

const exec = promisify(execFile);
const wait = new Waiter(new AbortController().signal);
const observedContainers = new Map<
  string,
  ProcessReceipt['containers'][number]
>();
let ownedNames: string[] | undefined;
let absence: ProcessReceipt['absence'];
let injectedFailure = false;

const containerSchema = z.object({
  Id: z.string().min(1),
  State: z.object({
    Status: z.string(),
    Running: z.boolean(),
    ExitCode: z.number().int(),
  }),
  Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }),
  HostConfig: z.object({
    Binds: z.array(z.string()).nullable(),
    RestartPolicy: z.object({ Name: z.string() }),
  }),
  NetworkSettings: z.object({
    Ports: z.record(
      z.string(),
      z
        .array(z.object({ HostIp: z.string(), HostPort: z.string() }))
        .nullable(),
    ),
  }),
});

export type ContainerInspection = z.output<typeof containerSchema>;

export function parseContainerInspection(value: unknown): ContainerInspection {
  const rows = z.array(containerSchema).length(1).parse(value);
  return rows[0];
}

export function assertLocalContainer(
  container: ContainerInspection,
  state: string,
  port: string,
  restartPolicy?: string,
): void {
  assert.equal(container.State.Running, true, 'API container is not running');
  assert.deepEqual(
    container.NetworkSettings.Ports['8080/tcp'],
    [{ HostIp: '127.0.0.1', HostPort: port }],
    'API must bind only the expected loopback port',
  );
  assert.deepEqual(
    container.HostConfig.Binds,
    [`${state}:/root/.anycloud`],
    'API must mount only its state directory',
  );
  if (restartPolicy !== undefined)
    assert.equal(container.HostConfig.RestartPolicy.Name, restartPolicy);
}

/** CLI failures exit 1; any other code is a timeout, signal, or still-starting exit. */
function assertFailedExit(exit: string): void {
  assert.equal(exit, '1', `Expected the CLI failure exit 1, got ${exit}`);
}

async function docker(
  args: readonly string[],
  timeout = 30_000,
): Promise<string> {
  return (
    await exec('docker', [...args], { timeout, maxBuffer: 4 * 1024 * 1024 })
  ).stdout.trim();
}

async function inspect(name = 'anycloud-api'): Promise<ContainerInspection> {
  const container = parseContainerInspection(
    JSON.parse(await docker(['inspect', name])),
  );
  assert.match(
    container.Id,
    /^[a-f0-9]{64}$/u,
    'Docker returned an invalid container identity',
  );
  observedContainers.set(container.Id, {
    id: container.Id,
    name,
    running: container.State.Running,
  });
  return container;
}

async function absent(
  kind: 'container' | 'image',
  name: string,
  timeoutMs = 30_000,
): Promise<boolean> {
  try {
    await docker(
      kind === 'image' ? ['image', 'inspect', name] : ['inspect', name],
      timeoutMs,
    );
    return false;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'stderr' in error &&
      typeof error.stderr === 'string' &&
      /No such (?:object|container|image)/iu.test(error.stderr)
    )
      return true;
    throw error;
  }
}

/** `token` is the bearer to send; undefined only for public routes. */
async function http(
  url: string,
  method: string,
  body: unknown,
  token: string | undefined,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
    headers: {
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      [ANYCLOUD_CLIENT_VERSION_HEADER]: packageJson.version,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* /health is plain text on older images. */
  }
  return { status: response.status, body: parsed };
}

async function health(url: string): Promise<void> {
  await wait.for(
    'API health',
    () => http(`${url}/health`, 'GET', undefined, undefined),
    {
      timeoutMs: 30_000,
      intervalMs: 1_000,
      probeError: {
        retry: (error) =>
          error instanceof TypeError ||
          (error instanceof Error && /timeout|aborted/iu.test(error.message)),
      },
      unmet: (response) =>
        response.status === 200 ? undefined : `HTTP ${response.status}`,
    },
  );
}

async function containerHealth(container: string): Promise<void> {
  await wait.for(
    'Container API health',
    async () => {
      assert.equal(
        (await inspect(container)).State.Running,
        true,
        'Container exited before readiness',
      );
      try {
        await docker(
          [
            'exec',
            container,
            'node',
            '--input-type=module',
            '--eval',
            'const r = await fetch("http://127.0.0.1:8080/health"); if (!r.ok) process.exit(1);',
          ],
          5_000,
        );
        return true;
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 1
        )
          return false;
        throw error;
      }
    },
    {
      timeoutMs: 30_000,
      intervalMs: 1_000,
      probeError: 'fail',
      unmet: (ready) => (ready ? undefined : 'API not ready'),
    },
  );
}

async function fileNonempty(file: string, timeoutMs = 2_000): Promise<void> {
  await wait.for(
    `File ${path.basename(file)}`,
    async () => {
      try {
        const info = await stat(file);
        return info.isFile() && info.size > 0;
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return false;
        throw error;
      }
    },
    {
      timeoutMs,
      intervalMs: 100,
      probeError: 'fail',
      unmet: (ready) => (ready ? undefined : 'file missing or empty'),
    },
  );
}

async function cipherDigest(container: string): Promise<string> {
  const key = await docker([
    'exec',
    container,
    'cat',
    '/root/.anycloud/cipher.key',
  ]);
  assert.ok(
    /^[a-f0-9]{64}$/u.test(key),
    'Generated cipher key has an invalid format',
  );
  return createHash('sha256').update(key).digest('hex');
}

async function durable(
  container: string,
  url: string,
  file: string,
  directory: string,
  restoring: boolean,
): Promise<void> {
  await health(url);
  await inspect(container);
  await wait.for(
    'Durable API state files',
    async () => {
      try {
        await docker([
          'exec',
          container,
          'sh',
          '-c',
          'test -s /root/.anycloud/cipher.key && test -s /root/.anycloud/api.db',
        ]);
        return true;
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 1
        )
          return false;
        throw error;
      }
    },
    {
      timeoutMs: 2_000,
      intervalMs: 100,
      probeError: 'fail',
      unmet: (ready) => (ready ? undefined : 'durable files missing'),
    },
  );
  const digest = await cipherDigest(container);
  const token = await localApiToken(directory);
  if (!restoring) {
    const saved = await http(
      `${url}/v1/credentials/durable-test`,
      'PUT',
      {
        cloudProvider: 'AWS',
        accessKeyId: 'AKIADURABLETEST',
        secretAccessKey: 'durable-secret',
      },
      token,
    );
    assert.equal(saved.status, 204, 'Could not save encrypted credential');
    await writeFile(file, JSON.stringify({ cipherDigest: digest }), {
      mode: 0o600,
    });
    return;
  }
  const original = z
    .object({ cipherDigest: z.string().regex(/^[a-f0-9]{64}$/u) })
    .strict()
    .parse(JSON.parse(await readFile(file, 'utf8')));
  assert.equal(
    digest,
    original.cipherDigest,
    'Cipher key changed across container replacement',
  );
  // The API decrypts the row to answer, so this also proves the key survived.
  const redacted = await http(
    `${url}/v1/credentials/durable-test`,
    'GET',
    undefined,
    token,
  );
  assert.equal(redacted.status, 200);
  assert.deepEqual(redactedCredentialSchema.parse(redacted.body), {
    name: 'durable-test',
    cloudProvider: 'AWS',
    accessKeyId: 'AKIADURABLETEST',
  });
}

async function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1_000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('Port probe timed out'));
    });
    socket.once('error', (error) => {
      socket.destroy();
      if ('code' in error && error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
  });
}

/** The per-install token `api start` writes for the local API. */
async function localApiToken(directory: string): Promise<string> {
  const file = path.join(directory, 'local-api-token');
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600, `${file} has mode ${mode.toString(8)}`);
  const token = (await readFile(file, 'utf8')).trim();
  assert.match(token, /^[0-9a-f]{64}$/, 'The local API token is malformed');
  return token;
}

/** fetch() can't set Host; a DNS-rebinding page would send its own. */
function statusWithHost(
  url: string,
  token: string,
  host: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        headers: {
          Host: host,
          Authorization: `Bearer ${token}`,
          [ANYCLOUD_CLIENT_VERSION_HEADER]: packageJson.version,
        },
        timeout: 5_000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${url} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

async function stdin(): Promise<string> {
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}

async function down(): Promise<void> {
  if (await absent('container', 'anycloud-api')) return;
  assert.equal(
    (await inspect()).State.Running,
    false,
    'A stopped API was resurrected',
  );
}

async function run(action: string, args: readonly string[]): Promise<void> {
  const required = (index: number): string => {
    const value = args[index];
    assert.ok(value, `Missing argument ${index + 1} for ${action}`);
    return value;
  };
  if (action === 'register-owned') {
    const member = apiProcessMemberSchema.parse(
      process.env.E2E_API_PROCESS_MEMBER,
    );
    validateOwnedContainerNames(member, args);
    ownedNames = [...args];
    return;
  }
  if (action === 'launcher-finished') {
    assert.equal(required(0), '0', 'Launcher cleanup failed');
    return;
  }
  if (action === 'after-running') {
    assert.equal((await inspect(required(0))).State.Running, true);
    if (process.env.E2E_API_PROCESS_FORCE_FAILURE_AFTER_RUNNING === '1') {
      injectedFailure = true;
      throw new Error(
        'Forced API process failure after Running and exact container identity capture',
      );
    }
    return;
  }
  if (action === 'containers-absent') {
    const member = apiProcessMemberSchema.parse(
      process.env.E2E_API_PROCESS_MEMBER,
    );
    const directory = process.env.RESULTS_DIR;
    assert.ok(
      directory,
      'RESULTS_DIR is required for native cleanup observations',
    );
    const targets = containerAbsenceTargets(
      await readProcessReceipts(directory),
      member,
    );
    const observations: NonNullable<ProcessReceipt['absence']> = [];
    absence = observations;
    const deadline = Date.now() + 120_000;
    for (const target of targets) {
      let observation: 'absent' | 'present' | 'unknown' = 'unknown';
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        try {
          observation = (await absent(
            'container',
            target.value,
            Math.min(30_000, remaining),
          ))
            ? 'absent'
            : 'present';
        } catch {
          /* Unknown remains an outstanding native cleanup obligation. */
        }
      }
      observations.push({ ...target, observation });
    }
    assert.ok(
      observations.every((entry) => entry.observation === 'absent'),
      'Owned API process containers remain present or unknown',
    );
    return;
  }
  if (action === 'health') return health(required(0));
  if (action === 'container-health') return containerHealth(required(0));
  if (action === 'durable-seed' || action === 'durable-restored')
    return durable(
      required(0),
      required(1),
      required(2),
      required(3),
      action === 'durable-restored',
    );
  if (action === 'file-nonempty') return fileNonempty(required(0));
  if (action === 'down') return down();
  if (action === 'container-id') {
    process.stdout.write(`${(await inspect(required(0))).Id}\n`);
    return;
  }
  if (action === 'container-missing') {
    assert.ok(
      await absent('container', required(0)),
      'An existing API container must not be touched',
    );
    return;
  }
  if (action === 'container-running') {
    await wait.for('API container running', () => inspect(required(0)), {
      timeoutMs: 30_000,
      intervalMs: 1_000,
      probeError: 'fail',
      unmet: (container) =>
        container.State.Running ? undefined : 'container stopped',
    });
    return;
  }
  if (action === 'image-metadata') {
    const images = z
      .array(
        z.object({
          Size: z.number().nonnegative(),
          Config: z.object({ Entrypoint: z.array(z.string()) }),
        }),
      )
      .length(1)
      .parse(JSON.parse(await docker(['image', 'inspect', required(0)])));
    assert.deepEqual(images[0]?.Config.Entrypoint, ['/usr/bin/tini', '--']);
    await docker([
      'run',
      '--rm',
      '--entrypoint',
      '/usr/bin/tini',
      required(0),
      '--version',
    ]);
    // Jobs run the CLI inside this image, so every module it loads must be in
    // the runtime stage (0.1.68 shipped a CLI import the stage lacked).
    assert.equal(
      await docker([
        'run',
        '--rm',
        required(0),
        'node',
        'dist/cli/index.js',
        '--version',
      ]),
      packageJson.version,
    );
    // tsc emits the cloud policies src/ imports into dist (the role
    // connection setup templates read all three), and the image carries no
    // docs/ for the CLI above to fall back on.
    assert.equal(
      await docker([
        'run',
        '--rm',
        required(0),
        'sh',
        '-c',
        'test ! -e docs && ls dist/shared/cloud-policies',
      ]),
      'aws-anycloud-access.json\nazure-anycloud-role.json\ngcp-anycloud-role.json',
    );
    return;
  }
  if (action === 'node-options') {
    const values = (
      await docker(['exec', required(0), 'cat', '/proc/1/environ'])
    )
      .split('\0')
      .filter((value) => value.startsWith('NODE_OPTIONS='));
    assert.deepEqual(
      values,
      args[1] ? [`NODE_OPTIONS=${args[1]}`] : [],
      'Container changed caller NODE_OPTIONS',
    );
    return;
  }
  if (action === 'graceful-stop') {
    // Unhandled SIGTERM exits 143 and a stop timeout 137; only the graceful
    // handler exits 0.
    const container = await inspect(required(0));
    assert.equal(container.State.Running, false);
    assert.equal(
      container.State.ExitCode,
      0,
      'Docker stop did not reach the graceful handler',
    );
    return;
  }
  if (action === 'image-runtime') {
    await fileNonempty(required(1));
    assert.equal((await inspect(required(0))).State.Running, true);
    await health(required(2));
    await docker([
      'exec',
      required(0),
      'node',
      '--input-type=module',
      '--eval',
      'import assert from "node:assert/strict"; import fs from "node:fs"; assert.ok(fs.existsSync("/app/dist/api/server.js")); assert.ok(!fs.existsSync("/app/node_modules/typescript"), "Development dependencies remain in runtime image");',
    ]);
    return;
  }
  if (action === 'port-free') {
    const port = z.coerce.number().int().min(1).max(65_535).parse(required(0));
    await wait.for('API listener closed', () => portIsOpen(port), {
      timeoutMs: 5_000,
      intervalMs: 100,
      probeError: 'fail',
      unmet: (open) => (open ? 'listener remains open' : undefined),
    });
    return;
  }
  if (action === 'startup-default') {
    assertLocalContainer(
      await inspect(),
      required(0),
      required(1),
      'unless-stopped',
    );
    return;
  }
  if (action === 'status-result') {
    // The CLI prints only the error's message: take the code and that message
    // from the same request, and require the CLI to relay the server's message.
    const response = await http(
      `${required(1)}/v1/workloads/${required(2)}`,
      'GET',
      undefined,
      await localApiToken(required(3)),
    );
    assert.equal(response.status, 404);
    const error = z
      .object({ code: z.string(), message: z.string().min(1) })
      .parse(response.body);
    assert.equal(error.code, 'WORKLOAD_MANAGEMENT_NOT_FOUND');
    assertFailedExit(required(0));
    assert.ok(
      (await stdin()).includes(error.message),
      'CLI status failed before reaching the API',
    );
    return;
  }
  if (action === 'startup-updated') {
    const current = await inspect();
    assert.notEqual(
      current.Id,
      required(0),
      'Update retained the old container',
    );
    assertLocalContainer(current, required(1), required(2));
    assert.equal(current.Config.Labels?.['sh.anycloud.version'], required(3));
    assert.equal(
      await absent('image', required(4)),
      false,
      'Update deleted the rollback image',
    );
    assert.equal(
      await absent('image', required(5)),
      true,
      'Update retained an older image',
    );
    return;
  }
  if (action === 'unchanged') {
    assert.equal(
      (await inspect()).Id,
      required(0),
      'Current missing-label API was needlessly replaced',
    );
    return;
  }
  if (action === 'version') {
    const response = await http(
      `${required(0)}/v1/version`,
      'GET',
      undefined,
      undefined,
    );
    assert.equal(response.status, 200);
    assert.equal(
      z.object({ version: z.string() }).parse(response.body).version,
      required(1),
    );
    return;
  }
  if (action === 'failed-update') {
    assertFailedExit(required(0));
    assert.ok(
      (await stdin()).includes(LOCAL_API_STOP_ADVICE),
      'A failed replacement must give the api stop advice',
    );
    if (required(1) === 'stopped') await down();
    else {
      assert.equal(required(1), 'running');
      assert.equal((await inspect()).State.Running, true);
    }
    return;
  }
  if (action === 'restored-local') {
    const current = await inspect();
    assert.equal(current.State.Running, true);
    assert.equal(
      current.NetworkSettings.Ports['8080/tcp']?.[0]?.HostPort,
      required(1),
    );
    assert.equal(
      (await readFile(path.join(required(0), 'api-url'), 'utf8')).trim(),
      required(2),
      'API update changed the persisted local target',
    );
    await health(required(2));
    return;
  }
  if (action === 'slow-start') {
    // The replacement answers only after the injected delay, past the old
    // 15 s budget; an upgrade faster than the delay never took the slow path.
    assert.equal(
      required(0),
      '0',
      `api upgrade exited ${required(0)} (${LOCAL_API_STILL_STARTING_EXIT_CODE} means it stopped waiting)`,
    );
    assert.ok(
      Number(required(1)) >= Number(required(2)),
      `api upgrade took ${required(1)}s, under the ${required(2)}s start delay`,
    );
    assert.ok(
      !(await stdin()).includes(LOCAL_API_STOP_ADVICE),
      'A healthy replacement must not give the api stop advice',
    );
    const current = await inspect();
    assert.equal(current.State.Running, true);
    assert.equal(current.HostConfig.RestartPolicy.Name, 'unless-stopped');
    await health(required(3));
    return;
  }
  if (action === 'local-token') {
    // The per-install token, not any GitHub account, opens a local API.
    const token = await localApiToken(required(0));
    const url = `${required(1)}/v1/workloads`;
    assert.equal(
      (await http(url, 'GET', undefined, 'dummy-token-for-test')).status,
      401,
      'The local API accepted a token other than its own',
    );
    assert.equal((await http(url, 'GET', undefined, token)).status, 200);
    assert.equal(
      await statusWithHost(url, token, 'rebound.example'),
      403,
      'The local API answered a request addressed to another host',
    );
    return;
  }
  if (action === 'save-credential') {
    const response = await http(
      `${required(1)}/v1/credentials/${required(2)}`,
      'PUT',
      {
        cloudProvider: 'AWS',
        accessKeyId: 'AKIAAPISTARTUPDUMMY0',
        secretAccessKey: 'dummy-not-validated',
      },
      await localApiToken(required(0)),
    );
    assert.equal(response.status, 204);
    return;
  }
  if (action === 'failed-start') {
    // Previously, only the 15 s health budget ended a boot crash.
    assertFailedExit(required(0));
    assert.ok(Number(required(1)) < 14, `Boot crash took ${required(1)}s`);
    const current = await inspect();
    assert.equal(current.HostConfig.RestartPolicy.Name, 'no');
    // `created` would mean Docker never started it, so the crash went unseen.
    assert.equal(current.State.Status, 'exited');
    assert.notEqual(current.State.ExitCode, 0, 'The boot crash exited 0');
    return;
  }
  throw new Error(`Unknown API process qualification action: ${action}`);
}

async function main(): Promise<void> {
  const [action, ...args] = process.argv.slice(2);
  assert.ok(action, 'An API process qualification action is required');
  if (action === 'verify-cleanup') {
    const [directory, memberInput, outcomeInput, modeInput] = args;
    assert.ok(directory, 'The process evidence directory is required');
    const member = apiProcessMemberSchema.parse(memberInput);
    const outcome = z.enum(['success', 'failure']).parse(outcomeInput);
    const mode = apiProcessModeSchema.parse(modeInput);
    const receipt = verifyProcessReceipts(
      await readProcessReceipts(directory),
      member,
      outcome,
      mode,
    );
    // Recheck the exact names and historical IDs at verification time. A stale
    // or copied absence record cannot establish current native cleanup.
    const deadline = Date.now() + 120_000;
    for (const target of receipt.absence) {
      const remaining = deadline - Date.now();
      assert.ok(
        remaining > 0,
        'Native process cleanup verification deadline expired',
      );
      assert.ok(
        await absent('container', target.value, Math.min(30_000, remaining)),
        `Owned container remains present: ${target.value}`,
      );
    }
    await writeFile(
      path.join(directory, 'api-process-cleanup.json'),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    return;
  }
  const member = apiProcessMemberSchema.parse(
    process.env.E2E_API_PROCESS_MEMBER,
  );
  const fault = process.env.E2E_API_PROCESS_FORCE_FAILURE_AFTER_RUNNING ?? '0';
  assert.ok(
    fault === '0' || fault === '1',
    'Process fault selector must be 0 or 1',
  );
  const mode = fault === '1' ? 'forced' : 'normal';
  const startedAt = Date.now();
  let completed = false;
  try {
    await run(action, args);
    completed = true;
  } finally {
    const directory = process.env.RESULTS_DIR;
    if (directory) {
      await mkdir(directory, { recursive: true });
      await appendFile(
        path.join(directory, 'api-process-observations.jsonl'),
        `${JSON.stringify(processReceiptSchema.parse({ schemaVersion: 1, member, mode, action, startedAt, completedAt: Date.now(), completed, injectedFailure, containers: [...observedContainers.values()], ...(ownedNames ? { ownedNames } : {}), ...(absence ? { absence } : {}) }))}\n`,
      );
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
