import { parseFamiliarName } from '@swimlane/docker-reference';
import { log } from './logger.js';
import type { VmExecFn } from './vm-exec.js';
import { shellEscape } from '../../shared/utils.js';
import { PULL_CONTROL_TIMEOUT_MS } from '../config.js';

// containerd 2.1 introduced same-layer concurrent range fetching in the local
// transfer plugin. Keep containerd's conservative default of three global
// download lanes: four qualified in isolated probes, but live paired pulls
// triggered repeat GHCR cancellations on Azure. 128 MiB ranges cap the working
// buffer near 384 MiB and completed the full Lambda qualification.
const CONTAINERD_TRANSFER_MIN_VERSION = '2.1.0';
export const CONTAINERD_TRANSFER_CONCURRENCY = 3;
export const CONTAINERD_TRANSFER_CHUNK_BYTES = 128 * 1024 * 1024;
// A transfer can finish most blobs before one range is canceled. Retry once
// after the same backoff used by detached Docker pulls so containerd can reuse
// committed content. Registry throttles are handled separately in the worker:
// paired live pulls showed that retrying 429s only delayed Docker's safer path.
export const CONTAINERD_TRANSFER_MAX_ATTEMPTS = 2;
export const CONTAINERD_TRANSFER_RETRY_DELAY_SECONDS = 15;

const CONTAINERD_CONFIG = '/etc/containerd/config.toml';
const CONTAINERD_CONFIG_BACKUP =
  '/etc/containerd/.config.toml.anycloud-transfer-bak';
const CONTAINERD_CONFIG_MISSING =
  '/etc/containerd/.config.toml.anycloud-transfer-missing';
const DOCKER_CONFIG = '/etc/docker/daemon.json';
const DOCKER_CONFIG_BACKUP = '/etc/docker/.daemon.json.anycloud-transfer-bak';
const DOCKER_CONFIG_MISSING =
  '/etc/docker/.daemon.json.anycloud-transfer-missing';
const DOCKER_OVERRIDE =
  '/etc/systemd/system/docker.service.d/zz-anycloud-containerd-store.conf';
const DOCKER_OVERRIDE_BACKUP = `${DOCKER_OVERRIDE}.anycloud-bak`;
const DOCKER_OVERRIDE_MISSING = `${DOCKER_OVERRIDE}.anycloud-missing`;
const TRANSFER_PLUGIN = 'io.containerd.transfer.v1.local';

export interface ContainerdTransferRuntime {
  supported: boolean;
  reason: string;
  containerdVersion?: string;
  address?: string;
  namespace?: string;
  snapshotter?: string;
}

function numericVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function versionAtLeast(actual: string, required: string): boolean {
  const a = numericVersion(actual);
  const r = numericVersion(required);
  if (!a || !r) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > r[i]) return true;
    if (a[i] < r[i]) return false;
  }
  return true;
}

export function parseContainerdVersion(output: string): string | null {
  const matches = output.match(/\bv?\d+\.\d+\.\d+(?:[-+][^\s]+)?\b/g);
  return matches?.at(-1)?.replace(/^v/, '') ?? null;
}

function transferTableHeader(line: string): boolean {
  const escapedPlugin = TRANSFER_PLUGIN.split('.').join('\\.');
  return new RegExp(
    `^\\s*\\[plugins\\.(?:"${escapedPlugin}"|'${escapedPlugin}')\\]\\s*$`,
  ).test(line);
}

const TRANSFER_CONFIG_VALUES: Record<string, number> = {
  max_concurrent_downloads: CONTAINERD_TRANSFER_CONCURRENCY,
  concurrent_layer_fetch_buffer: CONTAINERD_TRANSFER_CHUNK_BYTES,
};

/** Preserve the host's effective config while setting only the transfer
 * controls Anycloud owns, and any `extra` ones. Exported so the round-trip
 * behavior is unit tested. */
