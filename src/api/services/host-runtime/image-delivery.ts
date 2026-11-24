/**
 * Image delivery: pull a workload image onto one VM host. It authenticates to
 * GHCR in a short exec first, prefers containerd's same-layer transfer where
 * the host supports it, falls back to a detached Docker pull that outlives SSH
 * stream teardowns, and reports telemetry for every outcome.
 */

import { parseFamiliarName } from '@swimlane/docker-reference';
import { log } from '../logger.js';
import {
  assertVmHostContainerConfiguration,
  type StoredWorkload,
} from '../workload-record.js';
import { type ImagePullTelemetry } from '../../../shared/image.js';
import { SSHExecError } from '../gateways/ssh.js';
import { shellEscape, withRetry } from '../../../shared/utils.js';
import { redactSecrets } from '../redact.js';
import {
  PULL_TOTAL_TIMEOUT_MS,
  CONTAINERD_TRANSFER_PULL_TIMEOUT_MS,
  PULL_POLL_INTERVAL_MS,
  PULL_CONTROL_TIMEOUT_MS,
} from '../../config.js';
import { runDetachedOnVm, DetachedRunError } from '../vm-exec.js';
import { measuredPullCommand, parsePullStats } from './pull-timing.js';
import {
  pullNeedsRegistryAuth,
  resolveWorkloadImage,
} from '../container-image.js';
import {
  CONTAINERD_TRANSFER_PULL_COMMAND,
  containerdImageReference,
  dockerConfigDirPath,
  ghcrLoginCommand,
  detectContainerdTransferRuntime,
  transferAuthFileCommand,
  transferAuthFilePath,
  type ContainerdTransferRuntime,
} from '../containerd-transfer.js';
import { errorMessage } from '../../../shared/log-diagnostics.js';
import { jobHostPrePull } from '../job-host.js';
import { DeployError } from '../../../shared/errors.js';
import { archMismatchGuidance } from '../../../shared/error-formatter.js';
import { workloadArchitecture } from '../../../shared/cloud-config.js';
import { HOST_PLATFORM_FLAG } from '../../runtime-artifacts.js';

type CommandResult = { code: number; stdout: string; stderr: string };

/** The Docker host commands image delivery runs; `DockerManager` provides them. */
export interface ImageDeliveryHost {
  readonly host: string;
  /** 127.0.0.1, for unit tests and docker-in-docker: no SSH stream to lose. */
  readonly isLocal: boolean;
  exec(cmd: string, commandTimeoutMs?: number): Promise<CommandResult>;
  execResult(cmd: string, commandTimeoutMs: number): Promise<CommandResult>;
}

export interface DockerPullOptions {
  /** Prefer containerd's same-layer transfer service. Runtime capability still
   * decides; unsupported hosts use the ordinary Docker path. */
  preferContainerdTransfer?: boolean;
}

class PullError extends DeployError {
  public readonly elapsedMs: number;

  constructor(
    message: string,
    public readonly pullStdout: string,
    public readonly pullStderr: string,
    public readonly diskSpace: string,
    public readonly imagePull: ImagePullTelemetry,
    /** A full root disk or an image without the host's architecture is the
     * user's (400): runStep ends the attempt Invalid instead of retrying. */
    userFault = false,
  ) {
    super(message, userFault ? 400 : 500);
    this.name = 'PullError';
    this.elapsedMs = imagePull.elapsedMs;
  }
}

type ImagePullDetails = Omit<
  ImagePullTelemetry,
  'schemaVersion' | 'method' | 'outcome' | 'elapsedMs'
>;

function makeImagePullTelemetry(
  method: ImagePullTelemetry['method'],
  outcome: ImagePullTelemetry['outcome'],
  startedAt: number,
  details: Partial<ImagePullDetails> = {},
): ImagePullTelemetry {
  return {
    schemaVersion: 1,
    method,
    outcome,
    elapsedMs: Date.now() - startedAt,
    ...details,
  };
}

function normalizeTransferReason(reason: string): string {
  return /^containerd_.+_lt_2\.1$/.test(reason)
    ? 'containerd_version_too_old'
    : reason;
}

function classifyTransferFailure(error: unknown): string {
  const detail = [
    errorMessage(error),
    error instanceof DetachedRunError ? error.logTail : '',
  ]
    .join('\n')
    .toLowerCase();
  if (/\b429\b|throttl|too many requests/.test(detail)) {
    return 'registry_throttled';
  }
  if (
    /\b(?:401|403)\b|unauthori[sz]ed|authentication|access denied/.test(detail)
  ) {
    return 'registry_auth';
  }
  if (/timed? out|timeout/.test(detail)) {
    return 'timeout';
  }
  return 'transfer_failed';
}

