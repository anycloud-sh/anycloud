#!/usr/bin/env bash

# Independent cleanup for the paid Lambda boot-failover qualification. Exact
# provider IDs come from each trial's durable artifact; tag discovery is only a
# fallback for a trial that stopped before its ledger artifact was uploaded.

set -euo pipefail

: "${LAMBDA_API_KEY:?LAMBDA_API_KEY is required}"
: "${LAMBDA_BOOT_FAILOVER_LEDGER_ROOT:?LAMBDA_BOOT_FAILOVER_LEDGER_ROOT is required}"
: "${RUN_PREFIX:?RUN_PREFIX is required}"

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=test/integration/helpers/lambda-api.sh
source "$SCRIPT_DIR/lambda-api.sh"

print_warning() {
    printf 'LAMBDA_FAILOVER_AUDIT warning=%s\n' "$*" >&2
}

api=https://cloud.lambda.ai/api/v1
failures=()
mkdir -p "$LAMBDA_BOOT_FAILOVER_LEDGER_ROOT"
if [ "${LEDGER_DOWNLOAD_OUTCOME:-success}" != success ]; then
    failures+=("exact instance ledger artifacts could not be downloaded")
fi

lambda_audit_request() {
    local method=$1
    local url=$2
    local data=${3:-}
    local attempt response curl_rc http_code body

    for attempt in 1 2 3 4 5 6; do
        set +e
        if [ -n "$data" ]; then
            response=$(curl -sS -w "\n%{http_code}" \
                --request "$method" \
                --header "Authorization: Bearer $LAMBDA_API_KEY" \
                --header 'Content-Type: application/json' \
                --data "$data" \
                "$url" 2>&1)
        else
            response=$(curl -sS -w "\n%{http_code}" \
                --request "$method" \
                --header "Authorization: Bearer $LAMBDA_API_KEY" \
                "$url" 2>&1)
        fi
        curl_rc=$?
        set -e
        if [ $curl_rc -ne 0 ]; then
            [ $attempt -lt 6 ] && sleep 2
            continue
        fi

        http_code=$(printf '%s\n' "$response" | tail -1)
        body=$(printf '%s\n' "$response" | sed '$d')
        if [[ "$http_code" == 2?? ]]; then
            printf '%s' "$body"
            return 0
        fi
        if [ "$http_code" = 404 ] || [[ "$body" == *object-does-not-exist* ]]; then
            printf '%s' "$body"
            return 0
        fi
        case "$http_code" in
            429|5??)
                [ $attempt -lt 6 ] && sleep 2
                continue
                ;;
        esac
        printf 'HTTP %s: %s' "$http_code" "$body" >&2
        return 1
    done
    printf 'request remained inconclusive after retries' >&2
    return 1
}

ledger_ids=
ledger_workload_ids=
ledger_artifact_count=0
while IFS= read -r -d '' ledger; do
    ledger_artifact_count=$((ledger_artifact_count + 1))
    set +e
    jq -e --arg prefix "$RUN_PREFIX" '
      (.workloadId | type) == "string"
      and (.workloadId | startswith($prefix))
      and (.instanceIds | type) == "array"
      and all(.instanceIds[]; type == "string")
    ' "$ledger" >/dev/null
    ledger_rc=$?
    set -e
    if [ $ledger_rc -ne 0 ]; then
        failures+=("invalid exact instance ledger: $ledger")
        continue
    fi
    ledger_workload_ids="${ledger_workload_ids}$(jq -r '.workloadId' "$ledger")"$'\n'
    ledger_ids="${ledger_ids}$(jq -r '.instanceIds[]' "$ledger")"$'\n'
done < <(
    find "$LAMBDA_BOOT_FAILOVER_LEDGER_ROOT" -type f \
        -name 'lambda-boot-failover-ledger-*.json' -print0
)
ledger_ids=$(printf '%s' "$ledger_ids" | sed '/^$/d' | sort -u)
ledger_trial_count=$(
    printf '%s' "$ledger_workload_ids" | sed '/^$/d' | sort -u | wc -l | tr -d '[:space:]'
)
if [ -n "${EXPECTED_TRIAL_COUNT:-}" ] && \
   [ "$ledger_trial_count" -ne "$EXPECTED_TRIAL_COUNT" ]; then
    failures+=("expected $EXPECTED_TRIAL_COUNT unique trial ledgers, found $ledger_trial_count across $ledger_artifact_count artifacts")