export function withContainerdTransferConfig(
  raw: string,
  extra: Record<string, number> = {},
): string {
  const lines = raw.replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n');
  let tableStart = lines.findIndex(transferTableHeader);
  if (tableStart < 0) {
    if (lines.length === 1 && lines[0] === '') lines.length = 0;
    if (lines.length > 0) lines.push('');
    lines.push(`[plugins."${TRANSFER_PLUGIN}"]`);
    tableStart = lines.length - 1;
  }

  let tableEnd = lines.length;
  for (let i = tableStart + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      tableEnd = i;
      break;
    }
  }

  const values = { ...TRANSFER_CONFIG_VALUES, ...extra };
  const found = new Set<string>();
  for (let i = tableStart + 1; i < tableEnd; i++) {
    for (const [key, value] of Object.entries(values)) {
      if (new RegExp(`^\\s*${key}\\s*=`).test(lines[i])) {
        lines[i] = `  ${key} = ${value}`;
        found.add(key);
      }
    }
  }
  const additions = Object.entries(values)
    .filter(([key]) => !found.has(key))
    .map(([key, value]) => `  ${key} = ${value}`);
  lines.splice(tableEnd, 0, ...additions);
  return `${lines.join('\n')}\n`;
}

/** Compare values, not text: `config dump` formats the table differently from
 * the lines this module writes, so a text comparison never matched and every
 * re-init restarted containerd and Docker. */
