import { log } from './logger.js';
import type { VmTransport } from './gateways/transport-contract.js';
import { PULL_CONTROL_TIMEOUT_MS } from '../config.js';

// The Premium_LRS OS disk caps Azure GPU pulls at about 70 MB/s while each
// pull writes about 21 GB. Azure's local resource disk has no
// such cap, so on a type that has one the Docker and containerd stores are
// bind-mounted onto it. A deallocation or redeploy hands the VM a fresh, empty
// resource disk; the boot unit below re-creates the store directories there
// before either daemon starts, and the resumed Job re-pulls its image. Node
// pool Nodes bind kubelet and K3s's containerd the same way.
const STORE_UNIT = 'anycloud-image-store.service';
/** Each store's directory on the resource disk and the path bound onto it. */
const VM_HOST_STORES = {
  docker: '/var/lib/docker',
  containerd: '/var/lib/containerd',
};

/** Azure's udev rules name the disk under /dev/disk/cloud (cloud-init) or
 * /dev/disk/azure (WALinuxAgent, azure-vm-utils); no other cloud has them. */
export const RESOURCE_DISK_LINKS =
  '/dev/disk/cloud/azure_resource-part1 /dev/disk/azure/resource-part1';

/** Prints `<mountpoint> <KiB> <root KiB>` when the resource disk is mounted. */
export const RESOURCE_DISK_PROBE = [
  `for link in ${RESOURCE_DISK_LINKS}; do`,
  '  [ -e "$link" ] || continue',
  '  target=$(findmnt -n -o TARGET --source "$(readlink -f "$link")" | head -n 1)',
  '  [ -n "$target" ] || exit 0',
  `  echo "$target $(df -Pk "$target" | awk 'NR==2 {print $2}') $(df -Pk / | awk 'NR==2 {print $2}')"`,
  '  exit 0',
  'done',
].join('\n');

/** Prints the probe's mount point when resourceDiskStoreMount would return it. */
export const RESOURCE_DISK_STORE_MOUNT_FILTER = `awk 'index($1, "/") == 1 && $1 != "/" && $2 + 0 >= $3 + 0 { print $1 }'`;

/** The resource disk's mount point, or null when the stores stay on the OS
 * disk: no resource disk, an unmounted one, or one smaller than the root
 * filesystem (a requested large OS disk must keep its capacity). */
export function resourceDiskStoreMount(probe: string): string | null {
  const [mount, size, rootSize] = probe.trim().split(/\s+/);
  if (!mount?.startsWith('/') || mount === '/') return null;
  return Number(size) >= Number(rootSize) ? mount : null;
}

export function resourceDiskStoreUnit(mount: string): string {
  const binds = Object.entries(VM_HOST_STORES)
    .map(
      ([store, path]) =>
        `install -d -m 0711 ${mount}/anycloud/${store} ${path} && ` +
        `{ mountpoint -q ${path} || mount --bind ${mount}/anycloud/${store} ${path}; }`,
    )
    .join(' && ');
  return [
    '[Unit]',
    'Description=AnyCloud image stores on the Azure resource disk',
    `RequiresMountsFor=${mount}`,
    // An unmounted disk leaves the daemons on the OS disk instead of failing them.
    `ConditionPathIsMountPoint=${mount}`,
    // Ubuntu's walinuxagent writes a read-only, immutable warning file to a
    // fresh disk's mount point, which it reads from /proc/mounts. Once the
    // stores are bound, that lookup also returns them, and the warning makes
    // /var/lib/docker immutable.
    'After=ephemeral-disk-warning.service',
    'Before=containerd.service docker.service',
    '',
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
    `ExecStart=/bin/sh -c '${binds}'`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ].join('\n');
}

/** Wants, not Requires: a failed store unit must not stop the daemons. */
const DAEMON_DROP_IN = `[Unit]\nWants=${STORE_UNIT}\nAfter=${STORE_UNIT}`;

/**
 * Installs and starts the store unit, restarting a daemon that ran. The
 * heredocs are unquoted, so `mount` may be a shell variable such as
 * `$STORE_MOUNT` (generateJobHostUserData); the units hold no other expansion.
 */
export function resourceDiskStoreInstallCommand(mount: string): string {
  return [
    'set -eu',
    `systemctl is-active --quiet ${STORE_UNIT} && exit 0`,
    `cat > /etc/systemd/system/${STORE_UNIT} << UNIT_EOF\n${resourceDiskStoreUnit(mount)}\nUNIT_EOF`,
    ...Object.keys(VM_HOST_STORES).flatMap((store) => [
      `mkdir -p /etc/systemd/system/${store}.service.d`,
      `cat > /etc/systemd/system/${store}.service.d/anycloud-image-store.conf << UNIT_EOF\n${DAEMON_DROP_IN}\nUNIT_EOF`,
    ]),
    'systemctl daemon-reload',
    `systemctl enable ${STORE_UNIT}`,
    // The stores must be bound before a daemon opens them; restart what ran.
    'active=$(for s in containerd docker; do systemctl is-active --quiet "$s" && echo "$s"; done || true)',
    'for s in docker.socket docker.service containerd.service; do systemctl stop "$s" 2>/dev/null || true; done',
    `rc=0; systemctl start ${STORE_UNIT} || rc=$?`,
    'if [ -n "$active" ]; then systemctl start $active; fi',
    'exit $rc',
  ].join('\n');
}

/**
 * Move the Docker and containerd stores to the Azure resource disk when the
 * VM type has one. Best-effort: on any failure the stores stay on the OS disk.
 */
export async function moveImageStoresToResourceDisk(
  ssh: VmTransport,
  workloadId: string,
  vmIp: string,
): Promise<void> {
  try {
    const { stdout } = await ssh.exec(
      RESOURCE_DISK_PROBE,
      2,
      false,
      PULL_CONTROL_TIMEOUT_MS,
    );
    const mount = resourceDiskStoreMount(stdout);
    if (!mount) return;
    await ssh.exec(
      resourceDiskStoreInstallCommand(mount),
      1,
      false,
      PULL_CONTROL_TIMEOUT_MS,
    );
    log.info('Image stores on the resource disk', {
      id: workloadId,
      ip: vmIp,
      mount,
      probe: stdout.trim(),
    });
  } catch (error) {
    log.warn('Resource disk store setup failed; stores stay on the OS disk', {
      id: workloadId,
      ip: vmIp,
      error,
    });
  }
}
