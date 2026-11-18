/**
 * Docker container management via SSH or local exec
 * Uses SSHManager for remote hosts, execSync for localhost
 */

import { execSync } from 'child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  rename,
  rm,
  writeFile as writeFileOnDisk,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { log } from './logger.js';
import {
  assertVmHostContainerConfiguration,
  type StoredWorkload,
} from './workload-record.js';
import { WorkloadType } from '../../shared/workload.js';
import { ContainerState } from '../../shared/runtime.js';
import type { RuntimeContainerStatus } from './container-health.js';
import { createTransport } from './gateways/transport.js';
import type { VmTransport } from './gateways/transport-contract.js';
import {
  shellEscape,
  withRetry,
  extractErrorLines,
} from '../../shared/utils.js';
import {
  ANYCLOUD_DOCKER_ROLES,
  buildAnycloudDockerLabels,
} from '../../shared/docker-labels.js';
import { isSecretKey } from '../../shared/secret-keys.js';
import { redactSecrets } from './redact.js';
import { resolveServiceContainerPort } from './network.js';
import { resolveWorkloadImage } from './container-image.js';
import { parseDockerGpuRequest } from '../../shared/docker-options.js';
import {
  RUNTIME_SECRETS_DIR,
  RUNTIME_SECRETS_ENV_FILE,
  readSecretFileRevisions,
  serializeRuntimeSecretsEnv,
  writeSecretFiles,
  type RuntimeSecret,
} from './runtime-secrets.js';

export const STATUS_INSPECT_TIMEOUT_MS = 15_000;
const STATUS_FOLLOWUP_TIMEOUT_MS = 5_000;

type CommandResult = { code: number; stdout: string; stderr: string };

// Root-only runtime-secret file. VM hosts provide tmpfs at /run.
export const SECRETS_ENV_FILE = RUNTIME_SECRETS_ENV_FILE;
const SECRET_FILES_DIR = `${RUNTIME_SECRETS_DIR}/files`;
const VM_WORKSPACE_PATH = '/workspace';
const DOCKER_SOCKET_PATH = '/var/run/docker.sock';
const VM_KEEPALIVE_COMMAND = 'while :; do sleep 3600; done';
const KVM_DEVICE_PATH = '/dev/kvm';
/** Container engines and Kubernetes-in-Docker in a `--host-docker` Job need more than Ubuntu's 128. */
const HOST_DOCKER_INOTIFY_INSTANCES = 8192;

/**
 * Drop new connections from other machines to a `--host-docker` Job's
 * published ports, on the default-route interface, for each address family
 * whose DOCKER-USER chain Docker made; the host, host-networked containers
 * and other containers still reach them. Docker keeps DOCKER-USER across its
 * restarts, and every container start reapplies it after a reboot. Prints
 * the families it guards.
 */
const HOST_DOCKER_PORT_GUARD_COMMAND = `dev=$(awk '$2 == "00000000" { print $1; exit }' /proc/net/route)
[ -n "$dev" ] || exit 1
for t in iptables ip6tables; do
  command -v "$t" >/dev/null 2>&1 && "$t" -n -L DOCKER-USER >/dev/null 2>&1 || continue
  rule="DOCKER-USER -i $dev -m conntrack --ctstate NEW -j DROP"
  "$t" -C $rule 2>/dev/null || "$t" -I $rule || exit 1
  echo "$t"
done`;

/** Host groups a container joins: the Docker socket's, and `/dev/kvm`'s when present. */
export interface HostGroups {
  socket: number;
  kvm?: number;
}

/**
 * `--device` flags for the NVIDIA nodes `--gpus` selects, expanded by the host
 * shell and skipping nodes that don't exist. With cgroup v2 and Docker's
 * systemd driver, a host `systemctl daemon-reload` drops the device rules the
 * NVIDIA hook added, so new CUDA processes in a running container find no GPU;
 * explicit devices survive it. `--gpus N` selects indexes 0..N-1;
 * `nvidia-smi -q` lists GPUs in index order with the Minor Number that names
 * each /dev/nvidiaN (`--query-gpu` has no minor-number field).
 */
function nvidiaDeviceArgs(gpus: string): string {
  const request = parseDockerGpuRequest(gpus);
  const gpuNodes =
    request === 'all'
      ? '/dev/nvidia[0-9]*'
      : `$(nvidia-smi -q 2>/dev/null | awk -F': ' '/^ *Minor Number/ && n++ < ${request} { print "/dev/nvidia" $2 }')`;
  return `$(for d in /dev/nvidiactl /dev/nvidia-uvm /dev/nvidia-uvm-tools ${gpuNodes}; do [ -e "$d" ] && printf ' --device %s' "$d"; done)`;
}

