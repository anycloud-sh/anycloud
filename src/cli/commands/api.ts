import { Command, InvalidArgumentError } from 'commander';
import { apiClient, hostedApiBearer } from '../services/auth.js';
import * as semver from 'semver';
import { newTable } from '../renderers/table.js';
import { spawnSync, spawn } from 'child_process';
import {
  existsSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
  renameSync,
  statSync,
} from 'fs';
import { randomBytes } from 'crypto';
import { hostname, userInfo } from 'os';
import { join } from 'path';
import {
  printSuccess,
  printError,
  printInfo,
  printWarning,
  createSpinner,
  printFields,
  printStateHeader,
  printUpgrade,
  setJsonMode,
} from '../utils/output.js';
import { WorkloadState } from '../../shared/workload.js';
import {
  SIGINT_EXIT_CODE,
  isInterrupted,
  runUntilInterrupted,
} from '../utils/interrupt.js';
import {
  DEFAULT_WATCH_INTERVAL_SECONDS,
  parseWatchInterval,
  watchUntil,
} from '../utils/watch.js';
import { shouldAllowPrompts } from '../utils/safe-prompts.js';
import { runKubernetesStep } from '../use-cases/kubernetes-step.js';
import { formatAge } from '../utils/duration.js';
import packageJson from '../../../package.json' with { type: 'json' };
import {
  API_URL_PATH,
  localApiTokenPath,
  getLoopbackApiPort,
  resolveApiTarget,
} from '../../shared/config.js';
import { getAnycloudDir } from '../../shared/utils.js';
import { optionalGitHubToken } from '../../shared/services/auth.js';
import {
  createApiClient,
  isApiRestart,
} from '../../shared/services/api-client/rpc.js';
import { SSH_RUNTIME_TMPFS } from '../../shared/ssh-runtime.js';
import {
  API_NOTIFICATION_LABEL_ENV,
  localApiNotificationLabel,
} from '../../shared/notifications/source.js';
import {
  activeVmHostedApi,
  discoverApiTargetRows,
  checkApiHealth,
  getActiveApiTargetInfo,
  persistApiTarget,
  resolveApiTargetArgument,
  selectableApiTargets,
  selectApiTarget,
  vmHostedApiMigrationMessage,
  type ApiTargetInfo,
  type ApiTargetRow,
} from '../services/api-target.js';
import { reconcileLocalApi } from '../services/local-api-update.js';
import { ORPCError } from '@orpc/client';
import {
  LIFECYCLE_EXIT_HELP,
  NOT_RUN_EXIT_CODE,
  exitWithLifecycleError,
  lifecycleError,
  withLifecycleUsageExit,
} from '../utils/lifecycle-result.js';
import type {
  KubernetesStep,
  SystemReleaseStatus,
} from '../../shared/api-contract/system-release-schemas.js';
import { createApiAccessCommand, createApiTokenCommand } from './api-access.js';
import { drainPoolJobs } from '../use-cases/pool-job-drain.js';
import {
  inspectLocalApiContainer,
  isLocalApiContainerRunning,
  LOCAL_API_CONTAINER_NAME,
  LOCAL_API_STILL_STARTING_EXIT_CODE,
  LOCAL_API_CONTAINER_PORT,
  LOCAL_API_VERSION_LABEL,
} from '../../shared/local-api-container.js';

const IMAGE_NAME = packageJson.apiImage;
const CONTAINER_NAME = LOCAL_API_CONTAINER_NAME;
const LEGACY_CONTAINER_NAME = 'anycloud-conductor';
const DEFAULT_PORT = LOCAL_API_CONTAINER_PORT;
const API_CONTAINER_PORT = LOCAL_API_CONTAINER_PORT;
const LABEL_VERSION = LOCAL_API_VERSION_LABEL;
interface ApiStartOptions {
  port: string;
  version?: string;
}

function getDbPath(): string {
  const legacyPath = join(getAnycloudDir(), 'conductor.db');
  const newPath = join(getAnycloudDir(), 'api.db');
  // Migrate legacy DB filename from conductor.db to api.db
  if (existsSync(legacyPath) && !existsSync(newPath)) {
    renameSync(legacyPath, newPath);
  }
  return newPath;
}

function getCipherKeyPath(): string {
  return join(getAnycloudDir(), 'cipher.key');
}

