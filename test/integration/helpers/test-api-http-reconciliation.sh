#!/bin/bash

# Unit tests for Cloudflare-aware API reads and deterministic workload
# reconciliation in common.sh. Network calls are mocked at the single-request
# boundary so retry decisions stay fast and deterministic.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
export PROJECT_ROOT
source "$SCRIPT_DIR/common.sh"

PASSED=0
FAILED=0
MOCK_CALLS=$(mktemp)
MOCK_TOKEN=$(mktemp)
MOCK_BODY=$(mktemp)
trap 'rm -f "$MOCK_CALLS" "$MOCK_TOKEN" "$MOCK_BODY"' EXIT

pass() { echo "  PASS: $1"; PASSED=$((PASSED + 1)); }
fail_test() { echo "  FAIL: $1"; FAILED=$((FAILED + 1)); }

reset_mock() {
    MOCK_SCENARIO=$1
    : > "$MOCK_CALLS"
    : > "$MOCK_TOKEN"
    : > "$MOCK_BODY"
}

count_calls() {
    local pattern=$1
    grep -c "$pattern" "$MOCK_CALLS" 2>/dev/null || true
}

run_capture() {
    set +e
    TEST_OUTPUT=$("$@")
    TEST_RC=$?
    set -e
}

mock_response() {
    API_HTTP_CURL_RC=0
    API_HTTP_STATUS=$1
    API_HTTP_BODY=${2:-}
    API_HTTP_CF_RAY=${3:-}
    API_HTTP_CF_ERROR_TYPE=${4:-}
    API_HTTP_RETRY_AFTER=${5:-}
    API_HTTP_CF_ERROR_CODE=${6:-}
    API_HTTP_CF_ERROR_NAME=${7:-}
}

# Override the real curl boundary from common.sh.
_api_http_once() {
    local method=$1
    local url=$2
    local token=$3
    local body=${4:-}
    printf '%s %s\n' "$method" "$url" >> "$MOCK_CALLS"

    local submit_calls status_calls get_calls
    submit_calls=$(count_calls 'POST https://api.example.test/v1/workloads$')
    status_calls=$(count_calls 'GET https://api.example.test/v1/workloads/job-1$')
    get_calls=$(count_calls 'GET https://api.example.test/v1/credentials')

    case "$MOCK_SCENARIO" in
        get-retry)
            if [ "$get_calls" -eq 1 ]; then
                mock_response 522 '{}' ray-1 52x 120
            else
                mock_response 200 '{"name":"restored"}'
            fi
            ;;
        get-retry-530)
            if [ "$get_calls" -eq 1 ]; then
                mock_response 530 '<title>Error 1016</title>' ray-530 "" "" 1016 origin-dns
            else
                mock_response 200 '{"name":"restored"}'
            fi
            ;;
        get-retry-500)
            if [ "$get_calls" -eq 1 ]; then
                mock_response 500 '{"error":"temporary origin failure"}'
            else
                mock_response 200 '{"name":"restored"}'
            fi
            ;;
        get-exhausted-530)
            mock_response 530 '<title>Error 1016</title>' ray-terminal "" "" 1016 origin-dns
            ;;
        get-terminal)
            mock_response 401 '{"error":"Unauthorized"}'
            ;;
        submit-exists)
            if [ "$method" = POST ] && [[ "$url" == */v1/workloads ]]; then
                mock_response 530 '<title>Error 1016</title>' ray-2 "" "" 1016 origin-dns
            else
                mock_response 200 '{"workload":{"id":"job-1"}}'
            fi
            ;;
        submit-retry)
            if [ "$method" = POST ] && [[ "$url" == */v1/workloads ]]; then
                if [ "$submit_calls" -eq 1 ]; then
                    mock_response 522 '{}' ray-3 52x
                else
                    mock_response 200 '{"id":"job-1"}'
                fi
            else
                mock_response 404 '{"error":"Workload not found"}'
            fi
            ;;
        submit-duplicate)
            if [ "$method" = POST ] && [[ "$url" == */v1/workloads ]]; then
                if [ "$submit_calls" -eq 1 ]; then
                    mock_response 522 '{}' ray-4 52x
                else
                    mock_response 409 '{"error":"Workload already exists"}'
                fi
            elif [ "$status_calls" -le 2 ]; then
                mock_response 404 '{"error":"Workload not found"}'
            else
                mock_response 200 '{"workload":{"id":"job-1"}}'
            fi
            ;;
        submit-terminal)
            mock_response 400 '{"error":"invalid request"}'
            ;;
        save-credential)
            printf '%s' "$token" > "$MOCK_TOKEN"
            printf '%s' "$body" > "$MOCK_BODY"
            mock_response 204
            ;;
        save-credential-terminal)
            printf '%s' "$token" > "$MOCK_TOKEN"
            printf '%s' "$body" > "$MOCK_BODY"
            mock_response 400 '{"error":"Input validation failed"}'
            ;;
        delete-credential)
            printf '%s' "$token" > "$MOCK_TOKEN"
            mock_response 204
            ;;
        delete-credential-legacy)
            mock_response 200
            ;;
        *)
            mock_response 500 '{"error":"unknown mock scenario"}'
            ;;
    esac
}

