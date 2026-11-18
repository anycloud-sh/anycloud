#!/bin/bash

# Native Docker/process launch boundary; api-process.ts owns observations.
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"
source "$SCRIPT_DIR/helpers/common.sh"
export E2E_API_PROCESS_MEMBER=api-startup
export RESULTS_DIR="${RESULTS_DIR:-/tmp/e2e-results-api-startup-$$}"
mkdir -p "$RESULTS_DIR"

api_probe() {
    yarn -s tsx test/integration/helpers/api-process.ts "$@"
}
API_PORT=8787
API_URL="http://localhost:$API_PORT"
CLI="node $PROJECT_ROOT/dist/cli/index.js"
api_probe container-missing anycloud-api
TEMP_DIR=$(mktemp -d)
DURABLE_STATE_DIR=$(mktemp -d)
DURABLE_CONTAINER="api-startup-durable-$$"
BIN_DIR=$(mktemp -d)
TEST_API_IMAGE_TAGS=()
STARTED=0
BAD_DIR=""
FAST_IMAGE_TAG=""
FAKE_GITHUB_PID=""
cleanup() {
    local original_exit=$?
    trap - EXIT
    set +e
    local cleanup_failed=0
    [ "$STARTED" = "1" ] && { ANYCLOUD_DIR="$TEMP_DIR" $CLI api stop 2>/dev/null || true; }
    docker rm -f "$DURABLE_CONTAINER" anycloud-api >/dev/null 2>&1 || true
    api_probe containers-absent || cleanup_failed=1
    [ "${#TEST_API_IMAGE_TAGS[@]}" -gt 0 ] && docker image rm "${TEST_API_IMAGE_TAGS[@]}" >/dev/null 2>&1 || true
    # Put the real image back under its tag if the slow-replacement section failed.
    [ -z "$FAST_IMAGE_TAG" ] || { docker tag "$FAST_IMAGE_TAG" "$IMAGE_TAG" && docker image rm "$FAST_IMAGE_TAG"; } >/dev/null 2>&1 || true
    kill_port "$API_PORT"
    [ -z "$FAKE_GITHUB_PID" ] || kill "$FAKE_GITHUB_PID" 2>/dev/null
    if [ "$cleanup_failed" -eq 0 ]; then
        cleanup_anycloud_dir "$TEMP_DIR" || cleanup_failed=1
        cleanup_anycloud_dir "$DURABLE_STATE_DIR" || cleanup_failed=1
        [ -z "$BAD_DIR" ] || cleanup_anycloud_dir "$BAD_DIR" || cleanup_failed=1
        rm -rf "$BIN_DIR" || cleanup_failed=1
    fi
    if [ "$cleanup_failed" -ne 0 ]; then
        print_error "API startup cleanup remains incomplete; retained state: $TEMP_DIR $DURABLE_STATE_DIR $BAD_DIR $BIN_DIR"
        [ "$original_exit" -ne 0 ] || original_exit=1
    fi
    api_probe launcher-finished "$cleanup_failed" || { [ "$original_exit" -ne 0 ] || original_exit=1; }
    exit "$original_exit"
}
trap cleanup EXIT
api_probe register-owned anycloud-api "$DURABLE_CONTAINER"
kill_port "$API_PORT"

print_section "Building project and API image"
yarn build
VERSION=$(node -p "require('./package.json').version")
IMAGE_NAME=$(node -p "require('./package.json').apiImage")
IMAGE_TAG="$IMAGE_NAME:$VERSION"
DEPS_FULL_IMAGE=$(bash "$PROJECT_ROOT/scripts/resolve-deps-image.sh" full)
DEPS_PROD_IMAGE=$(bash "$PROJECT_ROOT/scripts/resolve-deps-image.sh" prod)
retry_cmd 3 15 docker build --build-arg "DEPS_FULL_IMAGE=$DEPS_FULL_IMAGE" \
    --build-arg "DEPS_PROD_IMAGE=$DEPS_PROD_IMAGE" -t "$IMAGE_TAG" -f "$PROJECT_ROOT/Dockerfile" "$PROJECT_ROOT"