export type DockerBucketMounts = {
  input?: string;
  output?: string;
  checkpoint?: string;
};

export type VmContainerInspection =
  | { kind: 'missing' }
  | {
      kind: 'managed';
      state: RuntimeContainerStatus['state'];
    }
  | {
      kind: 'conflict';
      state: RuntimeContainerStatus['state'];
    };

export type CreateContainerIfAbsentResult =
  | { outcome: 'created' }
  | { outcome: 'already-running' }
  | { outcome: 'aborted' }
  | {
      outcome: 'managed-not-running';
      state: RuntimeContainerStatus['state'];
    }
  | {
      outcome: 'conflict';
      state: RuntimeContainerStatus['state'];
    };

export class DockerManager {
  private ssh: VmTransport | null = null;
  private containerName: string | null = null;
  readonly host: string;
  readonly isLocal: boolean;

  constructor(
    host: string,
    privateKey: string,
    port?: number,
    username?: string,
  ) {
    this.host = host;
    // Only use local exec for explicit 127.0.0.1 (unit tests)
    // 'localhost' uses SSH (integration tests with Docker-in-Docker)
    this.isLocal = host === '127.0.0.1';
    if (!this.isLocal) {
      this.ssh = createTransport(host, privateKey, port, username);
    }
  }

  private execLocalOnce(cmd: string, commandTimeoutMs?: number): CommandResult {
    try {
      const stdout = execSync(cmd, {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: commandTimeoutMs,
      });
      return { code: 0, stdout, stderr: '' };
    } catch (error: unknown) {
      const failure = error as {
        status?: unknown;
        stdout?: Buffer | string;
        stderr?: Buffer | string;
      };
      if (typeof failure.status !== 'number') throw error;
      return {
        code: failure.status,
        stdout: failure.stdout?.toString() ?? '',
        stderr: failure.stderr?.toString() ?? '',
      };
    }
  }

  /**
   * Execute a command locally or via SSH
   * Throws on non-zero exit codes (consistent with SSHManager.exec behavior)
   */
  async exec(
    cmd: string,
    commandTimeoutMs?: number,
    maxAttempts = 4,
  ): Promise<CommandResult> {
    if (this.isLocal) {
      return withRetry(
        async () => {
          const result = this.execLocalOnce(cmd);
          if (result.code !== 0) {
            throw new Error(
              `Command exited with code ${result.code}: ${result.stderr || result.stdout}`,
            );
          }
          return result;
        },
        `Docker local: ${cmd.slice(0, 50)}`,
      );
    }

    return this.ssh!.exec(cmd, maxAttempts, false, commandTimeoutMs);
  }

  /** Run one status command without turning a nonzero exit into a transport error. */
  async execResult(
    cmd: string,
    commandTimeoutMs: number,
  ): Promise<CommandResult> {
    if (this.isLocal) {
      return this.execLocalOnce(cmd, commandTimeoutMs);
    }

    let stdout = '';
    let stderr = '';
    const code = await this.ssh!.execStream(cmd, {
      commandTimeoutMs,
      onStdout: (chunk) => {
        stdout += chunk.toString();
      },
      onStderr: (chunk) => {
        stderr += chunk.toString();
      },
    });
    return { code, stdout, stderr };
  }

  /**
   * Start container from pulled image
   * @param props Workload properties
   * @param buckets Optional bucket configuration for bind mounts
   * @param secrets Optional resolved named Secrets. Their merged values are
   *                written to /run/anycloud-secrets/env on the VM (tmpfs, mode
   *                0600) for `docker run --env-file`, and each one's files
   *                under /run/anycloud-secrets/files.
   */
  async startContainer(
    props: StoredWorkload,
    buckets?: DockerBucketMounts,
    secrets?: readonly RuntimeSecret[],
  ): Promise<void> {
    assertVmHostContainerConfiguration(props);
    const { id } = props;

    try {
      log.info('Starting container', { id, host: this.host });
      await this.writeRuntimeSecrets(secrets);
      await this.ensureDockerNetwork(props);
      await this.runContainer(props, buckets);
    } catch (error) {
      const msg = (error as any)?.message || String(error);
      // Preserve original error metadata, just update message
      if (error instanceof Error) {
        error.message = `Failed to start container on ${this.host}: ${msg}`;
        throw error;
      }
      throw new Error(`Failed to start container on ${this.host}: ${msg}`);
    }
  }

