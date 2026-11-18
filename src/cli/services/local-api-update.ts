import { execFileSync, execSync } from 'child_process';
import * as semver from 'semver';

import packageJson from '../../../package.json' with { type: 'json' };
import {
  getLocalApiContainerHostPort,
  getLocalApiContainerVersion,
  isLocalApiContainerRunning,
  LOCAL_API_CONTAINER_NAME,
  LOCAL_API_STILL_STARTING_EXIT_CODE,
} from '../../shared/local-api-container.js';
import { checkApiVersion } from '../../shared/services/api-client/runtime.js';
import { isJsonMode, printInfo, printWarning } from '../utils/output.js';

const DEFAULT_API_PORT = 8080;
const API_IMAGE_LIST_FORMAT = '{{.Repository}}\t{{.Tag}}';

interface LocalApiUpdateState {
  running: boolean;
  port: number | null;
  version: string | null;
}

export interface ReconcileLocalApiOptions {
  /** Start a stopped local API. Top-level `anycloud update` deliberately omits this. */
  startIfStopped?: boolean;
  /** Port to use only when startIfStopped starts a new local API container. */
  startPort?: number;
  /** Runs once a restart is decided, before the old API stops. */
  beforeRestart?: (apiUrl: string) => Promise<void>;
}

function apiUrlForPort(apiPort: number | null): string {
  return `http://localhost:${apiPort ?? DEFAULT_API_PORT}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command that runs this anycloud: the compiled binary, whose script lives
 * in Bun's embedded /$bunfs/ filesystem, or in development the runtime with
 * its flags and the script. Homebrew removes the old Cellar version on
 * upgrade, so its stable opt link stands in for the binary.
 */
export function runningAnycloud(): string[] {
  const [executable, script] = [process.execPath, process.argv[1]];
  if (!script.startsWith('/$bunfs/')) {
    return [executable, ...process.execArgv, script];
  }
  return [executable.replace(/\/Cellar\/anycloud\/[^/]+\//, '/opt/anycloud/')];
}

function anycloudRestartBin(): string {
  return runningAnycloud().map(shellQuote).join(' ');
}

// `--version=X` (not `--version X`): the cluster program also declares a bare
// `-V, --version` flag, which Commander matches greedily against the whole
// argv. The equals form reaches `api start`'s value-taking option.
function apiStartCommand(
  apiPort: number | null,
  targetVersion: string,
): string {
  return `${anycloudRestartBin()} api start${apiPort ? ` --port ${apiPort}` : ''} --version=${targetVersion}`;
}

function apiStopCommand(): string {
  return `${anycloudRestartBin()} api stop`;
}

/** Advice a failed replacement gives; a healthy or still-starting one must not. */
export const LOCAL_API_STOP_ADVICE =
  'If it is still running, run `anycloud api stop`.';

/** The replacement local API is up but not yet healthy; nothing failed. */
export class LocalApiStillStartingError extends Error {
  constructor() {
    super(
      'The new local API server is still starting in the background. ' +
        `Check it with \`anycloud api status\` and \`docker logs ${LOCAL_API_CONTAINER_NAME}\`.`,
    );
  }
}

/** Under --json the child's lines go to stderr, keeping stdout one document. */
function childStdio(): 'inherit' | ['inherit', 2, 'inherit'] {
  return isJsonMode() ? ['inherit', 2, 'inherit'] : 'inherit';
}

/** Runs `api start`; a still-starting server is reported as such, not as broken. */
function runApiStart(startCommand: string, failure: string): void {
  try {
    execSync(startCommand, { stdio: childStdio() });
  } catch (error) {
    if (
      (error as { status?: number }).status ===
      LOCAL_API_STILL_STARTING_EXIT_CODE
    ) {
      throw new LocalApiStillStartingError();
    }
    throw new Error(failure);
  }
}

function preflightApiImage(version: string): void {
  const image = `${packageJson.apiImage}:${version}`;
  try {
    execSync(`docker image inspect ${image}`, { stdio: 'ignore' });
    return;
  } catch {
    // Fall through to the remote manifest check. docker run would have to reach
    // the same registry after the old API is stopped, so fail before stopping.
  }

  try {
    execSync(`docker manifest inspect ${image}`, { stdio: 'ignore' });
  } catch {
    throw new Error(
      `Could not verify API image ${image}, so the local API server was left unchanged.`,
    );
  }
}

interface LocalApiImageVersion {
  tag: string;
  version: string;
}

function listLocalApiImageVersions(): LocalApiImageVersion[] {
  const output = execFileSync(
    'docker',
    ['image', 'ls', packageJson.apiImage, '--format', API_IMAGE_LIST_FORMAT],
    { encoding: 'utf-8' },
  );
  const seenTags = new Set<string>();

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [repository, tag] = line.split('\t');
      const version = tag ? semver.valid(tag) : null;
      // Exact repository and canonical semver tags only. In particular, leave
      // unrelated images plus operator-managed tags such as latest/dev alone.
      if (
        repository !== packageJson.apiImage ||
        !tag ||
        !version ||
        version !== tag ||
        seenTags.has(tag)
      ) {
        return [];
      }
      seenTags.add(tag);
      return [{ tag, version }];
    });
}

