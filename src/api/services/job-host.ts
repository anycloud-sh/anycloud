/**
 * CPU VM Job hosts on AWS, GCP and Azure: Ubuntu minimal, prepared by
 * cloud-config user data while the API waits for SSH, so initializeVM finds
 * Docker installed and image delivery finds a public image pulled.
 */
import { gzipSync } from 'node:zlib';
import { log } from './logger.js';
import {
  DOCKER_ARCH_COMMAND,
  DOCKER_ARCH_REF,
  BOUNDED_CURL,
  CONTAINERD_STORE_DAEMON_CONFIG_COMMAND,
  DOCKER_SYSTEMD_UNIT,
  dockerArchiveUrl,
  HOST_PLATFORM_FLAG,
  IPTABLES_DEBS,
  JOB_HOST_DOCKER_VERSION,
  PIGZ_DEBS,
  UNPIGZ_FROM_DEB,
  UNPIGZ_PATH,
} from '../runtime-artifacts.js';
import {
  CONTAINERD_TRANSFER_FETCH_COMMAND,
  containerdImageReference,
  withContainerdTransferConfig,
} from './containerd-transfer.js';
import { PULL_TOTAL_TIMEOUT_MS } from '../config.js';
import {
  BOOT_MARKS_PATH,
  bootMark,
  SYSTEMD_BOOT_MARKS,
} from './host-runtime/boot-marks.js';
import { RX_BYTES_FUNCTION } from './host-runtime/pull-timing.js';
import {
  RESOURCE_DISK_PROBE,
  resourceDiskStoreInstallCommand,
} from './resource-disk-store.js';
import {
  pullNeedsRegistryAuth,
  resolveWorkloadImage,
} from './container-image.js';
import type { SSHKeys } from './vm-startup-script.js';
import type { StoredWorkload } from './workload-record.js';
import type { CloudConfig, GpuRuntime } from '../../shared/cloud.js';
import type { ImagePullTelemetry } from '../../shared/image.js';
import { computeProviderData } from '../../shared/providers.js';
import { shellEscape } from '../../shared/utils.js';
import { WorkloadType } from '../../shared/workload.js';

/** One short command on the host: its stdout, within the timeout. */
type VmExec = (
  command: string,
  timeoutMs: number,
) => Promise<{ stdout: string }>;

/**
 * A CPU VM Job's host preparation, on clouds that prepare Job hosts: Ubuntu
 * minimal, prepared from user data, with a public image pre-pulled. GPU
 * hosts keep their own images and SSH-driven setup.
 */
export function jobHostPrepare(
  props: Pick<
    StoredWorkload,
    | 'workloadType'
    | 'image'
    | 'imageDigest'
    | 'githubToken'
    | 'registryUsername'
  >,
  { cloudProvider, region }: Pick<CloudConfig, 'cloudProvider' | 'region'>,
  gpuRuntime: GpuRuntime | null,
): JobHost | undefined {
  if (
    props.workloadType !== WorkloadType.Job ||
    gpuRuntime !== null ||
    !computeProviderData(cloudProvider).preparesJobHosts
  ) {
    return undefined;
  }
  let image: string | null = null;
  try {
    image = props.image
      ? resolveWorkloadImage({
          image: props.image,
          imageDigest: props.imageDigest,
        })
      : null;
    // The user data's ctr pull needs it qualified (generateJobHostUserData).
    if (image) containerdImageReference(image);
  } catch {
    // An unusable reference fails at the pull, as it always has.
    image = null;
  }
  // A private image's credentials can't go in user data: it pulls over SSH.
  return {
    prePullImage: image && !pullNeedsRegistryAuth(props, image) ? image : null,
    // A region name goes into a hostname and a shell script.
    ubuntuMirror:
      region && /^[a-z0-9-]+$/.test(region)
        ? (computeProviderData(cloudProvider).ubuntuMirror?.(region) ?? null)
        : null,
  };
}

/** What a CPU VM Job host's user data prepares. */
export interface JobHost {
  /** A public image to pull from user data. */
  prePullImage: string | null;
  /**
   * The cloud's in-region Ubuntu mirror (ubuntuMirror in providers.ts): quicker
   * than archive.ubuntu.com, whose TLS handshakes stall about one boot in six
   * for 10-40 s. A GCP region without one fails at DNS.
   */
  ubuntuMirror: string | null;
}

/**
 * A pinned archive.ubuntu.com or ports.ubuntu.com URL on the mirror, over
 * http: the pinned checksum, not the transport, vouches for the package.
 */
