/**
 * CLI interactivity PTY smoke tests.
 *
 * Spawns the compiled CLI in a real pseudo-terminal and drives interactive
 * prompts with real keystrokes. Catches TTY raw-mode regressions, prompt-render
 * breaks, validate-callback bugs, and hang-on-exit regressions that mocked unit
 * tests cannot see.
 *
 * To unlock prompts past the first one (most interactive flows hit
 * getGitHubToken() and an API call before their downstream prompts), this spec
 * boots the real API server in-process on a free port and overrides the child's
 * env with GITHUB_TOKEN + API_URL. IS_TEST=true makes the API's
 * `gateways/github.ts` auth gate return a stub user instead of calling GitHub.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  inject,
  vi,
} from 'vitest';
import {
  getCredentialSecretStore,
  getWorkloadEventStore as eventLog,
  getWorkloadOutcomes,
} from '../../src/api/services/persistence.js';
import { spawn, type IPty } from 'node-pty';
import {
  mkdtempSync,
  existsSync,
  readdirSync,
  cpSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs';
import { spawn as spawnProcess } from 'child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import packageJson from '../../package.json' with { type: 'json' };
import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../../src/shared/api-version.js';
import { type QuotaStatusEntry } from '../../src/shared/api-contract/quota-schemas.js';
import { CloudType } from '../../src/shared/cloud.js';
import { WorkloadState } from '../../src/shared/workload.js';
import { resolveVMType } from '../../src/shared/cloud-config.js';
import {
  requireTestWorkload,
  seedTestWorkload,
  walkToState,
} from '../helpers/workload-store.js';
import { isRecord, parseJson } from './helpers/json.js';
import { startApiServer, type ApiServer } from './api-server.js';
import { writeLocalApiToken } from './helpers/local-api-token.js';
import { childEnv } from './helpers/child-env.js';
import {
  installFakeCloudClis,
  type FakeCloudClis,
} from '../helpers/fake-cloud-cli.js';
import { createApiRpcDomains } from '../../src/api/composition.js';
import Github from '../../src/api/services/gateways/github.js';

const CLI = './dist/cli/index.js';
const SIGNED_OUT_BEARER = 'in-process-api-signed-out';

// The vitest setup at test/unit/setup.ts mocks the API's GitHub gateway to
// return this username for every authenticated request. Seeds must use the
// same value or routes won't find them under the mocked user. Note: this
// intentionally differs from TEST_USERNAMES[0] in api/services/test-identity.ts — many
// existing unit specs depend on the literal 'test-user'.
const STUB_USER_ID = 'test-user';

// Strips:
// - CSI sequences:        ESC [ <params> <intermediate> <final>  e.g. \x1b[1m
// - Fe escapes:           ESC <0x40-0x5F>                         e.g. ESC D
// - Fp/Fs private-use:    ESC <0x30-0x7E>                         e.g. ESC 7 (DECSC), ESC 8 (DECRC)
// The 3rd alternative is the easy-to-miss one — prompts uses ESC 7 / ESC 8
// around every redraw.
// eslint-disable-next-line no-control-regex
const STRIP_ANSI = /\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_]|[0-?])/g;
const stripAnsi = (s: string) => s.replace(STRIP_ANSI, '');
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Extract and parse JSON from PTY stdout. The CLI's --json mode is silent
 * apart from the payload, but spinners or info-line headers may briefly
 * appear before the JSON arrives. Find the first top-level `[` or `{` and
 * parse from there. Throws with the tail of the buffer if no JSON is found
 * — that's a real signal that --json mode regressed.
 */
function parseJsonStdout(stdout: string): unknown {
  const trimmed = stdout.trim();
  const starts = ['[', '{']
    .map((c) => trimmed.indexOf(c))
    .filter((i) => i >= 0);
  if (starts.length === 0) {
    throw new Error(`No JSON in stdout:\n${trimmed.slice(-500)}`);
  }
  return parseJson(trimmed.slice(Math.min(...starts)));
}

// ---------------------------------------------------------------------------
// In-process API server
// ---------------------------------------------------------------------------

let api: ApiServer | null = null;
let apiPort = 0;
let docsAWSSTSServer: ReturnType<typeof createServer> | null = null;
let docsAWSSTSEndpoint = '';
const docsAWSSTSCalls: Array<{
  action: string | null;
  accessKeyId: string | undefined;
}> = [];

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) {
      throw new TypeError('HTTP request emitted a non-buffer chunk.');
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleDocsAWSSTSRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const body = await readRequestBody(request);
    const action = new URLSearchParams(body).get('Action');
    const authorization = request.headers.authorization ?? '';
    const accessKeyId = authorization.match(/Credential=([^/]+)\//)?.[1];
    docsAWSSTSCalls.push({ action, accessKeyId });

    if (
      request.method !== 'POST' ||
      action !== 'GetCallerIdentity' ||
      accessKeyId !== 'AKIA-DOCS-TEST'
    ) {
      response.writeHead(403, { 'content-type': 'application/xml' });
      response.end(
        '<ErrorResponse><Error><Code>InvalidClientTokenId</Code><Message>Unexpected documentation fixture request</Message></Error></ErrorResponse>',
      );
      return;
    }

    response.writeHead(200, { 'content-type': 'application/xml' });
    response.end(
      '<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">' +
        '<GetCallerIdentityResult><UserId>AIDA-DOCS-TEST</UserId>' +
        '<Account>123456789012</Account>' +
        '<Arn>arn:aws:iam::123456789012:user/docs-test</Arn>' +
        '</GetCallerIdentityResult><ResponseMetadata>' +
        '<RequestId>docs-sts</RequestId></ResponseMetadata>' +
        '</GetCallerIdentityResponse>',
    );
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end(error instanceof Error ? error.message : String(error));
  }
}

// Cold-start cost: importing src/api/server.js transitively pulls in the
// cloud SDKs (AWS/Azure/GCP) — ~5–10s on a fresh esbuild cache. Plus the
// migrations run on init. Raise the hook timeout so a clean checkout doesn't
// flake the suite.
beforeAll(async () => {
  // Quota picker tests need the real CLI and route stack, but not real AWS
  // Service Quotas reads. Stub only the provider-backed status handler so the
  // region prompt can render deterministic "current quota" hints.
  const quotaHandler = await import('../../src/api/services/quota/handler.js');
  vi.spyOn(quotaHandler, 'handleQuotaStatus').mockImplementation(
    (_userId, cloud, _credentialName, region) => {
      if (cloud !== CloudType.AWS) return Promise.resolve([]);
      const entries: QuotaStatusEntry[] = [
        {
          kind: 'current',
          cloud: CloudType.AWS,
          region: 'us-east-1',
          resourceName: 'Running On-Demand G and VT instances',
          status: 'CURRENT',
          currentLimit: 192,
        },
      ];
      return Promise.resolve(
        region ? entries.filter((entry) => entry.region === region) : entries,
      );
    },
  );

  const cloudConfig = await import('../../src/api/services/cloud-config.js');
  const fakeCheckpointStorageShape = {
    hasBucket: vi.fn().mockResolvedValue(true),
  };
  const fakeCheckpointStorage =
    fakeCheckpointStorageShape as unknown as ReturnType<
      typeof cloudConfig.createCheckpointStorageProvider
    >;
  vi.spyOn(cloudConfig, 'createCheckpointStorageProvider').mockReturnValue(
    fakeCheckpointStorage,
  );

  // Workload admission calls validateCredentials, which hits real cloud APIs.
  // Stub it so submit's full happy-path can complete against a seeded
  // credential without touching AWS/Azure/GCP. We don't stub startup's deploy
  // because no monitor runs in beforeAll — the workload row stays in the
  // 'provisioning' state in our temp DB, no cloud work happens.
  const admissionChecks = await import(
    '../../src/api/services/workload-admission-checks.js'
  );
  vi.spyOn(admissionChecks, 'validateCredentials').mockImplementation(
    (config) => Promise.resolve(cloudConfig.createComputeProvider(config)),
  );

  let domains: ReturnType<typeof createApiRpcDomains> | undefined;
  api = await startApiServer({
    createApp: {
      // SIGNED_OUT_BEARER acts as a local API's owner: its GitHub sign-in is
      // only what the CLI sends beside the bearer.
      authenticate: async (token, signal, origin) => {
        const signedOut = token === SIGNED_OUT_BEARER;
        const { id, username } = await Github.authenticate(
          signedOut ? 'fake-pty-test-token' : token,
          signal,
        );
        return {
          id,
          username,
          token: signedOut ? origin?.githubToken?.trim() || null : token,
        };
      },
      resolveRpcDomains: () => {
        domains ??= createApiRpcDomains();
        return {
          ...domains,
        };
      },
    },
  });
  apiPort = api.port;

  docsAWSSTSServer = createServer((request, response) => {
    void handleDocsAWSSTSRequest(request, response);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    docsAWSSTSServer?.once('error', rejectListen);
    docsAWSSTSServer?.listen(0, '127.0.0.1', () => {
      docsAWSSTSServer?.off('error', rejectListen);
      resolveListen();
    });
  });
  const docsAWSSTSAddress = docsAWSSTSServer.address() as AddressInfo;
  docsAWSSTSEndpoint = `http://127.0.0.1:${docsAWSSTSAddress.port}`;

  // Catalogs are seeded once by test/global-setup.ts (fetch + GCP normalize).
  // Don't re-fetch here — it would overwrite the normalized GCP CSV with
  // whatever raw shape the public catalog currently has.
}, 60000);

