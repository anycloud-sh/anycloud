import type { VmTransport } from './gateways/transport-contract.js';
import { log } from './logger.js';
import { PULL_CONTROL_TIMEOUT_MS } from '../config.js';
import {
  BOUNDED_CURL,
  DOCKER_VERSION,
  DOCKER_ARCH_COMMAND,
  DOCKER_ARCH_REF,
  dockerArchiveUrl,
  DOCKER_DAEMON_CONFIG_COMMAND,
  DOCKER_SYSTEMD_UNIT,
  GO_ARCH_COMMAND,
  GO_ARCH_REF,
  installUnpigzCommand,
  JOB_HOST_DOCKER_VERSION,
  rcloneArchiveDirectory,
  rcloneArchiveUrl,
  RCLONE_VERSION,
  UNPIGZ_PATH,
} from '../runtime-artifacts.js';
import { configureContainerdTransferStore } from './containerd-transfer.js';
import { JOB_HOST_DOCKER, waitForJobHostDocker } from './job-host.js';
import { moveImageStoresToResourceDisk } from './resource-disk-store.js';
import { GpuRuntime } from '../../shared/cloud.js';
import { sleep } from '../../shared/utils.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import {
  NVIDIA_GPU_FABRIC_POLL_INTERVAL_MS,
  NVIDIA_GPU_FABRIC_READY_STATE,
  NVIDIA_GPU_FABRIC_READY_TIMEOUT_MS,
} from './gpu-fabric.js';

/** Shell command to acquire and install the pinned rclone binary. */
export function installRcloneCommand(): string {
  return (
    `GO_ARCH=${GO_ARCH_COMMAND} && ` +
    `${BOUNDED_CURL} ${rcloneArchiveUrl(GO_ARCH_REF)} -o /tmp/rclone.zip && ` +
    `python3 -c "import zipfile; zipfile.ZipFile('/tmp/rclone.zip').extractall('/tmp')" && ` +
    `mv /tmp/${rcloneArchiveDirectory(GO_ARCH_REF)}/rclone /usr/bin/rclone && ` +
    'chmod +x /usr/bin/rclone && ' +
    'rm -rf /tmp/rclone*'
  );
}

export interface InitVMParams {
  workloadId: string;
  vmIp: string;
  /**
   * Resolved GPU runtime for this VM-host target. NVIDIA fabric readiness is a
   * CUDA/NVIDIA concern; null/undefined means no vendor-specific GPU init gate.
   */
  gpuRuntime?: GpuRuntime | null;
  /**
   * Explicit Docker runtime requested by the workload. NVIDIA GPU images can
   * ship the toolkit before Docker is installed, so the `nvidia` runtime must
   * be registered after Anycloud installs/starts Docker.
   */
  dockerRuntime?: string | null;
  /** The Docker and containerd stores may move to an ephemeral local disk. */
  ephemeralImageStore?: boolean;
  /** A CPU VM Job host (jobHostPrepare), which gets JOB_HOST_DOCKER. */
  jobHost?: boolean;
}

/** Check whether systemd is running as PID 1. */
export async function hasSystemd(ssh: VmTransport): Promise<boolean> {
  try {
    const { stdout } = await ssh.exec('ps -p 1 -o comm= 2>/dev/null', 1);
    return stdout.trim() === 'systemd';
  } catch {
    return false;
  }
}

/** Bounds the best-effort unpigz install, so a slow mirror can't stall init. */
export const UNPIGZ_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Initialize a VM after SSH becomes available.
 * Installs Docker and rclone from pinned static archives (no apt-get).
 * Downloads come directly from the vendors.
 * Service workloads also install Caddy for HTTPS reverse proxy.
 */
