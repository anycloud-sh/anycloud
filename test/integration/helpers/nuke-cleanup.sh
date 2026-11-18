#!/bin/bash

# Only harness-owned IDs, states and process IDs enter these retained records.
# The caller chooses a fresh run directory; incomplete writes never replace a
# complete record. Isolated library consumers can omit the record directory.
nuke_cleanup_record() {
    local name=$1
    shift
    [ -n "${NUKE_CLEANUP_RECORD_DIR:-}" ] || return 0
    mkdir -p "$NUKE_CLEANUP_RECORD_DIR" || return 1
    jq -cn "$@" > "$NUKE_CLEANUP_RECORD_DIR/$name.tmp" &&
        mv "$NUKE_CLEANUP_RECORD_DIR/$name.tmp" "$NUKE_CLEANUP_RECORD_DIR/$name"
}

nuke_ids_json() {
    jq -cn --args '$ARGS.positional' -- "$@"
}

# Retain a strict, caller-bound observation, never an arbitrary CLI/provider
# body or the diagnostic fallback []. Missing, duplicate and foreign rows fail.
nuke_capture_caller_inventory() {
    local cohort=$1 suffix=$2 inventory projection ids prefix="nuke-${TEST_RUN}-"
    [ "$cohort" = witness ] && prefix="nuke-witness-${TEST_RUN}-"
    shift 2
    ids=$(nuke_ids_json "$@") || return 1
    inventory='[]'
    if [ "$#" -gt 0 ]; then
        inventory=$(nuke_db_run_with_timeout "${NUKE_DB_TIMEOUT_MS:-6000}" \
            env API_URL="$API_URL" IS_TEST=true GITHUB_TOKEN="${GITHUB_TOKEN:-dummy-token-for-test}" \
            node "$PROJECT_ROOT/dist/cli/index.js" list --json \
                --filter "$prefix" -n "$#" 2>/dev/null) || return 1
    fi
    projection=$(printf '%s' "$inventory" | jq -ce --argjson ids "$ids" '
        ["queued", "provisioning", "initializing", "downloading", "syncing",
         "starting", "running", "retrying", "recovering", "finalizing",
         "completed", "failed", "errored", "invalid", "terminated"] as $states |
        if type != "array" then error("inventory must be an array") else . end |
        if (map(.id) | sort) != ($ids | sort) or
           (map(.id) | unique | length) != length or
           any(.[]; (.id | type) != "string" or
               (.state as $state | $states | index($state)) == null)
        then error("inventory does not match the tracked caller cohort")
        else map({id, state}) end
    ' 2>/dev/null) || return 1
    nuke_cleanup_record "$cohort-$suffix.json" \
        --arg cohort "$cohort" --argjson workloads "$projection" \
        '{version: 1, cohort: $cohort, workloads: $workloads}' || return 1
    if [ -n "${NUKE_CLEANUP_RECORD_DIR:-}" ]; then
        # The same authenticated response supplies controller image facts.
        # Persist IDs/states first; image metadata cannot prevent either caller
        # from reaching termination or discard an earlier valid observation.
        if ! printf '%s' "$inventory" | \
            node "$(dirname "${BASH_SOURCE[0]}")/nuke-image-evidence.ts" workloads \
                "$NUKE_CLEANUP_RECORD_DIR/$cohort-$suffix-images.json" \
                "$cohort" "$suffix" "$ids" "${NUKE_IMAGE:-}"; then
            print_error "Nuke $cohort image evidence unavailable ($suffix)"
        fi
    fi
    return 0
}

# This fault control holds an already admitted witness wrapper, not an unknown
# provider launch reply. The real child and its wrapper stay in the owned group
# for at most 30 seconds, or until the normal cleanup owner stops them.
nuke_hold_admitted_witness() {
    local witness_id=$1 wrapper_pid=$BASHPID hold_pid
    (trap - INT TERM; exec sleep 30) &
    hold_pid=$!
    nuke_cleanup_record admitted-witness.json \
        --arg witnessId "$witness_id" --argjson wrapperPid "$wrapper_pid" \
        --argjson holdPid "$hold_pid" \
        '{version: 1, kind: "admitted-witness-wrapper-hold", witnessId: $witnessId,
          wrapperPid: $wrapperPid, holdPid: $holdPid, holdSeconds: 30,
          admissionExitCode: 0}' || return 1
    wait "$hold_pid"
}