function getOrCreateCipherKey(): string {
  const keyPath = getCipherKeyPath();
  if (existsSync(keyPath)) {
    return readFileSync(keyPath, 'utf-8').trim();
  }
  const dbPath = join(getAnycloudDir(), 'api.db');
  const legacyDbPath = join(getAnycloudDir(), 'conductor.db');
  const existingDbPath = [dbPath, legacyDbPath].find((path) => {
    if (!existsSync(path)) return false;
    return statSync(path).isFile();
  });
  if (existingDbPath) {
    throw new Error(
      `Cipher key missing at ${keyPath}; refusing to generate a new key because SQLite DB exists at ${existingDbPath}`,
    );
  }
  const key = randomBytes(32).toString('hex');
  writeFileSync(keyPath, key, { encoding: 'utf-8', mode: 0o600 });
  return key;
}

/**
 * Only this user's CLI can read it, and the local API admits nothing else. A
 * malformed file is replaced, so the CLI's "run `anycloud api start`" fixes it.
 */
function ensureLocalApiToken(): void {
  const path = localApiTokenPath();
  if (
    existsSync(path) &&
    /^[0-9a-f]{64}$/.test(readFileSync(path, 'utf-8').trim())
  ) {
    return;
  }
  rmSync(path, { force: true });
  writeFileSync(path, randomBytes(32).toString('hex'), {
    encoding: 'utf-8',
    mode: 0o600,
    flag: 'wx',
  });
}

function parseVersionOption(value: string): string {
  if (!semver.valid(value)) {
    throw new InvalidArgumentError(
      `--version must be a valid semver version (got "${value}")`,
    );
  }
  return value;
}

function isDockerAvailable(): boolean {
  const result = spawnSync('docker', ['info'], { stdio: 'ignore' });
  return result.status === 0;
}

function getContainerRestartCount(): number | null {
  const result = spawnSync(
    'docker',
    ['inspect', '--format', '{{.RestartCount}}', CONTAINER_NAME],
    { encoding: 'utf-8' },
  );
  if (result.status !== 0) return null;
  const count = parseInt(result.stdout.trim(), 10);
  return isNaN(count) ? null : count;
}

async function warnIfLegacyApiTarget(): Promise<void> {
  try {
    const legacy = await activeVmHostedApi();
    if (legacy) printWarning(vmHostedApiMigrationMessage(legacy));
  } catch (error) {
    printWarning(
      `Could not check the active API's migration status: ${(error as Error).message}`,
    );
  }
}

