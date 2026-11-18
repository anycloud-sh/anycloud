import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, type IPty } from 'node-pty';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../../slack-worker/src/index.js';
import packageJson from '../../package.json' with { type: 'json' };
import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../../src/shared/api-version.js';
import { startApiServer, type ApiServer } from './api-server.js';
import { writeLocalApiToken } from './helpers/local-api-token.js';
import { installFakeSlack, type FakeSlack } from '../helpers/fake-slack.js';
import { createWorkload } from '../../src/api/services/repositories/workload-creation.js';
import { ProvisioningAttemptStore } from '../../src/api/services/repositories/provisioning-attempts.js';
import {
  getDB,
  type CloseableDB,
} from '../../src/api/services/repositories/db.js';
import { resetPersistence } from '../../src/api/services/persistence.js';
import {
  requestWorkloadCleanup,
  runWorkloadReconcileOnce,
} from '../../src/api/services/monitor.js';
import {
  runVmReleaseNotificationsOnce,
  VM_RELEASE_ALERT_THRESHOLD_MS,
} from '../../src/api/services/vm-release-notifications.js';
import { getDefaultJobRuntime } from '../../src/api/services/job/default-runtime.js';
import { CloudType } from '../../src/shared/cloud.js';
import { WorkloadState } from '../../src/shared/workload.js';
import {
  walkToState,
  provisionTestVm,
  releaseTestVms,
} from '../helpers/workload-store.js';

const CLI = resolve('dist/cli/index.js');
const WEBHOOK =
  'https://hooks.slack.com/services/T_BROWSER/B_BROWSER/browser_token_xyz';
const ENV: Env = {
  SLACK_CLIENT_ID: 'browser-test-client-id',
  SLACK_CLIENT_SECRET: 'browser-test-client-secret',
};

// prompts uses CSI plus ESC 7 / ESC 8 cursor save/restore sequences.
// eslint-disable-next-line no-control-regex
const STRIP_ANSI = /\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_]|[0-?])/g;

interface PtyRun {
  pty: IPty;
  home: string;
  output: () => string;
  waitFor: (needle: RegExp | string, timeoutMs?: number) => Promise<void>;
  exit: Promise<{ exitCode: number; signal?: number }>;
}

function isAddressInfo(
  value: string | AddressInfo | null,
): value is AddressInfo {
  return value !== null && typeof value !== 'string';
}

function buildChildEnv(home: string, apiUrl: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.API_URL = apiUrl;
  env.GITHUB_TOKEN = 'fake-slack-handoff-token';

  const headlessBrowserImport = pathToFileURL(
    resolve('test/integration/helpers/headless-browser.mjs'),
  ).href;
  const preloads = `--import=${headlessBrowserImport}`;

  env.NODE_OPTIONS = env.NODE_OPTIONS
    ? `${env.NODE_OPTIONS} ${preloads}`
    : preloads;
  env.CI = 'false';
  env.HOME = home;
  env.ANYCLOUD_DIR = home;
  writeLocalApiToken(home);
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;

  return env;
}