export API_URL=https://api.example.test
export GITHUB_TOKEN=test-token
export REMOTE_API_GET_MAX_ATTEMPTS=2
export REMOTE_API_SUBMIT_MAX_ATTEMPTS=2
export REMOTE_API_RECONCILE_ATTEMPTS=2
export REMOTE_API_RETRY_DELAY_SECONDS=0
export REMOTE_API_RETRY_MAX_DELAY_SECONDS=0

echo "======================================="
echo "Testing remote API HTTP reconciliation"
echo "======================================="

echo ""
echo "1. Safe GET retries a Cloudflare 522"
reset_mock get-retry
run_capture api_get_with_cloudflare_retry \
    "https://api.example.test/v1/credentials/restored"
if [ "$TEST_RC" -eq 0 ] && [ "$TEST_OUTPUT" = '{"name":"restored"}' ]; then
    pass "GET returns the successful retry body"
else
    fail_test "GET retry failed (rc=$TEST_RC output=$TEST_OUTPUT)"
fi
if [ "$(count_calls 'GET https://api.example.test/v1/credentials')" -eq 2 ]; then
    pass "GET retried exactly once"
else
    fail_test "GET did not retry exactly once"
fi

echo ""
echo "2. Safe GET does not retry a terminal application response"
reset_mock get-terminal
run_capture api_get_with_cloudflare_retry \
    "https://api.example.test/v1/credentials/restored"
if [ "$TEST_RC" -eq 22 ] && \
   [ "$(count_calls 'GET https://api.example.test/v1/credentials')" -eq 1 ]; then
    pass "GET preserves terminal HTTP failure"
else
    fail_test "terminal GET was retried or returned the wrong status"
fi

echo ""
echo "3. Safe GET retries Cloudflare 530"
reset_mock get-retry-530
run_capture api_get_with_cloudflare_retry \
    "https://api.example.test/v1/credentials/restored"
if [ "$TEST_RC" -eq 0 ] && [ "$TEST_OUTPUT" = '{"name":"restored"}' ] && \
   [ "$(count_calls 'GET https://api.example.test/v1/credentials')" -eq 2 ]; then
    pass "GET retries a transient Cloudflare 530 exactly once"
else
    fail_test "Cloudflare 530 was not retried safely"
fi

echo ""
echo "4. Safe GET retries a generic server failure"
reset_mock get-retry-500
run_capture api_get_with_cloudflare_retry \
    "https://api.example.test/v1/credentials/restored"
if [ "$TEST_RC" -eq 0 ] && [ "$TEST_OUTPUT" = '{"name":"restored"}' ] && \
   [ "$(count_calls 'GET https://api.example.test/v1/credentials')" -eq 2 ]; then
    pass "GET retries a generic HTTP 500 exactly once"
else
    fail_test "generic server failure was not retried safely"
fi

echo ""
echo "5. Exhausted GET failures are explicit and structured"
reset_mock get-exhausted-530
set +e
TEST_OUTPUT=$(api_get_with_cloudflare_retry \
    "https://api.example.test/v1/credentials/restored" 2 2>&1)
TEST_RC=$?
set -e
if [ "$TEST_RC" -eq 22 ] && \
   [ "$(count_calls 'GET https://api.example.test/v1/credentials')" -eq 2 ] && \
   [[ "$TEST_OUTPUT" == *'✗ Remote API GET'* ]] && \
   [[ "$TEST_OUTPUT" == *'HTTP 530'* ]] && \
   [[ "$TEST_OUTPUT" == *'cloudflare-error-code=1016'* ]] && \
   [[ "$TEST_OUTPUT" == *'retryable=true'* ]]; then
    pass "terminal GET failure is loud and preserves safe diagnostics"
else
    fail_test "terminal GET failure was quiet or lost diagnostics"
fi

echo ""
echo "6. Ambiguous submit accepts a workload found by reconciliation"
reset_mock submit-exists
run_capture api_submit_workload_reconciled '{"id":"job-1"}'
if [ "$TEST_RC" -eq 0 ] && [ "$(echo "$TEST_OUTPUT" | jq -r .id)" = job-1 ] && \
   [ "$(count_calls 'POST https://api.example.test/v1/workloads$')" -eq 1 ] && \
   [ "$(count_calls 'GET https://api.example.test/v1/workloads/job-1$')" -eq 1 ]; then
    pass "existing workload prevents a duplicate POST"
