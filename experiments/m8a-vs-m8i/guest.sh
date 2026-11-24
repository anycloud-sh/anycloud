#!/bin/sh
# The Job's process, in docker:27-cli with the host's Docker socket: the CPU
# facts, sysbench, then backmesh's five benchmark builds (benchmarks/builds/
# bench.yml in backmesh/backmesh), each in its toolchain's official image.
# The toolchain images' pulls are timed as one. Clones and dependency fetches
# that the benchmark's commands don't include are untimed. Each timed step
# prints `BENCH <build> <command> <ms>`. A failed build prints
# `BENCH_FAIL <build>` and the next build still runs.
set -eu
# `MARK <name> <seconds since the host booted>`, for where the time goes.
mark() { echo "MARK $1 $(cut -d' ' -f1 /proc/uptime)"; }
mark guest-start
apk add --no-cache -q bash coreutils git >/dev/null

# The toolchains' pulls, timed together: the host's Docker writes them to the
# root disk.
start=$(date +%s%N)
for image in ubuntu:24.04 rust:1.83-bookworm golang:1.22.6-bookworm \
  node:22-bookworm python:3.12-bookworm; do
  docker pull -q "$image" >/dev/null
done
echo "BENCH pull toolchain-images $((($(date +%s%N) - start) / 1000000))"
mark images-pulled
# The images' digests, so a later run can tell whether they changed.
for image in docker:27-cli ubuntu:24.04 rust:1.83-bookworm \
  golang:1.22.6-bookworm node:22-bookworm python:3.12-bookworm; do
  docker image inspect -f "IMAGE $image {{index .RepoDigests 0}}" "$image" ||
    true
done

# `build <name> <image> <bash script>`: runs the script in a new container of
# the image; the script times its commands with `timed <label> <command...>`.
build() {
  docker run --rm -e BUILD="$1" "$2" bash -c '
    set -eu
    timed() {
      label=$1; shift
      start=$(date +%s%N)
      if ! "$@" >/tmp/out 2>&1; then
        tail -40 /tmp/out; echo "BENCH_FAIL $BUILD $label"; exit 1
      fi
      echo "BENCH $BUILD $label $(( ($(date +%s%N) - start) / 1000000 ))"
    }
    clone() { git clone -q --depth 1 -b "$2" "https://github.com/$1" /p 2>/dev/null; cd /p; }
    '"$3" || echo "BENCH_FAIL $1"
}

docker run --rm ubuntu:24.04 bash -c '
  lscpu | sed "s/^/LSCPU /"
  apt-get update -qq && apt-get install -y -qq sysbench >/dev/null 2>&1
  for threads in 1 $(nproc); do
    eps=$(sysbench cpu --threads=$threads --time=10 run | awk "/events per second/ {print \$4}")
    echo "SYSBENCH $threads $eps"
  done'

mark sysbench-done

# docker: the job container is the client, as on a runner.
git clone -q --depth 1 -b v0.54.0 https://github.com/grafana/k6 /k6 2>/dev/null
start=$(date +%s%N)
if (cd /k6 && docker build -q -t m8-bench-k6 . >/tmp/out 2>&1); then
  echo "BENCH docker build $((($(date +%s%N) - start) / 1000000))"
else
  tail -40 /tmp/out
  echo "BENCH_FAIL docker"
fi

build rust rust:1.83-bookworm '
  clone BurntSushi/ripgrep 14.1.1
  cargo fetch --locked -q
  timed build cargo build --release --locked'

build go golang:1.22.6-bookworm '
  clone cli/cli v2.62.0
  go mod download
  timed build go build ./...
  timed test go test ./pkg/cmd/pr/...'

build typescript node:22-bookworm '
  clone microsoft/TypeScript v5.6.3
  timed install npm ci --no-audit --no-fund
  timed build npx hereby local'

build python python:3.12-bookworm '
  pip install -q --root-user-action=ignore uv==0.13.9
  clone pydantic/pydantic v2.11.7
  export UV_PYTHON_PREFERENCE=only-system
  timed install uv sync --frozen
  timed test uv run --frozen pytest -q -p no:cacheprovider tests/test_main.py tests/test_types.py tests/test_json_schema.py'

mark builds-done
echo BENCH_DONE