function spawnConnect(apiUrl: string): PtyRun {
  if (!existsSync(CLI)) {
    throw new Error(`CLI binary not built: ${CLI}. Run 'yarn build' first.`);
  }

  const home = mkdtempSync(join(tmpdir(), 'anycloud-slack-handoff-'));
  // Prevent the unrelated release check from making a network request.
  writeFileSync(
    join(home, 'version-cache.json'),
    `${JSON.stringify({ latestVersion: '0.0.0', lastCheck: Date.now() })}\n`,
    { mode: 0o600 },
  );

  const pty = spawn(
    process.execPath,
    [CLI, 'notifications', 'connect', 'slack'],
    {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: home,
      env: buildChildEnv(home, apiUrl),
    },
  );

  let buffer = '';
  pty.onData((data) => {
    buffer += data;
  });

  const output = () => buffer.replace(STRIP_ANSI, '');
  const exit = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
    pty.onExit(resolve);
  });
  const waitFor = (needle: RegExp | string, timeoutMs = 10_000) =>
    new Promise<void>((resolveWait, reject) => {
      const matches = () => {
        const current = output();
        return typeof needle === 'string'
          ? current.includes(needle)
          : needle.test(current);
      };
      if (matches()) {
        resolveWait();
        return;
      }

      const interval = setInterval(() => {
        if (!matches()) return;
        clearInterval(interval);
        clearTimeout(timeout);
        resolveWait();
      }, 50);
      const timeout = setTimeout(() => {
        clearInterval(interval);
        reject(
          new Error(
            `Timed out waiting for ${String(needle)} after ${timeoutMs}ms.\nOutput:\n${output()}`,
          ),
        );
      }, timeoutMs);
    });

  return { pty, home, output, waitFor, exit };
}

function cleanExit(
  run: PtyRun,
  timeoutMs = 20_000,
): Promise<{ exitCode: number; signal?: number }> {
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`CLI did not exit within ${timeoutMs}ms`)),
      timeoutMs,
    );
    void run.exit.then((result) => {
      clearTimeout(timeout);
      resolveExit(result);
    });
  });
}

function stopRun(run: PtyRun): void {
  try {
    run.pty.kill();
  } catch {
    // The child already exited.
  }
  rmSync(run.home, { recursive: true, force: true });
}

