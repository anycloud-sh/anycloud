#!/bin/bash

# Shared helpers for e2e.sh and the retained integration shell tests.

# Unique per-test-run token for workload IDs.
# In CI: GITHUB_RUN_ID is globally unique across concurrent workflow runs;
# GITHUB_RUN_ATTEMPT disambiguates reruns. Locally: epoch + pid + $RANDOM
# (reseeded per subshell in bash) truncated to 10 chars so IDs fit the 28-char API cap.
if [ -n "${GITHUB_RUN_ID:-}" ]; then
    TEST_RUN="${GITHUB_RUN_ID: -9}${GITHUB_RUN_ATTEMPT:-1}"
else
    _tr="$(date +%s)$$$RANDOM"; TEST_RUN="${_tr: -10}"; unset _tr
fi
export TEST_RUN

# Print a formatted test section header
print_section() {
    echo ""
    echo "[$(date +%H:%M:%S)] $1"
}

# Print a success message with checkmark
print_success() {
    echo "[$(date +%H:%M:%S)]    ✓ $1"
}

# Print an error message with X
print_error() {
    echo "[$(date +%H:%M:%S)]    ✗ $1"
}

# Emit a live-progress dot, but only on an interactive terminal. In CI and the
# parallel e2e harness each test's stdout is redirected to a file, so these dots
# are pure noise in the captured logs — suppress them there while keeping live
# feedback when a human runs a single test in a TTY. `return 0` keeps the
# original `printf "."` exit status (0) so callers under `set -e` are unaffected.
progress_tick() { [ -t 1 ] && printf "."; return 0; }

api_client_version() {
    jq -r .version "$PROJECT_ROOT/package.json"
}

# Print an info message
print_info() {
    echo "[$(date +%H:%M:%S)]    $1"
}

# Print a warning message
print_warning() {
    echo "[$(date +%H:%M:%S)]    ⚠ $1"
}

# Retry a command with linear backoff. For transient CI infra failures like
# Docker Hub registry timeouts when `docker build` pulls the base image —
# BuildKit caches completed layers, so a retried build resumes from the failed
# step rather than rebuilding. Returns the last exit code after exhausting
# attempts so callers under `set -e` still fail. Mirrors the linear-15s
# docker-pull retry in src/api/services/docker.ts.
# Usage: retry_cmd <max_attempts> <sleep_seconds> <cmd> [args...]
retry_cmd() {
    local max_attempts=$1 sleep_seconds=$2
    shift 2
    local attempt=1 rc=0
    until "$@"; do
        rc=$?
        if [ "$attempt" -ge "$max_attempts" ]; then
            print_error "'$1' failed after ${max_attempts} attempts (exit ${rc})"
            return "$rc"
        fi
        print_info "Attempt ${attempt}/${max_attempts} failed (exit ${rc}); retrying in ${sleep_seconds}s..."
        sleep "$sleep_seconds"
        attempt=$((attempt + 1))
    done
}

# Print an error message, a stack trace, and end the run.
#
# This used to `return 1` and rely on errexit to turn that into an abort, which
# made errexit load-bearing everywhere: reached with errexit suppressed — inside
# a `set +e` region, or through a `helper || { ... }` guard — it printed the
# error and let the script carry on to exit 0, reporting a passing test that had
# already failed. Exiting removes that whole class.
#
# `caller` still walks the stack first, so the trace is unchanged. In a subshell
# this exits only the subshell, exactly as the errexit abort did before.
# Usage: fail "something went wrong"
fail() {
    print_error "$1"
    local frame=1
    local line
    while line=$(caller $frame 2>/dev/null); do
        echo "  $line" >&2
        ((frame++))
    done
    exit 1
}

# Assert that a command succeeds; if it fails, print the message and exit.
# Uses set +e/set -e to avoid errexit interference on the LHS of ||.
# Usage: assert "descriptive failure message" command arg1 arg2 ...
assert() {
    local msg="$1"; shift
    set +e
    "$@"
    local rc=$?
    set -e
    [ $rc -eq 0 ] || fail "$msg"
}

# ============================================================================
# Cloud Credential Helpers
# ============================================================================

# Check AWS credentials and build credentials JSON.
# Sets AWS_CREDENTIALS_JSON on success, exits on failure.
require_aws_credentials() {
    if [ -z "$AWS_ACCESS_KEY_ID" ] || [ -z "$AWS_SECRET_ACCESS_KEY" ]; then
        print_info "Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY"
        fail "AWS credentials not found in environment"
    fi
    print_success "AWS credentials found"

    AWS_CREDENTIALS_JSON=$(jq -n \
      --arg accessKeyId "$AWS_ACCESS_KEY_ID" \
      --arg secretAccessKey "$AWS_SECRET_ACCESS_KEY" \
      --arg sessionToken "${AWS_SESSION_TOKEN:-}" \
      '{
        "aws-test": ({
          cloudProvider: "AWS",
          accessKeyId: $accessKeyId,
          secretAccessKey: $secretAccessKey
        } + (if $sessionToken != "" then {sessionToken: $sessionToken} else {} end))
      }')
}

# Check Azure credentials and build credentials JSON.
# Sets AZURE_CREDENTIALS_JSON on success, exits on failure.
require_azure_credentials() {
    if [ -z "$AZURE_CLIENT_ID" ] || [ -z "$AZURE_CLIENT_SECRET" ] || [ -z "$AZURE_TENANT_ID" ] || [ -z "$AZURE_SUBSCRIPTION_ID" ]; then
        print_info "Please set AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID, and AZURE_SUBSCRIPTION_ID"
        fail "Azure credentials not found in environment"
    fi
    print_success "Azure credentials found"

    AZURE_CREDENTIALS_JSON=$(cat <<EOF
{
  "azure-test": {
    "cloudProvider": "Azure",
    "applicationId": "$AZURE_CLIENT_ID",
    "secret": "$AZURE_CLIENT_SECRET",
    "directoryId": "$AZURE_TENANT_ID",
    "subscriptionId": "$AZURE_SUBSCRIPTION_ID"
  }
}
EOF
)
}

# Check Lambda credentials and build credentials JSON.
# Sets LAMBDA_CREDENTIALS_JSON on success, exits on failure.
require_lambda_credentials() {
    if [ -z "$LAMBDA_API_KEY" ]; then
        print_info "Please set LAMBDA_API_KEY"
        fail "Lambda credentials not found in environment"
    fi
    print_success "Lambda credentials found"

    LAMBDA_CREDENTIALS_JSON=$(cat <<EOF
{
  "lambda-test": {
    "cloudProvider": "Lambda",
    "apiKey": "$LAMBDA_API_KEY"
  }
}
EOF
)
}

