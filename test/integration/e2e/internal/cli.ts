import path from 'node:path';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { ProcessRunner } from './process.js';
import {
  controllerCliEnvironment,
  controllerEndpointSource,
  type ControllerEndpointSource,
} from './controller-session.js';
import type { CommandOptions, CommandResult } from './types.js';

export interface CliRunOptions {
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string;
  readonly prependPath?: string;
  readonly label?: string;
  /** Private inventory reads retain validated metadata through their owner. */
  readonly recordArtifact?: boolean;
}

export const TRANSIENT_FAILURE =
  /anycloud API is temporarily unavailable|Could not verify API version|could not read \/v1\/version|timed out after \d+ms|Premature close|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/iu;

export class CliClient {
  readonly #runner: ProcessRunner;
  readonly #cliPath: string;
  readonly #compiledBinary: boolean;
  readonly #workspaceDirectory: string;
  readonly #endpoint: ControllerEndpointSource;
  /** The user's GitHub sign-in; undefined runs the CLI without one. */
  readonly #githubToken: string | undefined;
  readonly #signal: AbortSignal;
  /** Read before each run: the token `api start` wrote for the controller. */
  readonly #localApiToken: (() => string) | undefined;

  constructor(
    runner: ProcessRunner,
    projectRoot: string,
    workspaceDirectory: string,
    endpoint: string | undefined | ControllerEndpointSource,
    githubToken: string | undefined,
    signal: AbortSignal = new AbortController().signal,
    candidateBinary?: string,
    localApiToken?: () => string,
  ) {
    this.#runner = runner;
    this.#compiledBinary = Boolean(candidateBinary);
    this.#cliPath =
      candidateBinary ?? path.join(projectRoot, 'dist/cli/index.js');
    this.#workspaceDirectory = workspaceDirectory;
    this.#endpoint = controllerEndpointSource(endpoint);
    this.#githubToken = githubToken;
    this.#signal = signal;
    this.#localApiToken = localApiToken;
  }

  async artifactIdentity(): Promise<{ sha256: string; version: string }> {
    if (!this.#compiledBinary)
      throw new Error('CLI artifact identity requires a supplied binary');
    const result = await this.run(['--version'], {
      label: 'candidate-cli-version',
    });
    if (
      result.exitCode !== 0 ||
      result.aborted ||
      result.timedOut ||
      result.spawnError
    ) {
      throw new Error('Candidate CLI version check failed');
    }
    return {
      sha256: createHash('sha256')
        .update(await readFile(this.#cliPath))
        .digest('hex'),
      version: result.stdout.trim(),
    };
  }

  async run(
    args: readonly string[],
    options: CliRunOptions = {},
  ): Promise<CommandResult> {
    return this.#runner.run(
      this.#compiledBinary ? this.#cliPath : process.execPath,
      this.#compiledBinary ? args : [this.#cliPath, ...args],
      this.#processOptions(args, options),
    );
  }

  /**
   * Run the CLI as `cli 2>&1 | grep -m1 -E pattern`, the way a script waits for
   * one marker: the reader exits at the first match, and stdout reports the
   * match and the CLI's own exit status as `exit:<code>`.
   */
  async runToFirstMatch(
    args: readonly string[],
    pattern: string,
    options: CliRunOptions = {},
  ): Promise<CommandResult> {
    const processOptions = this.#processOptions(args, options);
    return this.#runner.run(
      'bash',
      [
        '-c',
        '"$@" 2>&1 | grep -m1 -E "$CLI_MATCH_PATTERN"; echo "exit:${PIPESTATUS[0]}"',
        'bash',
        ...(this.#compiledBinary
          ? [this.#cliPath]
          : [process.execPath, this.#cliPath]),
        ...args,
      ],
      {
        ...processOptions,
        env: { ...processOptions.env, CLI_MATCH_PATTERN: pattern },
      },
    );
  }

  #processOptions(
    args: readonly string[],
    options: CliRunOptions,
  ): CommandOptions {
    if (this.#localApiToken) {
      mkdirSync(this.#workspaceDirectory, { recursive: true });
      // Parallel calls read this file, so replace it whole instead of
      // truncating it in place.
      const file = path.join(this.#workspaceDirectory, 'local-api-token');
      const temporary = `${file}.${randomUUID()}`;
      writeFileSync(temporary, this.#localApiToken(), { mode: 0o600 });
      renameSync(temporary, file);
    }
    const environment: Record<string, string | undefined> = {
      ANYCLOUD_DIR: this.#workspaceDirectory,
      CI: 'true',
      GITHUB_TOKEN: this.#githubToken,
      ...controllerCliEnvironment(this.#endpoint),
      ...options.env,
    };
    if (options.prependPath) {
      environment.PATH = `${options.prependPath}${path.delimiter}${process.env.PATH ?? ''}`;
    }
    const processOptions: CommandOptions = {
      env: environment,
      label: options.label ?? `cli-${args[0] ?? 'root'}`,
      ...(options.recordArtifact === undefined
        ? {}
        : { recordArtifact: options.recordArtifact }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    };
    return processOptions;
  }

  async runWithTransientRetries(
    args: readonly string[],
    options: CliRunOptions = {},
  ): Promise<CommandResult> {
    let result = await this.run(args, options);
    // eslint-disable-next-line local/no-hand-written-retry-loops -- returns the last failed result to the caller instead of throwing
    for (
      let attempt = 1;
      attempt < 3 &&
      result.exitCode !== 0 &&
      TRANSIENT_FAILURE.test(result.combined);
      attempt += 1
    ) {
      await new Promise<void>((resolve, reject) => {
        if (this.#signal.aborted) {
          reject(new Error('CLI retry wait aborted'));
          return;
        }
        const finish = (): void => {
          clearTimeout(timer);
          this.#signal.removeEventListener('abort', abort);
          resolve();
        };
        const abort = (): void => {
          clearTimeout(timer);
          this.#signal.removeEventListener('abort', abort);
          reject(new Error('CLI retry wait aborted'));
        };
        const timer = setTimeout(finish, 10_000);
        this.#signal.addEventListener('abort', abort, { once: true });
      });
      result = await this.run(args, {
        ...options,
        label: `${options.label ?? `cli-${args[0] ?? 'root'}`}-retry-${attempt + 1}`,
      });
    }
    return result;
  }
}