async function createCallbackPage(): Promise<{
  body: string;
  headers: Record<string, string>;
}> {
  const fetchMock = vi.fn(
    (): Promise<Response> =>
      Promise.resolve(
        Response.json({
          ok: true,
          access_token: 'xoxb-browser-test-only',
          incoming_webhook: { url: WEBHOOK },
        }),
      ),
  );
  vi.stubGlobal('fetch', fetchMock);
  const state = 'a'.repeat(64);

  try {
    const response = await worker.fetch(
      new Request(
        `https://slack.anycloud.sh/oauth/callback?code=fake-code&state=${state}`,
        {
          headers: {
            Cookie: `__Host-anycloud_slack_oauth_state=${state}`,
          },
        },
      ),
      ENV,
    );
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { body: await response.text(), headers };
  } finally {
    vi.unstubAllGlobals();
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!isAddressInfo(address)) {
    throw new Error('Slack handoff test server did not bind to a TCP socket');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

describe('Slack browser-to-local-API handoff', () => {
  let browser: Browser;
  let server: Server;
  let origin: string;
  let api: ApiServer;
  let databasePath: string;
  const apiStateDirs = new Set<string>();

  // The API performs the verification post now, so it originates in this
  // process rather than the PTY child. Patch fetch by assignment rather than
  // vi.stubGlobal: createCallbackPage() calls vi.unstubAllGlobals() in its
  // finally, which would otherwise tear this down.
  let realFetch: typeof globalThis.fetch;
  let slack: FakeSlack;

  beforeAll(async () => {
    const callback = await createCallbackPage();
    server = createServer((_request, response) => {
      response.writeHead(200, callback.headers);
      response.end(callback.body);
    });
    origin = await listen(server);
    browser = await chromium.launch({ headless: true });
    api = await startApiServer();
    databasePath = join(api.stateDir, 'api.db');
    apiStateDirs.add(api.stateDir);

    realFetch = globalThis.fetch;
    slack = installFakeSlack();
  }, 60_000);

  afterAll(async () => {
    slack?.restore();
    await browser?.close();
    await api?.close();
    (getDB() as CloseableDB).close();
    resetPersistence();
    if (server?.listening) await closeServer(server);
    vi.unstubAllEnvs();
    for (const stateDir of apiStateDirs) {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('copies one webhook into two concurrent CLI runs', async () => {
    slack.reset();
    const first = spawnConnect(api.url);
    const second = spawnConnect(api.url);
    const context = await browser.newContext();

    try {
      await Promise.all([
        first.waitFor('Slack incoming-webhook URL'),
        second.waitFor('Slack incoming-webhook URL'),
      ]);

      await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
        origin,
      });
      const page = await context.newPage();
      const browserErrors: string[] = [];
      page.on('pageerror', (error) => browserErrors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') browserErrors.push(message.text());
      });

      await page.goto(origin);
      await expect(
        page.locator('[data-webhook]').getAttribute('type'),
      ).resolves.toBe('password');
      await page.locator('[data-copy-webhook]').click();
      await page
        .locator('[data-copy-status]', { hasText: 'Webhook copied' })
        .waitFor();
      const copiedWebhook = await page.evaluate(() =>
        navigator.clipboard.readText(),
      );
      expect(copiedWebhook).toBe(WEBHOOK);
      expect(browserErrors).toEqual([]);

      first.pty.write(`${copiedWebhook}\r`);
      second.pty.write(`${copiedWebhook}\r`);
      await Promise.all([
        first.waitFor('slack notifications enabled'),
        second.waitFor('slack notifications enabled'),
      ]);
      const [firstExit, secondExit] = await Promise.all([
        cleanExit(first),
        cleanExit(second),
      ]);
      expect(firstExit.exitCode).toBe(0);
      expect(secondExit.exitCode).toBe(0);

      // Each run drove a real server-side verification before storing.
      expect(slack.posts.map((post) => post.url)).toEqual([WEBHOOK, WEBHOOK]);

      const response = await realFetch(`${api.url}/v1/notifications`, {
        headers: {
          Authorization: 'Bearer fake-slack-handoff-token',
          [ANYCLOUD_CLIENT_VERSION_HEADER]: packageJson.version,
        },
      });
      expect(response.status).toBe(200);
      const channels = (await response.json()) as Array<{
        channel: string;
        webhook: string;
      }>;

      // Exactly one row after two runs: the second connect replaced the first
      // rather than duplicating it. Length also proves the stored value
      // decrypted, since a row that cannot be read is skipped rather than
      // returned.
      expect(channels).toHaveLength(1);
      expect(channels[0].channel).toBe('slack');

      // Assert the masked form of the webhook that came out of the browser, not
      // merely that the raw token is absent — a negative check would pass if
      // the API had stored some other value entirely.
      expect(channels[0].webhook).toBe(
        'https://hooks.slack.com/services/T_…/B_…/br…',
      );

      // Neither terminal echoed the secret — the point of the hidden prompt.
      expect(first.output()).not.toContain(WEBHOOK);
      expect(second.output()).not.toContain(WEBHOOK);
    } finally {
      await context.close();
      stopRun(first);
      stopRun(second);
    }
  }, 30_000);

  it('selects the webhook when clipboard permission is unavailable', async () => {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => Promise.reject(new Error('denied')),
        },
      });
    });

    try {
      const page = await context.newPage();
      await page.goto(origin);
      await page.locator('[data-copy-webhook]').click();
      await page
        .locator('[data-copy-status]', {
          hasText: 'Copy the selected webhook',
        })
        .waitFor();
      expect(
        await page.locator('[data-webhook]').evaluate((element) => {
          const input = element as HTMLInputElement;
          return {
            active: document.activeElement === input,
            selectionStart: input.selectionStart,
            selectionEnd: input.selectionEnd,
            valueLength: input.value.length,
          };
        }),
      ).toEqual({
        active: true,
        selectionStart: 0,
        selectionEnd: WEBHOOK.length,
        valueLength: WEBHOOK.length,
      });
    } finally {
      await context.close();
    }
  });

  it('persists the aggregate VM-release alert across API restarts', async () => {
    slack.reset();
    const attempts = (): ProvisioningAttemptStore =>
      new ProvisioningAttemptStore(getDB());
    const restartApi = async (): Promise<void> => {
      await api.close();
      (getDB() as CloseableDB).close();
      resetPersistence();
      api = await startApiServer({ sqlitePath: databasePath });
      apiStateDirs.add(api.stateDir);
    };
    const configure = await realFetch(`${api.url}/v1/notifications/slack`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer fake-slack-handoff-token',
        [ANYCLOUD_CLIENT_VERSION_HEADER]: packageJson.version,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ webhook: WEBHOOK }),
    });
    expect(configure.status).toBe(204);

    const seedWorkload = async (
      id: string,
      stampRemoval: boolean,
    ): Promise<void> => {
      await createWorkload(getDB(), {
        id,
        userId: 'alice',
        workloadType: 'job',
        image: 'alpine:latest',
        requestedComputeProvider: CloudType.Local,
        region: 'local',
        vmType: 'local',
        spot: false,
        dockerCommand: 'docker run alpine',
        sshPrivateKey: '',
        credentialId: null,
      });
      await provisionTestVm(id, {
        cloudId: `${id}-vm`,
        ip: '192.0.2.10',
      });
      await walkToState(id, WorkloadState.Completed);
      if (!stampRemoval) return;
      await attempts().claimVmRemoval(id, [`${id}-vm`]);
      await getDB().query(
        `UPDATE vms SET removal_requested_at = ? WHERE workload_id = ?`,
        [Date.now() - VM_RELEASE_ALERT_THRESHOLD_MS, id],
      );
    };

    const cleanup = vi
      .spyOn(getDefaultJobRuntime(), 'cleanup')
      .mockResolvedValue(undefined);
    try {
      const id = 'integration-release-delayed';
      await seedWorkload(id, false);
      let removalStamped!: () => void;
      let releaseProviderCall!: () => void;
      const stamped = new Promise<void>((resolve) => {
        removalStamped = resolve;
      });
      const providerCall = new Promise<void>((resolve) => {
        releaseProviderCall = resolve;
      });
      cleanup.mockImplementationOnce(async () => {
        await attempts().claimVmRemoval(id, [`${id}-vm`]);
        removalStamped();
        await providerCall;
      });

      const pendingReconciliation = runWorkloadReconcileOnce();
      await stamped;
      await getDB().query(
        `UPDATE vms SET removal_requested_at = ? WHERE workload_id = ?`,
        [Date.now() - VM_RELEASE_ALERT_THRESHOLD_MS, id],
      );
      await runVmReleaseNotificationsOnce();
      await runVmReleaseNotificationsOnce();

      expect(slack.posts).toHaveLength(1);
      expect(slack.posts[0].body.text).toContain(
        '*anycloud: VM release delayed*',
      );

      releaseProviderCall();
      await pendingReconciliation;
      await restartApi();
      await runVmReleaseNotificationsOnce();

      expect(slack.posts).toHaveLength(1);
      const [persisted] = await getDB().query<{ value: string }>(
        `SELECT value FROM notification_receipts
         WHERE kind = 'vm-release-alert'`,
      );
      expect(Number(persisted.value)).toBeGreaterThan(0);

      cleanup.mockImplementationOnce(async () => {
        await releaseTestVms(id, `${id}-vm`);
      });
      await requestWorkloadCleanup(id);
      await runWorkloadReconcileOnce();
      await runVmReleaseNotificationsOnce();

      expect(slack.posts).toHaveLength(1);
      await expect(
        getDB().query(
          `SELECT value FROM notification_receipts
           WHERE kind = 'vm-release-alert'`,
        ),
      ).resolves.toEqual([]);

      await restartApi();
      const nextId = 'integration-release-delayed-later';
      await seedWorkload(nextId, true);
      await runVmReleaseNotificationsOnce();

      expect(slack.posts).toHaveLength(2);
      expect(slack.posts[1].body.text).toContain(
        '*anycloud: VM release delayed*',
      );
      expect(slack.posts[1].body.text).not.toContain('still delayed');
    } finally {
      cleanup.mockRestore();
    }
  });
});
