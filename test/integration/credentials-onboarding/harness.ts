import { existsSync } from 'fs';
import { writeFile } from 'fs/promises';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'http';
import { spawn, type IPty } from 'node-pty';
import { resolve } from 'path';
import { setTimeout as sleep } from 'timers/promises';
import packageJson from '../../../package.json' with { type: 'json' };
import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../../../src/shared/api-version.js';
import { retryAfterMs } from '../../../src/shared/retry-after.js';
import { resetStorageCoordinatorForTests } from '../../../src/api/services/gateways/storage-coordinator.js';
import { isRecord, isUnknownArray } from '../helpers/json.js';
import {
  retryUntilDeadline,
  type DeadlineRetryOptions,
} from './common/deadline-retry.js';
import { startApiServer } from '../api-server.js';

const SOURCE_CLI = resolve('dist/cli/index.js');
const BUCKET_LIST_PAGE_SIZE = 1000;

// Strips CSI, Fe, and the private-use save/restore sequences emitted by
// prompts during an in-place redraw.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_]|[0-?])/g;

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const EXIT_TIMEOUT_MS = 30_000;

export async function readRequestBody(
  request: IncomingMessage,
): Promise<Buffer<ArrayBuffer>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) {
      throw new TypeError('HTTP request emitted a non-buffer chunk.');
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export interface CliLauncher {
  executable: string;
  argsPrefix?: string[];
  description?: string;
}

export function sourceCliLauncher(cliPath = SOURCE_CLI): CliLauncher {
  return {
    executable: process.execPath,
    argsPrefix: [cliPath],
    description: `source CLI at ${cliPath}`,
  };
}

export function installedCliLauncher(executable: string): CliLauncher {
  return { executable, description: `installed CLI at ${executable}` };
}

/**
 * Put a failing executable ahead of any host-installed provider CLI. An empty
 * fake bin directory is insufficient on CI runners that preinstall cloud SDKs.
 */
export async function installUnavailableCliShim(
  directory: string,
  command: string,
): Promise<void> {
  await writeFile(resolve(directory, command), '#!/bin/sh\nexit 127\n', {
    mode: 0o755,
  });
}

interface WaitOptions {
  after?: number;
  timeoutMs?: number;
}

export interface PtyRun {
  pty: IPty;
  output: () => string;
  outputSince: (checkpoint: number) => string;
  checkpoint: () => number;
  containsRaw: (value: string) => boolean;
  registerSecret: (value: string) => void;
  waitFor: (
    needle: RegExp | string,
    timeoutOrOptions?: number | WaitOptions,
  ) => Promise<void>;
  exit: Promise<{ exitCode: number; signal?: number }>;
}

export function spawnCliInPty(
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    launcher?: CliLauncher;
  },
): PtyRun {
  const launcher =
    options.launcher ??
    (process.env.ANYCLOUD_TEST_CLI_BINARY
      ? installedCliLauncher(process.env.ANYCLOUD_TEST_CLI_BINARY)
      : sourceCliLauncher());
  const launcherPath = launcher.argsPrefix?.[0] ?? launcher.executable;
  if (launcherPath.includes('/') && !existsSync(launcherPath)) {
    throw new Error(
      `CLI launcher does not exist: ${launcherPath}. Run 'yarn build' first when using the source CLI.`,
    );
  }

  const pty = spawn(
    launcher.executable,
    [...(launcher.argsPrefix ?? []), ...args],
    {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: options.cwd,
      env: options.env,
    },
  );
  let buffer = '';
  const secrets = new Set<string>();
  pty.onData((data) => {
    buffer += data;
  });

  const redact = (value: string): string => {
    let redacted = value;
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
      redacted = redacted.split(secret).join('[REDACTED]');
    }
    return redacted;
  };
  const render = (value: string): string =>
    redact(value.replace(ANSI_ESCAPE, ''));
  const output = () => render(buffer);
  const outputSince = (checkpoint: number) => render(buffer.slice(checkpoint));
  const checkpoint = () => buffer.length;
  const containsRaw = (value: string) => buffer.includes(value);
  const registerSecret = (value: string) => {
    if (value) secrets.add(value);
  };
  const exit = new Promise<{ exitCode: number; signal?: number }>((done) => {
    pty.onExit(done);
  });
  const waitFor = (
    needle: RegExp | string,
    timeoutOrOptions: number | WaitOptions = {},
  ) => {
    const waitOptions: WaitOptions =
      typeof timeoutOrOptions === 'number'
        ? { timeoutMs: timeoutOrOptions }
        : timeoutOrOptions;
    const timeoutMs = waitOptions.timeoutMs ?? 10_000;
    const after = waitOptions.after ?? 0;
    return new Promise<void>((done, reject) => {
      const timers: {
        interval?: ReturnType<typeof setInterval>;
        timeout?: ReturnType<typeof setTimeout>;
      } = {};
      let settled = false;
      const matches = () => {
        const text = outputSince(after);
        if (typeof needle === 'string') return text.includes(needle);
        needle.lastIndex = 0;
        return needle.test(text);
      };
      const cleanUp = () => {
        if (timers.interval) clearInterval(timers.interval);
        if (timers.timeout) clearTimeout(timers.timeout);
      };
      const resolveWait = () => {
        if (settled) return;
        settled = true;
        cleanUp();
        done();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanUp();
        reject(error);
      };
      if (matches()) return resolveWait();
      timers.interval = setInterval(() => {
        if (matches()) resolveWait();
      }, 25);
      timers.timeout = setTimeout(() => {
        const diagnostic = outputSince(after).slice(-8_000);
        fail(
          new Error(
            `Timed out waiting for ${String(needle)} after ${timeoutMs}ms.\nSanitized output since checkpoint:\n${diagnostic}`,
          ),
        );
      }, timeoutMs);
      void exit.then(({ exitCode, signal }) => {
        if (matches()) return resolveWait();
        const signalDescription =
          signal === undefined ? '' : `, signal ${signal}`;
        fail(
          new Error(
            `CLI exited with code ${exitCode}${signalDescription} before producing ${String(needle)}.\nSanitized output since checkpoint:\n${outputSince(after).slice(-8_000)}`,
          ),
        );
      });
    });
  };

  return {
    pty,
    output,
    outputSince,
    checkpoint,
    containsRaw,
    registerSecret,
    waitFor,
    exit,
  };
}

