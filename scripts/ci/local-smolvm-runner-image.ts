import {
  DOCKER_VERSION,
  RCLONE_VERSION,
} from '../../src/api/runtime-artifacts.js';
import { RUNTIME_ARTIFACTS_BY_HOST_ARCH } from '../../src/api/runtime-artifacts.js';
import { LOCAL_SMOLVM_CONTRACT } from '../../src/api/services/gateways/local-smolvm-contract.js';

const BUSYBOX_SOURCE =
  'mirror.gcr.io/library/busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662';
const BUSYBOX_IMAGE = 'busybox:1.36';

/** Build the script that prepares and sanitizes the stopped Local runner image. */
export function buildLocalSmolvmRunnerImageScript(): string {
  const x86Runtime = RUNTIME_ARTIFACTS_BY_HOST_ARCH.x86_64;
  const armRuntime = RUNTIME_ARTIFACTS_BY_HOST_ARCH.aarch64;

  return `#!/bin/sh
set -eux

apk add --no-cache bash openssh-server curl python3 ca-certificates iptables coreutils findutils procps tar unzip util-linux iproute2 bind-tools netcat-openbsd
mkdir -p /root/.ssh /var/empty /run/sshd /var/run/sshd /usr/local/bin /storage/docker /etc/docker
chown root:root /root /var/empty
chmod 755 /root /var/empty /run/sshd /var/run/sshd

case "$(uname -m)" in
  x86_64)
    DOCKER_URL='${x86Runtime.docker.url}'
    DOCKER_SHA256='${x86Runtime.docker.sha256}'
    RCLONE_URL='${x86Runtime.rclone.url}'
    RCLONE_SHA256='${x86Runtime.rclone.sha256}'
    RCLONE_DIR='rclone-v${RCLONE_VERSION}-linux-amd64'
    ;;
  aarch64|arm64)
    DOCKER_URL='${armRuntime.docker.url}'
    DOCKER_SHA256='${armRuntime.docker.sha256}'
    RCLONE_URL='${armRuntime.rclone.url}'
    RCLONE_SHA256='${armRuntime.rclone.sha256}'
    RCLONE_DIR='rclone-v${RCLONE_VERSION}-linux-arm64'
    ;;
  *)
    echo "Unsupported guest architecture: $(uname -m)" >&2
    exit 42
    ;;
esac

rm -rf /tmp/anycloud-runtime-install
mkdir -p /tmp/anycloud-runtime-install
cd /tmp/anycloud-runtime-install
curl -fL --retry 5 --retry-delay 2 --retry-all-errors "$DOCKER_URL" -o docker.tgz
echo "$DOCKER_SHA256  docker.tgz" | sha256sum -c -
tar xzf docker.tgz
install -m 0755 docker/* /usr/bin/
curl -fL --retry 5 --retry-delay 2 --retry-all-errors "$RCLONE_URL" -o rclone.zip
echo "$RCLONE_SHA256  rclone.zip" | sha256sum -c -
unzip -q rclone.zip
install -m 0755 "$RCLONE_DIR/rclone" /usr/bin/rclone
docker --version | grep -F '${DOCKER_VERSION}'
rclone version | head -n 1 | grep -F 'v${RCLONE_VERSION}'

test "$(findmnt -n -o FSTYPE /storage)" = ext4
cat > /etc/docker/daemon.json <<'DOCKER_DAEMON_CONFIG'
{
  "data-root": "/storage/docker",
  "storage-driver": "overlay2",
  "registry-mirrors": ["https://mirror.gcr.io"]
}
DOCKER_DAEMON_CONFIG
rm -f /var/run/docker.pid /var/run/docker.sock
rm -rf /var/run/docker/containerd
dockerd >/tmp/dockerd.log 2>&1 &
for i in $(seq 1 60); do
  docker info >/tmp/docker-info.log 2>&1 && break
  sleep 1
done
docker info >/dev/null || { cat /tmp/dockerd.log; cat /tmp/docker-info.log; exit 1; }
test "$(docker info --format '{{.Driver}}')" = overlay2
test "$(docker info --format '{{.DockerRootDir}}')" = /storage/docker
docker pull '${BUSYBOX_SOURCE}'
docker tag '${BUSYBOX_SOURCE}' '${BUSYBOX_IMAGE}'
docker run --rm '${BUSYBOX_IMAGE}' sh -c 'printf cache-ok' | grep -F cache-ok
docker image inspect '${BUSYBOX_IMAGE}' >/dev/null
pkill dockerd || true
pkill containerd || true
for i in $(seq 1 30); do
  if ! pgrep dockerd >/dev/null 2>&1 && ! pgrep containerd >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
! pgrep dockerd >/dev/null 2>&1
! pgrep containerd >/dev/null 2>&1

printf '%s\\n' '${LOCAL_SMOLVM_CONTRACT.runnerVersion}' > /etc/anycloud-image-version
rm -f /etc/ssh/ssh_host_* /etc/machine-id /var/lib/dbus/machine-id
rm -f /root/.ssh/authorized_keys /etc/anycloud-key /root/.docker/config.json
rm -rf /root/.config/rclone /tmp/anycloud-runtime-install
rm -f /var/run/docker.pid /var/run/docker.sock /run/docker.pid /run/docker.sock
rm -rf /var/run/docker/containerd /run/docker/containerd /run/containerd
rm -f /run/sshd.pid /var/run/sshd.pid
rm -rf /tmp/* /var/tmp/*
sync
`;
}