afterAll(async () => {
  await api?.close();
  if (docsAWSSTSServer) {
    await new Promise<void>((resolveClose, rejectClose) => {
      docsAWSSTSServer?.close((error) =>
        error ? rejectClose(error) : resolveClose(),
      );
    });
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// PTY helpers
// ---------------------------------------------------------------------------

interface PtyRun {
  pty: IPty;
  /** Child's working directory (per-spawn tmpdir). Tests read files the wizard wrote here. */
  cwd: string;
  output: () => string;
  waitFor: (needle: RegExp | string, timeoutMs?: number) => Promise<void>;
  exit: Promise<{ exitCode: number; signal?: number }>;
}

interface SpawnCliContext {
  cwd: string;
  env: Record<string, string>;
}

interface SpawnCliOptions {
  setup?: (context: SpawnCliContext) => void;
}

/** A fresh ANYCLOUD_DIR and the child env pointing at it and the in-process API. */
function cliContext(): SpawnCliContext {
  if (!existsSync(CLI)) {
    throw new Error(`CLI binary not built: ${CLI}. Run 'yarn build' first.`);
  }

  const childAnycloudDir = mkdtempSync(join(tmpdir(), 'anycloud-pty-cli-'));

  // Seed the catalogs test/global-setup.ts downloaded (it also runs the GCP
  // normalizer) so the spawned CLI skips its bootstrap fetch and reads the
  // same canonical data as in-process tests. Without this, the child CLI
  // would hit raw.githubusercontent.com per test and pick up whatever the
  // public catalog currently looks like, including the pre-normalize GCP
  // shape.
  cpSync(inject('testCatalogsPath'), join(childAnycloudDir, 'catalogs'), {
    recursive: true,
  });

  const env = childEnv();
  delete env.ANYCLOUD_CLOUD_PROVIDER;
  delete env.LAMBDA_API_KEY;
  // GitHub Actions sets CI=true globally; the gate would refuse to prompt.
  env.CI = 'false';
  // Isolate child config from real on-disk state.
  env.ANYCLOUD_DIR = childAnycloudDir;
  env.HOME = childAnycloudDir;
  writeLocalApiToken(childAnycloudDir);
  env.GITHUB_TOKEN = 'fake-pty-test-token';
  // Redirect every API client call at the in-process server.
  env.API_URL = `http://localhost:${apiPort}`;
  return { cwd: childAnycloudDir, env };
}

function spawnCli(args: string[], options: SpawnCliOptions = {}): PtyRun {
  const { cwd: childAnycloudDir, env } = cliContext();
  options.setup?.({ cwd: childAnycloudDir, env });

  // Point the child at a per-spawn temp dir so tests cannot clobber real
  // on-disk CLI state. The CLI binary is invoked by absolute path, so the
  // launcher itself does not care.
  const pty = spawn(process.execPath, [resolve(CLI), ...args], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: childAnycloudDir,
    env,
  });

  let buffer = '';
  pty.onData((data) => {
    buffer += data;
  });

  const exit = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
    pty.onExit(resolve);
  });

  const waitFor = (needle: RegExp | string, timeoutMs = 10000) =>
    new Promise<void>((resolve, reject) => {
      const matches = () => {
        const text = stripAnsi(buffer);
        return typeof needle === 'string'
          ? text.includes(needle)
          : needle.test(text);
      };
      if (matches()) return resolve();
      const interval = setInterval(() => {
        if (matches()) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve();
        }
      }, 50);
      const timer = setTimeout(() => {
        clearInterval(interval);
        reject(
          new Error(
            `Timed out waiting for ${String(needle)} after ${timeoutMs}ms.\nOutput:\n${stripAnsi(buffer)}`,
          ),
        );
      }, timeoutMs);
    });

  return {
    pty,
    cwd: childAnycloudDir,
    output: () => stripAnsi(buffer),
    waitFor,
    exit,
  };
}

function expectCleanExit(
  exit: PtyRun['exit'],
  timeoutMs = 15000,
): Promise<{ exitCode: number; signal?: number }> {
  return Promise.race([
    exit,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `CLI did not exit within ${timeoutMs}ms — hang regression`,
            ),
          ),
        timeoutMs,
      ),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Fixture seeders
// ---------------------------------------------------------------------------

async function seedWorkload(
  id: string,
  image: string,
  options: { state?: WorkloadState } = {},
): Promise<void> {
  await seedTestWorkload({
    id,
    userId: STUB_USER_ID,
    image,
    region: 'us-east-1',
    state: options.state,
  });
}

async function updateWorkloadState(
  id: string,
  state: WorkloadState,
): Promise<void> {
  await walkToState(id, state);
}

/**
 * The terminate route publishes Terminated before provider teardown. Prove the
 * separate cleanup boundary without starting monitors or touching a cloud.
 */
async function expectScheduledTerminationThenComplete(id: string) {
  expect(await requireTestWorkload(id)).toMatchObject({
    state: WorkloadState.Terminated,
    cleanedAt: null,
  });

  await expect(getWorkloadOutcomes().markCleanupComplete(id)).resolves.toBe(
    true,
  );
  const cleanedWorkload = await requireTestWorkload(id);
  expect(cleanedWorkload.state).toBe(WorkloadState.Terminated);
  expect(typeof cleanedWorkload.cleanedAt).toBe('number');
  expect((await eventLog().getWorkloadEvents(id)).at(-1)?.state).toBe(
    WorkloadState.Terminated,
  );
}

/**
 * PUT a credential via the in-process API. Returns the unique name so tests
 * don't share state on the listApiCredentials uniqueness check.
 */
async function seedCredential(
  provider: 'Lambda' | 'AWS',
  prefix: string,
): Promise<string> {
  const name = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const suffix = Math.random().toString(36).slice(2, 18).toUpperCase();
  const body =
    provider === 'Lambda'
      ? { cloudProvider: 'Lambda', apiKey: `sk-seed-fake-${suffix}` }
      : {
          cloudProvider: 'AWS',
          accessKeyId: `AKIA${suffix.padEnd(16, '0').slice(0, 16)}`,
          secretAccessKey: `SECRET-SEED-FAKE-${suffix}`,
        };
  const resp = await fetch(
    `http://localhost:${apiPort}/v1/credentials/${encodeURIComponent(name)}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer fake-pty-test-token',
        [ANYCLOUD_CLIENT_VERSION_HEADER]: packageJson.version,
      },
      body: JSON.stringify(body),
    },
  );
  if (!resp.ok) {
    throw new Error(
      `seedCredential(${provider}) failed: ${resp.status} ${await resp.text()}`,
    );
  }
  return name;
}

const seedLambdaCredential = () => seedCredential('Lambda', 'seed-lambda');
const seedAwsCredential = () => seedCredential('AWS', 'seed-aws');

vi.mock('../../src/shared/image-registry.js', async () => {
  const { ImageRuntime, ImageVerdict } = await vi.importActual<
    typeof import('../../src/shared/image.js')
  >('../../src/shared/image.js');

  return {
    inspectImage: vi.fn().mockResolvedValue({
      verdict: ImageVerdict.Ok,
      amd64Digest:
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      imageRuntime: ImageRuntime.Unknown,
      compressedLayerBytes: null,
    }),
  };
});

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

describe('credentials new — name prompt (PTY)', () => {
  it('renders the name prompt, validates empty input, and exits cleanly on Ctrl-C', async () => {
    const run = spawnCli(['credentials', 'new']);

    try {
      await run.waitFor('Name for this credential set');
      run.pty.write('\r');
      await run.waitFor('Name required');
      run.pty.write('\x03');
      const result = await expectCleanExit(run.exit);
      expect(result).toBeDefined();
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  });
});

describe('credentials new — provider select + Lambda end-to-end (PTY)', () => {
  it('renders provider select after the name prompt and exits cleanly on Ctrl-C', async () => {
    const run = spawnCli(['credentials', 'new']);

    try {
      await run.waitFor('Name for this credential set');
      run.pty.write('pty-render-test\r');

      await run.waitFor('Select cloud provider');
      // All four choices must render in the same frame.
      await run.waitFor(/AWS[\s\S]*Azure[\s\S]*GCP[\s\S]*Lambda/);

      // Arrow-down should redraw with the highlight (`❯`) now on the 2nd
      // choice. Content-based check — robust against in-place redraws that
      // don't grow the cumulative buffer. (prompts renders pointer + 3 spaces
      // before the choice title, hence `\s+`.)
      run.pty.write('\x1b[B');
      await run.waitFor(/❯\s+Azure/);

      run.pty.write('\x03');
      const result = await expectCleanExit(run.exit);
      expect(result).toBeDefined();
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  });

  it('completes the full Lambda wizard end-to-end against the in-process API', async () => {
    const credName = `pty-lambda-${Date.now()}`;
    const run = spawnCli(['credentials', 'new']);

    try {
      // Step 1 — name.
      await run.waitFor('Name for this credential set');
      run.pty.write(`${credName}\r`);

      // Step 2 — provider select. Lambda is the 4th choice; arrow-down x3 +
      // Enter. Wait for the highlight to land on Lambda before Enter so a
      // future re-ordering of `resolveProvider`'s choices array fails loudly
      // here instead of silently picking the wrong branch.
      await run.waitFor('Select cloud provider');
      run.pty.write('\x1b[B\x1b[B\x1b[B');
      await run.waitFor(/❯\s+Lambda/);
      run.pty.write('\r');

      // Step 3 — Lambda API key password prompt.
      await run.waitFor('Lambda Labs API Key');
      run.pty.write('sk-fake-pty-key\r');

      // Step 4 — confirm saving the imported key.
      await run.waitFor(`Save these Lambda Labs credentials as "${credName}"?`);
      run.pty.write('y\r');

      // Step 5 — saved successfully (credential PUT hit the in-process
      // server, which encrypts + persists via the sqlite-backed store).
      await run.waitFor(`Credentials "${credName}" saved successfully`, 20000);

      const result = await expectCleanExit(run.exit, 20000);
      expect(result.exitCode).toBe(0);

      // Cross-check via the API directly — the credential row exists.
      const listResp = await fetch(
        `http://localhost:${apiPort}/v1/credentials`,
        {
          headers: {
            Authorization: 'Bearer fake-pty-test-token',
            [ANYCLOUD_CLIENT_VERSION_HEADER]: packageJson.version,
          },
        },
      );
      expect(listResp.status).toBe(200);
      const list = (await listResp.json()) as Array<{
        name: string;
        cloudProvider: string;
      }>;
      expect(list.find((c) => c.name === credName)).toMatchObject({
        cloudProvider: 'Lambda',
      });
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  });
});