type AuthenticationFailureReason =
  | 'registry_auth'
  | 'timeout'
  | 'transport_error'
  | 'auth_setup_failed';

type AuthenticationCommandStage = 'registry_login' | 'transfer_auth_file';

const AUTHENTICATION_FAILURE_MESSAGES: Record<
  AuthenticationFailureReason,
  string
> = {
  registry_auth: 'Failed to authenticate',
  timeout: 'Registry authentication timed out',
  transport_error: 'Lost the VM connection while authenticating',
  auth_setup_failed: 'Failed to prepare registry authentication',
};

const AUTHENTICATION_TIMEOUT_PATTERN =
  /timed?\s*out|timeout|deadline exceeded/i;
const DOCKER_CLIENT_SETUP_FAILURE_PATTERN =
  /cannot connect to (?:the )?docker daemon|is (?:the )?docker daemon running|permission denied while trying to connect to (?:the )?docker daemon|\bdocker\s*:\s*(?:command\s+)?not found\b|executable file not found/i;
const REGISTRY_CREDENTIAL_FAILURE_PATTERN =
  /\b(?:401|403)\b|unauthori[sz]ed|authentication required|forbidden|access denied|denied:\s*denied|(?:invalid|bad)\s+(?:credentials?|token)\b/i;

function classifyAuthenticationResult(
  result: CommandResult,
  stage: AuthenticationCommandStage,
): AuthenticationFailureReason {
  const detail = `${result.stderr}\n${result.stdout}`;
  if (result.code === 124 || AUTHENTICATION_TIMEOUT_PATTERN.test(detail)) {
    return 'timeout';
  }
  if (stage === 'registry_login') {
    if (DOCKER_CLIENT_SETUP_FAILURE_PATTERN.test(detail)) {
      return 'auth_setup_failed';
    }
    if (REGISTRY_CREDENTIAL_FAILURE_PATTERN.test(detail)) {
      return 'registry_auth';
    }
  }
  return 'auth_setup_failed';
}

/** `df -h` shows under 1M free on `/` (100% rounds up), or the command ran out of space. */
function rootDiskFullDetail(diskSpace: string, output: string): string | null {
  const size = /^\S+\s+(\S+)\s+\S+\s+(?:\d+|[\d.]+K)\s+\S+%\s+\/$/m.exec(
    diskSpace,
  )?.[1];
  if (!size && !/no space left on device/i.test(output)) return null;
  return `the VM's root disk is full${size ? ` (${size})` : ''}; increase \`--disk-size\``;
}

function classifyAuthenticationError(
  error: unknown,
): AuthenticationFailureReason {
  const detail = errorMessage(error);
  return AUTHENTICATION_TIMEOUT_PATTERN.test(detail)
    ? 'timeout'
    : 'transport_error';
}

function authenticationErrorOutput(error: unknown): {
  stdout: string;
  stderr: string;
} {
  return error instanceof SSHExecError
    ? { stdout: error.stdout, stderr: error.stderr }
    : { stdout: '', stderr: '' };
}

function redactAuthenticationOutput(value: string, credential: string): string {
  const withoutKnownCredential = credential
    ? value.split(credential).join('<REDACTED_GH_TOKEN>')
    : value;
  return redactSecrets(withoutKnownCredential).slice(-2000);
}

function execAuthenticationCommand(
  docker: ImageDeliveryHost,
  command: string,
  stage: AuthenticationCommandStage,
): Promise<CommandResult> {
  return withRetry(
    () => docker.execResult(command, PULL_CONTROL_TIMEOUT_MS),
    stage === 'registry_login'
      ? 'GHCR registry login'
      : 'GHCR transfer credential setup',
    {
      maxAttempts: 4,
      waitMs: 5000,
      exponentialBackoff: false,
      onRetry: (attempt, max) => {
        log.warn('Retrying GHCR authentication command', {
          host: docker.host,
          stage,
          attempt,
          max,
        });
      },
    },
  );
}

/**
 * Pull Docker image from registry
 * @param props Workload properties
 */
