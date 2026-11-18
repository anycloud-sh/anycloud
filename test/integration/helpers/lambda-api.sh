# Lambda real-API helper functions for integration tests.
# Sourced by lambda-boot-failover-cleanup.sh.

# lambda_api_is_vm_terminated <instance_id>
#
# Independent, real-API confirmation that a Lambda instance is actually gone.
# Does not call into Lambda.api()/observeVMReleaseOnce()
# (src/api/services/gateways/lambda.ts) — the exact production path underlying
# terminateVM release confirmation — so a bug there
# can't silently pass both the code under test and this check.
# Returns: 0=terminated, 1=still present, 2=inconclusive (caller should retry),
# 3=verifier/auth/response failure (caller should fail immediately).
lambda_api_is_vm_terminated() {
    local instance_id=$1
    local response http_code body curl_rc point_absent list_state now

    # No `set -e` restore after this — the caller brackets this whole call
    # with set +e/set -e specifically so a non-zero `return` below doesn't
    # abort the script. set -e is shell-global, not function-scoped, so
    # re-arming it in here would defeat that: a `return` after this point
    # would trigger immediate errexit instead of returning control to the
    # caller's retry loop.
    set +e
    response=$(curl -sS -w "\n%{http_code}" \
        -H "Authorization: Bearer $LAMBDA_API_KEY" \
        "https://cloud.lambda.ai/api/v1/instances/$instance_id" 2>&1)
    curl_rc=$?

    if [ $curl_rc -ne 0 ]; then
        LAMBDA_RELEASE_CANDIDATE_ID=
        LAMBDA_RELEASE_CANDIDATE_AT=
        print_warning "Lambda instance check network error for $instance_id (curl exit $curl_rc)"
        return 2
    fi

    http_code=$(printf '%s\n' "$response" | tail -1)
    body=$(printf '%s\n' "$response" | sed '$d')

    point_absent=false
    if [ "$http_code" = "404" ] || echo "$body" | grep -q "object-does-not-exist"; then
        point_absent=true
    fi

    if [ "$point_absent" != true ] && [ "$http_code" = "200" ]; then
        local status
        status=$(echo "$body" | jq -r '.data.status // empty')
        case "$status" in
            terminated) point_absent=true ;;
            # The terminate endpoint returns this accepted, transitional state.
            # The instance remains provider-visible, so keep polling until the
            # independent verifier observes terminated or not-found.
            terminating)
                LAMBDA_RELEASE_CANDIDATE_ID=
                LAMBDA_RELEASE_CANDIDATE_AT=
                return 2
                ;;
            "")
                LAMBDA_RELEASE_CANDIDATE_ID=
                LAMBDA_RELEASE_CANDIDATE_AT=
                print_warning "Lambda instance check got 200 with unexpected body for $instance_id"
                return 3
                ;;
            *)
                LAMBDA_RELEASE_CANDIDATE_ID=
                LAMBDA_RELEASE_CANDIDATE_AT=
                return 1
                ;;
        esac
    fi

    if [ "$point_absent" != true ]; then
        LAMBDA_RELEASE_CANDIDATE_ID=
        LAMBDA_RELEASE_CANDIDATE_AT=
        case "$http_code" in
            429|5??) return 2 ;;
        esac
        print_warning "Lambda instance check got HTTP $http_code for $instance_id"
        return 3
    fi

    # Point absence is only a candidate. The account list is a separate Lambda
    # view and must independently stop reporting this exact ledger ID.
    response=$(curl -sS -w "\n%{http_code}" \
        -H "Authorization: Bearer $LAMBDA_API_KEY" \
        "https://cloud.lambda.ai/api/v1/instances" 2>&1)
    curl_rc=$?
    if [ $curl_rc -ne 0 ]; then
        LAMBDA_RELEASE_CANDIDATE_ID=
        LAMBDA_RELEASE_CANDIDATE_AT=
        print_warning "Lambda instance list network error for $instance_id (curl exit $curl_rc)"
        return 2
    fi
    http_code=$(printf '%s\n' "$response" | tail -1)
    body=$(printf '%s\n' "$response" | sed '$d')
    if [ "$http_code" = "200" ]; then
        set +e
        list_state=$(printf '%s\n' "$body" | jq -er --arg id "$instance_id" '
          if (.data | type) != "array" then error("missing data array")
          # Lambda pages this list; only its last page has page_token null.
          elif .page_token != null then error("partial instance page")
          else
            [.data[] | select((.id | tostring) == $id) | .status] as $statuses
            | if ($statuses | length) == 0
              or all($statuses[]; . == "terminated") then "absent"
              elif all($statuses[]; type == "string" and length > 0)
                and any($statuses[]; . == "terminating")
                and all($statuses[]; . == "terminating" or . == "terminated")
                then "transitioning"
              elif all($statuses[]; type == "string" and length > 0)
                then "present"
              else error("missing instance status")
              end
          end
        ' 2>/dev/null)
        curl_rc=$?
        if [ $curl_rc -ne 0 ]; then
            LAMBDA_RELEASE_CANDIDATE_ID=
            LAMBDA_RELEASE_CANDIDATE_AT=
            print_warning "Lambda instance list got an unexpected body for $instance_id"
            return 3
        fi
        case "$list_state" in
            present)
                LAMBDA_RELEASE_CANDIDATE_ID=
                LAMBDA_RELEASE_CANDIDATE_AT=
                return 1
                ;;
            transitioning)
                LAMBDA_RELEASE_CANDIDATE_ID=
                LAMBDA_RELEASE_CANDIDATE_AT=
                return 2
                ;;
        esac
    else
        LAMBDA_RELEASE_CANDIDATE_ID=
        LAMBDA_RELEASE_CANDIDATE_AT=
        case "$http_code" in
            429|5??) return 2 ;;
        esac
        print_warning "Lambda instance list got HTTP $http_code for $instance_id"
        return 3
    fi

    # Two successful point/list observations, completed at least ten seconds
    # apart, protect the E2E verifier from Lambda replica disagreement.
    now=$(date +%s)
    if [ "${LAMBDA_RELEASE_CANDIDATE_ID:-}" != "$instance_id" ] || \
       [ -z "${LAMBDA_RELEASE_CANDIDATE_AT:-}" ]; then
        LAMBDA_RELEASE_CANDIDATE_ID=$instance_id
        LAMBDA_RELEASE_CANDIDATE_AT=$now
        return 2
    fi
    if [ $((now - LAMBDA_RELEASE_CANDIDATE_AT)) -lt 10 ]; then
        return 2
    fi
    return 0
}
