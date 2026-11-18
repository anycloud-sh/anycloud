/** Docker Engine static binary version — installed from download.docker.com. */
export const DOCKER_VERSION = '27.5.1';

/**
 * A CPU VM Job host's Docker (job-host.ts), only ever on the containerd image
 * store: on overlay2 it pulls 6-11 s slower than 27.5.1.
 */
export const JOB_HOST_DOCKER_VERSION = '29.9.3';

/** Rclone version — installed from downloads.rclone.org. */
export const RCLONE_VERSION = '1.68.2';

// Shell expressions to detect VM architecture at runtime.
// Docker static binaries use uname -m directly (x86_64, aarch64).
// Rclone and Caddy use Go-style arch names (amd64, arm64).
export const DOCKER_ARCH_COMMAND = '$(uname -m)';
export const GO_ARCH_COMMAND = `$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')`;

// Shell references to the variables the commands above assign. Callers that
// emit multi-step scripts assign once and then reference.
export const DOCKER_ARCH_REF = '${DOCKER_ARCH}';
export const GO_ARCH_REF = '${GO_ARCH}';

/**
 * The static Docker install's daemon config, written before dockerd first
 * starts unless the image has one: the primary NIC's MTU for the default
 * bridge and new networks (GCP's is 1460; Docker's 1500 there stalls large
 * transfers), a high open-file limit for containers, and Google's Docker Hub
 * mirror, which Docker falls back from when it lacks an image.
 */
function dockerDaemonConfigCommand(extra: string): string {
  return `[ -s /etc/docker/daemon.json ] || { dev=$(awk '$2 == "00000000" { print $1; exit }' /proc/net/route) && mtu=$(cat "/sys/class/net/$dev/mtu") && mkdir -p /etc/docker && printf '{"mtu":%s,"default-network-opts":{"bridge":{"com.docker.network.driver.mtu":"%s"}},"default-ulimits":{"nofile":{"Name":"nofile","Soft":1048576,"Hard":1048576}},"registry-mirrors":["https://mirror.gcr.io"]${extra}}\\n' "$mtu" "$mtu" > /etc/docker/daemon.json; }`;
}
export const DOCKER_DAEMON_CONFIG_COMMAND = dockerDaemonConfigCommand('');
/** The same, with Docker on the containerd image store (JOB_HOST_DOCKER_VERSION). */
export const CONTAINERD_STORE_DAEMON_CONFIG_COMMAND = dockerDaemonConfigCommand(
  ',"features":{"containerd-snapshotter":true}',
);

/** The static Docker install's systemd unit, written over SSH or by a Job host's user data. */
export const DOCKER_SYSTEMD_UNIT = `[Unit]
Description=Docker Application Container Engine
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=notify
ExecStart=/usr/bin/dockerd
ExecReload=/bin/kill -s HUP $MAINPID
Restart=always
RestartSec=5
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
Delegate=yes
KillMode=process

[Install]
WantedBy=multi-user.target`;

/**
 * curl for a host's pinned downloads: a short connect timeout, a stall
 * (under 64 KB/s for 15 s: next to nothing, so a slow link still finishes)
 * counted as a failure, and bounded retries. A download that stalls 12–35 s
 * is cut off and retried.
 */
export const BOUNDED_CURL =
  'curl -fsSL --connect-timeout 5 --speed-limit 65536 --speed-time 15 --retry 5 --retry-delay 1 --retry-all-errors';

/**
 * One owner for pinned vendor URLs. Callers pass whichever architecture token
 * they have: a host literal or a shell reference inside a generated script.
 */
export function dockerArchiveUrl(
  arch: string,
  version: string = DOCKER_VERSION,
): string {
  return `https://download.docker.com/linux/static/stable/${arch}/docker-${version}.tgz`;
}

export function rcloneArchiveUrl(goArch: string): string {
  return `https://downloads.rclone.org/v${RCLONE_VERSION}/${rcloneArtifactFileName(goArch)}`;
}

export function rcloneArchiveDirectory(goArch: string): string {
  return `rclone-v${RCLONE_VERSION}-linux-${goArch}`;
}

function rcloneArtifactFileName(goArch: string): string {
  return `${rcloneArchiveDirectory(goArch)}.zip`;
}