function mirrorUrl(url: string, mirror: string | null): string {
  return mirror
    ? url.replace(
        /^https:\/\/(archive|ports)\.ubuntu\.com\//,
        `http://${mirror}.$1.ubuntu.com/`,
      )
    : '-';
}

/** Bounds a mirror download, so a dead mirror hands over to the archive. */
const MIRROR_CURL = 'curl -fsSL --connect-timeout 3 --max-time 15';

/**
 * fetch_deb FILE SHA256 MIRROR_URL URL: the pinned deb from the mirror (`-`
 * for none), else from the archive; either must match the checksum.
 */
const FETCH_DEB = `fetch_deb() {
  { [ "$3" != - ] && ${MIRROR_CURL} "$3" -o "$1" && echo "$2  $1" | sha256sum -c - >/dev/null; } ||
    { ${BOUNDED_CURL} "$4" -o "$1" && echo "$2  $1" | sha256sum -c - >/dev/null; }
}`;

/** Each architecture's `<mirror URL> <URL> <sha256>` triples, as a shell case. */
function debCase(
  debs: Record<string, readonly { url: string; sha256: string }[]>,
  mirror: string | null,
  assign: string,
): string {
  return `case $(uname -m) in ${Object.entries(debs)
    .map(
      ([arch, list]) =>
        `${arch}) ${assign}="${list.map((d) => `${mirrorUrl(d.url, mirror)} ${d.url} ${d.sha256}`).join(' ')}" ;;`,
    )
    .join(' ')} *) return 1 ;; esac`;
}

/**
 * A Job host's smallest default OS disk on AWS and GCP (Azure's Ubuntu image
 * is 30 GB). The `high` tier's 16 GB gp3 and GCP's 10 GB image hold little
 * beside a 2 GB image, and a small pd-ssd is a slow one.
 */
export const JOB_HOST_DISK_GB = 30;

/** Where a Job host's preparation records its progress; tmpfs, so a reboot starts it afresh. */
const JOB_HOST_PREPARE_DIR = '/run/anycloud/prepare';

/** Bounds each user-data pull attempt, so a stalled registry hands over to the SSH pull. */
const PRE_PULL_ATTEMPT_SECONDS = 300;

/** Bounds the user data's unpigz install, short of waitForJobHostDocker's wait. */
const JOB_HOST_UNPIGZ_SECONDS = 60;

/**
 * GCP's Ubuntu image has rsyslog copy daemon and kernel logs to the serial
 * console. Its 115200 baud then backs up systemd's own console writes, and
 * systemd starts about one unit every 0.7 s until the console drains. bootcmd
 * removes the rule before rsyslog starts; the journal keeps every message.
 */
const GCP_CONSOLE_LOG_RULE = '/etc/rsyslog.d/90-google.conf';

/** Apt's timers and unattended-upgrades, which compete with a Job at first boot. */
const JOB_HOST_MASKED_UNITS = [
  'apt-daily.timer',
  'apt-daily-upgrade.timer',
  'apt-daily.service',
  'apt-daily-upgrade.service',
  'unattended-upgrades.service',
];

/**
 * Docker's bridge networking needs iptables, which Ubuntu minimal lacks: the
 * pinned debs (IPTABLES_DEBS), fetched in parallel with fetch_deb, checked and
 * installed with dpkg, since apt has no sources before cloud-init's later
 * stages.
 */
function installIptables(mirror: string | null): string {
  return `${FETCH_DEB}
install_iptables() {
  command -v iptables >/dev/null && return 0
  ${debCase(IPTABLES_DEBS, mirror, 'debs')}
  d=$(mktemp -d) && set -- $debs || return 1
  pids=
  while [ $# -gt 2 ]; do
    fetch_deb "$d/$(basename "$2")" "$3" "$1" "$2" & pids="$pids $!"
    shift 3
  done
  ok=0
  for p in $pids; do wait "$p" || ok=1; done
  [ "$ok" = 0 ] && dpkg -i "$d"/*.deb && rm -rf "$d"
}`;
}

/** The pinned unpigz (PIGZ_DEBS), fetched with fetch_deb. */
function installUnpigz(mirror: string | null): string {
  return `install_unpigz() {
  [ -x ${UNPIGZ_PATH} ] && return 0
  ${debCase({ x86_64: [PIGZ_DEBS.x86_64], aarch64: [PIGZ_DEBS.aarch64] }, mirror, 'deb')}
  d=$(mktemp -d) && set -- $deb || return 1
  fetch_deb "$d/pigz.deb" "$3" "$1" "$2" && ${UNPIGZ_FROM_DEB}
  r=$?; rm -rf "$d"; return $r
}`;
}

