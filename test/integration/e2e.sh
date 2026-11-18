#!/usr/bin/env bash

# Run ONE integration test on its own freshly-booted local conductor.
#
# Usage: ./e2e.sh <test-name> [--debug] [--vitest]
#   <test-name>  basename of the selected Bash test or constrained Vitest spec
#   --debug      skip conductor teardown for inspection
#   --vitest     run the unique constrained <test-name>.spec.ts instead of Bash
#
# This builds the API image, boots an isolated local conductor (its own
# ANYCLOUD_DIR + the anycloud-api container on port 8787), runs the one test
# against it, and tears the conductor down. CI fans the tests out across runners:
# real-cloud Job, VM, and Service legs run on demand in e2e-job.yml, e2e-vm.yml,
# and e2e-serve.yml; Local smolvm and no-provision legs run on demand in
# integration.yml.

set -e

# Parse args: a test name plus optional runner/debug flags, in any order.
DEBUG_MODE=false
VITEST_MODE=false
TEST_NAME=""
for arg in "$@"; do
    case $arg in
        --debug) DEBUG_MODE=true ;;
        --vitest) VITEST_MODE=true ;;
        *) TEST_NAME="$arg" ;;
    esac
done

SCRIPT_DIR="$(dirname "$0")"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
export PROJECT_ROOT
cd "$PROJECT_ROOT"

# Source common helper functions
source "$SCRIPT_DIR/helpers/common.sh"

REQUESTED_TEST_NAME="$TEST_NAME"
SETUP_ERROR=""
if [ -z "$TEST_NAME" ]; then
    TEST_NAME="isolated-runner-setup"
    SETUP_ERROR="Usage: e2e.sh <test-name> [--debug] [--vitest]"
elif ! [[ "$TEST_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    TEST_NAME="isolated-runner-setup"
    SETUP_ERROR="Invalid isolated E2E test name: $REQUESTED_TEST_NAME"
fi

# Results dir for the per-workload diagnostics that process-e2e-logs.ts writes.
if [ "$VITEST_MODE" = true ]; then
    E2E_IMPLEMENTATION="vitest"
else
    E2E_IMPLEMENTATION="bash"
fi
export E2E_IMPLEMENTATION TEST_NAME
if [ "$TEST_NAME" = "nuke" ]; then
    export E2E_NUKE_IMAGE_RUN_ID="${GITHUB_RUN_ID:-local-$$}"
fi
RESULTS_DIR="${RESULTS_DIR:-/tmp/e2e-results-${TEST_NAME}-${E2E_IMPLEMENTATION}-$$}"
mkdir -p "$RESULTS_DIR"
export RESULTS_DIR
LOG_FILE="$RESULTS_DIR/${TEST_NAME}-${E2E_IMPLEMENTATION}.log"
TEST_COMMAND_DESCRIPTION="isolated runner setup for $TEST_NAME ($E2E_IMPLEMENTATION)"
RUNNER_START_SECONDS=$SECONDS
source "$SCRIPT_DIR/helpers/e2e-evidence.sh"

finish_early_evidence() {
    local original_exit=$?
    trap - EXIT
    set +e
    local final_exit=$original_exit
    if [ ! -f "$RESULTS_DIR/e2e-run.json" ] && [ "$final_exit" -eq 0 ]; then
        final_exit=1
    fi
    e2e_ensure_run_record "$original_exit" || final_exit=1
    e2e_process_evidence "$RESULTS_DIR/api-not-started.log" || final_exit=1
    exit "$final_exit"
}
trap finish_early_evidence EXIT

if [ -n "$SETUP_ERROR" ]; then
    print_error "$SETUP_ERROR"
    exit 1
fi

# Validate the selected implementation before the multi-minute build/boot.
# Candidate names need not have a same-named Bash file: one combined legacy
# scenario may map to independently qualified constrained contracts.
TEST_SCRIPT="./test/integration/${TEST_NAME}.test.sh"
VITEST_SPEC=""
if [ "$VITEST_MODE" = true ]; then
    while IFS= read -r candidate; do
        if [ -n "$VITEST_SPEC" ]; then
            print_error "Multiple constrained Vitest candidates are named ${TEST_NAME}.spec.ts"
            exit 1
        fi
        VITEST_SPEC="$candidate"
    done < <(find ./test/integration/e2e/specs -type f -name "${TEST_NAME}.spec.ts" -print)
    if [ -z "$VITEST_SPEC" ]; then
        print_error "No constrained Vitest candidate exists for ${TEST_NAME}"
        exit 1
    fi
elif [ ! -f "$TEST_SCRIPT" ]; then
    print_error "No Bash integration test exists at ${TEST_SCRIPT}"
    exit 1
fi

needs_local_smolvm_runtime() {
    case "$1" in
        local-held-job|local-completed-job|local-resubmitted-job|local-smolvm-vm|local-smolvm-vm-host-loss|local-smolvm-serve) return 0 ;;
        nuke)
            [ "${NUKE_PROVIDER:-}" = "local" ] && return 0
            return 1
            ;;
        *) return 1 ;;
    esac
}