/** Keep the running image and one rollback candidate after a healthy update. */
function cleanupOldApiImages(
  currentVersion: string,
  previousVersion: string | null,
): void {
  let images: LocalApiImageVersion[];
  try {
    images = listLocalApiImageVersions();
  } catch {
    printWarning(
      'Could not inspect old local AnyCloud API images; skipping image cleanup.',
    );
    return;
  }

  const canonicalCurrentVersion = semver.valid(currentVersion);
  if (!canonicalCurrentVersion) return;

  const olderImages = images.filter((image) =>
    semver.lt(image.version, canonicalCurrentVersion),
  );
  if (olderImages.length === 0) return;

  const canonicalPreviousVersion = previousVersion
    ? semver.valid(previousVersion)
    : null;
  let retainedTag =
    canonicalPreviousVersion &&
    semver.lt(canonicalPreviousVersion, canonicalCurrentVersion)
      ? olderImages.find((image) =>
          semver.eq(image.version, canonicalPreviousVersion),
        )?.tag
      : undefined;
  retainedTag ??= olderImages.sort((a, b) =>
    semver.rcompare(a.version, b.version),
  )[0]?.tag;

  const staleImages = olderImages.filter((image) => image.tag !== retainedTag);
  const failedRefs: string[] = [];
  let removed = 0;

  for (const image of staleImages) {
    const ref = `${packageJson.apiImage}:${image.tag}`;
    try {
      execFileSync('docker', ['image', 'rm', ref], { stdio: 'ignore' });
      removed += 1;
    } catch {
      failedRefs.push(ref);
    }
  }

  if (removed > 0) {
    printInfo(
      `Removed ${removed} old local AnyCloud API image${removed === 1 ? '' : 's'}.`,
    );
  }
  if (failedRefs.length > 0) {
    printWarning(
      `Could not remove ${failedRefs.length} old local AnyCloud API image${
        failedRefs.length === 1 ? '' : 's'
      }: ${failedRefs.join(', ')}`,
    );
  }
}

async function getRunningLocalApiVersion(
  apiPort: number | null,
): Promise<string | null> {
  const labelVersion = getLocalApiContainerVersion();
  if (labelVersion) return labelVersion;

  const version = await checkApiVersion(apiUrlForPort(apiPort));
  return version.apiVersion ?? null;
}

async function getLocalApiUpdateState(): Promise<LocalApiUpdateState> {
  const running = isLocalApiContainerRunning();
  const port = running ? getLocalApiContainerHostPort() : null;
  const version = running ? await getRunningLocalApiVersion(port) : null;
  return { running, port, version };
}

async function startStoppedLocalApiServer(
  targetVersion: string,
  startPort: number | undefined,
): Promise<void> {
  const startCommand = apiStartCommand(startPort ?? null, targetVersion);
  printInfo(
    `Starting local API server to match installed anycloud ${targetVersion}...`,
  );
  preflightApiImage(targetVersion);
  runApiStart(
    startCommand,
    `Could not start the local API server. Fix the issue, then run \`${startCommand}\`.`,
  );
  cleanupOldApiImages(targetVersion, null);
}

// Restart the running local API server so it comes back on targetVersion. The
// image tag is selected by the freshly installed CLI binary on PATH.
async function restartLocalApiServer(params: {
  apiPort: number | null;
  targetVersion: string;
}): Promise<void> {
  const { apiPort, targetVersion } = params;
  const startCommand = apiStartCommand(apiPort, targetVersion);
  printInfo('Restarting local API server to apply the update...');
  preflightApiImage(targetVersion);
  try {
    execSync(apiStopCommand(), { stdio: childStdio() });
  } catch {
    throw new Error(
      'Could not stop the running local API server to replace it. ' +
        'Fix the issue, then run this command again.',
    );
  }
  runApiStart(
    startCommand,
    'Stopped the old local API server, but the replacement did not start cleanly. ' +
      `${LOCAL_API_STOP_ADVICE} Then run \`${startCommand}\` once the issue is fixed.`,
  );
}

/**
 * Reconcile the local API container to the requested AnyCloud release.
 *
 * Container state is read immediately before it is acted on. Callers may
 * resolve routing separately, but must not use an earlier Docker inspection to
 * decide whether or how this function should restart the container.
 * Returns the version the local API ran before, null when none ran.
 */
export async function reconcileLocalApi(
  targetVersion: string,
  options: ReconcileLocalApiOptions = {},
): Promise<string | null> {
  const apiState = await getLocalApiUpdateState();

  if (!apiState.running) {
    if (options.startIfStopped) {
      await startStoppedLocalApiServer(targetVersion, options.startPort);
    } else {
      printInfo(
        'No local API server is running, so there is nothing to restart.',
      );
    }
    return null;
  }

  if (apiState.version === targetVersion) {
    printInfo(
      `Local API server already matches installed anycloud ${targetVersion}; no restart needed.`,
    );
    cleanupOldApiImages(targetVersion, null);
    return apiState.version;
  }

  printInfo(
    `Local API server is on ${apiState.version ?? 'a different version'}; ` +
      `restarting it to match installed anycloud ${targetVersion}.`,
  );
  await options.beforeRestart?.(apiUrlForPort(apiState.port));
  await restartLocalApiServer({
    apiPort: apiState.port,
    targetVersion,
  });
  cleanupOldApiImages(targetVersion, apiState.version);
  return apiState.version ?? null;
}
