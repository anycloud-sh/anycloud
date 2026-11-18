#!/bin/bash

# Docker launch boundary. Typed helpers own observations, polling and assertions.
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"
source "$SCRIPT_DIR/helpers/common.sh"
export E2E_API_PROCESS_MEMBER=api-image
export RESULTS_DIR="${RESULTS_DIR:-/tmp/e2e-results-api-image-$$}"
mkdir -p "$RESULTS_DIR"

api_probe() {
    yarn -s tsx test/integration/helpers/api-process.ts "$@"
}

API_PORT=8787
API_URL="http://localhost:$API_PORT"
IMAGE_NAME="anycloud-api-test"
CONTAINER_NAME="api-test-$$"
DURABLE_CONTAINER="api-durable-$$"
TEMP_DB_DIR=$(mktemp -d)
STATE_DIR=$(mktemp -d)
# A local API boots only with the per-install token `api start` would write.
TOKEN_DIR=$(mktemp -d)
ensure_local_api_token "$TOKEN_DIR"
ensure_local_api_token "$STATE_DIR"
DB_PATH="$TEMP_DB_DIR/api.db"
SSH_RUNTIME_TMPFS=/run/anycloud-ssh:rw,noexec,nosuid,nodev,size=1m,mode=0700
CIPHER_KEY_TEST=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

cleanup() {
    local original_exit=$?
    trap - EXIT
    set +e
    local cleanup_failed=0
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
    docker rm -f "$CONTAINER_NAME" "api-heap-$$" "api-heap-override-$$" "api-heap-default-$$" "$DURABLE_CONTAINER" >/dev/null 2>&1 || true
    api_probe containers-absent || cleanup_failed=1
    kill_port "$API_PORT"
    if [ "$cleanup_failed" -eq 0 ]; then
        rm -rf "$TEMP_DB_DIR" || cleanup_failed=1
        cleanup_anycloud_dir "$STATE_DIR" || cleanup_failed=1
        cleanup_anycloud_dir "$TOKEN_DIR" || cleanup_failed=1
    fi
    if [ "$cleanup_failed" -ne 0 ]; then
        print_error "API image cleanup remains incomplete; retained state: $TEMP_DB_DIR $STATE_DIR $TOKEN_DIR"
        [ "$original_exit" -ne 0 ] || original_exit=1
    fi
    api_probe launcher-finished "$cleanup_failed" || { [ "$original_exit" -ne 0 ] || original_exit=1; }
    exit "$original_exit"
}
trap cleanup EXIT
api_probe register-owned "$CONTAINER_NAME" "api-heap-$$" "api-heap-override-$$" "api-heap-default-$$" "$DURABLE_CONTAINER"
kill_port "$API_PORT"

print_section "Building the production Docker image"
retry_cmd 3 15 docker build -t "$IMAGE_NAME" -f "$PROJECT_ROOT/Dockerfile" "$PROJECT_ROOT"
api_probe image-metadata "$IMAGE_NAME"

print_section "OpenSSH tooling, private tmpfs and PID 1 reaper"
docker run --rm "$IMAGE_NAME" sh -c '
    command -v ssh >/dev/null && command -v ssh-keygen >/dev/null &&
    ssh-keygen -q -t ed25519 -N "" -f /tmp/identity &&
    ssh-keygen -y -f /tmp/identity >/dev/null
'
docker run --rm --tmpfs "$SSH_RUNTIME_TMPFS" -e CIPHER_KEY="$CIPHER_KEY_TEST" \
    -v "$PROJECT_ROOT/test/integration/fixtures/api-image-ssh.ts:/fixture/api-image-ssh.ts:ro" \
    "$IMAGE_NAME" node --experimental-strip-types /fixture/api-image-ssh.ts tmpfs
docker run --rm -e CIPHER_KEY="$CIPHER_KEY_TEST" \
    -v "$PROJECT_ROOT/test/integration/fixtures/api-image-ssh.ts:/fixture/api-image-ssh.ts:ro" \
    "$IMAGE_NAME" node --experimental-strip-types /fixture/api-image-ssh.ts missing

