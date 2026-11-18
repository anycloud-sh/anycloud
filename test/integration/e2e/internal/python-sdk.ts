import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { checkApiVersion } from '../../../../src/shared/services/api-client/runtime.js';
import type { ControllerEndpointSource } from './controller-session.js';
import type { ProcessRunner } from './process.js';
import { CommandFailure } from './read-retry.js';
import type { CommandResult } from './types.js';
import type {
  SubmissionResponseLossCapture,
  SubmissionResponseLossFault,
  SubmissionResponseLossObservation,
  SubmissionResponseLossWireSession,
} from './targets/cluster-node-pool.js';

function successful(
  result: CommandResult,
  operation: string,
  source?: CommandFailure['source'],
): void {
  if (
    result.exitCode === 0 &&
    !result.timedOut &&
    !result.aborted &&
    !result.spawnError &&
    !result.outputTruncated &&
    result.signal === null
  ) {
    return;
  }
  throw new CommandFailure(
    `${operation} failed (exit ${String(result.exitCode)}, timeout ${String(result.timedOut)}): ${result.combined}`,
    result,
    source,
  );
}

export interface PythonSdkArtifactIdentity {
  readonly sha256: string;
  readonly version: string;
  readonly installed: {
    readonly module: string;
    readonly workflowsModule: string;
    readonly clientModule: string;
    readonly asyncClientModule: string;
    readonly clientIdentity: true;
    readonly asyncClientIdentity: true;
    readonly generatedVersion: string;
  };
}

/** Builds one wheel used by both the operator process and the in-Pod fixture. */
export class WorkspacePythonSdk {
  readonly #anycloudDirectory: string;
  readonly #endpoint: ControllerEndpointSource;
  readonly #projectRoot: string;
  readonly #runner: ProcessRunner;
  readonly #token: string;
  readonly #venvDirectory: string;
  readonly #useSuppliedWheel: boolean;
  readonly #wheelDirectory: string;
  readonly #wheelDirectoryRelative: string;
  readonly #expectedVersion: string | undefined;
  #preparePromise: Promise<void> | undefined;
  #artifactIdentity: PythonSdkArtifactIdentity | undefined;

