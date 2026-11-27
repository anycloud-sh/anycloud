#!/bin/sh
# The Job's process, in docker:27-cli with the host's Docker socket: where
# the host keeps / , /workspace and the image stores, then three of backmesh's
# benchmark builds (benchmarks/builds/bench.yml in backmesh/backmesh), each in
# its toolchain's official image, then two disk-heavy ones: a CUDA image's
# pull, build, save and load, and a cache's restore and save. As on a
# backmesh runner, sources, build output and caches live in the host's
# /workspace, which anycloud binds into the Job; images and containers'
# layers live in the image stores. Each timed step prints `BENCH <build>
# <command> <ms>`. A failed build prints `BENCH_FAIL <build>` and the next
# build still runs.
set -eu
# coreutils' date, for nanoseconds.
apk add --no-cache -q coreutils git >/dev/null

# `host <script>`: runs the script in the host's mount namespace.
host() { docker run --rm --privileged --pid=host alpine:3.20 nsenter -t 1 -m -- sh -c "$1"; }
# Before each disk-heavy step, so it reads from the disk, not the page cache.
drop_caches() { host 'sync && echo 3 > /proc/sys/vm/drop_caches'; }

# `step <build> <command> <command line...>`: times a command run here.
step() {
  label="$1 $2"; shift 2
  start=$(date +%s%N)
  if "$@" >/tmp/out 2>&1; then
    echo "BENCH $label $((($(date +%s%N) - start) / 1000000))"
  else
    tail -40 /tmp/out; echo "BENCH_FAIL $label"; return 1
  fi
}

# `DISK <path> <source> <fstype>`.
host '
  for p in / /workspace /var/lib/containerd; do
    echo "DISK $p $(findmnt -no SOURCE,FSTYPE --target $p | head -n 1)"
  done
  lsblk -dno NAME,MODEL,SIZE | sed "s/^/LSBLK /"
  lscpu | sed -n "s/^Model name:/LSCPU Model name:/p"'

# The toolchains' pulls, timed together: the image stores take the writes.
step pull toolchain-images sh -c 'docker pull -q rust:1.83-bookworm && docker pull -q node:22-bookworm'

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
step docker build docker build -q -t local-nvme-k6 /workspace/k6 || :

build rust rust:1.83-bookworm '
  clone BurntSushi/ripgrep 14.1.1
  cargo fetch --locked -q
  timed build cargo build --release --locked'

build typescript node:22-bookworm '
  clone microsoft/TypeScript v5.6.3
  timed install npm ci --no-audit --no-fund
  timed build npx hereby local'

# A CUDA image of about 15 GB: the base's pull (4.5 GB compressed, 18
# layers), a build that installs PyTorch's CUDA wheels (2.5 GB), then a save
# to /workspace and a load of it after the image is gone, as a CI cache of
# images would. The base is pinned by digest; torch pins its NVIDIA wheels,
# and the rest of its dependencies are pinned here.
cuda=nvidia/cuda:12.4.1-cudnn-devel-ubuntu22.04@sha256:622e78a1d02c0f90ed900e3985d6c975d8e2dc9ee5e61643aed587dcf9129f42
mkdir -p /workspace/ml
cat >/workspace/ml/Dockerfile <<EOF
FROM $cuda
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3-pip && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir torch==2.5.1 triton==3.1.0 filelock==3.16.1 typing-extensions==4.12.2 sympy==1.13.1 mpmath==1.3.0 networkx==3.4.2 jinja2==3.1.4 MarkupSafe==3.0.2 fsspec==2024.10.0
EOF
{
  step ml pull docker pull -q "$cuda" &&
    step ml build docker build -q -t local-nvme-ml /workspace/ml &&
    echo "IMAGE_BYTES $(docker image inspect -f '{{.Size}}' local-nvme-ml)" &&
    drop_caches && step ml save docker save -o /workspace/ml.tar local-nvme-ml &&
    docker rmi -f local-nvme-ml $(docker images -q nvidia/cuda) >/dev/null && docker builder prune -af >/dev/null &&
    drop_caches && step ml load docker load -q -i /workspace/ml.tar
} || echo "BENCH_FAIL ml"
rm -f /workspace/ml.tar

# A restored and saved cache: 100 copies of 4,000 random files of 1 to 33
# KiB, 400,000 files and 6.5 GiB in all, as one uncompressed tarball
# (concatenated archives, hence -i), untimed; then its extraction into
# /workspace and its archive back, each until synced. Uncompressed, the
# steps wait on the disk rather than on zstd.
build cache node:22-bookworm '
  RANDOM=1
  for d in $(seq 40); do mkdir -p /workspace/seed/d/$d; done
  for i in $(seq 4000); do head -c $((1024 + RANDOM % 32768)) /dev/urandom >/workspace/seed/d/$((i % 40 + 1))/$i; done
  for c in $(seq 100); do tar -C /workspace/seed -cf - --transform "s,^d,$c," d; done >/workspace/cache.tar'
drop_caches
build cache node:22-bookworm '
  mkdir /workspace/cache
  timed restore bash -c "tar -xif /workspace/cache.tar -C /workspace/cache && sync"'
drop_caches
build cache node:22-bookworm '
  timed save bash -c "tar -cf /workspace/cache-out.tar -C /workspace/cache . && sync"'

echo BENCH_DONE