# Match Kubernetes emptyDir's initial permissions, then the chart init step.
docker run --rm --tmpfs /run/anycloud-ssh:rw,noexec,nosuid,nodev,size=1m,mode=0777 \
    -e CIPHER_KEY="$CIPHER_KEY_TEST" \
    -v "$PROJECT_ROOT/test/integration/fixtures/api-image-ssh.ts:/fixture/api-image-ssh.ts:ro" \
    "$IMAGE_NAME" node --experimental-strip-types /fixture/api-image-ssh.ts permissive-tmpfs

print_section "NODE_OPTIONS and graceful shutdown"
HEAP_CONTAINER="api-heap-$$"
docker run -d --name "$HEAP_CONTAINER" -m 2g \
    -v "$TOKEN_DIR:/root/.anycloud" \
    -e PORT=8080 -e CIPHER_KEY="$CIPHER_KEY_TEST" -e SQLITE_PATH=/tmp/api.db "$IMAGE_NAME" >/dev/null
api_probe container-health "$HEAP_CONTAINER"
api_probe after-running "$HEAP_CONTAINER"
api_probe node-options "$HEAP_CONTAINER"
docker stop -t 15 "$HEAP_CONTAINER" >/dev/null
api_probe graceful-stop "$HEAP_CONTAINER"
docker rm -f "$HEAP_CONTAINER" >/dev/null

OVERRIDE_CONTAINER="api-heap-override-$$"
docker run -d --name "$OVERRIDE_CONTAINER" \
    -e NODE_OPTIONS=--max-old-space-size=512 \
    -v "$TOKEN_DIR:/root/.anycloud" \
    -e PORT=8080 -e CIPHER_KEY="$CIPHER_KEY_TEST" -e SQLITE_PATH=/tmp/api.db "$IMAGE_NAME" >/dev/null
api_probe container-health "$OVERRIDE_CONTAINER"
api_probe node-options "$OVERRIDE_CONTAINER" --max-old-space-size=512
docker rm -f "$OVERRIDE_CONTAINER" >/dev/null

DEFAULT_CONTAINER="api-heap-default-$$"
docker run -d --name "$DEFAULT_CONTAINER" \
    -v "$TOKEN_DIR:/root/.anycloud" \
    -e PORT=8080 -e CIPHER_KEY="$CIPHER_KEY_TEST" -e SQLITE_PATH=/tmp/api.db "$IMAGE_NAME" >/dev/null
api_probe container-health "$DEFAULT_CONTAINER"
api_probe node-options "$DEFAULT_CONTAINER"
docker rm -f "$DEFAULT_CONTAINER" >/dev/null

print_section "Durable database and cipher key across container replacement"
docker run -d --name "$DURABLE_CONTAINER" -p "$API_PORT:8080" \
    -v "$STATE_DIR:/root/.anycloud" -e PORT=8080 -e IS_TEST=true "$IMAGE_NAME" >/dev/null
api_probe durable-seed "$DURABLE_CONTAINER" "$API_URL" "$TEMP_DB_DIR/durable.json" "$STATE_DIR"
docker rm -f "$DURABLE_CONTAINER" >/dev/null
docker run -d --name "$DURABLE_CONTAINER" -p "$API_PORT:8080" \
    -v "$STATE_DIR:/root/.anycloud" -e PORT=8080 -e IS_TEST=true "$IMAGE_NAME" >/dev/null
api_probe durable-restored "$DURABLE_CONTAINER" "$API_URL" "$TEMP_DB_DIR/durable.json" "$STATE_DIR"
docker rm -f "$DURABLE_CONTAINER" >/dev/null

print_section "File-backed API, runtime artifacts and shutdown"
touch "$DB_PATH"
docker run -d --name "$CONTAINER_NAME" -p "$API_PORT:8080" \
    -v "$TEMP_DB_DIR:/data" -v "$TOKEN_DIR:/root/.anycloud" -e PORT=8080 -e SQLITE_PATH=/data/api.db \
    -e CIPHER_KEY="$CIPHER_KEY_TEST" "$IMAGE_NAME" >/dev/null
api_probe health "$API_URL"
api_probe image-runtime "$CONTAINER_NAME" "$DB_PATH" "$API_URL"
docker stop "$CONTAINER_NAME" -t 10 >/dev/null
api_probe port-free "$API_PORT"
print_success "All Docker image qualification assertions passed"