  constructor(input: {
    anycloudDirectory: string;
    endpoint: ControllerEndpointSource;
    projectRoot: string;
    runId: string;
    runner: ProcessRunner;
    token: string;
    workspaceDirectory: string;
    wheelDirectoryRelative?: string;
    expectedVersion?: string;
  }) {
    this.#anycloudDirectory = input.anycloudDirectory;
    this.#endpoint = input.endpoint;
    this.#projectRoot = input.projectRoot;
    this.#runner = input.runner;
    this.#token = input.token;
    this.#expectedVersion = input.expectedVersion;
    this.#venvDirectory = path.join(
      input.workspaceDirectory,
      `python-sdk-${input.runId}`,
    );
    this.#useSuppliedWheel = input.wheelDirectoryRelative !== undefined;
    this.#wheelDirectoryRelative =
      input.wheelDirectoryRelative ?? `python/dist/e2e-${input.runId}`;
    if (
      path.isAbsolute(this.#wheelDirectoryRelative) ||
      this.#wheelDirectoryRelative.split(path.sep).includes('..')
    ) {
      throw new Error(
        'Python SDK wheel directory must stay inside the workspace',
      );
    }
    this.#wheelDirectory = path.join(
      this.#projectRoot,
      this.#wheelDirectoryRelative,
    );
  }

  prepare(): Promise<void> {
    this.#preparePromise ??= this.#prepare();
    return this.#preparePromise;
  }

  async wheelDirectoryRelative(): Promise<string> {
    await this.prepare();
    return this.#wheelDirectoryRelative;
  }

  async artifactIdentity(): Promise<PythonSdkArtifactIdentity> {
    await this.prepare();
    if (!this.#artifactIdentity)
      throw new Error('Installed SDK identity is unavailable');
    return this.#artifactIdentity;
  }

  async run(
    request: Readonly<Record<string, unknown>>,
    operation: string,
  ): Promise<CommandResult> {
    await this.prepare();
    const endpoint = this.#endpoint.snapshot();
    if (!endpoint) throw new Error(`${operation} has no attached API endpoint`);
    return this.#runner.run(
      path.join(this.#venvDirectory, 'bin', 'python'),
      [
        '-I',
        path.join(
          this.#projectRoot,
          'test/integration/e2e/internal/fixtures/python-sdk-driver.py',
        ),
      ],
      {
        env: {
          ANYCLOUD_DIR: this.#anycloudDirectory,
          API_URL: endpoint.url,
          CI: 'true',
          GITHUB_TOKEN: this.#token,
        },
        stdin: JSON.stringify(request),
        timeoutMs: 120_000,
        label: operation,
      },
    );
  }

  async json<T>(
    request: Readonly<Record<string, unknown>>,
    operation: string,
  ): Promise<T> {
    const result = await this.run(request, operation);
    successful(result, operation, {
      kind: 'python-sdk',
      action: typeof request.action === 'string' ? request.action : '',
    });
    try {
      return JSON.parse(result.stdout.trim()) as T;
    } catch (error) {
      throw new Error(`${operation} returned invalid JSON`, { cause: error });
    }
  }

  async startSubmissionResponseLoss(input: {
    readonly workloadId: string;
    readonly deployment: string;
    readonly fault: SubmissionResponseLossFault;
  }): Promise<SubmissionResponseLossWireSession> {
    await this.prepare();
    const endpoint = this.#endpoint.snapshot();
    if (!endpoint) throw new Error('Response-loss qualification has no API');
    const [version, source, status, sdk, diff, untracked] = await Promise.all([
      checkApiVersion(endpoint.url),
      this.#runner.run('git', ['rev-parse', 'HEAD'], {
        cwd: this.#projectRoot,
        label: 'response-loss-source',
      }),
      this.#runner.run('git', ['status', '--porcelain'], {
        cwd: this.#projectRoot,
        label: 'response-loss-source-status',
      }),
      this.artifactIdentity(),
      this.#runner.run('git', ['diff', '--binary', 'HEAD'], {
        cwd: this.#projectRoot,
        recordArtifact: false,
      }),
      this.#runner.run(
        'git',
        ['ls-files', '--others', '--exclude-standard', '-z'],
        {
          cwd: this.#projectRoot,
          recordArtifact: false,
        },
      ),
    ]);
    successful(source, 'Response-loss source identity');
    successful(status, 'Response-loss source status');
    successful(diff, 'Response-loss source changes');
    successful(untracked, 'Response-loss untracked sources');
    if (diff.outputTruncated || untracked.outputTruncated) {
      throw new Error('Response-loss source identity was truncated');
    }
    const changes = createHash('sha256').update(diff.stdout);
    for (const filename of untracked.stdout
      .split('\0')
      .filter(Boolean)
      .sort()) {
      changes.update(filename).update('\0');
      changes
        .update(await readFile(path.join(this.#projectRoot, filename)))
        .update('\0');
    }
    if (!version.compatible || version.apiVersion !== sdk.version) {
      throw new Error(
        'Response-loss qualification requires matching API and SDK versions',
      );
    }
    const directory = await mkdtemp(
      path.join(this.#venvDirectory, 'response-loss-'),
    );
    let failure: Error | undefined;
    let settled = false;
    const result = this.json<SubmissionResponseLossObservation>(
      {
        action: 'submit_response_loss',
        ...input,
        checkpointDirectory: directory,
      },
      `kubernetes-response-loss-${input.fault}`,
    ).then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        failure =
          error instanceof Error
            ? error
            : new Error('SDK response-loss child failed', { cause: error });
        throw failure;
      },
    );
    void result.catch(() => undefined);
    return {
      identity: {
        sourceSha: source.stdout.trim(),
        sourceStatus: status.stdout.trim(),
        sourceChangesSha256: changes.digest('hex'),
        sdkVersion: sdk.version,
        sdkSha256: sdk.sha256,
        apiVersion: version.apiVersion,
        apiUrl: endpoint.url,
        apiGeneration: endpoint.generation,
      },
      captured: async () => {
        if (failure) throw failure;
        try {
          return JSON.parse(
            await readFile(path.join(directory, 'captured.json'), 'utf8'),
          ) as SubmissionResponseLossCapture;
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              'code' in error &&
              error.code === 'ENOENT'
            )
          )
            throw error;
          if (settled)
            throw new Error(
              'SDK exited without capturing the selected response',
            );
          return null;
        }
      },
      release: () =>
        writeFile(path.join(directory, 'release'), '', { flag: 'wx' }),
      recovered: () => result,
      close: async () => {
        try {
          await writeFile(path.join(directory, 'abort'), '');
          await result.catch(() => undefined);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    };
  }

  async #prepare(): Promise<void> {
    if (!this.#useSuppliedWheel) {
      await rm(this.#wheelDirectory, { force: true, recursive: true });
      await mkdir(this.#wheelDirectory, { recursive: true });
      const wheel = await this.#runner.run(
        'python3',
        [
          '-m',
          'pip',
          'wheel',
          '--no-deps',
          '--wheel-dir',
          this.#wheelDirectory,
          path.join(this.#projectRoot, 'python'),
        ],
        { timeoutMs: 300_000, label: 'python-sdk-wheel-build' },
      );
      successful(wheel, 'Python SDK wheel build');
    }

    const wheels = (await readdir(this.#wheelDirectory)).filter((name) =>
      name.endsWith('.whl'),
    );
    if (wheels.length !== 1) {
      throw new Error(
        `Expected one workspace Python SDK wheel in ${this.#wheelDirectoryRelative}; found ${String(wheels.length)}`,
      );
    }
    await rm(this.#venvDirectory, { force: true, recursive: true });
    const create = await this.#runner.run(
      'python3',
      ['-m', 'venv', this.#venvDirectory],
      { timeoutMs: 120_000, label: 'python-sdk-venv-create' },
    );
    successful(create, 'Python SDK virtual environment creation');
    const install = await this.#runner.run(
      path.join(this.#venvDirectory, 'bin', 'python'),
      [
        '-I',
        '-m',
        'pip',
        'install',
        path.join(this.#wheelDirectory, wheels[0]),
      ],
      { timeoutMs: 300_000, label: 'python-sdk-wheel-install' },
    );
    successful(install, 'Python SDK wheel install');
    const provenance = await this.#runner.run(
      path.join(this.#venvDirectory, 'bin', 'python'),
      [
        '-I',
        '-c',
        'import anycloud, anycloud_workflows, importlib.metadata, inspect, json; from anycloud import AsyncClient, Client; print(json.dumps({"module": anycloud.__file__, "workflows_module": anycloud_workflows.__file__, "client_module": inspect.getfile(Client), "client_identity": Client is anycloud_workflows.Client, "async_client_module": inspect.getfile(AsyncClient), "async_client_identity": AsyncClient is anycloud_workflows.AsyncClient, "generated_version": anycloud.__version__, "version": importlib.metadata.version("anycloud-sdk")}))',
      ],
      { timeoutMs: 30_000, label: 'python-sdk-provenance' },
    );
    successful(provenance, 'Python SDK provenance check');
    const installed = JSON.parse(provenance.stdout.trim()) as {
      module?: unknown;
      workflows_module?: unknown;
      client_module?: unknown;
      client_identity?: unknown;
      async_client_module?: unknown;
      async_client_identity?: unknown;
      generated_version?: unknown;
      version?: unknown;
    };
    if (
      !this.#installedModule(installed.module) ||
      !this.#installedModule(installed.workflows_module) ||
      !this.#installedModule(installed.client_module) ||
      !this.#installedModule(installed.async_client_module) ||
      installed.client_identity !== true ||
      installed.async_client_identity !== true ||
      typeof installed.version !== 'string' ||
      installed.generated_version !== installed.version
    ) {
      throw new Error('Python operator did not import the workspace wheel');
    }
    if (this.#expectedVersion && installed.version !== this.#expectedVersion) {
      throw new Error(
        'Installed Python SDK version does not match the release candidate',
      );
    }
    this.#artifactIdentity = {
      sha256: createHash('sha256')
        .update(await readFile(path.join(this.#wheelDirectory, wheels[0])))
        .digest('hex'),
      version: installed.version,
      installed: {
        module: installed.module,
        workflowsModule: installed.workflows_module,
        clientModule: installed.client_module,
        asyncClientModule: installed.async_client_module,
        clientIdentity: installed.client_identity,
        asyncClientIdentity: installed.async_client_identity,
        generatedVersion: installed.generated_version,
      },
    };
  }

  #installedModule(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      value.startsWith(`${this.#venvDirectory}${path.sep}`)
    );
  }
}