export function expectCleanExit(
  exit: PtyRun['exit'],
  timeoutMs = 15_000,
): Promise<{ exitCode: number; signal?: number }> {
  return Promise.race([
    exit,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`CLI did not exit within ${timeoutMs}ms.`)),
        timeoutMs,
      ),
    ),
  ]);
}

export class WizardDriver {
  private cursor = 0;

  constructor(readonly run: PtyRun) {}

  async enterText(
    prompt: string,
    value: string,
    options: { clearInitial?: boolean } = {},
  ): Promise<void> {
    await this.run.waitFor(prompt, { after: this.cursor });
    this.cursor = this.run.checkpoint();
    if (options.clearInitial) this.run.pty.write('\x7f'.repeat(128));
    this.run.pty.write(`${value}\r`);
  }

  async enterSecret(prompt: string, value: string): Promise<void> {
    this.run.registerSecret(value);
    await this.run.waitFor(prompt, { after: this.cursor });
    const secretEntryStart = this.run.checkpoint();
    this.run.pty.write(value);
    await this.run.waitFor('*'.repeat(value.length), {
      after: secretEntryStart,
    });
    this.assertSecretNotPresent(value);
    this.cursor = this.run.checkpoint();
    this.run.pty.write('\r');
  }

  async selectChoice(
    prompt: string,
    target: string,
    orderedChoices: readonly string[],
    options: { initial?: string; timeoutMs?: number } = {},
  ): Promise<void> {
    if (!orderedChoices.includes(target)) {
      throw new Error(`Target choice "${target}" is not in the expected menu.`);
    }
    const menuStart = this.cursor;
    await this.run.waitFor(prompt, {
      after: menuStart,
      timeoutMs: options.timeoutMs,
    });
    await this.run.waitFor(orderedChoices.at(-1)!, {
      after: menuStart,
      timeoutMs: options.timeoutMs,
    });

    const renderedMenu = this.run.outputSince(menuStart);
    let previousIndex = renderedMenu.indexOf(prompt);
    for (const choice of orderedChoices) {
      const choiceIndex = renderedMenu.indexOf(choice, previousIndex + 1);
      if (choiceIndex < 0) {
        throw new Error(
          `Expected menu choice "${choice}" was not rendered.\nSanitized menu output:\n${renderedMenu.slice(-8_000)}`,
        );
      }
      previousIndex = choiceIndex;
    }

    const expectedInitial = options.initial ?? orderedChoices[0];
    let highlighted = expectedInitial;
    let latestHighlightIndex = -1;
    for (const choice of orderedChoices) {
      const pattern = new RegExp(`❯\\s+${escapeRegExp(choice)}`, 'g');
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(renderedMenu))) {
        if (match.index > latestHighlightIndex) {
          latestHighlightIndex = match.index;
          highlighted = choice;
        }
      }
    }
    if (latestHighlightIndex < 0) {
      throw new Error(
        `Expected menu choice "${expectedInitial}" to be highlighted initially.\nSanitized menu output:\n${renderedMenu.slice(-8_000)}`,
      );
    }
    if (highlighted !== expectedInitial) {
      throw new Error(
        `Expected "${expectedInitial}" to be highlighted initially, but "${highlighted}" was highlighted.`,
      );
    }

    const sourceIndex = orderedChoices.indexOf(expectedInitial);
    const targetIndex = orderedChoices.indexOf(target);
    const movement = targetIndex - sourceIndex;
    const selectionStart = this.run.checkpoint();
    if (movement > 0) this.run.pty.write('\x1b[B'.repeat(movement));
    if (movement < 0) this.run.pty.write('\x1b[A'.repeat(-movement));
    if (movement !== 0) {
      await this.run.waitFor(new RegExp(`❯\\s+${escapeRegExp(target)}`), {
        after: selectionStart,
        timeoutMs: options.timeoutMs,
      });
    }
    this.cursor = this.run.checkpoint();
    this.run.pty.write('\r');
  }

  async confirm(prompt: string, answer = true): Promise<void> {
    await this.run.waitFor(prompt, { after: this.cursor });
    this.cursor = this.run.checkpoint();
    this.run.pty.write(answer ? 'y\r' : 'n\r');
  }

  async cancelAt(
    prompt: string,
    timeoutMs = 10_000,
  ): Promise<{ exitCode: number; signal?: number }> {
    await this.run.waitFor(prompt, {
      after: this.cursor,
      timeoutMs,
    });
    this.run.pty.write('\x03');
    const result = await expectCleanExit(this.run.exit, timeoutMs);
    if (result.exitCode !== 0) {
      throw new Error(`Cancellation exited with code ${result.exitCode}.`);
    }
    return result;
  }

  async expectSuccess(
    name: string,
    timeoutMs = 30_000,
    failurePattern?: RegExp,
  ): Promise<void> {
    const successMessage = `Credentials "${name}" saved successfully`;
    const waitPattern = failurePattern
      ? new RegExp(
          `(?:${escapeRegExp(successMessage)})|(?:${failurePattern.source})`,
          failurePattern.flags.replace(/[gy]/g, ''),
        )
      : successMessage;
    await this.run.waitFor(waitPattern, {
      after: this.cursor,
      timeoutMs,
    });
    const rendered = this.run.outputSince(this.cursor);
    if (!rendered.includes(successMessage)) {
      throw new Error(
        `Wizard reported a failure before saving credentials.\nSanitized output since checkpoint:\n${rendered.slice(-8_000)}`,
      );
    }
    // The success line is the slow part. Exit follows it within seconds, so
    // cap that leg separately instead of letting a post-save hang burn the
    // whole propagation budget and die on the suite timeout instead.
    const result = await expectCleanExit(
      this.run.exit,
      Math.min(timeoutMs, EXIT_TIMEOUT_MS),
    );
    if (result.exitCode !== 0) {
      throw new Error(`Wizard exited with code ${result.exitCode}.`);
    }
  }

  assertSecretNotPresent(value: string): void {
    if (this.run.containsRaw(value)) {
      throw new Error('A registered secret was present in terminal output.');
    }
  }
}

