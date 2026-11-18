#!/usr/bin/env bash
# Exercise containerd's same-layer multipart fetch on a disposable VM and prove
# that an image pulled through the transfer service is consumable by Docker.
#
# This is intentionally a host-level experiment, not a production installer. It
# starts isolated containerd and Docker daemons with private state directories,
# leaving the daemons serving the test workload untouched. Unsupported runtimes
# emit a machine-readable verdict and exit 42 so a product caller can use its
# ordinary Docker pull without guessing from the cloud or GPU model.
set -euo pipefail

emit() { printf 'PARALLEL_PULL %s\n' "$*"; }

version_at_least() {
  local actual=${1#v} required=${2#v}
  actual=${actual%%[-+]*}
  required=${required%%[-+]*}
  local actual_major actual_minor actual_patch required_major required_minor required_patch
  IFS=. read -r actual_major actual_minor actual_patch <<< "$actual"
  IFS=. read -r required_major required_minor required_patch <<< "$required"
  [[ ${actual_major:-} =~ ^[0-9]+$ && ${actual_minor:-} =~ ^[0-9]+$ && ${actual_patch:-0} =~ ^[0-9]+$ ]] || return 1
  [[ ${required_major:-} =~ ^[0-9]+$ && ${required_minor:-} =~ ^[0-9]+$ && ${required_patch:-0} =~ ^[0-9]+$ ]] || return 1
  (( actual_major > required_major )) ||
    { (( actual_major == required_major )) && (( actual_minor > required_minor )); } ||
    { (( actual_major == required_major )) && (( actual_minor == required_minor )) && (( ${actual_patch:-0} >= ${required_patch:-0} )); }
}

baseline_cache_marker_count() {
  local count
  count=$(grep -Eic '(^|:[[:space:]])Already exists([[:space:]]|$)|(^|[[:space:]])Image is up to date([[:space:]]|$)' || true)
  printf '%s\n' "${count:-0}"
}

self_test() {
  version_at_least v2.2.4 2.1.0 || return 1
  version_at_least 2.1.0 2.1.0 || return 1
  version_at_least 3.0.0-rc.1 2.1.0 || return 1
  ! version_at_least 1.7.27 2.1.0 || return 1
  ! version_at_least 2.0.9 2.1.0 || return 1
  ! version_at_least unknown 2.1.0 || return 1
  [[ $(printf '%s\n' 'a: Pulling fs layer' 'a: Pull complete' | baseline_cache_marker_count) == 0 ]] || return 1
  [[ $(printf '%s\n' 'a: Already exists' 'Status: Image is up to date for example.test/image@sha256:deadbeef' | baseline_cache_marker_count) == 2 ]] || return 1
  emit 'self_test PASS legacy_containerd_1_7=fallback containerd_2_2=parallel cold_baseline=accepted cached_baseline=rejected'
}

if [[ ${1:-} == --self-test ]]; then
  self_test
  exit
fi

IMAGE_REF=${1:?usage: probe-containerd-parallel-pull.sh <digest-pinned-image> [compressed-layer-bytes] [concurrency] [chunk-bytes] [measure-baseline-0-or-1]}
IMAGE_BYTES=${2:-0}
# Three lanes avoided repeat GHCR cancellations seen with four on live Azure
# pulls. 128 MiB ranges cap the working buffer near 384 MiB.
CONCURRENCY=${3:-3}
CHUNK_BYTES=${4:-134217728}
# Opt-in: also time an ordinary single-stream `docker pull` of the same image so
# one run yields the real transfer-vs-default delta. Off by default because it
# re-downloads the whole image and roughly doubles runtime.
MEASURE_BASELINE=${5:-0}
SNAPSHOTTER=${PROBE_SNAPSHOTTER:-overlayfs}

PINNED_REF_RE='^([a-z0-9.-]+(:[0-9]+)?/)?[a-z0-9._/-]+(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[a-f0-9]{64}$'
[[ $IMAGE_REF =~ $PINNED_REF_RE ]] || { emit "error invalid_image_ref=$IMAGE_REF"; exit 2; }
[[ $IMAGE_BYTES =~ ^[0-9]+$ ]] || { emit "error invalid_image_bytes=$IMAGE_BYTES"; exit 2; }
[[ $CONCURRENCY =~ ^[1-9][0-9]*$ ]] || { emit "error invalid_concurrency=$CONCURRENCY"; exit 2; }
[[ $CHUNK_BYTES =~ ^[1-9][0-9]*$ ]] || { emit "error invalid_chunk_bytes=$CHUNK_BYTES"; exit 2; }
[[ $MEASURE_BASELINE =~ ^[01]$ ]] || { emit "error invalid_measure_baseline=$MEASURE_BASELINE"; exit 2; }
[[ $SNAPSHOTTER =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] || { emit "error invalid_snapshotter=$SNAPSHOTTER"; exit 2; }

# The Azure dstack image normally logs in as root, but keep the probe portable
# to images whose configured SSH user has passwordless sudo.
if [[ $(id -u) -ne 0 ]]; then
  exec sudo -n env "PROBE_SNAPSHOTTER=$SNAPSHOTTER" bash "$0" "$IMAGE_REF" "$IMAGE_BYTES" "$CONCURRENCY" "$CHUNK_BYTES" "$MEASURE_BASELINE"
fi

for command in containerd ctr docker dockerd ss; do
  if ! command -v "$command" >/dev/null 2>&1; then
    emit "verdict UNSUPPORTED reason=missing_${command} fallback=ordinary_pull"
    exit 42
  fi
done

CONTAINERD_VERSION=$(containerd --version 2>/dev/null | awk '{print $3}')
DOCKER_VERSION=$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)
CTR_VERSION=$(ctr --version 2>/dev/null | awk '{print $3}' || true)
DOCKER_DRIVER=$(docker info --format '{{.Driver}}' 2>/dev/null || true)
emit "fingerprint containerd=${CONTAINERD_VERSION:-NA} ctr=${CTR_VERSION:-NA} docker=${DOCKER_VERSION:-NA} driver=${DOCKER_DRIVER:-NA}"

if ! version_at_least "${CONTAINERD_VERSION:-unknown}" 2.1.0; then
  emit "verdict UNSUPPORTED reason=containerd_${CONTAINERD_VERSION:-unknown}_lt_2.1 fallback=ordinary_pull"
  exit 42
fi

PROBE_STATE=$(mktemp -d /run/anycloud-parallel-pull.XXXXXX)
PROBE_DATA=$(mktemp -d /var/lib/anycloud-parallel-pull.XXXXXX)
CONTAINERD_CONFIG="$PROBE_STATE/containerd.toml"
CONTAINERD_SOCKET="$PROBE_STATE/containerd.sock"
CONTAINERD_ROOT="$PROBE_DATA/containerd"
CONTAINERD_STATE="$PROBE_STATE/containerd-state"
CONTAINERD_LOG="$PROBE_STATE/containerd.log"
DOCKER_CONFIG="$PROBE_STATE/docker.json"
DOCKER_SOCKET="$PROBE_STATE/docker.sock"
DOCKER_ROOT="$PROBE_DATA/docker"
DOCKER_EXEC="$PROBE_STATE/docker-exec"
DOCKER_PID_FILE="$PROBE_STATE/docker.pid"
DOCKER_LOG="$PROBE_STATE/dockerd.log"
NAMESPACE=anycloud-probe
CONTAINERD_PID=
DOCKER_PID=
PULL_LOG=
PEAK_FILE=
PROBE_STARTED_EPOCH=$(date +%s)

redact_diagnostics() {
  sed -E \
    -e 's/(Authorization:[[:space:]]*[Bb]earer[[:space:]]+)[^[:space:]]+/\1<REDACTED>/g' \
    -e 's/([?&](token|sig)=)[^&[:space:]]+/\1<REDACTED>/g'
}

diagnostic_file() {
  local label=$1 file=$2
  emit "diagnostics section=${label} BEGIN"
  if [[ -s $file ]]; then
    {
      printf '%s\n' "----- ${label}: warnings and errors -----"
      grep -Eia 'error|warn|fail|cancel|timeout|killed|oom|no space|unavailable|reset|broken pipe' "$file" | tail -400 || true
      printf '%s\n' "----- ${label}: final 1200 lines -----"
      tail -1200 "$file" || true
    } | redact_diagnostics
  else
    printf '%s\n' "${label}: unavailable or empty (${file})"
  fi
  emit "diagnostics section=${label} END"
}

emit_failure_diagnostics() {
  local exit_code=$1
  emit "diagnostics BEGIN exit_code=${exit_code} state_dir=${PROBE_STATE} data_dir=${PROBE_DATA}"

  emit 'diagnostics section=resources BEGIN'
  {
    date --iso-8601=ns 2>/dev/null || date
    uname -a
    uptime
    printf '%s\n' '----- memory -----'
    free -h
    printf '%s\n' '----- filesystems -----'
    df -h / /run /var/lib 2>&1
    printf '%s\n' '----- probe storage -----'
    du -sh "$PROBE_STATE" "$PROBE_DATA" 2>&1
    printf '%s\n' '----- largest processes -----'
    ps -eo pid,ppid,state,etimes,rss,vsz,cmd --sort=-rss | head -60
    printf '%s\n' '----- established registry connections -----'
    ss -Htnp state established 2>&1 | tail -200
    printf '%s\n' '----- containerd content -----'
    ctr --address "$CONTAINERD_SOCKET" --namespace "$NAMESPACE" content ls 2>&1 | tail -200
    printf '%s\n' '----- containerd images -----'
    ctr --address "$CONTAINERD_SOCKET" --namespace "$NAMESPACE" images ls 2>&1 | tail -100
  } | redact_diagnostics
  emit 'diagnostics section=resources END'

  emit 'diagnostics section=kernel BEGIN'
  {
    journalctl -k --since "@${PROBE_STARTED_EPOCH}" --no-pager -n 500 2>&1 || true
    printf '%s\n' '----- dmesg tail -----'
    dmesg --ctime 2>&1 | tail -500 || true
  } | redact_diagnostics
  emit 'diagnostics section=kernel END'

  [[ -z $PULL_LOG ]] || diagnostic_file ctr-pull "$PULL_LOG"
  diagnostic_file containerd "$CONTAINERD_LOG"
  diagnostic_file dockerd "$DOCKER_LOG"
  emit "diagnostics END exit_code=${exit_code}"
}

stop_process() {
  local pid=${1:-}
  [[ $pid =~ ^[0-9]+$ ]] || return 0
  kill -TERM "$pid" 2>/dev/null || return 0
  for _ in $(seq 1 100); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  local exit_code=$?
  trap - EXIT
  set +e
  if [[ $exit_code -ne 0 ]]; then
    emit_failure_diagnostics "$exit_code"
  fi
  stop_process "$DOCKER_PID"
  stop_process "$CONTAINERD_PID"
  if { [[ -z $DOCKER_PID ]] || ! kill -0 "$DOCKER_PID" 2>/dev/null; } &&
     { [[ -z $CONTAINERD_PID ]] || ! kill -0 "$CONTAINERD_PID" 2>/dev/null; }; then
    emit 'cleanup PASS isolated_dockerd=stopped isolated_containerd=stopped'
  else
    emit 'cleanup FAIL'
    [[ $exit_code -ne 0 ]] || exit_code=1
  fi
  exit "$exit_code"
}
trap cleanup EXIT

# A minimal isolated daemon avoids mutating /etc/containerd/config.toml or
# restarting the system containerd. Debug logs expose the effective multipart
# resolver settings used for each layer.
printf '%s\n' \
  'version = 2' \
  'disabled_plugins = ["io.containerd.nri.v1.nri", "io.containerd.cri.v1.images", "io.containerd.cri.v1.runtime", "io.containerd.grpc.v1.cri"]' \
  "root = \"$CONTAINERD_ROOT\"" \
  "state = \"$CONTAINERD_STATE\"" \
  '' \
  '[grpc]' \
  "  address = \"$CONTAINERD_SOCKET\"" \
  '' \
  '[debug]' \
  '  level = "debug"' \
  '' \
  '[plugins."io.containerd.transfer.v1.local"]' \
  "  max_concurrent_downloads = $CONCURRENCY" \
  "  concurrent_layer_fetch_buffer = $CHUNK_BYTES" \
  > "$CONTAINERD_CONFIG"

containerd --config "$CONTAINERD_CONFIG" > "$CONTAINERD_LOG" 2>&1 &
CONTAINERD_PID=$!
for _ in $(seq 1 300); do
  ctr --address "$CONTAINERD_SOCKET" version >/dev/null 2>&1 && break
  kill -0 "$CONTAINERD_PID" 2>/dev/null || break
  sleep 0.1
done
if ! ctr --address "$CONTAINERD_SOCKET" version >/dev/null 2>&1; then
  emit 'error isolated_containerd_start_failed'
  tail -120 "$CONTAINERD_LOG" || true
  exit 1
fi
PLUGIN_LIST=$(ctr --address "$CONTAINERD_SOCKET" plugins ls 2>/dev/null || true)
if ! awk '$1 == "io.containerd.transfer.v1" && $2 == "local" && $NF == "ok" { found=1 } END { exit !found }' <<< "$PLUGIN_LIST"; then
  emit 'verdict UNSUPPORTED reason=transfer_plugin_unavailable fallback=ordinary_pull'
  printf '%s\n' "$PLUGIN_LIST" | tail -80 || true
  tail -120 "$CONTAINERD_LOG" || true
  exit 42
fi

# Docker 27's built-in pull client cannot pass concurrent_layer_fetch_buffer.
# An isolated daemon with the containerd image store proves that an explicit
# transfer-service pull into Docker's namespace is visible to Docker itself.
printf '%s\n' \
  '{' \
  '  "features": {' \
  '    "containerd-snapshotter": true' \
  '  }' \
  '}' \
  > "$DOCKER_CONFIG"

dockerd \
  --config-file "$DOCKER_CONFIG" \
  --host "unix://$DOCKER_SOCKET" \
  --data-root "$DOCKER_ROOT" \
  --exec-root "$DOCKER_EXEC" \
  --pidfile "$DOCKER_PID_FILE" \
  --containerd "$CONTAINERD_SOCKET" \
  --containerd-namespace "$NAMESPACE" \
  --containerd-plugins-namespace "${NAMESPACE}-plugins" \
  --storage-driver "$SNAPSHOTTER" \
  --bridge=none \
  --iptables=false \
  --ip-forward=false \
  --ip-masq=false \
  --userland-proxy=false \
  > "$DOCKER_LOG" 2>&1 &
DOCKER_PID=$!
for _ in $(seq 1 600); do
  docker --host "unix://$DOCKER_SOCKET" info >/dev/null 2>&1 && break
  kill -0 "$DOCKER_PID" 2>/dev/null || break
  sleep 0.1
done
if ! docker --host "unix://$DOCKER_SOCKET" info >/dev/null 2>&1; then
  emit 'error isolated_dockerd_start_failed'
  tail -160 "$DOCKER_LOG" || true
  exit 1
fi

DRIVER_STATUS=$(docker --host "unix://$DOCKER_SOCKET" info --format '{{json .DriverStatus}}' 2>/dev/null || true)
DOCKER_DRIVER=$(docker --host "unix://$DOCKER_SOCKET" info --format '{{.Driver}}' 2>/dev/null || true)
emit "config concurrency=$CONCURRENCY chunk_bytes=$CHUNK_BYTES docker_driver=${DOCKER_DRIVER:-NA} driver_status=${DRIVER_STATUS:-null} isolation=enabled"
if ! grep -q 'io.containerd.snapshotter.v1' <<< "$DRIVER_STATUS"; then
  emit 'error docker_containerd_image_store_inactive'
  exit 1
fi

ctr --address "$CONTAINERD_SOCKET" --namespace "$NAMESPACE" images remove "$IMAGE_REF" >/dev/null 2>&1 || true

PULL_LOG=$(mktemp /tmp/anycloud-ctr-pull.XXXXXX)
PEAK_FILE=$(mktemp /tmp/anycloud-ctr-peak.XXXXXX)
printf '0\n' > "$PEAK_FILE"
timestamp_ns() {
  local value seconds fraction
  value=${EPOCHREALTIME:-}
  if [[ $value =~ ^([0-9]+)\.([0-9]+)$ ]]; then
    seconds=${BASH_REMATCH[1]}
    fraction=${BASH_REMATCH[2]}000000000
    printf '%s%s\n' "$seconds" "${fraction:0:9}"
    return
  fi
  value=$(date +%s%N)
  if [[ $value =~ ^[0-9]{10,}$ ]]; then
    printf '%s\n' "$value"
  else
    printf '%s000000000\n' "$(date +%s)"
  fi
}
START_NS=$(timestamp_ns)

( ctr --address "$CONTAINERD_SOCKET" --namespace "$NAMESPACE" images pull --snapshotter "$SNAPSHOTTER" "$IMAGE_REF" > "$PULL_LOG" 2>&1 ) &
PULL_PID=$!
(
  peak=0
  ticks=0
  while kill -0 "$PULL_PID" 2>/dev/null; do
    current=$(ss -Htnp state established 2>/dev/null | awk -v pid="$CONTAINERD_PID" \
      '/:443[[:space:]]/ && index($0, "pid=" pid ",") {count++} END {print count+0}')
    if (( current > peak )); then
      peak=$current
      printf '%s\n' "$peak" > "$PEAK_FILE"
      emit "connections current=$current peak=$peak"
    fi
    ticks=$((ticks + 1))
    if (( ticks % 75 == 0 )); then
      emit "heartbeat pull_pid=$PULL_PID peak_connections=$peak"
    fi
    sleep 0.2
  done
) &
SAMPLER_PID=$!

set +e
wait "$PULL_PID"
PULL_RC=$?
set -e
wait "$SAMPLER_PID" || true
END_NS=$(timestamp_ns)

if [[ $PULL_RC -ne 0 ]]; then
  emit "error ctr_pull_failed exit_code=$PULL_RC"
  exit "$PULL_RC"
fi

FETCH_LOGS=$(grep 'fetching layer' "$CONTAINERD_LOG" || true)
if ! grep -Eq "parallelism=$CONCURRENCY([[:space:]]|$)" <<< "$FETCH_LOGS" ||
   ! grep -Eq "chunk_size=$CHUNK_BYTES([[:space:]]|$)" <<< "$FETCH_LOGS"; then
  emit 'error multipart_fetch_log_not_observed'
  printf '%s\n' "$FETCH_LOGS" | tail -40 || true
  exit 1
fi

ELAPSED_MS=$(( (END_NS - START_NS) / 1000000 ))
PEAK_CONNECTIONS=$(cat "$PEAK_FILE")
THROUGHPUT_MIB_S=NA
if [[ $IMAGE_BYTES -gt 0 && $ELAPSED_MS -gt 0 ]]; then
  THROUGHPUT_MIB_S=$(awk -v bytes="$IMAGE_BYTES" -v ms="$ELAPSED_MS" 'BEGIN { printf "%.2f", (bytes / 1048576) / (ms / 1000) }')
fi

if ! DOCKER_INSPECT_OUT=$(docker --host "unix://$DOCKER_SOCKET" image inspect "$IMAGE_REF" 2>&1); then
  emit 'error docker_image_inspect_failed'
  printf '%s\n' "$DOCKER_INSPECT_OUT" | redact_diagnostics
  exit 1
fi
PROBE_CONTAINER="ac-parallel-pull-${RANDOM}"
if ! DOCKER_CREATE_OUT=$(docker --host "unix://$DOCKER_SOCKET" create --name "$PROBE_CONTAINER" --entrypoint /bin/true "$IMAGE_REF" 2>&1); then
  emit 'error docker_container_create_failed'
  printf '%s\n' "$DOCKER_CREATE_OUT" | redact_diagnostics
  exit 1
fi
if ! DOCKER_REMOVE_OUT=$(docker --host "unix://$DOCKER_SOCKET" rm "$PROBE_CONTAINER" 2>&1); then
  emit 'error docker_container_remove_failed'
  printf '%s\n' "$DOCKER_REMOVE_OUT" | redact_diagnostics
  exit 1
fi

if [[ $PEAK_CONNECTIONS -lt 2 ]]; then
  emit "error multipart_not_observed peak_connections=$PEAK_CONNECTIONS"
  exit 1
fi

emit "pull elapsed_ms=$ELAPSED_MS compressed_layer_bytes=$IMAGE_BYTES mib_per_second=$THROUGHPUT_MIB_S peak_connections=$PEAK_CONNECTIONS"
emit "multipart_log PASS parallelism=$CONCURRENCY chunk_bytes=$CHUNK_BYTES"
emit "docker_visibility PASS inspect=ok create=ok namespace=$NAMESPACE snapshotter=$SNAPSHOTTER isolation=enabled"
emit 'verdict SUPPORTED fallback=not_needed'

# Optional single-stream baseline: time the ordinary host `docker pull` this
# transfer path would replace, so one run yields the real delta. Best-effort --
# a failure here never fails the probe. The transfer pull above already warmed
# the registry CDN, so this baseline is if anything optimistic; it understates,
# never inflates, the transfer's advantage. Refuse a throughput result if Docker
# reused host-cached layers: the numerator is the full compressed image size, so
# timing only the missing layers would overstate the baseline.
if [[ $MEASURE_BASELINE == 1 ]]; then
  HOST_DRIVER=$(docker info --format '{{.Driver}}' 2>/dev/null || echo NA)
  docker image rm -f "$IMAGE_REF" >/dev/null 2>&1 || true
  BASELINE_LOG="$PROBE_STATE/host-docker-pull.log"
  BASE_START_NS=$(timestamp_ns)
  if LC_ALL=C docker pull "$IMAGE_REF" > "$BASELINE_LOG" 2>&1; then
    BASE_END_NS=$(timestamp_ns)
    BASE_MS=$(( (BASE_END_NS - BASE_START_NS) / 1000000 ))
    BASE_CACHE_MARKERS=$(baseline_cache_marker_count < "$BASELINE_LOG")
    if [[ $BASE_CACHE_MARKERS -gt 0 ]]; then
      emit "baseline mode=host_docker_pull elapsed_ms=$BASE_MS error=cached_layers cached_markers=$BASE_CACHE_MARKERS driver=${HOST_DRIVER:-NA}"
      tail -n 40 "$BASELINE_LOG" 2>/dev/null | redact_diagnostics || true
    else
      BASE_MIB_S=NA
      if [[ $IMAGE_BYTES -gt 0 && $BASE_MS -gt 0 ]]; then
        BASE_MIB_S=$(awk -v bytes="$IMAGE_BYTES" -v ms="$BASE_MS" 'BEGIN { printf "%.2f", (bytes / 1048576) / (ms / 1000) }')
      fi
      emit "baseline mode=host_docker_pull elapsed_ms=$BASE_MS compressed_layer_bytes=$IMAGE_BYTES mib_per_second=$BASE_MIB_S driver=${HOST_DRIVER:-NA}"
    fi
  else
    emit "baseline mode=host_docker_pull error=pull_failed driver=${HOST_DRIVER:-NA}"
    tail -n 40 "$BASELINE_LOG" 2>/dev/null | redact_diagnostics || true
  fi
  docker image rm -f "$IMAGE_REF" >/dev/null 2>&1 || true
fi