/**
 * Layers a Job host's containerd unpacks at once; Docker's own pull unpacks
 * one at a time. Four cut a 2 GB image's pull and first start by 7-14 s on
 * 4-vCPU hosts (experiments/job-host-unpack on branch
 * experiment/job-host-unpack). GPU hosts showed no gain, so their config
 * (configureContainerdTransferStore) leaves it out.
 */
export const JOB_HOST_UNPACKS = 4;

/** The system containerd a Job host's dockerd uses (JOB_HOST_DOCKER). */
const JOB_HOST_CONTAINERD_SOCKET = '/run/containerd/containerd.sock';

const CONTAINERD_SYSTEMD_UNIT = `[Unit]
Description=containerd container runtime
After=network.target

[Service]
ExecStartPre=-/sbin/modprobe overlay
ExecStart=/usr/bin/containerd
Type=notify
Delegate=yes
KillMode=process
Restart=always
RestartSec=5
LimitNPROC=infinity
LimitCORE=infinity
LimitNOFILE=infinity
TasksMax=infinity
OOMScoreAdjust=-999`;

/**
 * Docker on the system containerd, whose config this module owns: Docker's
 * own containerd takes a generated config without the transfer settings. The
 * minimum API version stays at 1.24, as before 29: Testcontainers for Java
 * before 2.0 asks for 1.32.
 */
const DOCKER_CONTAINERD_DROP_IN = `[Unit]
Requires=containerd.service
After=containerd.service

[Service]
Environment=DOCKER_MIN_API_VERSION=1.24
ExecStart=
ExecStart=/usr/bin/dockerd --containerd=${JOB_HOST_CONTAINERD_SOCKET}`;

/**
 * Docker JOB_HOST_DOCKER_VERSION on a CPU VM Job host, from its user data or,
 * when that failed, over SSH (initializeVM): its static archive, on a system
 * containerd whose transfer service unpacks layers in parallel
 * (withContainerdTransferConfig), with Docker on the containerd image store.
 * Every config lands before dockerd does, so it never starts on overlay2.
 * start_docker refuses a Docker 29 or later that isn't on the containerd
 * store anyway; an older Docker, left by an earlier release, keeps running.
 */
export const JOB_HOST_DOCKER = `install_docker() {
  command -v dockerd >/dev/null && return 0
  DOCKER_ARCH=${DOCKER_ARCH_COMMAND}
  t=$(mktemp -d) &&
    ${BOUNDED_CURL} ${dockerArchiveUrl(DOCKER_ARCH_REF, JOB_HOST_DOCKER_VERSION)} -o "$t/docker.tgz" &&
    tar xzf "$t/docker.tgz" -C "$t" &&
    mkdir -p /etc/containerd /etc/systemd/system/docker.service.d || return 1
  cat > /etc/containerd/config.toml << 'CONFIG_EOF' || return 1
${withContainerdTransferConfig('version = 3', { max_concurrent_unpacks: JOB_HOST_UNPACKS }).trimEnd()}
CONFIG_EOF
  cat > /etc/systemd/system/containerd.service << 'UNIT_EOF' || return 1
${CONTAINERD_SYSTEMD_UNIT}
UNIT_EOF
  cat > /etc/systemd/system/docker.service << 'UNIT_EOF' || return 1
${DOCKER_SYSTEMD_UNIT}
UNIT_EOF
  cat > /etc/systemd/system/docker.service.d/anycloud-containerd.conf << 'UNIT_EOF' || return 1
${DOCKER_CONTAINERD_DROP_IN}
UNIT_EOF
  ${CONTAINERD_STORE_DAEMON_CONFIG_COMMAND} || return 1
  mv "$t"/docker/* /usr/bin/ && rm -rf "$t"
}
start_docker() {
  systemctl daemon-reload && systemctl enable --now docker || return 1
  v=$(docker version --format '{{.Server.Version}}')
  [ "\${v%%.*}" -lt 29 ] 2>/dev/null && return 0
  docker info --format '{{json .DriverStatus}}' | grep -q io.containerd.snapshotter.v1 && return 0
  echo "Docker $v is not on the containerd image store" >&2
  systemctl disable --now docker
  return 1
}`;