is_azure_backed_test() {
    case "$1" in
        azure-*) return 0 ;;
        *) return 1 ;;
    esac
}

record_preflight_evidence() {
    local exit_code=$1
    local description=$2
    local duration_seconds
    printf '%s\n%s\n' "$description" "${AZURE_AUTH_OUTPUT:-}" > "$LOG_FILE"
    duration_seconds=$(e2e_evidence_duration)
    e2e_write_run_record "$exit_code" "$duration_seconds" "$description"
    e2e_write_joblog "$exit_code" "$duration_seconds" "$description"
    e2e_process_evidence "$RESULTS_DIR/api-not-started.log"
}

if is_azure_backed_test "$TEST_NAME"; then
    set +e
    AZURE_AUTH_OUTPUT="$(azure_auth_preflight 2>&1)"
    AZURE_AUTH_RC=$?
    set -e
    if [ "$AZURE_AUTH_RC" -ne 0 ]; then
        echo "$AZURE_AUTH_OUTPUT"
        record_preflight_evidence "$AZURE_AUTH_RC" "Azure auth preflight failed"
        fail "Azure auth preflight failed"
    fi
    print_success "Azure auth preflight passed"
fi

# Isolated ANYCLOUD_DIR so the API server DB doesn't touch ~/.anycloud. The API
# container mounts it, so it stays under /tmp, which a CI runner shares with its
# Docker daemon at the same path, whatever TMPDIR says.
TEMP_DIR=$(mktemp -d /tmp/anycloud-e2e.XXXXXX)
export ANYCLOUD_DIR="$TEMP_DIR"

CLI="node $PROJECT_ROOT/dist/cli/index.js"
E2E_API_STARTED=false

capture_runner_evidence() {
    local original_exit=$1
    local api_log="$RESULTS_DIR/api-not-started.log"
    local evidence_failed=false
    if [ "$TEST_NAME" = "nuke" ]; then
        # Capture the actual container before api stop removes it. The nuke
        # collector validates these narrow observations after every backstop;
        # an observation failure must not replace the original test exit.
        node test/integration/helpers/nuke-image-evidence.ts container \
            "$RESULTS_DIR/nuke-api-container.json" || \
            print_error "Nuke API container image evidence unavailable"
    fi
    if [ "$E2E_API_STARTED" = true ]; then
        # The API container is destroyed during teardown, so its logs must be
        # captured before any API or local-runtime cleanup begins.
        docker logs anycloud-api > /tmp/api-e2e.log 2>&1 || true
        api_log=/tmp/api-e2e.log
    fi
    e2e_ensure_run_record "$original_exit" || evidence_failed=true
    e2e_process_evidence "$api_log" || evidence_failed=true
    [ "$evidence_failed" = false ]
}