print_section "SSH process reaping, ordered drain and responsiveness"
bash "$SCRIPT_DIR/helpers/api-ssh-reaping.sh" "$IMAGE_TAG"
bash "$SCRIPT_DIR/helpers/api-ssh-drain.sh" "$IMAGE_TAG"
docker run --rm --memory=6g \
    -v "$PROJECT_ROOT/test/helpers/api-responsiveness:/fixture/api-responsiveness:ro" \
    -v "$PROJECT_ROOT/test/integration/fixtures/api-startup-responsiveness.ts:/fixture/api-startup-responsiveness.ts:ro" \
    "$IMAGE_TAG" node --experimental-strip-types /fixture/api-startup-responsiveness.ts

print_section "Durable default state across container replacement"
ensure_local_api_token "$DURABLE_STATE_DIR"
docker run -d --name "$DURABLE_CONTAINER" -p "127.0.0.1:$API_PORT:8080" \
    -v "$DURABLE_STATE_DIR:/root/.anycloud" -e PORT=8080 -e IS_TEST=true "$IMAGE_TAG" >/dev/null
api_probe durable-seed "$DURABLE_CONTAINER" "$API_URL" "$TEMP_DIR/durable.json" "$DURABLE_STATE_DIR"
docker rm -f "$DURABLE_CONTAINER" >/dev/null
docker run -d --name "$DURABLE_CONTAINER" -p "127.0.0.1:$API_PORT:8080" \
    -v "$DURABLE_STATE_DIR:/root/.anycloud" -e PORT=8080 -e IS_TEST=true "$IMAGE_TAG" >/dev/null
api_probe durable-restored "$DURABLE_CONTAINER" "$API_URL" "$TEMP_DIR/durable.json" "$DURABLE_STATE_DIR"
docker rm -f "$DURABLE_CONTAINER" >/dev/null
kill_port "$API_PORT"

# Update restarts the API with the running CLI (node plus dist/cli/index.js),
# so `api start` faults are injected into that process through NODE_OPTIONS.
REAL_CURL="$(command -v curl)"
FAULT_SHIM="$TEMP_DIR/api-start-faults.cjs"
cat > "$FAULT_SHIM" <<'EOF'
const { execFileSync } = require('node:child_process');

const [command, subcommand] = process.argv.slice(2);
if (command === 'api' && subcommand === 'start') {
  if (process.env.ANYCLOUD_TEST_FAIL_API_START === '1') {
    console.error('simulated api start failure');
    process.exit(42);
  }
  if (process.env.ANYCLOUD_TEST_LEAVE_UNHEALTHY_API === '1') {
    execFileSync(
      'docker',
      ['run', '-d', '--name', 'anycloud-api', '--stop-timeout', '1',
        process.env.ANYCLOUD_TEST_IMAGE, 'node', '-e', 'setInterval(() => {}, 60_000)'],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    console.error('simulated api start health timeout');
    process.exit(42);
  }
}
EOF
cat > "$BIN_DIR/anycloud" <<EOF
#!/usr/bin/env bash
exec node "$PROJECT_ROOT/dist/cli/index.js" "\$@"
EOF
cat > "$BIN_DIR/curl" <<EOF
#!/usr/bin/env bash
for arg in "\$@"; do
  case "\$arg" in
    *get.anycloud.sh*)
      echo "unexpected installer call during stale-API update test" >&2
      exit 1
      ;;
  esac
done
exec "$REAL_CURL" "\$@"
EOF
chmod +x "$BIN_DIR/anycloud" "$BIN_DIR/curl"
export PATH="$BIN_DIR:$PATH"

# `anycloud update` must not accept public version arguments. Keep this test on
# the supported no-argument command while making the public release lookup return
# the current CLI version. The restart is forced by running an API container
# whose version label is stale, not by inventing a future release.
HTTPS_SHIM="$TEMP_DIR/mock-release-current.cjs"
cat > "$HTTPS_SHIM" <<'EOF'
const { EventEmitter } = require('node:events');
const https = require('node:https');
const { syncBuiltinESMExports } = require('node:module');

