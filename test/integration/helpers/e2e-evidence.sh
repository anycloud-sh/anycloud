#!/usr/bin/env bash

# Shared evidence protocol for the isolated Bash and constrained Vitest runners.
# Callers provide PROJECT_ROOT, RESULTS_DIR, TEST_NAME, E2E_IMPLEMENTATION,
# LOG_FILE, TEST_COMMAND_DESCRIPTION, and RUNNER_START_SECONDS.

E2E_EVIDENCE_TRIAGED=false

# Execute once and preserve every nonzero status, including legacy exit 77.
# Both runners use this path, so no caller can opt into successful skips.
e2e_run_command() {
    local started=$SECONDS statuses rc duration
    if "$@" 2>&1 | tee "$LOG_FILE"; then
        statuses=("${PIPESTATUS[@]}")
    else
        statuses=("${PIPESTATUS[@]}")
    fi
    rc=${statuses[0]}
    # A missing log is also a failed run; never replace a failed test's status.
    if [ "$rc" -eq 0 ] && [ "${statuses[1]}" -ne 0 ]; then
        rc=${statuses[1]}
    fi
    if [ "$rc" -eq 124 ]; then
        printf 'Test command timed out\n' >> "$LOG_FILE"
    fi
    duration=$(( SECONDS - started ))
    e2e_write_run_record "$rc" "$duration" "$TEST_COMMAND_DESCRIPTION" || return 1
    e2e_write_joblog "$rc" "$duration" "$TEST_COMMAND_DESCRIPTION" || return 1
    return "$rc"
}

e2e_evidence_duration() {
    printf '%s\n' "$(( SECONDS - RUNNER_START_SECONDS ))"
}

e2e_write_joblog() {
    local exit_code=$1
    local duration_seconds=$2
    local description=$3
    printf 'Seq\tHost\tStarttime\tJobRuntime\tSend\tReceive\tExitval\tSignal\tCommand\n1\t:\t0\t%s\t0\t0\t%s\t0\t%s\n' \
        "$duration_seconds" "$exit_code" "$description" > "$RESULTS_DIR/joblog.txt"
}

e2e_write_run_record() {
    local exit_code=$1
    local duration_seconds=$2
    local description=$3
    npx tsx "$PROJECT_ROOT/test/integration/helpers/e2e-run-record.ts" \
        "$RESULTS_DIR" \
        "$TEST_NAME" \
        "$E2E_IMPLEMENTATION" \
        "$(basename "$LOG_FILE")" \
        "$exit_code" \
        "$duration_seconds" \
        "$description"
}

e2e_ensure_run_record() {
    local original_exit=$1
    if [ -f "$RESULTS_DIR/e2e-run.json" ]; then
        return 0
    fi

    local fallback_exit=$original_exit
    [ "$fallback_exit" -ne 0 ] || fallback_exit=1
    if [ ! -f "$LOG_FILE" ]; then
        printf 'Runner exited before the test command produced its evidence record.\n' > "$LOG_FILE"
    fi
    local duration_seconds
    duration_seconds=$(e2e_evidence_duration)
    e2e_write_run_record \
        "$fallback_exit" \
        "$duration_seconds" \
        "$TEST_COMMAND_DESCRIPTION" || return 1
    e2e_write_joblog \
        "$fallback_exit" \
        "$duration_seconds" \
        "$TEST_COMMAND_DESCRIPTION"
}

e2e_process_evidence() {
    local api_log=$1
    if [ "$E2E_EVIDENCE_TRIAGED" = true ]; then
        return 0
    fi
    E2E_API_LOG="$api_log" \
        npx tsx "$PROJECT_ROOT/test/integration/helpers/process-e2e-logs.ts" "$RESULTS_DIR" || return 1
    E2E_EVIDENCE_TRIAGED=true
}