  /**
   * Inspect the deterministic VM-container name and verify that a winner
   * belongs to this workload. This deliberately treats labels as an
   * ownership boundary: repair must never adopt or remove an unrelated
   * container that happens to use the same name.
   */
  async inspectVmContainer(
    props: Pick<StoredWorkload, 'id' | 'userId'>,
  ): Promise<VmContainerInspection> {
    const status = await this.getContainerStatus(props.id);
    if (status.state === ContainerState.NotFound) return { kind: 'missing' };

    const labelsResult = await this.execResult(
      `docker inspect --type container --format '{{json .Config.Labels}}' ${shellEscape(props.id)} 2>/dev/null`,
      STATUS_INSPECT_TIMEOUT_MS,
    );
    if (labelsResult.code !== 0) {
      // The container may have disappeared between the state and label reads.
      const refreshed = await this.getContainerStatus(props.id);
      if (refreshed.state === ContainerState.NotFound)
        return { kind: 'missing' };
      throw new Error(
        `Cannot inspect ownership labels for VM container ${props.id}`,
      );
    }

    let labels: Record<string, string>;
    try {
      labels = JSON.parse(labelsResult.stdout.trim()) as Record<string, string>;
    } catch {
      return { kind: 'conflict', state: status.state };
    }
    const expected = buildAnycloudDockerLabels({
      role: ANYCLOUD_DOCKER_ROLES.workload,
      workloadId: props.id,
      userId: props.userId,
    });
    // Labels, not the name, are the ownership boundary: a name match alone is
    // never sufficient for repair. `expected` always carries the managed/role/
    // workload-id triple and omits only the user id, so legacy rows with an
    // empty user id still have to match those three.
    const owned = Object.entries(expected).every(
      ([key, value]) => labels?.[key] === value,
    );
    return owned
      ? { kind: 'managed', state: status.state }
      : { kind: 'conflict', state: status.state };
  }

  async hasWorkloadImage(props: StoredWorkload): Promise<boolean> {
    assertVmHostContainerConfiguration(props);
    const image = resolveWorkloadImage(props);
    const result = await this.execResult(
      `docker image inspect ${shellEscape(image)} >/dev/null 2>&1`,
      STATUS_INSPECT_TIMEOUT_MS,
    );
    if (result.code === 0) return true;
    const daemon = await this.execResult(
      'docker info >/dev/null 2>&1',
      STATUS_FOLLOWUP_TIMEOUT_MS,
    );
    if (daemon.code !== 0) {
      throw new Error(`Docker daemon unavailable (exit ${daemon.code})`);
    }
    return false;
  }

  /**
   * Create a missing VM container without any preceding
   * stop/remove. Docker's name uniqueness is the cross-process atomic guard;
   * if another repair wins, inspect that winner and converge safely.
   */
  async createContainerIfAbsent(
    props: StoredWorkload,
    secrets?: readonly RuntimeSecret[],
    stillEligible?: () => Promise<boolean>,
  ): Promise<CreateContainerIfAbsentResult> {
    assertVmHostContainerConfiguration(props);
    if (props.workloadType !== WorkloadType.Vm) {
      throw new Error('createContainerIfAbsent only supports vm workloads');
    }

    await this.writeRuntimeSecrets(secrets);
    await this.ensureDockerNetwork(props);
    const hostGroups = await this.prepareVmContainerHost();

    // Final observation immediately before docker run closes the ordinary
    // inspect-to-create race. A concurrent process is handled below by the
    // deterministic name conflict.
    const beforeCreate = await this.inspectVmContainer(props);
    if (beforeCreate.kind === 'managed') {
      return beforeCreate.state === ContainerState.Running
        ? { outcome: 'already-running' }
        : { outcome: 'managed-not-running', state: beforeCreate.state };
    }
    if (beforeCreate.kind === 'conflict') {
      return { outcome: 'conflict', state: beforeCreate.state };
    }
    if (stillEligible && !(await stillEligible())) {
      return { outcome: 'aborted' };
    }

    const command = DockerManager.getCommand(
      props,
      undefined,
      false,
      hostGroups,
    );
    const run = await this.execResult(command, 60_000);
    if (run.code === 0) return { outcome: 'created' };

    const winner = await this.inspectVmContainer(props);
    if (winner.kind === 'managed') {
      return winner.state === ContainerState.Running
        ? { outcome: 'already-running' }
        : { outcome: 'managed-not-running', state: winner.state };
    }
    if (winner.kind === 'conflict') {
      return { outcome: 'conflict', state: winner.state };
    }

    const detail = redactSecrets((run.stderr || run.stdout).trim()).slice(
      -1000,
    );
    throw new Error(
      `Failed to create missing VM container${detail ? `: ${detail}` : ''}`,
    );
  }

