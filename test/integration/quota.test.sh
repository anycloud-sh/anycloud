#!/bin/bash

# Quota Integration Test (end-to-end, real AWS + Azure)
#
# Drives the `anycloud quota` CLI surface against real accounts:
#   1. `quota status` (NO --region) — fans out across every catalog region. This
#      is the exact path that was timing out: the CLI aborts at
#      QUOTA_STATUS_TIMEOUT_MS (120s by default, src/shared/api-contract/quota.ts)
#      when the server's region fan-out runs too long. The per-region
#      quota.spec.ts tests never exercise this — they always pin a single region.
#   2. Region-scoped provider parity — compares AnyCloud current quota rows to
#      native provider APIs for a tiny default region set.
# Requirements (same as quota.spec.ts):
# - AWS:   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
# - Azure: AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID
# - CLIs:  jq, aws, az
# Every AWS and Azure assertion is required; unavailable prerequisites fail.
#
# Read-only: status only lists provider quotas and requests.
set -e

SCRIPT_DIR="$(dirname "$0")"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"
# shellcheck source=helpers/common.sh
source "$SCRIPT_DIR/helpers/common.sh"
# shellcheck source=helpers/azure-quota-parity.sh
source "$SCRIPT_DIR/helpers/azure-quota-parity.sh"

# The CLI aborts the request at this budget; keep in sync with
# QUOTA_STATUS_TIMEOUT_MS in src/shared/api-contract/quota.ts.
QUOTA_STATUS_BUDGET_S="${QUOTA_STATUS_BUDGET_S:-120}"
AWS_QUOTA_PARITY_REGIONS="${AWS_QUOTA_PARITY_REGIONS:-us-east-2}"
AZURE_QUOTA_PARITY_REGIONS="${AZURE_QUOTA_PARITY_REGIONS:-eastus}"

echo "========================================="
echo "Quota Integration Test"
echo "========================================="

require_cli() {
    local name=$1
    command -v "$name" >/dev/null 2>&1 || fail "Required CLI '$name' not found on PATH"
}

normalize_region_list() {
    printf '%s\n' "$1" | tr ',\n\t' '   ' | xargs
}

assert_numeric_equal() {
    local label=$1 provider_limit=$2 anycloud_limit=$3
    if ! jq -e -n --arg provider "$provider_limit" --arg anycloud "$anycloud_limit" '
        ($provider | tonumber) == ($anycloud | tonumber)
    ' >/dev/null 2>&1; then
        fail "$label mismatch: provider=$provider_limit AnyCloud=$anycloud_limit"
    fi
}

require_cli jq
require_cli aws
require_aws_credentials
require_azure_credentials
require_cli az
if ! AZURE_AUTH_OUTPUT="$(azure_auth_preflight 2>&1)"; then
    echo "$AZURE_AUTH_OUTPUT"
    fail "Azure auth preflight failed"
fi

# Isolate all state in a temp dir so we never touch the developer's ~/.anycloud.
ANYCLOUD_DIR_TEST="$(mktemp -d)"
export ANYCLOUD_DIR="$ANYCLOUD_DIR_TEST"
export SQLITE_PATH="$ANYCLOUD_DIR_TEST/api.db"
export IS_TEST=true # stubs GitHub auth so the dummy CLI token is accepted
export AZURE_CONFIG_DIR="$ANYCLOUD_DIR_TEST/azure-cli"

PORT=$((9000 + (RANDOM % 1000)))
export API_URL="http://localhost:$PORT"
API_LOG="/tmp/api-quota-${TEST_RUN}.log"
API_PID=""