nuke_interrupt_after_witness() {
    local witness_id=$1 submit_pid=$2 deadline hold_pid active_ids
    deadline=$((SECONDS + NUKE_SUBMIT_TIMEOUT_SEC + 30))
    while [ ! -f "$NUKE_CLEANUP_RECORD_DIR/admitted-witness.json" ]; do
        if [ "$SECONDS" -ge "$deadline" ] || ! kill -0 -- "-$submit_pid" 2>/dev/null; then
            print_error "Nuke interruption requires an admitted, still-running witness wrapper"
            return 1
        fi
        sleep 0.05
    done
    hold_pid=$(jq -er --arg id "$witness_id" --argjson pid "$submit_pid" '
        select(.version == 1 and .kind == "admitted-witness-wrapper-hold" and
            .witnessId == $id and .wrapperPid == $pid and .admissionExitCode == 0 and
            .holdSeconds == 30 and (.holdPid | type) == "number" and .holdPid > 1) |
        .holdPid
    ' "$NUKE_CLEANUP_RECORD_DIR/admitted-witness.json") || return 1
    nuke_capture_caller_inventory normal before-interrupt "${NUKE_IDS[@]}" || return 1
    GITHUB_TOKEN="$NUKE_FAIRNESS_TOKEN" \
        nuke_capture_caller_inventory witness before-interrupt "${NUKE_WITNESS_IDS[@]}" || return 1
    active_ids=$(jq -cs '[.[].workloads[] |
        select(.state != "completed" and .state != "failed" and .state != "errored" and
            .state != "invalid" and .state != "terminated") | .id]' \
        "$NUKE_CLEANUP_RECORD_DIR/normal-before-interrupt.json" \
        "$NUKE_CLEANUP_RECORD_DIR/witness-before-interrupt.json") || return 1
    if [ "$active_ids" = '[]' ] || ! kill -0 "$hold_pid" 2>/dev/null ||
        ! kill -0 -- "-$submit_pid" 2>/dev/null; then
        print_error "Nuke interruption requires a real active Workload and a live witness hold"
        return 1
    fi
    nuke_cleanup_record interruption.json \
        --arg admittedWitnessId "$witness_id" --argjson wrapperPid "$submit_pid" \
        --argjson holdPid "$hold_pid" --argjson activeIds "$active_ids" \
        '{version: 1, admittedWitnessId: $admittedWitnessId, wrapperPid: $wrapperPid,
          holdPid: $holdPid, activeIds: $activeIds}' || return 1
    NUKE_INTERRUPTION_ARMED=true
    kill -TERM "$$"
    # Returning would mean the installed first-signal handler did not run.
    return 1
}

# Give each submit wrapper and its descendants one owned process group. The
# wrapper disables job control again so timeout/CLI children stay in that group;
# submit timeouts must use --foreground for the same reason. Defer a signal only
# across launch/registration so cleanup cannot miss a just-started process.
nuke_launch_submission() {
    local had_monitor=false
    case "$-" in *m*) had_monitor=true ;; esac
    NUKE_SUBMIT_LAUNCHING=true
    set -m
    (
        set +m
        trap - EXIT
        # Stay alive to reap the foreground timeout/CLI after group termination.
        trap ':' INT TERM
        "$@"
    ) &
    NUKE_SUBMIT_PID=$!
    SUBMIT_PIDS+=("$NUKE_SUBMIT_PID")
    [ "$had_monitor" = true ] || set +m
    NUKE_SUBMIT_LAUNCHING=false
    if [ "${NUKE_SIGNAL_RC:-0}" -ne 0 ]; then
        exit "$NUKE_SIGNAL_RC"
    fi
}