  /**
   * Build the docker run command string
   * @param props Workload properties
   * @param buckets Optional bucket configuration for bind mounts
   * @param redactSecrets If true, replaces sensitive env values with <REDACTED>
   */
  static getCommand(
    props: Pick<
      StoredWorkload,
      | 'id'
      | 'image'
      | 'workloadType'
      | 'env'
      | 'registryUsername'
      | 'deploymentId'
      | 'userId'
      | 'dockerOptions'
      | 'command'
      | 'secretNames'
      | 'imageDigest'
    > &
      Partial<
        Pick<StoredWorkload, 'hostDocker' | 'requireNestedVirtualization'>
      >,
    buckets?: DockerBucketMounts,
    redactSecrets = false,
    hostGroups?: HostGroups,
  ): string {
    assertVmHostContainerConfiguration(props);
    const { id, env, secretNames } = props;
    // Run the exact digest that was pulled and verified at submit rather than
    // the mutable tag, so what executes equals what was inspected (no tag-back).
    const image = resolveWorkloadImage(props);
    const isService = props.workloadType === WorkloadType.Service;
    const isVm = props.workloadType === WorkloadType.Vm;
    // A dev box, or a `--host-docker` Job: the host's Docker and /workspace.
    const hostDocker =
      isVm || (props.workloadType === WorkloadType.Job && props.hostDocker);
    const serviceContainerPort = isService
      ? resolveServiceContainerPort(env)
      : undefined;

    // Build docker run command args
    // --pull never: image is already pulled in the download step; avoid contacting
    // the registry at run-time so transient auth failures (e.g. GHCR 401) don't
    // break container start.
    const args: string[] = [
      'docker',
      'run',
      '-d',
      '--pull',
      'never',
      '--name',
      id,
    ];

    for (const [key, value] of Object.entries(
      buildAnycloudDockerLabels({
        role: ANYCLOUD_DOCKER_ROLES.workload,
        workloadId: id,
        userId: props.userId,
      }),
    )) {
      args.push('--label', shellEscape(`${key}=${value}`));
    }

    if (hostDocker) {
      args.push(
        '--init',
        '--group-add',
        String(hostGroups?.socket ?? '<host-docker-socket-gid>'),
        ...(isVm ? ['--entrypoint', '/bin/sh'] : []),
        '--workdir',
        VM_WORKSPACE_PATH,
        '--add-host',
        'host.docker.internal:host-gateway',
      );
      // A nested Job's KVM; the submit-time display line can't know its group.
      const kvmGid = hostGroups ? hostGroups.kvm : '<host-kvm-gid>';
      if (!isVm && props.requireNestedVirtualization && kvmGid !== undefined) {
        args.push('--device', KVM_DEVICE_PATH, '--group-add', String(kvmGid));
      }
    }

    // Volume mounts for bucket sync
    // All mount at well-known paths: /mnt/input, /mnt/output, /mnt/checkpoint
    if (buckets?.input) {
      args.push('-v', `${buckets.input}:/mnt/input:ro`); // Read-only
    }
    if (buckets?.output) {
      args.push('-v', `${buckets.output}:/mnt/output`);
    }
    if (buckets?.checkpoint) {
      args.push('-v', `${buckets.checkpoint}:/mnt/checkpoint`);
    }

    // Restart policy and managed Service ingress
    args.push('--restart', isService || isVm ? 'unless-stopped' : 'no');
    if (isService) {
      args.push('-p', `0.0.0.0:80:${serviceContainerPort}`);
    }
    if (hostDocker) {
      args.push(
        '-v',
        `${DOCKER_SOCKET_PATH}:${DOCKER_SOCKET_PATH}`,
        '-v',
        `${VM_WORKSPACE_PATH}:${VM_WORKSPACE_PATH}`,
      );
    }

    // Docker runtime options (user-provided, must escape)
    const docker = props.dockerOptions;
    if (docker) {
      if (docker.privileged) {
        args.push('--privileged');
      }
      if (docker.gpus) {
        args.push(
          '--gpus',
          shellEscape(docker.gpus),
          nvidiaDeviceArgs(docker.gpus),
        );
      }
      if (!isVm && docker.runtime) {
        args.push('--runtime', shellEscape(docker.runtime));
      }
      if (!isVm && docker.network) {
        args.push('--network', shellEscape(docker.network));
      }
      if (!isVm && docker.shmSize) {
        args.push('--shm-size', shellEscape(docker.shmSize));
      }
      if (docker.ipc) {
        args.push('--ipc', shellEscape(docker.ipc));
      }
      if (!isVm && docker.ulimits) {
        for (const ulimit of docker.ulimits) {
          args.push('--ulimit', shellEscape(ulimit));
        }
      }
      if (!isVm && docker.memory) {
        args.push('--memory', shellEscape(docker.memory));
      }
      if (!isVm && docker.cpus) {
        args.push('--cpus', shellEscape(docker.cpus));
      }
      if (!isVm && docker.binds) {
        for (const bind of docker.binds) {
          args.push('-v', shellEscape(bind));
        }
      }
    }

    // Runtime secrets: Docker loads named secrets via the protected env file.
    // Later explicit user `-e KEY=VALUE` flags override them. The registry
    // token never reaches the container. The files directory, not one file,
    // is mounted, so a swapped revision shows through.
    if (secretNames && secretNames.length > 0) {
      args.push(
        '--env-file',
        SECRETS_ENV_FILE,
        '-v',
        `${SECRET_FILES_DIR}:${RUNTIME_SECRETS_DIR}:ro`,
      );
    }

    const systemEnv: Record<string, string> = {};
    systemEnv.WORKLOAD_ID = id;
    // One-release compatibility for 0.1.64 containers; a later release removes this.
    systemEnv.DEPLOYMENT_ID = id;
    // Detached containers have no TTY, so Python may buffer stdout long enough
    // for a running workload to appear silent in `anycloud logs --follow`.
    if (env?.PYTHONUNBUFFERED === undefined) {
      systemEnv.PYTHONUNBUFFERED = '1';
    }
    if (isService) {
      systemEnv.PORT = String(serviceContainerPort);
    }

    // Add non-secret system env vars.
    for (const [key, value] of Object.entries(systemEnv)) {
      const displayValue =
        redactSecrets && isSecretKey(key) ? '<REDACTED>' : value;
      args.push('-e', shellEscape(`${key}=${displayValue}`));
    }

    // Add user env vars (all user-provided, must escape)
    if (env) {
      for (const [key, value] of Object.entries(env)) {
        if (isService && key === 'PORT') continue;
        const displayValue =
          redactSecrets && isSecretKey(key) ? '<REDACTED>' : value;
        args.push('-e', shellEscape(`${key}=${displayValue}`));
      }
    }

    // Image (user-provided, must escape)
    args.push(shellEscape(image));

    const command = isVm ? null : props.command;

    // Command override (args after -- in CLI, user-provided, must escape)
    if (isVm) {
      args.push('-c', shellEscape(VM_KEEPALIVE_COMMAND));
    } else if (command && command.length > 0) {
      for (const arg of command) {
        args.push(shellEscape(arg));
      }
    }

    // Join args (already escaped where needed)
    return args.join(' ');
  }