cleanup() {
    local original_exit=$?
    trap - EXIT
    set +e
    local final_exit=$original_exit
    if [ ! -f "$RESULTS_DIR/e2e-run.json" ] && [ "$final_exit" -eq 0 ]; then
        final_exit=1
    fi
    if [ "$DEBUG_MODE" = true ]; then
        capture_runner_evidence "$original_exit" || final_exit=1
        echo ""
        print_info "⚠️  DEBUG MODE: Skipping cleanup"
        print_info "API URL:   ${API_URL:-<not started>}"
        print_info "SQLite DB: $TEMP_DIR/api.db"
        print_info "To clean up later:  ANYCLOUD_DIR=$TEMP_DIR $CLI api stop"
        exit "$final_exit"
    fi

    if [ -s "$RESULTS_DIR/workloads-to-clean" ] && [ -n "${API_URL:-}" ]; then
        print_info "Cleaning up recorded workload(s) before stopping API..."
        sort -u "$RESULTS_DIR/workloads-to-clean" | while IFS= read -r workload_id; do
            [ -n "$workload_id" ] || continue
            cleanup_workload_via_api "$workload_id" 600 || true
        done
    fi

    capture_runner_evidence "$original_exit" || final_exit=1
    print_info "Cleaning up API server..."
    ANYCLOUD_DIR="$TEMP_DIR" $CLI api stop 2>/dev/null || true
    kill_port 8787 2>/dev/null || true
    if needs_local_smolvm_runtime "$TEST_NAME"; then
        yarn -s local-runtime:cleanup 2>/dev/null || true
    fi
    cleanup_anycloud_dir "$TEMP_DIR"
    if [ "$final_exit" -ne "$original_exit" ]; then
        print_error "E2E evidence validation or log post-processing failed"
    fi
    exit "$final_exit"
}

trap cleanup EXIT

# Build project and Docker image
print_section "Building project and Docker image"
BUILD_LOG="/tmp/e2e-build-$$.log"
IMAGE_NAME=$(node -p "require('./package.json').apiImage")
VERSION=$(node -p "require('./package.json').version")
IMAGE_TAG="$IMAGE_NAME:$VERSION"
yarn build > "$BUILD_LOG" 2>&1
# The live cluster member's images name their chart by digest, as a release's
# do: publish this tree's chart at this version before building them. Gated
# with the image push below.
# Prints the digest-pinned reference of the chart published at version $1.
publish_api_chart() {
    local reference="/tmp/e2e-api-chart-$$"
    retry_cmd 3 15 sh -c 'yarn -s chart:publish "$1" > "$2"' sh "$1" "$reference" >&2 || return
    cat "$reference"
    rm -f "$reference"
}
API_CHART=""
if [ "${ANYCLOUD_PUSH_API_IMAGE:-}" = "true" ]; then
    API_CHART="$(publish_api_chart "$VERSION")"
    print_success "Published the API chart $API_CHART"
fi
# Reuse the prebuilt deps base for this yarn.lock hash when it exists (skips the
# ~5 min yarn install + native compile); falls back to inline build otherwise.
DEPS_FULL_IMAGE=$(bash "$PROJECT_ROOT/scripts/resolve-deps-image.sh" full)
DEPS_PROD_IMAGE=$(bash "$PROJECT_ROOT/scripts/resolve-deps-image.sh" prod)
retry_cmd 3 15 docker build \
    --build-arg "DEPS_FULL_IMAGE=$DEPS_FULL_IMAGE" \
    --build-arg "DEPS_PROD_IMAGE=$DEPS_PROD_IMAGE" \
    --build-arg "API_CHART=$API_CHART" \
    -t "$IMAGE_TAG" -f "$PROJECT_ROOT/Dockerfile" "$PROJECT_ROOT" >> "$BUILD_LOG" 2>&1
print_success "Built $IMAGE_TAG"

if [ "$TEST_NAME" = "nuke" ]; then
    node test/integration/helpers/nuke-image-evidence.ts built \
        "$RESULTS_DIR/nuke-api-built.json" "$IMAGE_TAG" || \
        print_error "Nuke built API image evidence unavailable"
fi