export async function pullImage(
  docker: ImageDeliveryHost,
  props: StoredWorkload,
  options: DockerPullOptions = {},
): Promise<ImagePullTelemetry> {
  assertVmHostContainerConfiguration(props);
  const { id } = props;
  const image = resolveWorkloadImage(props);

  // Validate image reference format before attempting pull
  try {
    parseFamiliarName(image);
  } catch {
    throw new Error(`Invalid image reference format: ${image}`);
  }

  // Log disk space before pulling to detect full /var/lib/docker partitions
  let diskSpace = '';
  try {
    const { stdout: dfOut } = await docker.exec(
      'LC_ALL=C df -h /var/lib/docker',
      PULL_CONTROL_TIMEOUT_MS,
    );
    diskSpace = dfOut.trim();
  } catch {
    // non-fatal — /var/lib/docker may not be a separate mount
  }
  log.info('Disk space before pull', {
    id,
    image,
    host: docker.host,
    df: diskSpace,
  });

  const useGhcrAuth = pullNeedsRegistryAuth(props, image);
  const prepulled = !useGhcrAuth && (await jobHostPrePull(docker, id, image));
  if (prepulled) return prepulled;

  const dockerConfig = useGhcrAuth ? dockerConfigDirPath(id) : undefined;
  try {
    // Local (unit-test / docker-in-docker) host: no SSH stream to be torn
    // down, so pull synchronously without the detach machinery.
    const pull = docker.isLocal ? pullImageDirect : pullImageRemote;
    return await pull(docker, props, options, dockerConfig, diskSpace, image);
  } finally {
    if (dockerConfig) {
      await docker
        .exec(`rm -rf ${shellEscape(dockerConfig)}`, PULL_CONTROL_TIMEOUT_MS)
        .catch(() => {});
    }
  }
}