const originalGet = https.get.bind(https);

https.get = function patchedGet(url, options, callback) {
  const href =
    typeof url === 'string'
      ? url
      : url && typeof url.href === 'string'
        ? url.href
        : String(url);

  if (
    href !==
    'https://api.github.com/repos/anycloud-sh/releases/releases/latest'
  ) {
    return originalGet(url, options, callback);
  }

  if (typeof options === 'function') {
    callback = options;
  }

  const req = new EventEmitter();
  req.destroy = () => req;
  req.end = () => undefined;

  process.nextTick(() => {
    req.emit('socket', { unref() {} });

    const res = new EventEmitter();
    res.statusCode = 200;
    res.setEncoding = () => undefined;
    callback(res);

    process.nextTick(() => {
      res.emit(
        'data',
        JSON.stringify({
          tag_name: `v${process.env.ANYCLOUD_TEST_CURRENT_VERSION}`,
        }),
      );
      res.emit('end');
    });
  });

  return req;
};

syncBuiltinESMExports();
EOF


root_update() {
    ANYCLOUD_DIR="$TEMP_DIR" CI=true IS_TEST=true \
        ANYCLOUD_TEST_CURRENT_VERSION="$VERSION" ANYCLOUD_TEST_IMAGE="$IMAGE_TAG" \
        NODE_OPTIONS="${NODE_OPTIONS:-} --require=$HTTPS_SHIM --require=$FAULT_SHIM" anycloud update
}

print_section "Default API startup and self-healing shutdown"
ANYCLOUD_DIR="$TEMP_DIR" IS_TEST=true $CLI api start --port "$API_PORT"
STARTED=1
api_probe startup-default "$TEMP_DIR" "$API_PORT"
api_probe after-running anycloud-api
node "$SCRIPT_DIR/helpers/api-http-shutdown.mjs" "$API_URL" anycloud-api "$VERSION" "$TEMP_DIR"
api_probe file-nonempty "$TEMP_DIR/api.db"
ANYCLOUD_DIR="$TEMP_DIR" $CLI api status

print_section "The per-install token, not GitHub, opens the local API"
# No GitHub sign-in: $TEMP_DIR holds no saved login and GITHUB_TOKEN is unset.
without_github() {
    env -u GITHUB_TOKEN ANYCLOUD_DIR="$TEMP_DIR" API_URL="$API_URL" CI=true $CLI "$@" 2>&1
}
with_github() {
    GITHUB_TOKEN=dummy-token-for-test ANYCLOUD_DIR="$TEMP_DIR" API_URL="$API_URL" CI=true $CLI "$@" 2>&1
}
set +e
MISSING_WORKLOAD=test-nonexistent-123
CLI_OUTPUT=$(without_github status "$MISSING_WORKLOAD")
CLI_EXIT=$?
set -e
printf '%s\n' "$CLI_OUTPUT"
api_probe local-token "$TEMP_DIR" "$API_URL"
printf '%s\n' "$CLI_OUTPUT" | api_probe status-result "$CLI_EXIT" "$API_URL" "$MISSING_WORKLOAD" "$TEMP_DIR"

print_section "Features that need GitHub relay the sign-in as actionRequired"
api_probe save-credential "$TEMP_DIR" "$API_URL" api-startup-aws
# Usage: expect_output <with_github|without_github> <exit 0|1> <needle> -- <cli args>
expect_output() {
    local runner=$1 expected_exit=$2 needle=$3 output exit_code
    shift 4
    set +e
    output=$("$runner" "$@")
    exit_code=$?
    set -e
    printf '%s\n' "$output"
    [ "$exit_code" -eq "$expected_exit" ] || fail "$* exited $exit_code, expected $expected_exit"
    grep -qF -- "$needle" <<<"$output" || fail "$* did not print: $needle"
}
PRIVATE_IMAGE=ghcr.io/anycloud-sh/ci-private:latest
expect_output without_github 1 "Can't access image \"$PRIVATE_IMAGE\". For a private GHCR image, run \`anycloud login\`" -- \
    job --credentials api-startup-aws --vm-type m3.medium "$PRIVATE_IMAGE" -- true