# The e2e-cluster-cloud hosted stage needs a second image of the same tree for a real
# `api upgrade` change: `b` differs from `a` by a label and by its chart (the
# same templates published as version `<version>-b`, which the Pod template
# carries, so every upgrade between `a` and `b` changes chart and image and a
# chart applied in a second Helm run would roll the API again), is pushed FIRST so the mutable release
# tag ends on `a`, and its digest reaches the spec as a digest-pinned reference
# under the release tag.
if [ "${ANYCLOUD_PUSH_API_IMAGE:-}" = "true" ] && [ -n "${ANYCLOUD_ALTERNATE_API_IMAGE_TAG:-}" ]; then
    ALTERNATE_IMAGE_TAG="$IMAGE_NAME:$ANYCLOUD_ALTERNATE_API_IMAGE_TAG"
    ALTERNATE_API_CHART="$(publish_api_chart "$VERSION-b")"
    retry_cmd 3 15 docker build \
        --build-arg "DEPS_FULL_IMAGE=$DEPS_FULL_IMAGE" \
        --build-arg "DEPS_PROD_IMAGE=$DEPS_PROD_IMAGE" \
        --build-arg "API_CHART=$ALTERNATE_API_CHART" \
        --label anycloud.live-run=b \
        -t "$ALTERNATE_IMAGE_TAG" -f "$PROJECT_ROOT/Dockerfile" "$PROJECT_ROOT" >> "$BUILD_LOG" 2>&1
    retry_cmd 3 15 docker push "$ALTERNATE_IMAGE_TAG"
    ALTERNATE_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$ALTERNATE_IMAGE_TAG" | sed 's/.*@//')"
    [ -n "$ALTERNATE_DIGEST" ] || fail "Could not read the digest of $ALTERNATE_IMAGE_TAG"
    export E2E_CLUSTER_ALTERNATE_IMAGE="$IMAGE_TAG@$ALTERNATE_DIGEST"
    print_success "Pushed $ALTERNATE_IMAGE_TAG ($ALTERNATE_DIGEST) as the alternate release"
fi

# The live cluster member's bootstrap resolves this image from GHCR by tag, so
# the just-built image must be published. Gated: only that leg sets this (after
# stamping a throwaway CI version), so ordinary legs and local runs never push.
if [ "${ANYCLOUD_PUSH_API_IMAGE:-}" = "true" ]; then
    retry_cmd 3 15 docker push "$IMAGE_TAG"
    print_success "Pushed $IMAGE_TAG for the cluster bootstrap"
fi

ensure_cipher_key() {
    local key_file="$ANYCLOUD_DIR/cipher.key"
    mkdir -p "$ANYCLOUD_DIR"
    if [ ! -f "$key_file" ]; then
        node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" > "$key_file"
        chmod 600 "$key_file"
    fi
}

start_local_api_for_smolvm_e2e() {
    ensure_cipher_key
    ensure_local_api_token "$ANYCLOUD_DIR"
    docker rm -f anycloud-api >/dev/null 2>&1 || true

    local fixture_args=() api_command=()
    if [ "$TEST_NAME" = "nuke" ]; then
        fixture_args=(
            -v "$PROJECT_ROOT/test/helpers/api-responsiveness:/fixture/api-responsiveness:ro"
            -v "$RESULTS_DIR:/fixture/nuke"
            -e "NUKE_SSH_PRESSURE_MODE=${NUKE_SSH_PRESSURE_MODE:-helper}"
        )
        api_command=(node --import /fixture/api-responsiveness/nuke-pressure.mjs /app/dist/api/server.js)
    fi

    # The API writes buckets the runner's SmolVM service mounts, so both see one
    # directory at one absolute path. CI puts it where the runner shares files
    # with its Docker daemon (ANYCLOUD_TEST_LOCAL_BUCKET_ROOT).
    local bucket_root="${ANYCLOUD_TEST_LOCAL_BUCKET_ROOT:-/var/lib/anycloud-test/local/buckets}"

    print_section "Starting API with the Local smolvm test harness"
    docker run -d \
        --name anycloud-api \
        --label "sh.anycloud.version=$VERSION" \
        --log-opt max-size=50m \
        --log-opt max-file=3 \
        --network host \
        -v "$ANYCLOUD_DIR:/root/.anycloud" \
        -v "$bucket_root:$bucket_root" \
        -e ANYCLOUD_TEST_LOCAL_BUCKET_ROOT="$bucket_root" \
        -e PORT="$API_PORT" \
        -e SQLITE_PATH=/root/.anycloud/api.db \
        -e IS_TEST=true \
        "${fixture_args[@]}" \
        "$IMAGE_TAG" "${api_command[@]}" >> "$BUILD_LOG" 2>&1

    export API_URL="http://localhost:$API_PORT"
    if ! wait_for_http "$API_URL/health" 240 "Local harness API"; then
        docker logs anycloud-api 2>&1 | tail -200
        fail "Local harness API did not become healthy"
    fi
    E2E_API_STARTED=true
    print_success "API running at $API_URL"
}