/**
 * Where Azure's Ubuntu cloud-init mounts the resource disk: in its network
 * stage, after bootcmd starts the preparation.
 */
const AZURE_RESOURCE_DISK_MOUNT = '/mnt';

/**
 * Bounds the preparation's wait for that mount, which held Docker's start:
 * it came 7 s after Docker's archive in the vm-boot-marks runs.
 */
const RESOURCE_DISK_MOUNT_WAIT_SECONDS = 20;

/**
 * `stores_ready`: succeeds once the image stores are where the Job's pull
 * should land. With no Azure resource disk, or one too small to take them
 * (resourceDiskStoreMount), they stay on the OS disk. A resource disk at
 * AZURE_RESOURCE_DISK_MOUNT gets them bound onto it, as initializeVM would,
 * before containerd first opens them. Any other disk, or none mounted in
 * time, fails: initializeVM decides, and the pull goes over SSH.
 */
const STORES_READY = `stores_ready() {
  [ -e /dev/disk/cloud/azure_resource-part1 ] || [ -e /dev/disk/azure/resource-part1 ] || return 0
  m=
  for _ in $(seq ${RESOURCE_DISK_MOUNT_WAIT_SECONDS * 2}); do
    m=$(
${RESOURCE_DISK_PROBE}
) && [ -n "$m" ] && break
    sleep 0.5
  done
  set -- $m
  [ $# = 3 ] || { echo "resource disk not mounted after ${RESOURCE_DISK_MOUNT_WAIT_SECONDS}s: the API moves the stores and pulls"; return 1; }
  [ "$1" != / ] && [ "$2" -ge "$3" ] 2>/dev/null || return 0
  # Heredocs inside, so unindented.
  [ "$1" = ${AZURE_RESOURCE_DISK_MOUNT} ] && (
${resourceDiskStoreInstallCommand(AZURE_RESOURCE_DISK_MOUNT)}
)
}`;

/**
 * The preparation a CPU VM Job host runs from its user data while the API
 * waits for SSH: Docker (JOB_HOST_DOCKER), and a pull of a public image
 * through containerd's transfer service, which unpacks layers in parallel,
 * or, if that fails, an ordinary `docker pull`. The transfer starts as soon
 * as containerd can, alongside iptables' install and dockerd's start.
 * `docker` and `pull` in JOB_HOST_PREPARE_DIR hold each step's exit status,
 * and `method` the pull's; a pull counts only once Docker is ready. The pull
 * is synced to disk here, off the Job's path; a container's first create
 * would otherwise wait for it.
 */
