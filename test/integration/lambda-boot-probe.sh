#!/usr/bin/env bash

# Launch a small matrix of Lambda Cloud instances and measure the boot
# mechanics the provisioning gateway's budgets and failure classification are
# sized against: time from launch to IP, whether instances stuck in `booting`
# accept a terminate request, and how long terminate takes to reach the
# `terminated` status that counts as confirmed-gone. Motivated by
# qualification run 33635355557, where one instance stayed `booting` without
# an IP past every budget. Observation-only: no SSH, no workload; every
# instance this probe launches is terminated by it, stuck or healthy.
set -euo pipefail

API_BASE=https://cloud.lambda.ai/api/v1
GPU_TYPE=${BOOT_PROBE_GPU_TYPE:-gpu_1x_a10}
GPU_COUNT=${BOOT_PROBE_GPU_COUNT:-4}
CPU_TYPE=${BOOT_PROBE_CPU_TYPE:-cpu_4x_general}
CPU_COUNT=${BOOT_PROBE_CPU_COUNT:-2}
# Instances terminated deliberately while still `booting` (never given a
# chance to reach an IP). Waiting for a naturally stuck instance is a lottery;
# this arm tests the same mechanism on demand — whether Lambda accepts a
# terminate for a booting instance, and how long that takes to reach the
# `terminated` status the retry fence waits for.
EARLY_TERM_COUNT=${BOOT_PROBE_EARLY_TERMINATE_COUNT:-2}
REGION=${BOOT_PROBE_REGION:-us-east-1}
OBSERVE_SECONDS=${BOOT_PROBE_OBSERVE_SECONDS:-1200}
# The product's boot budget (lambda.ts connectToProvisioningInstance): an
# instance still booting without an IP past this point is the incident state.
STUCK_AFTER_SECONDS=${BOOT_PROBE_STUCK_AFTER_SECONDS:-300}
POLL_SECONDS=10
RESULTS_DIR=${BOOT_PROBE_RESULTS_DIR:-${RUNNER_TEMP:-/tmp}/lambda-boot-probe}
RUN_TOKEN=${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}
NAME_PREFIX="bootprobe-${RUN_TOKEN}"
KEY_NAME="${NAME_PREFIX}-key"
# Leave launch headroom on the shared account: the CI GitHub runners are
# Lambda instances on this same account and quota.
MAX_PREEXISTING_INSTANCES=${BOOT_PROBE_MAX_PREEXISTING:-25}
RELEASE_STABILITY_SECONDS=${BOOT_PROBE_RELEASE_STABILITY_SECONDS:-10}