# Validate the Azure client secret without touching any resources.
# Missing or rejected credentials fail the selected test before provisioning.
azure_auth_preflight() {
    node --input-type=module <<'EOF'
import { ClientSecretCredential } from '@azure/identity';

const required = [
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_TENANT_ID',
  'AZURE_SUBSCRIPTION_ID',
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing Azure credentials: ${missing.join(', ')}`);
  process.exit(2);
}

function errorText(error) {
  const parts = [];
  if (error instanceof Error) {
    parts.push(error.name, error.message);
    if (error.stack) parts.push(error.stack);
  } else {
    parts.push(String(error));
  }
  if (error && typeof error === 'object') {
    for (const key of ['code', 'errorCode']) {
      const value = error[key];
      if (value !== undefined && value !== null) parts.push(String(value));
    }
  }
  return parts.filter(Boolean).join('\n');
}

try {
  const credential = new ClientSecretCredential(
    process.env.AZURE_TENANT_ID,
    process.env.AZURE_CLIENT_ID,
    process.env.AZURE_CLIENT_SECRET,
  );
  await credential.getToken('https://management.azure.com/.default');
} catch (error) {
  const text = errorText(error);
  const summary = text.split('\n').find((line) => line.trim().length > 0) ?? text;
  console.error(summary);
  process.exit(1);
}
EOF
}

# Check GCP credentials and build credentials JSON.
# Sets GCP_CREDENTIALS_JSON on success, exits on failure.
require_gcp_credentials() {
    if [ -z "$GCP_PROJECT_ID" ] || [ -z "$GCP_PRIVATE_KEY" ] || [ -z "$GCP_CLIENT_EMAIL" ]; then
        print_info "Please set GCP_PROJECT_ID, GCP_PRIVATE_KEY, and GCP_CLIENT_EMAIL"
        fail "GCP credentials not found in environment"
    fi
    print_success "GCP credentials found"

    GCP_CREDENTIALS_JSON=$(jq -n \
      --arg projectId "$GCP_PROJECT_ID" \
      --arg privateKey "$GCP_PRIVATE_KEY" \
      --arg clientEmail "$GCP_CLIENT_EMAIL" \
      '{
        "gcp-test": {
          cloudProvider: "GCP",
          projectId: $projectId,
          privateKey: $privateKey,
          clientEmail: $clientEmail
        }
      }')
}

# CLI helper: run any anycloud subcommand against $API_URL.
# Usage: cli <subcommand> [args...]   e.g. cli quota status --json
cli() {
    local cli_command=(node "$PROJECT_ROOT/dist/cli/index.js")
    if [ -n "${E2E_CANDIDATE_CLI:-}" ]; then
        cli_command=("$E2E_CANDIDATE_CLI")
    fi
    API_URL="$API_URL" \
        GITHUB_TOKEN="${GITHUB_TOKEN:-dummy-token-for-test}" \
        "${cli_command[@]}" "$@"
}

# CLI helper: submit a job with inline flags.
# Usage: cli_run [flags...] image
cli_run() {
    API_URL="$API_URL" \
        GITHUB_TOKEN="${GITHUB_TOKEN:-dummy-token-for-test}" \
        node "$PROJECT_ROOT/dist/cli/index.js" job "$@"
}

# Request direct SSH material and write the JSON response to a caller-owned file.
# Prints the HTTP status code on stdout.
# Usage: api_request_ssh_access <workload_id> <container|vm|snapshot> <output_file>
api_request_ssh_access() {
    local workload_id=$1
    local mode=$2
    local output_file=$3
    local version token http_code curl_exit

    version=$(jq -r .version "$PROJECT_ROOT/package.json")
    token=$(api_bearer "$API_URL" "${GITHUB_TOKEN:-dummy-token-for-test}") || return 1
    set +e
    http_code=$(curl -sS -o "$output_file" -w '%{http_code}' \
        "$API_URL/v1/workloads/$workload_id/ssh-access?mode=$mode" \
        -H "Authorization: Bearer $token" \
        -H "AnyCloud-Client-Version: $version")
    curl_exit=$?
    set -e
    if [ "$curl_exit" -ne 0 ]; then
        return "$curl_exit"
    fi

    printf '%s\n' "$http_code"
}

# Execute a non-interactive command using workload SSH-access material.
# Usage: ssh_exec_with_access <access_json_file> <command>
ssh_exec_with_access() {
    local access_file=$1
    local command=$2
    local private_key host port user key_file exit_code

    private_key=$(jq -er '.sshPrivateKey | select(type == "string" and length > 0)' "$access_file") || return 1
    host=$(jq -er '(.sshHost // .vmIp) | select(type == "string" and length > 0)' "$access_file") || return 1
    port=$(jq -er '(.sshPort // 22) | select(type == "number")' "$access_file") || return 1
    user=$(jq -er '(.sshUsername // "root") | select(type == "string" and length > 0)' "$access_file") || return 1

    key_file=$(mktemp "${TMPDIR:-/tmp}/anycloud-ssh-key.XXXXXX")
    chmod 600 "$key_file"
    printf '%s\n' "$private_key" > "$key_file"

    set +e
    ssh -i "$key_file" \
        -p "$port" \
        -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null \
        -o LogLevel=ERROR \
        -o ConnectTimeout=30 \
        -o ServerAliveInterval=15 \
        -o ServerAliveCountMax=3 \
        "${user}@${host}" \
        "$command"
    exit_code=$?
    set -e

    rm -f "$key_file"
    return "$exit_code"
}

_is_transient_cli_failure() {
    local output=$1
    echo "$output" | grep -Eqi \
        "anycloud API is temporarily unavailable|could not read /v1/version|timed out after [0-9]+ms|Premature close|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed"
}

# Run a CLI command and retry submit-time API/cloud connection flakes. Sets the
# global CLI_OUTPUT and CLI_EXIT variables to the final attempt, matching the
# open-coded capture pattern used by integration tests.
# Usage: run_cli_with_transient_retries <label> <cmd> [args...]
run_cli_with_transient_retries() {
    local label=$1
    shift
    local max_attempts=3 sleep_seconds=10 attempt=1

    while true; do
        set +e
        CLI_OUTPUT=$("$@" 2>&1)
        CLI_EXIT=$?
        set -e

        if [ "$CLI_EXIT" -eq 0 ] ||
            ! _is_transient_cli_failure "$CLI_OUTPUT" ||
            [ "$attempt" -ge "$max_attempts" ]; then
            return 0
        fi

        print_warning "$label hit a transient API/cloud failure on attempt ${attempt}/${max_attempts}; retrying in ${sleep_seconds}s..."
        echo "$CLI_OUTPUT" | tail -5
        sleep "$sleep_seconds"
        attempt=$((attempt + 1))
    done
}

# CLI helper: Execute a command in a workload.
# Usage: cli_exec [id] [--vm] "command"
# --vm is a test/diagnostic path for host-level assertions, implemented via
# the workload SSH-access resource so `anycloud exec` stays workload-only.
cli_exec() {
    if [ "$#" -ge 3 ] && [ "$2" = "--vm" ]; then
        local workload_id=$1
        shift 2
        cli_ssh_vm_exec "$workload_id" "$*"
        return $?
    fi

    API_URL="$API_URL" \
        GITHUB_TOKEN="${GITHUB_TOKEN:-dummy-token-for-test}" \
        node "$PROJECT_ROOT/dist/cli/index.js" exec "$@"
}

# Execute a non-interactive command on the host VM for integration diagnostics.
# Usage: cli_ssh_vm_exec <workload_id> "command"
cli_ssh_vm_exec() {
    local workload_id=$1
    local command=$2
    local response_file http_code exit_code

    response_file=$(mktemp)
    http_code=$(api_request_ssh_access "$workload_id" "vm" "$response_file") || {
        exit_code=$?
        rm -f "$response_file"
        return "$exit_code"
    }
    if [ "$http_code" != "200" ]; then
        cat "$response_file" >&2
        rm -f "$response_file"
        return 1
    fi

    set +e
    ssh_exec_with_access "$response_file" "$command"
    exit_code=$?
    set -e
    rm -f "$response_file"
    return "$exit_code"
}

# CLI helper: Get workload status (JSON). Mirrors StatusResponse shape.
# Usage: cli_status <id> [--json]
# Bash assertions scan the whole event history (`.events[]`), which the API no
# longer returns by default; --history asks for every event.
cli_status() {
    cli status --history "$@"
}

# CLI helper: stream a file in/out of a bucket via the API. Used by the per-cloud
# bucket helpers in place of `aws s3`, `gsutil`, and `az storage` so the
# integration suite dogfoods `anycloud bucket`.
# Usage: cli_bucket <list|upload|download|rm|exists|create|delete> <args...> [--region <r>]
cli_bucket() {
    if [ -z "$ANYCLOUD_BUCKET_CREDENTIAL" ]; then
        print_error "ANYCLOUD_BUCKET_CREDENTIAL must be set before calling cli_bucket"
        return 1
    fi
    local subcmd=$1
    shift
    API_URL="$API_URL" \
        GITHUB_TOKEN="${GITHUB_TOKEN:-dummy-token-for-test}" \
        node "$PROJECT_ROOT/dist/cli/index.js" bucket "$subcmd" \
            "$@" --credentials "$ANYCLOUD_BUCKET_CREDENTIAL"
}

# Save credentials to the API server via PUT /v1/credentials/{name}.
# Usage: setup_api_credentials "$credentials_json"
# The credentials_json is a map like {"aws-test": {"cloudProvider": "AWS", ...}}
setup_api_credentials() {
    local credentials_json="$1"
    local names
    names=$(echo "$credentials_json" | jq -r 'keys[]')
    for name in $names; do
        local body
        body=$(echo "$credentials_json" | jq --arg n "$name" '{name: $n} + .[$n]')
        if ! api_save_credential "$body" "dummy-token-for-test" > /dev/null; then
            fail "Failed to save credential '$name' via API (HTTP ${API_HTTP_STATUS:-000})"
        fi
    done
}

# NOTE: there's intentionally no per-test cleanup of API credentials.
# e2e.sh runs many tests in parallel against a single shared API server
# and they all register the same name ("aws-test", etc.). Per-test deletion
# would race: one test's cleanup wipes the row out from under a sibling
# that's still calling `cli_bucket`. The API container is destroyed at the
# end of the suite, taking the DB (and all test credentials) with it.

# The bearer the API at <url> takes, as the CLI chooses it: a loopback API's
# per-install token from ANYCLOUD_DIR, otherwise the given GitHub token.
# Usage: api_bearer <url> <github_token>
api_bearer() {
    local url
    url=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
    # The CLI's loopback rule (getLoopbackApiPort): http(s), any port or none.
    if [[ $url =~ ^https?://(localhost|127\.0\.0\.1|\[::1\])([:/]|$) ]]; then
        cat "${ANYCLOUD_DIR:-$HOME/.anycloud}/local-api-token"
    else
        printf '%s' "$2"
    fi
}

# Run one JSON API request and expose its result through API_HTTP_* globals.
# Keeping the response body off stdout lets callers decide whether an ambiguous
# response is safe to retry before emitting anything into command substitution.
# Usage: _api_http_once <method> <url> <token> [json_body] [max_time_seconds]
_api_http_once() {
    local method=$1
    local url=$2
    local token=$3
    local body=${4:-}
    local max_time=${5:-}
    local response_file headers_file version
    token=$(api_bearer "$url" "$token") || return 1
    version=$(api_client_version)
    response_file=$(mktemp)
    headers_file=$(mktemp)

    local curl_args=(
        -sS
        -D "$headers_file"
        -o "$response_file"
        -w "%{http_code}"
        -X "$method"
        -H "Authorization: Bearer $token"
        -H "AnyCloud-Client-Version: $version"
        -H "Accept: application/json"
    )
    if [ -n "$body" ]; then
        curl_args+=(
            -H "Content-Type: application/json"
            -d "$body"
        )
    fi
    if [ -n "$max_time" ]; then
        curl_args+=(--max-time "$max_time")
    fi

    if API_HTTP_STATUS=$(curl "${curl_args[@]}" "$url"); then
        API_HTTP_CURL_RC=0
    else
        API_HTTP_CURL_RC=$?
    fi
    API_HTTP_BODY=$(cat "$response_file")
    API_HTTP_CF_RAY=$(_api_http_header_value "$headers_file" "cf-ray")
    API_HTTP_CF_ERROR_TYPE=$(_api_http_header_value "$headers_file" "cf-error-type")
    API_HTTP_RETRY_AFTER=$(_api_http_header_value "$headers_file" "retry-after")
    API_HTTP_CF_ERROR_CODE=""
    API_HTTP_CF_ERROR_NAME=""
    if [ "$API_HTTP_STATUS" = "530" ]; then
        local cloudflare_error_candidate
        cloudflare_error_candidate=$(printf '%s\n' "$API_HTTP_BODY" \
            | jq -r 'if type == "object" then (.code // .error.code // empty) else empty end' \
                2>/dev/null || true)
        case "$cloudflare_error_candidate" in
            1???) API_HTTP_CF_ERROR_CODE=$cloudflare_error_candidate ;;
        esac
        if [ -z "$API_HTTP_CF_ERROR_CODE" ]; then
            API_HTTP_CF_ERROR_CODE=$(printf '%s\n' "$API_HTTP_BODY" \
                | grep -Eio 'error[[:space:]]+[0-9]{4}' \
                | head -n 1 \
                | grep -Eo '[0-9]{4}' || true)
        fi
        API_HTTP_CF_ERROR_NAME=$API_HTTP_CF_ERROR_TYPE
        if [ -z "$API_HTTP_CF_ERROR_NAME" ] && \
           [ "$API_HTTP_CF_ERROR_CODE" = "1016" ]; then
            API_HTTP_CF_ERROR_NAME=origin-dns
        fi
    fi
    rm -f "$response_file" "$headers_file"
}

_api_http_header_value() {
    local file=$1
    local name=$2
    awk -v target="$name" '
        BEGIN { target = tolower(target) }
        {
            line = $0
            sub(/\r$/, "", line)
            colon = index(line, ":")
            if (colon > 0 && tolower(substr(line, 1, colon - 1)) == target) {
                value = substr(line, colon + 1)
                sub(/^[[:space:]]+/, "", value)
            }
        }
        END { print value }
    ' "$file"
}

_api_http_is_success() {
    case "${API_HTTP_STATUS:-}" in
        2?? | 3??) return 0 ;;
        *) return 1 ;;
    esac
}

_api_http_is_server_error() {
    case "${API_HTTP_STATUS:-}" in
        5??) return 0 ;;
        *) return 1 ;;
    esac
}

_api_http_log_failure() {
    local label=$1
    local attempt=${2:-1}
    local max_attempts=${3:-1}
    local terminal=${4:-false}
    local printer=print_warning
    [ "$terminal" = true ] && printer=print_error

    if [ "${API_HTTP_CURL_RC:-0}" -ne 0 ]; then
        "$printer" "$label transport failure (curl ${API_HTTP_CURL_RC}, attempt ${attempt}/${max_attempts}) retryable=true" >&2
        return
    fi

    local details=""
    local retryable=false
    _api_http_is_server_error && retryable=true
    [ -n "${API_HTTP_CF_RAY:-}" ] && details="$details cf-ray=${API_HTTP_CF_RAY}"
    [ -n "${API_HTTP_CF_ERROR_TYPE:-}" ] && details="$details cf-error-type=${API_HTTP_CF_ERROR_TYPE}"
    [ -n "${API_HTTP_CF_ERROR_CODE:-}" ] && details="$details cloudflare-error-code=${API_HTTP_CF_ERROR_CODE}"
    [ -n "${API_HTTP_CF_ERROR_NAME:-}" ] && details="$details cloudflare-error-name=${API_HTTP_CF_ERROR_NAME}"
    [ -n "${API_HTTP_RETRY_AFTER:-}" ] && details="$details retry-after=${API_HTTP_RETRY_AFTER}"
    details="$details retryable=$retryable"
    "$printer" "$label returned HTTP ${API_HTTP_STATUS:-000} (attempt ${attempt}/${max_attempts})${details}" >&2
}

_api_http_failure_code() {
    if [ "${API_HTTP_CURL_RC:-0}" -ne 0 ]; then
        echo "$API_HTTP_CURL_RC"
        return
    fi
    # Match curl --fail's exit code for an HTTP >= 400 response.
    echo 22
}

# Save one credential through its canonical replacement resource.
# Authentication and client-version metadata are supplied as headers.
# Usage: api_save_credential <json_body> [token]
api_save_credential() {
    local body=$1
    local token="${2:-${GITHUB_TOKEN:-dummy-token-for-test}}"
    local name credential_body url
    name=$(printf '%s\n' "$body" | jq -er '.name') || {
        print_error "Credential save body is missing name" >&2
        return 1
    }
    credential_body=$(printf '%s\n' "$body" | jq 'del(.name)')
    url="$API_URL/v1/credentials/$name"

    _api_http_once PUT "$url" "$token" "$credential_body" 60
    if _api_http_is_success; then
        printf '%s\n' "$API_HTTP_BODY"
        return 0
    fi

    _api_http_log_failure "API credential save $url"
    if [ -n "$API_HTTP_BODY" ]; then
        printf 'Response body: %s\n' "$API_HTTP_BODY" >&2
    fi
    return "$(_api_http_failure_code)"
}

# Delete one credential through the canonical idempotent resource. The API
# returns 204 whether the credential existed or was already absent.
# Usage: api_delete_credential_idempotent <name> [token]
api_delete_credential_idempotent() {
    local name=$1
    local token="${2:-${GITHUB_TOKEN:-dummy-token-for-test}}"
    local url="$API_URL/v1/credentials/$name?force=true"

    _api_http_once DELETE "$url" "$token" "" 60
    if [ "$API_HTTP_CURL_RC" -eq 0 ] && [ "$API_HTTP_STATUS" = "204" ]; then
        return 0
    fi

    _api_http_log_failure "API credential delete $url"
    return "$(_api_http_failure_code)"
}

_api_http_retry_delay() {
    local fallback=${REMOTE_API_RETRY_DELAY_SECONDS:-5}
    local max_delay=${REMOTE_API_RETRY_MAX_DELAY_SECONDS:-30}
    local delay=$fallback
    if [[ "${API_HTTP_RETRY_AFTER:-}" =~ ^[0-9]+$ ]] && \
       [ "$API_HTTP_RETRY_AFTER" -gt "$delay" ]; then
        delay=$API_HTTP_RETRY_AFTER
    fi
    [ "$delay" -gt "$max_delay" ] && delay=$max_delay
    echo "$delay"
}

# GET is safe to retry after bounded transport failures or any server response.
# Capture Cloudflare diagnostics without dumping an arbitrary response body so
# a recurring edge/origin problem is actionable from the E2E artifact.
# Usage: api_get_with_cloudflare_retry <url> [max_attempts]
api_get_with_cloudflare_retry() {
    local url=$1
    local max_attempts=${2:-${REMOTE_API_GET_MAX_ATTEMPTS:-5}}
    local token="${GITHUB_TOKEN:-dummy-token-for-test}"
    local attempt=1

    while [ "$attempt" -le "$max_attempts" ]; do
        _api_http_once GET "$url" "$token" "" 60
        if _api_http_is_success; then
            printf '%s\n' "$API_HTTP_BODY"
            return 0
        fi

        local retryable=false
        if [ "$API_HTTP_CURL_RC" -ne 0 ] || _api_http_is_server_error; then
            retryable=true
        fi
        local terminal=false
        if [ "$retryable" != true ] || [ "$attempt" -ge "$max_attempts" ]; then
            terminal=true
        fi
        _api_http_log_failure \
            "Remote API GET $url" "$attempt" "$max_attempts" "$terminal"
        if [ "$terminal" = true ]; then
            return "$(_api_http_failure_code)"
        fi

        local delay
        delay=$(_api_http_retry_delay)
        sleep "$delay"
        attempt=$((attempt + 1))
    done
}

# Return 0 when a remote workload exists, 1 when the API authoritatively
# returns 404, and 2 when connectivity prevents a safe conclusion.
_remote_workload_presence() {
    local workload_id=$1
    local token=$2

    _api_http_once GET "$API_URL/v1/workloads/$workload_id" "$token" "" 60
    if _api_http_is_success; then
        return 0
    fi
    if [ "$API_HTTP_CURL_RC" -eq 0 ] && [ "$API_HTTP_STATUS" = "404" ]; then
        return 1
    fi

    _api_http_log_failure "Remote workload reconciliation for $workload_id"
    return 2
}

# Submit a workload whose caller-provided ID is its idempotency key. Any 5xx
# or transport failure is ambiguous, so query the workload before another POST.
# If a retry returns 409, reconcile once more: the first request may have won
# while its response was lost. Other HTTP errors remain terminal.
# Usage: api_submit_workload_reconciled <json_body>
api_submit_workload_reconciled() {
    local body=${1:-"{}"}
    local token workload_id
    local max_attempts reconcile_attempts retry_delay
    token="${GITHUB_TOKEN:-dummy-token-for-test}"
    workload_id=$(printf '%s\n' "$body" | jq -er '.id') || \
        fail "Reconciled workload request requires an explicit workload id"
    max_attempts=${REMOTE_API_SUBMIT_MAX_ATTEMPTS:-3}
    reconcile_attempts=${REMOTE_API_RECONCILE_ATTEMPTS:-6}
    retry_delay=${REMOTE_API_RETRY_DELAY_SECONDS:-5}

    local attempt=1
    local saw_ambiguous=false
    while [ "$attempt" -le "$max_attempts" ]; do
        _api_http_once POST "$API_URL/v1/workloads" "$token" "$body"
        local submission_status=$API_HTTP_STATUS
        local submission_curl_rc=$API_HTTP_CURL_RC
        local submission_cf_ray=$API_HTTP_CF_RAY
        local submission_cf_error_type=$API_HTTP_CF_ERROR_TYPE
        local submission_cf_error_code=$API_HTTP_CF_ERROR_CODE
        local submission_cf_error_name=$API_HTTP_CF_ERROR_NAME
        local submission_retry_after=$API_HTTP_RETRY_AFTER
        if _api_http_is_success; then
            printf '%s\n' "$API_HTTP_BODY"
            return 0
        fi

        local ambiguous=false
        if [ "$API_HTTP_CURL_RC" -ne 0 ] || \
           _api_http_is_server_error; then
            ambiguous=true
            saw_ambiguous=true
        elif [ "$API_HTTP_STATUS" = "409" ] && [ "$saw_ambiguous" = true ]; then
            ambiguous=true
        fi

        local terminal=false
        if [ "$ambiguous" != true ]; then
            terminal=true
        fi
        _api_http_log_failure "Remote API POST /v1/workloads for $workload_id" \
            "$attempt" "$max_attempts" "$terminal"
        if [ "$ambiguous" != true ]; then
            return "$(_api_http_failure_code)"
        fi

        local reconcile_attempt=1
        local confirmed_absent=0
        while [ "$reconcile_attempt" -le "$reconcile_attempts" ]; do
            local presence_rc
            if _remote_workload_presence "$workload_id" "$token"; then
                presence_rc=0
            else
                presence_rc=$?
            fi
            if [ "$presence_rc" -eq 0 ]; then
                print_info "Remote workload $workload_id exists; accepting the ambiguous submission" >&2
                jq -nc --arg id "$workload_id" '{id: $id}'
                return 0
            fi
            [ "$presence_rc" -eq 1 ] && confirmed_absent=$((confirmed_absent + 1))
            if [ "$reconcile_attempt" -lt "$reconcile_attempts" ]; then
                sleep "$retry_delay"
            fi
            reconcile_attempt=$((reconcile_attempt + 1))
        done

        # A duplicate response after an ambiguous request must never trigger a
        # third POST. If status cannot find it, preserve the 409 as a failure.
        if [ "$submission_status" = "409" ] || \
           [ "$confirmed_absent" -lt 2 ] || \
           [ "$attempt" -ge "$max_attempts" ]; then
            API_HTTP_STATUS=$submission_status
            API_HTTP_CURL_RC=$submission_curl_rc
            API_HTTP_CF_RAY=$submission_cf_ray
            API_HTTP_CF_ERROR_TYPE=$submission_cf_error_type
            API_HTTP_CF_ERROR_CODE=$submission_cf_error_code
            API_HTTP_CF_ERROR_NAME=$submission_cf_error_name
            API_HTTP_RETRY_AFTER=$submission_retry_after
            _api_http_log_failure \
                "Remote API POST /v1/workloads for $workload_id could not be reconciled" \
                "$attempt" "$max_attempts" true
            if [ "$submission_curl_rc" -ne 0 ]; then
                return "$submission_curl_rc"
            fi
            return 22
        fi

        print_info "Remote workload $workload_id is still absent; retrying submission" >&2
        sleep "$retry_delay"
        attempt=$((attempt + 1))
    done
}

# Get the current workload state from the CLI (via `status --json`).
# Usage: api_get_state <workload_id>
# Returns: state string (e.g. "running", "completed") on stdout, or empty on error
api_get_state() {
    cli_status "$1" --json | jq -r '.events[-1].state // empty'
}

# Get the newest live VM cloud ID from the API DB.
# Usage: api_get_cloud_id <workload_id> [max_wait_seconds]
# max_wait_seconds bounds the live-VM-row poll (defaults to 60 via
# api_get_live_vm_metadata). Pass a small value on cleanup paths where a missing
# row should fail fast instead of polling the full default.
api_get_cloud_id() {
    api_get_live_vm_metadata "$1" "$2" | jq -r '.cloud_id // empty'
}

# Look up the GCP zone for an instance by name.
# Usage: get_gcp_zone <instance_name>
get_gcp_zone() {
    local instance_name=$1
    gcloud compute instances list \
        --project="$GCP_PROJECT_ID" \
        --filter="name=${instance_name}" \
        --format="value(zone)" 2>/dev/null
}

# Get the resolved region from the newest live VM DB row.
# Usage: api_get_region <workload_id>
api_get_region() {
    api_get_live_vm_metadata "$1" | jq -r '.region // empty'
}

# Read the newest live VM row directly from the API DB. Used by e2e tests when
# they only need provider metadata and must not pay for full status health checks.
api_get_live_vm_metadata() {
    local workload_id=$1
    local max_wait=${2:-60}
    local elapsed=0
    local last_output=""
    local escaped_id=${workload_id//\'/\'\'}
    local sql="SELECT cloud_id, ip, region, ssh_host, ssh_port, ssh_username, base_image_id FROM vms WHERE workload_id = '$escaped_id' AND ended_at IS NULL AND ip IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1"

    while [ $elapsed -lt $max_wait ]; do
        set +e
        local output
        output=$(API_URL="$API_URL" \
            GITHUB_TOKEN="${GITHUB_TOKEN:-dummy-token-for-test}" \
            node "$PROJECT_ROOT/dist/cli/index.js" db query --json "$sql" 2>&1)
        local exit_code=$?
        set -e

        if [ $exit_code -eq 0 ]; then
            local row
            row=$(echo "$output" | jq -c '.rows[0] // empty' 2>/dev/null) || row=""
            if [ -n "$row" ] && [ "$row" != "null" ]; then
                echo "$row"
                return 0
            fi
        fi

        last_output="$output"
        sleep 5
        elapsed=$((elapsed + 5))
        progress_tick
    done

    if [ -n "$last_output" ]; then
        echo "$last_output" >&2
    fi
    return 1
}

# Count live VMs via `status --json`.
# Usage: api_count_vms <workload_id>
api_count_vms() {
    local status
    status=$(cli_status "$1" --json) || return $?
    printf '%s\n' "$status" \
        | jq '[.vms[]? | select(.endedAt == null)] | length'
}

# Count every live cleanup target through the API's read-only database route.
# Unlike status.vms, the provisioning ledger includes rows whose IP is still
# null after an in-flight or failed provisioning attempt.
# Usage: api_count_cleanup_targets <workload_id>...
api_count_cleanup_targets() {
    local workload_id escaped_id
    local quoted_ids=()
    for workload_id in "$@"; do
        [ -n "$workload_id" ] || continue
        # Keep the expansion unquoted: Bash 3.2 otherwise preserves the
        # backslashes used to escape the SQL single quotes.
        escaped_id=${workload_id//\'/\'\'}
        quoted_ids+=("'$escaped_id'")
    done
    if [ "${#quoted_ids[@]}" -eq 0 ]; then
        printf '0\n'
        return 0
    fi

    local IFS=,
    local sql="SELECT COUNT(*) AS count FROM vms WHERE ended_at IS NULL AND workload_id IN (${quoted_ids[*]})"
    local output

    if ! output=$(cli db query --json "$sql" 2>&1); then
        printf '%s\n' "$output" >&2
        return 1
    fi

    printf '%s\n' "$output" \
        | jq -er '
            if (.rows | type) != "array" or (.rows | length) == 0 or
                (.rows[0].count | type) != "number" then
              error("cleanup ledger response missing numeric count")
            else
              .rows[0].count
            end
          '
}

# Wait until the selected workloads have no live provisioning-ledger rows.
# One aggregate API query is issued per cycle regardless of workload count.
# Inspection errors remain unresolved instead of being mistaken for cleanup.
# Usage:
#   wait_for_workloads_no_live_vms_until <deadline-epoch-seconds> <id>...
wait_for_workloads_no_live_vms_until() {
    if [ "$#" -lt 1 ]; then
        print_error "VM cleanup wait requires an absolute deadline"
        return 1
    fi

    local deadline_epoch=$1
    shift
    if ! [[ "$deadline_epoch" =~ ^[0-9]+$ ]]; then
        print_error "VM cleanup deadline must be a non-negative integer"
        return 1
    fi

    local workload_ids=()
    local workload_id
    for workload_id in "$@"; do
        [ -n "$workload_id" ] && workload_ids+=("$workload_id")
    done
    [ "${#workload_ids[@]}" -gt 0 ] || return 0

    local started_at current_epoch last_log_at remaining sleep_seconds
    local count_output last_result="cleanup ledger was not checked"
    started_at=$(date +%s)
    last_log_at=$started_at

    while true; do
        if count_output=$(api_count_cleanup_targets "${workload_ids[@]}" 2>&1); then
            if ! [[ "$count_output" =~ ^[0-9]+$ ]]; then
                last_result="invalid live cleanup-target count"
            elif [ "$count_output" -eq 0 ]; then
                return 0
            else
                last_result="$count_output live cleanup target(s)"
            fi
        else
            count_output=$(printf '%s' "$count_output" | tr '\n' ' ' | cut -c1-200)
            last_result="ledger inspection failed${count_output:+ ($count_output)}"
        fi

        current_epoch=$(date +%s)
        if [ "$current_epoch" -ge "$deadline_epoch" ]; then
            break
        fi

        if [ $((current_epoch - last_log_at)) -ge 30 ]; then
            print_info "Still waiting for VM cleanup... ($((current_epoch - started_at))s elapsed, $last_result)"
            last_log_at=$current_epoch
        fi

        remaining=$((deadline_epoch - current_epoch))
        sleep_seconds=5
        [ "$remaining" -lt "$sleep_seconds" ] && sleep_seconds=$remaining
        sleep "$sleep_seconds"
        progress_tick
    done

    print_error "VM cleanup deadline reached: $last_result"
    return 1
}

# Wait until a workload has no live VMs recorded (every VM row has ended_at set).
# ended_at is written by the backend's softDeleteVMs, which runs LAST in terminateStep —
# after BOTH terminateVMs AND terminateNetworking (NSG/VNet). That ordering is deliberate:
# VM rows stay un-ended until the whole teardown succeeds, so cleanup reconciliation
# (which discovers workloads with un-ended attempts) keeps retrying. Azure networking teardown
# can hit multi-minute "in-use/reserved" retry tails, so this wait must not give up before the
# backend's own per-attempt budget or it false-fails during normal-but-slow cleanup. The
# default aligns with TERMINATION_TIMEOUT_MS (45m, src/api/config.ts).
# Usage: wait_for_no_live_vms <workload_id> [max_wait_seconds]
wait_for_no_live_vms() {
    local workload_id=$1
    local max_wait=${2:-2700}
    if ! [[ "$max_wait" =~ ^[0-9]+$ ]]; then
        print_error "VM cleanup wait must be a non-negative integer"
        return 1
    fi

    local deadline_epoch=$(( $(date +%s) + max_wait ))
    wait_for_workloads_no_live_vms_until \
        "$deadline_epoch" \
        "$workload_id"
}

# Get full status JSON via `status --json`.
# Usage: api_get_status <workload_id> [--verbose]
# Back-compat: a second arg of "true" maps to --verbose.
api_get_status() {
    local workload_id=$1
    shift || true

    local args=("--json")
    local arg
    for arg in "$@"; do
        case "$arg" in
            true)
                args+=("--verbose")
                ;;
            false|"")
                ;;
            *)
                args+=("$arg")
                ;;
        esac
    done

    cli_status "$workload_id" "${args[@]}"
}

# Terminate a workload via the CLI.
# Usage: api_terminate <workload_id>
# Returns: 0 on success, non-zero on failure
api_terminate() {
    cli terminate "$1" > /dev/null
}

mark_e2e_cleanup_workload_done() {
    local workload_id=$1
    [ -n "$workload_id" ] || return 0
    [ -n "${RESULTS_DIR:-}" ] || return 0

    # These Vitest contracts own native verification and release through the
    # Workload kernel. An outer-runner API-only retry cannot discharge a
    # registration they retained for missing or inconclusive native evidence.
    case "${E2E_IMPLEMENTATION:-}:${TEST_NAME:-}" in
        vitest:aws-vm|vitest:azure-vm|vitest:gcp-vm|vitest:lambda-vm|vitest:local-smolvm-vm|\
        vitest:aws-vm-host-loss|vitest:azure-vm-host-loss|vitest:gcp-vm-host-loss|vitest:lambda-vm-host-loss|vitest:local-smolvm-vm-host-loss|\
        vitest:aws-serve|vitest:azure-serve|vitest:gcp-serve|vitest:lambda-serve|\
        vitest:aws-gpu-serve|vitest:azure-gpu-serve|vitest:gcp-gpu-serve|vitest:lambda-gpu-serve|\
        vitest:aws-serve-upgrade|vitest:local-smolvm-serve|\
        vitest:local-held-job|vitest:local-completed-job|vitest:local-resubmitted-job|\
        vitest:aws-bucket-sync|vitest:azure-bucket-sync|vitest:gcp-bucket-sync|vitest:lambda-bucket-sync|\
        vitest:aws-concurrent-output|vitest:azure-concurrent-output|vitest:gcp-concurrent-output|\
        vitest:aws-invalid|vitest:azure-invalid|vitest:gcp-invalid|\
        vitest:aws-job-host-unreachable|vitest:azure-job-host-unreachable|vitest:gcp-job-host-unreachable|\
        vitest:aws-input-hydration-recovery|vitest:aws-spot-request-cleanup|vitest:aws-runtime-secrets|vitest:azure-runtime-secrets|vitest:gcp-runtime-secrets|vitest:lambda-runtime-secrets|vitest:aws-restricted-credential|vitest:azure-restricted-credential|\
        vitest:aws-host-docker|vitest:azure-host-docker|vitest:gcp-host-docker|\
        vitest:aws-spot-eviction|vitest:azure-spot-eviction|vitest:gcp-spot-eviction|vitest:azure-gpu-spot-eviction|\
        vitest:aws-gpu-probe-rerun|vitest:azure-gpu-probe-rerun|vitest:gcp-gpu-probe-rerun|vitest:lambda-gpu-probe-rerun|\
        vitest:aws-gpu-health-fault|vitest:azure-gpu-health-fault|vitest:gcp-gpu-health-fault|vitest:lambda-gpu-health-fault|\
        vitest:aws-mace-full-pull|vitest:azure-mace-full-pull|vitest:gcp-mace-full-pull|vitest:lambda-mace-full-pull|\
        vitest:gcp-disk-tier|vitest:azure-ghcr-probe)
            print_info "Retaining native verification tracking for candidate $workload_id"
            return 0
            ;;
    esac

    local manifest="$RESULTS_DIR/workloads-to-clean"
    [ -f "$manifest" ] || return 0

    local tmp="${manifest}.$$"
    grep -Fxv -- "$workload_id" "$manifest" > "$tmp" 2>/dev/null || true
    mv "$tmp" "$manifest"
}

cleanup_workload_via_api() {
    local workload_id=$1
    local wait_seconds=${2:-600}
    local term_exit wait_exit status_output
    local teardown_started teardown_elapsed

    [ -n "$workload_id" ] || return 0
    if [ -z "${API_URL:-}" ]; then
        print_warning "Cannot clean up $workload_id: API_URL is not set"
        return 1
    fi

    print_info "Capturing status before cleanup for $workload_id..."
    if status_output=$(api_get_status "$workload_id" true 2>&1); then
        [ -n "$status_output" ] && printf '%s\n' "$status_output"
    else
        print_warning "Could not capture pre-cleanup status for $workload_id"
    fi

    print_info "Terminating workload $workload_id..."
    teardown_started=$(date +%s)
    set +e
    api_terminate "$workload_id"
    term_exit=$?
    set -e
    if [ $term_exit -ne 0 ]; then
        print_warning "Terminate command failed for $workload_id (exit $term_exit)"
        return $term_exit
    fi

    print_info "Waiting for VM cleanup for $workload_id..."
    set +e
    wait_for_no_live_vms "$workload_id" "$wait_seconds"
    wait_exit=$?
    set -e
    if [ $wait_exit -ne 0 ]; then
        print_warning "VM cleanup did not finish for $workload_id (exit $wait_exit)"
        return $wait_exit
    fi

    # How long teardown took, not just that it eventually happened. A teardown
    # that overruns is billed at the full VM rate and holds the capacity the
    # next run needs, so "cleaned up within the 45-minute ceiling" is not the
    # same as healthy. Opt-in per provider: the ceiling in wait_seconds has to
    # stay generous for Azure's multi-minute networking retry tail, which would
    # false-fail any bound tight enough to be meaningful elsewhere.
    teardown_elapsed=$(( $(date +%s) - teardown_started ))
    print_info "Teardown for $workload_id took ${teardown_elapsed}s"
    if [ -n "${E2E_TEARDOWN_MAX_SECONDS:-}" ] && \
        [ "$teardown_elapsed" -gt "$E2E_TEARDOWN_MAX_SECONDS" ]; then
        print_error "Teardown for $workload_id took ${teardown_elapsed}s, over the ${E2E_TEARDOWN_MAX_SECONDS}s budget"
        return 1
    fi

    mark_e2e_cleanup_workload_done "$workload_id"
    print_success "Workload $workload_id cleaned up"
    return 0
}

# A local API reads this per-install token at boot. `anycloud api start` writes
# it for users; harnesses that start the API themselves write it here.
# Usage: ensure_local_api_token <anycloud_dir>
ensure_local_api_token() {
    local file="$1/local-api-token"
    mkdir -p "$1"
    [ -f "$file" ] && return 0
    node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" > "$file"
    chmod 600 "$file"
}

# Start API server for tests
# Usage: start_api <port> <log_file>
# Returns: API_PID variable set
start_api() {
    local port=$1
    local log_file=$2
    ensure_local_api_token "${ANYCLOUD_DIR:?start_api needs ANYCLOUD_DIR}"

    PORT=$port CIPHER_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef node ./dist/api/server.js > "$log_file" 2>&1 &
    API_PID=$!
    print_info "API PID: $API_PID"
    print_info "API log: $log_file"
}

# Wait for workload to reach a target state
# Usage: wait_for_workload_state <workload_id> <target_state> <max_wait_seconds> [<temp_config_dir> <project_root>]
# The last two args are kept for backward compatibility but ignored (API calls don't need them).
# Returns: 0 on success, 1 on failure or timeout
wait_for_workload_state() {
    local workload_id=$1
    local target_state=$2  # e.g., "running", "terminated"
    local max_wait=$3
    local elapsed=0

    while [ $elapsed -lt $max_wait ]; do
        local current_state
        current_state=$(api_get_state "$workload_id") || true

        # Empty state means API returned an error (workload not found, etc.)
        if [ -z "$current_state" ]; then
            if [ "$target_state" = "terminated" ]; then
                # Workload not found = successfully terminated
                return 0
            fi
            if [ $elapsed -ge 60 ]; then
                print_error "Workload not found after ${elapsed}s - may have been deleted or never created"
                return 1
            fi
            # Transient during concurrent workloads - keep waiting
            sleep 2
            elapsed=$((elapsed + 2))
            progress_tick
            continue
        fi

        if [ "$current_state" = "$target_state" ]; then
            return 0
        elif [ "$current_state" = "errored" ]; then
            print_error "Workload errored (current state: $current_state)"
            return 1
        elif [ "$current_state" = "failed" ] || \
             [ "$current_state" = "invalid" ] || \
             { [ "$current_state" = "terminated" ] && [ "$target_state" != "terminated" ]; }; then
            print_error "Workload reached terminal state: $current_state (target was: $target_state)"
            return 1
        fi

        # Debug: Show state every 30 seconds
        if [ $((elapsed % 30)) -eq 0 ] && [ $elapsed -gt 0 ]; then
            echo ""
            local debug_msg="Still waiting for $target_state... (${elapsed}s elapsed, current: ${current_state:-checking})"
            # When stuck retrying, show the error reason so we can diagnose flakes
            if [ "$current_state" = "retrying" ] || [ "$current_state" = "recovering" ]; then
                local last_error
                last_error=$(cli_status "$workload_id" --json 2>/dev/null \
                    | jq -c '.events | map(select(.state == "retrying" or .state == "recovering")) | last | .metadata | {diagnosis: (.diagnosis // .errorKind), disposition, error: (.error.message // .error // .reason // "unknown")}' 2>/dev/null) || true
                if [ -n "$last_error" ] && [ "$last_error" != "null" ]; then
                    debug_msg="$debug_msg — $last_error"
                fi
            fi
            print_info "$debug_msg"
        fi

        sleep 2
        elapsed=$((elapsed + 2))
        progress_tick
    done

    echo ""
    print_error "Workload did not reach $target_state within ${max_wait}s"
    # Dump last events on timeout for CI debugging
    local timeout_status
    timeout_status=$(cli_status "$workload_id" --json 2>/dev/null) || true
    if [ -n "$timeout_status" ]; then
        local last_events
        last_events=$(echo "$timeout_status" | jq -c '[.events[-3:][] | {state, metadata}]' 2>/dev/null) || true
        if [ -n "$last_events" ]; then
            print_info "Last events: $last_events"
        fi
    fi
    return 1
}


# Wait for a process to be ready by checking HTTP endpoint
# Usage: wait_for_http <url> <max_attempts> <description> [header]
# Note: Accepts any valid HTTP response (2xx-5xx) which indicates server is running
# Optional 4th parameter: custom header (e.g. "Metadata-Flavor: Google")
wait_for_http() {
    local url=$1
    local max_attempts=${2:-30}
    local description=${3:-"service"}
    local header=${4:-""}
    local attempt=1

    while [ $attempt -le $max_attempts ]; do
        # Accept any HTTP response code (even errors) - just need server to be responding
        # This includes 200 (OK), 401 (Unauthorized), 404 (Not Found), 500 (Server Error), etc.
        local curl_cmd="curl -s -k -o /dev/null -w %{http_code}"
        if [ -n "$header" ]; then
            curl_cmd="$curl_cmd -H \"$header\""
        fi
        curl_cmd="$curl_cmd \"$url\" 2>/dev/null || echo \"000\""

        # A refused connection makes curl emit "000" (and the `|| echo 000`
        # above can double it to "000000"), so treat any string containing
        # "000" — or an empty one — as "not up yet". A real HTTP code (200,
        # 404, 500, ...) never contains "000".
        local http_code=$(eval $curl_cmd)
        case "$http_code" in
            "" | *000*) ;;
            *)
                # Double-check server is stable by making a second request
                sleep 0.5
                local http_code2=$(eval $curl_cmd)
                case "$http_code2" in
                    "" | *000*) ;;
                    *) return 0 ;;
                esac
                ;;
        esac
        sleep 1
        attempt=$((attempt + 1))
    done

    echo "   ✗ Timeout waiting for $description to be ready"
    return 1
}

# Wait for a public serve URL to return the expected body marker(s).
# Usage: wait_for_public_http <url> <max_wait_seconds> <marker> [marker...]
wait_for_public_http() {
    local url=$1
    local max_wait=${2:-300}
    local markers=("${@:3}")
    local elapsed=0
    local body=""
    local err_file="/tmp/serve-curl-error.$$.$RANDOM"
    local last_missing=""

    while [ $elapsed -lt "$max_wait" ]; do
        set +e
        body=$(curl -fsS --max-time 15 "$url" 2>"$err_file")
        local curl_rc=$?
        set -e
        if [ $curl_rc -eq 0 ]; then
            local missing=()
            local expected
            for expected in "${markers[@]}"; do
                if ! printf '%s\n' "$body" | grep -Fq "$expected"; then
                    missing+=("$expected")
                fi
            done
            if [ ${#missing[@]} -eq 0 ]; then
                rm -f "$err_file"
                print_success "Public URL returned expected marker(s): $url"
                return 0
            fi
            last_missing="${missing[*]}"
        fi
        sleep 5
        elapsed=$((elapsed + 5))
        progress_tick
    done

    echo ""
    print_error "Last curl error:"
    cat "$err_file" 2>/dev/null || true
    if [ -n "$last_missing" ]; then
        print_error "Last missing marker(s): $last_missing"
    fi
    if [ -n "$body" ]; then
        print_error "Last response body:"
        printf '%s\n' "$body"
    fi
    rm -f "$err_file"
    return 1
}

# Remove an ANYCLOUD_DIR that may contain root-owned files from Docker.
# Usage: cleanup_anycloud_dir <dir>
cleanup_anycloud_dir() {
    local dir=$1
    [ -z "$dir" ] && return
    docker run --rm -v "$dir:/data" \
        'mirror.gcr.io/library/alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce' \
        rm -rf /data 2>/dev/null || true
    rm -rf "$dir" 2>/dev/null || true
}

# Kill process on port
# Usage: kill_port <port>
kill_port() {
    local port=$1
    local pids=$(lsof -t -i ":$port" 2>/dev/null)
    if [ -n "$pids" ]; then
        echo "$pids" | xargs kill -9 2>/dev/null || true
        print_info "Killed processes on port $port"
    fi
}