export type CredentialSaveFault =
  | { kind: 'http'; status: 422; message?: string }
  | { kind: 'malformed-before-commit' }
  | { kind: 'disconnect-after-commit' };

export interface CredentialBucketTarget {
  credentialName: string;
  bucketName: string;
  region: string;
}

export interface CredentialBucketListTarget {
  credentialName: string;
  region: string;
}

/** Holds a throttled answer so the last one still reports its own body. */
class ThrottledBucketRead extends Error {
  constructor(readonly response: Response) {
    super('Bucket read was throttled');
  }
}

/**
 * Rides out the API's declared, retryable 503 `BUCKET_THROTTLED` on a bucket
 * read for about 30 s, honouring its `Retry-After`. Any
 * other answer is final.
 */
export async function readThroughBucketThrottle(
  send: () => Promise<Response>,
  options: Pick<DeadlineRetryOptions, 'now' | 'random' | 'wait'> = {},
): Promise<Response> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? sleep;
  const deadline = now() + 30_000;
  let retryAfter = 0;
  return retryUntilDeadline(
    async () => {
      const response = await send();
      const body: unknown =
        response.status === 503
          ? await response
              .clone()
              .json()
              .catch(() => undefined)
          : undefined;
      if (!isRecord(body) || body.code !== 'BUCKET_THROTTLED') return response;
      retryAfter = retryAfterMs(response.headers, now()) ?? 0;
      throw new ThrottledBucketRead(response);
    },
    {
      deadline,
      initialDelayMs: 1_000,
      maxDelayMs: 8_000,
      now,
      random: options.random,
      wait: (ms) => wait(Math.max(ms, Math.min(retryAfter, deadline - now()))),
      shouldRetry: (error) => error instanceof ThrottledBucketRead,
    },
  ).catch((error: unknown) => {
    if (error instanceof ThrottledBucketRead) return error.response;
    throw error;
  });
}