export async function initializeVM(
  ssh: VmTransport,
  params: InitVMParams,
): Promise<void> {
  const { workloadId, vmIp, gpuRuntime = null, dockerRuntime = null } = params;

  log.info('Initializing VM via SSH', {
    id: workloadId,
    ip: vmIp,
  });

  await settleFirstBootUpgrade(ssh, workloadId, vmIp);
  // Before the store move, which restarts a running Docker, and before the
  // install, which would race the user data's own.
  await waitForJobHostDocker(
    (cmd, ms) => ssh.exec(cmd, 1, false, ms),
    workloadId,
    vmIp,
  );

  if (gpuRuntime === GpuRuntime.Cuda) {
    await waitForNvidiaGpuFabricReady(ssh, workloadId, vmIp);
  }

  // Before Docker installs: systemd reads the drop-ins on its next reload.
  if (params.ephemeralImageStore && (await hasSystemd(ssh))) {
    await moveImageStoresToResourceDisk(ssh, workloadId, vmIp);
  }

  await installBinaries(ssh, workloadId, vmIp, gpuRuntime, dockerRuntime, {
    jobHost: params.jobHost ?? false,
  });

  log.info('VM initialization complete', { id: workloadId, ip: vmIp });
}

/**
 * The Azure NGC GPU image runs a first-boot cloud-init `package_upgrade` ~2-3 min in
 * that upgrades docker-ce + containerd.io (and on the 25.9.1 SKU, the NVIDIA kmod,
 * which additionally forces a reboot). Restarting docker/containerd SIGKILLs any
 * workload container running at that moment — exit 137, which classifyJobExit treats
 * as terminal and non-retryable, so a job that started mid-upgrade dies with no
 * rerun. We wait for cloud-init to finish its first-boot work BEFORE building the
 * runtime and starting the container, so the daemons are at their final versions and
 * won't restart under the workload.
 *
 * Provider-agnostic on purpose: it's a fast no-op on images whose cloud-init is
 * already `done` (e.g. the AWS DLAMI, which doesn't self-upgrade), so only images
 * that actually upgrade on first boot pay the wait. Skips entirely when cloud-init
 * isn't present (test containers / minimal images), and a remote `timeout` bounds the
 * wait so a stuck cloud-init can't hang init. Best-effort — if the wait itself errors
 * we proceed, since the pre-`running` window is still retryable.
 */
async function settleFirstBootUpgrade(
  ssh: VmTransport,
  workloadId: string,
  vmIp: string,
): Promise<void> {
  try {
    const { stdout } = await ssh.exec(
      [
        'if ! command -v cloud-init >/dev/null 2>&1; then echo SETTLE_SKIP_NO_CLOUDINIT; exit 0; fi',
        'timeout 480 cloud-init status --wait >/dev/null 2>&1',
        'echo SETTLE_DONE rc=$?',
        'cloud-init status 2>/dev/null | head -1 || true',
        'exit 0',
      ].join('\n'),
      1, // single attempt — re-running just re-waits
      false,
      510_000, // command-timeout backstop above the remote `timeout 480`
    );
    log.info('Settled first-boot host config', {
      id: workloadId,
      ip: vmIp,
      result: stdout.replace(/\s+/g, ' ').trim(),
    });
  } catch (err) {
    // Best-effort: downstream Docker/GPU readiness + the retryable pre-`running`
    // window still guard the deploy if the wait itself fails.
    log.warn('First-boot settle wait failed; proceeding', {
      id: workloadId,
      ip: vmIp,
      error: err,
    });
  }
}

type NvidiaGpuFabricReadiness =
  | { ready: true; result: string; states: string[] }
  | { ready: false; states: string[] };

/**
 * Gate the container start on the GPU's NVSwitch fabric being ready. On multi-GPU
 * NVLink hosts (HGX H100/A100, and multi-GPU slices of a shared baseboard) the
 * GPUs enumerate before NVIDIA Fabric Manager has registered them into an active
 * fabric partition; a container that starts in that window fails CUDA init with
 * error 802 ("system not yet initialized"). Waiting for every GPU's fabric to
 * reach `State: Completed` HERE — during Initializing, a non-reusable state — means
 * a host whose fabric never comes up is torn down and reprovisioned on a fresh
 * host, instead of crashing the workload after it is already `running`.
 *
 * Reads the machine-readable `nvidia-smi --query-gpu=fabric.state` (CSV), not the
 * brittle `-q` text layout. Runs only for resolved CUDA/NVIDIA VM-host targets.
 * Proceeds when every reported state is a recognized ready/non-fabric value
 * (Completed, "Not Supported", or N/A). Some drivers prefix the value with a
 * `state` label (for example, `state  N/A`); those forms are equivalent.
 * Transitional and unknown values keep polling, so a new driver state cannot
 * accidentally fail open. An unsupported query field (older driver), no state,
 * or no nvidia-smi proceeds immediately. The reactive looksLikeMissingGPU retry
 * still backstops any 802 that slips past.
 */