export function hasExpectedContainerdTransferConfig(raw: string): boolean {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex(transferTableHeader);
  if (start < 0) return false;
  const end = lines.findIndex((line, i) => i > start && /^\s*\[/.test(line));
  const table = lines.slice(start + 1, end < 0 ? undefined : end);
  return Object.entries(TRANSFER_CONFIG_VALUES).every(([key, value]) =>
    table.some((line) =>
      new RegExp(`^\\s*${key}\\s*=\\s*${value}\\s*(?:#.*)?$`).test(line),
    ),
  );
}

function parseDockerConfig(raw: string): Record<string, unknown> {
  const value = raw.trim();
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Docker daemon.json is invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Docker daemon.json is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function withDockerContainerdImageStore(raw: string): string {
  const config = parseDockerConfig(raw);
  const driver = config['storage-driver'];
  if (driver !== undefined && driver !== 'overlay2' && driver !== 'overlayfs') {
    throw new Error(
      `Docker storage driver ${JSON.stringify(driver)} is not migratable`,
    );
  }
  // Docker calls the containerd snapshotter "overlayfs"; an image-provided
  // overlay2 graph-driver pin must be removed when the image store is enabled.
  delete config['storage-driver'];
  const features = config.features;
  config.features = {
    ...(features && typeof features === 'object' && !Array.isArray(features)
      ? features
      : {}),
    'containerd-snapshotter': true,
  };
  return `${JSON.stringify(config)}\n`;
}

function atomicWrite(path: string, body: string, mode = '0644'): string {
  const temporary = `${path}.anycloud-tmp`;
  return [
    `install -d -m 0755 ${shellEscape(path.slice(0, path.lastIndexOf('/')))}`,
    `cat > ${shellEscape(temporary)} <<'ANYCLOUD_CONFIG_EOF'`,
    body.replace(/\s+$/, ''),
    'ANYCLOUD_CONFIG_EOF',
    `chmod ${mode} ${shellEscape(temporary)}`,
    `mv -f ${shellEscape(temporary)} ${shellEscape(path)}`,
  ].join('\n');
}

function pluginActive(output: string): boolean {
  return output.split('\n').some((line) => {
    const columns = line.trim().split(/\s+/);
    return (
      columns[0] === 'io.containerd.transfer.v1' &&
      columns[1] === 'local' &&
      columns.at(-1) === 'ok'
    );
  });
}

async function runtimeInfo(
  exec: VmExecFn,
): Promise<{ address: string; namespace: string; configPath: string } | null> {
  // Only configure a system containerd explicitly wired into dockerd. Docker's
  // private/managed containerd has a generated config that cannot safely be
  // rewritten through /etc/containerd; it takes the ordinary fallback.
  const command = [
    'set -eu',
    'systemctl is-active --quiet containerd',
    'systemctl is-active --quiet docker',
    'dockerd_pid=$(systemctl show --property=MainPID --value docker)',
    'containerd_pid=$(systemctl show --property=MainPID --value containerd)',
    '[ -n "$dockerd_pid" ] && [ -n "$containerd_pid" ]',
    'address=',
    'namespace=moby',
    'next_address=0',
    'next_namespace=0',
    'for arg in $(tr "\\000" "\\n" < "/proc/$dockerd_pid/cmdline"); do',
    '  if [ "$next_address" = 1 ]; then address=$arg; next_address=0; continue; fi',
    '  if [ "$next_namespace" = 1 ]; then namespace=$arg; next_namespace=0; continue; fi',
    '  case "$arg" in',
    '    --containerd=*) address=${arg#--containerd=} ;;',
    '    --containerd) next_address=1 ;;',
    '    --containerd-namespace=*) namespace=${arg#--containerd-namespace=} ;;',
    '    --containerd-namespace) next_namespace=1 ;;',
    '  esac',
    'done',
    'config=/etc/containerd/config.toml',
    'next_config=0',
    'for arg in $(tr "\\000" "\\n" < "/proc/$containerd_pid/cmdline"); do',
    '  if [ "$next_config" = 1 ]; then config=$arg; next_config=0; continue; fi',
    '  case "$arg" in --config=*) config=${arg#--config=} ;; --config) next_config=1 ;; esac',
    'done',
    'printf "%s\\n%s\\n%s\\n" "${address:-managed}" "$namespace" "$config"',
  ].join('\n');
  try {
    const { stdout } = await exec(command, PULL_CONTROL_TIMEOUT_MS);
    const [address, namespace, configPath] = stdout.trim().split('\n');
    if (
      !address ||
      address === 'managed' ||
      !/^\/[A-Za-z0-9_./-]+\.sock$/.test(address) ||
      address.includes('..') ||
      !/^[A-Za-z0-9_.-]+$/.test(namespace ?? '') ||
      configPath !== CONTAINERD_CONFIG
    ) {
      return null;
    }
    return { address, namespace, configPath };
  } catch {
    return null;
  }
}

async function dockerStoreInfo(
  exec: VmExecFn,
): Promise<{ active: boolean; snapshotter: string | null }> {
  try {
    const { stdout } = await exec(
      "docker info --format '{{.Driver}}'; docker info --format '{{json .DriverStatus}}'",
      PULL_CONTROL_TIMEOUT_MS,
    );
    const [driver = '', ...statusLines] = stdout.trim().split('\n');
    const snapshotter = /^[a-z0-9][a-z0-9._-]{0,63}$/.test(driver)
      ? driver
      : null;
    return {
      active: statusLines.join('\n').includes('io.containerd.snapshotter.v1'),
      snapshotter,
    };
  } catch {
    return { active: false, snapshotter: null };
  }
}

async function restoreContainerdTransferStore(exec: VmExecFn): Promise<void> {
  const command = [
    'set +e',
    `if [ -f ${shellEscape(CONTAINERD_CONFIG_MISSING)} ]; then rm -f ${shellEscape(CONTAINERD_CONFIG)}; else cp -f ${shellEscape(CONTAINERD_CONFIG_BACKUP)} ${shellEscape(CONTAINERD_CONFIG)}; fi`,
    `if [ -f ${shellEscape(DOCKER_CONFIG_MISSING)} ]; then rm -f ${shellEscape(DOCKER_CONFIG)}; else cp -f ${shellEscape(DOCKER_CONFIG_BACKUP)} ${shellEscape(DOCKER_CONFIG)}; fi`,
    `if [ -f ${shellEscape(DOCKER_OVERRIDE_MISSING)} ]; then rm -f ${shellEscape(DOCKER_OVERRIDE)}; else cp -f ${shellEscape(DOCKER_OVERRIDE_BACKUP)} ${shellEscape(DOCKER_OVERRIDE)}; fi`,
    'systemctl daemon-reload',
    'systemctl restart containerd',
    'systemctl restart docker',
  ].join('\n');
  await exec(command, PULL_CONTROL_TIMEOUT_MS).catch((error) => {
    log.warn(
      'Containerd transfer rollback could not fully restart the runtime',
      {
        error: error,
      },
    );
  });
}

type ContainerdTransferReadiness =
  | {
      ready: true;
      version: string;
      runtime: { address: string; namespace: string; configPath: string };
      store: { active: boolean; snapshotter: string | null };
      containerdRaw: string;
      dockerRaw: string;
    }
  | {
      ready: false;
      reason: string;
      version?: string;
    };

/**
 * Read the runtime state needed before configuration starts without mutating
 * it. VM initialization starts Docker first, so this is a single capability
 * preflight rather than a passive wait for another command to start the daemon.
 */
async function readContainerdTransferReadiness(
  exec: VmExecFn,
): Promise<ContainerdTransferReadiness> {
  let version: string | null = null;
  try {
    const { stdout } = await exec(
      'containerd --version',
      PULL_CONTROL_TIMEOUT_MS,
    );
    version = parseContainerdVersion(stdout);
  } catch {
    // A not-yet-readable binary/runtime is a transient readiness failure.
  }
  if (!version) return { ready: false, reason: 'containerd_missing' };
  if (!versionAtLeast(version, CONTAINERD_TRANSFER_MIN_VERSION)) {
    return {
      ready: false,
      reason: `containerd_${version}_lt_2.1`,
      version,
    };
  }

  const runtime = await runtimeInfo(exec);
  if (!runtime) {
    return {
      ready: false,
      reason: 'docker_not_wired_to_configurable_system_containerd',
      version,
    };
  }

  let pluginOutput = '';
  try {
    pluginOutput = (
      await exec(
        `ctr --address ${shellEscape(runtime.address)} plugins ls`,
        PULL_CONTROL_TIMEOUT_MS,
      )
    ).stdout;
  } catch {
    // Report the same stable reason for command and plugin-state failures.
  }
  if (!pluginActive(pluginOutput)) {
    return {
      ready: false,
      reason: 'transfer_plugin_unavailable',
      version,
    };
  }

  let containerdRaw: string;
  try {
    containerdRaw = (
      await exec(
        `containerd --config ${shellEscape(runtime.configPath)} config dump`,
        PULL_CONTROL_TIMEOUT_MS,
      )
    ).stdout;
  } catch {
    return {
      ready: false,
      reason: 'containerd_config_unreadable',
      version,
    };
  }

  let dockerRaw: string;
  try {
    dockerRaw = (
      await exec(
        `cat ${shellEscape(DOCKER_CONFIG)} 2>/dev/null || true`,
        PULL_CONTROL_TIMEOUT_MS,
      )
    ).stdout;
  } catch {
    return {
      ready: false,
      reason: 'docker_config_unreadable',
      version,
    };
  }

  return {
    ready: true,
    version,
    runtime,
    store: await dockerStoreInfo(exec),
    containerdRaw,
    dockerRaw,
  };
}

/**
 * Configure the fresh VM's Docker/containerd pair for the same-layer transfer
 * store ONCE at VM init. Best-effort: on any failure the daemon is restored to
 * a working state and the detect-only pull path falls back to a plain
 * `docker pull`.
 */
export async function configureContainerdTransferStore(
  exec: VmExecFn,
  context: { id: string; ip: string },
): Promise<void> {
  const readinessStartedAt = Date.now();
  const readiness = await readContainerdTransferReadiness(exec);
  const readinessCheckMs = Date.now() - readinessStartedAt;
  if (!readiness.ready) {
    log.info('containerd transfer store unavailable; pull will use Docker', {
      ...context,
      reason: readiness.reason,
      ...(readiness.version && {
        containerdVersion: readiness.version,
      }),
      readinessCheckMs,
    });
    return;
  }

  const { version, runtime, store, containerdRaw, dockerRaw } = readiness;

  let containerdConfig: string;
  let dockerConfig: string | null = null;
  try {
    containerdConfig = withContainerdTransferConfig(containerdRaw);
    // Docker 29 defaults to the containerd image store; only write daemon.json
    // when the daemon is not already proving it is on that store.
    if (!store.active || !store.snapshotter) {
      dockerConfig = withDockerContainerdImageStore(dockerRaw);
    }
  } catch (error) {
    log.warn(
      'containerd transfer store config not migratable; leaving Docker as-is',
      {
        ...context,
        error: error,
      },
    );
    return;
  }

  // Already fully configured (idempotent re-init on a reused VM).
  if (
    hasExpectedContainerdTransferConfig(containerdRaw) &&
    store.active &&
    store.snapshotter
  ) {
    return;
  }

  let backedUp = false;
  try {
    await exec(
      [
        'set -e',
        `install -d -m 0755 /etc/containerd /etc/docker ${shellEscape(DOCKER_OVERRIDE.slice(0, DOCKER_OVERRIDE.lastIndexOf('/')))}`,
        `if [ -e ${shellEscape(CONTAINERD_CONFIG)} ]; then cp -f ${shellEscape(CONTAINERD_CONFIG)} ${shellEscape(CONTAINERD_CONFIG_BACKUP)}; rm -f ${shellEscape(CONTAINERD_CONFIG_MISSING)}; else rm -f ${shellEscape(CONTAINERD_CONFIG_BACKUP)}; : > ${shellEscape(CONTAINERD_CONFIG_MISSING)}; fi`,
        `if [ -e ${shellEscape(DOCKER_CONFIG)} ]; then cp -f ${shellEscape(DOCKER_CONFIG)} ${shellEscape(DOCKER_CONFIG_BACKUP)}; rm -f ${shellEscape(DOCKER_CONFIG_MISSING)}; else rm -f ${shellEscape(DOCKER_CONFIG_BACKUP)}; : > ${shellEscape(DOCKER_CONFIG_MISSING)}; fi`,
        `if [ -e ${shellEscape(DOCKER_OVERRIDE)} ]; then cp -f ${shellEscape(DOCKER_OVERRIDE)} ${shellEscape(DOCKER_OVERRIDE_BACKUP)}; rm -f ${shellEscape(DOCKER_OVERRIDE_MISSING)}; else rm -f ${shellEscape(DOCKER_OVERRIDE_BACKUP)}; : > ${shellEscape(DOCKER_OVERRIDE_MISSING)}; fi`,
      ].join('\n'),
      PULL_CONTROL_TIMEOUT_MS,
    );
    backedUp = true;
    await exec(
      atomicWrite(CONTAINERD_CONFIG, containerdConfig),
      PULL_CONTROL_TIMEOUT_MS,
    );
    if (dockerConfig !== null) {
      await exec(
        atomicWrite(DOCKER_CONFIG, dockerConfig),
        PULL_CONTROL_TIMEOUT_MS,
      );
    }
    await exec(
      [
        'set -e',
        ...(dockerConfig !== null
          ? [
              "if systemctl cat docker.service 2>/dev/null | grep -qE '^ExecStart=.*--storage-driver'; then",
              "  EXEC=$(systemctl cat docker.service | grep -E '^ExecStart=' | tail -1 | sed -E 's/^ExecStart=//; s/ *--storage-driver[= ][^ ]+//g')",
              `  cat > ${shellEscape(DOCKER_OVERRIDE)} <<EOF`,
              '[Service]',
              'ExecStart=',
              'ExecStart=$EXEC',
              'EOF',
              'fi',
            ]
          : []),
        'systemctl daemon-reload',
        'systemctl restart containerd',
        'systemctl restart docker',
      ].join('\n'),
      PULL_CONTROL_TIMEOUT_MS,
    );

    const [verifiedPlugins, verifiedStore] = await Promise.all([
      exec(
        `ctr --address ${shellEscape(runtime.address)} plugins ls`,
        PULL_CONTROL_TIMEOUT_MS,
      ),
      dockerStoreInfo(exec),
    ]);
    if (
      !pluginActive(verifiedPlugins.stdout) ||
      !verifiedStore.active ||
      !verifiedStore.snapshotter
    ) {
      throw new Error('runtime verification failed after restart');
    }

    log.info('Enabled containerd same-layer transfer store', {
      ...context,
      containerdVersion: version,
      concurrency: CONTAINERD_TRANSFER_CONCURRENCY,
      chunkBytes: CONTAINERD_TRANSFER_CHUNK_BYTES,
      readinessCheckMs,
      snapshotter: verifiedStore.snapshotter,
    });
  } catch (error) {
    if (backedUp) await restoreContainerdTransferStore(exec);
    log.warn(
      'containerd transfer store config failed; restored Docker, pull will fall back',
      {
        ...context,
        containerdVersion: version,
        error: error,
      },
    );
  }
}

/**
 * Detect whether the init-time transfer store is usable for a pull: containerd
 * >= 2.1, a configurable system containerd wired into dockerd, the transfer
 * plugin active, and Docker on a containerd image store.
 * Read-only — the store is configured at init (configureContainerdTransferStore).
 */
export async function detectContainerdTransferRuntime(
  exec: VmExecFn,
): Promise<ContainerdTransferRuntime> {
  let version: string | null = null;
  try {
    const { stdout } = await exec(
      'containerd --version',
      PULL_CONTROL_TIMEOUT_MS,
    );
    version = parseContainerdVersion(stdout);
  } catch {
    // unsupported verdict below
  }
  if (!version || !versionAtLeast(version, CONTAINERD_TRANSFER_MIN_VERSION)) {
    return {
      supported: false,
      reason: version ? `containerd_${version}_lt_2.1` : 'containerd_missing',
      ...(version && { containerdVersion: version }),
    };
  }

  const runtime = await runtimeInfo(exec);
  if (!runtime) {
    return {
      supported: false,
      reason: 'docker_not_wired_to_configurable_system_containerd',
      containerdVersion: version,
    };
  }

  let pluginOutput = '';
  try {
    pluginOutput = (
      await exec(
        `ctr --address ${shellEscape(runtime.address)} plugins ls`,
        PULL_CONTROL_TIMEOUT_MS,
      )
    ).stdout;
  } catch {
    pluginOutput = '';
  }
  if (!pluginActive(pluginOutput)) {
    return {
      supported: false,
      reason: 'transfer_plugin_unavailable',
      containerdVersion: version,
    };
  }

  const store = await dockerStoreInfo(exec);
  if (!store.active || !store.snapshotter) {
    return {
      supported: false,
      reason: 'docker_image_store_inactive',
      containerdVersion: version,
    };
  }
  return {
    supported: true,
    reason: 'ready',
    containerdVersion: version,
    address: runtime.address,
    namespace: runtime.namespace,
    snapshotter: store.snapshotter,
  };
}

/** `ctr` pulls only a fully qualified reference, such as
 * `docker.io/library/ubuntu:latest` for `ubuntu`; Docker finds it by either. */
export function containerdImageReference(image: string): string {
  const ref = parseFamiliarName(image);
  return ref.tag || ref.digest ? ref.toString() : `${ref.toString()}:latest`;
}

export function transferAuthFilePath(workloadId: string): string {
  const safe = workloadId.replace(/[^A-Za-z0-9_.-]/g, '_');
  return `/run/anycloud/registry-auth-${safe}`;
}

/** A per-pull Docker config on tmpfs, so a GitHub token never lands in
 * root's `~/.docker`, where any member with SSH access could read it. */
export function dockerConfigDirPath(workloadId: string): string {
  const safe = workloadId.replace(/[^A-Za-z0-9_.-]/g, '_');
  return `/run/anycloud/docker-config-${safe}`;
}

/** Login remains the ordinary Docker fallback credential source. The leading
 * logout scrubs a login that earlier releases left in root's `~/.docker`. */
export function ghcrLoginCommand(
  username: string,
  secret: string,
  configDir: string,
): string {
  return `docker logout ghcr.io >/dev/null 2>&1; install -d -m 0700 ${shellEscape(configDir)} && printf '%s\\n' ${shellEscape(secret)} | DOCKER_CONFIG=${shellEscape(configDir)} docker login ghcr.io -u ${shellEscape(username)} --password-stdin`;
}

/** A cluster-only tmpfs file lets the transfer worker exchange a short-lived GHCR
 * bearer without placing the GitHub token in its argv, environment, or logs. */
export function transferAuthFileCommand(
  username: string,
  secret: string,
  transferAuthFile: string,
): string {
  const payload = `${Buffer.from(username).toString('base64')}\n${Buffer.from(secret).toString('base64')}\n`;
  return [
    'install -d -m 0700 /run/anycloud',
    `printf '%s' ${shellEscape(Buffer.from(payload).toString('base64'))} | base64 -d > ${shellEscape(transferAuthFile)}`,
    `chmod 0600 ${shellEscape(transferAuthFile)}`,
  ].join(' && ');
}

/** The pull through containerd's transfer service. All values supplied via
 * env are non-secret; GHCR's long-lived credential is read from a cluster-only
 * tmpfs file and replaced with a scoped bearer in a temporary hosts.toml, both
 * removed on exit. A Job host's user data runs it before dockerd is up. */
export const CONTAINERD_TRANSFER_FETCH_COMMAND = `set -eu
auth_root=
auth_file=\${AC_REGISTRY_AUTH_FILE:-}
attempt_log=
cleanup_transfer_auth() {
  [ -z "$auth_root" ] || rm -rf "$auth_root"
  [ -z "$auth_file" ] || rm -f "$auth_file"
  [ -z "$attempt_log" ] || rm -f "$attempt_log"
}
trap cleanup_transfer_auth EXIT HUP INT TERM

if [ -n "$auth_file" ]; then
  user_b64=$(sed -n '1p' "$auth_file")
  secret_b64=$(sed -n '2p' "$auth_file")
  user=$(printf '%s' "$user_b64" | base64 -d)
  secret=$(printf '%s' "$secret_b64" | base64 -d)
  ref_path=\${AC_PULL_IMAGE#ghcr.io/}
  repository=\${ref_path%%@*}
  repository=\${repository%:*}
  case "$repository" in ''|*[!a-zA-Z0-9._/-]*) exit 64 ;; esac

  auth_root=$(mktemp -d /run/anycloud-transfer-auth.XXXXXX)
  chmod 0700 "$auth_root"
  auth_pair=$(printf '%s:%s' "$user" "$secret" | base64 | tr -d '\\n')
  curl_config="$auth_root/curl.conf"
  printf 'header = "Authorization: Basic %s"\\n' "$auth_pair" > "$curl_config"
  chmod 0600 "$curl_config"
  token_json=$(curl --config "$curl_config" --fail --silent --show-error --get \
    --data-urlencode 'service=ghcr.io' \
    --data-urlencode "scope=repository:$repository:pull" \
    https://ghcr.io/token)
  bearer=$(printf '%s' "$token_json" | sed -nE 's/.*"(token|access_token)"[[:space:]]*:[[:space:]]*"([^"]+)".*/\\2/p' | head -n 1)
  case "$bearer" in ''|*[!A-Za-z0-9._~+/=-]*) exit 65 ;; esac
  unset secret secret_b64 auth_pair token_json

  hosts_root="$auth_root/hosts"
  mkdir -p "$hosts_root/ghcr.io"
  printf 'server = "https://ghcr.io"\\ncapabilities = ["pull", "resolve"]\\n\\n[header]\\n  authorization = "Bearer %s"\\n' "$bearer" > "$hosts_root/ghcr.io/hosts.toml"
  chmod 0600 "$hosts_root/ghcr.io/hosts.toml"
  unset bearer
fi

attempt_log=$(mktemp /tmp/anycloud-transfer-attempt.XXXXXX)
pull_attempt=1
while :; do
  : > "$attempt_log"
  if [ -n "$auth_file" ]; then
    if ctr --address "$AC_CONTAINERD_ADDRESS" --namespace "$AC_CONTAINERD_NAMESPACE" \
      images pull --snapshotter "$AC_SNAPSHOTTER" --hosts-dir "$hosts_root" "$AC_PULL_IMAGE" \
      > "$attempt_log" 2>&1; then
      cat "$attempt_log"
      break
    fi
  else
    if ctr --address "$AC_CONTAINERD_ADDRESS" --namespace "$AC_CONTAINERD_NAMESPACE" \
      images pull --snapshotter "$AC_SNAPSHOTTER" "$AC_PULL_IMAGE" \
      > "$attempt_log" 2>&1; then
      cat "$attempt_log"
      break
    fi
  fi
  cat "$attempt_log" >&2
  if grep -Eqi '429[[:space:]]+Too[[:space:]]+Many[[:space:]]+Requests|too[[:space:]]*many[[:space:]]*requests' "$attempt_log"; then
    printf 'containerd transfer was registry-throttled; falling back without retry\n' >&2
    exit 1
  fi
  [ "$pull_attempt" -lt ${CONTAINERD_TRANSFER_MAX_ATTEMPTS} ] || exit 1
  pull_attempt=$((pull_attempt + 1))
  printf 'containerd transfer attempt failed; retrying in %ss (attempt %s/%s)\n' \
    '${CONTAINERD_TRANSFER_RETRY_DELAY_SECONDS}' "$pull_attempt" '${CONTAINERD_TRANSFER_MAX_ATTEMPTS}' >&2
  sleep ${CONTAINERD_TRANSFER_RETRY_DELAY_SECONDS}
done
`;

/** Detached worker body: the transfer, then a check that Docker sees the image. */
export const CONTAINERD_TRANSFER_PULL_COMMAND = `${CONTAINERD_TRANSFER_FETCH_COMMAND}
docker image inspect "$AC_PULL_IMAGE" >/dev/null
`;