# Stop all active submissions before issuing any Workload termination. Killing
# only a wrapper can leave its CLI alive and let it admit a Workload after the
# cleanup drain. Match the submit timeout's existing 30-second kill grace.
nuke_stop_submissions() {
    local grace_seconds=${1:-30}
    local pid deadline remaining running_submit_pids cleanup_rc=0
    local groups=() pending=() remaining_groups=()
    if ! [[ "$grace_seconds" =~ ^[0-9]+$ ]]; then
        print_error "Nuke submit shutdown grace must be a non-negative integer"
        return 1
    fi

    running_submit_pids=" $(jobs -p 2>/dev/null | tr '\n' ' ') "
    for pid in "${SUBMIT_PIDS[@]:-}"; do
        [ -n "$pid" ] || continue
        case "$running_submit_pids" in
            *" $pid "*)
                groups+=("$pid")
                kill -TERM -- "-$pid" 2>/dev/null || true
                kill -CONT -- "-$pid" 2>/dev/null || true
                ;;
        esac
    done

    deadline=$((SECONDS + grace_seconds))
    pending=("${groups[@]}")
    while [ "${#pending[@]}" -gt 0 ]; do
        remaining=()
        for pid in "${pending[@]}"; do
            kill -0 -- "-$pid" 2>/dev/null && remaining+=("$pid")
        done
        pending=("${remaining[@]}")
        [ "${#pending[@]}" -gt 0 ] || break
        if [ "$SECONDS" -ge "$deadline" ]; then
            for pid in "${pending[@]}"; do
                kill -KILL -- "-$pid" 2>/dev/null || true
            done
            break
        fi
        sleep 0.05
    done

    for pid in "${SUBMIT_PIDS[@]:-}"; do
        [ -n "$pid" ] || continue
        wait "$pid" 2>/dev/null || true
    done
    SUBMIT_PIDS=()

    # SIGKILL can leave an adopted descendant briefly awaiting reaping. Do not
    # certify submission shutdown until every owned group has disappeared.
    deadline=$((SECONDS + 1))
    for pid in "${groups[@]}"; do
        while kill -0 -- "-$pid" 2>/dev/null; do
            if [ "$SECONDS" -ge "$deadline" ]; then
                print_error "Nuke submission process group $pid remains after shutdown"
                remaining_groups+=("$pid")
                cleanup_rc=1
                break
            fi
            sleep 0.05
        done
    done
    nuke_cleanup_record submissions.json \
        --argjson groups "$(nuke_ids_json "${groups[@]}")" \
        --argjson remaining "$(nuke_ids_json "${remaining_groups[@]}")" \
        '{version: 1, groupIds: ($groups | map(tonumber)),
          remainingGroupIds: ($remaining | map(tonumber))}' || cleanup_rc=1
    return "$cleanup_rc"
}

# Termination only schedules asynchronous provider cleanup. Attempt every
# termination before starting one drain deadline, then verify the full set.
nuke_terminate_and_drain() {
    local label=$1 drain_seconds=$2
    shift 2
    if ! [[ "$drain_seconds" =~ ^[0-9]+$ ]]; then
        print_error "Nuke cleanup drain must be a non-negative integer"
        return 1
    fi
    local workload_id deadline_epoch cleanup_rc=0 vms_ended=true index
    local parallelism=1
    # Local has no cloud API quotas; bound CLI processes while avoiding 300
    # serial Node startups during cleanup. Keep real-provider cleanup serial.
    [ "${NUKE_IS_LOCAL:-false}" = true ] && parallelism=8
    local failed_ids=() batch_ids=() batch_pids=()
    for workload_id in "$@"; do
        [ -n "$workload_id" ] || continue
        # Shared assertions may call fail(), which exits rather than returns.
        # Contain each operation so every ID and caller still reaches cleanup.
        (api_terminate "$workload_id" 2>/dev/null) &
        batch_ids+=("$workload_id")
        batch_pids+=("$!")
        if [ "${#batch_pids[@]}" -ge "$parallelism" ]; then
            for index in "${!batch_pids[@]}"; do
                if ! wait "${batch_pids[$index]}"; then
                    failed_ids+=("${batch_ids[$index]}")
                    cleanup_rc=1
                fi
            done
            batch_ids=() batch_pids=()
        fi
    done
    for index in "${!batch_pids[@]}"; do
        if ! wait "${batch_pids[$index]}"; then
            failed_ids+=("${batch_ids[$index]}")
            cleanup_rc=1
        fi
    done

    if [ "$#" -gt 0 ]; then
        deadline_epoch=$(( $(date +%s) + drain_seconds ))
        if ! (nuke_assert_workloads_vms_ended "$label" "$deadline_epoch" "$@"); then
            vms_ended=false
            cleanup_rc=1
        fi
    fi
    nuke_cleanup_record "${NUKE_CLEANUP_COHORT:-normal}.json" \
        --arg cohort "${NUKE_CLEANUP_COHORT:-normal}" \
        --argjson ids "$(nuke_ids_json "$@")" \
        --argjson failed "$(nuke_ids_json "${failed_ids[@]}")" \
        --argjson vmsEnded "$vms_ended" \
        '{version: 1, cohort: $cohort, ids: $ids, terminationFailedIds: $failed,
          vmsEnded: $vmsEnded}' || cleanup_rc=1
    return "$cleanup_rc"
}