  /** The env file, then each Secret's files, before the container starts. */
  private async writeRuntimeSecrets(
    secrets: readonly RuntimeSecret[] | undefined,
  ): Promise<void> {
    if (!secrets || secrets.length === 0) return;
    await this.writeSecretsEnvFile(
      Object.assign({}, ...secrets.map((secret) => secret.values)),
    );
    for (const secret of secrets) await this.writeSecretFiles(secret);
  }

  /** The revision each Secret's files hold on this host; null when missing. */
  readSecretFileRevisions(
    names: readonly string[],
  ): Promise<Map<string, string | null>> {
    return readSecretFileRevisions(this, names);
  }

  /**
   * Write and swap in one Secret's files; see `writeSecretFiles`. Errors name
   * only the Secret and host, never transport output.
   */
  async writeSecretFiles(secret: RuntimeSecret): Promise<void> {
    try {
      await writeSecretFiles(this, secret);
    } catch {
      throw new Error(
        `Failed to write files for Secret "${secret.name}" on ${this.host}`,
      );
    }
  }

  /**
   * Write the runtime-secret env file with mode 0600. Remote payloads travel
   * over SSH stdin and are never embedded in the logged command.
   */
  private async writeSecretsEnvFile(
    values: Record<string, string>,
  ): Promise<void> {
    // Docker parses KEY=VALUE lines literally. Revalidate here because a named
    // secret can change between submission and workload startup.
    const content = serializeRuntimeSecretsEnv(values);
    try {
      await this.writeFile(SECRETS_ENV_FILE, content);
    } catch {
      // Keep transport details out of workload event metadata.
      throw new Error(`Failed to write secrets env file on ${this.host}`);
    }
  }