function jobHostPrepareScript({
  prePullImage,
  ubuntuMirror: mirror,
}: JobHost): string {
  const dir = JOB_HOST_PREPARE_DIR;
  return `#!/bin/bash
set -u
dir=${dir}
mkdir -p "$dir"
${bootMark('prepare-start')}
# systemd's marks for the boot before this, once its units have all started.
${SYSTEMD_BOOT_MARKS}
trap systemd_marks EXIT
${JOB_HOST_DOCKER}
${installIptables(mirror)}
${installUnpigz(mirror)}
export -f fetch_deb install_unpigz
{ install_docker && ${bootMark('docker-installed')}; } >"$dir/docker-install.log" 2>&1 & docker=$!
{ install_iptables && ${bootMark('iptables-installed')}; } >"$dir/iptables.log" 2>&1 & iptables=$!
# Best effort: Docker unpacks gzip layers with unpigz when it's on PATH, else
# with Go's one-thread gzip. It lands before the pull, and initializeVM's own
# install then finds it.
{ timeout ${JOB_HOST_UNPIGZ_SECONDS} bash -c install_unpigz && ${bootMark('unpigz-installed')}; } >"$dir/unpigz.log" 2>&1 & unpigz=$!
# All finish before the unit can exit, so dpkg is never cut off mid-install.
wait "$docker"; d=$?
wait "$unpigz"
${
  prePullImage
    ? `${STORES_READY}
cat > "$dir/transfer-pull.sh" << 'TRANSFER_EOF'
${CONTAINERD_TRANSFER_FETCH_COMMAND.trimEnd()}
TRANSFER_EOF
# Early in boot GHCR's token fetch can stall or fail; each attempt is
# bounded, and a bounded failure leaves the image to the SSH pull, which
# reuses the layers fetched here. overlayfs is Docker's snapshotter on the
# containerd store, which start_docker requires.
transfer_pull() {
  AC_PULL_IMAGE=${shellEscape(containerdImageReference(prePullImage))} AC_CONTAINERD_ADDRESS=${JOB_HOST_CONTAINERD_SOCKET} AC_CONTAINERD_NAMESPACE=moby AC_SNAPSHOTTER=overlayfs \\
    timeout ${PRE_PULL_ATTEMPT_SECONDS} bash "$dir/transfer-pull.sh" >> "$dir/pull.log" 2>&1 &&
    { ${bootMark('pull-unpacked')}; sync; }
}
${RX_BYTES_FUNCTION}
pull=
if [ "$d" = 0 ] && stores_ready >>"$dir/docker-install.log" 2>&1 &&
  systemctl daemon-reload && systemctl start containerd; then
  ${bootMark('containerd-ready')}
  rx=$(ac_rx)
  ${bootMark('pull-start')}
  transfer_pull & pull=$!
fi
`
    : ''
}wait "$iptables"; i=$?
[ "$d" = 0 ] && [ "$i" = 0 ] && start_docker 2>>"$dir/docker-install.log"
s=$?
[ "$s" = 0 ] && ${bootMark('docker-ready')}
# A failure's evidence, for waitForJobHostDocker to log before the VM goes.
[ "$s" = 0 ] || { echo "install_docker=$d install_iptables=$i"; systemctl status docker --no-pager; journalctl -u docker --no-pager -n 40; } > "$dir/failure.log" 2>&1
echo $s > "$dir/docker"
${
  prePullImage
    ? `[ "$s" = 0 ] && [ -n "$pull" ] || exit 0
echo ${shellEscape(prePullImage)} > "$dir/image"
echo containerd-transfer > "$dir/method"
wait "$pull"; rc=$?
# A timed-out attempt hands over at once: its layers are what's slow.
if [ "$rc" != 0 ] && [ "$rc" != 124 ]; then
  echo docker-fallback > "$dir/method"
  for attempt in 1 2 3; do
    timeout ${PRE_PULL_ATTEMPT_SECONDS} docker pull ${HOST_PLATFORM_FLAG} ${shellEscape(prePullImage)} >> "$dir/pull.log" 2>&1 && sync && rc=0 && break
    rc=$?
    [ "$rc" = 124 ] && break
    [ "$attempt" = 3 ] || sleep $((attempt * 3))
  done
fi
echo "pull-bytes $(($(ac_rx) - rx))" >> ${BOOT_MARKS_PATH}
${bootMark('pull-end')}
echo $rc > "$dir/pull"`
    : ''
}
`;
}

/**
 * User data for a CPU VM Job host (Ubuntu minimal on AWS, GCP and Azure):
 * cloud-config, written as JSON (a YAML subset). Its bootcmd runs in
 * cloud-init's network stage, before sshd and cloud-init's later stages. It
 * adds the API's key for root, starts the host's preparation in its own unit
 * (no default dependencies, so systemd starts it at once rather than after
 * boot), keeps rsyslog off GCP's serial console (GCP_CONSOLE_LOG_RULE), and
 * masks apt's timers, so initializeVM's first-boot settle is short. bootcmd
 * runs on every boot; the preparation is idempotent.
 */
export function generateJobHostUserData(
  sshKeys: SSHKeys,
  jobHost: JobHost,
): string {
  const { publicKey } = sshKeys;
  if (!publicKey?.trim()) {
    throw new Error('SSH public key is required to generate VM user data');
  }
  const script = gzipSync(jobHostPrepareScript(jobHost)).toString('base64');
  const bootcmd = [
    'mkdir -p -m 700 /root/.ssh',
    `echo ${shellEscape(publicKey.trim())} >> /root/.ssh/authorized_keys`,
    'chmod 600 /root/.ssh/authorized_keys',
    `echo ${script} | base64 -d | gunzip > /run/anycloud-prepare.sh`,
    'systemd-run --no-block --unit=anycloud-prepare -p DefaultDependencies=no /bin/bash /run/anycloud-prepare.sh',
    `rm -f ${GCP_CONSOLE_LOG_RULE}`,
    `systemctl mask --now ${JOB_HOST_MASKED_UNITS.join(' ')}`,
  ].join('; ');
  return `#cloud-config\n${JSON.stringify({ bootcmd: [['sh', '-c', bootcmd]] })}\n`;
}

/** Bounds the wait for a Job host's user data to install Docker. */
const JOB_HOST_DOCKER_WAIT_SECONDS = 180;

