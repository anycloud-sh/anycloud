# The vm-image-pull-attribution guest. run.ts prepends its SPIKE_*
# settings and the product's transfer pull command (transfer-pull.sh).
shutdown -h +"$SPIKE_DEADLINE_MIN"
exec > >(tee /var/log/spike.log /dev/console) 2>&1
set -u
out=/var/spike/out
mkdir -p "$out" && cd /var/spike || exit 1
upload() {
  kill "$sampler"
  cp /var/log/spike.log "$out/"
  tar czf /var/spike.tgz -C "$out" .
  curl -sf --retry 5 -X PUT -H 'Content-Type: application/gzip' \
    --upload-file /var/spike.tgz "$SPIKE_EVIDENCE_URL"
  shutdown -h now
}
trap upload EXIT

# One line a second: time, bytes received on the host's NICs (not loopback,
# bridges, or an enslaved VF its parent already counts), sectors written to
# whole disks, and CPU busy, iowait and total jiffies.
rx() {
  for nic in /sys/class/net/*; do
    case ${nic##*/} in lo | docker* | veth* | br-* | virbr*) continue ;; esac
    [ -e "$nic/master" ] || cat "$nic/statistics/rx_bytes"
  done | awk '{s += $1} END {print s}'
}
while :; do
  printf '%s %s %s %s\n' "$(date +%s.%N)" "$(rx)" \
    "$(awk '$3 ~ /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme[0-9]+n[0-9]+)$/ {s += $10} END {print s}' /proc/diskstats)" \
    "$(awk '/^cpu / {print $2 + $3 + $4 + $7 + $8, $6, $2 + $3 + $4 + $5 + $6 + $7 + $8}' /proc/stat)"
  sleep 1
done > "$out/samples.txt" &
sampler=$!

# A timed step; its output goes to <name>.log.
phase() {
  local name=$1 start code
  shift
  start=$(date +%s.%N)
  "$@" > "$out/$name.log" 2>&1
  code=$?
  printf '%s\t%s\t%s\t%s\n' "$name" "$start" "$(date +%s.%N)" "$code" >> "$out/phases.tsv"
  return "$code"
}