nuke_run_cleanup_on_exit() {
    # The first failure owns the exit status. Further Ctrl-C/TERM requests must
    # not interrupt the independently bounded cleanup or its child commands.
    trap '' INT TERM
    local exit_rc="${1:-1}" cleanup_rc=0 repeated_term=false

    # Avoid recursive cleanup when this handler exits with the final status.
    trap - EXIT
    nuke_cleanup_record start.json \
        --argjson exitCode "$exit_rc" \
        --argjson forcedRequested "${NUKE_INTERRUPT_AFTER_WITNESS:-false}" \
        --argjson forcedArmed "${NUKE_INTERRUPTION_ARMED:-false}" \
        --argjson normalIds "$(nuke_ids_json "${NUKE_IDS[@]}")" \
        --argjson witnessIds "$(nuke_ids_json "${NUKE_WITNESS_IDS[@]}")" \
        '{version: 1, exitCode: $exitCode, forcedRequested: $forcedRequested,
          forcedArmed: $forcedArmed, normalIds: $normalIds, witnessIds: $witnessIds}' || cleanup_rc=1
    if [ "${NUKE_INTERRUPTION_ARMED:-false}" = true ]; then
        kill -TERM "$$" || cleanup_rc=1
        repeated_term=true
    fi
    cleanup || cleanup_rc=$?
    nuke_cleanup_record result.json \
        --argjson exitCode "$exit_rc" --argjson cleanupExitCode "$cleanup_rc" \
        --argjson repeatedTerm "$repeated_term" \
        '{version: 1, exitCode: $exitCode, cleanupExitCode: $cleanupExitCode,
          repeatedTerm: $repeatedTerm}' || cleanup_rc=1
    if [ "$cleanup_rc" -ne 0 ]; then
        printf 'Nuke cleanup failed (exit %s); original exit was %s\n' \
            "$cleanup_rc" "$exit_rc" >&2
    fi

    if [ "$exit_rc" -eq 0 ] && [ "$cleanup_rc" -ne 0 ]; then
        exit "$cleanup_rc"
    fi
    exit "$exit_rc"
}

nuke_handle_signal() {
    if [ "${NUKE_SIGNAL_RC:-0}" -eq 0 ]; then
        NUKE_SIGNAL_RC=$1
    fi
    if [ "${NUKE_SUBMIT_LAUNCHING:-false}" != true ]; then
        exit "$NUKE_SIGNAL_RC"
    fi
}

nuke_install_cleanup_traps() {
    # Funnel signals through EXIT so cleanup runs exactly once while the handler
    # preserves the conventional signal-derived status.
    NUKE_SIGNAL_RC=0
    NUKE_SUBMIT_LAUNCHING=false
    trap 'nuke_run_cleanup_on_exit "$?"' EXIT
    trap 'nuke_handle_signal 130' INT
    trap 'nuke_handle_signal 143' TERM
}