[[ -n ${LAMBDA_API_KEY:-} ]] || { echo 'LAMBDA_API_KEY is required' >&2; exit 2; }
[[ $GPU_COUNT =~ ^[0-9]+$ && $CPU_COUNT =~ ^[0-9]+$ && $EARLY_TERM_COUNT =~ ^[0-9]+$ && $RELEASE_STABILITY_SECONDS =~ ^[0-9]+$ ]] || { echo 'counts and release stability must be integers' >&2; exit 2; }
(( EARLY_TERM_COUNT <= GPU_COUNT + CPU_COUNT )) || { echo 'early-terminate count exceeds launch count' >&2; exit 2; }
(( GPU_COUNT + CPU_COUNT >= 1 && GPU_COUNT + CPU_COUNT <= 12 )) || { echo 'total instances must be 1-12' >&2; exit 2; }
[[ $REGION =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || { echo 'invalid region' >&2; exit 2; }

mkdir -p "$RESULTS_DIR"
EVENTS_CSV="$RESULTS_DIR/boot-events.csv"
SUMMARY_JSON="$RESULTS_DIR/summary.json"
echo 'epoch,instance_id,vm_type,arm,list_status,point_status,has_ip,note' > "$EVENTS_CSV"
KEY_ID=

api_get() {
  curl --fail-with-body --silent --show-error \
    --retry 5 --retry-all-errors --retry-delay 2 \
    --header "Authorization: Bearer $LAMBDA_API_KEY" \
    "$API_BASE$1"
}

# No --fail: terminate responses (including 4xx refusals) are the observation.
api_post_status() {
  local path=$1 body=$2 out=$3
  curl --silent --show-error --output "$out" --write-out '%{http_code}' \
    --request POST \
    --header "Authorization: Bearer $LAMBDA_API_KEY" \
    --header 'Content-Type: application/json' \
    --data "$body" \
    "$API_BASE$path"
}

probe_instances() {
  api_get /instances | jq -c --arg prefix "$NAME_PREFIX" \
    '[.data[]? | select((.name // "") | startswith($prefix))
      | {id, name, status, has_ip: (.ip != null)}]'
}

probe_instance_status() {
  local id=$1 response=''
  if response=$(api_get "/instances/$id" 2>/dev/null); then
    jq -r '.data.status // "invalid"' <<<"$response"
    return
  fi
  if jq -e '(.error.code // "") | contains("object-does-not-exist")' <<<"$response" >/dev/null 2>&1; then
    echo missing
  else
    echo unknown
  fi
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  set +e

  local ids deadline remaining
  ids=$(probe_instances 2>/dev/null | jq -c '[.[] | select(.status != "terminated") | .id]' 2>/dev/null)
  [[ -n $ids ]] || ids='[]'
  if [[ $ids != '[]' ]]; then
    echo "BOOT_PROBE cleanup terminating remaining=$ids"
    local body attempt
    body=$(jq -cn --argjson ids "$ids" '{instance_ids:$ids}')
    for attempt in 1 2 3 4 5; do
      api_post_status /instance-operations/terminate "$body" /dev/null | grep -q '^2' && break
      sleep 12
    done
    deadline=$((SECONDS + 900))
    while [[ $SECONDS -lt $deadline ]]; do
      sleep 10
      remaining=$(probe_instances 2>/dev/null | jq -c '[.[] | select(.status != "terminated") | .id]' 2>/dev/null)
      [[ -n $remaining && $remaining == '[]' ]] && break
    done
  fi

  remaining=$(probe_instances 2>/dev/null | jq -c '[.[] | select(.status != "terminated") | .id]' 2>/dev/null)
  echo "BOOT_PROBE cleanup remaining_after_sweep=${remaining:-unknown}"
  if [[ -n $KEY_ID ]]; then
    curl --silent --request DELETE \
      --header "Authorization: Bearer $LAMBDA_API_KEY" \
      "$API_BASE/ssh-keys/$KEY_ID" >/dev/null || true
  fi
  if [[ -n $remaining && $remaining != '[]' ]]; then
    echo "BOOT_PROBE error unswept_instances=$remaining" >&2
    exit 1
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

# ---- Preflight: account headroom + advertised capacity ----------------------
PREEXISTING=$(api_get /instances | jq '[.data[] | select(.status != "terminated")] | length')
echo "BOOT_PROBE preflight preexisting_instances=$PREEXISTING"
if (( PREEXISTING > MAX_PREEXISTING_INSTANCES )); then
  echo "BOOT_PROBE abort account_too_busy preexisting=$PREEXISTING max=$MAX_PREEXISTING_INSTANCES" >&2
  exit 1
fi
sleep 2
TYPES_JSON=$(api_get /instance-types)
CAPACITY_BEFORE=$(jq -c --arg gpu "$GPU_TYPE" --arg cpu "$CPU_TYPE" \
  '{gpu: [.data[$gpu].regions_with_capacity_available[]?.name],
    cpu: [.data[$cpu].regions_with_capacity_available[]?.name]}' <<<"$TYPES_JSON")
echo "BOOT_PROBE preflight capacity=$CAPACITY_BEFORE region=$REGION"

sleep 2
KEY_RESPONSE=$(api_get /ssh-keys)
if ! KEY_ID=$(jq -er --arg name "$KEY_NAME" '.data[] | select(.name == $name) | .id' <<<"$KEY_RESPONSE" 2>/dev/null); then
  KEY_ID=
  CODE=$(api_post_status /ssh-keys "$(jq -cn --arg name "$KEY_NAME" '{name:$name}')" "$RESULTS_DIR/key-response.json")
  [[ $CODE == 2* ]] || { echo "BOOT_PROBE error key_registration http=$CODE" >&2; cat "$RESULTS_DIR/key-response.json" >&2; exit 1; }
  KEY_ID=$(jq -er '.data.id' "$RESULTS_DIR/key-response.json")
  # The generated private key is never used; keep only the id for deletion.
  jq 'del(.data.private_key)' "$RESULTS_DIR/key-response.json" > "$RESULTS_DIR/key-response.json.tmp" \
    && mv "$RESULTS_DIR/key-response.json.tmp" "$RESULTS_DIR/key-response.json"
fi

# ---- Launch the matrix ------------------------------------------------------
# state per instance id, all epoch seconds (0 = not yet observed)
declare -A VM_TYPE_OF ARM_OF LAUNCH_AT IP_AT TERM_KIND TERM_HTTP TERM_REQ_AT TERMINATED_AT LAST_STATUS LAST_POINT_STATUS VIEW_DISAGREEMENT RELEASE_AGREE_AT RELEASE_REGRESSION
LAUNCH_ORDER=()
LAUNCHED_COUNT=0

launch_one() {
  local vm_type=$1 idx=$2
  local name="${NAME_PREFIX}-${vm_type}-${idx}"
  local body code
  body=$(jq -cn --arg region "$REGION" --arg vm "$vm_type" --arg key "$KEY_NAME" --arg name "$name" --arg run "$RUN_TOKEN" \
    '{region_name:$region,instance_type_name:$vm,ssh_key_names:[$key],name:$name,tags:[{key:"anycloud:boot-probe",value:$run}]}')
  code=$(api_post_status /instance-operations/launch "$body" "$RESULTS_DIR/launch-${vm_type}-${idx}.json")
  if [[ $code == 2* ]]; then
    local id
    id=$(jq -er '.data.instance_ids[0]' "$RESULTS_DIR/launch-${vm_type}-${idx}.json")
    VM_TYPE_OF[$id]=$vm_type
    # GPU instances launch first, so the early-terminate arm lands on the
    # incident's own pool.
    if (( LAUNCHED_COUNT < EARLY_TERM_COUNT )); then ARM_OF[$id]=early; else ARM_OF[$id]=observe; fi
    LAUNCHED_COUNT=$((LAUNCHED_COUNT + 1))
    LAUNCH_AT[$id]=$(date +%s)
    IP_AT[$id]=0; TERM_KIND[$id]=""; TERM_HTTP[$id]=""; TERM_REQ_AT[$id]=0; TERMINATED_AT[$id]=0; LAST_STATUS[$id]=requested; LAST_POINT_STATUS[$id]=not-checked; VIEW_DISAGREEMENT[$id]=false; RELEASE_AGREE_AT[$id]=0; RELEASE_REGRESSION[$id]=false
    LAUNCH_ORDER+=("$id")
    echo "BOOT_PROBE launched id=$id vm_type=$vm_type arm=${ARM_OF[$id]} name=$name"
  else
    echo "BOOT_PROBE launch_rejected vm_type=$vm_type idx=$idx http=$code body=$(head -c 300 "$RESULTS_DIR/launch-${vm_type}-${idx}.json")"
  fi
  # Space launch requests far enough apart to avoid measuring our own request
  # burst. Run 33659477831 waited only 2s here and the sixth request received a
  # Cloudflare edge 429 ("error code: 1015").
  sleep 13
}

for ((i = 0; i < GPU_COUNT; i++)); do launch_one "$GPU_TYPE" "$i"; done
for ((i = 0; i < CPU_COUNT; i++)); do launch_one "$CPU_TYPE" "$i"; done

if (( ${#LAUNCH_ORDER[@]} == 0 )); then
  echo 'BOOT_PROBE verdict NOTHING_LAUNCHED (see launch-*.json for rejections)'
  jq -cn --argjson capacity "$CAPACITY_BEFORE" \
    '{verdict:"nothing-launched", capacityBefore:$capacity, instances:[]}' > "$SUMMARY_JSON"
  exit 0
fi

# ---- Observe: one bulk /instances call per tick -----------------------------
terminate_one() {
  local id=$1 kind=$2
  local body code out="$RESULTS_DIR/terminate-${id}.json"
  body=$(jq -cn --arg id "$id" '{instance_ids:[$id]}')
  code=$(api_post_status /instance-operations/terminate "$body" "$out")
  if [[ ${TERM_REQ_AT[$id]} == 0 ]]; then
    TERM_REQ_AT[$id]=$(date +%s)
    TERM_KIND[$id]=$kind
    TERM_HTTP[$id]=$code
  fi
  echo "BOOT_PROBE terminate_requested id=$id kind=$kind http=$code body=$(head -c 200 "$out")"
}

DEADLINE=$((SECONDS + OBSERVE_SECONDS))
while [[ $SECONDS -lt $DEADLINE ]]; do
  sleep "$POLL_SECONDS"
  SNAPSHOT=$(probe_instances) || continue
  NOW=$(date +%s)
  OPEN=0
  for id in "${LAUNCH_ORDER[@]}"; do
    row=$(jq -c --arg id "$id" '.[] | select(.id == $id)' <<<"$SNAPSHOT")
    status=$(jq -r '.status // "missing"' <<<"${row:-null}" 2>/dev/null); [[ -n $row ]] || status=missing
    point_status=${LAST_POINT_STATUS[$id]}
    has_ip=$(jq -r '.has_ip' <<<"${row:-null}" 2>/dev/null); [[ $has_ip == true ]] || has_ip=false
    note=""
    if [[ $status != "${LAST_STATUS[$id]}" ]]; then
      note="transition:${LAST_STATUS[$id]}->${status}"
      LAST_STATUS[$id]=$status
    fi
    if [[ $has_ip == true && ${IP_AT[$id]} == 0 ]]; then
      IP_AT[$id]=$NOW
      note="${note:+$note }got_ip_after=$((NOW - LAUNCH_AT[$id]))s"
    fi
    if [[ ${TERM_REQ_AT[$id]} == 0 ]]; then
      if [[ ${ARM_OF[$id]} == early && $has_ip == false && $status == booting ]]; then
        # The mechanism under test, exercised on demand rather than waiting
        # for a naturally stuck instance.
        note="${note:+$note }early_terminate_while_booting age=$((NOW - LAUNCH_AT[$id]))s"
        terminate_one "$id" early
      elif [[ $has_ip == true ]]; then
        # Healthy path measured; terminate now to record confirm latency and
        # release shared-account quota promptly.
        terminate_one "$id" healthy
      elif [[ $status == booting && $((NOW - LAUNCH_AT[$id])) -gt $STUCK_AFTER_SECONDS ]]; then
        # A naturally stuck instance: the incident state itself.
        note="${note:+$note }stuck_past_boot_budget"
        terminate_one "$id" stuck
      fi
    fi

    if [[ ${TERM_REQ_AT[$id]} -gt 0 && ${TERMINATED_AT[$id]} == 0 ]]; then
      point_status=$(probe_instance_status "$id")
      LAST_POINT_STATUS[$id]=$point_status
    fi

    if [[ ${TERM_REQ_AT[$id]} -gt 0 && ${TERMINATED_AT[$id]} == 0 ]]; then
      list_released=false
      point_released=false
      [[ $status == terminated || $status == missing ]] && list_released=true
      [[ $point_status == terminated || $point_status == missing ]] && point_released=true
      if [[ $list_released != $point_released ]]; then
        VIEW_DISAGREEMENT[$id]=true
        note="${note:+$note }release_view_disagreement:list=$status;point=$point_status"
      fi
      if [[ $list_released == true && $point_released == true ]]; then
        if [[ ${RELEASE_AGREE_AT[$id]} == 0 ]]; then
          RELEASE_AGREE_AT[$id]=$NOW
        fi
        stable_for=$((NOW - RELEASE_AGREE_AT[$id]))
        note="${note:+$note }release_agreement_seconds=$stable_for"
        if (( stable_for >= RELEASE_STABILITY_SECONDS )); then
          TERMINATED_AT[$id]=$NOW
        fi
      else
        if [[ ${RELEASE_AGREE_AT[$id]} -gt 0 ]]; then
          RELEASE_REGRESSION[$id]=true
          note="${note:+$note }release_regressed_after_agreement"
        fi
        RELEASE_AGREE_AT[$id]=0
      fi
    fi
    if [[ ${TERMINATED_AT[$id]} == 0 ]]; then OPEN=$((OPEN + 1)); fi
    echo "$NOW,$id,${VM_TYPE_OF[$id]},${ARM_OF[$id]},$status,$point_status,$has_ip,$note" >> "$EVENTS_CSV"
  done
  if (( OPEN == 0 )); then break; fi
done

# ---- Summarize --------------------------------------------------------------
sleep 2
CAPACITY_AFTER=$(api_get /instance-types | jq -c --arg gpu "$GPU_TYPE" --arg cpu "$CPU_TYPE" \
  '{gpu: [.data[$gpu].regions_with_capacity_available[]?.name],
    cpu: [.data[$cpu].regions_with_capacity_available[]?.name]}')

ROWS='[]'
for id in "${LAUNCH_ORDER[@]}"; do
  ROWS=$(jq -cn --argjson rows "$ROWS" --arg id "$id" --arg vm "${VM_TYPE_OF[$id]}" \
    --arg arm "${ARM_OF[$id]}" \
    --argjson launch "${LAUNCH_AT[$id]}" --argjson ip "${IP_AT[$id]}" \
    --arg termKind "${TERM_KIND[$id]}" --arg termHttp "${TERM_HTTP[$id]}" \
    --argjson termReq "${TERM_REQ_AT[$id]}" --argjson termDone "${TERMINATED_AT[$id]}" \
    --arg last "${LAST_STATUS[$id]}" --arg point "${LAST_POINT_STATUS[$id]}" \
    --argjson disagreement "${VIEW_DISAGREEMENT[$id]}" \
    --argjson regression "${RELEASE_REGRESSION[$id]}" \
    '$rows + [{id:$id, vmType:$vm, arm:$arm,
      secondsToIp: (if $ip > 0 then $ip - $launch else null end),
      terminateKind: (if $termKind == "" then null else $termKind end),
      terminateHttp: (if $termHttp == "" then null else $termHttp end),
      terminateAcceptedWhileBooting: (if $termKind == "early" or $termKind == "stuck" then ($termHttp | startswith("2")) else null end),
      secondsFromTerminateToStableRelease: (if $termReq > 0 and $termDone > 0 then $termDone - $termReq else null end),
      releaseViewDisagreementObserved:$disagreement,
      releaseRegressionObserved:$regression,
      finalListStatus:$last,
      finalPointStatus:$point}]')
done
jq -cn --argjson rows "$ROWS" --argjson before "$CAPACITY_BEFORE" --argjson after "$CAPACITY_AFTER" \
  --arg region "$REGION" --argjson stuckAfter "$STUCK_AFTER_SECONDS" \
  --argjson releaseStability "$RELEASE_STABILITY_SECONDS" \
  '{region:$region, stuckAfterSeconds:$stuckAfter, releaseStabilitySeconds:$releaseStability, capacityBefore:$before, capacityAfter:$after, instances:$rows}' \
  | jq . > "$SUMMARY_JSON"
echo "BOOT_PROBE summary $(jq -c . "$SUMMARY_JSON")"