if [ "$TEST_NAME" = "nuke" ]; then
    NUKE_DB_WORKLOADS="${NUKE_DB_WORKLOADS:-3700}"
    if ! [[ "$NUKE_DB_WORKLOADS" =~ ^[0-9]+$ ]] || [ "$NUKE_DB_WORKLOADS" -lt 1 ]; then
        print_error "NUKE_DB_WORKLOADS must be a positive integer"
        exit 1
    fi
    export NUKE_DB_MANIFEST="${NUKE_DB_MANIFEST:-$RESULTS_DIR/nuke-db-manifest.json}"
    ensure_cipher_key
    CIPHER_KEY="$(<"$ANYCLOUD_DIR/cipher.key")"
    export CIPHER_KEY
    print_section "Seeding nuke-db ($NUKE_DB_WORKLOADS workloads)"
    SQLITE_PATH="$ANYCLOUD_DIR/api.db" yarn -s seed nuke-db "$NUKE_DB_WORKLOADS" \
        --seed "${NUKE_DB_RANDOM_SEED:-nuke-db}" \
        --manifest "$NUKE_DB_MANIFEST" >> "$BUILD_LOG" 2>&1
    print_success "Seeded nuke-db manifest at $NUKE_DB_MANIFEST"
fi

# Local lanes use an internal harness start so smolvm configuration never becomes
# a public `api start` option. Other lanes exercise the public local API command.
API_PORT=8787
# The live cluster member's installer must authenticate the harness as the real
# GitHub account behind GITHUB_TOKEN: bootstrap records that account as the
# hosted API's owner, and the hosted API (a production image) resolves the
# same token for real. Under IS_TEST the installer would stub the identity and
# the hosted API would then deny the owner (F run 14: `API access denied`).
if [ "$TEST_NAME" = e2e-cluster-cloud ]; then
    API_START_IDENTITY_ENV=()
else
    API_START_IDENTITY_ENV=(IS_TEST=true)
fi
# The MACE cell pulls its image through the customer GHCR login path:
# a test API otherwise skips the login, so CI never exercised it.
if [[ "$TEST_NAME" == *-mace-full-pull ]]; then
    API_START_IDENTITY_ENV+=(ANYCLOUD_E2E_GHCR_AUTH=true)
fi
if needs_local_smolvm_runtime "$TEST_NAME"; then
    start_local_api_for_smolvm_e2e