else
    fail_test "existing workload was not reconciled safely"
fi

echo ""
echo "7. Ambiguous submit retries only after repeated authoritative 404s"
reset_mock submit-retry
run_capture api_submit_workload_reconciled '{"id":"job-1"}'
if [ "$TEST_RC" -eq 0 ] && [ "$(echo "$TEST_OUTPUT" | jq -r .id)" = job-1 ] && \
   [ "$(count_calls 'POST https://api.example.test/v1/workloads$')" -eq 2 ] && \
   [ "$(count_calls 'GET https://api.example.test/v1/workloads/job-1$')" -eq 2 ]; then
    pass "confirmed absence permits one retry"
else
    fail_test "confirmed absence did not produce one safe retry"
fi

echo ""
echo "8. A retry collision reconciles the first request instead of posting again"
reset_mock submit-duplicate
run_capture api_submit_workload_reconciled '{"id":"job-1"}'
if [ "$TEST_RC" -eq 0 ] && [ "$(echo "$TEST_OUTPUT" | jq -r .id)" = job-1 ] && \
   [ "$(count_calls 'POST https://api.example.test/v1/workloads$')" -eq 2 ] && \
   [ "$(count_calls 'GET https://api.example.test/v1/workloads/job-1$')" -eq 3 ]; then
    pass "409 after ambiguity resolves through status"
else
    fail_test "409 reconciliation failed or sent another POST"
fi

echo ""
echo "9. Terminal submit responses are not retried"
reset_mock submit-terminal
run_capture api_submit_workload_reconciled '{"id":"job-1"}'
if [ "$TEST_RC" -eq 22 ] && \
   [ "$(count_calls 'POST https://api.example.test/v1/workloads$')" -eq 1 ] && \
   [ "$(count_calls 'GET https://api.example.test/v1/workloads/job-1$')" -eq 0 ]; then
    pass "terminal submission stays terminal"
else
    fail_test "terminal submission was retried or reconciled"
fi

echo ""
echo "10. Credential saves keep authentication out of the request body"
credential_body=$(jq -nc '{name:"rec-state",cloudProvider:"AWS",accessKeyId:"AKIASTATE",secretAccessKey:"secret"}')
reset_mock save-credential
run_capture api_save_credential "$credential_body"
expected_credential_body=$(printf '%s\n' "$credential_body" | jq 'del(.name)')
if [ "$TEST_RC" -eq 0 ] && [ -z "$TEST_OUTPUT" ] && \
   [ "$(count_calls 'PUT https://api.example.test/v1/credentials/rec-state$')" -eq 1 ] && \
   [ "$(cat "$MOCK_TOKEN")" = "test-token" ] && \
   [ "$(cat "$MOCK_BODY")" = "$expected_credential_body" ]; then
    pass "credential identity is in the path and auth stays separate"
else
    fail_test "credential save changed the body or misplaced authentication"
fi

echo ""
echo "11. Credential validation failures include the response body"
reset_mock save-credential-terminal
set +e
TEST_OUTPUT=$(api_save_credential "$credential_body" 2>&1)
TEST_RC=$?
set -e
if [ "$TEST_RC" -eq 22 ] && \
   [ "$(count_calls 'PUT https://api.example.test/v1/credentials/rec-state$')" -eq 1 ] && \
   [[ "$TEST_OUTPUT" == *'HTTP 400'* ]] && \
   [[ "$TEST_OUTPUT" == *'Input validation failed'* ]]; then
    pass "credential failure exposes its HTTP status and response body"
else
    fail_test "credential failure hid its status or response body"
fi

echo ""
echo "12. Credential deletion requires the canonical idempotent 204"
reset_mock delete-credential
run_capture api_delete_credential_idempotent rec-state
if [ "$TEST_RC" -eq 0 ] && [ -z "$TEST_OUTPUT" ] && \
   [ "$(count_calls 'DELETE https://api.example.test/v1/credentials/rec-state?force=true$')" -eq 1 ] && \
   [ "$(cat "$MOCK_TOKEN")" = "test-token" ]; then
    pass "credential cleanup accepts the canonical 204"
else
    fail_test "credential cleanup did not use the canonical DELETE resource"
fi

reset_mock delete-credential-legacy
run_capture api_delete_credential_idempotent rec-state
if [ "$TEST_RC" -eq 22 ]; then
    pass "credential cleanup rejects the removed legacy 200 response"
else
    fail_test "credential cleanup silently preserved the legacy response"
fi

echo ""
echo "======================================="
echo "Results: $PASSED passed, $FAILED failed"
echo "======================================="

if [ "$FAILED" -gt 0 ]; then
    exit 1
fi