/**
 * pigz 2.8 from Ubuntu 24.04's archive. It needs glibc 2.34 and zlib, so it
 * runs on every VM-host image (Ubuntu 22.04 or 24.04). 2.6, from 22.04,
 * aborts against 24.04's zlib 1.3. Docker and containerd decompress gzip
 * layers through unpigz when it is on PATH.
 */
export const PIGZ_DEBS = {
  x86_64: {
    url: 'https://archive.ubuntu.com/ubuntu/pool/universe/p/pigz/pigz_2.8-1_amd64.deb',
    sha256: '9c90b8ada9e9c346b787aa7e827c1f70c4a8933ee322171689f2a0311e3f7b5e',
  },
  aarch64: {
    url: 'https://ports.ubuntu.com/ubuntu-ports/pool/universe/p/pigz/pigz_2.8-1_arm64.deb',
    sha256: '8d3bce5fd98ea04be1343dab5669c4a0b92422bf1b3c38cb4b0403b44bf66f5d',
  },
} as const satisfies Record<'x86_64' | 'aarch64', RuntimeArtifactRelease>;

export const UNPIGZ_PATH = '/usr/local/bin/unpigz';

/**
 * Installs unpigz from a downloaded, checked "$d/pigz.deb". A binary that
 * can't inflate on this host must not reach PATH: every gzip layer would fail
 * to unpack.
 */
export const UNPIGZ_FROM_DEB =
  'dpkg-deb --fsys-tarfile "$d/pigz.deb" | tar -xO ./usr/bin/pigz > "$d/unpigz" && ' +
  'chmod +x "$d/unpigz" && echo ok | gzip | "$d/unpigz" -dc | grep -qx ok && ' +
  `install -m 0755 "$d/unpigz" ${UNPIGZ_PATH}`;

/**
 * Shell command to install the pinned unpigz as UNPIGZ_PATH. pigz
 * decompresses when invoked under that name. Hosts without dpkg-deb (Local's
 * Alpine guest) skip it; every cloud VM-host image is Ubuntu.
 */
export function installUnpigzCommand(): string {
  const arches = Object.entries(PIGZ_DEBS)
    .map(([arch, deb]) => `${arch}) url=${deb.url} sum=${deb.sha256} ;;`)
    .join(' ');
  return (
    'command -v dpkg-deb >/dev/null || exit 0; ' +
    `case $(uname -m) in ${arches} *) exit 1 ;; esac && ` +
    `d=$(mktemp -d) && trap 'rm -rf "$d"' EXIT && ` +
    'curl -fsSL --connect-timeout 10 --max-time 120 --retry 2 --retry-all-errors "$url" -o "$d/pigz.deb" && ' +
    'echo "$sum  $d/pigz.deb" | sha256sum -c - && ' +
    UNPIGZ_FROM_DEB
  );
}

/**
 * iptables 1.8.10 and the libraries Ubuntu 24.04 minimal lacks, from Ubuntu's
 * archive: Docker's bridge networking needs it. Installed with dpkg, since a
 * Job host's user data runs before cloud-init writes its apt sources.
 */