# Without a terminal the CLI relays a device code; a fake GitHub issues it.
FAKE_GITHUB_PORT_FILE="$TEMP_DIR/fake-github-port"
node -e '
  const http = require("http");
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/login/device/code"
      ? { device_code: "fake-device", user_code: "FAKE-0001", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 0 }
      : { error: "authorization_pending" }));
  });
  server.listen(0, "127.0.0.1", () =>
    require("fs").writeFileSync(process.argv[1], String(server.address().port)));
' "$FAKE_GITHUB_PORT_FILE" &
FAKE_GITHUB_PID=$!
for _ in $(seq 50); do [ -s "$FAKE_GITHUB_PORT_FILE" ] && break; sleep 0.1; done
signed_out_relay() {
    IS_TEST=true ANYCLOUD_GITHUB_URL="http://127.0.0.1:$(cat "$FAKE_GITHUB_PORT_FILE")" without_github "$@"
}
RELAY='Ask the user to open https://github.com/login/device?user_code=FAKE-0001 and enter the code FAKE-0001'
expect_output signed_out_relay 1 "{\"actionRequired\":{\"code\":\"GITHUB_SIGN_IN_REQUIRED\",\"message\":\"A Service's public URL needs GitHub sign-in. $RELAY" -- \
    service --credentials api-startup-aws --vm-type m3.medium busybox:1.36 -- true
# Create runs through the cloud's own CLI, not the API. It must never reach
# a real cloud from CI. The dummy token stops it at GitHub, before the seed;
# as a backstop, `aws` is a signed-out fake ahead of the runner's, and AWS's
# credential env and instance metadata are off.
FAKE_CLOUD_BIN="$TEMP_DIR/fake-cloud-bin"
mkdir -p "$FAKE_CLOUD_BIN"
printf '#!/bin/sh\necho "Unable to locate credentials" >&2\nexit 253\n' > "$FAKE_CLOUD_BIN/aws"
chmod +x "$FAKE_CLOUD_BIN/aws"
without_cloud() (
    unset $(compgen -v AWS_)
    export AWS_EC2_METADATA_DISABLED=true PATH="$FAKE_CLOUD_BIN:$PATH"
    with_github "$@"
)
expect_output without_cloud 1 "Failed to create cluster: GitHub did not name the signed-in account" -- \
    cluster create api-startup-dummy-github --cloud aws --region us-east-1 --vm-type t3.medium
kill "$FAKE_GITHUB_PID"
FAKE_GITHUB_PID=""
rm -f "$TEMP_DIR/github-device.json" "$FAKE_GITHUB_PORT_FILE"
# Signed in, the same Service passes the gate and reaches the dummy keys' check.
expect_output with_github 1 'Cloud credential "api-startup-aws" failed AWS validation' -- \
    service --credentials api-startup-aws --vm-type m3.medium busybox:1.36 -- true

print_section "The local API token survives a restart"
TOKEN_DIGEST=$(sha256sum "$TEMP_DIR/local-api-token")
ANYCLOUD_DIR="$TEMP_DIR" $CLI api stop
ANYCLOUD_DIR="$TEMP_DIR" IS_TEST=true $CLI api start --port "$API_PORT"
[ "$(sha256sum "$TEMP_DIR/local-api-token")" = "$TOKEN_DIGEST" ] || fail "api start replaced the local API token"
RESTARTED_STATUS=$(without_github status "$MISSING_WORKLOAD" || true)
grep -qF "Workload not found" <<<"$RESTARTED_STATUS" || fail "the restarted API refused its token: $RESTARTED_STATUS"