else
    # e2e-cluster-cloud's from_release: that release's CLI starts the installer
    # on its own image; the spec's `api upgrade` moves it to this tree. `api
    # start` runs whatever the local tag holds, and other e2e builds on a shared
    # Docker host tag this tree as `api:<package version>`, so the published
    # image is pulled first and the started container must run it.
    if [ -n "${E2E_CLUSTER_FROM_RELEASE_CLI:-}" ]; then
        RELEASED_IMAGE="$IMAGE_NAME:${E2E_CLUSTER_FROM_RELEASE:?from_release needs E2E_CLUSTER_FROM_RELEASE}"
        retry_cmd 3 15 docker pull "$RELEASED_IMAGE" >> "$BUILD_LOG" 2>&1
        RELEASED_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$RELEASED_IMAGE")"
    fi
    if ! env ANYCLOUD_DIR="$TEMP_DIR" ${API_START_IDENTITY_ENV[@]+"${API_START_IDENTITY_ENV[@]}"} ${E2E_CLUSTER_FROM_RELEASE_CLI:-$CLI} api start --port "$API_PORT" >> "$BUILD_LOG" 2>&1; then
        # `api start` deliberately leaves an unhealthy container available for
        # diagnosis. Capture it before the EXIT trap removes the container and
        # isolated ANYCLOUD_DIR, otherwise the evidence record only reports that
        # the runner exited without preserving the actual startup failure.
        docker logs anycloud-api > "$RESULTS_DIR/api-not-started.log" 2>&1 || {
            if [ -f "$TEMP_DIR/api-last.log" ]; then
                cp "$TEMP_DIR/api-last.log" "$RESULTS_DIR/api-not-started.log"
            fi
        }
        fail "Local API failed to start; see $RESULTS_DIR/api-not-started.log"
    fi
    if [ -n "${RELEASED_IMAGE_ID:-}" ]; then
        STARTED_IMAGE_ID="$(docker inspect --format '{{.Image}}' anycloud-api)"
        [ "$STARTED_IMAGE_ID" = "$RELEASED_IMAGE_ID" ] ||
            fail "The installer runs $STARTED_IMAGE_ID, not the published $RELEASED_IMAGE ($RELEASED_IMAGE_ID)"
        print_success "Installer runs the published $RELEASED_IMAGE"
    fi
    export API_URL="http://localhost:$API_PORT"
    E2E_API_STARTED=true
    print_success "API running at $API_URL"
fi

# Per-test timeout (coreutils `timeout`; disabled if absent or set to 0).
E2E_TEST_TIMEOUT_SECONDS="${E2E_TEST_TIMEOUT_SECONDS:-6600}"
if ! [[ "$E2E_TEST_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]]; then
    print_error "E2E_TEST_TIMEOUT_SECONDS must be a non-negative integer"
    exit 1
fi
TIMEOUT_CMD=""
if [ "$E2E_TEST_TIMEOUT_SECONDS" -gt 0 ]; then
    if command -v timeout > /dev/null 2>&1; then
        TIMEOUT_CMD="timeout"
    elif command -v gtimeout > /dev/null 2>&1; then
        TIMEOUT_CMD="gtimeout"
    else
        print_warning "No timeout command found; per-test timeout is disabled"
        E2E_TEST_TIMEOUT_SECONDS=0
    fi
fi

# Run the one test. Output streams live to stdout (visible in the CI log) and is
# teed to a logfile for the artifact. The shared command runner records evidence
# and preserves the test's exit status through logging and cleanup.
print_section "Running $TEST_NAME ($E2E_IMPLEMENTATION)"
if [ "$VITEST_MODE" = true ]; then
    export E2E_ARTIFACT_DIR="$RESULTS_DIR/vitest-fixture"
    TEST_COMMAND=(yarn -s vitest run --config vitest.e2e.config.mts "$VITEST_SPEC")
    TEST_COMMAND_DESCRIPTION="vitest $VITEST_SPEC"
else
    TEST_COMMAND=("$BASH" "$TEST_SCRIPT")
    TEST_COMMAND_DESCRIPTION="bash $TEST_SCRIPT"
fi
if [ "$E2E_TEST_TIMEOUT_SECONDS" -gt 0 ] && [ -n "$TIMEOUT_CMD" ]; then
    TEST_COMMAND=("$TIMEOUT_CMD" --kill-after=60s "$E2E_TEST_TIMEOUT_SECONDS" "${TEST_COMMAND[@]}")
fi
if e2e_run_command "${TEST_COMMAND[@]}"; then
    RC=0
else
    RC=$?
fi

echo ""
if [ "$RC" -eq 0 ]; then
    print_success "$TEST_NAME ($E2E_IMPLEMENTATION) passed"
elif [ "$RC" -eq 124 ]; then
    print_error "$TEST_NAME timed out after ${E2E_TEST_TIMEOUT_SECONDS}s"
else
    print_error "$TEST_NAME failed (exit $RC)"
fi

exit "$RC"