export const IPTABLES_DEBS = {
  x86_64: [
    {
      url: 'https://archive.ubuntu.com/ubuntu/pool/main/i/iptables/iptables_1.8.10-3ubuntu2_amd64.deb',
      sha256:
        'd341e8ffc42ca035f5aa0fd9a798c8d2b2edb019225dc11f4dac16edf9c57840',
    },
    {
      url: 'https://archive.ubuntu.com/ubuntu/pool/main/i/iptables/libip4tc2_1.8.10-3ubuntu2_amd64.deb',
      sha256:
        'eb381f8ff0469534df3f1b146c3eb8baa6e36f8cfcdf2e3e039398322930d0a4',
    },
    {
      url: 'https://archive.ubuntu.com/ubuntu/pool/main/i/iptables/libip6tc2_1.8.10-3ubuntu2_amd64.deb',
      sha256:
        'b98b88eb6aa14a902ea1aebc3b12ddd140572545ae1fc6428cb0868c31671d05',
    },
    {
      url: 'https://archive.ubuntu.com/ubuntu/pool/main/libn/libnetfilter-conntrack/libnetfilter-conntrack3_1.0.9-6build1_amd64.deb',
      sha256:
        '6d32a4c4618eb7d6c0d989591d28637a9acdfa86dfe22e42e9ac9cc25d882a97',
    },
    {
      url: 'https://archive.ubuntu.com/ubuntu/pool/main/libn/libnfnetlink/libnfnetlink0_1.0.2-2build1_amd64.deb',
      sha256:
        'f557a287af2ca00df5dbf632c6b77d77479139ffb51c83e3de9766eb609b5d63',
    },
    {
      url: 'https://archive.ubuntu.com/ubuntu/pool/main/libn/libnftnl/libnftnl11_1.2.6-2build1_amd64.deb',
      sha256:
        'e5bde5c9cbb95082700011f0b7ef2c0a41900b0a9fd7434f6e90448e2a7b4e50',
    },
  ],
  aarch64: [
    {
      url: 'https://ports.ubuntu.com/ubuntu-ports/pool/main/i/iptables/iptables_1.8.10-3ubuntu2_arm64.deb',
      sha256:
        'cbaacdb34f19a9b29f569205cdbf1e5851f63fde60777c5cf539a2b46c0c2fc7',
    },
    {
      url: 'https://ports.ubuntu.com/ubuntu-ports/pool/main/i/iptables/libip4tc2_1.8.10-3ubuntu2_arm64.deb',
      sha256:
        'e692da5dffee228ed346474a6e9e21511acbb7329bc304b4ae6dbbc25b2831a2',
    },
    {
      url: 'https://ports.ubuntu.com/ubuntu-ports/pool/main/i/iptables/libip6tc2_1.8.10-3ubuntu2_arm64.deb',
      sha256:
        '4438956b281410ee6d58ce59d1f9588e30f4abf7167e110fdb4f26a99fa5dee7',
    },
    {
      url: 'https://ports.ubuntu.com/ubuntu-ports/pool/main/libn/libnetfilter-conntrack/libnetfilter-conntrack3_1.0.9-6build1_arm64.deb',
      sha256:
        '7b152f919dbd3ffd9ca3ac95d96fdac0cdd139656eb284a0abbc46fce6063301',
    },
    {
      url: 'https://ports.ubuntu.com/ubuntu-ports/pool/main/libn/libnfnetlink/libnfnetlink0_1.0.2-2build1_arm64.deb',
      sha256:
        'c7c64d90793ce4d7df262aad50d99eb45ca848fa9421f1bccb22665c350bdb2f',
    },
    {
      url: 'https://ports.ubuntu.com/ubuntu-ports/pool/main/libn/libnftnl/libnftnl11_1.2.6-2build1_arm64.deb',
      sha256:
        '678792e1aa102892b594e0ee13ee93b763011674bddba800a3974a68a83c6ed1',
    },
  ],
} as const satisfies Record<
  'x86_64' | 'aarch64',
  readonly RuntimeArtifactRelease[]
>;

interface RuntimeArtifactRelease {
  url: string;
  sha256: string;
}

export interface RuntimeArtifactSet {
  docker: RuntimeArtifactRelease;
  rclone: RuntimeArtifactRelease;
}

/**
 * Pinned archives used when a test host prepares the Local runtime cache.
 * The guest architecture matches the smolvm host architecture, while rclone
 * uses Go's amd64/arm64 names instead of uname's x86_64/aarch64 names.
 */
export const RUNTIME_ARTIFACTS_BY_HOST_ARCH = {
  x86_64: {
    docker: {
      url: dockerArchiveUrl('x86_64'),
      sha256:
        '4f798b3ee1e0140eab5bf30b0edc4e84f4cdb53255a429dc3bbae9524845d640',
    },
    rclone: {
      url: rcloneArchiveUrl('amd64'),
      sha256:
        '0e6fa18051e67fc600d803a2dcb10ddedb092247fc6eee61be97f64ec080a13c',
    },
  },
  aarch64: {
    docker: {
      url: dockerArchiveUrl('aarch64'),
      sha256:
        'e6b53725a73763ab3f988c73f8772eaed429754c1a579db5ff11f21990fd1817',
    },
    rclone: {
      url: rcloneArchiveUrl('arm64'),
      sha256:
        'c6e9d4cf9c88b279f6ad80cd5675daebc068e404890fa7e191412c1bc7a4ac5f',
    },
  },
} as const satisfies Record<'x86_64' | 'aarch64', RuntimeArtifactSet>;