fi

discovered_ids=
discover_tagged_instance_ids() {
    local observation=$1
    local live_json live_rc observed_ids discovery_rc

    set +e
    live_json=$(lambda_audit_request GET "$api/instances")
    live_rc=$?
    set -e
    if [ $live_rc -ne 0 ]; then
        failures+=("tagged-instance discovery observation $observation was inconclusive")
        return
    fi

    set +e
    observed_ids=$(printf '%s\n' "$live_json" | jq -r --arg prefix "$RUN_PREFIX" '
      if (.data | type) != "array" then error("missing data array")
      # Lambda pages this list; only its last page has page_token null.
      elif .page_token != null then error("partial instance page")
      else
        .data[]?
        | select(any(.tags[]?;
            .key == "anycloud:deployment-id"
            and (.value | type) == "string"
            and (.value | startswith($prefix))))
        | if (.id | type) == "string" and (.id | length) > 0
          then .id
          else error("tagged instance is missing an id")
          end
      end
    ' 2>/dev/null)
    discovery_rc=$?
    set -e
    if [ $discovery_rc -ne 0 ]; then
        failures+=("tagged-instance discovery observation $observation was malformed")
        return
    fi

    discovered_ids="${discovered_ids}${observed_ids}"$'\n'
}

# Lambda's account list can briefly omit an instance or retain a terminal
# record that later becomes live again. Require two completed observations ten
# seconds apart and union every tagged ID from both before declaring discovery
# complete. Exact point/list verification below decides whether each ID is gone.
for observation in 1 2; do
    discover_tagged_instance_ids "$observation"
    [ "$observation" -eq 1 ] && sleep 10
done

instance_ids=()
while IFS= read -r instance_id; do
    [ -n "$instance_id" ] && instance_ids+=("$instance_id")
done < <(printf '%s\n%s\n' "$ledger_ids" "$discovered_ids" | sed '/^$/d' | sort -u)

printf 'LAMBDA_FAILOVER_AUDIT exact_ids=%s\n' \
    "$(printf '%s\n' "${instance_ids[@]:-}" | jq -Rsc 'split("\n") | map(select(length > 0))')"

# Attempt termination for every exact ID before starting any verification.
for instance_id in "${instance_ids[@]}"; do
    set +e
    termination_error=$(lambda_audit_request POST \
        "$api/instance-operations/terminate" \
        "$(jq -nc --arg id "$instance_id" '{instance_ids:[$id]}')" 2>&1 >/dev/null)
    termination_rc=$?
    set -e
    if [ $termination_rc -ne 0 ]; then
        failures+=("termination request for $instance_id failed: $termination_error")
    fi
done

audit_deadline=$(( $(date +%s) + ${LAMBDA_BOOT_FAILOVER_AUDIT_SECONDS:-720} ))
for instance_id in "${instance_ids[@]}"; do
    confirmed=false
    last_rc=2
    while [ "$(date +%s)" -lt "$audit_deadline" ]; do
        set +e
        lambda_api_is_vm_terminated "$instance_id"
        last_rc=$?
        set -e
        if [ $last_rc -eq 0 ]; then
            confirmed=true
            break
        fi
        if [ $last_rc -eq 3 ]; then
            break
        fi
        sleep 5
    done
    if [ "$confirmed" = true ]; then
        printf 'LAMBDA_FAILOVER_AUDIT released=%s\n' "$instance_id"
    elif [ $last_rc -eq 3 ]; then
        failures+=("verifier failed for $instance_id")
    else
        failures+=("$instance_id remained present or inconclusive at the audit deadline")
    fi
done

if [ ${#failures[@]} -gt 0 ]; then
    printf 'LAMBDA_FAILOVER_AUDIT failures=%s\n' \
        "$(printf '%s\n' "${failures[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')" >&2
    exit 1
fi

printf 'LAMBDA_FAILOVER_AUDIT result=clean\n'