export async function walkBucketListPages(
  readPage: (cursor?: string) => Promise<unknown>,
): Promise<string[]> {
  const names: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    const page = await readPage(cursor);
    if (!isRecord(page) || !isUnknownArray(page.buckets)) {
      throw new TypeError(
        'Bucket listing returned an invalid response: expected a JSON object with a buckets array.',
      );
    }
    for (const [index, bucket] of page.buckets.entries()) {
      if (
        !isRecord(bucket) ||
        typeof bucket.name !== 'string' ||
        bucket.name.length === 0
      ) {
        throw new TypeError(
          `Bucket listing returned an invalid bucket at index ${index}: expected a non-empty string name.`,
        );
      }
      names.push(bucket.name);
    }

    const nextCursor = page.nextCursor;
    if (nextCursor === undefined || nextCursor === null || nextCursor === '') {
      return names;
    }
    if (typeof nextCursor !== 'string') {
      throw new TypeError(
        'Bucket listing returned an invalid nextCursor: expected a string, null, or no cursor.',
      );
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error(
        `Bucket listing returned a repeated pagination cursor: ${nextCursor}`,
      );
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

export interface CredentialApiFixture {
  url: string;
  /** The stored material, read in process: the API never returns it. */
  storedCredential: (name: string) => Promise<Record<string, unknown>>;
  credentialExists: (name: string) => Promise<boolean>;
  deleteCredential: (name: string) => Promise<void>;
  createBucket: (target: CredentialBucketTarget) => Promise<void>;
  listBuckets: (target: CredentialBucketListTarget) => Promise<string[]>;
  bucketExists: (
    target: CredentialBucketTarget,
    options?: { uncached?: boolean },
  ) => Promise<boolean>;
  deleteBucket: (target: CredentialBucketTarget) => Promise<void>;
  guardNextCredentialSave: (guard?: () => void | Promise<void>) => void;
  queueSaveFault: (fault: CredentialSaveFault) => void;
  close: () => Promise<void>;
}

function definedHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name === 'host' || name === 'content-length' || value === undefined) {
      continue;
    }
    result[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return result;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done, reject) => {
    server.listen(0, '127.0.0.1', done);
    server.once('error', reject);
  });
  server.keepAliveTimeout = 0;
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Credential test API did not bind to a TCP socket.');
  }
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((done, reject) => {
    server.close((error) => (error ? reject(error) : done()));
    server.closeAllConnections?.();
  });
}