function nvidiaGpuFabricStateQueryCommand(): string {
  return [
    'command -v nvidia-smi >/dev/null 2>&1 || { echo GPUFABRIC_SKIP_NO_SMI; exit 0; }',
    'nvidia-smi --query-gpu=fabric.state --format=csv,noheader 2>/dev/null || { echo GPUFABRIC_SKIP_UNSUPPORTED; exit 0; }',
  ].join('\n');
}

function parseSingleColumnCsv(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1).replace(/""/g, '"').trim();
      }
      return trimmed;
    })
    .filter(Boolean);
}

export function classifyNvidiaGpuFabricStateCsv(
  stdout: string,
): NvidiaGpuFabricReadiness {
  const states = parseSingleColumnCsv(stdout);
  if (states.length === 0) {
    return { ready: true, result: 'GPUFABRIC_NONE', states };
  }

  if (
    states.length === 1 &&
    (states[0] === 'GPUFABRIC_SKIP_NO_SMI' ||
      states[0] === 'GPUFABRIC_SKIP_UNSUPPORTED')
  ) {
    return { ready: true, result: states[0], states };
  }

  if (
    states.every((state) =>
      new RegExp(`^${NVIDIA_GPU_FABRIC_READY_STATE}$`, 'i').test(state.trim()),
    )
  ) {
    return { ready: true, result: 'GPUFABRIC_READY', states };
  }

  return { ready: false, states };
}