async function pullImageRemote(
  docker: ImageDeliveryHost,
  props: StoredWorkload,
  options: DockerPullOptions,
  dockerConfig: string | undefined,
  diskSpace: string,
  image: string,
): Promise<ImagePullTelemetry> {
  const { id, registryUsername, githubToken } = props;
  const transferRequested = !!options.preferContainerdTransfer;

  // Remote VMs: decouple the pull from the SSH control stream. A long
  // `docker pull` over one SSH exec is killed by ~5-min NAT/idle teardowns —
  // and a layer larger than that window then never completes, because docker
  // re-downloads an incomplete layer from scratch each attempt. Instead run the
  // pull as a VM-side transient systemd unit (independent of any SSH channel)
  // and poll a result sentinel with short execs that survive the teardowns.
  log.info('Preparing remote image pull', { id, image, host: docker.host });

  let transferRuntime: ContainerdTransferRuntime = {
    supported: false,
    reason: 'not_requested',
  };
  if (options.preferContainerdTransfer) {
    try {
      transferRuntime = await detectContainerdTransferRuntime(
        (cmd, timeoutMs) => docker.exec(cmd, timeoutMs),
      );
    } catch (error) {
      transferRuntime = {
        supported: false,
        reason: 'capability_probe_failed',
      };
      log.warn('Containerd transfer capability probe failed', {
        id,
        image,
        host: docker.host,
        error: error,
      });
    }
  }

  const transferReady =
    transferRuntime.supported &&
    !!transferRuntime.address &&
    !!transferRuntime.namespace &&
    !!transferRuntime.snapshotter;
  const transferAuthFile =
    transferReady && dockerConfig ? transferAuthFilePath(id) : undefined;
  const transferDetails: Partial<ImagePullDetails> = transferRequested
    ? {
        ...(!transferReady && {
          reason:
            transferRuntime.reason === 'ready'
              ? 'runtime_incomplete'
              : normalizeTransferReason(transferRuntime.reason),
        }),
        ...(transferRuntime.containerdVersion && {
          containerdVersion: transferRuntime.containerdVersion,
        }),
        ...(transferRuntime.snapshotter && {
          snapshotter: transferRuntime.snapshotter,
        }),
      }
    : {};

  let fallbackReason: string | undefined;
  // Authenticate first, as a short exec, so the token never reaches the
  // detached unit's argv / the journal / `ps`.
  if (dockerConfig) {
    const authenticationStartedAt = Date.now();
    log.info('Using GitHub authentication for private registry', {
      id,
      host: docker.host,
    });

    const authenticationFailure = (
      reason: AuthenticationFailureReason,
      output: { stdout: string; stderr: string },
    ): PullError => {
      const fullDisk = rootDiskFullDetail(
        diskSpace,
        output.stderr + output.stdout,
      );
      const message = `${AUTHENTICATION_FAILURE_MESSAGES[reason]} for image '${image}' on ${docker.host}${fullDisk ? `: ${fullDisk}` : ''}`;
      const imagePull = makeImagePullTelemetry(
        transferReady ? 'containerd-transfer' : 'docker',
        'failed',
        authenticationStartedAt,
        { ...transferDetails, reason },
      );
      return new PullError(
        message,
        redactAuthenticationOutput(output.stdout, githubToken!),
        redactAuthenticationOutput(output.stderr, githubToken!),
        diskSpace,
        imagePull,
        fullDisk !== null,
      );
    };

    const authenticationStages: Array<[AuthenticationCommandStage, string]> = [
      [
        'registry_login',
        ghcrLoginCommand(registryUsername!, githubToken!, dockerConfig),
      ],
    ];
    if (transferAuthFile) {
      authenticationStages.push([
        'transfer_auth_file',
        transferAuthFileCommand(
          registryUsername!,
          githubToken!,
          transferAuthFile,
        ),
      ]);
    }

    for (const [stage, command] of authenticationStages) {
      let failure: PullError | undefined;
      try {
        const result = await execAuthenticationCommand(docker, command, stage);
        if (result.code !== 0) {
          failure = authenticationFailure(
            classifyAuthenticationResult(result, stage),
            result,
          );
        }
      } catch (error) {
        failure = authenticationFailure(
          classifyAuthenticationError(error),
          authenticationErrorOutput(error),
        );
      }
      if (!failure) continue;
      if (stage === 'registry_login') throw failure;
      // Docker is logged in, so its pull needs no transfer credential.
      fallbackReason = failure.imagePull.reason;
      log.warn('Transfer credential setup failed; pulling with Docker', {
        id,
        error: failure.message,
        stderr: failure.pullStderr,
      });
    }
  }

  const vmExec = docker.exec.bind(docker);
  const startedAt = Date.now();
  if (transferReady && !fallbackReason) {
    log.info('Pulling image with containerd same-layer transfer', {
      id,
      image,
      host: docker.host,
      containerdVersion: transferRuntime.containerdVersion,
      snapshotter: transferRuntime.snapshotter,
    });
    try {
      const { logTail } = await runDetachedOnVm(vmExec, {
        unit: `ac-transfer-${id.replace(/[^a-zA-Z0-9_.-]/g, '_')}`,
        command: measuredPullCommand(CONTAINERD_TRANSFER_PULL_COMMAND),
        env: {
          AC_PULL_IMAGE: containerdImageReference(image),
          AC_CONTAINERD_ADDRESS: transferRuntime.address!,
          AC_CONTAINERD_NAMESPACE: transferRuntime.namespace!,
          AC_SNAPSHOTTER: transferRuntime.snapshotter!,
          ...(transferAuthFile
            ? { AC_REGISTRY_AUTH_FILE: transferAuthFile }
            : {}),
        },
        totalTimeoutMs: CONTAINERD_TRANSFER_PULL_TIMEOUT_MS,
        pollIntervalMs: PULL_POLL_INTERVAL_MS,
        controlTimeoutMs: PULL_CONTROL_TIMEOUT_MS,
        maxLaunches: 1,
        logContext: {
          id,
          image,
          host: docker.host,
          mode: 'containerd-transfer',
        },
      });
      const imagePull = makeImagePullTelemetry(
        'containerd-transfer',
        'succeeded',
        startedAt,
        { ...transferDetails, ...parsePullStats(logTail).stats },
      );
      log.info('Image pulled successfully with containerd transfer', {
        id,
        image,
        host: docker.host,
        ...imagePull,
      });
      return imagePull;
    } catch (error) {
      fallbackReason = classifyTransferFailure(error);
      log.warn('Containerd transfer pull failed; retrying with Docker', {
        id,
        image,
        host: docker.host,
        error: error,
        transferLogTail:
          error instanceof DetachedRunError
            ? error.logTail.slice(-2000)
            : undefined,
      });
    }
  } else if (!transferReady && options.preferContainerdTransfer) {
    log.info('Containerd transfer unavailable; using Docker pull', {
      id,
      image,
      host: docker.host,
      reason: transferRuntime.reason,
      containerdVersion: transferRuntime.containerdVersion,
    });
  }

  // The worker normally removes this through its trap. Cover a killed
  // shell/unit, or a worker never launched, before using Docker's credentials.
  if (fallbackReason && transferAuthFile) {
    await docker
      .exec(`rm -f ${shellEscape(transferAuthFile)}`, PULL_CONTROL_TIMEOUT_MS)
      .catch(() => {});
  }

  log.info('Pulling Docker image (detached)', { id, image, host: docker.host });
  try {
    const { logTail } = await runDetachedOnVm(vmExec, {
      unit: `ac-pull-${id.replace(/[^a-zA-Z0-9_.-]/g, '_')}`,
      // Image passed via env so it needs no nested quoting and is not
      // re-evaluated by the SSH shell.
      command: measuredPullCommand(
        `docker pull ${HOST_PLATFORM_FLAG} "$AC_PULL_IMAGE"`,
      ),
      env: {
        AC_PULL_IMAGE: image,
        ...(dockerConfig && { DOCKER_CONFIG: dockerConfig }),
      },
      totalTimeoutMs: PULL_TOTAL_TIMEOUT_MS,
      pollIntervalMs: PULL_POLL_INTERVAL_MS,
      controlTimeoutMs: PULL_CONTROL_TIMEOUT_MS,
      logContext: { id, image, host: docker.host },
    });
    const imagePull = makeImagePullTelemetry(
      fallbackReason ? 'docker-fallback' : 'docker',
      'succeeded',
      startedAt,
      {
        ...transferDetails,
        ...(fallbackReason && { reason: fallbackReason }),
        ...parsePullStats(logTail).stats,
      },
    );
    log.info('Image pulled successfully', {
      id,
      image,
      host: docker.host,
      ...imagePull,
    });
    return imagePull;
  } catch (error) {
    const msg = (error as Error)?.message || String(error);
    const { stats, output: logTail } = parsePullStats(
      error instanceof DetachedRunError ? error.logTail : '',
    );
    const imagePull = makeImagePullTelemetry(
      fallbackReason ? 'docker-fallback' : 'docker',
      'failed',
      startedAt,
      {
        ...transferDetails,
        ...(fallbackReason && { reason: fallbackReason }),
        ...stats,
      },
    );
    const fullDisk = rootDiskFullDetail(diskSpace, logTail);
    const wrongPlatform = archMismatchGuidance(
      logTail,
      image,
      workloadArchitecture(props),
    );
    throw new PullError(
      `Failed to pull image '${image}' on ${docker.host}: ${fullDisk ? `${fullDisk} (${msg})` : (wrongPlatform ?? msg)}`,
      logTail,
      '',
      diskSpace,
      imagePull,
      fullDisk !== null || wrongPlatform !== null,
    );
  }
}