// Generated AWS/Azure journeys live in credentials-onboarding/*/terminal.spec.ts,
// where real SDK protocol calls are verified before the credential save.
describe('catalog discovery prompts (PTY)', () => {
  it('bare regions uses cloud wording and accepts the default cloud', async () => {
    const run = spawnCli(['regions']);

    try {
      await run.waitFor('Pick a cloud');
      await run.waitFor('AWS (Amazon Web Services)');

      run.pty.write('\r');

      const result = await expectCleanExit(run.exit, 20000);
      expect(result.exitCode).toBe(0);
      expect(run.output()).toMatch(/us-(east|west)-\d/);
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  });

  it('bare vm-types prompts for cloud, then region, then exits cleanly', async () => {
    const run = spawnCli(['vm-types']);

    try {
      await run.waitFor('Pick a cloud');
      await run.waitFor('AWS (Amazon Web Services)');
      run.pty.write('\r');

      await run.waitFor('Pick a region');
      await run.waitFor(/us-(east|west)-\d/);
      run.pty.write('\r');

      const result = await expectCleanExit(run.exit, 20000);
      expect(result.exitCode).toBe(0);
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  });

  it('bare gpus offers all-cloud comparison and expanded cloud names', async () => {
    const run = spawnCli(['gpus']);

    try {
      await run.waitFor('Show GPUs for');
      await run.waitFor('Compare all clouds');
      await run.waitFor('AWS (Amazon Web Services)');

      run.pty.write('\r');
      await run.waitFor('Pick a GPU type');

      run.pty.write('\x03');
      const result = await expectCleanExit(run.exit);
      expect(result).toBeDefined();
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  });
});

describe('status — workload autocomplete picker (PTY)', () => {
  it('lists a seeded workload, reads its status, and exits after picker selection', async () => {
    const id = `pty-exit-${Date.now()}`;
    await seedWorkload(id, 'nginx:latest');
    for (const args of [['list'], ['status', id], ['status']]) {
      const run = spawnCli(args);
      try {
        if (args[0] === 'list') {
          await run.waitFor('Select view');
          run.pty.write('\r');
        }
        if (args.length === 1 && args[0] === 'status') {
          await run.waitFor('Select workload');
          run.pty.write(id);
          await run.waitFor(new RegExp(`❯\\s+${id}`));
          run.pty.write('\r');
        }
        const result = await expectCleanExit(run.exit, 20_000);
        expect(result.exitCode).toBe(0);
        expect(run.output()).toContain(
          args[0] === 'list' ? id : 'nginx:latest',
        );
      } finally {
        try {
          run.pty.kill();
        } catch {
          // The process has already exited.
        }
      }
    }
  });

  it('renders both seeded workloads, narrows on typed filter, exits on Ctrl-C', async () => {
    const nginxId = `pty-nginx-${Date.now()}`;
    const redisId = `pty-redis-${Date.now()}`;
    await seedWorkload(nginxId, 'nginx:latest');
    await seedWorkload(redisId, 'redis:7');

    const run = spawnCli(['status']);

    try {
      await run.waitFor('Select workload');
      // Both IDs appear in the initial autocomplete frame.
      await run.waitFor(
        new RegExp(
          `${nginxId}[\\s\\S]*${redisId}|${redisId}[\\s\\S]*${nginxId}`,
        ),
      );

      // Typing into the autocomplete invokes `suggestFilter` live (the same
      // function unit-tested in output.spec.ts, but here exercised via real
      // raw-mode input and a real redraw). After typing "redis" the rendered
      // choice list should contain redis but not nginx.
      // Typing "redis" runs suggestFilter live. The autocomplete moves the
      // highlight onto the first match — which must be redis (nginx's title
      // doesn't contain "redis"). Asserting on the highlight position is a
      // robust positive signal that the filter ran and pruned the candidate
      // set, without needing to reason about terminal redraw byte order in
      // the cumulative buffer.
      run.pty.write('redis');
      await run.waitFor(new RegExp(`❯\\s+${redisId}`));

      run.pty.write('\x03');
      const result = await expectCleanExit(run.exit);
      expect(result).toBeDefined();
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  });
});

describe('status — watch mode (PTY)', () => {
  it('redraws human status in a TTY and exits when the workload becomes terminal', async () => {
    const id = `pty-watch-${Date.now()}`;
    await seedWorkload(id, 'busybox:latest', {
      state: WorkloadState.Running,
    });

    const run = spawnCli(['status', id, '--watch', '--interval', '1']);

    try {
      await run.waitFor('running');
      await updateWorkloadState(id, WorkloadState.Completed);
      await run.waitFor('completed', 15000);

      const result = await expectCleanExit(run.exit, 20000);
      expect(result.exitCode).toBe(0);
      expect(run.output()).toContain('completed');
      expect(run.output()).not.toContain('{"workload":');
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  });

  it('exits 130 without an API error when interrupted with Ctrl-C', async () => {
    const id = `pty-watch-interrupt-${Date.now()}`;
    await seedWorkload(id, 'busybox:latest', {
      state: WorkloadState.Running,
    });

    const run = spawnCli(['status', id, '--watch', '--interval', '1']);

    try {
      await run.waitFor('running');
      run.pty.write('\x03');

      const result = await expectCleanExit(run.exit, 10000);
      expect(result.exitCode).toBe(130);
      expect(run.output()).not.toContain('Failed to fetch status');
      expect(run.output()).not.toContain('No local API is running');
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  });

  it('exits 130 when interrupted after selecting a workload and starting the watch', async () => {
    const id = `pty-watch-picker-${Date.now()}`;
    await seedWorkload(id, 'busybox:latest', {
      state: WorkloadState.Running,
    });

    const run = spawnCli(['status', '--watch', '--interval', '1']);

    try {
      await run.waitFor('Select workload');
      run.pty.write(id);
      await run.waitFor(new RegExp(`❯\\s+${id}`));
      run.pty.write('\r');
      // "Disk Size" is rendered by status, but not by the picker. Waiting for
      // it ensures Ctrl-C lands after the watch has installed its handlers.
      await run.waitFor('Disk Size');
      run.pty.write('\x03');

      const result = await expectCleanExit(run.exit, 10000);
      expect(result.exitCode).toBe(130);
      expect((await requireTestWorkload(id)).state).toBe(WorkloadState.Running);
      expect(run.output()).not.toContain('Failed to fetch status');
      expect(run.output()).not.toContain('No local API is running');
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  });
});

describe('list — summary view picker (PTY)', () => {
  it('defaults to all jobs on Enter and can narrow to a selected state', async () => {
    const now = Date.now();
    const allRunningId = `pty-list-all-running-${now}`;
    const allCompletedId = `pty-list-all-completed-${now}`;
    await seedWorkload(allRunningId, 'nginx:latest', {
      state: WorkloadState.Running,
    });
    await seedWorkload(allCompletedId, 'redis:7', {
      state: WorkloadState.Completed,
    });

    const allRun = spawnCli(['list']);
    try {
      await allRun.waitFor('Select view');
      allRun.pty.write('\r');
      const result = await expectCleanExit(allRun.exit, 20000);
      expect(result.exitCode).toBe(0);
      const output = allRun.output();
      expect(output).toContain(allRunningId);
      expect(output).toContain(allCompletedId);
    } finally {
      try {
        allRun.pty.kill();
      } catch {
        // already exited
      }
    }

    const stateRunId = `pty-list-state-running-${now}`;
    const stateCompletedId = `pty-list-state-completed-${now}`;
    await seedWorkload(stateRunId, 'busybox:latest', {
      state: WorkloadState.Running,
    });
    await seedWorkload(stateCompletedId, 'alpine:latest', {
      state: WorkloadState.Completed,
    });

    const stateRun = spawnCli(['list']);
    try {
      await stateRun.waitFor('Select view');
      stateRun.pty.write('\x1b[A'.repeat(2));
      await stateRun.waitFor(/❯\s+✅ completed/);
      stateRun.pty.write('\r');
      const result = await expectCleanExit(stateRun.exit, 20000);
      expect(result.exitCode).toBe(0);
      const output = stateRun.output();
      expect(output).toContain(stateCompletedId);
      expect(output).not.toContain(stateRunId);
    } finally {
      try {
        stateRun.pty.kill();
      } catch {
        // already exited
      }
    }
  });
});

describe('terminate — multi-select autocomplete (PTY)', () => {
  it('schedules the selected workload cleanup, which completes Terminated', async () => {
    const id = `pty-term-${Date.now()}`;
    await seedWorkload(id, 'busybox:latest');
    expect((await requireTestWorkload(id)).state).toBe(WorkloadState.Running);

    const run = spawnCli(['terminate']);

    try {
      await run.waitFor('Select workloads');
      await run.waitFor(id);

      // Multi-select rows are prefixed ◯ (unselected) / ◉ (selected).
      run.pty.write(' ');
      await run.waitFor(/◉/);

      // Confirm the selection.
      run.pty.write('\r');
      await run.waitFor(`Terminating: ${id}`, 20000);
      await run.waitFor('Workload termination scheduled successfully!');

      const result = await expectCleanExit(run.exit, 20000);
      expect(result.exitCode).toBe(0);
      await expectScheduledTerminationThenComplete(id);
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  });
});

describe('api create — management VM pickers (PTY)', () => {
  // Never a real cloud: the CLI drives the cloud's own CLI, so `aws` is a
  // fake that is signed out, PATH holds nothing else, and AWS's credential
  // env is cleared. GitHub is a local fake that names the account, so the
  // run reaches the seed's account discovery deterministically.
  let github: ReturnType<typeof createServer>;
  let githubUrl = '';
  let clis: FakeCloudClis;

  beforeAll(async () => {
    github = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify(
          request.url === '/user' ? { id: 4242, login: 'pty-user' } : {},
        ),
      );
    });
    await new Promise<void>((resolveListen) =>
      github.listen(0, '127.0.0.1', resolveListen),
    );
    githubUrl = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
    clis = installFakeCloudClis({
      aws: [
        {
          match: ['sts', 'get-caller-identity'],
          stderr: 'Unable to locate credentials',
          exitCode: 253,
        },
      ],
    });
  });

  afterAll(async () => {
    clis.cleanup();
    await new Promise((resolveClose) => github.close(resolveClose));
  });

  it('picks the VM type and a region that offers it, then stops at the signed-out cloud CLI', async () => {
    const run = spawnCli(['api', 'create', 'pty-cluster', '--cloud', 'aws'], {
      setup: ({ env }) => {
        env.PATH = clis.env.PATH!;
        for (const key of Object.keys(env)) {
          if (key.startsWith('AWS_')) delete env[key];
        }
        env.IS_TEST = 'true';
        env.ANYCLOUD_GITHUB_URL = githubUrl;
      },
    });
    try {
      await run.waitFor('Pick a VM type', 20000);
      run.pty.write('t3.medium');
      await run.waitFor(/❯[^\n]*t3\.medium/);
      run.pty.write('\r');

      await run.waitFor('Pick a region', 20000);
      run.pty.write('us-east-2');
      await run.waitFor(/❯\s*us-east-2/);
      run.pty.write('\r');

      await run.waitFor(
        "aws isn't signed in (Unable to locate credentials)",
        20000,
      );
      const result = await expectCleanExit(run.exit, 20000);
      expect(result.exitCode).toBe(1);
      // Only the fake answered, and nothing went past account discovery.
      expect(clis.calls().map((call) => call.args.slice(0, 2))).toEqual([
        ['sts', 'get-caller-identity'],
      ]);
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  });
});

describe('submit — interactive compute picker (PTY)', () => {
  it('no --vm-type drives the real compute picker, skips spot for Lambda, lands a concrete vmType', async () => {
    const credName = await seedLambdaCredential();
    const workloadId = `pty-pick-${Date.now()}`;

    // No --vm-type/--gpu-type → the compute picker fires. --credentials pins
    // the cloud (Lambda) and skips the credential picker. This whole flow
    // hard-errored before the interactive-submit work, so it doubles as a
    // real-terminal regression guard.
    const run = spawnCli([
      'job',
      'nginx:latest',
      '--id',
      workloadId,
      '--credentials',
      credName,
    ]);

    try {
      await run.waitFor('Pick compute target');
      run.pty.write('\x1b[B');
      await run.waitFor(/❯\s+Pick exact VM type/);
      run.pty.write('\r');

      // Real autocomplete renders; type-to-filter to a Lambda A100 GPU offering.
      await run.waitFor('Pick a VM type');
      run.pty.write('a100');
      await run.waitFor(/❯[^\n]*a100/i);
      run.pty.write('\r');

      // Lambda is non-preemptible (no catalog spot price), so the on-demand/spot
      // prompt must be suppressed — submitting without ever answering a
      // "Pricing model" prompt is the assertion.
      await run.waitFor(`ID: ${workloadId}`, 20000);
      const result = await expectCleanExit(run.exit, 20000);
      expect(result.exitCode).toBe(0);

      const workload = await requireTestWorkload(workloadId);
      // The picker resolved the filtered A100 vmType (concrete, on-demand).
      expect(workload.vmType).toMatch(/a100/i);
      expect(workload.cloudProvider).toBe('Lambda');
      expect(workload.spot).toBe(false);
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  });

  it('typing a CPU family surfaces real matches (regression: t3 → "no matches found")', async () => {
    // Composition guard against the dedupe bug: getCpuOfferings used to collapse
    // CPU instances to the cheapest per (vCPU, memory) shape, so whole families
    // (t3 — beaten by t3a/t4g) vanished from the searchable list and typing "t3"
    // showed "no matches found". This drives the REAL AWS catalog through the
    // REAL picker (no mocks) — the seam the earlier tests stubbed out.
    const credName = await seedAwsCredential();
    const run = spawnCli([
      'job',
      'nginx:latest',
      '--id',
      `pty-search-${Date.now()}`,
      '--credentials',
      credName,
    ]);
    try {
      await run.waitFor('Pricing model');
      run.pty.write('\r');

      await run.waitFor('Pick compute target');
      run.pty.write('\x1b[B');
      await run.waitFor(/❯\s+Pick exact VM type/);
      run.pty.write('\r');

      await run.waitFor('Pick a VM type');
      run.pty.write('t3');
      // A real t3.* row (vmType + specs) must render. On the buggy deduped list,
      // t3 was beaten by t3a/t4g and absent, so the picker showed only "no
      // matches found" and this wait would time out. (We assert the row appears
      // rather than the absence of "no matches found" — the accumulated PTY
      // buffer keeps the transient pre-suggestion frame.)
      await run.waitFor(/t3\.\w[^\n]*vCPU/i);
      expect(run.output()).toMatch(/t3\.\w[^\n]*vCPU/i);
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  });

  it('can submit a portable GPU alias and persist gpu_type without vm_type', async () => {
    const credName = await seedAwsCredential();
    const workloadId = `pty-gpu-alias-${Date.now()}`;
    const run = spawnCli([
      'job',
      'nginx:latest',
      '--id',
      workloadId,
      '--credentials',
      credName,
    ]);

    try {
      await run.waitFor('Pricing model');
      run.pty.write('\x1b[B');
      await run.waitFor(/❯\s+Spot/);
      run.pty.write('\r');

      await run.waitFor('Pick compute target');
      await run.waitFor(/❯\s+Pick by GPU type/);
      run.pty.write('\r');

      const gpuAlias = 'l40s:1';
      const resolvedVmType = resolveVMType(gpuAlias, CloudType.AWS);
      expect(resolvedVmType).not.toBe(gpuAlias);

      await run.waitFor('Pick a GPU type');
      run.pty.write(gpuAlias);
      // The portable alias persists, so this row must describe the same VM
      // type the server will resolve during provisioning.
      await run.waitFor(
        new RegExp(
          `❯[^\\n]*${escapeRegExp(gpuAlias)}[^\\n]*${escapeRegExp(resolvedVmType)}`,
          'i',
        ),
        20000,
      );
      run.pty.write('\r');

      await run.waitFor(`ID: ${workloadId}`, 20000);
      const result = await expectCleanExit(run.exit, 20000);
      expect(result.exitCode).toBe(0);

      const workload = await requireTestWorkload(workloadId);
      expect(workload).toMatchObject({
        gpuType: gpuAlias,
        vmType: null,
      });
      expect(workload.spot).toBe(true);
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  });
});

describe('submit — compute credential selection (PTY)', () => {
  it('prompts among multiple saved credentials when --credentials is omitted', async () => {
    await seedAwsCredential();
    const selectedCredential = await seedAwsCredential();
    const workloadId = `pty-cred-${Date.now()}`;

    const run = spawnCli([
      'job',
      'nginx:latest',
      '--id',
      workloadId,
      '--vm-type',
      't3.micro',
    ]);

    try {
      await run.waitFor('Pick credentials', 30000);
      run.pty.write(selectedCredential);
      await run.waitFor(
        new RegExp(`❯\\s+${escapeRegExp(selectedCredential)}`),
        20000,
      );
      run.pty.write('\r');

      await run.waitFor(`ID: ${workloadId}`, 20000);
      const result = await expectCleanExit(run.exit, 20000);
      expect(result.exitCode).toBe(0);

      const [workload, credential] = await Promise.all([
        requireTestWorkload(workloadId),
        getCredentialSecretStore().getNamedCredential(selectedCredential),
      ]);
      expect(workload.credentialId).toBe(credential?.id);
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  });
});

describe('credentials new — collision against existing name (PTY)', () => {
  it('errors with "already exist" and a non-zero exit when name is taken', async () => {
    // Seed a real credential, then try to create another one with the same
    // name. The CLI's uniqueness check (credentials/new.ts:1184-1190) must
    // refuse and surface the --overwrite hint.
    const existing = await seedLambdaCredential();

    const run = spawnCli(['credentials', 'new']);
    try {
      await run.waitFor('Name for this credential set');
      run.pty.write(`${existing}\r`);

      await run.waitFor(
        new RegExp(`Credentials "${existing}" already exist`),
        15000,
      );
      const result = await expectCleanExit(run.exit, 15000);
      expect(result.exitCode).not.toBe(0);
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Docs/tutorials drift guards
//
// Every case below replays a command from docs/introduction/getting-started.md
// (the provider credential flag forms and the deploy invocation). A flag rename
// in the CLI or a stale flag in the docs makes these fail with "unknown option"
// — the regression we're guarding against.
// ---------------------------------------------------------------------------

describe('docs — credentials new flag forms (PTY)', () => {
  it.each([
    {
      provider: 'aws',
      flags: [
        '--access-key-id',
        'AKIA-DOCS-TEST',
        '--secret-access-key',
        'SECRET-DOCS-TEST',
      ],
      expectInDb: 'AWS',
    },
    {
      provider: 'azure',
      flags: [
        '--application-id',
        'app-docs',
        '--secret',
        'sec-docs',
        '--subscription-id',
        'sub-docs',
        '--directory-id',
        'dir-docs',
      ],
      expectInDb: 'Azure',
    },
    {
      provider: 'gcp',
      flags: [
        '--project-id',
        'proj-docs',
        '--client-email',
        'sa@proj-docs.iam.gserviceaccount.com',
        '--private-key',
        '-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----\\n',
      ],
      expectInDb: 'GCP',
    },
    {
      provider: 'lambda',
      flags: ['--api-key', 'sk-docs-lambda'],
      expectInDb: 'Lambda',
    },
  ])(
    '$provider: the documented `--provider $provider <...flags>` form saves a cred',
    async ({ provider, flags, expectInDb }) => {
      const name = `docs-${provider}-${Date.now()}`;
      const stsCallStart = docsAWSSTSCalls.length;
      const run = spawnCli(
        ['credentials', 'new', name, '--provider', provider, ...flags],
        {
          setup: ({ env }) => {
            if (provider !== 'aws') return;
            env.AWS_ENDPOINT_URL_STS = docsAWSSTSEndpoint;
            env.AWS_REGION = 'us-east-1';
          },
        },
      );
      try {
        await run.waitFor(`Credentials "${name}" saved successfully`, 20000);
        const result = await expectCleanExit(run.exit, 20000);
        expect(result.exitCode).toBe(0);

        if (provider === 'aws') {
          expect(docsAWSSTSCalls.slice(stsCallStart)).toEqual([
            {
              action: 'GetCallerIdentity',
              accessKeyId: 'AKIA-DOCS-TEST',
            },
          ]);
        }

        const listResp = await fetch(
          `http://localhost:${apiPort}/v1/credentials`,
          {
            headers: {
              Authorization: 'Bearer fake-pty-test-token',
              [ANYCLOUD_CLIENT_VERSION_HEADER]: packageJson.version,
            },
          },
        );
        expect(listResp.status).toBe(200);
        const list = (await listResp.json()) as Array<{
          name: string;
          cloudProvider: string;
        }>;
        expect(list.find((c) => c.name === name)?.cloudProvider).toBe(
          expectInDb,
        );
      } finally {
        try {
          run.pty.kill();
        } catch {
          // already exited
        }
      }
    },
  );
});

describe('docs — secrets new (PTY)', () => {
  it('the documented `secrets new <name> KEY=VALUE...` form saves a secret', async () => {
    const name = `docs-secret-${Date.now()}`;
    // Verbatim from docs/reference/cli/secrets.md.
    const run = spawnCli([
      'secrets',
      'new',
      name,
      'HF_TOKEN=hf_docs_test',
      'WANDB_ENTITY=docs',
    ]);
    try {
      await run.waitFor(/saved|created/i, 20000);
      const result = await expectCleanExit(run.exit, 20000);
      expect(result.exitCode).toBe(0);

      const listResp = await fetch(`http://localhost:${apiPort}/v1/secrets`, {
        headers: {
          Authorization: 'Bearer fake-pty-test-token',
          [ANYCLOUD_CLIENT_VERSION_HEADER]: packageJson.version,
        },
      });
      expect(listResp.status).toBe(200);
      const list = (await listResp.json()) as Array<{ name: string }>;
      expect(list.find((s) => s.name === name)).toBeDefined();
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  });
});

describe('docs — terminate <id> non-interactive (PTY)', () => {
  it('the documented form schedules cleanup which completes Terminated', async () => {
    const id = `docs-term-${Date.now()}`;
    await seedWorkload(id, 'busybox:latest');
    expect((await requireTestWorkload(id)).state).toBe(WorkloadState.Running);

    // Documented explicit id path, bypassing the multi-select picker that we
    // cover separately.
    const run = spawnCli(['terminate', id]);
    try {
      await run.waitFor(`Terminating: ${id}`, 20000);
      await run.waitFor('Workload termination scheduled successfully!');
      const result = await expectCleanExit(run.exit, 20000);
      expect(result.exitCode).toBe(0);
      await expectScheduledTerminationThenComplete(id);
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  });
});

describe('docs — submit deploy invocation (PTY)', () => {
  it('the getting-started.md submit form lands a workload with every flag reflected', async () => {
    const credName = await seedAwsCredential();
    const workloadId = `docs-deploy-${Date.now()}`;

    // Mirrors docs/introduction/getting-started.md's CLI deploy snippet.
    const run = spawnCli([
      'job',
      'pytorch/pytorch:2.2.0-cuda12.1-cudnn8-runtime',
      '--id',
      workloadId,
      '--credentials',
      credName,
      '--gpu-type',
      'h100',
      '--gpus',
      'all',
      '--',
      'python',
      '-c',
      "import torch; print('CUDA available:', torch.cuda.is_available())",
    ]);

    try {
      await run.waitFor(`ID: ${workloadId}`, 20000);
      const result = await expectCleanExit(run.exit, 20000);
      expect(result.exitCode).toBe(0);

      const workload = await requireTestWorkload(workloadId);
      expect(workload).toMatchObject({
        image: 'pytorch/pytorch:2.2.0-cuda12.1-cudnn8-runtime',
        gpuType: 'h100',
        dockerOptions: { gpus: 'all' },
      });
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  });
});

describe('docs — catalog query commands (PTY)', () => {
  // Replays each documented invocation from docs/reference/cli/catalog-pricing.md
  // and the changelog entries for the catalog refactor. beforeAll fetched
  // real catalog CSVs from anycloud-sh/catalog so we can assert value-level
  // shape, not just exit-0 — this is the only test layer that exercises the
  // CLI → shared/catalog/queries → readCatalog → parseCatalogCSV pipeline
  // end to end. Unit specs all mock at least one of those boundaries.
  //
  // Targets chosen for stability: us-east-1 and t3.micro have existed for
  // years; p5.48xlarge / h100 may exist in fewer regions but the filter
  // path should still find non-empty results.
  it.each<{
    label: string;
    args: string[];
    check: (parsed: unknown) => void;
  }>([
    {
      label: 'regions aws',
      args: ['regions', 'aws'],
      check: (p) => {
        expect(Array.isArray(p)).toBe(true);
        const arr = p as string[];
        expect(arr).toContain('us-east-1');
        expect(arr.length).toBeGreaterThan(10);
      },
    },
    {
      label: 'regions aws --vm-type p5.48xlarge --spot',
      args: ['regions', 'aws', '--vm-type', 'p5.48xlarge', '--spot'],
      check: (p) => {
        expect(Array.isArray(p)).toBe(true);
        expect((p as unknown[]).length).toBeGreaterThan(0);
      },
    },
    {
      label: 'vm-types aws us-east-1',
      args: ['vm-types', 'aws', 'us-east-1'],
      check: (p) => {
        expect(Array.isArray(p)).toBe(true);
        expect(p as string[]).toContain('t3.micro');
      },
    },
    {
      label: 'vm-types aws us-east-1 --accelerator h100',
      args: ['vm-types', 'aws', 'us-east-1', '--accelerator', 'h100'],
      check: (p) => {
        expect(Array.isArray(p)).toBe(true);
        expect((p as unknown[]).length).toBeGreaterThan(0);
      },
    },
    {
      label: 'gpus aws',
      args: ['gpus', 'aws'],
      check: (p) => {
        expect(Array.isArray(p)).toBe(true);
        expect((p as unknown[]).length).toBeGreaterThan(0);
      },
    },
    {
      // Lowercase per the docs (`cli-reference.md:36/74`). `getGpuOfferings`
      // in `shared/catalog/queries.ts` uppercases the filter before matching
      // against catalog keys (which are stored uppercase).
      label: 'gpus aws --type h100',
      args: ['gpus', 'aws', '--type', 'h100'],
      check: (p) => {
        expect(Array.isArray(p)).toBe(true);
        expect((p as unknown[]).length).toBeGreaterThan(0);
      },
    },
    {
      // Catches a GCP catalog join regression: the published catalog must link
      // each accelerator price component to a Compute Engine machine type.
      label: 'gpus gcp',
      args: ['gpus', 'gcp'],
      check: (p) => {
        expect(Array.isArray(p)).toBe(true);
        const offerings = p as Array<{ gpu: string; count: number }>;
        expect(offerings.some((o) => o.gpu === 'H100' && o.count === 8)).toBe(
          true,
        );
      },
    },
    {
      label: 'gpus azure',
      args: ['gpus', 'azure'],
      check: (p) => {
        expect(Array.isArray(p)).toBe(true);
        expect((p as unknown[]).length).toBeGreaterThan(0);
      },
    },
    {
      label: 'gpus lambda',
      args: ['gpus', 'lambda'],
      check: (p) => {
        expect(Array.isArray(p)).toBe(true);
        expect((p as unknown[]).length).toBeGreaterThan(0);
      },
    },
    {
      label: 'pricing aws p5.48xlarge',
      args: ['pricing', 'aws', 'p5.48xlarge'],
      check: (p) => {
        // getPricing returns { vmType, spot, regions: [{region, pricePerHour}] }
        // (sorted cheapest-first).
        expect(p).toBeTypeOf('object');
        expect(p).not.toBeNull();
        const obj = p as {
          vmType: string;
          spot: boolean;
          regions: { region: string; pricePerHour: number }[];
        };
        expect(obj.vmType).toBe('p5.48xlarge');
        expect(typeof obj.spot).toBe('boolean');
        expect(Array.isArray(obj.regions)).toBe(true);
        expect(obj.regions.length).toBeGreaterThan(0);
        expect(
          obj.regions.every(
            (r) =>
              typeof r.region === 'string' &&
              typeof r.pricePerHour === 'number' &&
              r.pricePerHour > 0,
          ),
        ).toBe(true);
      },
    },
  ])(
    '`anycloud $label --json` returns documented shape',
    async ({ args, check }) => {
      const run = spawnCli([...args, '--json']);
      try {
        const result = await expectCleanExit(run.exit, 20000);
        expect(result.exitCode).toBe(0);
        check(parseJsonStdout(run.output()));
      } finally {
        try {
          run.pty.kill();
        } catch {
          // already exited
        }
      }
    },
  );
});

describe('docs — throttle + budget (PTY)', () => {
  // The in-process API + DB are shared across describes, so reset the
  // spend-controls tables between cases. Tiny tables (≤ 2 throttles, ≤ 6
  // budgets) — a DELETE is cheaper than spinning up a fresh DB.
  async function resetSpendControls(): Promise<void> {
    const { getDB } = await import('../../src/api/services/repositories/db.js');
    await getDB().query('DELETE FROM throttles');
    await getDB().query('DELETE FROM budgets');
  }

  async function runOnce(args: string[], timeoutMs = 15000): Promise<string> {
    const run = spawnCli(args);
    try {
      const result = await expectCleanExit(run.exit, timeoutMs);
      expect(result.exitCode).toBe(0);
      return run.output();
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  }

  it('throttle set / show / unset round-trips both scopes', async () => {
    await resetSpendControls();

    // Account-wide cap.
    let out = await runOnce(['throttle', 'set', '50']);
    expect(out).toMatch(/Throttle set.*\$50\/hr.*account-wide/);

    out = await runOnce(['throttle', 'show']);
    expect(out).toMatch(/account:/);
    expect(out).toMatch(/\$50\/hr cap/);

    // Per-agent-session cap coexists.
    await runOnce(['throttle', 'set', '5', '--agent-session']);
    out = await runOnce(['throttle', 'show']);
    expect(out).toMatch(/agent-session:/);
    expect(out).toMatch(/account:/);

    // Unset account leaves agent-session in place.
    await runOnce(['throttle', 'unset']);
    out = await runOnce(['throttle', 'show']);
    expect(out).not.toMatch(/account:/);
    expect(out).toMatch(/agent-session:/);

    // Unset agent-session empties the list.
    await runOnce(['throttle', 'unset', '--agent-session']);
    out = await runOnce(['throttle', 'show']);
    expect(out).toMatch(/No throttles set/);
  });

  it('budget set / show / unset round-trips all four periods × scopes', async () => {
    await resetSpendControls();

    let out = await runOnce(['budget', 'set', '100', '--per', 'day']);
    expect(out).toMatch(/Budget set.*\$100 per day.*account-wide/);

    out = await runOnce(['budget', 'show']);
    expect(out).toMatch(/day \(account\)/);
    expect(out).toMatch(/\$100/);

    // Three more budgets — week, month, day-per-session.
    await runOnce(['budget', 'set', '500', '--per', 'week']);
    await runOnce(['budget', 'set', '2000', '--per', 'month']);
    await runOnce(['budget', 'set', '25', '--per', 'day', '--agent-session']);

    out = await runOnce(['budget', 'show']);
    for (const label of [
      'day (account)',
      'week (account)',
      'month (account)',
      'day (agent-session)',
    ]) {
      expect(out).toContain(label);
    }

    // Scoped unset.
    await runOnce(['budget', 'unset', '--per', 'week']);
    out = await runOnce(['budget', 'show']);
    expect(out).not.toContain('week (account)');
    expect(out).toContain('day (account)');
  });

  it('validation errors exit non-zero with a useful message', async () => {
    await resetSpendControls();

    // `throttle set 0` is rejected by the CLI before any HTTP call.
    const t = spawnCli(['throttle', 'set', '0']);
    try {
      const result = await expectCleanExit(t.exit, 10000);
      expect(result.exitCode).not.toBe(0);
      expect(t.output()).toMatch(/positive integer/);
    } finally {
      try {
        t.pty.kill();
      } catch {
        // already exited
      }
    }

    // `budget set --per yearly` rejected by --per validation.
    const b = spawnCli(['budget', 'set', '100', '--per', 'yearly']);
    try {
      const result = await expectCleanExit(b.exit, 10000);
      expect(result.exitCode).not.toBe(0);
    } finally {
      try {
        b.pty.kill();
      } catch {
        // already exited
      }
    }
  });

  it('throttle set with no args prompts for the cap', async () => {
    await resetSpendControls();

    const run = spawnCli(['throttle', 'set']);
    try {
      await run.waitFor('Throttle cap (USD/hr)');
      run.pty.write('25\r');

      await run.waitFor(/Throttle set.*\$25\/hr.*account-wide/);
      const result = await expectCleanExit(run.exit);
      expect(result.exitCode).toBe(0);

      // Confirm the value actually round-tripped through the API.
      const show = await runOnce(['throttle', 'show']);
      expect(show).toMatch(/account:.*\$25\/hr cap/);
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  });

  it('budget set with no args prompts for cap and period', async () => {
    await resetSpendControls();

    const run = spawnCli(['budget', 'set']);
    try {
      await run.waitFor('Budget cap (USD)');
      run.pty.write('150\r');

      await run.waitFor('Window');
      // Choices order is day (0), week (1), month (2); arrow-down twice
      // moves the highlight onto month before Enter.
      run.pty.write('\x1b[B\x1b[B');
      await run.waitFor(/❯\s+month/);
      run.pty.write('\r');

      await run.waitFor(/Budget set.*\$150 per month/);
      const result = await expectCleanExit(run.exit);
      expect(result.exitCode).toBe(0);
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  });

  it('submit + scheduler tick: throttle keeps the job Queued with a block reason', async () => {
    await resetSpendControls();

    // No monitor runs in this spec's beforeAll, so deploy() never gets a
    // chance to fire on its own. Spy on it anyway so an accidental dispatch
    // (e.g. throttle gate regression) shows up as a test failure rather than
    // a hung Lambda HTTP call.
    const startup = await import(
      '../../src/api/services/workload-workflows/vm-host-startup.js'
    );
    const deploySpy = vi.spyOn(startup, 'deploy').mockResolvedValue(undefined);

    try {
      const credName = await seedLambdaCredential();
      const workloadId = `pty-throttled-${Date.now()}`;

      // $1/hr cap. The Lambda gpu_1x_a10 catalog price is > $1/hr, so the
      // candidate's pre-charge alone trips the gate (rate=$0 + candidate ≥ $1).
      await runOnce(['throttle', 'set', '1']);

      // Submit a real job. Submit returns once the workload row is
      // persisted as Queued — the scheduler hasn't ticked yet.
      const submit = spawnCli([
        'job',
        'nginx:latest',
        '--id',
        workloadId,
        '--credentials',
        credName,
        '--region',
        'us-east-1',
        '--vm-type',
        'gpu_1x_a10',
      ]);
      try {
        await submit.waitFor(`ID: ${workloadId}`, 20000);
        const r = await expectCleanExit(submit.exit, 20000);
        expect(r.exitCode).toBe(0);
      } finally {
        try {
          submit.pty.kill();
        } catch {
          // already exited
        }
      }

      // Sanity: queued pre-tick.
      expect((await requireTestWorkload(workloadId)).state).toBe(
        WorkloadState.Queued,
      );

      // Tick the scheduler in-process — throttle gate must block the dispatch.
      const { runProvisioningSchedulerOnce } = await import(
        '../../src/api/services/monitor.js'
      );
      await runProvisioningSchedulerOnce();

      // Still queued, deploy() never invoked for *this* workload. Other
      // queued rows from prior tests in the same file may dispatch in this
      // tick, so filter by id.
      expect((await requireTestWorkload(workloadId)).state).toBe(
        WorkloadState.Queued,
      );
      const callsForMine = deploySpy.mock.calls.filter(
        ([, , workload]) =>
          (workload as { id?: string } | undefined)?.id === workloadId,
      );
      expect(callsForMine).toHaveLength(0);

      // The block reason surfaces via `anycloud list --json` on latestMessage.
      const listOut = await runOnce(['list', '--json']);
      const parsed = parseJsonStdout(listOut) as Array<{
        id: string;
        state: string;
        latestMessage: string | null;
      }>;
      const row = parsed.find((d) => d.id === workloadId);
      expect(row?.state).toBe('queued');
      expect(row?.latestMessage).toMatch(/throttle/);
    } finally {
      deploySpy.mockRestore();
    }
  });
});

describe('docs — notifications enable slack (PTY)', () => {
  // `enable slack` now hands the webhook to the API, which posts the test
  // message before storing it. That POST leaves this process, not the PTY
  // child, so intercept fetch here rather than preloading the child. The CLI
  // refuses any webhook host other than hooks.slack.com, so it cannot simply be
  // pointed at localhost.
  const WEBHOOK =
    'https://hooks.slack.com/services/T_FAKE/B_FAKE/test_token_xyz';
  let realFetch: typeof globalThis.fetch;
  let slackPosts: string[];

  beforeAll(() => {
    realFetch = globalThis.fetch;
    slackPosts = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.startsWith('https://hooks.slack.com/')) {
        slackPosts.push(url);
        return new Response('ok', { status: 200 });
      }
      return realFetch(input, init);
    };
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it('enable slack with no args prompts for the webhook URL and stores it on the API', async () => {
    const run = spawnCli(['notifications', 'enable', 'slack']);
    try {
      await run.waitFor('Slack incoming-webhook URL');
      run.pty.write(`${WEBHOOK}\r`);

      await run.waitFor(/slack notifications enabled/, 20000);
      const result = await expectCleanExit(run.exit, 20000);
      expect(result.exitCode).toBe(0);

      // The API posted the verification message, proving delivery from where
      // notifications actually originate.
      expect(slackPosts).toContain(WEBHOOK);

      // The webhook reached the API rather than a file beside the CLI, and
      // comes back masked.
      const listResp = await realFetch(
        `http://localhost:${apiPort}/v1/notifications`,
        {
          headers: {
            Authorization: 'Bearer fake-pty-test-token',
            [ANYCLOUD_CLIENT_VERSION_HEADER]: packageJson.version,
          },
        },
      );
      expect(listResp.status).toBe(200);
      const channels = (await listResp.json()) as Array<{
        channel: string;
        webhook: string;
      }>;
      expect(channels).toHaveLength(1);
      expect(channels[0].channel).toBe('slack');
      expect(channels[0].webhook).not.toContain('test_token_xyz');

      expect(existsSync(join(run.cwd, '.anycloud', 'notifications.json'))).toBe(
        false,
      );
      expect(run.output()).not.toContain(WEBHOOK);
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  });

  it('rejects a non-Slack webhook URL at the prompt', async () => {
    const run = spawnCli(['notifications', 'enable', 'slack']);
    try {
      await run.waitFor('Slack incoming-webhook URL');
      run.pty.write('https://example.com/hook\r');
      await run.waitFor(
        /Must be a valid https:\/\/hooks\.slack\.com\/services\/\.\.\. URL/,
      );
      run.pty.write('\x03'); // Ctrl-C — exit the prompt
      expect((await expectCleanExit(run.exit, 10000)).exitCode).toBe(0);
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  });
});

describe('docs — cost aggregate (PTY)', () => {
  // `cost` aggregates the workloads table, not the catalog. It belongs
  // separately. docs/changelog.md:38 enumerates the exact field set — that's
  // the docs-drift catch we want.
  it('`anycloud cost --json` emits the documented aggregate object', async () => {
    const run = spawnCli(['cost', '--json']);
    try {
      const result = await expectCleanExit(run.exit, 20000);
      expect(result.exitCode).toBe(0);
      const parsed = parseJsonStdout(run.output());
      if (!isRecord(parsed)) {
        throw new TypeError('Cost output must be a JSON object.');
      }
      for (const field of [
        'periodMs',
        'totalCost',
        'totalDurationMs',
        'totalJobs',
        'totalServices',
        'workloadsWithoutPrice',
      ]) {
        expect(typeof parsed[field]).toBe('number');
      }
      expect(parsed.byProvider).not.toBeNull();
      expect(parsed.byProvider).not.toBeUndefined();
    } finally {
      try {
        run.pty.kill();
      } catch {
        // already exited
      }
    }
  });
});

describe('login — GitHub device flow', () => {
  // A fake github.com and api.github.com; ANYCLOUD_GITHUB_URL points the CLI here.
  const deviceCodeRequests: unknown[] = [];
  const tokenRequests: unknown[] = [];
  const userRequests: unknown[] = [];
  // GitHub's answer to a token request, until the user approves ('approved').
  let tokenAnswer = 'authorization_pending';
  let expiresIn = 60;
  let github: ReturnType<typeof createServer>;
  let githubUrl = '';
  const deviceCode = () => `device-code-${deviceCodeRequests.length}`;
  const userCode = () => `ABCD-000${deviceCodeRequests.length}`;

  function answer(response: ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }

  async function handleGitHub(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const body = await readRequestBody(request);
    if (request.method === 'POST' && request.url === '/login/device/code') {
      deviceCodeRequests.push(parseJson(body));
      return answer(response, 200, {
        device_code: deviceCode(),
        user_code: userCode(),
        verification_uri: `${githubUrl}/login/device`,
        expires_in: expiresIn,
        interval: 0,
      });
    }
    if (
      request.method === 'POST' &&
      request.url === '/login/oauth/access_token'
    ) {
      const exchange = parseJson(body);
      tokenRequests.push(exchange);
      if (
        !isRecord(exchange) ||
        exchange.device_code !== deviceCode() ||
        exchange.grant_type !== 'urn:ietf:params:oauth:grant-type:device_code'
      ) {
        return answer(response, 400, { error: 'bad_verification_code' });
      }
      return answer(
        response,
        200,
        tokenAnswer === 'approved'
          ? { access_token: 'gho_login-test' }
          : { error: tokenAnswer, interval: 0 },
      );
    }
    if (request.method === 'GET' && request.url === '/user') {
      userRequests.push(request.headers.authorization);
      return request.headers.authorization === 'Bearer gho_login-test'
        ? answer(response, 200, { login: 'test-user' })
        : answer(response, 401, { message: 'Bad credentials' });
    }
    answer(response, 404, { message: 'Not Found' });
  }

  beforeAll(async () => {
    github = createServer((request, response) => {
      void handleGitHub(request, response);
    });
    await new Promise<void>((resolveListen) =>
      github.listen(0, '127.0.0.1', resolveListen),
    );
    githubUrl = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    deviceCodeRequests.length = 0;
    tokenRequests.length = 0;
    userRequests.length = 0;
    tokenAnswer = 'authorization_pending';
    expiresIn = 60;
  });

  afterAll(async () => {
    await new Promise((resolveClose) => github.close(resolveClose));
  });

  // Starts from no token file, or from a world-readable one left by an
  // earlier login; either way the saved token is readable only by its owner.
  it.each([false, true])(
    'requests only read:org read:packages (existing token file: %s)',
    async (existing) => {
      tokenAnswer = 'approved';
      const run = spawnCli(['login'], {
        setup: ({ cwd, env }) => {
          if (existing) {
            writeFileSync(join(cwd, '.token'), 'gho_old', { mode: 0o644 });
          }
          env.IS_TEST = 'true';
          env.ANYCLOUD_GITHUB_URL = githubUrl;
          delete env.DISPLAY;
          delete env.WAYLAND_DISPLAY;
          delete env.GITHUB_TOKEN;
        },
      });
      try {
        await run.waitFor('Token saved successfully', 20000);
        const result = await expectCleanExit(run.exit, 20000);
        expect(result.exitCode).toBe(0);
        expect(deviceCodeRequests).toEqual([
          {
            client_id: 'Ov23liaPWSFbk7P7XDEY',
            scope: 'read:org read:packages',
          },
        ]);
        expect(readFileSync(join(run.cwd, '.token'), 'utf8')).toBe(
          'gho_login-test',
        );
        expect(statSync(join(run.cwd, '.token')).mode & 0o777).toBe(0o600);
      } finally {
        try {
          run.pty.kill();
        } catch {
          // already exited
        }
      }
    },
    60000,
  );

  // Piped stdout, as an agent's shell runs it. A login that keeps polling
  // after printing is killed and exits null, not 1.
  function runPiped(
    context: SpawnCliContext,
    args: string[],
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolveRun) => {
      const child = spawnProcess(process.execPath, [resolve(CLI), ...args], {
        cwd: context.cwd,
        env: { ...context.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5_000,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('close', (code) => resolveRun({ code, stdout, stderr }));
    });
  }

  function signInContext(): SpawnCliContext {
    const context = cliContext();
    context.env.IS_TEST = 'true';
    context.env.ANYCLOUD_GITHUB_URL = githubUrl;
    delete context.env.GITHUB_TOKEN;
    return context;
  }

  // An agent's shell: its marker env and no terminal.
  function agentContext(): SpawnCliContext {
    const context = signInContext();
    context.env.CLAUDECODE = '1';
    return context;
  }

  const pendingPath = (context: SpawnCliContext) =>
    join(context.cwd, 'github-device.json');

  // What the agent relays: the latest URL and user code, and when they expire.
  function expectRelayed(output: string): void {
    const line = output
      .split(/\r?\n/)
      .find((l) => l.includes('actionRequired'));
    const parsed = parseJson(line ?? '');
    const code = userCode();
    expect(parsed).toMatchObject({
      actionRequired: {
        code: 'GITHUB_SIGN_IN_REQUIRED',
        url: `${githubUrl}/login/device?user_code=${code}`,
        userCode: code,
      },
    });
    const relayed = isRecord(parsed) ? parsed.actionRequired : undefined;
    expect(isRecord(relayed) && String(relayed.message)).toContain(code);
    expect(
      isRecord(relayed) && Date.parse(String(relayed.expiresAt)),
    ).toBeGreaterThan(Date.now());
  }

  // Nothing the CLI wrote besides the pending file holds a device code.
  function expectNoDeviceCodeOutside(context: SpawnCliContext, output: string) {
    expect(output).not.toContain('device-code');
    const files = readdirSync(context.cwd, {
      recursive: true,
      encoding: 'utf8',
    })
      .filter((f) => !f.startsWith('catalogs') && f !== 'github-device.json')
      .map((f) => join(context.cwd, f))
      .filter((f) => statSync(f).isFile());
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('device-code');
    }
  }

  it('agent-mode login relays the code and the next command completes the sign-in', async () => {
    const context = agentContext();
    const tokenPath = join(context.cwd, '.token');
    let output = '';

    for (const attempt of [1, 2]) {
      const login = await runPiped(context, ['login']);
      output += login.stdout + login.stderr;
      expect(login.code, `attempt ${attempt}: ${login.stderr}`).toBe(1);
      expectRelayed(login.stdout);
      expect(statSync(pendingPath(context)).mode & 0o777).toBe(0o600);
    }
    // The second login checks the pending code once and relays it again.
    expect(deviceCodeRequests).toHaveLength(1);
    expect(tokenRequests).toHaveLength(1);
    expect(existsSync(tokenPath)).toBe(false);

    tokenAnswer = 'approved';
    const next = await runPiped(context, ['list', '--json']);
    output += next.stdout + next.stderr;
    expect(next.code, next.stderr).toBe(0);
    expect(tokenRequests).toHaveLength(2);
    expect(readFileSync(tokenPath, 'utf8')).toBe('gho_login-test');
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(existsSync(pendingPath(context))).toBe(false);

    // Signed in with a token GitHub accepts: nothing to relay.
    const again = await runPiped(context, ['login']);
    output += again.stdout + again.stderr;
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).not.toContain('actionRequired');
    expect(deviceCodeRequests).toHaveLength(1);
    expect(userRequests).toEqual(['Bearer gho_login-test']);
    expectNoDeviceCodeOutside(context, output);
  }, 60_000);

  // Agents in a terminal relay; Cursor's own terminals and Aider don't.
  it.each([
    ['CLAUDECODE', true],
    ['CURSOR_AGENT', true],
    ['CURSOR_TRACE_ID', false],
    ['AIDER_MODEL', false],
  ])(
    'under a terminal with %s set, relays: %s',
    async (marker, relays) => {
      tokenAnswer = 'approved';
      const run = spawnCli(['login'], {
        setup: ({ env }) => {
          env.IS_TEST = 'true';
          env.ANYCLOUD_GITHUB_URL = githubUrl;
          env[marker] = '1';
          delete env.GITHUB_TOKEN;
          delete env.DISPLAY;
          delete env.WAYLAND_DISPLAY;
        },
      });
      try {
        const result = await expectCleanExit(run.exit, 10_000);
        expect(result.exitCode, run.output()).toBe(relays ? 1 : 0);
        if (relays) expectRelayed(run.output());
        else expect(run.output()).toContain('Token saved successfully');
      } finally {
        try {
          run.pty.kill();
        } catch {
          // already exited
        }
      }
    },
    30_000,
  );

  it("relays instead of waiting when a human's stdout is piped", async () => {
    const { cwd, env } = signInContext();
    const pty = spawn(
      'bash',
      [
        '-c',
        `"${process.execPath}" "${resolve(CLI)}" login | cat; echo "exit=\${PIPESTATUS[0]}"`,
      ],
      { name: 'xterm-256color', cols: 400, rows: 30, cwd, env },
    );
    let output = '';
    pty.onData((data) => (output += data));
    try {
      await expectCleanExit(new Promise((r) => pty.onExit(r)), 10_000);
      expect(stripAnsi(output)).toContain('exit=1');
      expectRelayed(stripAnsi(output));
    } finally {
      try {
        pty.kill();
      } catch {
        // already exited
      }
    }
  }, 30_000);

  it('relays a fresh code once the pending one expires', async () => {
    expiresIn = 1;
    const context = agentContext();
    expect((await runPiped(context, ['login'])).code).toBe(1);
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_100));
    expiresIn = 60;
    const login = await runPiped(context, ['login']);
    expect(login.code, login.stderr).toBe(1);
    expectRelayed(login.stdout);
    expect(deviceCodeRequests).toHaveLength(2);
    expect(tokenRequests).toHaveLength(0);
  }, 30_000);

  it.each([
    ['expired_token', 2],
    ['access_denied', 2],
    ['slow_down', 1],
  ])(
    'after %s, relays the code from device request %i',
    async (answer, n) => {
      const context = agentContext();
      expect((await runPiped(context, ['login'])).code).toBe(1);
      tokenAnswer = answer;
      const login = await runPiped(context, ['login']);
      expect(login.code, login.stderr).toBe(1);
      expectRelayed(login.stdout);
      expect(tokenRequests).toHaveLength(1);
      expect(deviceCodeRequests).toHaveLength(n);
    },
    30_000,
  );

  it('relays a fresh code when the pending file is corrupt', async () => {
    const context = agentContext();
    expect((await runPiped(context, ['login'])).code).toBe(1);
    writeFileSync(pendingPath(context), '{"deviceCode":"dev', { mode: 0o600 });
    const login = await runPiped(context, ['login']);
    expect(login.code, login.stderr).toBe(1);
    expectRelayed(login.stdout);
    expect(deviceCodeRequests).toHaveLength(2);
  }, 30_000);

  it('tells a human at the terminal what to do when stdout is redirected', async () => {
    const { cwd, env } = signInContext();
    const pty = spawn(
      'bash',
      [
        '-c',
        `"${process.execPath}" "${resolve(CLI)}" images --json > out.json`,
      ],
      { name: 'xterm-256color', cols: 400, rows: 30, cwd, env },
    );
    let output = '';
    pty.onData((data) => (output += data));
    try {
      await expectCleanExit(new Promise((r) => pty.onExit(r)), 10_000);
      expect(stripAnsi(output)).toContain(
        `enter the code ${userCode()} to approve it`,
      );
      expectRelayed(readFileSync(join(cwd, 'out.json'), 'utf8'));
    } finally {
      try {
        pty.kill();
      } catch {
        // already exited
      }
    }
  }, 30_000);

  it.each([
    ['gho_login-test', 0],
    ['gho_revoked', 1],
  ])(
    'checks an existing sign-in with GitHub (%s exits %i)',
    async (token, exitCode) => {
      const context = agentContext();
      writeFileSync(join(context.cwd, '.token'), token, { mode: 0o600 });
      const login = await runPiped(context, ['login']);
      expect(login.code, login.stderr).toBe(exitCode);
      expect(userRequests).toEqual([`Bearer ${token}`]);
      expect(deviceCodeRequests).toHaveLength(exitCode);
      if (exitCode) expectRelayed(login.stdout);
    },
    30_000,
  );

  it('runs other commands while GitHub is unreachable', async () => {
    const context = agentContext();
    expect((await runPiped(context, ['login'])).code).toBe(1);
    // A closed port: nothing listens on port 1.
    context.env.ANYCLOUD_GITHUB_URL = 'http://127.0.0.1:1';
    const list = await runPiped(context, ['list', '--json']);
    expect(list.code, list.stderr).toBe(0);
    expect(existsSync(pendingPath(context))).toBe(true);
  }, 30_000);

  it('a command that needs GitHub relays the code instead of dead-ending', async () => {
    const images = await runPiped(agentContext(), ['images', '--json']);
    expect(images.code, images.stderr).toBe(1);
    expectRelayed(images.stdout);
    expect(deviceCodeRequests).toHaveLength(1);
  }, 30_000);

  it("relays the code when the API answers a feature's GITHUB_SIGN_IN_REQUIRED", async () => {
    const credentials = await seedAwsCredential();
    const context = agentContext();
    // A local API's owner without a GitHub sign-in.
    writeLocalApiToken(context.cwd, SIGNED_OUT_BEARER);
    const service = await runPiped(context, [
      'service',
      'nginx:latest',
      '--credentials',
      credentials,
      '--vm-type',
      't3.small',
    ]);
    expect(service.code, service.stderr).toBe(1);
    expectRelayed(service.stdout);
    expect(service.stdout).toContain("A Service's public URL needs");
    // One instruction: relay the code, not the API's own "Run anycloud login".
    expect(service.stdout).not.toContain('anycloud login');
  }, 30_000);
});