cleanup() {
    [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
    cleanup_anycloud_dir "$ANYCLOUD_DIR_TEST" 2>/dev/null || true
}
trap cleanup EXIT

# The anycloud CLI runs against $API_URL via the shared `cli` helper. IS_TEST is
# exported above, which makes the client skip its Docker-container preflight:
# `anycloud api start` would otherwise be required, but that runs the *published*
# image as a container; start_api runs the locally-built API directly so we
# exercise this fix, not a release.

print_section "1. Starting local API on port $PORT"
start_api "$PORT" "$API_LOG"
assert "API did not become ready on $API_URL" wait_for_http "$API_URL/" 60 "API"
print_success "API ready"

print_section "2. Seeding credentials via the CLI (anycloud credentials new)"
assert "failed to add aws-test credential" \
    cli credentials new aws-test --provider aws \
    --access-key-id "$AWS_ACCESS_KEY_ID" \
    --secret-access-key "$AWS_SECRET_ACCESS_KEY"
assert "failed to add azure-test credential" \
    cli credentials new azure-test --provider azure \
    --application-id "$AZURE_CLIENT_ID" \
    --secret "$AZURE_CLIENT_SECRET" \
    --subscription-id "$AZURE_SUBSCRIPTION_ID" \
    --directory-id "$AZURE_TENANT_ID"
print_success "Credentials seeded"

setup_azure_cli_for_parity() {
    print_info "Logging Azure CLI into isolated AZURE_CONFIG_DIR for quota parity"

    local out err rc
    out="$(mktemp)"; err="$(mktemp)"
    set +e
    az login --service-principal \
        --username "$AZURE_CLIENT_ID" \
        --password="$AZURE_CLIENT_SECRET" \
        --tenant "$AZURE_TENANT_ID" \
        --output none >"$out" 2>"$err"
    rc=$?
    set -e
    if [ $rc -ne 0 ]; then
        echo "--- az login stdout ---"; cat "$out"
        echo "--- az login stderr ---"; cat "$err"
        rm -f "$out" "$err"
        fail "Azure CLI login failed"
    fi

    set +e
    az account set --subscription "$AZURE_SUBSCRIPTION_ID" >"$out" 2>"$err"
    rc=$?
    set -e
    if [ $rc -ne 0 ]; then
        echo "--- az account set stdout ---"; cat "$out"
        echo "--- az account set stderr ---"; cat "$err"
        rm -f "$out" "$err"
        fail "Azure CLI account selection failed"
    fi
    rm -f "$out" "$err"
}

# Run `quota status` (no --region) for one cloud and assert it returns current
# quota rows as JSON inside the budget. A timeout surfaces as a non-zero exit
# (the CLI aborts at the budget) — the precise failure this test guards against.
run_quota_status_check() {
    local label=$1 cred=$2
    print_section "3. quota status — $label ($cred), all regions"

    local start_s end_s elapsed_s out err rc
    out="$ANYCLOUD_DIR_TEST/quota-status-${label}-all.json"
    err="$(mktemp)"
    start_s=$(date +%s)
    set +e
    cli quota status --credentials "$cred" --json >"$out" 2>"$err"
    rc=$?
    set -e
    end_s=$(date +%s)
    elapsed_s=$((end_s - start_s))

    print_info "exit=$rc elapsed=${elapsed_s}s"

    if [ $rc -ne 0 ]; then
        echo "--- stdout ---"; cat "$out"
        echo "--- stderr ---"; cat "$err"
        echo "--- api log (tail) ---"; tail -50 "$API_LOG" || true
        rm -f "$err"
        fail "$label quota status failed (exit $rc after ${elapsed_s}s); inspect the CLI error above"
    fi
    rm -f "$err"

    # --json emits a single JSON array of entries.
    if ! jq -e 'type == "array"' "$out" >/dev/null 2>&1; then
        cat "$out"
        fail "$label quota status did not emit a JSON array"
    fi

    # The status API should expose current quota rows for both clouds even when
    # no provider tickets exist. Current rows must use currentLimit and must not
    # overload requestedLimit, which is reserved for ticket/request rows.
    if ! jq -e --arg cloud "$label" '
        any(.[]; .cloud == $cloud and .kind == "current" and (.currentLimit | type == "number"))
        and all(.[] | select(.cloud == $cloud and .kind == "current");
            (.currentLimit | type == "number") and (has("requestedLimit") | not)
        )
    ' "$out" >/dev/null 2>&1; then
        cat "$out"
        fail "$label quota status JSON did not include current rows with numeric currentLimit only"
    fi

    assert "$label quota status took ${elapsed_s}s, over the ${QUOTA_STATUS_BUDGET_S}s budget" \
        test "$elapsed_s" -lt "$QUOTA_STATUS_BUDGET_S"

    local count
    count=$(jq 'length' "$out")
    print_success "$label quota status OK (${elapsed_s}s, ${count} entries)"
}

run_quota_status_check "AWS" "aws-test"
run_quota_status_check "Azure" "azure-test"

run_scoped_quota_status() {
    local label=$1 cred=$2 region=$3 outfile=$4
    local err rc
    err="$(mktemp)"
    set +e
    cli quota status --credentials "$cred" --region "$region" --json >"$outfile" 2>"$err"
    rc=$?
    set -e
    if [ $rc -ne 0 ]; then
        echo "--- stdout ---"; cat "$outfile"
        echo "--- stderr ---"; cat "$err"
        echo "--- api log (tail) ---"; tail -50 "$API_LOG" || true
        rm -f "$err"
        fail "$label quota status parity read failed for $region (exit $rc)"
    fi
    rm -f "$err"

    if ! jq -e 'type == "array"' "$outfile" >/dev/null 2>&1; then
        cat "$outfile"
        fail "$label quota status parity read for $region did not emit a JSON array"
    fi
}

run_aws_quota_parity() {
    local regions
    regions="$(normalize_region_list "$AWS_QUOTA_PARITY_REGIONS")"
    if [ -z "$regions" ]; then
        fail "AWS_QUOTA_PARITY_REGIONS did not contain any regions"
    fi
    print_section "4. AWS quota parity — ${regions}"

    local total=0
    local region
    for region in $regions; do
        local status_file count
        status_file="$ANYCLOUD_DIR_TEST/quota-status-aws-${region}.json"
        run_scoped_quota_status "AWS" "aws-test" "$region" "$status_file"

        count=$(jq '[.[] | select(.cloud == "AWS" and .kind == "current" and ((.resourceKey // "") | test("^aws:l-[a-z0-9]+$")))] | length' "$status_file")
        if [ "$count" -eq 0 ]; then
            cat "$status_file"
            fail "AWS quota parity found no current aws:l-* rows for $region"
        fi

        # One paginated ListServiceQuotas per region instead of one
        # GetServiceQuota per row: ListServiceQuotas has its own 10/s
        # per-account bucket, apart from the 5/s GetServiceQuota bucket the
        # API's own quota reads and parallel CI runs drain. Adaptive retry
        # backs off with jitter and rate-limits the client when throttled.
        local provider_file err rc
        provider_file="$ANYCLOUD_DIR_TEST/aws-service-quotas-ec2-${region}.json"
        err="$(mktemp)"
        set +e
        AWS_PAGER="" AWS_RETRY_MODE=adaptive AWS_MAX_ATTEMPTS=10 \
            aws service-quotas list-service-quotas \
            --service-code ec2 \
            --region "$region" \
            --output json >"$provider_file" 2>"$err"
        rc=$?
        set -e
        if [ $rc -ne 0 ]; then
            echo "--- aws service-quotas stderr ---"; cat "$err"
            rm -f "$err"
            fail "AWS Service Quotas list failed for $region"
        fi
        rm -f "$err"

        while IFS=$'\t' read -r resource_key anycloud_limit; do
            local quota_code provider_limit
            quota_code="$(printf '%s' "${resource_key#aws:}" | tr '[:lower:]' '[:upper:]')"
            provider_limit="$(jq -r --arg code "$quota_code" \
                '[.Quotas[] | select(.QuotaCode == $code) | .Value][0] // empty' \
                "$provider_file")"
            if [ -z "$provider_limit" ]; then
                fail "AWS Service Quotas list has no value for $region $quota_code"
            fi
            assert_numeric_equal "AWS $region $quota_code" "$provider_limit" "$anycloud_limit"
            total=$((total + 1))
        done < <(jq -r '
            .[]
            | select(.cloud == "AWS" and .kind == "current" and ((.resourceKey // "") | test("^aws:l-[a-z0-9]+$")))
            | [.resourceKey, (.currentLimit | tostring)]
            | @tsv
        ' "$status_file")

        print_success "AWS quota parity OK for $region (${count} rows)"
    done
    print_success "AWS quota parity OK (${total} rows total)"
}

# ARM throttles reads per subscription, and this parity oracle competes with
# every other CI leg on the shared test subscription. Azure advertises a 300s
# retry-after. Retry within a bounded budget, then fail if the independent
# quota oracle remains unavailable.
AZURE_PARITY_THROTTLE_ATTEMPTS=3
AZURE_PARITY_THROTTLE_SLEEP=20

az_rest_throttled() {
    grep -qE 'RequestThrottled|TooManyRequests|Too Many Requests' "$1"
}

az_rest_paginated() {
    local url=$1 outfile=$2
    local pages tmp page err rc next attempt
    pages="$(mktemp)"
    jq -n '[]' >"$pages"

    while [ -n "$url" ]; do
        page="$(mktemp)"; err="$(mktemp)"
        attempt=1
        while :; do
            # Capture the failure without changing the caller's errexit mode.
            rc=0
            az rest --method get --url "$url" --output json >"$page" 2>"$err" || rc=$?
            [ "$rc" -eq 0 ] && break

            if az_rest_throttled "$err" && [ "$attempt" -lt "$AZURE_PARITY_THROTTLE_ATTEMPTS" ]; then
                print_warning "Azure throttled the quota parity read; retrying in ${AZURE_PARITY_THROTTLE_SLEEP}s (attempt ${attempt}/${AZURE_PARITY_THROTTLE_ATTEMPTS})"
                sleep "$AZURE_PARITY_THROTTLE_SLEEP"
                attempt=$((attempt + 1))
                continue
            fi

            echo "--- az rest url ---"; echo "$url"
            echo "--- az rest stderr ---"; cat "$err"
            rm -f "$pages" "$page" "$err"
            fail "Azure REST quota parity read failed"
        done
        rm -f "$err"

        if ! jq -e 'type == "object" and (.value | type == "array")' "$page" >/dev/null 2>&1; then
            echo "--- az rest url ---"; echo "$url"
            cat "$page"
            rm -f "$pages" "$page"
            fail "Azure REST quota parity response did not include a value array"
        fi

        tmp="$(mktemp)"
        jq -s '.[0] + (.[1].value // [])' "$pages" "$page" >"$tmp"
        mv "$tmp" "$pages"
        next="$(jq -r '.nextLink // ""' "$page")"
        rm -f "$page"
        url="$next"
    done

    mv "$pages" "$outfile"
}

print_azure_provider_keys() {
    local compute_usage_file=$1 compute_quota_file=$2 network_quota_file=$3
    echo "--- Azure compute usage keys ---"
    jq -r '.[] | (.name.value // .name // empty)' "$compute_usage_file" | sort | sed 's/^/  /'
    echo "--- Azure compute quota keys ---"
    jq -r '.[] | (.properties.name.value // .name // empty)' "$compute_quota_file" | sort | sed 's/^/  /'
    echo "--- Azure network quota keys ---"
    jq -r '.[] | (.properties.name.value // .name // empty)' "$network_quota_file" | sort | sed 's/^/  /'
}

run_azure_quota_parity() {
    local regions
    regions="$(normalize_region_list "$AZURE_QUOTA_PARITY_REGIONS")"
    if [ -z "$regions" ]; then
        fail "AZURE_QUOTA_PARITY_REGIONS did not contain any regions"
    fi
    print_section "4. Azure quota parity — ${regions}"
    setup_azure_cli_for_parity

    local total=0
    local region
    for region in $regions; do
        local status_file compute_usage_file compute_quota_file network_quota_file
        local compute_scope network_scope count public_ip_count public_ip_resource_key
        status_file="$ANYCLOUD_DIR_TEST/quota-status-azure-${region}.json"
        compute_usage_file="$ANYCLOUD_DIR_TEST/azure-compute-usages-${region}.json"
        compute_quota_file="$ANYCLOUD_DIR_TEST/azure-compute-quotas-${region}.json"
        network_quota_file="$ANYCLOUD_DIR_TEST/azure-network-quotas-${region}.json"
        compute_scope="https://management.azure.com/subscriptions/${AZURE_SUBSCRIPTION_ID}/providers/Microsoft.Compute/locations/${region}"
        network_scope="https://management.azure.com/subscriptions/${AZURE_SUBSCRIPTION_ID}/providers/Microsoft.Network/locations/${region}"

        run_scoped_quota_status "Azure" "azure-test" "$region" "$status_file"
        count=$(jq '[.[] | select(.cloud == "Azure" and .kind == "current" and ((.resourceKey // "") | startswith("azure:")))] | length' "$status_file")
        if [ "$count" -eq 0 ]; then
            cat "$status_file"
            fail "Azure quota parity found no current azure:* rows for $region"
        fi

        az_rest_paginated "${compute_scope}/usages?api-version=2026-03-01" "$compute_usage_file"
        az_rest_paginated "${compute_scope}/providers/Microsoft.Quota/quotas?api-version=2025-09-01" "$compute_quota_file"
        az_rest_paginated "${network_scope}/providers/Microsoft.Quota/quotas?api-version=2025-09-01" "$network_quota_file"

        public_ip_count=$(jq '[
            .[]
            | select(
                .cloud == "Azure"
                and .kind == "current"
                and ((((.resourceKey // "") + " " + (.resourceName // "")) | ascii_downcase) | contains("public") and contains("ip"))
              )
        ] | length' "$status_file")
        # A slow Azure Network read is reported as a bounded UNAVAILABLE row,
        # not a wrong answer: show it and skip the public IP check.
        if [ "$public_ip_count" -eq 0 ] && jq -e --arg region "$region" '
            any(.[]; .kind == "unavailable" and .region == $region
                and .resourceName == "Network limits"
                and ((.message // "") | test("timed out after")))
        ' "$status_file" >/dev/null; then
            jq -c --arg region "$region" '.[] | select(.kind == "unavailable" and .region == $region)' "$status_file"
            print_warning "Azure Network quota limits timed out for $region; skipping public IP parity"
            if [ -n "${GITHUB_ACTIONS:-}" ]; then
                echo "::warning::Azure Network quota limits timed out for $region; skipped public IP parity"
            fi
        else
            if [ "$public_ip_count" -ne 1 ]; then
                cat "$status_file"
                print_azure_provider_keys "$compute_usage_file" "$compute_quota_file" "$network_quota_file"
                fail "Azure quota parity expected exactly one resolved public IP status row for $region, got $public_ip_count"
            fi
            public_ip_resource_key=$(jq -r '
                .[]
                | select(
                    .cloud == "Azure"
                    and .kind == "current"
                    and ((((.resourceKey // "") + " " + (.resourceName // "")) | ascii_downcase) | contains("public") and contains("ip"))
                  )
                | .resourceKey // ""
            ' "$status_file")
            if [ "$public_ip_resource_key" != "azure:standardskupublicipaddresses" ]; then
                cat "$status_file"
                fail "Azure quota parity expected the public IP status key azure:standardskupublicipaddresses for $region, got $public_ip_resource_key"
            fi
        fi

        while IFS=$'\t' read -r resource_key resource_name anycloud_limit is_public_ip row_json; do
            local key provider_limit public_ip_selection selected_key selected_name selected_provider_id
            key="${resource_key#azure:}"
            if [ "$is_public_ip" = "true" ]; then
                public_ip_selection="$(azure_public_ip_selection "$network_quota_file")"
                if [ -z "$public_ip_selection" ]; then
                    echo "--- unmatched AnyCloud row ---"; echo "$row_json"
                    print_azure_provider_keys "$compute_usage_file" "$compute_quota_file" "$network_quota_file"
                    fail "Azure quota parity could not find a provider-native public IP quota for $region"
                fi
                selected_key="$(printf '%s\n' "$public_ip_selection" | cut -f1)"
                provider_limit="$(printf '%s\n' "$public_ip_selection" | cut -f2)"
                selected_name="$(printf '%s\n' "$public_ip_selection" | cut -f3)"
                selected_provider_id="$(printf '%s\n' "$public_ip_selection" | cut -f4)"
                if [ "$selected_key" != "$resource_key" ]; then
                    echo "--- selected Azure public IP quota ---"
                    printf 'key=%s name=%s providerId=%s limit=%s\n' "$selected_key" "$selected_name" "$selected_provider_id" "$provider_limit"
                    fail "Azure quota parity public IP key mismatch for $region: adapter=$selected_key AnyCloud=$resource_key"
                fi
                if [ -z "$provider_limit" ]; then
                    echo "--- selected Azure public IP quota ---"
                    printf 'key=%s name=%s providerId=%s limit=%s\n' "$selected_key" "$selected_name" "$selected_provider_id" "$provider_limit"
                    fail "Azure quota parity selected a public IP quota without a limit for $region"
                fi
                if [ -z "$selected_provider_id" ]; then
                    echo "--- selected Azure public IP quota ---"
                    printf 'key=%s name=%s providerId=%s limit=%s\n' "$selected_key" "$selected_name" "$selected_provider_id" "$provider_limit"
                    fail "Azure quota parity selected a public IP quota without an exact provider ID for $region"
                fi
                assert_numeric_equal "Azure $region public IP quota ($selected_key)" "$provider_limit" "$anycloud_limit"
            else
                provider_limit="$(azure_compute_provider_limit "$resource_key" "$compute_usage_file" "$compute_quota_file")"
                if [ -z "$provider_limit" ]; then
                    echo "--- unmatched AnyCloud row ---"; echo "$row_json"
                    print_azure_provider_keys "$compute_usage_file" "$compute_quota_file" "$network_quota_file"
                    fail "Azure quota parity could not match $resource_key ($resource_name) in provider-native data for $region"
                fi
                assert_numeric_equal "Azure $region $key" "$provider_limit" "$anycloud_limit"
            fi
            total=$((total + 1))
        done < <(jq -r '
            .[]
            | select(.cloud == "Azure" and .kind == "current" and ((.resourceKey // "") | startswith("azure:")))
            | [
                .resourceKey,
                (.resourceName // ""),
                (.currentLimit | tostring),
                (((.resourceKey // "") + " " + (.resourceName // "") | ascii_downcase) | contains("public") and contains("ip")),
                (. | @json)
              ]
            | @tsv
        ' "$status_file")

        print_success "Azure quota parity OK for $region (${count} rows)"
    done
    print_success "Azure quota parity OK (${total} rows total)"
}

run_aws_quota_parity
run_azure_quota_parity

assert_no_azure_public_ip_quota_schema_drift() {
    local event_code="azure_public_ip_quota_schema_drift"
    local matches
    matches="$(grep -nF "$event_code" "$API_LOG" || true)"
    if [ -n "$matches" ]; then
        echo "--- Azure public IP quota schema drift events ---"
        echo "$matches"
        fail "Azure public IP quota schema drift detected in API log"
    fi
    print_success "Azure public IP quota schema drift canary OK"
}

assert_no_azure_public_ip_quota_schema_drift

print_section "Done"
print_success "quota status within budget + provider parity matched + no Azure public IP quota schema drift (AWS + Azure)"