/**
 * A Job host's user data installs Docker while the API waits for SSH
 * (generateJobHostUserData); wait for it to finish. A no-op on other hosts.
 * Best-effort: if it failed or is still running, initializeVM's install
 * proceeds.
 */
export async function waitForJobHostDocker(
  exec: VmExec,
  workloadId: string,
  vmIp: string,
): Promise<void> {
  const dir = JOB_HOST_PREPARE_DIR;
  try {
    const { stdout } = await exec(
      [
        `[ -d ${dir} ] || { echo none; exit 0; }`,
        `for _ in $(seq ${JOB_HOST_DOCKER_WAIT_SECONDS * 2}); do [ -s ${dir}/docker ] && break; sleep 0.5; done`,
        `status=$(cat ${dir}/docker 2>/dev/null || echo pending)`,
        // initializeVM then installs or starts Docker over SSH, which needs
        // iptables when the user data didn't get it.
        `[ "$status" = 0 ] || { ${installIptables(null).replace(/\n/g, '\n  ')}\n  install_iptables >/dev/null 2>&1; }`,
        'echo "$status"',
        // A failed prepare's evidence follows the status line.
        `case "$status" in 0) ;; *) tail -c 4000 ${dir}/failure.log ${dir}/docker-install.log ${dir}/iptables.log 2>/dev/null || true ;; esac`,
      ].join('\n'),
      (JOB_HOST_DOCKER_WAIT_SECONDS + 30) * 1000,
    );
    const [status = '', ...evidence] = stdout.trim().split('\n');
    if (status === 'none') return;
    if (status === '0') {
      log.info('Job host Docker prepared by user data', {
        id: workloadId,
        ip: vmIp,
        status,
      });
    } else {
      log.warn(
        status === 'pending'
          ? 'Job host Docker prepare still running; installing over SSH'
          : 'Job host Docker prepare failed; installing over SSH',
        {
          id: workloadId,
          ip: vmIp,
          status,
          evidence: evidence.join('\n'),
        },
      );
    }
  } catch (error) {
    log.warn('Job host Docker wait failed; installing over SSH', {
      id: workloadId,
      ip: vmIp,
      error,
    });
  }
}

/** Each wait for a Job host's pre-pull, kept short of NAT idle teardowns. */
const PRE_PULL_WAIT_SECONDS = 60;

/**
 * The telemetry of the Job host's own pull of this image
 * (generateJobHostUserData), once it finishes; null when it pulled another
 * image, none, or failed, and the ordinary pull runs.
 */
export async function jobHostPrePull(
  host: { exec: VmExec },
  id: string,
  image: string,
): Promise<ImagePullTelemetry | null> {
  const startedAt = Date.now();
  const dir = JOB_HOST_PREPARE_DIR;
  const quoted = shellEscape(image);
  const probe = [
    `[ "$(cat ${dir}/image 2>/dev/null)" = ${quoted} ] || { echo none; exit 0; }`,
    `for _ in $(seq ${PRE_PULL_WAIT_SECONDS * 2}); do [ -s ${dir}/pull ] && break; sleep 0.5; done`,
    `[ -s ${dir}/pull ] || { echo pending; exit 0; }`,
    `[ "$(cat ${dir}/pull)" = 0 ] && docker image inspect ${quoted} >/dev/null 2>&1 && echo "ready $(cat ${dir}/method 2>/dev/null)" || echo failed`,
  ].join('\n');
  const deadline = Date.now() + PULL_TOTAL_TIMEOUT_MS;
  try {
    for (let first = true; ; first = false) {
      const { stdout } = await host.exec(
        first ? `${bootMark('api-pull')}\n${probe}` : probe,
        (PRE_PULL_WAIT_SECONDS + 30) * 1000,
      );
      const [state, method] = stdout.trim().split(/\s+/);
      if (state !== 'pending' || Date.now() > deadline) {
        if (state !== 'none')
          log.info('Job host pre-pull', { id, image, state, method });
        return state === 'ready'
          ? {
              schemaVersion: 1,
              method:
                method === 'containerd-transfer' || method === 'docker-fallback'
                  ? method
                  : 'docker',
              outcome: 'succeeded',
              elapsedMs: Date.now() - startedAt,
              alreadyPresent: true,
              reason: 'prepulled',
            }
          : null;
      }
    }
  } catch (error) {
    log.warn('Job host pre-pull check failed; pulling', { id, image, error });
    return null;
  }
}