/**
 * Synchronous pull for the local host (127.0.0.1), used by unit tests and
 * docker-in-docker. No SSH channel to be torn down, so no detach machinery.
 */
async function pullImageDirect(
  docker: ImageDeliveryHost,
  props: StoredWorkload,
  options: DockerPullOptions,
  dockerConfig: string | undefined,
  diskSpace: string,
  image: string,
): Promise<ImagePullTelemetry> {
  const { id, registryUsername, githubToken } = props;
  const startedAt = Date.now();
  const transferDetails = options.preferContainerdTransfer
    ? { reason: 'local_host' }
    : {};
  let lastOutput: { stdout: string; stderr: string } | undefined;

  const pullCmd = dockerConfig
    ? `${ghcrLoginCommand(registryUsername!, githubToken!, dockerConfig)} && DOCKER_CONFIG=${shellEscape(dockerConfig)} docker pull ${shellEscape(image)}`
    : `docker pull ${shellEscape(image)}`;

  try {
    await withRetry(
      async () => {
        const result = await docker.exec(pullCmd);
        lastOutput = result;
        return result;
      },
      `docker pull ${image}`,
      {
        maxAttempts: 5,
        waitMs: 15_000,
        exponentialBackoff: false,
        onRetry: (attempt, max, error) => {
          if (error instanceof SSHExecError) {
            lastOutput = { stdout: error.stdout, stderr: error.stderr };
          }
          log.warn('Retrying image pull', {
            id,
            image,
            host: docker.host,
            attempt,
            max,
          });
        },
      },
    );
    const imagePull = makeImagePullTelemetry(
      'docker',
      'succeeded',
      startedAt,
      transferDetails,
    );
    log.info('Image pulled successfully', {
      id,
      image,
      host: docker.host,
      elapsedMs: imagePull.elapsedMs,
    });
    return imagePull;
  } catch (error) {
    if (error instanceof SSHExecError) {
      lastOutput = { stdout: error.stdout, stderr: error.stderr };
    }
    const msg = (error as any)?.message || String(error);
    const imagePull = makeImagePullTelemetry(
      'docker',
      'failed',
      startedAt,
      transferDetails,
    );
    throw new PullError(
      `Failed to pull image '${image}' on ${docker.host}: ${msg}`,
      lastOutput?.stdout?.slice(-2000) ?? '',
      lastOutput?.stderr?.slice(-2000) ?? '',
      diskSpace,
      imagePull,
    );
  }
}
