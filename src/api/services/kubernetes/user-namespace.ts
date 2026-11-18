/**
 * RFC 0049 C32: user-namespace pool Jobs. A pool created with
 * `--user-namespace-jobs` gets one more runc handler on its Nodes, and every
 * Job on it runs under that handler as root of its own user namespace,
 * with a delegated cgroup and the Node's `/sys`, so it can run container
 * engines, inner `--privileged` containers and nested clusters.
 */

/** The RuntimeClass a user-namespace Pod names, and the containerd handler it selects. */
export const USER_NAMESPACE_RUNTIME_CLASS = 'anycloud-user-namespace';
export const USER_NAMESPACE_HANDLER = 'anycloud-userns';

/**
 * Set by the node pool controller with the pool's membership label, once it
 * matches a Node to a VM of an opted-in pool. NodeRestriction refuses it to
 * a kubelet, so a rooted Node elsewhere can't attract these Pods.
 */
export const USER_NAMESPACE_NODE_LABEL =
  'node-restriction.kubernetes.io/anycloud-user-namespace';

/**
 * The RuntimeClass's `overhead.podFixed` memory: the kubelet adds it to the
 * Pod cgroup's limit, so the container's own limit, the namespace root whose
 * `memory.events.local` the runner reads, is reached first.
 */
export const USER_NAMESPACE_POD_OVERHEAD_MI = 32;

/** `/dev/kvm`, advertised by the device plugin on user-namespace Nodes. */
export const KVM_RESOURCE = 'anycloud.sh/kvm';

const CONTAINERD_DIR = '/var/lib/rancher/k3s/agent/etc/containerd';
const BASE_SPEC_PATH = `${CONTAINERD_DIR}/anycloud-userns-spec.json`;

const DEFAULT_CAPABILITIES = [
  'CAP_CHOWN',
  'CAP_DAC_OVERRIDE',
  'CAP_FSETID',
  'CAP_FOWNER',
  'CAP_MKNOD',
  'CAP_NET_RAW',
  'CAP_SETGID',
  'CAP_SETUID',
  'CAP_SETFCAP',
  'CAP_SETPCAP',
  'CAP_NET_BIND_SERVICE',
  'CAP_SYS_CHROOT',
  'CAP_KILL',
  'CAP_AUDIT_WRITE',
];
const DEV_OPTIONS = ['nosuid', 'strictatime', 'mode=755', 'size=65536k'];

/**
 * The handler's `base_runtime_spec`: containerd's default spec (`ctr oci
 * spec` at the pinned K3s) with `/sys` a recursive read-write bind of the
 * Node's, and without the default's `RLIMIT_NOFILE` of 1024, which CRI keeps
 * when a base spec is set. A fresh sysfs mounts read-write in a user
 * namespace only while one is fully visible, which inner `--privileged`
 * containers need; a non-recursive bind fails with EINVAL, as it would
 * uncover locked mounts. A K3s pin bump re-captures it (RELEASE.md); the
 * cloud check compares it with the Node's.
 */
export const USER_NAMESPACE_BASE_SPEC = {
  ociVersion: '1.3.0',
  process: {
    user: { uid: 0, gid: 0 },
    cwd: '/',
    capabilities: {
      bounding: DEFAULT_CAPABILITIES,
      effective: DEFAULT_CAPABILITIES,
      permitted: DEFAULT_CAPABILITIES,
    },
    noNewPrivileges: true,
  },
  root: { path: 'rootfs' },
  mounts: [
    {
      destination: '/proc',
      type: 'proc',
      source: 'proc',
      options: ['nosuid', 'noexec', 'nodev'],
    },
    {
      destination: '/dev',
      type: 'tmpfs',
      source: 'tmpfs',
      options: DEV_OPTIONS,
    },
    {
      destination: '/dev/pts',
      type: 'devpts',
      source: 'devpts',
      options: [
        'nosuid',
        'noexec',
        'newinstance',
        'ptmxmode=0666',
        'mode=0620',
        'gid=5',
      ],
    },
    {
      destination: '/dev/shm',
      type: 'tmpfs',
      source: 'shm',
      options: ['nosuid', 'noexec', 'nodev', 'mode=1777', 'size=65536k'],
    },
    {
      destination: '/dev/mqueue',
      type: 'mqueue',
      source: 'mqueue',
      options: ['nosuid', 'noexec', 'nodev'],
    },
    {
      destination: '/sys',
      type: 'bind',
      source: '/sys',
      options: ['rbind', 'nosuid', 'noexec', 'nodev', 'rw'],
    },
    {
      destination: '/run',
      type: 'tmpfs',
      source: 'tmpfs',
      options: DEV_OPTIONS,
    },
  ],
  linux: {
    resources: { devices: [{ allow: false, access: 'rwm' }] },
    cgroupsPath: '/k8s.io',
    namespaces: [
      { type: 'pid' },
      { type: 'ipc' },
      { type: 'uts' },
      { type: 'mount' },
      { type: 'network' },
    ],
    maskedPaths: [
      '/proc/acpi',
      '/proc/asound',
      '/proc/kcore',
      '/proc/keys',
      '/proc/latency_stats',
      '/proc/timer_list',
      '/proc/timer_stats',
      '/proc/sched_debug',
      '/sys/firmware',
      '/sys/devices/virtual/powercap',
      '/proc/scsi',
    ],
    readonlyPaths: [
      '/proc/bus',
      '/proc/fs',
      '/proc/irq',
      '/proc/sys',
      '/proc/sysrq-trigger',
    ],
  },
};

/**
 * The join script's part for an opted-in pool, written before the agent
 * first starts so containerd loads the handler without a restart: the
 * handler, as K3s's own runc on pool Nodes (`SystemdCgroup`), with
 * containerd's `cgroup_writable` so runc hands the Pod's cgroup to its
 * process's user (its group stays unmapped),
 * and its base spec. With nested virtualization, `/dev/kvm` becomes 0666:
 * a user-namespace Pod's root isn't in the host's `kvm` group, and only Pods
 * the device plugin gives the device see it. The device exists at boot, so
 * the rule is applied to it now.
 */
export function userNamespaceJoinScript(nestedVirtualization: boolean): string {
  const runtime = `plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.${USER_NAMESPACE_HANDLER}`;
  return `cat > ${BASE_SPEC_PATH} <<'SPEC'
${JSON.stringify(USER_NAMESPACE_BASE_SPEC)}
SPEC
cat > ${CONTAINERD_DIR}/config-v3.toml.d/60-anycloud-userns.toml <<'CONTAINERD'
version = 3
[${runtime}]
  runtime_type = "io.containerd.runc.v2"
  cgroup_writable = true
  base_runtime_spec = "${BASE_SPEC_PATH}"
  [${runtime}.options]
    SystemdCgroup = true
CONTAINERD
${
  nestedVirtualization
    ? `echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666"' > /etc/udev/rules.d/99-anycloud-kvm.rules
udevadm control --reload-rules
if [ -e /dev/kvm ]; then
  udevadm trigger --action=change --name-match=kvm
  udevadm settle
fi
`
    : ''
}`;
}