export async function waitForNvidiaGpuFabricReady(
  ssh: VmTransport,
  workloadId: string,
  vmIp: string,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const pollIntervalMs =
    options.pollIntervalMs ?? NVIDIA_GPU_FABRIC_POLL_INTERVAL_MS;
  const deadline =
    Date.now() + (options.timeoutMs ?? NVIDIA_GPU_FABRIC_READY_TIMEOUT_MS);
  let lastStates: string[] = [];

  for (;;) {
    let stdout: string;
    try {
      const result = await ssh.exec(
        nvidiaGpuFabricStateQueryCommand(),
        1,
        false,
        30_000,
      );
      stdout = result.stdout;
    } catch (err) {
      // Couldn't run the probe (SSH glitch, unexpected image). Don't reprovision
      // on a probe failure — proceed and let the reactive 802 retry backstop it.
      log.warn('NVIDIA GPU fabric probe did not run; proceeding', {
        id: workloadId,
        ip: vmIp,
        error: err,
      });
      return;
    }

    const readiness = classifyNvidiaGpuFabricStateCsv(stdout);
    lastStates = readiness.states;
    if (readiness.ready) {
      log.info('NVIDIA GPU fabric probe', {
        id: workloadId,
        ip: vmIp,
        result: readiness.result,
        states: readiness.states.join(', '),
      });
      return;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      // Positively observed states that never became ready — fail init so the
      // monitor tears this host down and reprovisions on a fresh one.
      throw new Error(
        `NVIDIA GPU fabric not ready on ${vmIp}: [${lastStates.join(', ')}]`,
      );
    }

    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
}

async function installBinaries(
  ssh: VmTransport,
  workloadId: string,
  vmIp: string,
  gpuRuntime: GpuRuntime | null,
  dockerRuntime: string | null,
  { jobHost }: { jobHost: boolean },
): Promise<void> {
  // Install Docker, rclone and unpigz in parallel — they are independent.
  // Docker looks unpigz up per pull and containerd on its first unpack, so
  // neither daemon needs a restart.
  await Promise.all([
    jobHost
      ? installJobHostDocker(ssh, workloadId, vmIp)
      : installDocker(ssh, workloadId, vmIp, gpuRuntime, dockerRuntime),
    installRclone(ssh, workloadId, vmIp),
    // Best-effort: without unpigz, pulls fall back to Go's one-thread gzip.
    // A Job host's user data installs it before its pull, which a reinstall
    // here could race.
    ssh
      .exec(
        `[ -x ${UNPIGZ_PATH} ] || { ${installUnpigzCommand()}; }`,
        1,
        false,
        UNPIGZ_INSTALL_TIMEOUT_MS,
      )
      .catch((error: unknown) =>
        log.warn('unpigz install failed; pulls use Go gzip', {
          id: workloadId,
          ip: vmIp,
          error: errorMessage(error),
        }),
      ),
  ]);
}

/**
 * A CPU VM Job host's Docker, as its user data installs it; this finishes
 * what a failed user data left undone.
 */
async function installJobHostDocker(
  ssh: VmTransport,
  workloadId: string,
  vmIp: string,
): Promise<void> {
  await ssh.exec(`${JOB_HOST_DOCKER}\ninstall_docker && start_docker`, 5, true);
  log.info('Docker installed and started', {
    id: workloadId,
    ip: vmIp,
    version: JOB_HOST_DOCKER_VERSION,
  });
}

async function installDocker(
  ssh: VmTransport,
  workloadId: string,
  vmIp: string,
  gpuRuntime: GpuRuntime | null,
  dockerRuntime: string | null,
): Promise<void> {
  // GPU VM images (NVIDIA NGC, Deep Learning AMIs) come with docker-ce pre-installed.
  let hasDocker = false;
  try {
    await ssh.exec('docker --version', 1);
    hasDocker = true;
  } catch {
    // Docker not installed
  }

  if (hasDocker) {
    log.info('Docker already installed, skipping install', {
      id: workloadId,
      ip: vmIp,
    });
    // dstack cloud images deliberately ship docker.service stopped and
    // disabled. Start an installed systemd daemon explicitly before probing
    // containerd instead of depending on a concurrent Docker CLI call to
    // socket-activate it. `systemctl start` waits for Docker's readiness
    // notification and starts the packaged system containerd dependency.
    const useSystemd = await hasSystemd(ssh);
    if (useSystemd) {
      await ensureSystemdDockerStarted(ssh, workloadId, vmIp);
    } else {
      await ensureNonSystemdDockerStarted(ssh, workloadId, vmIp);
    }
    await ensureRequestedNvidiaDockerRuntime(
      ssh,
      workloadId,
      vmIp,
      gpuRuntime,
      dockerRuntime,
      useSystemd,
    );
    // GPU images self-upgrade NVIDIA libs on first boot, staling the CDI spec;
    // refresh it so `docker run --gpus` works regardless of the storage driver.
    await reconcileNvidiaCdi(ssh, workloadId, vmIp);
    // GPU images: enable the containerd same-layer transfer store once here so
    // the detect-only pull path can use it.
    // Best-effort — restores Docker on any failure and never fails the deploy.
    if (gpuRuntime !== null) {
      await configureContainerdTransferStore(
        (cmd, timeoutMs) => ssh.exec(cmd, 4, false, timeoutMs),
        { id: workloadId, ip: vmIp },
      );
    }
    return;
  }

  log.info('Installing Docker static binary', {
    id: workloadId,
    ip: vmIp,
    version: DOCKER_VERSION,
  });

  // Docker static binaries use uname -m directly (x86_64 or aarch64)
  await ssh.exec(
    `DOCKER_ARCH=${DOCKER_ARCH_COMMAND} && ` +
      `${BOUNDED_CURL} ${dockerArchiveUrl(DOCKER_ARCH_REF)} -o /tmp/docker.tgz && ` +
      'tar xzf /tmp/docker.tgz -C /tmp && ' +
      'mv /tmp/docker/* /usr/bin/ && rm -rf /tmp/docker /tmp/docker.tgz',
    5,
    true,
  );

  const useSystemd = await hasSystemd(ssh);
  if (useSystemd) {
    await ssh.exec(
      `cat > /etc/systemd/system/docker.service << 'UNIT_EOF'\n${DOCKER_SYSTEMD_UNIT}\nUNIT_EOF\n${DOCKER_DAEMON_CONFIG_COMMAND}`,
    );
    await ssh.exec(
      'systemctl daemon-reload && systemctl enable docker && systemctl start docker',
    );
  } else {
    await ensureNonSystemdDockerStarted(ssh, workloadId, vmIp);
  }

  await ensureRequestedNvidiaDockerRuntime(
    ssh,
    workloadId,
    vmIp,
    gpuRuntime,
    dockerRuntime,
    useSystemd,
  );

  log.info('Docker installed and started', {
    id: workloadId,
    ip: vmIp,
    version: DOCKER_VERSION,
    systemd: useSystemd,
  });
}

const NVIDIA_DOCKER_RUNTIME_PROBE = `docker info --format '{{json .Runtimes}}' | grep -q '"nvidia":'`;

async function hasNvidiaDockerRuntime(ssh: VmTransport): Promise<boolean> {
  try {
    await ssh.exec(
      NVIDIA_DOCKER_RUNTIME_PROBE,
      1,
      false,
      PULL_CONTROL_TIMEOUT_MS,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * `--gpus` can work through Docker's CDI support without a named runtime, but
 * an explicit `--runtime nvidia` still requires Docker's runtime alias. GCP's
 * CUDA DLVM image currently ships NVIDIA Container Toolkit before Docker;
 * Anycloud then installs Docker from the static archive, so the toolkit never
 * had an engine to configure. Register the alias after Docker is running and
 * verify the daemon sees it before allowing the workload to reach Starting.
 */
async function ensureRequestedNvidiaDockerRuntime(
  ssh: VmTransport,
  workloadId: string,
  vmIp: string,
  gpuRuntime: GpuRuntime | null,
  dockerRuntime: string | null,
  useSystemd: boolean,
): Promise<void> {
  if (
    gpuRuntime !== GpuRuntime.Cuda ||
    dockerRuntime !== 'nvidia' ||
    (await hasNvidiaDockerRuntime(ssh))
  ) {
    return;
  }

  if (!useSystemd) {
    throw new Error(
      `NVIDIA Docker runtime requested on ${vmIp}, but Docker cannot be restarted with systemd`,
    );
  }

  await ssh.exec(
    [
      'set -e',
      'command -v nvidia-ctk >/dev/null 2>&1 || { echo "NVIDIA Container Toolkit is not installed" >&2; exit 1; }',
      'command -v nvidia-container-runtime >/dev/null 2>&1 || { echo "NVIDIA Container Runtime is not installed" >&2; exit 1; }',
      'nvidia-ctk runtime configure --runtime=docker',
    ].join('\n'),
    2,
  );
  await ssh.exec(
    'systemctl restart docker && systemctl is-active --quiet docker',
    1,
    false,
    PULL_CONTROL_TIMEOUT_MS,
  );

  if (!(await hasNvidiaDockerRuntime(ssh))) {
    throw new Error(
      `NVIDIA Docker runtime registration did not take effect on ${vmIp}`,
    );
  }

  log.info('Registered requested NVIDIA Docker runtime', {
    id: workloadId,
    ip: vmIp,
  });
}

async function ensureSystemdDockerStarted(
  ssh: VmTransport,
  workloadId: string,
  vmIp: string,
): Promise<void> {
  const startedAt = Date.now();
  let alreadyActive = false;
  try {
    await ssh.exec(
      'systemctl is-active --quiet docker',
      1,
      false,
      PULL_CONTROL_TIMEOUT_MS,
    );
    alreadyActive = true;
  } catch {
    // An inactive service is expected on images that defer Docker startup to
    // their orchestrator. Starting it is idempotent and is required anyway.
  }

  if (!alreadyActive) {
    await ssh.exec('systemctl start docker', 1, false, PULL_CONTROL_TIMEOUT_MS);
    await ssh.exec(
      'systemctl is-active --quiet docker',
      1,
      false,
      PULL_CONTROL_TIMEOUT_MS,
    );
  }

  log.info('Docker daemon ready for initialization', {
    id: workloadId,
    ip: vmIp,
    started: !alreadyActive,
    dockerStartMs: Date.now() - startedAt,
  });
}

async function ensureNonSystemdDockerStarted(
  ssh: VmTransport,
  workloadId: string,
  vmIp: string,
): Promise<void> {
  try {
    await ssh.exec(
      'docker info >/dev/null 2>&1',
      1,
      false,
      PULL_CONTROL_TIMEOUT_MS,
    );
    return;
  } catch {
    // The CLI is installed in minimal VM images, but the daemon is not started.
  }

  const startedAt = Date.now();
  await ssh.exec(
    [
      'mkdir -p /var/log',
      'if ! pgrep dockerd >/dev/null 2>&1; then',
      '  rm -f /var/run/docker.pid /var/run/docker.sock',
      '  rm -rf /var/run/docker/containerd',
      '  if [ -s /etc/docker/daemon.json ]; then',
      '    nohup dockerd </dev/null > /var/log/dockerd.log 2>&1 &',
      '  else',
      '    nohup dockerd --storage-driver=vfs </dev/null > /var/log/dockerd.log 2>&1 &',
      '  fi',
      'fi',
    ].join('\n'),
    1,
    false,
    PULL_CONTROL_TIMEOUT_MS,
  );
  await ssh.exec(
    'for i in $(seq 1 30); do docker info >/dev/null 2>&1 && exit 0; sleep 1; done; cat /var/log/dockerd.log 2>/dev/null || true; exit 1',
    1,
    false,
    35_000,
  );
  log.info('Docker daemon ready for initialization', {
    id: workloadId,
    ip: vmIp,
    started: true,
    dockerStartMs: Date.now() - startedAt,
  });
}

/**
 * NGC/DLAMI GPU images ship a CDI spec (/var/run/cdi/nvidia.yaml) generated at
 * boot. When the image's first-boot self-upgrade swaps NVIDIA userspace libs
 * (e.g. Azure NGC 26.4.1 bumps libnvidia-egl-wayland 1.1.13->1.1.21) the
 * pre-generated spec still names the old versioned path, and `docker run --gpus`
 * fails with "no such file". Regenerating the spec re-points it at the current
 * libs — no reboot or Docker restart needed, since the runtime reads it per run.
 *
 * Best-effort — never fails the workload; a no-op on non-NVIDIA images (no
 * nvidia-ctk) or an image that didn't self-upgrade. Runs on every init attempt,
 * so a retry after the upgrade settles heals it even if the first init raced it.
 */
async function reconcileNvidiaCdi(
  ssh: VmTransport,
  workloadId: string,
  vmIp: string,
): Promise<void> {
  try {
    // Regenerate only when the spec is actually stale — it names a driver lib
    // that no longer exists because the image's first-boot self-upgrade swapped
    // it (Azure NGC). On images that don't self-upgrade (AWS DLAMI) every
    // referenced lib is present, so this is a cheap grep + test that skips the
    // regen (and the nvidia-ctk invocation) entirely — no cost on the fast path.
    const { stdout } = await ssh.exec(
      [
        'if command -v nvidia-ctk >/dev/null 2>&1 && [ -f /var/run/cdi/nvidia.yaml ]; then',
        '  CDI=/var/run/cdi/nvidia.yaml',
        '  stale=0',
        `  for p in $(grep -oE '/[^ "]+\\.so\\.[0-9][0-9.]*' "$CDI" | sort -u); do [ -e "$p" ] || { stale=1; break; }; done`,
        '  if [ "$stale" = 1 ]; then nvidia-ctk cdi generate --output="$CDI" >/dev/null 2>&1 && echo regenerated; fi',
        'fi',
      ].join('\n'),
      2,
    );
    if (stdout.trim() === 'regenerated') {
      log.info('Regenerated stale NVIDIA CDI spec (image self-upgrade)', {
        id: workloadId,
        ip: vmIp,
      });
    }
  } catch (error) {
    log.warn('NVIDIA CDI reconcile failed; continuing on the image spec', {
      id: workloadId,
      ip: vmIp,
      error: error,
    });
  }
}

async function installRclone(
  ssh: VmTransport,
  workloadId: string,
  vmIp: string,
): Promise<void> {
  let hasRclone = false;
  try {
    await ssh.exec('rclone version', 1);
    hasRclone = true;
  } catch {
    // rclone not installed
  }

  if (hasRclone) {
    log.info('rclone already installed, skipping', {
      id: workloadId,
      ip: vmIp,
    });
    return;
  }

  log.info('Installing rclone', {
    id: workloadId,
    ip: vmIp,
    version: RCLONE_VERSION,
  });

  await ssh.exec(installRcloneCommand(), 5, true);

  log.info('Rclone installed', {
    id: workloadId,
    ip: vmIp,
    version: RCLONE_VERSION,
  });
}