print_section "Update replaces a stale API and keeps exactly one rollback image"
docker stop anycloud-api >/dev/null
docker rm anycloud-api >/dev/null
PREVIOUS_API_VERSION="0.0.0-api-startup-prev-$$"
STALE_API_VERSION="0.0.0-api-startup-stale-$$"
PREVIOUS_API_IMAGE_TAG="$IMAGE_NAME:$PREVIOUS_API_VERSION"
STALE_API_IMAGE_TAG="$IMAGE_NAME:$STALE_API_VERSION"
TEST_API_IMAGE_TAGS=("$PREVIOUS_API_IMAGE_TAG" "$STALE_API_IMAGE_TAG")
docker tag "$IMAGE_TAG" "$PREVIOUS_API_IMAGE_TAG"
docker tag "$IMAGE_TAG" "$STALE_API_IMAGE_TAG"
docker run -d --name anycloud-api --label "sh.anycloud.version=$PREVIOUS_API_VERSION" \
    -p "127.0.0.1:$API_PORT:8080" -v "$TEMP_DIR:/root/.anycloud" \
    -e PORT=8080 -e SQLITE_PATH=/root/.anycloud/api.db -e IS_TEST=true "$PREVIOUS_API_IMAGE_TAG" >/dev/null
api_probe health "$API_URL"
BEFORE_ID=$(api_probe container-id anycloud-api)
root_update
api_probe container-running anycloud-api
api_probe startup-updated "$BEFORE_ID" "$TEMP_DIR" "$API_PORT" "$VERSION" "$PREVIOUS_API_IMAGE_TAG" "$STALE_API_IMAGE_TAG"
api_probe health "$API_URL"

print_section "Current missing-label API remains running without replacement"
docker stop anycloud-api >/dev/null
docker rm anycloud-api >/dev/null
docker run -d --name anycloud-api -p "$API_PORT:8080" -v "$TEMP_DIR:/root/.anycloud" \
    -e PORT=8080 -e SQLITE_PATH=/root/.anycloud/api.db -e IS_TEST=true "$IMAGE_TAG" >/dev/null
api_probe health "$API_URL"
api_probe version "$API_URL" "$VERSION"
BEFORE_ID=$(api_probe container-id anycloud-api)
root_update
api_probe unchanged "$BEFORE_ID"
api_probe health "$API_URL"

print_section "Failed replacement stays down until an explicit manual start"
docker stop anycloud-api >/dev/null
docker rm anycloud-api >/dev/null
docker run -d --name anycloud-api --label sh.anycloud.version=0.0.1 \
    -p "$API_PORT:8080" -v "$TEMP_DIR:/root/.anycloud" \
    -e PORT=8080 -e SQLITE_PATH=/root/.anycloud/api.db -e IS_TEST=true "$IMAGE_TAG" >/dev/null
api_probe health "$API_URL"
set +e
FAILED_OUTPUT=$(ANYCLOUD_TEST_FAIL_API_START=1 root_update 2>&1)
FAILED_EXIT=$?
set -e
printf '%s\n' "$FAILED_OUTPUT" | api_probe failed-update "$FAILED_EXIT" stopped
root_update
api_probe down
ANYCLOUD_DIR="$TEMP_DIR" IS_TEST=true $CLI api start --port "$API_PORT"
STARTED=1
api_probe health "$API_URL"

print_section "Unhealthy running replacement requires stop followed by start"
ANYCLOUD_DIR="$TEMP_DIR" $CLI api stop
STARTED=0
docker run -d --name anycloud-api --label sh.anycloud.version=0.0.1 \
    -p "$API_PORT:8080" -v "$TEMP_DIR:/root/.anycloud" \
    -e PORT=8080 -e SQLITE_PATH=/root/.anycloud/api.db -e IS_TEST=true "$IMAGE_TAG" >/dev/null