  async writeFile(
    path: string,
    content: string,
    { mode, directoryMode } = { mode: 0o600, directoryMode: 0o700 },
  ): Promise<void> {
    if (!this.isLocal) {
      await this.ssh!.writeFile(path, content, { mode, directoryMode });
      return;
    }

    // 127.0.0.1 is the direct-exec/test transport. Match the SSH writer's
    // modes and same-filesystem atomic replacement without a shell command.
    const directory = dirname(path);
    const temporaryPath = join(
      directory,
      `.${basename(path)}.${randomUUID()}.tmp`,
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, directoryMode);
    try {
      await writeFileOnDisk(temporaryPath, content, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await chmod(temporaryPath, mode);
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private async ensureDockerNetwork(props: StoredWorkload): Promise<void> {
    const network = props.dockerOptions?.network;
    if (!network) return;
    const quoted = shellEscape(network);
    await this.exec(
      `docker network inspect ${quoted} >/dev/null 2>&1 || docker network create ${quoted}`,
    );
  }

  /**
   * Run Docker container with proper configuration
   * @param props Workload properties
   * @param buckets Optional bucket configuration for bind mounts
   */
  private async runContainer(
    props: StoredWorkload,
    buckets?: DockerBucketMounts,
  ): Promise<void> {
    this.containerName = props.id;

    // Stop and remove existing container if it exists
    await this.stopContainer();

    log.info('Starting container', {
      image: props.image,
      containerName: this.containerName,
      workloadType: props.workloadType,
      buckets,
      host: this.host,
    });

    let hostGroups: HostGroups | undefined;
    if (props.workloadType === WorkloadType.Vm) {
      hostGroups = await this.prepareVmContainerHost();
    } else if (props.workloadType === WorkloadType.Job && props.hostDocker) {
      hostGroups = await this.prepareHostDockerJob(
        props.requireNestedVirtualization,
      );
    }

    // Build and execute docker run command
    const cmd = DockerManager.getCommand(props, buckets, false, hostGroups);
    await this.exec(cmd);

    log.info('Container started', {
      containerName: this.containerName,
      host: this.host,
    });
  }

  private async prepareVmContainerHost(): Promise<HostGroups> {
    await this.exec(`install -d -m 0777 ${shellEscape(VM_WORKSPACE_PATH)}`);
    const socket = await this.hostGroupId(DOCKER_SOCKET_PATH);
    if (socket === undefined) {
      throw new Error(
        `Cannot determine numeric group id for ${DOCKER_SOCKET_PATH}`,
      );
    }
    return { socket };
  }

  /** A dev box's host, plus the inotify limit and, with nesting, KVM's group. */
  private async prepareHostDockerJob(nested: boolean): Promise<HostGroups> {
    const groups = await this.prepareVmContainerHost();
    const limit = '/proc/sys/fs/inotify/max_user_instances';
    await this.exec(
      `[ "$(cat ${limit})" -ge ${HOST_DOCKER_INOTIFY_INSTANCES} ] || sysctl -qw fs.inotify.max_user_instances=${HOST_DOCKER_INOTIFY_INSTANCES}`,
    );
    const guarded = await this.exec(HOST_DOCKER_PORT_GUARD_COMMAND);
    if (!guarded.stdout.split('\n').includes('iptables')) {
      // Docker without iptables publishes nothing through DOCKER-USER; the
      // cloud network's rules still stand.
      log.warn('--host-docker Job host has no DOCKER-USER chain', {
        host: this.host,
      });
    }
    if (!nested) return groups;
    const kvm = await this.hostGroupId(KVM_DEVICE_PATH);
    if (kvm === undefined) {
      throw new Error(
        `nested virtualization was requested but ${KVM_DEVICE_PATH} is missing on this host`,
      );
    }
    return { ...groups, kvm };
  }

  /** The numeric group of a host path; undefined when it is absent or unreadable. */
  private async hostGroupId(path: string): Promise<number | undefined> {
    const result = await this.execResult(
      `stat -c '%g' ${shellEscape(path)} 2>/dev/null`,
      STATUS_FOLLOWUP_TIMEOUT_MS,
    );
    const raw = result.stdout.trim();
    const gid = Number(raw);
    return result.code === 0 && /^\d+$/.test(raw) && Number.isSafeInteger(gid)
      ? gid
      : undefined;
  }

  async assertVmContainerReady(workloadId: string): Promise<void> {
    const checks = [
      `[ -w ${VM_WORKSPACE_PATH} ]`,
      `[ -r ${DOCKER_SOCKET_PATH} ]`,
      `[ -w ${DOCKER_SOCKET_PATH} ]`,
    ];
    const script = checks.join(' && ');
    const result = await this.execResult(
      `docker exec ${shellEscape(workloadId)} /bin/sh -c ${shellEscape(script)}`,
      STATUS_INSPECT_TIMEOUT_MS,
    );
    if (result.code !== 0) {
      const detail = redactSecrets(
        (result.stderr || result.stdout).trim(),
      ).slice(-1000);
      throw new Error(
        `VM container failed its runtime contract${detail ? `: ${detail}` : ''}`,
      );
    }
  }

  /**
   * Get container status.
   */
  async getContainerStatus(
    workloadId: string,
  ): Promise<RuntimeContainerStatus> {
    // Get container state as JSON to avoid delimiter issues
    const { code, stdout } = await this.execResult(
      `docker inspect --format '{{json .State}}' ${workloadId} 2>/dev/null`,
      STATUS_INSPECT_TIMEOUT_MS,
    );

    if (code !== 0) {
      const daemon = await this.execResult(
        'docker info > /dev/null 2>&1',
        STATUS_FOLLOWUP_TIMEOUT_MS,
      );
      if (daemon.code !== 0) {
        throw new Error(`Docker daemon unavailable (exit ${daemon.code})`);
      }
      return { state: ContainerState.NotFound };
    }

    const dockerState = JSON.parse(stdout.trim()) as {
      Status: string;
      ExitCode: number;
      StartedAt: string;
      OOMKilled: boolean;
      Error: string;
    };

    const state = dockerState.Status as ContainerState;

    if (state === ContainerState.Running) {
      // Calculate uptime from StartedAt (short format: 2h, 45m, 3d)
      const started = new Date(dockerState.StartedAt);
      const uptimeMs = Date.now() - started.getTime();
      const uptimeSec = Math.floor(uptimeMs / 1000);
      const uptimeMin = Math.floor(uptimeSec / 60);
      const uptimeHours = Math.floor(uptimeMin / 60);
      const uptimeDays = Math.floor(uptimeHours / 24);
      const uptime =
        uptimeDays > 0
          ? `${uptimeDays}d`
          : uptimeHours > 0
            ? `${uptimeHours}h`
            : uptimeMin > 0
              ? `${uptimeMin}m`
              : `${uptimeSec}s`;
      return {
        state,
        uptime,
        startedAt: dockerState.StartedAt,
      };
    }

    if (state !== ContainerState.Exited) {
      return { state };
    }

    // Gather error diagnostics for non-running containers
    const diagnostics: string[] = [];

    // 1. Docker State.Error (if present)
    if (dockerState.Error?.trim()) {
      diagnostics.push(`Docker error: ${dockerState.Error.trim()}`);
    }

    // 2. Container logs - show errors and context
    let logOutput = '';
    try {
      const logs = await this.execResult(
        `docker logs --tail 100 ${workloadId} 2>&1`,
        STATUS_FOLLOWUP_TIMEOUT_MS,
      );
      if (logs.code === 0) logOutput = logs.stdout;
    } catch {
      // The inspect result is authoritative; logs are diagnostics only.
    }
    if (logOutput.trim()) {
      const allLines = logOutput.split('\n').filter((line) => line.trim());

      // Extract error lines using shared utility
      const errorLines = extractErrorLines(logOutput);

      // Determine context lines that will be shown
      let contextLines: string[];
      if (allLines.length <= 6) {
        contextLines = allLines;
      } else {
        contextLines = [...allLines.slice(0, 3), ...allLines.slice(-3)];
      }

      // Show separate error section unless ALL errors exist outside context window
      if (errorLines.length > 0) {
        const allErrorsInContext = errorLines.every((err) =>
          contextLines.includes(err),
        );
        if (!allErrorsInContext) {
          diagnostics.push('Error logs:\n' + errorLines.join('\n'));
        }
      }

      // Add first/last lines for context
      if (allLines.length > 0) {
        if (allLines.length <= 6) {
          diagnostics.push('Container logs:\n' + allLines.join('\n'));
        } else {
          const displayLines = [
            ...allLines.slice(0, 3),
            '...',
            ...allLines.slice(-3),
          ];
          diagnostics.push('Container logs:\n' + displayLines.join('\n'));
        }
      }
    }

    // Redact secrets from diagnostics (performance: only redact final output)
    const redactedDiagnostics = diagnostics.map((line) => redactSecrets(line));

    return {
      state,
      exitCode: dockerState.ExitCode,
      oomKilled: dockerState.OOMKilled,
      logs: redactedDiagnostics.join('\n') || undefined,
    };
  }

  /**
   * Stop and remove container
   */
  async stopContainer(): Promise<void> {
    if (!this.containerName) {
      return;
    }

    // Force remove (stops if running)
    const { code } = await this.exec(
      `docker rm -f ${this.containerName} 2>/dev/null`,
    );

    if (code === 0) {
      log.info('Container removed', {
        containerName: this.containerName,
        host: this.host,
      });
    }
  }

  /**
   * Ask a running workload to shut down cleanly and wait for Docker's grace
   * period. Unlike stopContainer(), this deliberately leaves the container in
   * place: callers can retry a checkpoint flush before destroying the VM.
   */
  async stopContainerGracefully(
    workloadId: string,
    timeoutSeconds = 30,
  ): Promise<void> {
    const inspected = await this.execResult(
      `docker inspect --format '{{.State.Running}}' ${shellEscape(workloadId)} 2>/dev/null`,
      STATUS_INSPECT_TIMEOUT_MS,
    );
    if (inspected.code !== 0) {
      // A missing container is already quiesced. Distinguish that from a dead
      // Docker daemon so teardown never silently skips a live workload.
      const daemon = await this.execResult(
        'docker info > /dev/null 2>&1',
        STATUS_FOLLOWUP_TIMEOUT_MS,
      );
      if (daemon.code !== 0) {
        throw new Error(`Docker daemon unavailable (exit ${daemon.code})`);
      }
      log.info('Container already absent before graceful stop', {
        containerName: workloadId,
        host: this.host,
      });
      return;
    }
    if (inspected.stdout.trim() !== 'true') {
      log.info('Container already stopped', {
        containerName: workloadId,
        host: this.host,
      });
      return;
    }

    await this.exec(
      `docker stop --time ${timeoutSeconds} ${shellEscape(workloadId)} >/dev/null`,
      (timeoutSeconds + 15) * 1000,
      1,
    );
    log.info('Container stop command completed', {
      containerName: workloadId,
      host: this.host,
    });
  }

  /**
   * Test whether the Docker daemon is ready. systemd's Type=notify state is
   * the authoritative signal — dockerd reports READY only after it finishes
   * initializing — and asking systemd costs the VM no disk I/O. That matters
   * during boot: a `docker info` probe forces a starting daemon to assemble a
   * full system report (storage-driver state and plugin enumeration) on every
   * poll.
   * `docker version` is the lightweight fallback where systemd is absent
   * (docker-in-docker test VMs, local control containers).
   */
  async ping(maxAttempts = 4): Promise<boolean> {
    const { code } = await this.exec(
      'systemctl is-active --quiet docker 2>/dev/null || docker version > /dev/null 2>&1',
      15_000,
      maxAttempts,
    );
    return code === 0;
  }

  /**
   * Restart a stopped container by name using `docker start`.
   * Used after an in-place VM restart (startVM) to resume a job whose
   * container was stopped by the cloud's preemption signal (--restart no).
   */
  async restartContainer(containerId: string): Promise<void> {
    log.info('Restarting stopped container', { containerId, host: this.host });
    const { code } = await this.exec(`docker start ${containerId}`);
    if (code !== 0) {
      throw new Error(
        `docker start ${containerId} failed with exit code ${code}`,
      );
    }
    log.info('Container restarted', { containerId, host: this.host });
  }
}
