import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { cp, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

import { ApiClient } from './api.js';
import type { ArtifactStore, Redactor } from './artifacts.js';
import type { CleanupStack } from './cleanup.js';
import { CliClient } from './cli.js';
import { ControllerEndpoint } from './controller-session.js';
import { CliDatabase } from './database.js';
import type { FixtureFiles } from './files.js';
import { ManagedProcess } from './managed-process.js';
import type { ProcessRunner } from './process.js';
import type { TargetHttpClient } from './transports/http.js';
import { writeLocalApiToken } from '../../helpers/local-api-token.js';
import { FakeGithub, githubToken } from './fake-github.js';

export const unscopedCliEnvironment = {
  CLAUDECODE: undefined,
  CLAUDE_CODE_SESSION_ID: undefined,
  CODEX_BIN_PATH: undefined,
  CODEX_THREAD_ID: undefined,
  CURSOR_TRACE_ID: undefined,
  AIDER_MODEL: undefined,
};

export interface ApiFixtureRuntime {
  readonly artifacts: ArtifactStore;
  readonly cleanup: CleanupStack;
  readonly cleanupRunner: ProcessRunner;
  readonly cleanupSignal: AbortSignal;
  readonly files: FixtureFiles;
  readonly http: TargetHttpClient;
  readonly projectRoot: string;
  readonly redactor: Redactor;
  readonly runner: ProcessRunner;
  readonly signal: AbortSignal;
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

/** Owns the shipped server process, persistent state, and endpoint-bound clients. */
export class LocalApiProcess {
  readonly #runtime: ApiFixtureRuntime;
  readonly #process: ManagedProcess<string>;
  readonly #endpoint = new ControllerEndpoint();
  readonly #port: number;
  readonly #label: string;
  readonly directory: string;
  readonly dbPath: string;
  /** A local start's per-install token; a hosted start authenticates GitHub. */
  #localToken: string | undefined;
  #hosted = false;
  /** What a hosted start checks GitHub sign-ins against. */
  #github: FakeGithub | undefined;

  private constructor(
    runtime: ApiFixtureRuntime,
    directory: string,
    port: number,
    label: string,
  ) {
    this.#runtime = runtime;
    this.#process = new ManagedProcess(runtime.artifacts);
    this.#port = port;
    this.#label = label;
    this.directory = directory;
    this.dbPath = path.join(directory, 'api.db');
    runtime.cleanup.defer(`local API process ${label}`, async () => {
      await this.stop();
      await this.#github?.stop();
    });
  }

  static async create(
    runtime: ApiFixtureRuntime,
    label: string,
  ): Promise<LocalApiProcess> {
    return new LocalApiProcess(
      runtime,
      await runtime.files.directory(`local-api-${label}`, { private: true }),
      await unusedPort(),
      label,
    );
  }

  /**
   * The CLI sends its local token to loopback names only, so a hosted start
   * is addressed through another loopback address, as a remote API would be.
   * Linux routes all of 127/8; macOS needs `sudo ifconfig lo0 alias 127.0.0.2`.
   */
  get url(): string {
    return `http://${this.#hosted ? '127.0.0.2' : '127.0.0.1'}:${this.#port}`;
  }

  /** The fake GitHub a hosted start checks sign-ins against. */
  get github(): FakeGithub {
    assert.ok(this.#github, 'Only a hosted start has a fake GitHub');
    return this.#github;
  }

  /** The caller's GitHub sign-in when a test names none. */
  get defaultGithubToken(): string {
    return this.#hosted ? githubToken('anycloud-test') : 'dummy-token-for-test';
  }

  /** The bearer a caller presents: the local token, or the GitHub `token`. */
  bearer(token = this.defaultGithubToken): string {
    return this.#localToken ?? token;
  }

  /**
   * `token` is the caller's GitHub sign-in; null runs signed out. Each hosted
   * caller keeps its own CLI state, as each person has their own machine.
   */
  client(
    token: string | null = this.defaultGithubToken,
    cleanup = false,
  ): { api: ApiClient; cli: CliClient; database: CliDatabase } {
    const signal = cleanup ? this.#runtime.cleanupSignal : this.#runtime.signal;
    const api = new ApiClient(
      this.#endpoint,
      this.bearer(token ?? undefined),
      this.#runtime.artifacts,
      this.#runtime.redactor,
      signal,
      `local-${this.#label}`,
    );
    const cli = new CliClient(
      cleanup ? this.#runtime.cleanupRunner : this.#runtime.runner,
      this.#runtime.projectRoot,
      path.join(
        this.directory,
        this.#hosted ? `cli-state-${token ?? 'signed-out'}` : 'cli-state',
      ),
      this.#endpoint,
      token ?? undefined,
      signal,
    );
    return {
      api,
      cli,
      database: new CliDatabase({
        run: (args, options) =>
          cli.run(args, {
            ...options,
            env: { ...unscopedCliEnvironment, ...options?.env },
          }),
      }),
    };
  }

  environment(): Readonly<Record<string, string | undefined>> {
    return {
      ...unscopedCliEnvironment,
      ANYCLOUD_DIR: this.directory,
      SQLITE_PATH: this.dbPath,
      CIPHER_KEY: '',
      IS_TEST: 'true',
      PORT: String(this.#port),
      API_URL: undefined,
      ANYCLOUD_WORKLOAD_API_URL: undefined,
      WORKLOAD_ID: undefined,
      GITHUB_TOKEN: 'dummy-token-for-test',
    };
  }

  async start(owner?: {
    readonly username: string;
    readonly id: string;
  }): Promise<void> {
    const args = [path.join(this.#runtime.projectRoot, 'dist/api/server.js')];
    this.#hosted = owner !== undefined;
    if (!owner) this.#writeLocalToken();
    if (owner) this.#github ??= await FakeGithub.start();
    if (owner)
      args.push(
        '--hosted-api-owner',
        owner.username,
        '--hosted-api-owner-id',
        owner.id,
      );
    await this.#process.startWithProbe({
      executable: process.execPath,
      args,
      cwd: this.#runtime.projectRoot,
      label: `local-api-${this.#label}`,
      env: {
        ...this.environment(),
        // A hosted API refuses IS_TEST, so it checks sign-ins with a fake
        // GitHub exactly as a real one does.
        ...(owner
          ? {
              IS_TEST: undefined,
              ANYCLOUD_DISABLE_USAGE_COLLECTION: '1',
              ANYCLOUD_GITHUB_API_URL: this.#github?.url,
              WORKLOAD_ID: `hosted-api-access-policy-${owner.id}`,
              ANYCLOUD_WORKLOAD_API_URL: 'https://api.example.com',
            }
          : {}),
      },
      signal: this.#runtime.signal,
      readyTimeoutMs: 30_000,
      probeReady: async (_pid, deadlineAt) => {
        let response;
        try {
          response = await this.#runtime.http.get(
            'local-api-readiness',
            new URL('/health', this.url),
            { timeoutMs: 1_000, deadlineAt, redirect: 'error' },
          );
        } catch (error) {
          if (
            error instanceof Error &&
            /fetch failed|ECONNREFUSED|timeout|aborted/iu.test(error.message)
          )
            return undefined;
          throw error;
        }
        if (response.status !== 200) return undefined;
        assert.ok(
          JSON.stringify(response.body).includes('ok'),
          'API health route returned no readiness acknowledgement',
        );
        return this.url;
      },
    });
    this.#endpoint.attach(this.url);
  }

  /** What `api start` does: the API and this fixture's CLI share one token. */
  #writeLocalToken(): void {
    this.#localToken ??= randomBytes(32).toString('hex');
    this.#runtime.redactor.add(this.#localToken);
    for (const directory of [
      this.directory,
      path.join(this.directory, 'cli-state'),
    ])
      writeLocalApiToken(directory, this.#localToken);
  }

  async stop(): Promise<void> {
    try {
      await this.#process.stop(true);
    } finally {
      this.#endpoint.detach();
    }
  }

  async restoreFrom(source: LocalApiProcess): Promise<void> {
    await source.stop();
    for (const name of ['api.db', 'cipher.key']) {
      const from = path.join(source.directory, name);
      assert.ok((await stat(from)).size > 0, `Missing durable ${name}`);
      await cp(from, path.join(this.directory, name));
    }
    // A stop that ends before the drain's checkpoint leaves committed pages
    // in the WAL, which belongs with the database file.
    const wal = path.join(source.directory, 'api.db-wal');
    if (existsSync(wal)) await cp(wal, path.join(this.directory, 'api.db-wal'));
    const key = (
      await readFile(path.join(this.directory, 'cipher.key'), 'utf8')
    ).trim();
    assert.match(key, /^[a-f0-9]{64}$/u, 'Restored cipher key is malformed');
    this.#runtime.redactor.add(key);
  }
}