# CPU images have no Docker: install it as vm-initializer.ts does, from the
# pinned static archive (overlay2, its own bundled containerd).
if ! command -v docker > /dev/null; then
  curl -fsSL --retry 5 "$SPIKE_DOCKER_URL" -o /tmp/docker.tgz &&
    tar xzf /tmp/docker.tgz -C /tmp && mv /tmp/docker/* /usr/bin/ &&
    printf '%s\n' '[Unit]' 'After=network-online.target' '[Service]' \
      'Type=notify' 'ExecStart=/usr/bin/dockerd' 'Delegate=yes' \
      'KillMode=process' > /etc/systemd/system/docker.service &&
    systemctl daemon-reload || { echo 'SPIKE docker install failed'; exit 1; }
fi
systemctl start docker || { echo 'SPIKE docker failed to start'; exit 1; }

# The transfer store, as configureContainerdTransferStore sets it up: a system
# containerd >= 2.1 wired into dockerd, the transfer table, and Docker on the
# containerd image store. Any other host records why and pulls with Docker only.
transfer_store() {
  local version pid
  version=$(containerd --version 2> /dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | tail -1)
  echo "containerd=${version:-missing}"
  printf '2.1.0\n%s\n' "$version" | sort -VC || { echo "transfer=containerd_${version:-missing}_lt_2.1"; return 1; }
  systemctl is-active --quiet containerd || { echo 'transfer=no_system_containerd'; return 1; }
  pid=$(systemctl show -p MainPID --value docker)
  address=$(tr '\0' '\n' < "/proc/$pid/cmdline" |
    awk 'p {print; exit} $0 == "--containerd" {p = 1} sub(/^--containerd=/, "") {print; exit}')
  [ -n "$address" ] || { echo 'transfer=docker_not_wired_to_system_containerd'; return 1; }
  grep -qs 'io.containerd.transfer.v1.local' /etc/containerd/config.toml &&
    { echo 'transfer=transfer_table_preexisting'; return 1; }
  printf '\n[plugins."io.containerd.transfer.v1.local"]\n  max_concurrent_downloads = %s\n  concurrent_layer_fetch_buffer = %s\n' \
    "$SPIKE_TRANSFER_CONCURRENCY" "$SPIKE_TRANSFER_CHUNK_BYTES" >> /etc/containerd/config.toml
  python3 -c 'import json, os
p = "/etc/docker/daemon.json"
d = json.load(open(p)) if os.path.exists(p) else {}
d.pop("storage-driver", None)
d.setdefault("features", {})["containerd-snapshotter"] = True
json.dump(d, open(p, "w"))'
  systemctl restart containerd && systemctl restart docker
  ctr --address "$address" plugins ls | grep -qE 'io\.containerd\.transfer\.v1 +local .* ok' &&
    docker info -f '{{json .DriverStatus}}' | grep -q 'io.containerd.snapshotter' ||
    { echo 'transfer=verification_failed'; return 1; }
  echo 'transfer=ready'
}
{
  echo "target=$SPIKE_TARGET"
  echo "cpus=$(nproc)"
  echo "memKiB=$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
  echo "docker=$(docker version -f '{{.Server.Version}}')"
  transfer_store || address=
  echo "driver=$(docker info -f '{{.Driver}}')"
  echo "dockerRoot=$(docker info -f '{{.DockerRootDir}}')"
  lsblk -b -d -n -o NAME,SIZE,ROTA,MODEL | sed 's/^/disk=/'
} >> "$out/meta"

# Empty both stores and the page cache; summary.json flags a pull that
# fetched less than the image.
cold() {
  docker rmi -f "$SPIKE_IMAGE"
  docker system prune -af
  if [ -n "${address:-}" ]; then
    ctr --address "$address" -n moby content ls -q |
      xargs -r ctr --address "$address" -n moby content rm
  fi
  sync && echo 3 > /proc/sys/vm/drop_caches
}

# Probes: sequential direct writes to Docker's filesystem, then 1 GiB of the
# image's largest layer from GHCR as one stream and as the transfer's
# three lanes of 128 MiB ranges.
probe=$(docker info -f '{{.DockerRootDir}}')/../spike-probe
phase disk-write dd if=/dev/zero of="$probe" bs=1M count=2048 oflag=direct
rm -f "$probe"
repo=${SPIKE_IMAGE#ghcr.io/}
repo=${repo%@*}
export SPIKE_BEARER SPIKE_BLOB_URL="https://ghcr.io/v2/$repo/blobs/$SPIKE_PROBE_BLOB"
SPIKE_BEARER=$(curl -sf "https://ghcr.io/token?service=ghcr.io&scope=repository:$repo:pull" |
  sed -nE 's/.*"token":"([^"]+)".*/\1/p')
fetch() { curl -sfL -H "Authorization: Bearer $SPIKE_BEARER" -r "$1" -o /dev/null "$SPIKE_BLOB_URL"; }
ranges() {
  seq 0 7 | xargs -P3 -I{} bash -c 'fetch $(({} * 134217728))-$(({} * 134217728 + 134217727))'
}
export -f fetch
phase net-single fetch 0-1073741823
phase net-ranges ranges

# docker-pull is the Go gzip baseline: move aside any unpigz the image ships.
# Docker looks unpigz up for each layer, so no restart is needed.
for bin in $(which -a unpigz); do mv "$bin" "$bin.spike-off" && echo "imageUnpigz=$bin" >> "$out/meta"; done

# Each pull stops after 25 minutes, so a slow disk still leaves its partial
# samples as evidence before the halt.
cold > /dev/null 2>&1
phase docker-pull timeout 25m docker pull "$SPIKE_IMAGE"
if [ -n "${address:-}" ]; then
  cold > /dev/null 2>&1
  export AC_CONTAINERD_ADDRESS=$address AC_CONTAINERD_NAMESPACE=moby \
    AC_SNAPSHOTTER=$(docker info -f '{{.Driver}}') AC_PULL_IMAGE=$SPIKE_IMAGE
  phase transfer-pull timeout 25m sh /var/spike/transfer-pull.sh
fi

# R2: the same cold pull with the product's pinned unpigz on PATH.
# unpigz-ps shows Docker running it, 90 s in.
sh /var/spike/install-unpigz.sh > "$out/unpigz-install.log" 2>&1 &&
  command -v unpigz >> "$out/meta" || { echo 'SPIKE unpigz install failed'; exit 1; }
cold > /dev/null 2>&1
(sleep 90 && pgrep -a unpigz) > "$out/unpigz-ps" 2>&1 &
phase unpigz-pull timeout 25m docker pull "$SPIKE_IMAGE"
echo 'SPIKE complete'