STARTED=1
api_probe health "$API_URL"
set +e
UNHEALTHY_OUTPUT=$(ANYCLOUD_TEST_LEAVE_UNHEALTHY_API=1 root_update 2>&1)
UNHEALTHY_EXIT=$?
set -e
printf '%s\n' "$UNHEALTHY_OUTPUT" | api_probe failed-update "$UNHEALTHY_EXIT" running
ANYCLOUD_DIR="$TEMP_DIR" $CLI api stop
STARTED=0
ANYCLOUD_DIR="$TEMP_DIR" IS_TEST=true $CLI api start --port "$API_PORT" --version="$VERSION"
STARTED=1
api_probe health "$API_URL"

print_section "Explicit stop retains logs and root update never resurrects it"
ANYCLOUD_DIR="$TEMP_DIR" $CLI api use local
ANYCLOUD_DIR="$TEMP_DIR" $CLI api stop
STARTED=0
api_probe file-nonempty "$TEMP_DIR/api-last.log"
api_probe port-free "$API_PORT"
root_update
api_probe down
docker rm -f anycloud-api >/dev/null 2>&1 || true

print_section "API upgrade recovers the persisted custom-port local target"
ANYCLOUD_DIR="$TEMP_DIR" IS_TEST=true $CLI api upgrade
STARTED=1
api_probe container-running anycloud-api
api_probe restored-local "$TEMP_DIR" "$API_PORT" "$API_URL"
ANYCLOUD_DIR="$TEMP_DIR" $CLI api stop
STARTED=0

# A replacement that answers /health only after SLOW_START_DELAY seconds
# (past the old 15 s budget) must be waited for and keep its restart policy. The
# delayed image temporarily takes the current version's tag, which `api upgrade`
# starts.
print_section "API upgrade waits for a slow replacement"
FAST_IMAGE_TAG="anycloud-api-startup-fast:$$"
docker tag "$IMAGE_TAG" "$FAST_IMAGE_TAG"
SLOW_START_DELAY=20
printf 'FROM %s\nCMD ["sh", "-c", "sleep %s && exec node ./dist/api/server.js"]\n' \
    "$FAST_IMAGE_TAG" "$SLOW_START_DELAY" | docker build -q -t "$IMAGE_TAG" - >/dev/null
docker run -d --name anycloud-api --label sh.anycloud.version=0.0.1 --stop-timeout 1 \
    -p "127.0.0.1:$API_PORT:8080" "$FAST_IMAGE_TAG" node -e 'setInterval(() => {}, 60_000)' >/dev/null
STARTED=1
set +e
SLOW_AT=$SECONDS
ANYCLOUD_DIR="$TEMP_DIR" IS_TEST=true $CLI api upgrade 2>&1 | tee "$RESULTS_DIR/slow-upgrade.log"
SLOW_EXIT=${PIPESTATUS[0]}
SLOW_ELAPSED=$((SECONDS - SLOW_AT))
set -e
api_probe slow-start "$SLOW_EXIT" "$SLOW_ELAPSED" "$SLOW_START_DELAY" "$API_URL" <"$RESULTS_DIR/slow-upgrade.log"
ANYCLOUD_DIR="$TEMP_DIR" $CLI api stop
STARTED=0
docker tag "$FAST_IMAGE_TAG" "$IMAGE_TAG"
docker image rm "$FAST_IMAGE_TAG" >/dev/null
FAST_IMAGE_TAG=""

print_section "Boot failure exits at once and leaves no restarting container"
BAD_DIR=$(mktemp -d)
mkdir "$BAD_DIR/api.db"
set +e
START_AT=$SECONDS
START_OUTPUT=$(ANYCLOUD_DIR="$BAD_DIR" IS_TEST=true $CLI api start --port "$API_PORT" 2>&1)
START_EXIT=$?
set -e
printf '%s\n' "$START_OUTPUT"
api_probe failed-start "$START_EXIT" "$((SECONDS - START_AT))"
docker rm -f anycloud-api >/dev/null
cleanup_anycloud_dir "$BAD_DIR"
BAD_DIR=""
print_success "All API startup and shutdown assertions passed"
