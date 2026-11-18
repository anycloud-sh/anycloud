#!/usr/bin/env bash

# Run one constrained Vitest candidate that does not require a local API while
# still emitting the same evidence protocol as the isolated API-backed runner.

set -e

REQUESTED_TEST_NAME="${1:-}"
TEST_NAME="$REQUESTED_TEST_NAME"
SETUP_ERROR=""
if [ -z "$TEST_NAME" ]; then
    TEST_NAME="constrained-vitest-setup"
    SETUP_ERROR="usage: run-constrained-vitest.sh <test-name>"
elif ! [[ "$TEST_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    TEST_NAME="constrained-vitest-setup"
    SETUP_ERROR="invalid constrained Vitest test name: $REQUESTED_TEST_NAME"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

RESULTS_DIR="${RESULTS_DIR:-${E2E_RESULTS_ROOT:-/tmp}/e2e-results-${TEST_NAME}-vitest-$$}"
mkdir -p "$RESULTS_DIR"
export RESULTS_DIR
export E2E_ARTIFACT_DIR="$RESULTS_DIR/vitest-fixture"

E2E_IMPLEMENTATION="vitest"
export E2E_IMPLEMENTATION
LOG_FILE="$RESULTS_DIR/${TEST_NAME}-vitest.log"
TEST_COMMAND_DESCRIPTION="constrained Vitest runner setup for $TEST_NAME"
RUNNER_START_SECONDS=$SECONDS
source "$SCRIPT_DIR/helpers/e2e-evidence.sh"

finish_evidence() {
    local original_exit=$?
    trap - EXIT
    set +e
    local final_exit=$original_exit
    if [ ! -f "$RESULTS_DIR/e2e-run.json" ] && [ "$final_exit" -eq 0 ]; then
        final_exit=1
    fi
    e2e_ensure_run_record "$original_exit" || final_exit=1
    e2e_process_evidence "$RESULTS_DIR/api-not-applicable.log" || final_exit=1
    exit "$final_exit"
}
trap finish_evidence EXIT

if [ -n "$SETUP_ERROR" ]; then
    echo "$SETUP_ERROR" >&2
    exit 2
fi

VITEST_SPEC=""
while IFS= read -r candidate; do
    if [ -n "$VITEST_SPEC" ]; then
        echo "multiple constrained Vitest candidates are named ${TEST_NAME}.spec.ts" >&2
        exit 2
    fi
    VITEST_SPEC="$candidate"
done < <(find ./test/integration/e2e/specs -type f -name "${TEST_NAME}.spec.ts" -print)
if [ -z "$VITEST_SPEC" ]; then
    echo "no constrained Vitest candidate exists for $TEST_NAME" >&2
    exit 2
fi

TEST_COMMAND_DESCRIPTION="vitest $VITEST_SPEC"
e2e_run_command yarn -s vitest run --config vitest.e2e.config.mts "$VITEST_SPEC"