export async function startCredentialApi(
  token: string,
): Promise<CredentialApiFixture> {
  // ':memory:' preserves this suite's existing storage: nothing here sets
  // SQLITE_PATH, and the database defaults to in-memory when it is unset.
  const apiServer = await startApiServer({ sqlitePath: ':memory:' });
  const upstreamUrl = apiServer.url;
  const saveFaults: CredentialSaveFault[] = [];
  let nextCredentialSaveGuard: (() => void | Promise<void>) | undefined;

  async function handleProxyRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const requestUrl = new URL(request.url ?? '/', upstreamUrl);
      const isCredentialSave =
        request.method === 'PUT' &&
        /^\/v1\/credentials\/[^/]+$/.test(requestUrl.pathname);
      if (isCredentialSave && nextCredentialSaveGuard) {
        const guard = nextCredentialSaveGuard;
        nextCredentialSaveGuard = undefined;
        await guard();
      }
      const fault = isCredentialSave ? saveFaults.shift() : undefined;
      if (fault?.kind === 'http') {
        response.writeHead(fault.status, {
          'Content-Type': 'application/json',
        });
        response.end(
          JSON.stringify({
            defined: false,
            code: 'UNPROCESSABLE_CONTENT',
            status: fault.status,
            message: fault.message ?? 'Injected save failure',
          }),
        );
        return;
      }
      if (fault?.kind === 'malformed-before-commit') {
        // Consume the request but do not forward it. A complete 2xx response
        // with malformed JSON creates an ambiguous client-side failure without
        // allowing a runtime-level transport retry to commit the request.
        await readRequestBody(request);
        const partialBody = '{"incomplete":';
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': String(partialBody.length),
          Connection: 'close',
        });
        response.end(partialBody);
        return;
      }

      const body = await readRequestBody(request);
      const upstreamResponse = await fetch(requestUrl, {
        method: request.method,
        headers: definedHeaders(request.headers),
        body:
          request.method === 'GET' || request.method === 'HEAD'
            ? undefined
            : body,
      });
      const responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
      if (fault?.kind === 'disconnect-after-commit') {
        response.destroy();
        return;
      }
      const responseHeaders: Record<string, string> = {};
      upstreamResponse.headers.forEach((value, name) => {
        if (name !== 'content-length' && name !== 'transfer-encoding') {
          responseHeaders[name] = value;
        }
      });
      response.writeHead(upstreamResponse.status, responseHeaders);
      response.end(responseBody);
    } catch (error) {
      if (!response.destroyed) {
        response.writeHead(502, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            error:
              error instanceof Error
                ? error.message
                : 'Unknown credential proxy error',
          }),
        );
      }
    }
  }

  const proxyServer = createServer((request, response) => {
    void handleProxyRequest(request, response);
  });
  const url = await listen(proxyServer);

  const request = async (path: string, init?: RequestInit): Promise<Response> =>
    fetch(`${upstreamUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        [ANYCLOUD_CLIENT_VERSION_HEADER]: packageJson.version,
        ...init?.headers,
      },
    });

  const bucketPath = (target: CredentialBucketTarget): string =>
    `/v1/credentials/${encodeURIComponent(target.credentialName)}/buckets/${encodeURIComponent(target.bucketName)}`;

  const bucketQuery = (
    target: CredentialBucketTarget,
    extra: Record<string, string> = {},
  ): string => {
    const query = new URLSearchParams({
      region: target.region,
      ...extra,
    });
    return query.toString();
  };

  const requireOk = async (
    response: Response,
    description: string,
  ): Promise<void> => {
    if (response.ok) return;
    const body = (await response.text()).trim();
    throw new Error(
      `${description} failed with HTTP ${response.status}${body ? `: ${body}` : '.'}`,
    );
  };

  return {
    url,
    storedCredential: async (name) => {
      const { resolveCredentialByName } = await import(
        '../../../src/api/services/cloud-config.js'
      );
      const resolved = await resolveCredentialByName(name);
      if (!resolved) throw new Error(`Credential ${name} is not stored.`);
      return { name, ...resolved.creds };
    },
    credentialExists: async (name) => {
      const response = await request('/v1/credentials');
      if (!response.ok) {
        throw new Error(`Failed to list credentials: HTTP ${response.status}.`);
      }
      const credentials = (await response.json()) as Array<{ name: string }>;
      return credentials.some((credential) => credential.name === name);
    },
    deleteCredential: async (name) => {
      const response = await request(
        `/v1/credentials/${encodeURIComponent(name)}?force=true`,
        { method: 'DELETE' },
      );
      if (!response.ok && response.status !== 404) {
        throw new Error(
          `Failed to delete credential ${name}: HTTP ${response.status}.`,
        );
      }
    },
    createBucket: async (target) => {
      const response = await request(
        `${bucketPath(target)}?${bucketQuery(target)}`,
        { method: 'PUT' },
      );
      await requireOk(response, `Creating bucket ${target.bucketName}`);
    },
    // Listing bypasses the storage coordinator entirely, so there is no cached
    // read to bust here the way bucketExists needs.
    listBuckets: async (target) =>
      walkBucketListPages(async (cursor) => {
        const query = new URLSearchParams({
          region: target.region,
          pageSize: String(BUCKET_LIST_PAGE_SIZE),
        });
        if (cursor !== undefined) query.set('cursor', cursor);
        const response = await readThroughBucketThrottle(() =>
          request(
            `/v1/credentials/${encodeURIComponent(target.credentialName)}/buckets?${query}`,
          ),
        );
        await requireOk(
          response,
          `Listing buckets for credential ${target.credentialName}`,
        );
        const page: unknown = await response.json();
        return page;
      }),
    bucketExists: async (target, options = {}) => {
      if (options.uncached) resetStorageCoordinatorForTests();
      const response = await readThroughBucketThrottle(() =>
        request(`${bucketPath(target)}?${bucketQuery(target)}`),
      );
      if (response.status === 404) return false;
      await requireOk(response, `Checking bucket ${target.bucketName}`);
      return true;
    },
    deleteBucket: async (target) => {
      const response = await request(
        `${bucketPath(target)}?${bucketQuery(target)}`,
        { method: 'DELETE' },
      );
      await requireOk(response, `Deleting bucket ${target.bucketName}`);
    },
    guardNextCredentialSave: (guard) => {
      if (!guard) {
        nextCredentialSaveGuard = undefined;
        return;
      }
      if (nextCredentialSaveGuard) {
        throw new Error('A credential-save guard is already pending.');
      }
      nextCredentialSaveGuard = guard;
    },
    queueSaveFault: (fault) => saveFaults.push(fault),
    close: async () => {
      await closeServer(proxyServer);
      await apiServer.close();
    },
  };
}
