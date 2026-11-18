#!/bin/bash

# Shared list helpers for the nuke harness. Normal visibility/measurement reads
# are strict; diagnostics and EXIT cleanup use the explicit best-effort wrapper.

nuke_list_json() {
    API_URL="$API_URL" IS_TEST=true GITHUB_TOKEN="${GITHUB_TOKEN:-dummy-token-for-test}" \
        node "$PROJECT_ROOT/dist/cli/index.js" list --json \
            --filter "nuke-${TEST_RUN}-" -n "$NUKE_COUNT"
}

nuke_list_json_best_effort() {
    # EXIT diagnostics must never outlive the cleanup drain when the API is
    # already overloaded. nuke.test.sh sources nuke-db.sh first, so reuse its
    # portable Node-based timeout instead of relying on GNU `timeout` (which is
    # absent on macOS). Keep the direct call for isolated helper consumers.
    if type nuke_db_run_with_timeout >/dev/null 2>&1; then
        nuke_db_run_with_timeout "${NUKE_DB_TIMEOUT_MS:-6000}" \
            env API_URL="$API_URL" IS_TEST=true GITHUB_TOKEN="${GITHUB_TOKEN:-dummy-token-for-test}" \
            node "$PROJECT_ROOT/dist/cli/index.js" list --json \
                --filter "nuke-${TEST_RUN}-" -n "$NUKE_COUNT" \
                2>/dev/null || printf '[]\n'
        return
    fi
    nuke_list_json 2>/dev/null || printf '[]\n'
}

nuke_list_snapshot() {
    local label="$1" destination="$2"
    if ! nuke_list_json > "$destination"; then
        fail "$label: nuke list request failed"
        return 1
    fi
    if ! jq -e 'type == "array"' "$destination" >/dev/null 2>&1; then
        fail "$label: nuke list returned malformed or non-array JSON"
        return 1
    fi
}
