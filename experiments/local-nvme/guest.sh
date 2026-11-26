#!/bin/sh
# The Job's process, in docker:27-cli with the host's Docker socket: where
# the host keeps / , /workspace and the image stores, then three of backmesh's
# benchmark builds (benchmarks/builds/bench.yml in backmesh/backmesh), each in
# its toolchain's official image. As on a backmesh runner, sources, build
# output and caches live in the host's /workspace, which anycloud binds into
# the Job; images and containers' layers live in the image stores. Each timed
# step prints `BENCH <build> <command> <ms>`. A failed build prints
# `BENCH_FAIL <build>` and the next build still runs.
set -eu
# coreutils' date, for nanoseconds.
apk add --no-cache -q coreutils git >/dev/null

# `DISK <path> <source> <fstype>`, from the host's mount namespace.
docker run --rm --privileged --pid=host alpine:3.20 nsenter -t 1 -m -- sh -c '
  for p in / /workspace /var/lib/containerd; do
    echo "DISK $p $(findmnt -no SOURCE,FSTYPE --target $p | head -n 1)"
  done
  lsblk -dno NAME,MODEL,SIZE | sed "s/^/LSBLK /"
  lscpu | sed -n "s/^Model name:/LSCPU Model name:/p"'

# The toolchains' pulls, timed together: the image stores take the writes.
start=$(date +%s%N)
for image in rust:1.83-bookworm node:22-bookworm; do
  docker pull -q "$image" >/dev/null
done
echo "BENCH pull toolchain-images $((($(date +%s%N) - start) / 1000000))"

# `build <name> <image> <bash script>`: runs the script in a new container of
# the image, in /workspace/<name>; the script times its commands with
# `timed <label> <command...>`.
build() {
  docker run --rm -e BUILD="$1" -v /workspace:/workspace \
    -e HOME=/workspace/home -e CARGO_HOME=/workspace/home/.cargo "$2" bash -c '
    set -eu
    timed() {
      label=$1; shift
      start=$(date +%s%N)
      if ! "$@" >/tmp/out 2>&1; then
        tail -40 /tmp/out; echo "BENCH_FAIL $BUILD $label"; exit 1
      fi
      echo "BENCH $BUILD $label $(( ($(date +%s%N) - start) / 1000000 ))"
    }
    clone() { git clone -q --depth 1 -b "$2" "https://github.com/$1" "/workspace/$BUILD" 2>/dev/null; cd "/workspace/$BUILD"; }
    '"$3" || echo "BENCH_FAIL $1"
}

# docker: the job container is the client, as on a runner.
git clone -q --depth 1 -b v0.54.0 https://github.com/grafana/k6 /workspace/k6 2>/dev/null
start=$(date +%s%N)
if (cd /workspace/k6 && docker build -q -t local-nvme-k6 . >/tmp/out 2>&1); then
  echo "BENCH docker build $((($(date +%s%N) - start) / 1000000))"
else
  tail -40 /tmp/out
  echo "BENCH_FAIL docker"
fi

build rust rust:1.83-bookworm '
  clone BurntSushi/ripgrep 14.1.1
  cargo fetch --locked -q
  timed build cargo build --release --locked'

build typescript node:22-bookworm '
  clone microsoft/TypeScript v5.6.3
  timed install npm ci --no-audit --no-fund
  timed build npx hereby local'

echo BENCH_DONE