function createUseCommand(): Command {
  return new Command('use')
    .description('Set the active API server')
    .argument('[target]', 'API URL or "local"')
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud api use
  $ anycloud api use https://<cluster-id>.anycloud.sh
  $ anycloud api use local
`,
    )
    .action(async (target: string | undefined) => {
      try {
        if (target) {
          const candidate = resolveApiTargetArgument(target);
          await persistApiTarget(candidate);
          if (candidate.source !== 'local') await warnIfLegacyApiTarget();
          if (candidate.source !== 'local') {
            printInfo(`Saved to ${API_URL_PATH}`);
          }
          return;
        }

        if (!shouldAllowPrompts()) {
          throw new Error('Pass an API URL or "local".');
        }

        const spinner = createSpinner('Loading API servers...').start();
        const discovery = await discoverApiTargetRows().finally(() =>
          spinner.stop(),
        );
        for (const warning of discovery.warnings) printWarning(warning);

        const candidates = selectableApiTargets(discovery.targets);

        if (candidates.length === 0) {
          printError(
            `No healthy compatible API servers found. Start local with "anycloud api start" or pass a URL.`,
          );
          process.exit(1);
        }

        const selected = await selectApiTarget(candidates);
        if (!selected) process.exit(0);
        await persistApiTarget(selected);
        if (selected.source !== 'local') await warnIfLegacyApiTarget();
        if (selected.source !== 'local') {
          printInfo(`Saved to ${API_URL_PATH}`);
        }
      } catch (error) {
        printError((error as Error).message);
        process.exit(1);
      }
    });
}

/**
 * A Helm-managed API answers its own release surface; a Docker-hosted one
 * (or an API without the route) does not, and is updated through the local
 * manager as before.
 */
async function probeSystemRelease(
  client: ReturnType<typeof createApiClient>['systemRelease'],
): Promise<SystemReleaseStatus | null> {
  try {
    return await client.status();
  } catch (error) {
    if (
      error instanceof ORPCError &&
      (error.code === 'SYSTEM_RELEASE_UNAVAILABLE' || error.status === 404)
    ) {
      return null;
    }
    throw error;
  }
}

interface ApiUpgradeOptions {
  image?: string;
  force?: boolean;
  json?: boolean;
}

/**
 * `api upgrade --json`, the upgrade hook an embedding product drives (RFC 0049
 * C26 (d)). `started`: the hosted API began the upgrade numbered `upgrade`;
 * `accepted`: an API older than this CLI took it without naming it;
 * `unchanged`: it already runs the release; `local`: the active API is the
 * local one, now on `version`.
 */
export interface ApiUpgradeResult {
  outcome: 'started' | 'accepted' | 'unchanged' | 'local';
  api: { url: string; previousVersion: string | null; version: string | null };
  upgrade: number | null;
  /**
   * The K3s step (C26 (b)): whether it changed the server configuration;
   * null when it didn't run (the API already ran the release, or predates
   * the step). The K3s binary upgrade (b2) adds the server's versions.
   */
  k3s: { configuration: 'changed' | 'current' } | null;
}

function createApiUpgradeCommand(): Command {
  return withLifecycleUsageExit(new Command('upgrade'))
    .alias('update')
    .description(
      'Upgrade the active API: the local API, or a cluster-hosted one',
    )
    .allowExcessArguments(false)
    .option(
      '--image <reference>',
      "Helm-managed API only: exact image to run instead of this CLI's release (ghcr.io/anycloud-sh/api:<version>@sha256:<digest>); an image older than the served one is refused",
    )
    .option(
      '--force',
      'Stop the pool Jobs the upgrade waits for instead of waiting; each retries on the new release',
    )
    .option('--json', 'Emit the upgrade result, or the error, as JSON')
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud api upgrade
  $ anycloud api upgrade --image ghcr.io/anycloud-sh/api:<version>@sha256:<digest>

With the local API active, it is started or restarted on this CLI's release. If the
active API is a Helm-managed API on a cluster (anycloud cluster create), it is
asked to move to this CLI's release, without Docker or the local API:
it backs its database up and hands the new image to helm-controller, then is
replaced by it while it keeps running. "anycloud api status" shows the
upgrade. The active API selection is not changed. From any machine, once the
pool Jobs below have drained, the hosted API first brings the cluster's K3s
configuration to the new release's, which briefly restarts the Kubernetes API
server when it changed.

Before an API is replaced, no new pool Job (job --node-pool) starts. Pool
Jobs running on this release's or the previous release's runner keep running
through the upgrade and are listed. The upgrade waits for older ones, and
for all of them with an --image of another release; with --force those are
stopped instead, and each retries after the upgrade.

${LIFECYCLE_EXIT_HELP} Exit 4: the new local API was still starting (local API only).
`,
    )
    .action(async (options: ApiUpgradeOptions) => {
      if (options.json) setJsonMode(true);
      const finish = (result: ApiUpgradeResult, message: string) => {
        if (options.json) console.log(JSON.stringify(result));
        else printSuccess(message);
      };
      try {
        const activeTarget = resolveApiTarget();
        const activeLoopbackPort = getLoopbackApiPort(activeTarget.url);
        const activeIsLocal =
          activeTarget.source === 'default' || activeLoopbackPort !== undefined;
        const currentVersion = packageJson.version;
        // RFC 0049 C27: this release accepts its own runners and the previous
        // release's, so Jobs on those keep running through the upgrade.
        const keep = [currentVersion, packageJson.previousVersion];

        // A hosted API is upgraded through its own API alone: the local API,
        // and Docker, are not touched.
        if (activeIsLocal) {
          const localBefore = await reconcileLocalApi(currentVersion, {
            startIfStopped: true,
            ...(activeTarget.source !== 'default' &&
              activeLoopbackPort !== undefined && {
                startPort: activeLoopbackPort,
              }),
            // Claims go through the API, so one that doesn't answer starts no
            // new pool Job; those it started before keep running until the
            // restart, which retries them, and can't be drained from here.
            beforeRestart: async (apiUrl) => {
              if (!(await checkApiHealth(apiUrl))) {
                printWarning(
                  'Skipped draining pool Jobs: the local API did not answer /health. Pool Jobs it claimed before keep running until the new API replaces their replicas, then retry.',
                );
                return;
              }
              await drainPoolJobs(
                (
                  await apiClient({
                    apiUrl,
                    missingExitCode: NOT_RUN_EXIT_CODE,
                  })
                ).systemRelease,
                !!options.force,
                printInfo,
                { keep },
              );
            },
          });
          finish(
            {
              outcome: 'local',
              api: {
                url: activeTarget.url,
                previousVersion: localBefore,
                version: currentVersion,
              },
              upgrade: null,
              k3s: null,
            },
            `Local API matches anycloud ${currentVersion}.`,
          );
          return;
        }

        const hostedRelease = (
          await apiClient({
            apiUrl: activeTarget.url,
            missingExitCode: NOT_RUN_EXIT_CODE,
          })
        ).systemRelease;
        const releaseStatus = await probeSystemRelease(hostedRelease);
        if (releaseStatus) {
          const served = releaseStatus.servedVersion;
          let k3sResult: ApiUpgradeResult['k3s'] = null;
          const hostedResult = (
            outcome: ApiUpgradeResult['outcome'],
            version: string | null,
            upgrade: number | null = null,
          ): ApiUpgradeResult => ({
            outcome,
            api: { url: activeTarget.url, previousVersion: served, version },
            upgrade,
            k3s: k3sResult,
          });
          if (!options.image && served === currentVersion) {
            finish(
              hostedResult('unchanged', served),
              `Hosted API ${activeTarget.url} already matches anycloud ${currentVersion}.`,
            );
            return;
          }
          // The hosted API resolves this CLI's release tag to its published
          // digest itself; an explicit --image is used exactly as given.
          const image = options.image ?? `${IMAGE_NAME}:${currentVersion}`;
          // A pinned image of another release has a window this CLI can't
          // name, so every pool Job drains.
          await drainPoolJobs(hostedRelease, !!options.force, printInfo, {
            image,
            ...(image.split('@')[0]!.endsWith(`:${currentVersion}`) && {
              keep,
            }),
          }).catch((error: unknown) => {
            // The drain checks the release first: its refusal is the verdict.
            if (
              error instanceof ORPCError &&
              ['SYSTEM_RELEASE_REFUSED', 'SYSTEM_RELEASE_UNAVAILABLE'].includes(
                error.code,
              )
            ) {
              exitWithLifecycleError(
                'Hosted API upgrade refused',
                error,
                options.json,
              );
            }
            throw error;
          });
          const k3s = await runKubernetesStep(hostedRelease, image, printInfo);
          if (k3s) {
            printInfo(`K3s step: ${kubernetesStepSummary(k3s)}`);
            k3sResult = { configuration: k3s.configuration ?? 'current' };
          }
          const releaseSpinner = createSpinner(
            `Requesting hosted API upgrade to ${image}...`,
          ).start();
          let result: Awaited<ReturnType<typeof hostedRelease.request>>;
          try {
            result = await hostedRelease.request({ image });
            releaseSpinner.stop();
          } catch (error) {
            releaseSpinner.stop();
            // The refusal is the verdict: a plain line on stderr, with the
            // API's reason, whatever the terminal (F runs 16 and 18).
            exitWithLifecycleError(
              'Hosted API upgrade refused',
              error,
              options.json,
            );
          }
          // Plain-line verdicts: a spinner prints nothing in a non-TTY run.
          if (result.unchanged) {
            finish(
              hostedResult('unchanged', served),
              `Hosted API ${activeTarget.url} already runs ${image}; nothing to do (unchanged).`,
            );
            return;
          }
          // An API older than this CLI accepts the upgrade without naming it.
          if (!result.upgrade) {
            finish(
              hostedResult('accepted', null),
              `Hosted API ${activeTarget.url} accepted the upgrade to ${image}.`,
            );
            printInfo(
              `It keeps running while it is replaced. Run "anycloud api status" until it no longer reports version ${releaseStatus.servedVersion}.`,
            );
            return;
          }
          finish(
            hostedResult(
              'started',
              result.upgrade.apiVersion,
              result.upgrade.number,
            ),
            `Hosted API upgrade ${result.upgrade.number} started: ${releaseStatus.servedVersion} → ${result.upgrade.apiVersion}.`,
          );
          printInfo(
            'It backed its database up and keeps running while it is replaced. Run "anycloud api status --watch" to follow the upgrade.',
          );
          return;
        }
        if (options.image) {
          throw new Error(
            `Active API ${activeTarget.url} is not a Helm-managed API; --image applies only to one.`,
          );
        }
        // A VM-hosted API (`anycloud api serve`, removed) is still a Service
        // the installer's API manages; it is retired, not updated.
        const legacy = await activeVmHostedApi();
        if (legacy) throw new Error(vmHostedApiMigrationMessage(legacy));
        throw new Error(
          `Active API ${activeTarget.url} is not a Helm-managed API; api upgrade applies to the local API and to an API created with anycloud cluster create.`,
        );
      } catch (error) {
        if (options.json) {
          exitWithLifecycleError('Failed to upgrade the API', error, true);
        }
        const { message, exitCode } = lifecycleError(error);
        printError(message);
        process.exit(exitCode);
      }
    });
}

function formatApiTargetSource(source: ApiTargetRow['source']): string {
  switch (source) {
    case 'env':
      return 'API_URL';
    case 'file':
      return 'api-url';
    case 'default':
      return 'default';
    case 'manual':
      return 'manual';
  }
}

function formatApiTargetVersion(row: ApiTargetRow): string {
  if (!row.apiVersion) return 'unknown';
  return row.compatible ? row.apiVersion : `${row.apiVersion} (mismatch)`;
}

function printApiTargetsTable(rows: ApiTargetRow[]): void {
  const table = newTable({
    head: ['CURRENT', 'KIND', 'ID', 'URL', 'HEALTH', 'VERSION', 'SOURCE'],
    style: { head: [] },
  });

  for (const row of rows) {
    table.push([
      row.current ? '*' : '',
      row.kind,
      row.id,
      row.url,
      row.health,
      formatApiTargetVersion(row),
      formatApiTargetSource(row.source),
    ]);
  }

  console.log(table.toString());
}

function createListCommand(): Command {
  return new Command('list')
    .alias('ls')
    .description('List API servers')
    .option('--json', 'Emit API targets as JSON')
    .action(async (options?: { json?: boolean }) => {
      try {
        if (options?.json) setJsonMode(true);
        const spinner = createSpinner('Loading API servers...').start();
        const discovery = await discoverApiTargetRows().finally(() =>
          spinner.stop(),
        );

        if (options?.json) {
          console.log(JSON.stringify(discovery));
          return;
        }

        for (const warning of discovery.warnings) printWarning(warning);
        if (discovery.targets.length > 0) {
          printApiTargetsTable(discovery.targets);
        }
      } catch (error) {
        printError((error as Error).message);
        process.exit(1);
      }
    });
}

// Save the container's recent logs before `docker rm` destroys them — the
// container may hold the only record of why a crash happened.
function saveContainerLogs(): void {
  const result = spawnSync(
    'docker',
    ['logs', '--tail', '5000', CONTAINER_NAME],
    { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) return;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (!output.trim()) return;
  try {
    writeFileSync(join(getAnycloudDir(), 'api-last.log'), output);
  } catch {
    // Best-effort: never block start/stop on log capture.
  }
}

function isContainerRunning(): boolean {
  return isApiContainerRunning();
}

function isApiContainerRunning(): boolean {
  return isLocalApiContainerRunning();
}

const HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_PROGRESS_MS = 15_000;

/**
 * Only Docker's confirmed answer counts: an inspect that times out, cannot
 * reach the daemon, or prints garbage during a heavy boot proves nothing.
 */
function localApiContainerExited(): boolean {
  const container = inspectLocalApiContainer();
  return (
    container.failure === 'missing' ||
    (container.failure === undefined && !container.running)
  );
}

/**
 * Waits for `/health` while watching the container: the server binds only
 * after migrations and bootstrap, which can take minutes on a large database,
 * so only an exited container is a failure.
 */
async function waitForHealth(
  url: string,
): Promise<'healthy' | 'exited' | 'starting'> {
  const start = Date.now();
  let nextProgress = start + HEALTH_PROGRESS_MS;
  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    try {
      const res = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return 'healthy';
    } catch {
      // not ready yet
    }
    if (localApiContainerExited()) return 'exited';
    if (Date.now() >= nextProgress) {
      printInfo(
        `Still starting after ${Math.round((Date.now() - start) / 1000)}s...`,
      );
      nextProgress += HEALTH_PROGRESS_MS;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // A crash in the last window is still an exit, not a slow start.
  return localApiContainerExited() ? 'exited' : 'starting';
}

function createStartCommand(): Command {
  return new Command('start')
    .description('Start a local API server')
    .option('--port <port>', 'Port to listen on', String(DEFAULT_PORT))
    .option(
      '--version <version>',
      "API image version to start (defaults to this CLI's own version)",
      parseVersionOption,
    )
    .action(async (opts: ApiStartOptions) => {
      const port = parseInt(opts.port, 10);
      const version = opts.version ?? packageJson.version;
      const image = `${IMAGE_NAME}:${version}`;
      const url = `http://localhost:${port}`;

      if (!isDockerAvailable()) {
        printError('Docker is not running. Please start Docker and try again.');
        process.exit(1);
      }

      // Stop legacy container from before the rename if still running
      const legacyRunning = spawnSync(
        'docker',
        ['inspect', '--format={{.State.Running}}', LEGACY_CONTAINER_NAME],
        { encoding: 'utf-8' },
      );
      if (legacyRunning.stdout?.trim() === 'true') {
        spawnSync('docker', ['stop', LEGACY_CONTAINER_NAME], {
          stdio: 'ignore',
        });
      }
      spawnSync('docker', ['rm', LEGACY_CONTAINER_NAME], { stdio: 'ignore' });

      if (isContainerRunning()) {
        printError(
          `Local API server is already running (container: ${CONTAINER_NAME}).`,
        );
        printInfo('Run "anycloud api stop" to stop it first.');
        process.exit(1);
      }

      // Remove stale stopped container if it exists, keeping its logs for
      // post-mortems. -f because under the restart policy a crashed container
      // is "Restarting", not "Exited".
      saveContainerLogs();
      spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' });

      mkdirSync(getAnycloudDir(), { recursive: true, mode: 0o700 });
      try {
        getOrCreateCipherKey();
        ensureLocalApiToken();
      } catch (error) {
        printError((error as Error).message);
        process.exit(1);
      }
      const dbPath = getDbPath();
      const apiLabel = localApiNotificationLabel({
        username: process.env.SUDO_USER ?? userInfo().username,
        hostname: hostname(),
        port,
        defaultPort: DEFAULT_PORT,
        override: process.env[API_NOTIFICATION_LABEL_ENV],
      });

      const spinner = createSpinner(`Starting local API server (${image})...`);
      spinner.start();

      const runArgs = [
        'run',
        '-d',
        '--name',
        CONTAINER_NAME,
        '--label',
        `${LABEL_VERSION}=${version}`,
        '--log-opt',
        'max-size=50m',
        '--log-opt',
        'max-file=3',
        '-p',
        `127.0.0.1:${port}:${API_CONTAINER_PORT}`,
        '-v',
        `${getAnycloudDir()}:/root/.anycloud`,
        '--tmpfs',
        SSH_RUNTIME_TMPFS,
        '-e',
        `PORT=${API_CONTAINER_PORT}`,
        '-e',
        'SQLITE_PATH=/root/.anycloud/api.db',
        '-e',
        `${API_NOTIFICATION_LABEL_ENV}=${apiLabel}`,
        ...(process.env.IS_TEST === 'true' ? ['-e', 'IS_TEST=true'] : []),
        ...(process.env.IS_TEST === 'true' &&
        process.env.ANYCLOUD_E2E_GHCR_AUTH === 'true'
          ? ['-e', 'ANYCLOUD_E2E_GHCR_AUTH=true']
          : []),
        // E2E only: the node pool of this name fails its first launch as the
        // provider's capacity error. e2e-cluster-cloud runs without IS_TEST.
        ...(process.env.ANYCLOUD_E2E_CAPACITY_FAULT
          ? [
              '-e',
              `ANYCLOUD_E2E_CAPACITY_FAULT=${process.env.ANYCLOUD_E2E_CAPACITY_FAULT}`,
            ]
          : []),
        image,
      ];
      const runResult = spawnSync('docker', runArgs, { encoding: 'utf-8' });
      if (runResult.status !== 0) {
        spinner.fail('Failed to start API server container.');
        printError(runResult.stderr || 'docker run failed');
        process.exit(1);
      }

      // A silent (non-TTY) spinner would swallow every line from here on.
      spinner.stop();
      printInfo(
        `Waiting up to ${HEALTH_TIMEOUT_MS / 1000}s for the API server to answer; a large database can take minutes.`,
      );
      const health = await waitForHealth(url);
      if (health === 'exited') {
        printError('The API server container exited before it was healthy.');
        printInfo(`Check logs with: docker logs ${CONTAINER_NAME}`);
        process.exit(1);
      }

      // Only a server that is healthy, or still up after the whole wait, gets
      // the self-heal policy (crashes, docker daemon restarts, and host
      // reboots; an explicit `api stop` still keeps it stopped). Attaching it
      // at creation would leave a boot-crashing container restart-looping in
      // the background, holding the name and port, instead of Exited and
      // diagnosable; past the wait, `api status` shows its restarts.
      const updateResult = spawnSync(
        'docker',
        ['update', '--restart', 'unless-stopped', CONTAINER_NAME],
        { encoding: 'utf-8' },
      );
      if (updateResult.status !== 0) {
        // The server is healthy and serving — failing the start here would be
        // wrong. But without the policy it won't come back after a crash or
        // reboot, and nothing downstream surfaces that; say it once, loudly.
        printWarning(
          'Could not enable automatic restarts for the API server container' +
            (updateResult.stderr?.trim()
              ? `: ${updateResult.stderr.trim()}`
              : '.'),
        );
        printWarning(
          'The server will not restart by itself after a crash ' +
            'or reboot. Run "anycloud api stop" then "anycloud api start" to retry.',
        );
      }

      if (health === 'starting') {
        printWarning(
          `The API server is still starting after ${HEALTH_TIMEOUT_MS / 1000}s; it keeps starting in the background.`,
        );
        printInfo('Check it with: anycloud api status');
        printInfo(`Check logs with: docker logs ${CONTAINER_NAME}`);
        process.exit(LOCAL_API_STILL_STARTING_EXIT_CODE);
      }

      printSuccess('Local API server is running.');
      printInfo(`URL:      ${url}`);
      printInfo(`Database: ${dbPath}`);
      printInfo(`Version:  ${version}`);
      console.log('');
      printInfo('Run "anycloud api stop" to stop it.');
    });
}

function createStopCommand(): Command {
  return new Command('stop')
    .description('Stop the local API server')
    .action(() => {
      if (!isDockerAvailable()) {
        printError('Docker is not running.');
        process.exit(1);
      }

      if (!isContainerRunning()) {
        printError('No local API server is running.');
        process.exit(1);
      }

      const stopResult = spawnSync('docker', ['stop', CONTAINER_NAME], {
        stdio: 'ignore',
      });
      if (stopResult.status !== 0) {
        printError('Failed to stop container.');
        process.exit(1);
      }
      saveContainerLogs();
      spawnSync('docker', ['rm', CONTAINER_NAME], { stdio: 'ignore' });

      printSuccess('Local API server stopped.');
    });
}

function createLogsCommand(): Command {
  return new Command('logs')
    .description('Show logs from the local API server container')
    .option('-f, --follow', 'Follow log output')
    .action((opts) => {
      if (!isDockerAvailable()) {
        printError('Docker is not running.');
        process.exit(1);
      }

      const args = ['logs', CONTAINER_NAME];
      if (opts.follow) args.push('-f');

      if (opts.follow) {
        const child = spawn('docker', args, { stdio: 'inherit' });
        child.on('exit', (code) => process.exit(code ?? 0));
      } else {
        const result = spawnSync('docker', args, { stdio: 'inherit' });
        if (result.status !== 0) {
          process.exit(result.status ?? 1);
        }
      }
    });
}

function formatApiVersion(info: ApiTargetInfo): string {
  const version = info.apiVersion ?? 'unknown';
  if (info.compatible) return version;
  return `${version} (incompatible with CLI ${info.cliVersion}${info.compatibilityReason ? `: ${info.compatibilityReason}` : ''})`;
}

/** The K3s step (RFC 0049 C26 (b)) as `api upgrade` and `api status` show it. */
function kubernetesStepSummary(step: KubernetesStep): string {
  const at = step.finishedAt ?? step.startedAt;
  const age = at ? ` ${formatAge(Date.parse(at))} ago` : '';
  if (step.state === 'running') return `running, started${age}`;
  if (step.state === 'failed')
    return `failed${age}: ${step.reason ?? 'no reason reported'}`;
  return step.configuration === 'changed'
    ? `configuration changed, Kubernetes ready${age}`
    : `configuration current${age}`;
}

/** Upgrade N with one ✓/◌/✗ line, as `status` shows a Service upgrade. */
function printApiUpgrade(release: SystemReleaseStatus): void {
  const { upgrade, rollout } = release;
  if (!upgrade) return;
  const ready = rollout
    ? ` · ${rollout.readyReplicas}/${rollout.replicas} ready`
    : '';
  const error = upgrade.lastError ? `: ${upgrade.lastError}` : '';
  printUpgrade(upgrade, upgrade.apiVersion, 'api', `${ready}${error}`);
}

interface ApiStatus extends ApiTargetInfo {
  local: boolean;
  release: SystemReleaseStatus | null;
  /** The hosted API refused this account its upgrades (signed out or no access). */
  releaseDenied: boolean;
}

/** The upgrade read, or `denied` when this account may not read it. */
async function readRelease(
  url: string,
): Promise<SystemReleaseStatus | null | 'denied'> {
  try {
    const bearer = await hostedApiBearer(url, async () =>
      optionalGitHubToken(),
    );
    if (!bearer) return 'denied';
    return await probeSystemRelease(
      createApiClient(bearer, { apiUrl: url }).systemRelease,
    );
  } catch (error) {
    if (
      error instanceof ORPCError &&
      (error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN')
    ) {
      return 'denied';
    }
    throw error;
  }
}

async function readApiStatus(): Promise<ApiStatus> {
  const info = await getActiveApiTargetInfo();
  const local =
    info.source === 'default' || getLoopbackApiPort(info.url) !== undefined;
  const release = !local && info.healthy ? await readRelease(info.url) : null;
  return {
    ...info,
    local,
    release: release === 'denied' ? null : release,
    releaseDenied: release === 'denied',
  };
}

/** Where a watch stands: the upgrade's state, or the API not answering. */
function upgradeProgress(status: ApiStatus): string {
  if (!status.healthy) return 'not answering';
  const upgrade = status.release?.upgrade;
  return upgrade ? `Upgrade ${upgrade.number} ${upgrade.state}` : 'running';
}

/**
 * Polls until the latest upgrade is no longer `starting`. Once the API has
 * answered, a gap while it is replaced (the edge reconnecting) is waited out;
 * an API that never answered is reported at once, as without `--watch`.
 */
function watchApiStatus(
  options: { interval?: string; json?: boolean },
  signal: AbortSignal,
): Promise<ApiStatus> {
  let shown: string | null = null;
  let answered: ApiStatus | null = null;
  const read = async (): Promise<ApiStatus> => {
    try {
      return await readApiStatus();
    } catch (error) {
      if (!answered || !isApiRestart(error)) throw error;
      return { ...answered, healthy: false, release: null };
    }
  };
  return watchUntil(read, {
    intervalSeconds: parseWatchInterval(options.interval),
    signal,
    done: (status) =>
      status.local ||
      (status.healthy
        ? status.release?.upgrade?.state !== WorkloadState.Starting
        : !answered),
    onRead: (status) => {
      if (status.healthy) answered = status;
      if (options.json) {
        console.log(JSON.stringify(status));
        return;
      }
      // A stopped local API or one that never answered is printed once, below.
      if (!status.healthy && (status.local || !answered)) return;
      const progress = upgradeProgress(status);
      if (progress === shown) return;
      shown = progress;
      printInfo(`[${new Date().toLocaleTimeString()}] ${progress}`);
    },
  });
}

function printApiStatus(status: ApiStatus): void {
  const { local, release } = status;
  if (!status.healthy && !local) {
    // Found by F run 18: right after an upgrade the edge reconnects.
    printError(
      `Active API ${status.url} is not answering; right after an upgrade it may answer 503 for a few seconds while the edge reconnects. Retry.`,
    );
    process.exit(1);
  }
  // A local container that exists but does not answer is crash-looping or
  // still starting: its restarts and logs say which.
  const restarts = local ? getContainerRestartCount() : null;
  if (!status.healthy && restarts === null) {
    printInfo('Local API server is not running.');
    printInfo('Start it with: anycloud api start');
    return;
  }
  printStateHeader(
    status.healthy ? WorkloadState.Running : WorkloadState.Starting,
  );
  const fields: Array<[string, string]> = [
    ['URL', status.url],
    ['Source', status.sourceLabel],
    ['Version', formatApiVersion(status)],
  ];
  if (release?.schemaVersion) {
    fields.push(['Schema', release.schemaVersion]);
  }
  if (release?.kubernetes) {
    fields.push(['K3s step', kubernetesStepSummary(release.kubernetes)]);
  }
  if (restarts !== null) {
    fields.push(['Database', getDbPath()]);
    if (restarts > 0) {
      fields.push([
        'Restarts',
        `${restarts}: it has crashed; run "anycloud api logs" to see why`,
      ]);
    }
  }
  printFields(fields);
  if (!status.healthy) {
    printInfo('It is not answering yet. Check why with: anycloud api logs');
  }
  if (release) printApiUpgrade(release);
  if (status.releaseDenied) {
    printInfo(
      'Its upgrades are shown only to accounts it admits: run "anycloud login", or ask its owner for "anycloud api access add".',
    );
  }
}

function createStatusCommand(): Command {
  return new Command('status')
    .alias('describe')
    .description('Show the active API server and its latest upgrade')
    .option(
      '-w, --watch',
      'Refresh until the latest upgrade is running or failed',
    )
    .option(
      '--interval <seconds>',
      `Polling interval for --watch (default ${DEFAULT_WATCH_INTERVAL_SECONDS}s)`,
    )
    .option('--json', 'Emit the API server status as JSON')
    .action(
      async (options: {
        watch?: boolean;
        interval?: string;
        json?: boolean;
      }) => {
        try {
          if (options.json) setJsonMode(true);
          const status = options.watch
            ? await runUntilInterrupted('api status --watch', (signal) =>
                watchApiStatus(options, signal),
              )
            : await readApiStatus();
          if (options.json) {
            if (!options.watch) console.log(JSON.stringify(status));
            return;
          }
          printApiStatus(status);
          if (!status.local) await warnIfLegacyApiTarget();
        } catch (error) {
          if (isInterrupted(error)) {
            process.exitCode = SIGINT_EXIT_CODE;
            return;
          }
          printError((error as Error).message);
          process.exit(1);
        }
      },
    );
}

export function createApiCommand(): Command {
  const api = new Command('api').description('Manage AnyCloud API servers');

  api.addCommand(createListCommand());
  api.addCommand(createUseCommand());
  api.addCommand(createApiUpgradeCommand());
  api.addCommand(createStartCommand());
  api.addCommand(createStopCommand());
  api.addCommand(createStatusCommand());
  api.addCommand(createLogsCommand());
  api.addCommand(createApiAccessCommand());
  api.addCommand(createApiTokenCommand());

  return api;
}
